// SyncStore: a Store decorator. Wrap ANY Store (MemoryStore, SqliteStore) before handing it to the Hub; with no sync group it is a pure
// pass-through. Once a SyncService attaches a context, every local change of a synced entity also gets a ledger entry (fresh seq + HLC stamp).
// Changes written by replication go through `applyRemote`, which talks to the inner store directly, so they are never echoed back.
import type { StoredAvatar, Chat, ChatFlags, ChatMerge, Folder, Job, MeshGroup, Message, Space, StateRecord, Store, StoredAccount, AccountEventKind } from "@unimsg/core";
import { canon, contentOf, pinSig, fullPatch, joinMessage, key, parseKey, recSig, rxDiff, rxFromReactions, rxSanitize, SYNCED_SETTINGS, isSyncedSetting, accountOfKey, type Kind, type MsgRec, type Rx } from "./crdt.js";
import { type Clock, maxStamp, parseStamp, zeroStamp } from "./hlc.js";
import type { Entity, Ledger } from "./ledger.js";

export type SyncMode = "none" | "archive-only" | "credentials";
export interface WireEntry { k: string; h: string; t?: 1; m?: { c: string; r: string; x?: Rx; p?: string }; v?: any }
export interface SyncCtx {
  ledger: Ledger; clock: Clock; device: string;
  changed(): void;
  mode(acct: string): SyncMode;
  purgedBefore(): string;
  setPurgedBefore(iso: string): void;
  /** the account was removed on this device: stop syncing it */
  accountRemoved(acct: string): void;
  /** a credentials entry arrived (not stored in the Store) */
  credentials(acct: string, v: any, hlc: string, from: string): void;
  /** Does this device hold a LIVE connector for the account (own login or a proxy)? Then its chat list is authoritative and a peer's chat cache is ignored. */
  isLive?(acct: string): boolean;
  /** a message with attachments was stored/updated by replication: the media layer may want the bytes later (lazy blob sync) */
  wantMedia?(m: Message): void;
  /** a message was stored by replication: the Hub's search index must see it (the index only watches the Hub's own store wrapper) */
  index?(m: Message): void;
}
export interface ApplyResult { applied: number; skipped: number; invalid: number; chats: Set<string>; accounts: boolean; global: boolean }
type Maps = { al: Record<string, string>; fl: Record<string, ChatFlags>; fo: Map<string, Folder>; cf: Record<string, string>; me: Map<string, ChatMerge>; ms: Map<string, MeshGroup>; ac: Map<string, StoredAccount> };

export class SyncStore implements Store {
  ctx?: SyncCtx;
  constructor(readonly inner: Store) { if (inner.scanMessages) this.scanMessages = (o) => inner.scanMessages!(o); } // paged archive scan for the search index / history / media jobs: without it they fall back to exportRecords(), which decrypts EVERY record (avatars too)
  scanMessages?: Store["scanMessages"];

  // ------------------------------------------------------------------ pass-through reads
  listAccounts() { return this.inner.listAccounts(); }
  listAliases() { return this.inner.listAliases(); }
  listChatFlags() { return this.inner.listChatFlags(); }
  listFolders() { return this.inner.listFolders(); }
  listChatFolders() { return this.inner.listChatFolders(); }
  listMeshGroups() { return this.inner.listMeshGroups(); }
  listMerges() { return this.inner.listMerges(); }
  getMessage(chatId: string, id: string) { return this.inner.getMessage(chatId, id); }
  listMessages(chatId: string, o: { beforeTime?: string; limit: number }) { return this.inner.listMessages(chatId, o); }
  searchMessages(chatId: string, q: string, limit: number) { return this.inner.searchMessages(chatId, q, limit); }
  getChatCache(id: string) { return this.inner.getChatCache(id); }
  addAccountEvent(a: string, k: AccountEventKind, t?: string) { return this.inner.addAccountEvent(a, k, t); }
  listAccountEvents(a: string) { return this.inner.listAccountEvents(a); }
  getSetting(k: string) { return this.inner.getSetting(k); }
  // avatars: a device-local cache that avatars.ts replicates by content hash, with tombstones for deletions (no ledger entries)
  getAvatar(k: string) { return this.inner.getAvatar(k); }
  /** the sync service listens here: this device's store gained / lost pictures (it then tells its peers, see avatars.ts) */
  onAvatar?: () => void;
  putAvatar(a: StoredAvatar) { this.inner.putAvatar(a); this.onAvatar?.(); }
  listAvatars(o: { after?: string; limit: number }) { return this.inner.listAvatars(o); }
  deleteAvatars(o: { accountId?: string; id?: string; at?: number }) { const n = this.inner.deleteAvatars(o); this.onAvatar?.(); return n; }
  pruneAvatars(o: { maxBytes: number; olderThan?: number; tombOlderThan?: number }) { return this.inner.pruneAvatars(o); }
  putJob(j: Job) { this.inner.putJob(j); }
  getJob(id: string) { return this.inner.getJob(id); }
  dueJobs(now: number) { return this.inner.dueJobs(now); }
  nextRunAt() { return this.inner.nextRunAt(); }
  listJobs(s?: Job["status"]) { return this.inner.listJobs(s); }
  exportRecords() { return this.inner.exportRecords(); }
  countRecords() { return this.inner.countRecords(); }
  inTransaction<T>(f: () => T | Promise<T>) { return this.inner.inTransaction(f); }

  // ------------------------------------------------------------------ recorded writes
  private touch(kind: Kind, ids: string[], o: { tomb?: boolean; meta?: unknown; time?: string; hlc?: string } = {}) {
    const c = this.ctx; if (!c) return;
    c.ledger.put({ key: key(kind, ...ids), hlc: o.hlc ?? c.clock.tick(), tomb: o.tomb, meta: o.meta, time: o.time });
    c.changed();
  }
  putAccount(a: StoredAccount) {
    const pre = this.ctx ? this.inner.listAccounts().find((x) => x.id === a.id) : undefined;
    this.inner.putAccount(a);
    if (this.ctx && !this.held.has(a.id) && (!pre || pre.label !== a.label || pre.provider !== a.provider)) this.touch("ac", [a.id]);
  }
  private held = new Set<string>(); // accounts added here that never signed in: not announced (see Store.holdAccount)
  holdAccount(id: string) { this.held.add(id); }
  releaseAccount(id: string) { if (this.held.delete(id) && this.ctx) this.touch("ac", [id]); }
  deleteAccount(id: string) {
    const never = this.held.delete(id); // cancelled before the first sign-in: nobody else ever heard of it
    this.inner.deleteAccount(id);
    if (this.ctx) { if (!never) this.touch("ac", [id], { tomb: true }); this.ctx.accountRemoved(id); }
  }
  deleteAccountData(id: string) { this.inner.deleteAccountData(id); this.ctx?.ledger.dropAccount(id); }
  setAlias(chatId: string, name: string | null) { this.inner.setAlias(chatId, name); this.touch("al", [chatId], { tomb: !name }); }
  setChatFlags(chatId: string, f: ChatFlags) { this.inner.setChatFlags(chatId, f); this.touch("fl", [chatId], { tomb: !(f.pinned || f.muted || f.archived || f.unreadMark || f.starred || f.readUpTo) }); }
  putFolder(f: Folder) { this.inner.putFolder(f); this.touch("fo", [f.id]); }
  deleteFolder(id: string) {
    const before = this.ctx ? this.inner.listChatFolders() : {};
    this.inner.deleteFolder(id);
    if (!this.ctx) return;
    this.touch("fo", [id], { tomb: true });
    const after = this.inner.listChatFolders();
    for (const [chat, fid] of Object.entries(before)) if (fid === id && !after[chat]) this.touch("cf", [chat], { tomb: true });
  }
  setChatFolder(chatId: string, folderId: string | null) { this.inner.setChatFolder(chatId, folderId); this.touch("cf", [chatId], { tomb: !folderId }); }
  putMeshGroup(g: MeshGroup) { this.inner.putMeshGroup(g); this.touch("ms", [g.id]); }
  putMerge(m: ChatMerge) { this.inner.putMerge(m); this.touch("me", [m.id]); }
  deleteMerge(id: string) { this.inner.deleteMerge(id); this.touch("me", [id], { tomb: true }); }
  /** Settings that became syncable after this device was paired (e.g. rail groups, categories, imported-chat lists) have a value but no ledger entry yet: register them once so already-paired devices receive them. */
  adoptSettings() {
    const c = this.ctx; if (!c) return;
    const keys = [...SYNCED_SETTINGS]; for (const a of this.inner.listAccounts()) keys.push(`signalImport.chats.${a.id}`, `whatsappImport.chats.${a.id}`);
    for (const k of keys) { if (this.inner.getSetting(k) === undefined || c.ledger.get(key("se", k))) continue; this.touch("se", [k]); }
  }
  setSetting(k: string, v: string) { const pre = this.inner.getSetting(k); this.inner.setSetting(k, v); if (isSyncedSetting(k) && pre !== v) this.touch("se", [k]); }
  putChatCache(id: string, v: { chats: Chat[]; spaces: Space[] }) {
    const same = this.ctx && canon(this.inner.getChatCache(id)) === canon(v);
    this.inner.putChatCache(id, v); if (this.ctx && !same) this.touch("cc", [id]);
  }
  deleteMessagesBefore(iso: string) {
    const n = this.inner.deleteMessagesBefore(iso);
    const c = this.ctx; if (c) { c.ledger.dropMessagesBefore(iso); if (iso > c.purgedBefore()) c.setPurgedBefore(iso); } // local policy: dropped silently, and remembered so peers cannot bring it back
    return n;
  }
  putMessages(ms: Message[]) {
    const c = this.ctx; if (!c) return this.inner.putMessages(ms);
    const pre = ms.map((m) => this.inner.getMessage(m.chatId, m.id));
    this.inner.putMessages(ms);
    ms.forEach((m, i) => this.afterMsg(pre[i], this.inner.getMessage(m.chatId, m.id)));
  }
  patchMessage(chatId: string, id: string, patch: Partial<Message>) {
    const pre = this.ctx ? this.inner.getMessage(chatId, id) : undefined;
    this.inner.patchMessage(chatId, id, patch);
    if (this.ctx) this.afterMsg(pre, this.inner.getMessage(chatId, id));
  }
  private afterMsg(pre: Message | undefined, post: Message | undefined) {
    const c = this.ctx; if (!c || !post) return;
    const k = key("msg", post.chatId, post.id), row = c.ledger.get(k), z = zeroStamp(c.device);
    let cs = row?.meta?.c ?? z, rs = row?.meta?.r ?? z, ps: string | undefined = row?.meta?.p, dirty = false, x: Rx | undefined = row?.meta?.x;
    const rx = (m: Message | undefined) => canon(m?.deleted ? [] : m?.reactions ?? null);
    if (!pre || canon(contentOf(pre)) !== canon(contentOf(post))) { cs = c.clock.tick(); dirty = true; }
    else if (canon(pre.system ?? null) !== canon(post.system ?? null)) { cs = c.clock.tick(); dirty = true; } // a line marked as a notice afterwards (#102): the other devices must hear of it too
    if (!pre || rx(pre) !== rx(post)) {
      rs = c.clock.tick(); dirty = true;
      // per-(emoji, sender) elements: unchanged ones keep their stamp, new ones get `rs`, removed ones become tombstones (see crdt.ts)
      x = rxDiff(row?.meta?.x ?? rxFromReactions(pre?.deleted ? [] : pre?.reactions, row?.meta?.r ?? z), post.deleted ? [] : post.reactions, rs);
    }
    if (pre ? pinSig(pre) !== pinSig(post) : !!post.pinned) { ps = c.clock.tick(); dirty = true; }
    if (pre && (pre.status !== post.status || !!pre.deleted !== !!post.deleted)) dirty = true;
    if (!dirty) return;
    c.ledger.put({ key: k, hlc: maxStamp(maxStamp(cs, rs), ps ?? z), meta: { c: cs, r: rs, ...(x ? { x } : {}), ...(ps ? { p: ps } : {}) }, time: post.time }); c.changed();
  }

  // ------------------------------------------------------------------ reading entities for the wire
  maps(): Maps {
    return { al: this.inner.listAliases(), fl: this.inner.listChatFlags(), fo: new Map(this.inner.listFolders().map((f) => [f.id, f])), cf: this.inner.listChatFolders(),
      me: new Map(this.inner.listMerges().map((m) => [m.id, m])), ms: new Map(this.inner.listMeshGroups().map((g) => [g.id, g])), ac: new Map(this.inner.listAccounts().map((a) => [a.id, a])) };
  }
  /** The wire form of a ledger entity (current value read from the store), or undefined when there is nothing to send (value vanished, local-only, ...). */
  entry(e: Entity, mp: Maps): WireEntry | undefined {
    const { kind, id, id2 } = parseKey(e.key);
    if (e.tomb) return kind === "msg" ? undefined : { k: e.key, h: e.hlc, t: 1 };
    let v: any;
    switch (kind) {
      case "al": v = mp.al[id]; break;
      case "fl": v = mp.fl[id]; break;
      case "fo": v = mp.fo.get(id); break;
      case "cf": v = mp.cf[id]; break;
      case "me": v = mp.me.get(id); break;
      case "ms": v = mp.ms.get(id); break;
      case "se": v = this.inner.getSetting(id); break;
      case "ac": { const a = mp.ac.get(id); v = a && { id: a.id, provider: a.provider, label: a.label }; break; }
      case "cc": v = this.inner.getChatCache(id); break;
      case "msg": { v = this.inner.getMessage(id, id2 ?? ""); break; }
      default: return undefined;
    }
    if (v === undefined) return undefined;
    return { k: e.key, h: e.hlc, ...(kind === "msg" ? { m: e.meta } : {}), v };
  }

  /** current values of the global kinds, read once per applied batch (only for writes that arrive again, see applyOne) */
  private batchMaps?: Maps;
  // ------------------------------------------------------------------ applying what a peer sent (never echoed: inner store + ledger only)
  async applyRemote(entries: WireEntry[], src: string): Promise<ApplyResult> {
    const c = this.ctx; if (!c) throw new Error("sync is not active");
    const r: ApplyResult = { applied: 0, skipped: 0, invalid: 0, chats: new Set(), accounts: false, global: false };
    const t0 = Date.now();
    this.batchMaps = undefined;
    await this.inner.inTransaction(() => c.ledger.tx(() => { for (const e of entries) this.applyOne(c, e, src, r); }));
    this.batchMaps = undefined;
    const ms = Date.now() - t0; if (ms > 150) (globalThis as any).__unimsgPlog?.("sync.applyRemote", { entries: entries.length, applied: r.applied, ms }); // slow batches only (Android stage log)
    return r;
  }
  private applyOne(c: SyncCtx, e: WireEntry, src: string, r: ApplyResult) {
    if (!e || typeof e.k !== "string" || typeof e.h !== "string" || !c.clock.observe(e.h)) { r.invalid++; return; }
    const { kind, id, id2 } = parseKey(e.k);
    const acct = accountOfKey(e.k);
    if (acct && c.mode(acct) === "none") { r.skipped++; return; }
    if (kind === "cr") { if (e.v) c.credentials(id, e.v, e.h, src); r.applied++; return; }
    const cur = c.ledger.get(e.k);
    if (kind === "msg") return this.applyMsg(c, e, id, id2 ?? "", cur, src, r);
    if (cur && cur.hlc > e.h) { r.skipped++; return; }
    if (cur && cur.hlc === e.h) {
      // The same write again (a peer re-sending its log). Normally identical: skip. But a device that ran an older
      // version when it first arrived stored it without fields it did not know yet (a chat's `starred` flag was lost that
      // way). Only the device that made the write (its id ends the stamp) is believed: an old device re-sending its
      // incomplete copy must not undo the complete one here.
      if (parseStamp(e.h)?.device !== src) { r.skipped++; return; }
      const mine = cur.tomb ? undefined : this.entry(cur, (this.batchMaps ??= this.maps()));
      const norm = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== false && x !== undefined && x !== null && x !== "")) : v ?? null); // false / empty fields are stored as absent
      if (!!cur.tomb === !!e.t && canon(norm(mine?.v)) === canon(norm(e.v))) { r.skipped++; return; }
      this.batchMaps = undefined;
    }
    const tomb = !!e.t, v = e.v, i = this.inner;
    try {
      switch (kind) {
        case "al": i.setAlias(id, tomb ? null : String(v)); r.global = true; break;
        case "fl": i.setChatFlags(id, tomb ? {} : { pinned: !!v?.pinned, muted: !!v?.muted, archived: !!v?.archived, ...(v?.unreadMark ? { unreadMark: true } : {}), ...(v?.starred ? { starred: true } : {}), ...(typeof v?.readUpTo === "string" && v.readUpTo ? { readUpTo: v.readUpTo } : {}) }); r.global = true; break;
        case "fo": if (tomb) i.deleteFolder(id); else i.putFolder(v as Folder); r.global = true; break;
        case "cf": i.setChatFolder(id, tomb ? null : String(v)); r.global = true; break;
        case "me": if (tomb) i.deleteMerge(id); else i.putMerge(v as ChatMerge); r.global = true; break;
        case "ms": i.putMeshGroup(v as MeshGroup); r.global = true; break;
        case "se": if (isSyncedSetting(id) && typeof v === "string") i.setSetting(id, v); r.global = true; break;
        case "ac": {
          const have = i.listAccounts().find((a) => a.id === id);
          // status is per device: an account we only know from a peer is an ARCHIVE here (never auto-started, needs its own sign-in)
          if (tomb) { if (have && have.status !== "archived") i.putAccount({ ...have, status: "archived" }); }
          else if (v && typeof v.id === "string") i.putAccount({ id: v.id, provider: String(v.provider), label: String(v.label), status: have?.status ?? "archived" });
          r.accounts = true; break;
        }
        case "cc":
          // chat cache vs live connector: a device that holds a LIVE connector for the account (own login or proxy) asks the network itself, so a
          // peer's cache never overwrites it. Nothing is recorded or echoed: the entry is simply not applied.
          if (!tomb && c.isLive?.(id)) { r.skipped++; return; }
          i.putChatCache(id, v); r.global = true; break;
        default: r.skipped++; return;
      }
    } catch { r.invalid++; return; }
    c.ledger.put({ key: e.k, hlc: e.h, tomb, src }); r.applied++;
  }
  private applyMsg(c: SyncCtx, e: WireEntry, chatId: string, mid: string, cur: Entity | undefined, src: string, r: ApplyResult) {
    const v = e.v as Message | undefined;
    if (!v || v.id !== mid || v.chatId !== chatId || !e.m || typeof e.m.c !== "string" || typeof e.m.r !== "string" || typeof v.time !== "string") { r.invalid++; return; }
    if (v.time < c.purgedBefore()) { r.skipped++; return; } // retention purge on this device wins: do not resurrect
    const z = zeroStamp(c.device), local = this.inner.getMessage(chatId, mid);
    const ix = e.m.x === undefined ? undefined : rxSanitize(e.m.x);
    if (e.m.x !== undefined && !ix) { r.invalid++; return; }
    const ip = typeof (e.m as any).p === "string" ? (e.m as any).p as string : undefined;
    const inc: MsgRec = { m: v, c: e.m.c, r: e.m.r, ...(ix ? { x: ix } : {}), ...(ip ? { p: ip } : {}) };
    if (!c.clock.observe(inc.c) || !c.clock.observe(inc.r) || (ip && !c.clock.observe(ip)) || (ix && !Object.values(ix).every((el) => c.clock.observe(el.h)))) { r.invalid++; return; }
    const mine: MsgRec | undefined = local && { m: local, c: cur?.meta?.c ?? z, r: cur?.meta?.r ?? z, ...(cur?.meta?.x ? { x: cur.meta.x } : {}), ...(cur?.meta?.p ? { p: cur.meta.p } : {}) };
    const out = mine ? joinMessage(mine, inc) : joinMessage(inc, inc);
    if (mine && recSig(out) === recSig(mine)) { r.skipped++; return; }
    if (!local) this.inner.putMessages([out.m]); else this.inner.patchMessage(chatId, mid, fullPatch(local, out.m));
    c.ledger.put({ key: e.k, hlc: maxStamp(maxStamp(out.c, out.r), out.p ?? z), meta: { c: out.c, r: out.r, ...(out.x ? { x: out.x } : {}), ...(out.p ? { p: out.p } : {}) }, time: out.m.time, src: mine && recSig(out) !== recSig(inc) ? "" : src }); // a merge that holds more than the sender had must go back to it (no echo suppression)
    r.applied++; r.chats.add(chatId);
    c.index?.(out.m);
    if (out.m.attachments?.length && !out.m.deleted) c.wantMedia?.(out.m);
  }

  // ------------------------------------------------------------------ first activation: give pre-existing data a ledger entry with the zero stamp
  async bootstrap(): Promise<number> {
    const c = this.ctx; if (!c) throw new Error("sync is not active");
    const z = zeroStamp(c.device); let n = 0;
    const add = (kind: Kind, ids: string[], time?: string, meta?: unknown) => { if (c.ledger.putIfAbsent({ key: key(kind, ...ids), hlc: z, meta, time })) n++; };
    const rec = (x: StateRecord) => {
      switch (x.t) {
        case "account": return add("ac", [x.v.id]);
        case "alias": return add("al", [x.chatId]);
        case "flags": return add("fl", [x.chatId]);
        case "folder": return add("fo", [x.v.id]);
        case "chatFolder": return add("cf", [x.chatId]);
        case "mesh": return add("ms", [x.v.id]);
        case "merge": return add("me", [x.v.id]);
        case "message": return add("msg", [x.v.chatId, x.v.id], x.v.time, { c: z, r: z });
        case "chatCache": return add("cc", [x.accountId]);
        case "setting": return isSyncedSetting(x.key) ? add("se", [x.key]) : undefined;
        default: return undefined;
      }
    };
    let chunk: StateRecord[] = [];
    const flush = () => { const part = chunk; chunk = []; c.ledger.tx(() => { for (const x of part) rec(x); }); };
    for (const x of this.inner.exportRecords()) { chunk.push(x); if (chunk.length >= 2000) { flush(); await new Promise((ok) => setImmediate(ok)); } }
    flush();
    c.changed();
    return n;
  }
}
