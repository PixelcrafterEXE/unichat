// Groups v2 state: fetch + decrypt title / description / avatar / members for a group, given only its master key.
// Flow (as in Signal-Desktop ts/groups.preload.ts):
//   1. GET /v1/certificate/auth/group?redemptionStartSeconds&redemptionEndSeconds on the authenticated chat connection
//      -> daily AuthCredentialWithPni responses (ACI + PNI).
//   2. Per group: GroupSecretParams = derive(masterKey); presentation = ClientZkAuthOperations(serverPublicParams)
//      .createAuthCredentialWithPniPresentation(secretParams, credential).
//   3. GET https://storage.signal.org/v2/groups/  Authorization: Basic base64(hex(groupPublicParams) ":" hex(presentation)).
//   4. Decode Group (or GroupResponse) protobuf, decrypt blobs/userIds with ClientZkGroupCipher.
//   5. Avatar: GET <cdn>/<avatar path> (no credentials), decrypt with the group cipher.
// Fails soft: any error is logged as step + error class only (never ids, names, keys) and leaves the chat unchanged.
import { request } from "node:https";
import {
  AuthCredentialWithPniResponse, ClientZkAuthOperations, ClientZkGroupCipher, GroupMasterKey, GroupSecretParams, GroupSendEndorsementsResponse, ServerPublicParams,
  UuidCiphertext,
} from "@signalapp/libsignal-client/dist/zkgroup/index.js";
import { Aci, Pni } from "@signalapp/libsignal-client";
import type { CoreEvent } from "@unimsg/core";
import { AvatarUploadAttributesCodec, GroupAttributeBlobCodec, GroupCodec, GroupMemberRole, GroupResponseCodec, type AvatarUploadAttributesPb, type GroupPb } from "../protocol/codec.js";
import { toBytes } from "../protocol/bytes.js";
import type { SignalStore } from "../store/signalStore.js";
import { fetchCdn } from "./attachments.js";
import { CDN_URLS, SERVER_PUBLIC_PARAMS_B64, SIGNAL_TLS_ROOT_PEM, STORAGE_URL, USER_AGENT } from "./constants.js";
import { sniffImageMime } from "./ownProfile.js";

export interface AuthCredentialsResponse { credentials?: { credential: string; redemptionTime: number }[]; pni?: string }

/** Network edge, replaceable in tests. */
export interface GroupsTransport {
  authCredentials(startSeconds: number, endSeconds: number): Promise<AuthCredentialsResponse>;
  /** Resolves the raw body of GET /v2/groups/. Throws GroupsHttpError for non-200. */
  fetchGroup(basicAuth: string): Promise<Uint8Array>;
  /** Resolves the encrypted avatar blob. */
  fetchAvatar(path: string): Promise<Uint8Array>;
  // ---- write side (Groups v2 modify). Hypothesised wire details, see README "Unverified". ----
  /** PUT /v2/groups/ with a serialized Group; resolves the response body (GroupResponse or empty). */
  createGroup(basicAuth: string, group: Uint8Array): Promise<Uint8Array>;
  /** PATCH /v2/groups/ with serialized GroupChange.Actions; resolves the body (GroupChangeResponse). 409 = revision conflict. */
  modifyGroup(basicAuth: string, actions: Uint8Array): Promise<Uint8Array>;
  /** GET /v2/groups/avatar/form -> serialized AvatarUploadAttributes. */
  avatarForm(basicAuth: string): Promise<Uint8Array>;
  /** Multipart POST of the encrypted avatar to the groups CDN (cdn0) using the form attributes. */
  uploadAvatar(form: AvatarUploadAttributesPb, encrypted: Uint8Array): Promise<void>;
}

export class GroupsHttpError extends Error {
  constructor(readonly status: number, readonly body?: Uint8Array) { super(`HTTP ${status}`); this.name = "GroupsHttpError"; }
}

const DAY = 86_400;
const RETRY_COOLDOWN_MS = 60_000;
const AVATAR_PERSIST_MAX = 1024 * 1024;

export const groupsDebug = (line: string) => { if (process.env.UNIMSG_DEBUG === "1") console.debug(`[signal] groups v2: ${line}`); };
const errClass = (e: unknown) => e instanceof GroupsHttpError ? `http ${e.status}` : e instanceof Error ? e.name : "unknown";

class StepError extends Error { constructor(readonly step: string, readonly cause2: unknown) { super(step); } }
async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  try { return await fn(); } catch (e) { throw new StepError(name, e); }
}

/** Real HTTPS storage + CDN access; credentials come from the chat connection via `authCredentials`. */
export function httpsTransport(authCredentials: GroupsTransport["authCredentials"], opts: { storageUrl?: string; ca?: string } = {}): GroupsTransport {
  const storage = opts.storageUrl ?? STORAGE_URL;
  const call = (method: string, path: string, basicAuth: string, body?: Uint8Array) => new Promise<Uint8Array>((resolve, reject) => {
    const payload = body ? Buffer.from(body) : undefined;
    const req = request(new URL(path, storage), {
      method, ca: opts.ca ?? SIGNAL_TLS_ROOT_PEM, timeout: 30_000,
      headers: {
        authorization: `Basic ${basicAuth}`, "user-agent": USER_AGENT, accept: "application/x-protobuf",
        ...(payload ? { "content-type": "application/x-protobuf", "content-length": String(payload.length) } : {}),
      },
    }, (res) => {
      const parts: Buffer[] = []; let n = 0;
      res.on("data", (c: Buffer) => { n += c.length; if (n > 4 * 1024 * 1024) req.destroy(new Error("group state too large")); else parts.push(c); });
      res.on("end", () => {
        const data = Buffer.concat(parts);
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(data); else reject(new GroupsHttpError(res.statusCode ?? 0, data));
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("storage timeout")));
    req.on("error", reject);
    req.end(payload);
  });
  return {
    authCredentials,
    fetchGroup: (basicAuth) => call("GET", "/v2/groups/", basicAuth),
    createGroup: (basicAuth, group) => call("PUT", "/v2/groups/", basicAuth, group),
    modifyGroup: (basicAuth, actions) => call("PATCH", "/v2/groups/", basicAuth, actions),
    avatarForm: (basicAuth) => call("GET", "/v2/groups/avatar/form", basicAuth),
    uploadAvatar: (form, encrypted) => uploadAvatarMultipart(new URL(CDN_URLS[0]!), opts.ca ?? SIGNAL_TLS_ROOT_PEM, form, encrypted),
    fetchAvatar: async (path) => {
      let last: unknown;
      for (const cdn of [0, 2]) {
        try { return await fetchCdn(new URL(`${CDN_URLS[cdn]}/${path.split("/").map(encodeURIComponent).join("/")}`)); } catch (e) { last = e; }
      }
      throw last;
    },
  };
}

/** S3-style POST policy upload (what Signal-Desktop does with the avatar form): fields first, `file` last. */
function uploadAvatarMultipart(base: URL, ca: string, form: AvatarUploadAttributesPb, data: Uint8Array): Promise<void> {
  const boundary = `----unimsg${Buffer.from(Array.from({ length: 12 }, () => Math.floor(Math.random() * 256))).toString("hex")}`;
  const fields: [string, string | undefined][] = [
    ["key", form.key], ["x-amz-credential", form.credential], ["acl", form.acl], ["x-amz-algorithm", form.algorithm],
    ["x-amz-date", form.date], ["policy", form.policy], ["x-amz-signature", form.signature], ["Content-Type", "application/octet-stream"],
  ];
  const parts: Buffer[] = [];
  for (const [k, v] of fields) if (v !== undefined) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(data), Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return new Promise((resolve, reject) => {
    const req = request(base, { method: "POST", ca, timeout: 60_000, headers: { "user-agent": USER_AGENT, "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) } }, (res) => {
      res.resume();
      res.on("end", () => (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new GroupsHttpError(res.statusCode ?? 0))));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("cdn timeout")));
    req.on("error", reject);
    req.end(body);
  });
}
export const parseAvatarForm = (b: Uint8Array) => AvatarUploadAttributesCodec.decode(b);

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

export class GroupResolver {
  private readonly ops: ClientZkAuthOperations;
  private readonly serverParams: ServerPublicParams;
  private creds = new Map<number, AuthCredentialWithPniResponse>();
  private pni?: string;
  private inflight = new Map<string, Promise<void>>();
  private failedAt = new Map<string, number>();
  /** Decrypted avatars too big to persist (> AVATAR_PERSIST_MAX), kept in memory keyed by their CDN path. */
  private memAvatars = new Map<string, { path: string; data: Uint8Array; mime: string }>();
  private chain: Promise<void> = Promise.resolve();
  private now: () => number;

  constructor(
    private readonly store: SignalStore, private readonly transport: () => GroupsTransport,
    private readonly emit: (e: CoreEvent) => void,
    opts: { serverPublicParams?: Uint8Array; now?: () => number } = {},
  ) {
    this.serverParams = new ServerPublicParams(toBytes(opts.serverPublicParams ?? Buffer.from(SERVER_PUBLIC_PARAMS_B64, "base64")));
    this.ops = new ClientZkAuthOperations(this.serverParams);
    this.now = opts.now ?? Date.now;
  }

  memoryAvatar(chatId: string): { data: Uint8Array; mime: string } | undefined {
    const m = this.memAvatars.get(chatId), p = this.store.data.chats[chatId]?.avatarPath;
    return m && m.path === p ? { data: m.data, mime: m.mime } : undefined;
  }

  /** True when this chat needs (re)fetching for an announced `revision` (undefined = unknown revision). */
  needs(chatId: string, revision?: number): boolean {
    const rec = this.store.data.chats[chatId];
    if (!rec?.groupMasterKey) return false;
    if (rec.groupRevision === undefined) return true;
    return revision !== undefined && revision > rec.groupRevision;
  }

  /** Fire-and-forget friendly: queue a resolve if needed; the promise never rejects. */
  request(chatId: string, revision?: number, opts: { force?: boolean; ignoreCooldown?: boolean } = {}): Promise<void> {
    if (opts.force ? !this.store.data.chats[chatId]?.groupMasterKey : !this.needs(chatId, revision)) return Promise.resolve();
    const running = this.inflight.get(chatId);
    if (running) return running;
    const failed = this.failedAt.get(chatId);
    if (!opts.ignoreCooldown && failed !== undefined && this.now() - failed < RETRY_COOLDOWN_MS) return Promise.resolve();
    const p = (this.chain = this.chain.then(() => this.resolve(chatId))).finally(() => this.inflight.delete(chatId));
    this.inflight.set(chatId, p);
    return p;
  }

  /**
   * Make sure usable member state is cached before a send. State older than `maxAgeMs` is refetched (a failed refetch
   * keeps the old state). Returns "missing" only when there is no state at all.
   */
  async ensure(chatId: string, maxAgeMs: number): Promise<"cached" | "refreshed" | "missing"> {
    const state = () => { const r = this.store.data.chats[chatId]; return r?.groupMasterKey && r.groupRevision !== undefined && r.groupMembers ? r : undefined; };
    const before = state();
    if (before && this.now() - (before.groupFetchedAt ?? 0) < maxAgeMs) return "cached";
    await this.request(chatId, undefined, { force: true, ignoreCooldown: !before });
    const after = state();
    if (!after) return "missing";
    return after.groupFetchedAt !== before?.groupFetchedAt ? "refreshed" : "cached";
  }

  private async credentialFor(): Promise<{ response: AuthCredentialWithPniResponse; redemptionTime: number }> {
    const today = Math.floor(this.now() / 1000 / DAY) * DAY;
    let cached = this.creds.get(today);
    if (!cached) {
      const r = await step("credentials", () => this.transport().authCredentials(today, today + 7 * DAY));
      const list = r.credentials ?? [];
      this.creds.clear();
      for (const c of list) this.creds.set(c.redemptionTime, new AuthCredentialWithPniResponse(toBytes(Buffer.from(c.credential, "base64"))));
      if (r.pni) this.pni = r.pni.replace(/^PNI:/i, "");
      groupsDebug(`auth credentials received count=${list.length} pni=${this.pni ? 1 : 0}`);
      cached = this.creds.get(today);
      if (!cached) throw new StepError("credentials", new Error("no credential for today"));
    }
    return { response: cached, redemptionTime: today };
  }

  /** Basic-auth header value (group public params : auth credential presentation) for requests about the group of `secret`. */
  async authFor(secret: GroupSecretParams): Promise<string> {
    const { response, redemptionTime } = await this.credentialFor();
    const account = this.store.requireAccount();
    const pni = this.pni ?? account.pni;
    if (!pni) throw new StepError("presentation", new Error("no PNI"));
    const credential = this.ops.receiveAuthCredentialWithPniAsServiceId(Aci.fromUuid(account.aci), Pni.fromUuid(pni), redemptionTime, response);
    const presentation = this.ops.createAuthCredentialWithPniPresentation(secret, credential);
    return Buffer.from(`${hex(secret.getPublicParams().serialize())}:${hex(presentation.serialize())}`).toString("base64");
  }
  readonly publicServerParams = () => this.serverParams;

  private async resolve(chatId: string): Promise<void> {
    const rec = this.store.data.chats[chatId];
    if (!rec?.groupMasterKey) return;
    let stage = "start";
    try {
      groupsDebug("resolve start pending=1");
      const secret = GroupSecretParams.deriveFromMasterKey(new GroupMasterKey(toBytes(Buffer.from(rec.groupMasterKey, "base64"))));
      const publicParams = secret.getPublicParams();
      const { response, redemptionTime } = await this.credentialFor();
      stage = "presentation";
      const account = this.store.requireAccount();
      const pni = this.pni ?? account.pni;
      if (!pni) throw new StepError("presentation", new Error("no PNI"));
      const credential = this.ops.receiveAuthCredentialWithPniAsServiceId(Aci.fromUuid(account.aci), Pni.fromUuid(pni), redemptionTime, response);
      const presentation = this.ops.createAuthCredentialWithPniPresentation(secret, credential);
      const auth = Buffer.from(`${hex(publicParams.serialize())}:${hex(presentation.serialize())}`).toString("base64");
      stage = "fetch";
      const body = await this.transport().fetchGroup(auth);
      groupsDebug(`state fetched http=200 bytes=${body.length}`);
      stage = "decode";
      const parsed = decodeGroupResponse(body, publicParams.serialize());
      const group = parsed.group;
      const cipher = new ClientZkGroupCipher(secret);
      stage = "decrypt";
      const next = this.decryptState(group, cipher);
      groupsDebug(`decoded members=${next.members.length} pending=${group.membersPendingProfileKey?.length ?? 0} revision=${group.version ?? 0} title=${next.title ? "ok" : "missing"} description=${next.description ? "ok" : "missing"} avatar=${group.avatar ? "set" : "none"}`);

      let avatarB64 = rec.avatarB64, avatarMime = rec.avatarMime, avatarPath = rec.avatarPath;
      const prevPath = rec.avatarPath;
      if (!group.avatar) { avatarB64 = avatarMime = avatarPath = undefined; this.memAvatars.delete(chatId); }
      else if (group.avatar !== rec.avatarPath || (!rec.avatarB64 && this.memAvatars.get(chatId)?.path !== group.avatar)) {
        stage = "avatar";
        try {
          const blob = await this.transport().fetchAvatar(group.avatar);
          const data = GroupAttributeBlobCodec.decode(cipher.decryptBlob(toBytes(blob))).avatar;
          if (!data?.length) throw new Error("empty avatar");
          avatarPath = group.avatar; avatarMime = sniffImageMime(data);
          avatarB64 = data.length <= AVATAR_PERSIST_MAX ? Buffer.from(data).toString("base64") : undefined;
          if (avatarB64) this.memAvatars.delete(chatId); else this.memAvatars.set(chatId, { path: group.avatar, data: new Uint8Array(data), mime: avatarMime });
          groupsDebug(`avatar ok bytes=${data.length}`);
        } catch (e) {
          // the avatar is optional: keep title/members, retry the avatar on the next refresh
          avatarPath = undefined; avatarB64 = undefined; avatarMime = undefined;
          groupsDebug(`avatar failed reason=${errClass(e instanceof StepError ? e.cause2 : e)}`);
        }
      }
      const prevMembers = rec.groupMembers ?? [];
      this.store.upsertChat({
        id: chatId, kind: "group", ...(next.title ? { name: next.title } : {}),
        groupRevision: group.version ?? 0, groupMembers: next.members, groupAdmins: next.admins,
      });
      // upsertChat ignores undefined, so clear/replace optional fields explicitly
      const cur = this.store.data.chats[chatId]!;
      cur.groupFetchedAt = this.now();
      if (next.expireTimer !== undefined) cur.expireTimer = next.expireTimer;
      // a member left/was removed: rotate our sender key (they must not be able to decrypt future messages)
      if (prevMembers.some((m) => !next.members.some((n) => n.toLowerCase() === m.toLowerCase()))) { delete cur.skDistributionId; delete cur.skSharedWith; }
      cur.endorsements = this.receiveEndorsements(parsed.endorsements, group, secret) ?? cur.endorsements;
      cur.description = next.description; cur.avatarPath = avatarPath; cur.avatarB64 = avatarB64; cur.avatarMime = avatarMime;
      this.store.touch();
      await this.store.flush();
      this.failedAt.delete(chatId);
      groupsDebug("resolved ok=1 failed=0");
      this.emit({ type: "chats-changed", data: { chatId } });
      if (avatarPath !== prevPath) this.emit({ type: "avatar-changed", data: { id: chatId, kind: "chat" } });
    } catch (e) {
      this.failedAt.set(chatId, this.now());
      const s = e instanceof StepError ? e.step : stage;
      groupsDebug(`resolved ok=0 failed=1 step=${s} reason=${errClass(e instanceof StepError ? e.cause2 : e)}`);
    }
  }

  /** Validate + store group send endorsements (soft: any failure just disables the multi-recipient send path). */
  private receiveEndorsements(raw: Uint8Array | undefined, g: GroupPb, secret: GroupSecretParams): ChatRecordEndorsements | undefined {
    if (!raw?.length) return undefined;
    try {
      const cipher = new ClientZkGroupCipher(secret);
      const cts = (g.members ?? []).filter((m) => m.userId?.length).map((m) => new UuidCiphertext(toBytes(m.userId!)));
      const me = cipher.encryptServiceId(Aci.fromUuid(this.store.requireAccount().aci));
      const resp = new GroupSendEndorsementsResponse(toBytes(raw));
      const got = resp.receiveWithCiphertexts(cts, me, this.serverParams, new Date(this.now()));
      const members: Record<string, string> = {};
      cts.forEach((ct, i) => { members[cipher.decryptServiceId(ct).getServiceIdString().replace(/^PNI:/i, "").toLowerCase()] = Buffer.from(got.endorsements[i]!.serialize()).toString("base64"); });
      groupsDebug(`endorsements ok members=${cts.length}`);
      return { expiresAt: resp.getExpiration().getTime(), combined: Buffer.from(got.combinedEndorsement.serialize()).toString("base64"), members };
    } catch (e) {
      groupsDebug(`endorsements failed reason=${errClass(e)}`);
      return undefined;
    }
  }

  private decryptState(g: GroupPb, cipher: ClientZkGroupCipher) {
    const text = (b: Uint8Array | undefined, key: "title" | "descriptionText"): string | undefined => {
      if (!b?.length) return undefined;
      const v = GroupAttributeBlobCodec.decode(cipher.decryptBlob(toBytes(b)))[key];
      return v ? v : undefined;
    };
    const members: string[] = [], admins: string[] = [];
    for (const m of g.members ?? []) {
      if (!m.userId?.length) continue;
      try {
        const id = cipher.decryptServiceId(new UuidCiphertext(toBytes(m.userId))).getServiceIdString().replace(/^PNI:/i, "");
        members.push(id);
        if (m.role === GroupMemberRole.ADMINISTRATOR) admins.push(id);
      } catch { /* one undecryptable member must not lose the whole group */ }
    }
    let expireTimer: number | undefined;
    if (g.disappearingMessagesTimer?.length) {
      try { expireTimer = GroupAttributeBlobCodec.decode(cipher.decryptBlob(toBytes(g.disappearingMessagesTimer))).disappearingMessagesDuration ?? 0; } catch { /* optional */ }
    }
    return { title: text(g.title, "title"), description: text(g.descriptionBytes, "descriptionText"), members, admins, expireTimer };
  }
}

type ChatRecordEndorsements = NonNullable<import("../store/types.js").ChatRecord["endorsements"]>;

/** Like decodeGroup, but also returns the group send endorsements of a GroupResponse. */
export function decodeGroupResponse(body: Uint8Array, expectedPublicKey: Uint8Array): { group: GroupPb; endorsements?: Uint8Array } {
  const same = (g?: GroupPb) => !!g?.publicKey && Buffer.from(g.publicKey).equals(Buffer.from(expectedPublicKey));
  try { const r = GroupResponseCodec.decode(body); if (same(r.group)) return { group: r.group!, endorsements: r.groupSendEndorsementsResponse }; } catch { /* try bare Group */ }
  return { group: decodeGroup(body, expectedPublicKey) };
}

/** The endpoint returns a GroupResponse on current servers and a bare Group on older ones; the group's own public key tells which. */
export function decodeGroup(body: Uint8Array, expectedPublicKey: Uint8Array): GroupPb {
  const same = (g?: GroupPb) => !!g?.publicKey && Buffer.from(g.publicKey).equals(Buffer.from(expectedPublicKey));
  try { const r = GroupResponseCodec.decode(body); if (same(r.group)) return r.group!; } catch { /* try bare Group */ }
  const g = GroupCodec.decode(body);
  if (!same(g)) throw new Error("group state does not match the requested group");
  return g;
}
