// READ-ONLY Storage Service sync (what Signal-Desktop does after linking): the primary phone keeps the address book, profile
// keys, profile names, blocked / archived / muted / pinned flags and group master keys in the Storage Service, encrypted with a
// key only the account's devices can derive. A linked device gets that key from the primary (SyncMessage.Keys, see inbound.ts).
//
// Flow: GET /v1/storage/auth (chat connection) -> basic credentials; GET https://storage.signal.org/v1/storage/manifest[/version/N];
// decrypt the manifest; PUT /v1/storage/read in batches of 100 storage ids; decrypt each StorageItem; apply Contact / GroupV2 / Account
// records. Only ids that are new since the last sync are read. NEVER writes: the only PUT ever sent is /v1/storage/read (a read
// request with a body) and `guard` below refuses everything else. Failures are counted, never logged with ids, names or keys.
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import {
  ManifestRecordCodec, ReadOperationCodec, StorageIdType, StorageItemsCodec, StorageManifestCodec, StorageRecordCodec, StorageRecordPniProbe,
  type AccountRecordPb, type ContactRecordPb, type GroupV2RecordPb,
} from "../protocol/codec.js";
import type { SignalStore } from "../store/signalStore.js";
import type { AuthChat } from "./chatTypes.js";
import { SIGNAL_TLS_ROOT_PEM, STORAGE_URL, USER_AGENT } from "./constants.js";
import { resolveContactName } from "./contacts.js";
import { cleanName } from "./profileCrypto.js";
import { groupChatId, groupIdFromMasterKey } from "./groups.js";
import { gcmDecrypt, itemKeys, manifestKey } from "./storageCrypto.js";

export interface StorageResponse { status: number; body: Uint8Array }
export interface StorageCredentials { username: string; password: string }
/** Network edge, replaceable in tests. Never throws for HTTP statuses, only for transport errors. */
export interface StorageTransport {
  auth(): Promise<StorageCredentials>;
  call(method: "GET" | "PUT", path: string, basicAuth: string, body?: Uint8Array): Promise<StorageResponse>;
}

const BATCH = 100;
const MAX_BODY = 16 * 1024 * 1024;
const text = (b: Uint8Array | undefined | null) => Buffer.from(b ?? new Uint8Array()).toString("utf8");
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const sdbg = (s: string) => { if (process.env.UNIMSG_DEBUG) process.stderr.write(`[signal] storage: ${s}\n`); };

/** Real HTTPS (pinned Signal root CA, as groupState.ts). An `http://` base URL is accepted ONLY so tests can use a loopback server. */
export function httpsStorageTransport(auth: StorageTransport["auth"], opts: { storageUrl?: string; ca?: string } = {}): StorageTransport {
  const base = opts.storageUrl ?? STORAGE_URL;
  return {
    auth,
    call: (method, path, basicAuth, body) => new Promise<StorageResponse>((resolve, reject) => {
      const url = new URL(path, base);
      const payload = body ? Buffer.from(body) : undefined;
      const go = url.protocol === "http:" ? httpRequest : httpsRequest;
      const req = go(url, {
        method, timeout: 30_000, ...(url.protocol === "https:" ? { ca: opts.ca ?? SIGNAL_TLS_ROOT_PEM } : {}),
        headers: {
          authorization: `Basic ${basicAuth}`, "user-agent": USER_AGENT, accept: "application/x-protobuf",
          ...(payload ? { "content-type": "application/x-protobuf", "content-length": String(payload.length) } : {}),
        },
      }, (res) => {
        const parts: Buffer[] = []; let n = 0;
        res.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) req.destroy(new Error("storage response too large")); else parts.push(c); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("storage timeout")));
      req.on("error", reject);
      req.end(payload);
    }),
  };
}

/** Auth over the authenticated chat connection: GET /v1/storage/auth -> {username, password}. */
export const storageAuthViaChat = (chat: () => AuthChat): StorageTransport["auth"] => async () => {
  const res = await chat().fetch({ verb: "GET", path: "/v1/storage/auth", headers: [] });
  if (res.status < 200 || res.status >= 300) throw new Error(`storage auth http ${res.status}`);
  const j = JSON.parse(text(res.body)) as Partial<StorageCredentials>;
  if (!j.username || !j.password) throw new Error("storage auth: bad response");
  return { username: j.username, password: j.password };
};

/** When may the primary be asked for its keys again? Backoff 0, 2 min, 10 min, 1 h, 6 h, 24 h, then weekly. */
export function keysRequestDelayMs(attempts: number): number {
  return attempts >= 6 ? 7 * 86_400_000 : [0, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000][attempts]!;
}

export interface StorageStats { version?: number; records: number; contacts: number; groups: number; applied: number; skipped: number; unchanged?: boolean }
export interface StorageHooks {
  onChanged(): void;
  onProfileKey?(aci: string): void;
  /** a contact record names both the ACI and the PNI of a person */
  onPni?(pni: string, aci: string): void;
  /** A record holds a PNI and a number but no ACI (number-only contact the phone messaged). */
  onPniNumber?(pni: string, e164: string): void;
  /** The phone says this ACI has this number. */
  onNumber?(aci: string, e164: string): void;
  /** Group chats created from storage (master keys we never saw a message for): their state should be resolved. */
  onNewGroups?(chatIds: string[]): void;
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
const join = (...p: (string | undefined)[]) => cleanName(p.map(cleanName).filter(Boolean).join(" "));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export class StorageSync {
  private running?: Promise<StorageStats | undefined>; private again = false;
  constructor(
    private readonly store: SignalStore, private readonly transport: () => StorageTransport | undefined, private readonly hooks: StorageHooks,
    private readonly now: () => number = Date.now,
  ) {}

  get hasKey(): boolean { return !!this.store.data.storage.key; }

  /** Run a sync (coalesced: a request during a run triggers exactly one more run). */
  sync(): Promise<StorageStats | undefined> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try { return await this.once(); }
      catch (e) { sdbg(`failed ${e instanceof Error ? e.name : "error"}`); return undefined; }
      finally { this.running = undefined; if (this.again) { this.again = false; void this.sync(); } }
    })();
    return this.running;
  }

  private creds?: StorageCredentials;
  /** One request with auth; a 401/403 re-authenticates once and retries. Only reads are allowed (guard). */
  private async req(t: StorageTransport, method: "GET" | "PUT", path: string, body?: Uint8Array): Promise<StorageResponse> {
    if (!(method === "GET" || (method === "PUT" && path === "/v1/storage/read"))) throw new Error("storage sync is read-only");
    for (let attempt = 0; ; attempt++) {
      this.creds ??= await t.auth();
      const res = await t.call(method, path, Buffer.from(`${this.creds.username}:${this.creds.password}`).toString("base64"), body);
      if ((res.status === 401 || res.status === 403) && attempt === 0) { this.creds = undefined; continue; }
      return res;
    }
  }

  private async once(): Promise<StorageStats | undefined> {
    const st = this.store.data.storage;
    const t = this.transport();
    if (!st.key || !t) return undefined;
    const storageKey = Buffer.from(st.key, "base64");
    const have = st.manifestVersion;
    const res = await this.req(t, "GET", have !== undefined ? `/v1/storage/manifest/version/${have}` : "/v1/storage/manifest");
    if (res.status === 204) { sdbg(`manifest v=${have} unchanged`); return { version: have, records: 0, contacts: 0, groups: 0, applied: 0, skipped: 0, unchanged: true }; }
    if (res.status === 404) { sdbg("no manifest on the server"); return undefined; }
    if (res.status !== 200) throw new Error(`manifest http ${res.status}`);

    let manifest;
    try {
      const sm = StorageManifestCodec.decode(res.body);
      manifest = ManifestRecordCodec.decode(gcmDecrypt(manifestKey(storageKey, sm.version ?? 0), sm.value ?? new Uint8Array()));
    } catch {
      sdbg("manifest could not be decrypted (wrong storage key?): key dropped, will ask the phone again");
      delete st.key; this.store.touch();
      return undefined;
    }
    const ids = (manifest.identifiers ?? []).filter((i) => i.raw?.length);
    const items = (st.items ??= {});
    const present = new Set(ids.map((i) => b64(i.raw!)));
    for (const k of Object.keys(items)) if (!present.has(k)) delete items[k]; // record removed on the phone: forget the mapping, keep the data
    const stats: StorageStats = {
      version: manifest.version, records: ids.length, applied: 0, skipped: 0,
      contacts: ids.filter((i) => i.type === StorageIdType.CONTACT).length, groups: ids.filter((i) => i.type === StorageIdType.GROUPV2).length,
    };
    const wanted = (ty?: number) => ty === StorageIdType.CONTACT || ty === StorageIdType.GROUPV2 || ty === StorageIdType.ACCOUNT;
    for (const i of ids) if (!wanted(i.type) && !items[b64(i.raw!)]) items[b64(i.raw!)] = { t: i.type ?? 0 }; // not interesting: remember, never read
    const todo = ids.filter((i) => wanted(i.type) && !items[b64(i.raw!)]);

    const ctx: Ctx = { changed: false, newGroups: [], me: this.store.requireAccount().aci.toLowerCase() };
    const accounts: { rec: AccountRecordPb; raw: string }[] = [];
    let readFailed = false;
    for (let off = 0; off < todo.length && !readFailed; off += BATCH) {
      const batch = todo.slice(off, off + BATCH);
      const r = await this.req(t, "PUT", "/v1/storage/read", ReadOperationCodec.encode({ readKey: batch.map((i) => i.raw!) }));
      if (r.status !== 200) { readFailed = true; break; }
      const got = new Map<string, Uint8Array>();
      for (const it of StorageItemsCodec.decode(r.body).items ?? []) if (it.key && it.value) got.set(b64(it.key), it.value);
      for (const i of batch) {
        const raw = b64(i.raw!); const value = got.get(raw);
        const rec = value && this.decryptRecord(storageKey, i.raw!, value, manifest.recordIkm);
        if (!rec) { stats.skipped++; continue; }
        if (rec.contact) { const k = this.applyContact(rec.contact, ctx); items[raw] = { t: i.type!, ...(k ? { k } : {}) }; }
        else if (rec.groupV2) { const k = this.applyGroup(rec.groupV2, ctx); if (k) items[raw] = { t: i.type!, k }; else { stats.skipped++; continue; } }
        else if (rec.account) { accounts.push({ rec: rec.account, raw }); items[raw] = { t: i.type! }; }
        else items[raw] = { t: i.type! };
        stats.applied++;
      }
    }
    for (const a of accounts) this.applyAccount(a.rec, ctx);
    if (!readFailed) { st.manifestVersion = manifest.version; st.syncedAt = this.now(); }
    this.store.touch();
    await this.store.flush().catch(() => {});
    sdbg(`manifest v=${stats.version} records=${stats.records} contacts=${stats.contacts} groups=${stats.groups} applied=${stats.applied} skipped=${stats.skipped}${readFailed ? " readfailed=1" : ""}`);
    if (ctx.newGroups.length) this.hooks.onNewGroups?.(ctx.newGroups);
    if (ctx.changed || ctx.newGroups.length) this.hooks.onChanged();
    return stats;
  }

  private decryptRecord(storageKey: Buffer, raw: Uint8Array, value: Uint8Array, ikm?: Uint8Array) {
    for (const k of itemKeys(storageKey, raw, ikm)) {
      try {
        const plain = gcmDecrypt(k, value), rec = StorageRecordCodec.decode(plain);
        if (rec.contact) {
          let pni: string | undefined; try { pni = StorageRecordPniProbe.decode(plain).contact?.pni; } catch { /* probe only */ }
          // the field number of the PNI was a guess: look at what the record really contains (it holds no other UUID than the ACI and the PNI)
          if (!pni || !isUuid(pni.toLowerCase().replace(/^pni:/, ""))) pni = scanContactPni(plain, rec.contact.aci);
          else pni = pni.toLowerCase().replace(/^pni:/, "");
          if (pni) rec.contact.pni = pni;
        }
        return rec;
      } catch { /* try the next derivation */ }
    }
    return undefined;
  }

  private applyContact(r: ContactRecordPb, ctx: Ctx): string | undefined {
    const aci = r.aci?.toLowerCase();
    if ((!aci || !isUuid(aci)) && r.pni && r.e164) this.hooks.onPniNumber?.(r.pni, r.e164);
    if (!aci || !isUuid(aci) || aci === ctx.me) return undefined;
    const c = (this.store.data.contacts[aci] ??= { aci });
    const before = JSON.stringify(c);
    if (r.profileKey?.length === 32) {
      const k = b64(r.profileKey);
      if (c.profileKey !== k) { c.profileKey = k; delete c.sealedRejectedAt; delete c.unrestricted; delete c.profileNameCheckedAt; this.hooks.onProfileKey?.(aci); }
    }
    if (r.e164) c.number = r.e164;
    if (r.pni) this.hooks.onPni?.(r.pni, aci);
    if (r.e164) this.hooks.onNumber?.(aci, r.e164);
    if (r.pni && r.e164) this.hooks.onPniNumber?.(r.pni, r.e164);
    c.nickName = join(r.nickname?.given, r.nickname?.family);
    c.systemName = join(r.systemGivenName, r.systemFamilyName) ?? cleanName(r.systemNickname);
    c.profileName = join(r.givenName, r.familyName);
    resolveContactName(c);
    c.blocked = !!r.blocked; c.archived = !!r.archived; c.hidden = !!r.hidden; c.unregistered = num(r.unregisteredAtTimestamp) > 0;
    c.mutedUntil = num(r.mutedUntilTimestamp) || undefined;
    for (const k of Object.keys(c) as (keyof typeof c)[]) if (c[k] === undefined) delete c[k];
    if (JSON.stringify(c) !== before) { ctx.changed = true; this.store.touch(); }
    return aci;
  }

  private applyGroup(r: GroupV2RecordPb, ctx: Ctx): string | undefined {
    if (r.masterKey?.length !== 32) return undefined;
    let id: string;
    try { id = groupChatId(groupIdFromMasterKey(r.masterKey)); } catch { return undefined; }
    const existing = this.store.data.chats[id];
    const before = JSON.stringify(existing);
    if (!existing) { this.store.upsertChat({ id, kind: "group", groupMasterKey: b64(r.masterKey) }); ctx.newGroups.push(id); }
    const c = this.store.data.chats[id]!;
    c.groupMasterKey ??= b64(r.masterKey);
    c.blocked = !!r.blocked || undefined; c.archived = !!r.archived || undefined; c.mutedUntil = num(r.mutedUntilTimestamp) || undefined;
    for (const k of Object.keys(c) as (keyof typeof c)[]) if (c[k] === undefined) delete c[k];
    if (JSON.stringify(c) !== before) { ctx.changed = true; this.store.touch(); }
    return id;
  }

  private applyAccount(r: AccountRecordPb, ctx: Ctx): void {
    const a = this.store.requireAccount();
    const before = JSON.stringify([a, Object.values(this.store.data.contacts).map((c) => c.pinned), Object.values(this.store.data.chats).map((c) => c.pinned)]);
    if (!a.profileKey && r.profileKey?.length === 32) a.profileKey = b64(r.profileKey);
    if (r.readReceipts !== undefined) a.readReceipts = r.readReceipts;
    if (r.typingIndicators !== undefined) a.typingIndicators = r.typingIndicators;
    if (r.linkPreviews !== undefined) a.linkPreviews = r.linkPreviews;
    for (const c of Object.values(this.store.data.contacts)) delete c.pinned;
    for (const c of Object.values(this.store.data.chats)) delete c.pinned;
    for (const p of r.pinnedConversations ?? []) {
      if (p.contact?.serviceId) {
        const id = p.contact.serviceId.replace(/^ACI:/i, "").toLowerCase();
        if (isUuid(id)) (this.store.data.contacts[id] ??= { aci: id }).pinned = true;
      } else if (p.groupMasterKey?.length === 32) {
        try { const ch = this.store.data.chats[groupChatId(groupIdFromMasterKey(p.groupMasterKey))]; if (ch) ch.pinned = true; } catch { /* ignore */ }
      }
    }
    if (JSON.stringify([a, Object.values(this.store.data.contacts).map((c) => c.pinned), Object.values(this.store.data.chats).map((c) => c.pinned)]) !== before) { ctx.changed = true; this.store.touch(); }
  }
}
interface Ctx { changed: boolean; newGroups: string[]; me: string }

/**
 * The PNI of a storage ContactRecord found without knowing its field number: the record's other UUIDs are only the ACI and the PNI, so any UUID
 * (text, "PNI:<uuid>", or 16/17 raw bytes) that is not the ACI is the PNI. Pure wire-format reading; returns undefined when there is none.
 */
export function scanContactPni(plain: Uint8Array, aci?: string): string | undefined {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const fields = (b: Uint8Array): { n: number; v: Uint8Array }[] => {
    const out: { n: number; v: Uint8Array }[] = []; let i = 0;
    const varint = (): number => { let r = 0, sh = 0; for (;;) { if (i >= b.length || sh > 56) throw new Error("bad varint"); const x = b[i++]!; r += (x & 0x7f) * 2 ** sh; if (!(x & 0x80)) return r; sh += 7; } };
    while (i < b.length) {
      const tag = varint(), wt = tag & 7, n = Math.floor(tag / 8);
      if (wt === 0) varint(); else if (wt === 1) i += 8; else if (wt === 5) i += 4;
      else if (wt === 2) { const len = varint(); if (i + len > b.length) throw new Error("truncated"); out.push({ n, v: b.subarray(i, i + len) }); i += len; } else throw new Error("unsupported wire type");
    }
    return out;
  };
  const hex = (x: Uint8Array) => { const h = Buffer.from(x).toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  try {
    const own = aci?.toLowerCase();
    const contact = fields(plain).find((f) => f.n === 1)?.v; if (!contact) return undefined; // StorageRecord.contact
    for (const f of fields(contact)) {
      let cand: string | undefined;
      if (f.v.length === 16) cand = hex(f.v);
      else if (f.v.length === 17 && f.v[0] === 0x01) cand = hex(f.v.subarray(1)); // raw PNI service id: 0x01 prefix
      else if (f.v.length >= 36 && f.v.length <= 41) cand = Buffer.from(f.v).toString("utf8").toLowerCase().replace(/^pni:/, "");
      if (cand && uuidRe.test(cand) && cand !== own) return cand;
    }
  } catch { /* not a contact record we can read */ }
  return undefined;
}

