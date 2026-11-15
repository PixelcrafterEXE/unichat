// Matrix provider (matrix-js-sdk 45, classic /sync, Rust crypto). See README.md for design notes.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  AutoDiscovery, ClientEvent, createClient, Direction, HttpApiEvent, MatrixError, MemoryStore, Method,
  NotificationCountType, Preset, ReceiptType, Visibility, RoomEvent, RoomMemberEvent, RoomStateEvent, SyncState, MatrixEvent, UserEvent,
  type MatrixClient, type Room, type RoomMember,
} from "matrix-js-sdk";
import type {
  AccountState, Chat, Connector, Contact, CoreEvent, HistoryQuery, LoginPrompt, Message, OutgoingMessage,
  LoginField, PrivacySetting, Profile, ProfilePatch, ProviderFactory, Space,
} from "@unimsg/core";
import type { Capabilities, VerificationAction } from "@unimsg/core";
import { logger as sdkLogger, type Logger } from "matrix-js-sdk/lib/logger.js";
import { decryptAttachment, encryptAttachment } from "./attach-crypto.js";
import { IdbPersister, installFakeIndexedDB } from "./idb-persist.js";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { decryptKeyFile } from "./keyfile.js";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import type { VerificationRequest } from "matrix-js-sdk/lib/crypto-api/verification.js";
import { Verifications } from "./verification.js";
import { deriveRecoveryKeyFromPassphrase } from "matrix-js-sdk/lib/crypto-api/key-passphrase.js";
import { emoticons, firstHttpUrl, linkPreviewContent, mentionContent, threadOf, groupReactions, locationContent, normalizeUserId, parseSpaceInvite, isCallEnd, isSpecialType, callCard, isPollEnd, isPollEvent, isPollResponse, isPollStart, parsePollStart, tallyPoll, pollStartContent, pollResponseContent, pollEndContent, isRedacted, mapMessage, pickEdit, relationOf, stripReplyFallback, UNDECRYPTABLE_TEXT, type RawEvent } from "./map.js";

const PROVIDER = "matrix";
const PREFS_TYPE = "org.unimsg.privacy";
const CAPS: Capabilities = {
  spaces: true, reactions: true, pinMessages: true, edits: true, deletes: true, replies: true, attachments: true, typing: true,
  readReceipts: true, receiptDetails: true, startChat: true, createGroup: true, backfill: true, fetchHistory: true, e2ee: true,
  location: true, voiceNotes: true, contactCards: false,
  leaveChat: true, manageMembers: true, renameChat: true, chatPicture: true, chatDescription: true, block: true, createSpace: true, joinSpace: true, polls: true, leaveSpace: true,
  avatars: true, profile: { displayName: true, about: false, avatar: true }, privacy: true, mentions: true, requests: true, customEmoji: true, presence: true, verification: true,
};

// The SDK (and Rust crypto) log verbosely; drop it all. Problems are surfaced through {type:"error"} events instead.
const SILENT: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild() { return SILENT; } };

// The SDK's module-level logger (HTTP traces with room ids, RTC, send queue...) ignores the per-client `logger` option and would
// print to the Hub's stdout. Silence it globally (found against a real homeserver).
(sdkLogger as any).methodFactory = () => () => {};
(sdkLogger as any).setLevel("silent", false);

interface Session { baseUrl: string; userId: string; deviceId: string; accessToken: string; cryptoKey: string }

/** Convert an SDK event (decrypted if possible) to the plain shape used by map.ts. */
function raw(ev: MatrixEvent): RawEvent {
  const redacted = ev.isRedacted();
  return {
    event_id: ev.getId() ?? "", sender: ev.getSender() ?? "", type: ev.getType(), origin_server_ts: ev.getTs(),
    content: ev.getContent() as Record<string, any>,
    unsigned: redacted ? { redacted_because: true } : ev.isState() ? { prev_content: ev.getPrevContent() } : undefined,
    state_key: ev.getStateKey(),
  };
}
const encRoomId = encodeURIComponent;
const DEVICE_NAME = "UniChat";

class MatrixConnector implements Connector {
  readonly capabilities = CAPS;
  private emitFn: (e: CoreEvent) => void = () => {};
  private client?: MatrixClient;
  private session?: Session;
  private persister?: IdbPersister;
  private stopped = false;
  private started = false;
  private pendingLogin?: { promptId: string; sso?: Server };
  /** Prompt id of an open "restore key backup" form, the recovery key typed at login (restored after the first sync) and the secret-storage key while a restore runs. */
  private restorePrompt?: string; private importPrompt?: string; private pendingRecovery?: string; private ssKey?: Uint8Array;
  private ownTxn = new Set<string>();      // txn ids of messages we sent (their remote echo is not re-emitted)
  private ownEvents = new Set<string>();
  private reactionIndex = new Map<string, { chatId: string; targetId: string }>();
  private serverStart = 0; private seenEvents = new Set<string>(); private roomFirstSeen = new Map<string, number>();
  private avatarCache = new Map<string, Promise<string | undefined>>();
  private dirty = new Set<string>(); private dirtyAll = false; private flushTimer?: ReturnType<typeof setTimeout>;
  private sessionFile: string;
  private accountId: string; private dataDir: string;

  constructor(accountId: string, dataDir: string) {
    this.accountId = accountId; this.dataDir = dataDir;
    this.sessionFile = join(dataDir, "matrix-session.json");
    this.verif = new Verifications({
      accountId, client: () => this.client, me: () => this.me, emit: (e) => this.emit(e), err: (c, e) => this.err(c, e),
      withSecretKey: async (k, fn) => { this.ssKey = k; try { return await fn(); } finally { this.ssKey = undefined; } },
      keyFromInput: (i) => this.secretKeyFrom(i),
    });
  }
  private verif: Verifications;
  /** Sessions made before UniChat named its device (or by other apps) show a random id in other clients: rename it once, only while it still has the default name. */
  private async ensureDeviceName(c: MatrixClient) {
    try {
      const id = c.getDeviceId(); if (!id) return;
      const dn = (await c.getDevice(id)).display_name;
      if (!dn || dn === id || /^[A-Za-z0-9]{10}$/.test(dn)) await c.setDeviceDetails(id, { display_name: DEVICE_NAME });
    } catch { /* cosmetic: ignore */ }
  }

  // ------------------------------------------------------------------ plumbing
  private emit(e: CoreEvent) { try { this.emitFn(e); } catch { /* never throw from handlers */ } }
  private lastState = "";
  /** Announce a state only when it (or its detail) changed: repeated "connected" announcements make every UI drop and reload its cached chats. */
  private state(state: AccountState, detail?: string) { const sig = state + "|" + (detail ?? ""); if (sig === this.lastState) return; this.lastState = sig; this.emit({ type: "account", data: { id: this.accountId, state, detail } }); }
  /** Error reporting: only error class / errcode, never content, tokens or keys. */
  private err(code: string, e: unknown, fatal = false) {
    const m = e instanceof MatrixError ? `${e.errcode ?? "error"}${e.httpStatus ? ` (HTTP ${e.httpStatus})` : ""}` : e instanceof Error ? e.name + ": " + e.message.slice(0, 200) : "unknown error";
    this.emit({ type: "error", data: { id: this.accountId, code, message: m, fatal } });
  }
  private guard<A extends unknown[]>(code: string, fn: (...a: A) => void | Promise<void>) {
    return (...a: A) => { try { const r = fn(...a); if (r instanceof Promise) r.catch((e) => this.err(code, e)); } catch (e) { this.err(code, e); } };
  }
  private markDirty(chatId?: string) {
    if (chatId) this.dirty.add(chatId); else this.dirtyAll = true;
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      if (this.dirtyAll) this.emit({ type: "chats-changed", data: {} });
      else for (const id of this.dirty) this.emit({ type: "chats-changed", data: { chatId: id } });
      this.dirty.clear(); this.dirtyAll = false;
    }, 250);
  }
  private room(chatId: string): Room {
    const r = this.client?.getRoom(chatId);
    if (!r) throw new Error("unknown room");
    return r;
  }
  private get me(): string { return this.client?.getUserId() ?? this.session?.userId ?? ""; }
  private nameOf(room: Room | null | undefined, userId: string): string {
    return room?.getMember(userId)?.name ?? userId;
  }

  // ------------------------------------------------------------------ lifecycle
  async start(emit: (e: CoreEvent) => void) {
    this.lastState = ""; // a fresh start announces its states again
    this.emitFn = emit; this.stopped = false;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.state("connecting");
    const s = this.loadSession();
    if (!s) { this.promptLogin(); return; }
    // Do not block the Hub: resolve once the attempt is underway.
    void this.connect(s).catch((e) => this.fail(e));
  }

  // ------------------------------------------------------------------ presence (light: only the peers of our 1:1 rooms)
  // The SDK keeps `disablePresence: true` (we do not announce OUR presence). The server may still push m.presence of people we share rooms
  // with; we pass on only the DM peers' (no event for the rest). On top, the peers are asked once and then every 5 min with GET /presence/{user}/status
  // (sequential, 300 ms apart, at most 40 peers, so at most ~8 requests a minute); a server that refuses (presence disabled, M_FORBIDDEN / 404) stops the polling.
  private presenceOn = true; private presenceTimer?: ReturnType<typeof setTimeout>; private presenceBroken = 0;
  private presenceSeen = new Map<string, string>();
  setPresenceEnabled(on: boolean) { this.presenceOn = on; if (!on) { this.clearPresenceTimer(); this.presenceSeen.clear(); } else if (this.client && this.started) this.schedulePresence(2000); }
  private clearPresenceTimer() { if (this.presenceTimer) clearTimeout(this.presenceTimer); this.presenceTimer = undefined; }
  private schedulePresence(ms: number) { this.clearPresenceTimer(); if (this.presenceOn && !this.stopped && this.presenceBroken < 3) this.presenceTimer = setTimeout(() => { void this.pollPresence(); }, ms); }
  private emitPresence(userId: string, presence: string | undefined, lastActiveAgo?: number) {
    if (!this.presenceOn || !presence) return;
    const rooms = [...this.directMap()].filter(([, u]) => u === userId).map(([r]) => r);
    if (!rooms.length) return; // not someone we have a 1:1 chat with
    const online = presence === "online" || presence === "unavailable"; // "unavailable" = idle
    const lastSeen = !online && typeof lastActiveAgo === "number" && lastActiveAgo >= 0 ? new Date(Date.now() - lastActiveAgo).toISOString() : undefined;
    const sig = `${online}|${lastSeen ? lastSeen.slice(0, 16) : ""}`; if (this.presenceSeen.get(userId) === sig) return; this.presenceSeen.set(userId, sig);
    for (const chatId of rooms) this.emit({ type: "presence", data: { accountId: this.accountId, chatId, contactId: userId, online, ...(lastSeen ? { lastSeen } : {}) } });
  }
  private async pollPresence() {
    const c = this.client; if (!c || this.stopped || !this.presenceOn) return;
    const peers = [...new Set(this.directMap().values())].filter((u) => u !== this.me).slice(0, 40);
    for (const u of peers) {
      if (this.stopped || !this.presenceOn || c !== this.client) return;
      try { const r = await c.getPresence(u); this.presenceBroken = 0; this.emitPresence(u, r.presence, r.last_active_ago); }
      catch (e) { if (e instanceof MatrixError && (e.httpStatus === 403 || e.httpStatus === 404 || e.httpStatus === 400)) { if (e.httpStatus !== 404) this.presenceBroken++; } else this.presenceBroken++; if (this.presenceBroken >= 3) return; }
      await new Promise((r) => setTimeout(r, 300));
    }
    this.schedulePresence(5 * 60_000);
  }

  async stop() {
    this.stopped = true; this.clearPresenceTimer(); this.verif.dispose();
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    this.closeSso();
    const c = this.client; this.client = undefined;
    try { c?.stopClient(); } catch { /* ignore */ }
    try { await this.persister?.stop(); } catch { /* ignore */ }
    this.persister = undefined; this.started = false;
  }

  async logout() {
    const c = this.client;
    let warning: string | undefined;
    try { await c?.logout(true); }
    catch (e) { // an already-invalid token means the session is gone: fine. Anything else: the server may still list this session.
      if (!(e instanceof MatrixError && (e.errcode === "M_UNKNOWN_TOKEN" || e.httpStatus === 401)))
        warning = "Couldn't reach the Matrix server to end this session. Remove it manually, for example in Element: Settings > Sessions.";
    }
    const persister = this.persister;
    await this.stop();
    const wipe = () => { for (const f of ["matrix-session.json", "matrix-crypto.bin", "matrix-crypto.bin.tmp"]) rmSync(join(this.dataDir, f), { force: true }); };
    if (persister) await persister.drop(wipe); else wipe();
    this.session = undefined;
    this.state("needs-login");
    if (warning) throw new Error(warning);
  }

  private fail(e: unknown) {
    if (this.stopped) return;
    this.err("start-failed", e);
    // Network trouble at startup: retry with backoff; credential problems: needs-login.
    if (e instanceof MatrixError && (e.errcode === "M_UNKNOWN_TOKEN" || e.httpStatus === 401)) { this.invalidate(); return; }
    this.state("disconnected");
    setTimeout(() => { const s = this.session; if (!this.stopped && s) void this.connect(s).catch((x) => this.fail(x)); }, 15_000).unref?.();
  }

  /** Credentials are gone: wipe the session and ask for a new login. */
  private invalidate() {
    if (this.stopped) return;
    try { this.client?.stopClient(); } catch { /* ignore */ }
    this.client = undefined; this.started = false;
    // wipe the session first (sync), then the crypto snapshot; stop() must not write the snapshot back afterwards
    const wipe = () => { for (const f of ["matrix-session.json", "matrix-crypto.bin", "matrix-crypto.bin.tmp"]) rmSync(join(this.dataDir, f), { force: true }); };
    wipe();
    const persister = this.persister; this.persister = undefined;
    if (persister) void persister.drop(wipe); else wipe();
    this.session = undefined;
    this.state("needs-login", "session invalidated");
    this.promptLogin("Session expired or revoked – please log in again.");
  }

  // ------------------------------------------------------------------ session persistence
  private loadSession(): Session | undefined {
    try {
      if (!existsSync(this.sessionFile)) return undefined;
      const s = JSON.parse(readFileSync(this.sessionFile, "utf8")) as Session;
      return s.baseUrl && s.accessToken && s.userId && s.deviceId && s.cryptoKey ? s : undefined;
    } catch { return undefined; }
  }
  private saveSession(s: Session) {
    writeFileSync(this.sessionFile, JSON.stringify(s), { mode: 0o600 });
    try { chmodSync(this.sessionFile, 0o600); } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------ login
  private promptLogin(error?: string) {
    const promptId = randomBytes(6).toString("hex");
    this.pendingLogin = { promptId };
    const p: LoginPrompt = {
      accountId: this.accountId, promptId, kind: "form", title: "Matrix login", error,
      fields: [
        { name: "homeserver", label: "Homeserver (e.g. matrix.org or https://matrix.example.com)", type: "text", placeholder: "matrix.org" },
        { name: "method", label: "Sign in with", type: "select", value: "password", options: [{ value: "password", label: "Username and password" }, { value: "sso", label: "Single sign-on in the browser (Google, GitHub, company login...)" }] },
        { name: "username", label: "Username (only for username and password)", type: "text", placeholder: "alice or @alice:matrix.org" },
        { name: "password", label: "Password (only for username and password)", type: "password" },
        { name: "recoverykey", label: "Recovery key or passphrase of your message backup (optional - lets this device read older encrypted messages)", type: "password" },
      ],
    };
    this.emit({ type: "login", data: p });
  }

  async submitLogin(promptId: string, values: Record<string, string>) {
    if (this.restorePrompt && this.restorePrompt === promptId) { // "restore key backup" form of the settings entry
      const r = await this.restoreBackup(values.recoverykey ?? ""); // throws a readable error: the UI shows it and re-prompts
      this.restorePrompt = undefined;
      this.state("connected", `Restored ${r.imported} of ${r.total} message keys`);
      return;
    }
    if (this.importPrompt && this.importPrompt === promptId) {
      const r = await this.importKeyFile(values.keyfile ?? "", values.passphrase ?? ""); // throws a readable error: re-prompts
      this.importPrompt = undefined; this.state("connected", `Imported ${r} message keys from the file`);
      return;
    }
    if (!this.pendingLogin || this.pendingLogin.promptId !== promptId) throw new Error("stale login prompt");
    const baseUrl = await this.resolveHomeserver((values.homeserver ?? "").trim());
    const username = (values.username ?? "").trim();
    const password = values.password ?? "";
    this.closeSso();
    if (values.method === "sso" || (!username && !password)) { await this.startSso(baseUrl); return; }
    if (!username || !password) throw new Error("Enter both username and password, or choose \"Single sign-on\".");
    const tmp = createClient({ baseUrl });
    let res;
    try { res = await tmp.login("m.login.password", { identifier: { type: "m.id.user", user: username }, password, initial_device_display_name: DEVICE_NAME }); }
    catch (e) {
      if (e instanceof MatrixError && (e.errcode === "M_FORBIDDEN" || e.httpStatus === 403)) throw new Error("Invalid username or password.");
      if (e instanceof MatrixError && e.errcode === "M_USER_DEACTIVATED") throw new Error("This account has been deactivated.");
      if (e instanceof MatrixError && e.errcode === "M_LIMIT_EXCEEDED") throw new Error("Too many attempts – try again later.");
      throw new Error("Could not log in: " + (e instanceof MatrixError ? e.errcode ?? `HTTP ${e.httpStatus}` : "server unreachable"));
    }
    this.pendingRecovery = (values.recoverykey ?? "").trim() || undefined;
    await this.finishLogin(baseUrl, res);
  }

  private async finishLogin(baseUrl: string, res: { access_token: string; device_id: string; user_id: string }) {
    const s: Session = { baseUrl, userId: res.user_id, deviceId: res.device_id, accessToken: res.access_token, cryptoKey: randomBytes(32).toString("base64") };
    this.saveSession(s);
    this.pendingLogin = undefined;
    void this.connect(s).catch((e) => this.fail(e));
  }

  private async resolveHomeserver(input: string): Promise<string> {
    if (!input) throw new Error("Homeserver is required.");
    if (/^https?:\/\//i.test(input)) return input.replace(/\/+$/, "");
    const cfg = await AutoDiscovery.findClientConfig(input).catch(() => undefined);
    const hs = cfg?.["m.homeserver"];
    if (hs?.base_url) return hs.base_url.replace(/\/+$/, "");
    return `https://${input.replace(/\/+$/, "")}`;
  }

  /** SSO: local 127.0.0.1 listener receives ?loginToken=... after the browser flow. Only works if the browser can reach this host's loopback. */
  private async startSso(baseUrl: string) {
    const tmp = createClient({ baseUrl });
    const flows = await tmp.loginFlows().catch(() => { throw new Error("Could not query login flows."); });
    if (!flows.flows.some((f) => f.type === "m.login.sso")) throw new Error("This homeserver has no browser sign-in (SSO); it only supports username and password. Choose \"Username and password\" and enter your Matrix username and password.");
    const promptId = randomBytes(6).toString("hex");
    const server = createServer((req, res) => {
      const token = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("loginToken");
      res.setHeader("content-type", "text/plain");
      if (!token) { res.statusCode = 400; res.end("Missing token"); return; }
      res.end("Login complete. You can close this tab and return to UniChat.");
      this.closeSso();
      tmp.login("m.login.token", { token, initial_device_display_name: DEVICE_NAME })
        .then((r) => this.finishLogin(baseUrl, r))
        .catch((e) => { this.err("sso-failed", e); this.promptLogin("SSO login failed."); });
    });
    await new Promise<void>((ok, ko) => { server.once("error", ko); server.listen(0, "127.0.0.1", ok); });
    const port = (server.address() as { port: number }).port;
    const url = tmp.getSsoLoginUrl(`http://127.0.0.1:${port}/`, "sso");
    this.pendingLogin = { promptId, sso: server };
    setTimeout(() => { if (this.pendingLogin?.sso === server) { this.closeSso(); this.promptLogin("SSO timed out."); } }, 5 * 60_000).unref?.();
    this.emit({ type: "login", data: { accountId: this.accountId, promptId, kind: "link", payload: url, hint: "Open this link in a browser on this computer and sign in there. When the page says \"Login complete\", come back here. (It must be the same computer that runs UniChat.)" } });
  }
  private closeSso() { try { this.pendingLogin?.sso?.close(); } catch { /* ignore */ } if (this.pendingLogin) this.pendingLogin.sso = undefined; }

  // ------------------------------------------------------------------ connect
  private async connect(s: Session) {
    if (this.started || this.stopped) return;
    this.started = true; this.session = s;
    const idb = await installFakeIndexedDB();
    const prefix = `unimsg-${this.accountId}`;
    const persister = this.persister = new IdbPersister(idb, prefix, join(this.dataDir, "matrix-crypto.bin"), (e) => this.err("persist-failed", e));
    await persister.restore();

    // Server-clock time of this start (Date header), used to tell backlog re-delivered by /sync from genuinely new events.
    this.serverStart = Date.now();
    try {
      const r = await fetch(`${s.baseUrl}/_matrix/client/versions`, { signal: AbortSignal.timeout(5000) });
      const d = Date.parse(r.headers.get("date") ?? "");
      if (Number.isFinite(d)) this.serverStart = d + 500 + (Date.now() - this.serverStart) / 2; // Date has 1 s resolution: take the middle (+-0.5 s)
    } catch { /* offline: local clock */ }
    const client = this.client = createClient({
      baseUrl: s.baseUrl, userId: s.userId, deviceId: s.deviceId, accessToken: s.accessToken,
      store: new MemoryStore({ localStorage: undefined }), logger: SILENT,
      cryptoCallbacks: { getSecretStorageKey: async ({ keys }) => (this.ssKey ? [Object.keys(keys)[0], this.ssKey as Uint8Array<ArrayBuffer>] : null) },
    });
    this.attach(client);
    await client.initRustCrypto({ cryptoDatabasePrefix: prefix, storageKey: Buffer.from(s.cryptoKey, "base64") });
    persister.start();
    await persister.flush();
    await client.startClient({ initialSyncLimit: 20, lazyLoadMembers: true, threadSupport: false, disablePresence: true });
  }

  private attach(c: MatrixClient) {
    let first = true;
    c.on(HttpApiEvent.SessionLoggedOut, () => this.invalidate());
    const changed = () => this.verif.changed();
    c.on(CryptoEvent.UserTrustStatusChanged as never, ((userId: string) => { if (userId === this.me) changed(); }) as never); // this device / my cross-signing became (un)verified
    c.on(CryptoEvent.KeyBackupStatus as never, changed as never);
    c.on(CryptoEvent.VerificationRequestReceived as never, ((req: VerificationRequest) => {
      try { this.verif.received(req); } catch (e) { this.err("verify", e); } // the UI shows "X wants to verify you" with Accept / Decline
    }) as never);
    c.on(ClientEvent.Sync, (st: SyncState, _prev: SyncState | null, data?: { error?: Error }) => {
      if (this.stopped || c !== this.client) return;
      switch (st) {
        case SyncState.Prepared: case SyncState.Syncing: case SyncState.Catchup:
          this.state("connected");
          if (first) {
            first = false; void this.ensureDeviceName(c); this.emit({ type: "spaces-changed", data: {} }); this.markDirty(); this.schedulePresence(3000); void this.persister?.flush();
            const rk = this.pendingRecovery; this.pendingRecovery = undefined;
            if (rk) void this.restoreBackup(rk).then(() => this.markDirty(), (e) => this.emit({ type: "error", data: { id: this.accountId, code: "backup-restore-failed", message: e instanceof Error ? e.message : "Key backup restore failed" } }));
          }
          break;
        case SyncState.Reconnecting: this.state("connecting"); break;
        case SyncState.Error: {
          const e = data?.error;
          if (e instanceof MatrixError && (e.errcode === "M_UNKNOWN_TOKEN" || e.errcode === "M_USER_DEACTIVATED")) { this.invalidate(); break; }
          this.state("disconnected"); // the SDK keeps retrying with backoff
          if (e) this.err("sync", e);
          break;
        }
        case SyncState.Stopped: break;
      }
    });
    c.on(ClientEvent.Room, this.guard("room", (r: Room) => { if (c.isInitialSyncComplete() && !this.roomFirstSeen.has(r.roomId)) this.roomFirstSeen.set(r.roomId, Date.now()); this.emit({ type: "spaces-changed", data: {} }); this.markDirty(); }));
    c.on(ClientEvent.DeleteRoom, this.guard("room", () => { this.emit({ type: "spaces-changed", data: {} }); this.markDirty(); }));
    c.on(ClientEvent.AccountData, this.guard("account-data", (ev: MatrixEvent) => {
      if (ev.getType() === PREFS_TYPE) this.prefsLocal = undefined; // synced value is authoritative
 if (ev.getType() === "m.direct" || ev.getType() === "m.ignored_user_list") this.markDirty(); }));
    c.on(UserEvent.Presence as never, this.guard("presence", (_ev: MatrixEvent | undefined, u: { userId: string; presence?: string; lastActiveAgo?: number }) => this.emitPresence(u.userId, u.presence, u.lastActiveAgo)) as never);
    c.on(RoomEvent.MyMembership, this.guard("membership", () => { this.emit({ type: "spaces-changed", data: {} }); this.markDirty(); }));
    c.on(RoomEvent.Name, this.guard("name", (r: Room) => this.markDirty(r.roomId)));
    c.on(RoomStateEvent.Events, this.guard("state", (ev: MatrixEvent) => {
      const t = ev.getType();
      if (t === "m.space.child" || t === "m.room.create") this.emit({ type: "spaces-changed", data: {} });
      if (t === "m.room.pinned_events" && ev.getStateKey() === "") this.onPinnedEvents(ev);
      if (t === "m.space.child" || t === "m.room.avatar" || t === "m.room.power_levels" || t === "m.room.name" || t === "m.room.topic") this.markDirty(t === "m.space.child" ? undefined : ev.getRoomId());
    }));
    c.on(RoomEvent.Timeline, this.guard("timeline", (ev: MatrixEvent, room: Room | undefined, toStart: boolean | undefined, removed: boolean, data: { liveEvent?: boolean }) =>
      this.onTimeline(c, ev, room, toStart, removed, data)));
    c.on(RoomEvent.Redaction, this.guard("redaction", (ev: MatrixEvent, room: Room) => this.onRedaction(ev, room)));
    c.on(RoomEvent.Receipt, this.guard("receipt", (ev: MatrixEvent, room: Room) => this.onReceipt(ev, room)));
    c.on(RoomMemberEvent.Typing, this.guard("typing", (_ev: MatrixEvent, m: RoomMember) => {
      if (m.userId === this.me) return;
      this.emit({ type: "typing", data: { chatId: m.roomId, senderId: m.userId, typing: !!m.typing } });
    }));
  }

  // ------------------------------------------------------------------ incoming events
  private async onTimeline(c: MatrixClient, ev: MatrixEvent, room: Room | undefined, toStart: boolean | undefined, removed: boolean, data: { liveEvent?: boolean }) {
    if (!room || toStart || removed) return;
    // The SDK keeps delivering the initial sync's room timelines as "live" events AFTER it reported PREPARED (rooms are processed in
    // slices, seen against Synapse after a restart) and delivers the whole timeline of a room when it is joined. Remember every event id and drop repeats; also drop the pre-join backlog of a newly joined room.
    const eid = ev.getId() ?? "";
    const dup = this.seenEvents.has(eid);
    if (eid && !dup) { this.seenEvents.add(eid); if (this.seenEvents.size > 50_000) this.seenEvents.delete(this.seenEvents.values().next().value as string); }
    if (dup) return;
    if (!data?.liveEvent) return;
    if (room.getMyMembership() !== "join") return;
    // Skip everything delivered by the initial sync (history() serves the backlog; the Hub has no dedup).
    if (!c.isInitialSyncComplete()) return;
    if (ev.getTs() < this.serverStart) return; // sent before this connector started: backlog (history() serves it)
    const joinedAt = this.roomFirstSeen.get(room.roomId);
    if (joinedAt && Date.now() - joinedAt < 15_000 && ev.getTs() < joinedAt - 5000) return; // (bounded window: tolerates clock skew afterwards)
    const txn = ev.getTxnId();
    if (ev.getSender() === this.me && ((txn && this.ownTxn.has(txn)) || this.ownEvents.has(ev.getId() ?? ""))) { this.markDirty(room.roomId); return; }
    if (ev.isBeingDecrypted() || ev.getType() === "m.room.encrypted") {
      await c.decryptEventIfNeeded(ev).catch(() => undefined);
      if (ev.getType() === "m.room.encrypted" || ev.isDecryptionFailure()) {
        // Keys may arrive later: re-evaluate when the SDK retries decryption.
        ev.once("Event.decrypted" as never, ((e: MatrixEvent) => { void this.onLateDecrypt(e, room); }) as never);
      }
    }
    this.dispatch(ev, room);
    this.markDirty(room.roomId);
  }

  private dispatch(ev: MatrixEvent, room: Room) {
    const r = raw(ev);
    const rel = relationOf(r);
    const chatId = room.roomId;
    if (r.type === "m.reaction") {
      if (rel.relType === "m.annotation" && rel.eventId && r.event_id) {
        this.reactionIndex.set(r.event_id, { chatId, targetId: rel.eventId });
        this.emitReactions(room, rel.eventId);
      }
      return;
    }
    if (isCallEnd(r.type)) { this.emitCall(room, String(r.content?.call_id ?? "")); return; }
    if ((isPollResponse(r.type) || isPollEnd(r.type)) && rel.eventId) { this.emitPoll(room, rel.eventId, r); return; }
    if (rel.relType === "m.replace" && rel.eventId) {
      const orig = room.findEventById(rel.eventId);
      if (!orig) return;
      const edit = pickEdit(raw(orig), [r]);
      const nc = edit?.content["m.new_content"];
      if (!edit || !nc) return;
      this.emit({ type: "message-update", data: { chatId, messageId: rel.eventId, patch: {
        text: stripReplyFallback(typeof nc.body === "string" ? nc.body : "", !!relationOf(raw(orig)).replyTo), editedAt: new Date(edit.origin_server_ts).toISOString() } } });
      return;
    }
    const m = this.toMessage(room, ev);
    if (m) this.emit({ type: "message", data: m });
  }

  private async onLateDecrypt(ev: MatrixEvent, room: Room) {
    if (ev.getType() === "m.room.encrypted") return;
    const lr = raw(ev);
    if (isPollResponse(lr.type) || isPollEnd(lr.type)) { const t = relationOf(lr).eventId; if (t) this.emitPoll(room, t, lr); return; }
    const m = this.toMessage(room, ev);
    if (m) this.emit({ type: "message-update", data: { chatId: room.roomId, messageId: m.id, patch: m.poll ? { text: m.text, poll: m.poll } : { text: m.text } } });
  }

  private toMessage(room: Room, ev: MatrixEvent): Message | null {
    const r = raw(ev);
    const edit = this.editFor(room, ev);
    const mapped = mapMessage(r, {
      accountId: this.accountId, chatId: room.roomId, selfId: this.me,
      nameOf: (u) => this.nameOf(room, u), edit, reactions: this.reactionsFor(room, r.event_id),
      memberCount: room.getJoinedMemberCount(), callRelated: r.type === "m.call.invite" ? this.callRelated(room) : undefined,
      ...(isPollStart(r.type) ? { pollRelated: this.pollRelated(room, r.event_id), isMember: (u: string) => this.isMember(room, u), canEndPoll: (u: string) => this.canEnd(room, u) } : {}),
      replyPreview: (id) => {
        const t = room.findEventById(id); if (!t) return undefined;
        const m = mapMessage(raw(t), { chatId: room.roomId, selfId: this.me, nameOf: (u) => this.nameOf(room, u) });
        return m ? { sender: m.sender, textPreview: m.text.slice(0, 120) } : undefined;
      },
    });
    return mapped && r.event_id && this.pinnedIds(room).includes(r.event_id) ? { ...mapped, pinned: true } : mapped;
  }

  /** MSC3381: a poll may also be ended by a user who could redact the poll start (room admins/moderators). */
  private canEnd(room: Room, userId: string): boolean {
    const m = room.getMember(userId);
    return !!m && room.currentState.hasSufficientPowerLevelFor("redact", m.powerLevel);
  }

  private isMember(room: Room, userId: string): boolean {
    const m = room.getMember(userId);
    return !m || m.membership === "join"; // unknown (lazy-loaded) members are given the benefit of the doubt
  }

  /** Poll responses/end events for a poll: aggregated relations plus a scan of the live timeline, plus `extra`. */
  private pollRelated(room: Room, pollId: string, extra?: RawEvent[]): RawEvent[] {
    const byId = new Map<string, RawEvent>();
    const take = (e: MatrixEvent) => { const t = e.getType(); if (isPollEvent(t) && !isPollStart(t) && e.getRelation()?.event_id === pollId && !e.isRedacted()) byId.set(e.getId() ?? "", raw(e)); };
    for (const e of room.relations.getAllChildEventsForEvent(pollId)) take(e);
    for (const e of room.getLiveTimeline().getEvents()) take(e);
    for (const e of extra ?? []) byId.set(e.event_id, e);
    return [...byId.values()];
  }

  private callRelated(room: Room): RawEvent[] {
    return room.getLiveTimeline().getEvents().filter((e) => isCallEnd(e.getType())).map(raw);
  }

  /** An answer/hangup/reject arrived: refresh the card of the invite with the same call_id (one card per call). */
  private emitCall(room: Room, callId: string) {
    if (!callId) return;
    const inv = room.getLiveTimeline().getEvents().find((e) => e.getType() === "m.call.invite" && e.getContent().call_id === callId);
    if (!inv) return;
    const card = callCard(raw(inv), this.callRelated(room), this.me);
    this.emit({ type: "message-update", data: { chatId: room.roomId, messageId: inv.getId() ?? "", patch: { text: card.title, card } } });
  }

  private emitPoll(room: Room, pollId: string, extra?: RawEvent) {
    const start = room.findEventById(pollId);
    if (!start || !isPollStart(start.getType())) return;
    const sr = raw(start); const ps = parsePollStart(sr);
    if (!ps || sr.unsigned?.redacted_because) return;
    const poll = tallyPoll(sr, ps, this.pollRelated(room, pollId, extra ? [extra] : undefined), this.me, (u) => this.isMember(room, u), (u) => this.canEnd(room, u));
    this.emit({ type: "message-update", data: { chatId: room.roomId, messageId: pollId, patch: { poll } } });
  }

  private editFor(room: Room, ev: MatrixEvent): RawEvent | undefined {
    const id = ev.getId(); if (!id) return undefined;
    const rel = room.relations.getChildEventsForEvent(id, "m.replace", ev.getType());
    return pickEdit(raw(ev), (rel?.getRelations() ?? []).map(raw));
  }

  private reactionsFor(room: Room, eventId: string, extra?: { id: string; key: string; sender: string }, exclude?: string) {
    const rel = room.relations.getChildEventsForEvent(eventId, "m.annotation", "m.reaction");
    const seen = new Map<string, { key: string; sender: string }>();
    for (const e of rel?.getRelations() ?? []) {
      const id = e.getId(); const k = e.getRelation()?.key; const s = e.getSender();
      if (id && k && s && id !== exclude && !e.isRedacted()) seen.set(id, { key: k, sender: s });
    }
    if (extra && extra.id !== exclude) seen.set(extra.id, extra);
    return groupReactions(seen.values(), this.me);
  }

  private emitReactions(room: Room, targetId: string, exclude?: string) {
    const reactions = this.reactionsFor(room, targetId, undefined, exclude);
    // The just-arrived event may not be aggregated yet; fold in everything we indexed for this target.
    const extra = [...this.reactionIndex.entries()].filter(([id, v]) => v.targetId === targetId && v.chatId === room.roomId && id !== exclude);
    for (const [id] of extra) {
      const e = room.findEventById(id); const k = e?.getRelation()?.key; const s = e?.getSender();
      if (e && k && s && !e.isRedacted() && !reactions.some((x) => x.emoji === k && x.senderIds.includes(s))) {
        const g = reactions.find((x) => x.emoji === k);
        if (g) { g.senderIds.push(s); if (s === this.me) g.mine = true; }
        else reactions.push(s === this.me ? { emoji: k, senderIds: [s], mine: true } : { emoji: k, senderIds: [s] });
      }
    }
    this.emit({ type: "message-update", data: { chatId: room.roomId, messageId: targetId, patch: { reactions } } });
  }

  private onRedaction(redaction: MatrixEvent, room: Room) {
    const targetId = redaction.getAssociatedId() ?? (redaction.getContent().redacts as string | undefined) ?? (redaction.event as { redacts?: string }).redacts;
    if (!targetId) return;
    const idx = this.reactionIndex.get(targetId);
    if (idx) { this.reactionIndex.delete(targetId); this.emitReactions(room, idx.targetId, targetId); return; }
    const t = room.findEventById(targetId);
    // Redacting a decrypted event drops its clear-text type: an encrypted room's message then reports "m.room.encrypted" (found against Synapse).
    if (t && (t.getType() === "m.room.message" || t.getType() === "m.room.encrypted" || isPollStart(t.getType()))) {
      if (t.getRelation()?.rel_type === "m.replace") return; // redacted edit: leave text as is (TODO: revert to previous)
      this.emit({ type: "message-update", data: { chatId: room.roomId, messageId: targetId, patch: { deleted: true } } });
    } else if (t?.getType() === "m.sticker") {
      this.emit({ type: "message-update", data: { chatId: room.roomId, messageId: targetId, patch: { deleted: true } } });
    }
    this.markDirty(room.roomId);
  }

  /** How far each (room, user) has read, as the timestamp of the event their latest public receipt pointed at: a receipt only reports the NEW range. */
  private readUpTo = new Map<string, number>();
  /**
   * m.read = "read up to and including this event". For every member the receipt covers all MY events since their previous receipt
   * (bounded to the loaded timeline). Matrix has no delivery receipts, so only `read` is reported. The time is when the receipt was
   * posted (an earlier message may have been read sooner, the protocol doesn't say). m.read.private is invisible to others by design.
   */
  private onReceipt(ev: MatrixEvent, room: Room) {
    const content = ev.getContent() as Record<string, Record<string, Record<string, unknown>>>;
    let mine = false;
    for (const [eventId, types] of Object.entries(content)) {
      for (const [type, users] of Object.entries(types ?? {})) {
        if (type !== "m.read" && type !== "m.read.private") continue;
        for (const [userId, info] of Object.entries(users ?? {})) {
          if (userId === this.me) { mine = true; continue; }
          if (type !== "m.read") continue;
          const t = (info as { ts?: unknown } | undefined)?.ts, at = typeof t === "number" && t > 0 ? new Date(t).toISOString() : undefined;
          const thread = (info as { thread_id?: unknown } | undefined)?.thread_id;
          const emitOne = (id: string) => this.emit({ type: "receipt", data: { chatId: room.roomId, messageId: id, status: "read", by: userId, ...(at ? { at } : {}) } });
          const target = room.findEventById(eventId);
          const upTo = target?.getTs() ?? 0, key = `${room.roomId}|${userId}`, from = this.readUpTo.get(key) ?? 0;
          if (!upTo || (typeof thread === "string" && thread !== "main")) { emitOne(eventId); continue; } // unknown position / thread receipt: just that event
          if (upTo > from) this.readUpTo.set(key, upTo);
          let n = 0;
          const mineEvents = room.getLiveTimeline().getEvents().filter((e) => e.getSender() === this.me && e.getId() && e.getTs() <= upTo && e.getTs() > from
            && e.getRelation()?.rel_type !== "m.replace" && e.getRelation()?.rel_type !== "m.annotation" && e.getType() !== "m.reaction");
          for (const e of mineEvents.slice(-100)) { emitOne(e.getId()!); if (e.getId() === eventId) n++; }
          if (!n && target?.getSender() === this.me) emitOne(eventId);
        }
      }
    }
    if (mine) this.markDirty(room.roomId); // read on another device: unread count changed
  }

  // ------------------------------------------------------------------ read
  private directMap(): Map<string, string> { // roomId -> other user id
    const out = new Map<string, string>();
    const c = this.client?.getAccountData("m.direct" as never)?.getContent() as Record<string, string[]> | undefined;
    for (const [user, rooms] of Object.entries(c ?? {})) if (Array.isArray(rooms)) for (const r of rooms) out.set(r, user);
    return out;
  }
  private joined(): Room[] { return (this.client?.getRooms() ?? []).filter((r) => r.getMyMembership() === "join"); }

  /** roomId -> parent space id (first space, by id order, that lists it via m.space.child with `via`). */
  private parentMap(): Map<string, string> {
    const out = new Map<string, string>();
    for (const sp of this.joined().filter((r) => r.isSpaceRoom()).sort((a, b) => a.roomId.localeCompare(b.roomId))) {
      for (const ev of sp.currentState.getStateEvents("m.space.child")) {
        const child = ev.getStateKey(); const via = (ev.getContent() as { via?: unknown }).via;
        if (child && Array.isArray(via) && via.length && !out.has(child)) out.set(child, sp.roomId);
      }
    }
    return out;
  }

  private async avatarDataUrl(mxc: string | null | undefined, size = 96): Promise<string | undefined> {
    if (!mxc || !this.client) return undefined;
    const key = `${mxc}@${size}`;
    let p = this.avatarCache.get(key);
    if (!p) {
      p = (async () => {
        try {
          const c = this.client!;
          const url = c.mxcUrlToHttp(mxc, size, size, "crop", false, true, true);
          if (!url) return undefined;
          let res = await fetch(url, { headers: { authorization: `Bearer ${c.getAccessToken()}` } });
          if (!res.ok) { // server without authenticated media
            const legacy = c.mxcUrlToHttp(mxc, size, size, "crop", false, true, false);
            if (!legacy) return undefined;
            res = await fetch(legacy);
          }
          if (!res.ok) return undefined;
          const mime = (res.headers.get("content-type") ?? "image/png").split(";")[0];
          if (!mime.startsWith("image/")) return undefined;
          return `data:${mime};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
        } catch { return undefined; }
      })();
      this.avatarCache.set(key, p);
    }
    return p;
  }

  async spaces(): Promise<Space[]> {
    const rooms = this.joined().filter((r) => r.isSpaceRoom());
    return Promise.all(rooms.map(async (r): Promise<Space> => ({
      id: r.roomId, accountId: this.accountId, provider: PROVIDER, name: r.name || r.roomId,
      iconUrl: await this.avatarDataUrl(r.getMxcAvatarUrl()),
    })));
  }

  private async toChat(r: Room, direct: Map<string, string>, parents: Map<string, string>): Promise<Chat> {
    const invited = r.getMyMembership() === "invite";
    const inviter = invited ? r.getDMInviter() : undefined;
    const isDm = direct.has(r.roomId) || !!inviter;
    const parent = parents.get(r.roomId);
    const last = r.getLastActiveTimestamp();
    let avatarMxc = r.getMxcAvatarUrl();
    if (!avatarMxc && isDm) avatarMxc = r.getAvatarFallbackMember()?.getMxcAvatarUrl() ?? null;
    const chat: Chat = {
      id: r.roomId, accountId: this.accountId, provider: PROVIDER,
      kind: isDm ? "dm" : parent ? "channel" : "group",
      name: r.name || direct.get(r.roomId) || r.roomId,
      unread: r.getUnreadNotificationCount(NotificationCountType.Total) || 0,
      readOnly: invited ? false : !r.currentState.maySendMessage(this.me), // (sending to a pending request accepts it)
    };
    if (invited) {
      chat.request = true;
      if (!(r.currentState.getStateEvents("m.room.name", "") as MatrixEvent | null)?.getContent().name) chat.name = (inviter ? r.getMember(inviter)?.name || this.client?.getUser(inviter)?.displayName || inviter : chat.name === "Empty room" ? "Invitation" : chat.name); // SDK says "Empty room" when an invite carries no name
      if (r.isSpaceRoom()) chat.description = "Invitation to a space";
      const av0 = await this.avatarDataUrl(r.getMxcAvatarUrl()); if (av0) chat.avatarUrl = av0;
      return chat;
    }
    if (!isDm && parent) chat.spaceId = parent;
    const peer = direct.get(r.roomId);
    if (isDm && peer && this.client?.getIgnoredUsers().includes(peer)) chat.blocked = true;
    const topic = (r.currentState.getStateEvents("m.room.topic", "") as MatrixEvent | null)?.getContent() as { topic?: unknown } | undefined;
    if (!isDm && typeof topic?.topic === "string" && topic.topic) chat.description = topic.topic.slice(0, 500);
    const lastEv = r.getLastLiveEvent();
    if (lastEv) {
      const lm = mapMessage(raw(lastEv), { chatId: r.roomId, selfId: this.me, nameOf: (u) => this.nameOf(r, u) });
      if (lm && !lm.system) chat.preview = lm.deleted ? "" : lm.text || (lm.attachments?.[0] ? `[${lm.attachments[0].kind}]` : lm.poll ? `[poll] ${lm.poll.question}` : lm.location ? "[location]" : "");
      if (chat.preview) chat.preview = chat.preview.slice(0, 120);
    }
    if (Number.isFinite(last) && last > 0) chat.lastMessageAt = new Date(last).toISOString();
    const av = await this.avatarDataUrl(avatarMxc);
    if (av) chat.avatarUrl = av;
    return chat;
  }

  async chats(): Promise<Chat[]> {
    const direct = this.directMap(); const parents = this.parentMap();
    // Pending invitations are message requests (Chat.request). Invitations to spaces are listed too (they have no Space.request); accepting makes them a space.
    const invites = (this.client?.getRooms() ?? []).filter((r) => r.getMyMembership() === "invite" && !r.isCallRoom());
    return Promise.all([...this.joined().filter((r) => !r.isSpaceRoom() && !r.isCallRoom()), ...invites].map((r) => this.toChat(r, direct, parents)));
  }

  async members(chatId: string): Promise<Contact[]> {
    const room = this.room(chatId);
    if (room.getMyMembership() === "invite") { const i = room.getDMInviter() ?? room.getMember(this.me)?.events.member?.getSender(); return i ? [{ id: i, name: room.getMember(i)?.name || i, handle: i }] : []; }
    await room.loadMembersIfNeeded();
    return room.getJoinedMembers().map((m) => ({ id: m.userId, name: m.name || m.userId, handle: m.userId }));
  }

  async history(chatId: string, q: HistoryQuery): Promise<Message[]> {
    const c = this.client; if (!c) throw new Error("not connected");
    const room = this.room(chatId);
    if (room.getMyMembership() !== "join") return []; // a pending invitation has no readable history
    let from: string | null = null;
    if (q.beforeMessageId) {
      const ctx = await c.http.authedRequest<{ start?: string }>(Method.Get, `/rooms/${encRoomId(chatId)}/context/${encRoomId(q.beforeMessageId)}`, { limit: "0" });
      if (!ctx.start) return [];
      from = ctx.start;
    }
    const out: Message[] = [];
    const mapper = c.getEventMapper();
    // Page until we have `limit` message events or the room start is reached (edits/reactions/state take page slots).
    for (let guard = 0; guard < 10 && out.length < q.limit; guard++) {
      const page = await c.createMessagesRequest(chatId, from, Math.max(q.limit, 30), Direction.Backward);
      const events = page.chunk.map((e) => mapper({ ...e, room_id: chatId }));
      await Promise.all(events.map((e) => c.decryptEventIfNeeded(e).catch(() => undefined)));
      const rawEvents = events.map(raw);
      for (const [i, ev] of events.entries()) {
        const r = rawEvents[i];
        if (r.type !== "m.room.message" && r.type !== "m.sticker" && r.type !== "m.room.encrypted" && !isPollStart(r.type) && !isSpecialType(r.type)) continue;
        let pollRelated: RawEvent[] | undefined;
        if (isPollStart(r.type)) {
          pollRelated = [...rawEvents, ...this.pollRelated(room, r.event_id)];
          try { // responses may be newer than this page: ask the server
            const rels = await c.relations(chatId, r.event_id, "m.reference", null, { limit: 100 });
            await Promise.all(rels.events.map((e) => c.decryptEventIfNeeded(e).catch(() => undefined)));
            pollRelated.push(...rels.events.map(raw));
          } catch { /* offline/unsupported: tally what we have */ }
        }
        const bundled = (ev.getUnsigned() as { "m.relations"?: Record<string, any> })["m.relations"]?.["m.replace"] as RawEvent | undefined;
        const edit = pickEdit(r, [...(bundled ? [bundled] : []), ...rawEvents]);
        const m = mapMessage(r, {
          accountId: this.accountId, chatId, selfId: this.me, nameOf: (u) => this.nameOf(room, u), edit,
          reactions: this.reactionsFor(room, r.event_id), pollRelated, isMember: (u) => this.isMember(room, u), canEndPoll: (u) => this.canEnd(room, u),
          memberCount: room.getJoinedMemberCount(), callRelated: r.type === "m.call.invite" ? [...rawEvents, ...this.callRelated(room)] : undefined,
          replyPreview: (id) => {
            const j = rawEvents.findIndex((x) => x.event_id === id);
            const t = j >= 0 ? rawEvents[j] : room.findEventById(id) ? raw(room.findEventById(id)!) : undefined;
            const mm = t && mapMessage(t, { chatId, selfId: this.me, nameOf: (u) => this.nameOf(room, u) });
            return mm ? { sender: mm.sender, textPreview: mm.text.slice(0, 120) } : undefined;
          },
        });
        if (m) { m.status = m.fromMe ? "sent" : undefined; out.push(m); }
      }
      if (!page.end || page.chunk.length === 0) break;
      from = page.end;
    }
    // Backward pages arrive newest-first; contract wants oldest->newest within the page.
    const page = out.slice(0, q.limit).reverse();
    return page;
  }

  // ------------------------------------------------------------------ attachments
  async downloadAttachment(chatId: string, messageId: string, _attachmentId: string) {
    const c = this.client; if (!c) throw new Error("not connected");
    let ev = this.room(chatId).findEventById(messageId);
    if (!ev) {
      const e = await c.fetchRoomEvent(chatId, messageId);
      ev = c.getEventMapper()({ ...e, room_id: chatId } as never);
      await c.decryptEventIfNeeded(ev);
    }
    const content = ev.getContent() as { url?: string; file?: { url: string; key: any; iv: string; hashes: { sha256: string } }; info?: { mimetype?: string }; body?: string; filename?: string };
    const mxc = content.file?.url ?? content.url;
    if (!mxc) throw new Error("message has no attachment");
    const auth = { authorization: `Bearer ${c.getAccessToken()}` };
    const primary = c.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, false, true);
    const legacy = c.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, false, false);
    if (!primary || !legacy) throw new Error("bad mxc url");
    let res = await fetch(primary, { headers: auth });
    if (!res.ok && (res.status === 404 || res.status === 401 || res.status === 400)) res = await fetch(legacy);
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    let data: Uint8Array = new Uint8Array(await res.arrayBuffer());
    if (content.file) data = decryptAttachment(data, content.file);
    return { data, mime: content.info?.mimetype ?? "application/octet-stream", name: content.filename ?? content.body };
  }

  // ------------------------------------------------------------------ write
  async send(chatId: string, msg: OutgoingMessage): Promise<Message> {
    const c = this.client; if (!c) throw new Error("not connected");
    const room = this.room(chatId);
    if (room.getMyMembership() === "invite") await this.acceptRequest(chatId); // replying to a request accepts it
    const relates = msg.replyToMessageId ? this.replyRelation(room, msg.replyToMessageId) : {};
    const encrypted = c.isRoomEncrypted(chatId);
    const bodies: Record<string, unknown>[] = [];
    const atts = msg.attachments ?? [];
    atts.forEach((a, i) => { bodies.push({ _att: a, _caption: i === 0 ? msg.text : "" }); });
    if (msg.poll) {
      const opts = msg.poll.options.map((o) => o.trim()).filter(Boolean);
      if (!msg.poll.question.trim() || opts.length < 2) throw new Error("A poll needs a question and at least two options");
      bodies.push({ _poll: pollStartContent(msg.poll.question.trim(), opts.slice(0, 20), !!msg.poll.multiple, () => randomBytes(4).toString("hex")) });
    }
    if (msg.location) bodies.push(locationContent(msg.location));
    if (!atts.length && (msg.text || (!msg.location && !msg.poll))) bodies.push({ msgtype: "m.text", body: msg.text, ...mentionContent(msg.text, msg.mentions), ...(await this.linkPreview(c, msg.text, encrypted, (msg as { linkPreview?: boolean }).linkPreview)) });
    let first: Message | undefined;
    let n = 0;
    for (const b of bodies) {
      let content: Record<string, unknown>;
      const evType = "_poll" in b ? "m.poll.start" : "m.room.message";
      if ("_poll" in b) content = { ...(b._poll as Record<string, unknown>) };
      else if ("_att" in b) {
        const a = b._att as NonNullable<OutgoingMessage["attachments"]>[number];
        const caption = b._caption as string;
        const name = a.name ?? "file";
        const msgtype = a.kind === "image" ? "m.image" : a.kind === "video" ? "m.video" : a.kind === "audio" || a.kind === "voice" ? "m.audio" : "m.file";
        const info: Record<string, unknown> = { mimetype: a.mime, size: a.data.byteLength };
        content = { msgtype, body: caption || name, filename: name, info };
        if (a.durationMs) info.duration = Math.round(a.durationMs);
        if (a.gif && a.kind === "video") Object.assign(info, { "fi.mau.gif": true, "fi.mau.loop": true, "fi.mau.autoplay": true, "fi.mau.hide_controls": true, "fi.mau.no_audio": true });
        if (a.kind === "voice") {
          content["org.matrix.msc3245.voice"] = {};
          // MSC1767 audio block (waveform values 0..1024), what Element renders as the voice-message bars
          content["org.matrix.msc1767.audio"] = { ...(a.durationMs ? { duration: Math.round(a.durationMs) } : {}), ...(a.waveform?.length ? { waveform: a.waveform.slice(0, 100).map((v) => Math.round(Math.max(0, Math.min(100, v)) * 10.24)) } : {}) };
        }
        if (encrypted) {
          const { ciphertext, info: ei } = encryptAttachment(a.data);
          const up = await c.uploadContent(new Blob([ciphertext as BlobPart]), { type: "application/octet-stream", name, includeFilename: false });
          content.file = { ...ei, url: up.content_uri };
        } else {
          const up = await c.uploadContent(new Blob([a.data as BlobPart], { type: a.mime }), { type: a.mime, name });
          content.url = up.content_uri;
        }
      } else content = { ...b };
      if (n++ === 0) Object.assign(content, relates);
      const txn = `unimsg-${randomBytes(8).toString("hex")}`;
      this.ownTxn.add(txn);
      const res = evType === "m.room.message" ? await c.sendMessage(chatId, content as never, txn) : await c.sendEvent(chatId, evType as never, content as never, txn);
      this.ownEvents.add(res.event_id);
      if (this.ownTxn.size > 500) { this.ownTxn.delete(this.ownTxn.values().next().value as string); this.ownEvents.delete(this.ownEvents.values().next().value as string); }
      if (!first) {
        const rawEv: RawEvent = { event_id: res.event_id, sender: this.me, type: evType, origin_server_ts: Date.now(), content };
        first = mapMessage(rawEv, {
          pollRelated: [],
          accountId: this.accountId, chatId, selfId: this.me, nameOf: (u) => this.nameOf(room, u), status: "sent",
          replyPreview: (id) => { const t = room.findEventById(id); const m = t && mapMessage(raw(t), { chatId, selfId: this.me, nameOf: (u) => this.nameOf(room, u) }); return m ? { sender: m.sender, textPreview: m.text.slice(0, 120) } : undefined; },
        }) ?? undefined;
      }
    }
    this.markDirty(chatId);
    return first!;
  }

  /** Reply relation; replying to a message that is in (or the root of) a thread stays in that thread (m.thread, is_falling_back false). */
  private replyRelation(room: Room, targetId: string): Record<string, unknown> {
    const t = room.findEventById(targetId);
    const thr = t ? threadOf(raw(t)) : undefined;
    const root = thr?.root ?? ((t?.getUnsigned() as { "m.relations"?: Record<string, unknown> } | undefined)?.["m.relations"]?.["m.thread"] ? targetId : undefined);
    if (root) return { "m.relates_to": { rel_type: "m.thread", event_id: root, is_falling_back: false, "m.in_reply_to": { event_id: targetId } } };
    return { "m.relates_to": { "m.in_reply_to": { event_id: targetId } } };
  }

  async vote(chatId: string, messageId: string, optionIds: string[]) {
    const c = this.client; if (!c) throw new Error("not connected");
    const room = this.room(chatId);
    const start = room.findEventById(messageId);
    const sr = start && isPollStart(start.getType()) ? raw(start) : undefined;
    const ps = sr && parsePollStart(sr);
    if (!sr || !ps) throw new Error("not a poll");
    const ids = [...new Set(optionIds)];
    if (ids.some((i) => !ps.options.some((o) => o.id === i))) throw new Error("unknown poll option");
    if (ids.length > ps.max) throw new Error(`at most ${ps.max} option(s) can be selected`);
    if (tallyPoll(sr, ps, this.pollRelated(room, messageId), this.me, undefined, (u) => this.canEnd(room, u)).closed) throw new Error("poll has ended");
    const content = pollResponseContent(messageId, ids);
    const res = await c.sendEvent(chatId, "m.poll.response" as never, content as never);
    this.ownEvents.add(res.event_id);
    this.emitPoll(room, messageId, { event_id: res.event_id, sender: this.me, type: "m.poll.response", origin_server_ts: Date.now(), content });
  }

  async leaveSpace(spaceId: string) {
    const c = this.client; if (!c) throw new Error("not connected");
    const r = c.getRoom(spaceId);
    if (r && !r.isSpaceRoom()) throw new Error("not a space");
    // Only the space room itself; its child rooms stay joined (they just lose their space).
    try { await c.leave(spaceId); } catch (e) { if (!(e instanceof MatrixError && e.errcode === "M_FORBIDDEN")) throw e; }
    await c.forget(spaceId);
    this.emit({ type: "spaces-changed", data: {} });
    this.markDirty();
  }

  async react(chatId: string, messageId: string, emoji: string | null) {
    const c = this.client; if (!c) throw new Error("not connected");
    const room = this.room(chatId);
    const rel = room.relations.getChildEventsForEvent(messageId, "m.annotation", "m.reaction");
    const mine = (rel?.getRelations() ?? []).filter((e) => e.getSender() === this.me && !e.isRedacted());
    let already = false;
    for (const e of mine) {
      if (emoji !== null && e.getRelation()?.key === emoji) { already = true; continue; }
      const id = e.getId(); if (id) await c.redactEvent(chatId, id);
    }
    if (emoji !== null && !already) {
      const res = await c.sendEvent(chatId, "m.reaction" as never, { "m.relates_to": { rel_type: "m.annotation", event_id: messageId, key: emoji } } as never);
      this.reactionIndex.set(res.event_id, { chatId, targetId: messageId });
    }
  }

  /** The pinned event ids of a room (m.room.pinned_events state, newest last as the room lists them). */
  private pinnedIds(room: Room): string[] {
    const l = room.currentState.getStateEvents("m.room.pinned_events" as never, "")?.getContent()?.pinned;
    return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
  }

  /** Pinned events changed (by anyone, also my other devices): mark added ids, unmark removed ones. */
  private onPinnedEvents(ev: MatrixEvent) {
    const chatId = ev.getRoomId(); if (!chatId) return;
    const ids = (c: unknown) => { const l = (c as { pinned?: unknown } | undefined)?.pinned; return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : []; };
    const now = new Set(ids(ev.getContent())), before = new Set(ids(ev.getPrevContent()));
    const at = new Date(ev.getTs() || Date.now()).toISOString(), by = ev.getSender() ?? undefined;
    for (const id of now) if (!before.has(id)) this.emit({ type: "message-update", data: { chatId, messageId: id, patch: { pinned: true, pinnedAt: at, ...(by ? { pinnedBy: by } : {}) } } });
    for (const id of before) if (!now.has(id)) this.emit({ type: "message-update", data: { chatId, messageId: id, patch: { pinned: false } } });
  }

  /** Pin / unpin = read-modify-write of the room's m.room.pinned_events list (needs the room's "send state" power level). */
  async pin(chatId: string, messageId: string, pinned: boolean) {
    const c = this.client; if (!c) throw new Error("not connected");
    const cur = this.pinnedIds(this.room(chatId)).filter((x) => x !== messageId);
    const next = pinned ? [...cur, messageId] : cur;
    try { await c.sendStateEvent(chatId, "m.room.pinned_events" as never, { pinned: next } as never, ""); }
    catch (e) { if (e instanceof MatrixError && e.errcode === "M_FORBIDDEN") throw new Error("You do not have permission to pin messages in this room."); throw e; }
    this.emit({ type: "message-update", data: { chatId, messageId, patch: pinned ? { pinned: true, pinnedAt: new Date().toISOString(), pinnedBy: this.me } : { pinned: false } } });
  }

  /** The room's pinned messages (events that cannot be fetched or mapped are skipped). Newest pin last in the state list: returned newest first. */
  async pins(chatId: string): Promise<Message[]> {
    const c = this.client; if (!c) throw new Error("not connected");
    const room = this.room(chatId), out: Message[] = [];
    for (const id of this.pinnedIds(room).reverse()) {
      try {
        let ev = room.findEventById(id);
        if (!ev) { const r = await c.fetchRoomEvent(chatId, id); ev = new MatrixEvent(r); await c.decryptEventIfNeeded(ev).catch(() => undefined); }
        const m = this.toMessage(room, ev); if (m && !m.deleted) out.push({ ...m, pinned: true });
      } catch { /* redacted / not visible */ }
    }
    return out;
  }

  async edit(chatId: string, messageId: string, newText: string) {
    const c = this.client; if (!c) throw new Error("not connected");
    const orig = this.room(chatId).findEventById(messageId);
    if (orig && orig.getSender() !== this.me) throw new Error("can only edit own messages");
    await c.sendMessage(chatId, {
      msgtype: "m.text", body: `* ${newText}`,
      "m.new_content": { msgtype: "m.text", body: newText },
      "m.relates_to": { rel_type: "m.replace", event_id: messageId },
    } as never);
  }

  async delete(chatId: string, messageId: string) {
    const c = this.client; if (!c) throw new Error("not connected");
    await c.redactEvent(chatId, messageId);
  }

  async setTyping(chatId: string, typing: boolean) {
    if (!this.prefs().typing) return; // privacy: typing notifications off
    await this.client?.sendTyping(chatId, typing, 30_000);
  }

  // ------------------------------------------------------------------ profile + privacy
  private async fetchMxc(mxc: string, size: number): Promise<{ data: Uint8Array; mime: string } | undefined> {
    const c = this.client; if (!c) return undefined;
    const tryUrl = async (auth: boolean) => {
      const url = c.mxcUrlToHttp(mxc, size, size, "scale", false, true, auth);
      if (!url) return undefined;
      const res = await fetch(url, auth ? { headers: { authorization: `Bearer ${c.getAccessToken()}` } } : undefined);
      return res.ok ? res : undefined;
    };
    try {
      const res = (await tryUrl(true)) ?? (await tryUrl(false));
      if (!res) return undefined;
      const mime = (res.headers.get("content-type") ?? "image/png").split(";")[0];
      return mime.startsWith("image/") ? { data: new Uint8Array(await res.arrayBuffer()), mime } : undefined;
    } catch { return undefined; }
  }

  /** MSC4095 preview for the first URL, built from the homeserver's /preview_url. Never in encrypted rooms (it would tell the server what was linked); best effort with a short timeout. */
  private async linkPreview(c: MatrixClient, text: string, encrypted: boolean, flag: boolean | undefined): Promise<Record<string, unknown>> {
    const url = firstHttpUrl(text);
    if (!url || encrypted || flag === false) return {};
    try {
      const og = await Promise.race([c.getUrlPreview(url, Date.now()), new Promise<never>((_r, j) => setTimeout(() => j(new Error("timeout")), 4000))]);
      return linkPreviewContent(url, og as Record<string, unknown>) ?? {};
    } catch { return {}; }
  }

  async avatar(target: { kind: "chat" | "space" | "contact" | "emoji"; id: string }): Promise<{ data: Uint8Array; mime: string } | undefined> {
    const c = this.client; if (!c) return undefined;
    try {
      if (target.kind === "emoji") { const mxc = emoticons.get(target.id.replace(/^:+|:+$/g, "").toLowerCase()); return mxc ? await this.fetchMxc(mxc, 64) : undefined; }
      let mxc: string | null | undefined;
      if (target.kind === "contact") {
        // Cheap path: the member object of any joined room we know already carries the avatar (lazy-loaded members include it).
        for (const r of this.joined()) { mxc = r.getMember(target.id)?.getMxcAvatarUrl(); if (mxc) break; }
        if (!mxc && /^@[^:\s]+:\S+$/.test(target.id)) mxc = (await c.getProfileInfo(target.id)).avatar_url;
      } else {
        const r = c.getRoom(target.id); if (!r) return undefined;
        mxc = r.getMxcAvatarUrl();
        if (!mxc && target.kind === "chat" && this.directMap().has(r.roomId)) mxc = r.getAvatarFallbackMember()?.getMxcAvatarUrl();
      }
      return mxc ? await this.fetchMxc(mxc, 96) : undefined;
    } catch { return undefined; }
  }

  async getProfile(): Promise<Profile> {
    const c = this.client; if (!c) throw new Error("not connected");
    const info = await c.getProfileInfo(this.me);
    const p: Profile = { displayName: info.displayname || undefined, handle: this.me };
    if (info.avatar_url) { const a = await this.fetchMxc(info.avatar_url, 256); if (a) p.avatar = a; }
    return p;
  }

  async updateProfile(patch: ProfilePatch): Promise<Profile> {
    const c = this.client; if (!c) throw new Error("not connected");
    if (patch.about !== undefined) throw new Error("Matrix has no profile 'about' field");
    if (patch.displayName !== undefined) {
      const n = patch.displayName.trim();
      if (!n) throw new Error("Display name must not be empty");
      await c.setDisplayName(n);
    }
    if (patch.avatar === null) {
      await c.setProfileInfo("avatar_url", { avatar_url: "" }); // no stable DELETE on older servers: empty URL clears it
    } else if (patch.avatar) {
      const up = await c.uploadContent(new Blob([patch.avatar.data as BlobPart], { type: patch.avatar.mime }), { type: patch.avatar.mime, name: "avatar" });
      await c.setAvatarUrl(up.content_uri);
    }
    return this.getProfile();
  }

  /** UniChat-specific account data (syncs between devices): read receipt visibility + typing notifications. */
  private prefsLocal?: { readReceipts: "public" | "private"; typing: boolean };
  private prefs(): { readReceipts: "public" | "private"; typing: boolean } {
    if (this.prefsLocal) return this.prefsLocal;
    const c = this.client?.getAccountData(PREFS_TYPE as never)?.getContent() as { read_receipts?: string; typing?: boolean } | undefined;
    return { readReceipts: c?.read_receipts === "private" ? "private" : "public", typing: c?.typing !== false };
  }

  // ------------------------------------------------------------------ key backup (restore only)
  /** Restore the server-side key backup with a recovery key (Element's "security key" from secret storage, or the raw backup key) or a passphrase.
   *  Old encrypted history becomes readable; the key stays in the crypto store, so later sessions are fetched on demand. Memory-only secrets. */
  private async restoreBackup(secret: string): Promise<{ total: number; imported: number }> {
    const c = this.client; const crypto = c?.getCrypto(); if (!c || !crypto) throw new Error("Not connected yet - try again in a moment.");
    const input = secret.trim(); if (!input) throw new Error("Enter your recovery key or passphrase.");
    const info = await crypto.getKeyBackupInfo().catch(() => null);
    if (!info?.version) throw new Error("This account has no message key backup on the server.");
    const wrong = new Error("That recovery key or passphrase does not match this account's message backup.");
    let key: Uint8Array | undefined;
    try { key = decodeRecoveryKey(input); } catch { /* not a recovery key: passphrase */ }
    const viaSecretStorage = async (k: Uint8Array) => {
      this.ssKey = k;
      try { await crypto.loadSessionBackupPrivateKeyFromSecretStorage(); return await crypto.restoreKeyBackup(); }
      finally { this.ssKey = undefined; }
    };
    try {
      if (key) {
        try { return await viaSecretStorage(key); } catch { /* not the secret-storage key */ }
        await crypto.storeSessionBackupPrivateKey(key, info.version); // the backup key itself
        return await crypto.restoreKeyBackup();
      }
      const id = (c.getAccountData("m.secret_storage.default_key" as never)?.getContent() as { key?: string } | undefined)?.key;
      const pp = id ? (c.getAccountData(`m.secret_storage.key.${id}` as never)?.getContent() as { passphrase?: { salt?: string; iterations?: number } } | undefined)?.passphrase : undefined;
      if (pp?.salt && pp.iterations) {
        try { return await viaSecretStorage(await deriveRecoveryKeyFromPassphrase(input, pp.salt, pp.iterations)); } catch { /* try the legacy backup passphrase */ }
      }
      return await crypto.restoreKeyBackupWithPassphrase(input);
    } catch (e) {
      this.err("backup-restore", e);
      throw wrong;
    }
  }

  /** Element's exported room-key file: decrypt, then hand the sessions to the crypto module. */
  private async importKeyFile(file: string, passphrase: string): Promise<number> {
    const crypto = this.client?.getCrypto(); if (!crypto) throw new Error("Not connected yet - try again in a moment.");
    if (!file.trim()) throw new Error("Choose the exported key file first.");
    if (!passphrase) throw new Error("Enter the passphrase you chose when exporting the keys.");
    const json = decryptKeyFile(file, passphrase);
    let n = 0; try { n = (JSON.parse(json) as unknown[]).length; } catch { throw new Error("The key file decrypted but its content is not valid."); }
    await crypto.importRoomKeysAsJson(json);
    return n;
  }

  // ---- verification (emoji comparison, set-up, recovery key): see verification.ts and the generic `verification` contract in @unimsg/core
  verificationStart(target?: { userId?: string; chatId?: string }) { return this.verif.start(target); }
  verificationAction(id: string, action: VerificationAction) { return this.verif.action(id, action); }
  verificationStatus(target?: { userId?: string; chatId?: string }) { return this.verif.status(target); }
  verificationSetup(opts: { password?: string }) { return this.verif.setup(opts); }
  verificationRecover(recoveryKey: string) { return this.verif.recover(recoveryKey); }
  /** A recovery key ("EsT..."), or a passphrase derived with the account's secret-storage key parameters. */
  private async secretKeyFrom(input: string): Promise<Uint8Array> {
    const c = this.client; const text = input.trim();
    try { return decodeRecoveryKey(text); } catch { /* a passphrase then */ }
    const id = (c?.getAccountData("m.secret_storage.default_key" as never)?.getContent() as { key?: string } | undefined)?.key;
    const pp = id ? (c?.getAccountData(`m.secret_storage.key.${id}` as never)?.getContent() as { passphrase?: { salt?: string; iterations?: number } } | undefined)?.passphrase : undefined;
    if (!pp?.salt || !pp.iterations) throw new Error("not a recovery key");
    return deriveRecoveryKeyFromPassphrase(text, pp.salt, pp.iterations);
  }

  private async backupState(): Promise<"restored" | "available" | "none"> {
    const crypto = this.client?.getCrypto(); if (!crypto) return "none";
    const info = await crypto.getKeyBackupInfo().catch(() => null);
    if (!info?.version) return "none";
    return (await crypto.getSessionBackupPrivateKey().catch(() => null)) ? "restored" : "available";
  }
  private async deviceState(): Promise<"verified" | "unverified"> {
    const crypto = this.client?.getCrypto(); const dev = this.client?.getDeviceId();
    if (!crypto || !dev) return "unverified";
    const st = await crypto.getDeviceVerificationStatus(this.me, dev).catch(() => null);
    return st?.crossSigningVerified ? "verified" : "unverified";
  }

  async getPrivacy(): Promise<PrivacySetting[]> {
    const p = this.prefs();
    const bk = await this.backupState(); const dv = await this.deviceState();
    return [
      { id: "readReceipts", label: "Read receipts", description: "Private receipts still clear your unread counts, but other people cannot see that you read their messages.",
        value: p.readReceipts, options: [{ value: "public", label: "Visible to others" }, { value: "private", label: "Private (only you)" }] },
      { id: "typing", label: "Typing notifications", description: "Let others in a room see when you are typing.",
        value: p.typing ? "on" : "off", options: [{ value: "on", label: "On" }, { value: "off", label: "Off" }] },
      { id: "keyBackup", label: "Older encrypted messages", description: "Restore your account's message key backup with its recovery key or passphrase so this device can read encrypted messages from before it was added.",
        value: bk, options: [{ value: bk, label: bk === "restored" ? "Restored on this device" : bk === "available" ? "Backup available, not restored" : "No backup on the server" },
          ...(bk !== "none" ? [{ value: "restore", label: "Restore with recovery key or passphrase..." }] : []), { value: "importFile", label: "Import an exported key file (.txt)..." }] },
      { id: "deviceVerification", label: "This device", description: "Verify this device with another one of your Matrix devices by comparing emojis. Verified devices can also get your message keys from your other devices.",
        value: dv, options: [{ value: dv, label: dv === "verified" ? "Verified" : "Not verified" }, ...(dv === "verified" ? [] : [{ value: "verify", label: "Verify with another device..." }])] },
    ];
  }

  async setPrivacy(id: string, value: string): Promise<PrivacySetting[]> {
    const c = this.client; if (!c) throw new Error("not connected");
    if (id === "keyBackup" && value === "restore") { // asks for the key with a form prompt; the answer arrives in submitLogin
      if ((await this.backupState()) === "none") throw new Error("This account has no message key backup on the server.");
      const promptId = randomBytes(6).toString("hex"); this.restorePrompt = promptId;
      this.emit({ type: "login", data: { accountId: this.accountId, promptId, kind: "form", title: "Restore encrypted message backup",
        fields: [{ name: "recoverykey", label: "Recovery key or passphrase", type: "password", required: true }] } });
      return this.getPrivacy();
    }
    if (id === "keyBackup" && value === "importFile") {
      const promptId = randomBytes(6).toString("hex"); this.importPrompt = promptId;
      this.emit({ type: "login", data: { accountId: this.accountId, promptId, kind: "form", title: "Import exported message keys",
        warning: { text: "This is the file Element creates with \"Export E2E room keys\" (it starts with -----BEGIN MEGOLM SESSION DATA-----). It is not a login: it only lets this device read older encrypted messages. Choose the file and enter the passphrase you typed when exporting it.", severity: "info" },
        fields: [{ name: "keyfile", label: "Key file", type: "file", required: true }, { name: "passphrase", label: "Passphrase of the file", type: "password", required: true }] } });
      return this.getPrivacy();
    }
    if (id === "deviceVerification" && value === "verify") { await this.verif.start(); return this.getPrivacy(); }
    if (id === "deviceVerification" || id === "keyBackup") throw new Error("This setting cannot be changed here.");
    const cur = this.prefs();
    let next = cur;
    if (id === "readReceipts" && (value === "public" || value === "private")) next = { ...cur, readReceipts: value };
    else if (id === "typing" && (value === "on" || value === "off")) next = { ...cur, typing: value === "on" };
    else throw new Error("unknown privacy setting or value");
    this.prefsLocal = next; // effective immediately; the account-data echo (other devices) overrides it later
    await c.setAccountData(PREFS_TYPE as never, { read_receipts: next.readReceipts, typing: next.typing } as never);
    return this.getPrivacy();
  }

  async markRead(chatId: string, upToMessageId: string) {
    const c = this.client; if (!c) throw new Error("not connected");
    let ev = this.room(chatId).findEventById(upToMessageId);
    if (!ev) ev = c.getEventMapper()({ ...(await c.fetchRoomEvent(chatId, upToMessageId)), room_id: chatId } as never);
    await c.sendReadReceipt(ev, this.prefs().readReceipts === "private" ? ReceiptType.ReadPrivate : ReceiptType.Read);
    this.markDirty(chatId);
  }

  private async waitForRoom(roomId: string, ms = 8000): Promise<Room | undefined> {
    const c = this.client; if (!c) return undefined;
    const have = c.getRoom(roomId); if (have) return have;
    return new Promise((ok) => {
      const t = setTimeout(() => { c.off(ClientEvent.Room, h); ok(undefined); }, ms);
      const h = (r: Room) => { if (r.roomId === roomId) { clearTimeout(t); c.off(ClientEvent.Room, h); ok(r); } };
      c.on(ClientEvent.Room, h);
    });
  }
  /** A just-created room reaches us over /sync in pieces: give the m.room.name state (we just set it) a moment so the name is not "Empty room". */
  private async waitForName(r: Room | undefined) {
    for (let i = 0; r && i < 20 && !r.currentState.getStateEvents("m.room.name", ""); i++) await new Promise((ok) => setTimeout(ok, 100));
  }
  private async chatFor(roomId: string, fallbackName: string, kind: Chat["kind"]): Promise<Chat> {
    const r = await this.waitForRoom(roomId);
    await this.waitForName(r);
    if (r) { const c = await this.toChat(r, this.directMap(), this.parentMap()); if (!r.currentState.getStateEvents("m.room.name", "") && kind !== "dm") c.name = fallbackName; return c; }
    return { id: roomId, accountId: this.accountId, provider: PROVIDER, kind, name: fallbackName };
  }

  async acceptRequest(chatId: string) {
    const c = this.client; if (!c) throw new Error("not connected");
    const r = c.getRoom(chatId);
    if (!r || r.getMyMembership() !== "invite") throw new Error("This invitation is no longer pending.");
    const inviter = r.getDMInviter();
    try { await c.joinRoom(chatId); }
    catch (e) {
      if (e instanceof MatrixError && (e.errcode === "M_FORBIDDEN" || e.errcode === "M_NOT_FOUND" || e.httpStatus === 404 || e.httpStatus === 403)) { this.markDirty(); throw new Error("The invitation has expired or was withdrawn."); }
      throw e;
    }
    if (inviter) { // like Element: remember the direct chat in m.direct
      const cur = (c.getAccountData("m.direct" as never)?.getContent() ?? {}) as Record<string, string[]>;
      if (!(cur[inviter] ?? []).includes(chatId)) await c.setAccountData("m.direct" as never, { ...cur, [inviter]: [...(cur[inviter] ?? []), chatId] } as never);
    }
    for (let i = 0; i < 50 && c.getRoom(chatId)?.getMyMembership() !== "join"; i++) await new Promise((ok) => setTimeout(ok, 100));
    this.emit({ type: "spaces-changed", data: {} });
    this.markDirty();
  }

  async declineRequest(chatId: string) {
    const c = this.client; if (!c) throw new Error("not connected");
    try { await c.leave(chatId); } catch (e) { if (!(e instanceof MatrixError && (e.errcode === "M_FORBIDDEN" || e.errcode === "M_NOT_FOUND"))) throw e; }
    try { await c.forget(chatId); } catch { /* already gone */ }
    this.emit({ type: "spaces-changed", data: {} });
    this.markDirty();
  }

  async leaveChat(chatId: string) {
    const c = this.client; if (!c) throw new Error("not connected");
    try { await c.leave(chatId); } catch (e) { if (!(e instanceof MatrixError && e.errcode === "M_FORBIDDEN")) throw e; /* already left */ }
    await c.forget(chatId);
    this.markDirty();
  }

  async addMembers(chatId: string, memberHandles: string[]) {
    const c = this.client; if (!c) throw new Error("not connected");
    const ids = memberHandles.map((h) => normalizeUserId(h, this.me));
    if (ids.some((i) => !i)) throw new Error("Invalid Matrix ID (expected @user:server)");
    for (const id of ids as string[]) await c.invite(chatId, id);
  }

  async removeMember(chatId: string, memberId: string) {
    const c = this.client; if (!c) throw new Error("not connected");
    await c.kick(chatId, memberId);
  }

  async setChatDescription(chatId: string, text: string) {
    const c = this.client; if (!c) throw new Error("not connected");
    await c.setRoomTopic(chatId, text.trim());
  }

  async setChatPicture(chatId: string, image: { data: Uint8Array; mime: string } | null) {
    const c = this.client; if (!c) throw new Error("not connected");
    if (!image) { await c.sendStateEvent(chatId, "m.room.avatar" as never, {} as never, ""); return; }
    const up = await c.uploadContent(new Blob([image.data as BlobPart], { type: image.mime }), { type: image.mime, name: "avatar" });
    await c.sendStateEvent(chatId, "m.room.avatar" as never, { url: up.content_uri } as never, "");
  }

  async renameChat(chatId: string, name: string) {
    const c = this.client; if (!c) throw new Error("not connected");
    if (!name.trim()) throw new Error("Name must not be empty");
    await c.setRoomName(chatId, name.trim());
  }

  async blockChat(chatId: string, blocked: boolean) {
    const c = this.client; if (!c) throw new Error("not connected");
    const peer = this.directMap().get(chatId);
    if (!peer) throw new Error("Only 1:1 chats can be blocked");
    const cur = c.getIgnoredUsers();
    const next = blocked ? [...new Set([...cur, peer])] : cur.filter((u) => u !== peer);
    if (next.length !== cur.length) await c.setIgnoredUsers(next);
    this.markDirty();
  }

  private async spaceOf(r: Room): Promise<Space> {
    return { id: r.roomId, accountId: this.accountId, provider: PROVIDER, name: r.name || r.roomId, iconUrl: await this.avatarDataUrl(r.getMxcAvatarUrl()) };
  }

  async createSpace(name: string, description?: string): Promise<Space> {
    const c = this.client; if (!c) throw new Error("not connected");
    if (!name.trim()) throw new Error("Name must not be empty");
    const { room_id } = await c.createRoom({
      name: name.trim(), topic: description?.trim() || undefined, preset: Preset.PrivateChat, visibility: Visibility.Private,
      creation_content: { type: "m.space" },
      // Only admins may post in / restructure the space itself.
      power_level_content_override: { events_default: 100, events: { "m.space.child": 100 }, invite: 50 },
    });
    const r = await this.waitForRoom(room_id);
    await this.waitForName(r);
    this.emit({ type: "spaces-changed", data: {} });
    this.markDirty();
    if (r) return { ...(await this.spaceOf(r)), name: name.trim() };
    return { id: room_id, accountId: this.accountId, provider: PROVIDER, name: name.trim() };
  }

  async joinSpace(invite: string): Promise<Space> {
    const c = this.client; if (!c) throw new Error("not connected");
    const p = parseSpaceInvite(invite);
    if (!p) throw new Error("Not a Matrix space link: use #alias:server, !roomid:server or a matrix.to link");
    const joinedBefore = new Set(this.joined().map((r) => r.roomId));
    let room: Room;
    try { room = await c.joinRoom(p.target, p.via.length ? { viaServers: p.via } : {}); }
    catch (e) {
      if (e instanceof MatrixError) {
        if (e.errcode === "M_NOT_FOUND" || e.httpStatus === 404) throw new Error("Space not found (check the address, or add ?via=server).");
        if (e.errcode === "M_FORBIDDEN" || e.httpStatus === 403) throw new Error("Not allowed to join this space (invite-only or banned).");
      }
      throw new Error("Could not join the space: " + (e instanceof MatrixError ? (e.errcode ?? `HTTP ${e.httpStatus}`) : "server unreachable"));
    }
    // joinRoom may resolve before the room's state and our join membership arrived over /sync: wait for m.room.create + membership (else spaces() misses it).
    for (let i = 0; i < 50 && (!(c.getRoom(room.roomId) ?? room).currentState.getStateEvents("m.room.create", "") || c.getRoom(room.roomId)?.getMyMembership() !== "join"); i++) await new Promise((r) => setTimeout(r, 200));
    room = c.getRoom(room.roomId) ?? room;
    if (!room.currentState.getStateEvents("m.room.create", "")) throw new Error("Joined, but the space has not synced yet; it will appear shortly.");
    if (!room.isSpaceRoom()) {
      // Only undo the join we just did: a room the user was already in (pasted its own link) must stay joined.
      if (!joinedBefore.has(room.roomId)) { try { await c.leave(room.roomId); await c.forget(room.roomId); } catch { /* best effort */ } }
      throw new Error("This address is a room, not a space.");
    }
    this.emit({ type: "spaces-changed", data: {} });
    this.markDirty();
    return this.spaceOf(room);
  }

  async startChat(handle: string): Promise<Chat> {
    const c = this.client; if (!c) throw new Error("not connected");
    const user = handle.trim();
    if (!/^@[^:\s]+:\S+$/.test(user)) throw new Error("Use a full Matrix ID like @alice:example.org");
    for (const [roomId, u] of this.directMap()) {
      const r = c.getRoom(roomId);
      if (u === user && r?.getMyMembership() === "join") return this.toChat(r, this.directMap(), this.parentMap());
    }
    const { room_id } = await c.createRoom({
      is_direct: true, invite: [user], preset: Preset.TrustedPrivateChat,
      initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    const cur = (c.getAccountData("m.direct" as never)?.getContent() ?? {}) as Record<string, string[]>;
    await c.setAccountData("m.direct" as never, { ...cur, [user]: [...(cur[user] ?? []), room_id] } as never);
    return this.chatFor(room_id, user, "dm");
  }

  async createGroup(name: string, memberHandles: string[]): Promise<Chat> {
    const c = this.client; if (!c) throw new Error("not connected");
    const bad = memberHandles.find((h) => !/^@[^:\s]+:\S+$/.test(h.trim()));
    if (bad !== undefined) throw new Error("Members must be full Matrix IDs like @alice:example.org");
    const { room_id } = await c.createRoom({
      name, invite: memberHandles.map((h) => h.trim()), preset: Preset.PrivateChat,
      initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    return this.chatFor(room_id, name, "group");
  }
}

const factory: ProviderFactory = {
  name: PROVIDER, displayName: "Matrix", login: "form", capabilities: CAPS,
  create: ({ accountId, dataDir }) => new MatrixConnector(accountId, dataDir),
};
export default factory;
export { MatrixConnector, UNDECRYPTABLE_TEXT, isRedacted };
