// Instagram provider (UNOFFICIAL private mobile API, personal accounts). See README.md for the honest risk statement.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Capabilities, Chat, PrivacySetting, Connector, Contact, CoreEvent, HistoryQuery, LoginPrompt, Message, OutgoingAttachment, OutgoingMessage, ProviderFactory, MessagePatch } from "@unimsg/core";
import { Api, DEFAULT_BASE, DEFAULT_MQTT, IgError, cdnAllowed, dbg, encryptPassword, endpoint, newDevice, sleepAbortable, type Device, type Session } from "./api.js";
import { iso, mapItem, mapReactions, mapThread, mapUser, tsNum, userLabel, type IgItem, type IgThread, type IgUser, type MediaRef } from "./map.js";
import { Realtime, TOPICS, buildConnectPayload, type SyncOp } from "./mqtt.js";
import { imageSize } from "./imgsize.js";

export const CAPABILITIES: Capabilities = {
  spaces: false, reactions: true, edits: false, deletes: true, replies: true, attachments: true, typing: true,
  readReceipts: true, receiptDetails: true, markRead: true, startChat: true, createGroup: true, backfill: true, e2ee: false,
  voiceNotes: true, requests: true, mentions: true, leaveChat: true, renameChat: true, manageMembers: true, block: true, avatars: true,
  location: false, contactCards: false, polls: false, events: false, profile: {}, privacy: true, refreshChat: false, sync: false,
};

const SESSION_FILE = "instagram-session.json", DEVICE_FILE = "instagram-device.json", STATE_FILE = "instagram-sync.json";
const WARNING =
  "Unofficial login: Instagram doesn't allow third-party clients, so your account could be restricted or banned. Your password goes only to Instagram; only the session is kept on this device.";
/** The consent checkbox sends "true"; the old typed "YES" is still accepted. */
export const isConsent = (v: string | undefined) => /^(true|yes|on|1)$/i.test((v ?? "").trim());

const PACE_MS = () => process.env.UNIMSG_IG_PACE_MS !== undefined ? Number(process.env.UNIMSG_IG_PACE_MS) : 1200;
const POLL_MS = () => process.env.UNIMSG_IG_POLL_MS !== undefined ? Number(process.env.UNIMSG_IG_POLL_MS) : 75_000;   // without realtime
const POLL_RT_MS = () => process.env.UNIMSG_IG_POLL_MS !== undefined ? Number(process.env.UNIMSG_IG_POLL_MS) : 8 * 60_000; // safety net while realtime is up
const jitter = (ms: number) => Math.round(ms * (0.75 + Math.random() * 0.5));
const bounded = <K>(m: { size: number; keys(): IterableIterator<K>; delete(k: K): unknown }, max: number) => { while (m.size > max) m.delete(m.keys().next().value as K); };
const clientCtx = () => String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));

type Step = { kind: "login" } | { kind: "2fa"; username: string; identifier: string; method: "1" | "3" } | { kind: "challenge-code"; path: string } ;

class InstagramConnector implements Connector {
  readonly capabilities = CAPABILITIES;
  private emit: (e: CoreEvent) => void = () => {};
  private device!: Device;
  private sess: Session = { userId: "" };
  private api!: Api;
  private threads = new Map<string, IgThread>();
  private requests = new Set<string>();
  private users = new Map<string, IgUser>();
  private media = new Map<string, MediaRef>();
  private seen = new Set<string>();
  private cursors = new Map<string, string>();
  private myReact = new Map<string, string>();
  private ctxOf = new Map<string, string>();
  private lastSeenItem = new Map<string, string>();
  /** Timestamps (µs) of my own items per thread (bounded) and how far each member has seen: "seen up to X" covers all my items up to X, not just X. */
  private mineTs = new Map<string, Map<string, number>>();
  private seenUpTo = new Map<string, number>();
  private lastTs: Record<string, number> = {};
  private typingTimers = new Map<string, NodeJS.Timeout>();
  private rt?: Realtime;
  private rtFails = 0;
  private rtTimer?: NodeJS.Timeout;
  private iris?: { seq_id: number; snapshot_at_ms: number };
  private abort = new AbortController();
  private kickAt = 0;
  private stopped = true;
  private loopRunning = false;
  private loopId = 0;
  private promptN = 0;
  private step: Step = { kind: "login" };
  private firstEver = false;
  private syncN = 0;
  private dirty = false;
  private announcedBlock = 0;

  private readonly accountId: string; private readonly dataDir: string;
  constructor(accountId: string, dataDir: string) { this.accountId = accountId; this.dataDir = dataDir; }

  // ---------------------------------------------------------------- lifecycle
  async start(emit: (e: CoreEvent) => void): Promise<void> {
    this.emit = (e) => { try { emit(e); } catch { /* handlers must not break us */ } };
    this.stopped = false; this.abort = new AbortController();
    this.device = this.readJson<Device>(DEVICE_FILE) ?? this.saveJson(DEVICE_FILE, newDevice());
    const s = this.readJson<Session>(SESSION_FILE);
    this.lastTs = this.readJson<{ lastTs: Record<string, number> }>(STATE_FILE)?.lastTs ?? {};
    this.firstEver = !existsSync(join(this.dataDir, STATE_FILE));
    this.api = new Api({
      base: endpoint("UNIMSG_IG_BASE", DEFAULT_BASE), device: this.device, paceMs: PACE_MS(),
      getSession: () => (this.sess.userId ? this.sess : undefined),
      setSession: (p) => { Object.assign(this.sess, p); if (this.sess.userId) this.persistSession(); },
      onBlocked: (ms, why) => { this.emitBlocked(ms, why); },
    });
    if (!s?.userId || !s.authorization) { this.state("needs-login"); this.prompt(); return; }
    this.sess = s; this.state("connecting"); this.begin();
  }
  async stop(): Promise<void> {
    this.stopped = true; this.loopId++; this.abort.abort();
    for (const t of this.typingTimers.values()) clearTimeout(t); this.typingTimers.clear();
    clearTimeout(this.rtTimer); this.rt?.stop(); this.rt = undefined; this.flushState();
  }
  async logout(): Promise<void> {
    const had = !!this.sess.userId; const api = this.api;
    await this.stop();
    this.wipe();
    if (had && api) { try { await api.request("POST", "/api/v1/accounts/logout/", { form: { device_id: this.device.androidId, _uuid: this.device.uuid }, signed: true, noBlock: true, headers: {} }); } catch { throw new Error("You were signed out locally, but Instagram did not confirm the logout. You can end the session in the Instagram app under Settings > Accounts Center > Password and security > Where you're logged in."); } }
    this.sess = { userId: "" };
  }

  private state(state: "connecting" | "needs-login" | "connected" | "disconnected" | "signed-out", detail?: string) { this.emit({ type: "account", data: { id: this.accountId, state, ...(detail ? { detail } : {}) } }); }
  private err(code: string, message: string, fatal = false) { this.emit({ type: "error", data: { id: this.accountId, code, message, fatal } }); }
  private emitBlocked(ms: number, why: string) {
    if (Date.now() - this.announcedBlock < 60_000) return; this.announcedBlock = Date.now();
    this.err(why === "rate" ? "rate-limited" : "action-blocked", `Instagram asked this client to slow down; pausing for about ${Math.ceil(ms / 60000)} min.`);
  }

  // ---------------------------------------------------------------- files (session = secret: private mode, atomic, never logged)
  private readJson<T>(name: string): T | undefined { try { const f = join(this.dataDir, name); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) as T : undefined; } catch { return undefined; } }
  private saveJson<T>(name: string, v: T): T {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const f = join(this.dataDir, name), tmp = f + ".tmp";
    writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, f); return v;
  }
  private persistSession() { try { this.saveJson(SESSION_FILE, this.sess); } catch { /* disk problems must not kill the session */ } }
  private flushState() { if (!this.dirty) return; this.dirty = false; try { this.saveJson(STATE_FILE, { lastTs: this.lastTs }); } catch { /* ignore */ } }
  /** The device file stays: forgetting it would make the next login look like a brand-new phone. */
  private wipe() { for (const n of [SESSION_FILE, STATE_FILE]) try { rmSync(join(this.dataDir, n), { force: true }); } catch { /* ignore */ } this.lastTs = {}; this.dirty = false; this.threads.clear(); this.media.clear(); this.seen.clear(); this.cursors.clear(); }

  // ---------------------------------------------------------------- login
  private prompt(error?: string) {
    const id = `${this.step.kind}-${++this.promptN}`;
    let p: LoginPrompt;
    if (this.step.kind === "2fa") p = { accountId: this.accountId, promptId: id, kind: "form", title: "Instagram asks for your two-factor code (authenticator app or the SMS it just sent).", fields: [{ name: "code", label: "Verification code", type: "code" }], ...(error ? { error } : {}) };
    else if (this.step.kind === "challenge-code") p = { accountId: this.accountId, promptId: id, kind: "form", title: "Instagram wants to confirm it is really you (security checkpoint) and sent you a code by e-mail or SMS. Enter it here. If nothing arrives, open the Instagram app or website, approve \"This was me\", then sign in again.", fields: [{ name: "code", label: "Security code", type: "code" }], ...(error ? { error } : {}) };
    else p = { accountId: this.accountId, promptId: id, kind: "form", title: "Sign in to Instagram", ...(error ? { error } : {}), warning: { severity: "danger", text: WARNING }, fields: [
      { name: "username", label: "Instagram username or e-mail", type: "text" },
      { name: "password", label: "Password", type: "password" },
      { name: "confirm", label: "I understand this is unofficial and may risk my account", type: "checkbox", required: true },
    ] };
    this.emit({ type: "login", data: p });
  }
  private async needsLogin(msg: string) {
    this.stopLoops(); this.wipe(); this.sess = { userId: "" }; this.step = { kind: "login" };
    this.state("needs-login", msg); this.prompt(msg);
  }

  async submitLogin(_promptId: string, v: Record<string, string>): Promise<void> {
    const st = this.step;
    try {
      if (st.kind === "login") await this.doLogin(v);
      else if (st.kind === "2fa") {
        const code = (v.code ?? "").replace(/\s/g, ""); if (!/^\d{4,8}$/.test(code)) throw new IgError("Enter the numeric code.", "http");
        const r = await this.api.request("POST", "/api/v1/accounts/two_factor_login/", { signed: true, form: { username: st.username, verification_code: code, two_factor_identifier: st.identifier, trust_this_device: "1", verification_method: st.method, device_id: this.device.androidId, guid: this.device.uuid } });
        this.finishLogin(r.json);
      } else {
        const code = (v.code ?? "").replace(/\s/g, ""); if (!/^\d{4,8}$/.test(code)) throw new IgError("Enter the numeric code.", "http");
        const r = await this.api.request("POST", st.path, { form: { security_code: code, _uuid: this.device.uuid, guid: this.device.uuid, device_id: this.device.androidId } });
        this.finishLogin(r.json);
      }
    } catch (e) {
      if (e instanceof IgError && e.kind === "2fa" && st.kind === "login") {
        const info = e.data?.two_factor_info ?? {};
        this.step = { kind: "2fa", username: String(info.username ?? v.username ?? "").replace(/^@/, ""), identifier: String(info.two_factor_identifier ?? ""), method: info.totp_two_factor_on ? "3" : "1" };
        this.prompt(); return;
      }
      if (e instanceof IgError && e.kind === "challenge" && st.kind === "login") { await this.startChallenge(e.data); return; }
      if (e instanceof IgError) throw new Error(e.message);
      throw new Error("Login failed.");
    }
  }
  private async doLogin(v: Record<string, string>) {
    if (!isConsent(v.confirm)) throw new IgError("Please tick the box to confirm you understand the risks of this unofficial login.", "http");
    const username = (v.username ?? "").trim().replace(/^@/, "").toLowerCase(), password = v.password ?? "";
    if (!username || !password) throw new IgError("Enter username and password.", "http");
    // The password key comes back as response headers. Instagram removed /qe/sync/ (404); the login endpoint itself still sends the key headers (even on its 405 answer to a GET), so ask it as a fallback.
    let keyId: string | null = null, pub: string | null = null;
    for (const path of ["/api/v1/qe/sync/", "/api/v1/accounts/login/"]) {
      try { const k = await this.api.request("GET", path, { anon: true, allowError: true }); keyId = k.headers.get("ig-set-password-encryption-key-id"); pub = k.headers.get("ig-set-password-encryption-pub-key"); } catch (e) { if (e instanceof IgError && e.kind === "network") throw e; }
      if (keyId && pub) break;
    }
    if (!keyId || !pub) throw new IgError("Instagram did not offer a password key (the login flow has probably changed).", "http");
    const r = await this.api.request("POST", "/api/v1/accounts/login/", { signed: true, anon: true, form: {
      username, enc_password: encryptPassword(password, keyId, pub), device_id: this.device.androidId, guid: this.device.uuid, phone_id: this.device.phoneId,
      adid: this.device.adId, login_attempt_count: "0", country_codes: '[{"country_code":"1","source":["default"]}]' } });
    this.finishLogin(r.json);
  }
  private async startChallenge(data: any) {
    const path = String(data?.challenge?.api_path ?? "");
    if (!path.startsWith("/")) { this.step = { kind: "login" }; this.prompt("Instagram wants to verify it is you, but no code can be requested from here. Open the Instagram app or website, approve \"This was me\", and try again."); return; }
    try {
      const c = await this.api.json<any>("GET", "/api/v1" + path.replace(/^\/api\/v1/, ""));
      const choice = c?.step_data?.choice ?? (c?.step_data?.email ? "1" : "0");
      await this.api.json("POST", "/api/v1" + path.replace(/^\/api\/v1/, ""), { form: { choice, _uuid: this.device.uuid, guid: this.device.uuid, device_id: this.device.androidId } });
      this.step = { kind: "challenge-code", path: "/api/v1" + path.replace(/^\/api\/v1/, "") }; this.prompt();
    } catch { this.step = { kind: "login" }; this.prompt("Instagram wants to verify it is you, but requesting a code failed. Open the Instagram app or website, approve \"This was me\", and try again later."); }
  }
  private finishLogin(j: any) {
    const u = j?.logged_in_user; if (!u?.pk || !this.sess.authorization) throw new IgError("Instagram answered the login unexpectedly.", "http");
    this.sess.userId = String(u.pk); this.sess.username = u.username; this.persistSession();
    this.step = { kind: "login" }; this.firstEver = true; this.state("connecting"); this.begin();
  }

  // ---------------------------------------------------------------- sync loop (polling, paced) + realtime
  private stopLoops() { this.loopId++; this.abort.abort(); this.abort = new AbortController(); clearTimeout(this.rtTimer); this.rt?.stop(); this.rt = undefined; }
  private begin() { this.stopLoops(); const id = this.loopId; void this.loop(id); }
  /** Ask the loop to poll sooner (e.g. realtime saw an unknown thread), at most every 20 s. */
  private kick() { if (Date.now() - this.kickAt < 20_000) return; this.kickAt = Date.now(); this.abort.abort(); this.abort = new AbortController(); }

  private async loop(id: number) {
    let fails = 0, connected = false, first = true;
    while (!this.stopped && id === this.loopId) {
      let wait = this.rt?.isOpen ? POLL_RT_MS() : POLL_MS();
      try {
        await this.pollInbox(first); first = false;
        if (!connected) { connected = true; this.state("connected"); }
        fails = 0; if (!this.rt && !this.rtTimer) this.connectRealtime(id);
      } catch (e) {
        if (this.stopped || id !== this.loopId) return;
        if (e instanceof IgError && (e.kind === "auth")) return void this.needsLogin("Your Instagram session expired or was revoked. Please sign in again.");
        if (e instanceof IgError && e.kind === "challenge") return void this.needsLogin("Instagram requires a security checkpoint for this account. Open the Instagram app or website, confirm \"This was me\", then sign in again here.");
        fails++;
        if (e instanceof IgError && (e.kind === "rate" || e.kind === "feedback")) { wait = Math.max(e.retryAfterMs ?? 0, 5 * 60_000); }
        else { wait = Math.min(15 * 60_000, 20_000 * 2 ** Math.min(fails, 6)) * (0.8 + Math.random() * 0.4); if (process.env.UNIMSG_IG_POLL_MS !== undefined) wait = Number(process.env.UNIMSG_IG_POLL_MS) * Math.min(fails, 4); }
        if (connected) { connected = false; this.state("disconnected", e instanceof IgError && e.kind === "network" ? "offline" : "Instagram unavailable"); }
        else this.state("connecting");
        if (!(e instanceof IgError && (e.kind === "rate" || e.kind === "feedback"))) this.err(e instanceof IgError && e.kind === "network" ? "network" : "sync-failed", e instanceof IgError ? e.message : "Sync failed.");
      }
      await sleepAbortable(jitter(wait), this.abort.signal);
    }
  }

  private viewer() { return this.sess.userId; }

  private async pollInbox(first: boolean) {
    const n = ++this.syncN; let changed = false;
    const q = "?persistentBadging=true&limit=20&thread_message_limit=10&visual_message_return_type=unseen";
    const inbox = await this.api.json<any>("GET", "/api/v1/direct_v2/inbox/" + q);
    if (inbox.seq_id !== undefined) this.iris = { seq_id: Number(inbox.seq_id), snapshot_at_ms: Number(inbox.snapshot_at_ms ?? Date.now()) };
    const seenIds = new Set<string>();
    for (const t of inbox.inbox?.threads ?? []) { seenIds.add(String(t.thread_id)); if (this.ingest(t, first, false)) changed = true; }
    if (first || n % 5 === 0 || (inbox.pending_requests_total ?? 0) > 0 && n % 3 === 0) {
      try {
        const p = await this.api.json<any>("GET", "/api/v1/direct_v2/pending_inbox/?limit=20&thread_message_limit=5");
        const pend = new Set<string>();
        for (const t of p.inbox?.threads ?? []) { pend.add(String(t.thread_id)); seenIds.add(String(t.thread_id)); if (this.ingest(t, first, true)) changed = true; }
        for (const id of [...this.requests]) if (!pend.has(id) && !(inbox.inbox?.threads ?? []).some((t: any) => String(t.thread_id) === id)) { this.requests.delete(id); changed = true; }
      } catch (e) { if (e instanceof IgError && (e.kind === "auth" || e.kind === "rate" || e.kind === "feedback" || e.kind === "challenge")) throw e; /* requests are optional */ }
    }
    if (changed || first) this.emit({ type: "chats-changed", data: {} });
    this.flushState();
  }

  /** Merge one inbox/thread object into the caches and emit message/receipt events for what is new. Returns true when the chat list changed. */
  private ingest(t: IgThread, initial: boolean, pending: boolean): boolean {
    const id = String(t.thread_id); const prev = this.threads.get(id);
    if (!this.sess.userId && t.viewer_id) this.sess.userId = String(t.viewer_id);
    for (const u of t.users ?? []) this.users.set(String(u.pk), u); bounded(this.users, 5000);
    const merged: IgThread = { ...prev, ...t, users: t.users ?? prev?.users, items: t.items?.length ? t.items : prev?.items };
    this.threads.set(id, merged); if (pending) this.requests.add(id); else if (!t.pending) this.requests.delete(id);
    const items = [...(t.items ?? [])].reverse(); // oldest -> newest
    const last = this.lastTs[id];
    for (const it of items) {
      const key = `${id}|${it.item_id}`; const ts = tsNum(it.timestamp);
      if (this.seen.has(key)) continue; this.seen.add(key); bounded(this.seen, 20000);
      if (last !== undefined && ts <= last) continue;
      const { message, media } = this.map(it, id);
      this.noteItem(id, it.item_id, ts, message.fromMe);
      const recent = Date.now() - ts / 1000 < 15 * 60_000;
      const historical = (last === undefined && (initial || this.firstEver)) || !recent;
      this.keepMedia(id, media);
      this.emit({ type: "message", data: historical ? { ...message, historical: true } : message });
      if (ts > (this.lastTs[id] ?? 0)) { this.lastTs[id] = ts; this.dirty = true; }
    }
    if (last === undefined && !items.length) { this.lastTs[id] = 0; this.dirty = true; }
    for (const [uid, v] of Object.entries(t.last_seen_at ?? {})) {
      if (uid === this.viewer() || !v?.item_id) continue;
      const k = `${id}|${uid}`; if (this.lastSeenItem.get(k) === v.item_id) continue;
      this.lastSeenItem.set(k, v.item_id);
      this.seenBy(id, uid, v.item_id, v.timestamp);
    }
    if (!prev) return true;
    return prev.thread_title !== t.thread_title || !!prev.muted !== !!t.muted || !!(prev.archived || prev.is_archived) !== !!(t.archived || t.is_archived) || prev.last_activity_at !== t.last_activity_at || prev.read_state !== t.read_state;
  }
  private noteItem(chatId: string, itemId: string, ts: number, mine: boolean) {
    if (!mine || !ts) return;
    let m = this.mineTs.get(chatId); if (!m) { m = new Map(); this.mineTs.set(chatId, m); bounded(this.mineTs, 500); }
    m.set(itemId, ts); bounded(m, 300);
  }
  /** `uid` has seen the thread up to `itemId`: that is a read receipt for each of my items up to it (new range since their previous mark). The time is when they saw it (µs). */
  private seenBy(chatId: string, uid: string, itemId: string, seenAt: unknown) {
    const t = tsNum(seenAt) / 1000, at = t > 1e11 ? new Date(t).toISOString() : undefined; // µs -> ms; not a counter
    const send = (id: string) => this.emit({ type: "receipt", data: { chatId, messageId: id, status: "read", by: uid, ...(at ? { at } : {}) } });
    const mine = this.mineTs.get(chatId), upTo = mine?.get(itemId);
    if (!mine || upTo === undefined) { send(itemId); return; } // position unknown (or not my item): only the exact item
    const key = `${chatId}|${uid}`, from = this.seenUpTo.get(key) ?? 0;
    if (upTo > from) this.seenUpTo.set(key, upTo); bounded(this.seenUpTo, 2000);
    for (const [id, ts] of mine) if (ts > from && ts <= upTo) send(id);
  }
  private map(it: IgItem, chatId: string) { const r = mapItem(it, chatId, this.viewer(), this.users, this.accountId); if (it.client_context) { this.ctxOf.set(`${chatId}|${it.item_id}`, String(it.client_context)); bounded(this.ctxOf, 5000); } return r; }
  private keepMedia(chatId: string, m: Map<string, MediaRef>) { for (const [k, v] of m) this.media.set(`${chatId}|${k}`, v); bounded(this.media, 4000); }

  // ---------------------------------------------------------------- realtime
  private connectRealtime(id: number) {
    if (process.env.UNIMSG_IG_NO_REALTIME === "1" || this.stopped || id !== this.loopId || !this.sess.authorization) return;
    const rt = new Realtime({
      url: endpoint("UNIMSG_IG_MQTT", DEFAULT_MQTT), headers: { "User-Agent": this.device.userAgent, Origin: "https://www.instagram.com" },
      connect: () => this.sess.authorization ? buildConnectPayload({ userId: this.sess.userId, deviceId: this.device.deviceId, userAgent: this.device.userAgent, authorization: this.sess.authorization }) : undefined,
      iris: () => this.iris,
      onOpen: () => { this.rtFails = 0; dbg("realtime connected"); },
      onOps: (ops) => this.safe(() => this.onOps(ops)), onPubsub: (ops) => this.safe(() => this.onPubsub(ops)),
      onClose: (was, reason) => {
        if (this.rt !== rt || this.stopped || id !== this.loopId) return; this.rt = undefined; dbg(`realtime closed (${reason})`);
        this.rtFails = was ? 1 : this.rtFails + 1;
        // Never hammer: 30s, 1m, 2m ... 15 min; after repeated failures to even connect, retry only every 30 min (polling carries on).
        const base = process.env.UNIMSG_IG_RT_RETRY_MS ? Number(process.env.UNIMSG_IG_RT_RETRY_MS) : this.rtFails >= 4 ? 30 * 60_000 : Math.min(15 * 60_000, 30_000 * 2 ** (this.rtFails - 1));
        this.rtTimer = setTimeout(() => { this.rtTimer = undefined; this.connectRealtime(id); }, jitter(base)); this.rtTimer.unref?.();
        this.kick();
      },
    });
    this.rt = rt; rt.start();
  }
  private safe(f: () => void) { try { f(); } catch { dbg("realtime: handler error ignored"); } }
  private val(v: unknown): any { if (typeof v === "string") { try { return JSON.parse(v); } catch { return undefined; } } return v; }
  private onOps(ops: SyncOp[]) {
    for (const o of ops) {
      let m = /^\/direct_v2\/threads\/([^/]+)\/items\/([^/]+)$/.exec(o.path);
      if (m) {
        const [, tid, iid] = m;
        if (o.op === "remove") { this.emit({ type: "message-update", data: { chatId: tid, messageId: iid, patch: { deleted: true } } }); continue; }
        const it = this.val(o.value) as IgItem | undefined; if (!it?.item_id) continue;
        const key = `${tid}|${it.item_id}`; const { message, media } = this.map(it, tid);
        if (this.seen.has(key)) { const patch: MessagePatch = {}; if (message.reactions) patch.reactions = message.reactions; if (it.is_deleted) patch.deleted = true; if (Object.keys(patch).length) this.emit({ type: "message-update", data: { chatId: tid, messageId: it.item_id, patch } }); continue; }
        this.seen.add(key); this.keepMedia(tid, media); this.noteItem(tid, it.item_id, tsNum(it.timestamp), message.fromMe);
        this.emit({ type: "message", data: message });
        const ts = tsNum(it.timestamp); if (ts > (this.lastTs[tid] ?? 0)) { this.lastTs[tid] = ts; this.dirty = true; }
        if (!this.threads.has(tid)) this.kick(); else this.emit({ type: "chats-changed", data: { chatId: tid } });
        continue;
      }
      m = /^\/direct_v2\/threads\/([^/]+)\/participants\/([^/]+)\/has_seen$/.exec(o.path);
      if (m) { const v = this.val(o.value); if (v?.item_id && m[2] !== this.viewer()) this.seenBy(m[1], m[2], String(v.item_id), v.timestamp); continue; }
      m = /^\/direct_v2\/(?:inbox\/)?threads\/([^/]+)$/.exec(o.path);
      if (m) this.emit({ type: "chats-changed", data: { chatId: m[1] } });
    }
  }
  private onPubsub(ops: SyncOp[]) {
    for (const o of ops) {
      const m = /^\/direct_v2\/threads\/([^/]+)\/activity_indicator_id\//.exec(o.path); if (!m) continue;
      const v = this.val(o.value); const sender = String(v?.sender_id ?? ""); if (!sender || sender === this.viewer()) continue;
      const on = Number(v?.activity_status) === 1; const key = `${m[1]}|${sender}`;
      clearTimeout(this.typingTimers.get(key));
      this.emit({ type: "typing", data: { chatId: m[1], senderId: sender, typing: on } });
      if (on) { const t = setTimeout(() => { this.typingTimers.delete(key); this.emit({ type: "typing", data: { chatId: m[1], senderId: sender, typing: false } }); }, Math.min(Math.max(Number(v?.ttl) || 5000, 2000), 15000)); t.unref?.(); this.typingTimers.set(key, t); }
    }
  }

  // ---------------------------------------------------------------- read
  async spaces() { return []; }
  async chats(): Promise<Chat[]> {
    const out: IgThread[] = []; let cursor: string | undefined;
    for (let i = 0; i < 5; i++) { // at most 100 threads, one page at a time
      const r = await this.api.json<any>("GET", "/api/v1/direct_v2/inbox/?persistentBadging=true&limit=20&thread_message_limit=1&visual_message_return_type=unseen" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
      for (const t of r.inbox?.threads ?? []) { this.ingest({ ...t }, false, false); out.push(t); }
      if (!r.inbox?.has_older || !r.inbox?.oldest_cursor) break; cursor = r.inbox.oldest_cursor;
    }
    const ids = new Set(out.map((t) => String(t.thread_id)));
    try {
      const p = await this.api.json<any>("GET", "/api/v1/direct_v2/pending_inbox/?limit=20&thread_message_limit=1");
      for (const t of p.inbox?.threads ?? []) { this.ingest({ ...t }, false, true); if (!ids.has(String(t.thread_id))) out.push(t); }
    } catch (e) { if (e instanceof IgError && e.kind === "auth") throw e; }
    return out.map((t) => mapThread(this.threads.get(String(t.thread_id)) ?? t, this.accountId, this.viewer(), this.users, this.requests.has(String(t.thread_id))));
  }

  private async fetchThread(tid: string, cursor?: string): Promise<IgThread> {
    const r = await this.api.json<any>("GET", `/api/v1/direct_v2/threads/${encodeURIComponent(tid)}/?visual_message_return_type=unseen&direction=older&limit=20` + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    const t = r.thread as IgThread; if (!t) throw new IgError("Conversation not found.", "not-found", 404);
    for (const u of t.users ?? []) this.users.set(String(u.pk), u);
    if (!this.viewer() && t.viewer_id) this.sess.userId = String(t.viewer_id);
    return t;
  }

  async history(chatId: string, q: HistoryQuery): Promise<Message[]> {
    const want = Math.max(1, Math.min(q.limit, 60)); const got: IgItem[] = [];
    let cursor: string | undefined; let skipping = q.beforeMessageId;
    if (skipping) cursor = this.cursors.get(`${chatId}|${skipping}`);
    const walk = !!skipping && !cursor;
    let pages = 0, hasOlder = true;
    // Without a remembered cursor for beforeMessageId we walk down from the newest page (bounded) until we find it.
    while (hasOlder && got.length < want && pages < (walk ? 12 : 4)) {
      const t = await this.fetchThread(chatId, cursor); pages++;
      const items = t.items ?? []; this.threads.set(chatId, { ...this.threads.get(chatId), ...t, items: this.threads.get(chatId)?.items ?? t.items });
      let list = items;
      if (skipping && walk) { const i = items.findIndex((x) => x.item_id === skipping); if (i >= 0) { list = items.slice(i + 1); skipping = undefined; } else list = []; }
      else skipping = undefined;
      got.push(...list);
      hasOlder = !!t.has_older && !!t.oldest_cursor; cursor = t.oldest_cursor;
      if (items.length && cursor) this.cursors.set(`${chatId}|${items[items.length - 1].item_id}`, cursor);
      if (!list.length && !items.length) break;
    }
    const page = got.slice(0, want); if (cursor && got.length > want) { /* surplus items are re-fetched on the next page: cursor of the cut point is unknown */ }
    // remember the cursor for the last returned item only when we stopped exactly at a page edge
    if (page.length && got.length === page.length && cursor) this.cursors.set(`${chatId}|${page[page.length - 1].item_id}`, cursor);
    const out: Message[] = [];
    for (const it of page.reverse()) { const { message, media } = this.map(it, chatId); this.keepMedia(chatId, media); out.push(message); }
    return out;
  }

  async members(chatId: string): Promise<Contact[]> {
    const t = this.threads.get(chatId)?.users ? this.threads.get(chatId)! : await this.fetchThread(chatId);
    const me = this.users.get(this.viewer());
    return [{ id: this.viewer(), name: me ? mapUser(me).name : this.sess.username ?? "Me", ...(this.sess.username ? { handle: "@" + this.sess.username } : {}) }, ...(t.users ?? []).filter((u) => String(u.pk) !== this.viewer()).map(mapUser)];
  }

  async downloadAttachment(chatId: string, messageId: string, attachmentId: string) {
    let ref = this.media.get(`${chatId}|${attachmentId}`);
    if (!ref) { // e.g. media we just sent: look at the newest page of the thread
      const t = await this.fetchThread(chatId);
      for (const it of t.items ?? []) this.keepMedia(chatId, this.map(it, chatId).media);
      ref = this.media.get(`${chatId}|${attachmentId}`);
    }
    if (!ref) throw new Error("This attachment is no longer available from Instagram.");
    const d = await this.api.download(ref.url);
    return { data: d.data, mime: d.mime.startsWith("application/") ? ref.mime : d.mime, ...(ref.name ? { name: ref.name } : {}) };
  }

  async avatar(target: { kind: "chat" | "space" | "contact"; id: string }) {
    let url: string | undefined;
    if (target.kind === "contact") url = this.users.get(target.id)?.profile_pic_url;
    else if (target.kind === "chat") { const t = this.threads.get(target.id); const o = (t?.users ?? []).filter((u) => String(u.pk) !== this.viewer()); if (!t?.is_group && o.length === 1) url = o[0].profile_pic_url; }
    if (!url || !cdnAllowed(url)) return undefined;
    try { const d = await this.api.download(url); return d.mime.startsWith("image/") ? { data: d.data, mime: d.mime } : undefined; } catch { return undefined; }
  }

  // ---------------------------------------------------------------- write
  private async approveIfRequest(chatId: string) {
    if (!this.requests.has(chatId)) return;
    await this.api.json("POST", `/api/v1/direct_v2/threads/${encodeURIComponent(chatId)}/approve/`, { form: { _uuid: this.device.uuid } });
    this.requests.delete(chatId); this.emit({ type: "chats-changed", data: { chatId } });
  }
  /** A provisional chat id is `new:<user pk>`: Instagram creates the thread with the first message, addressed by recipient. */
  private base(chatId: string) { const c = clientCtx(); const target: Record<string, string> = chatId.startsWith("new:") ? { recipient_users: JSON.stringify([[chatId.slice(4)]]) } : { thread_ids: JSON.stringify([chatId]) };
    return { ...target, client_context: c, mutation_token: c, offline_threading_id: c, _uuid: this.device.uuid, device_id: this.device.androidId, action: "send_item" } as Record<string, string>; }
  private ack(chatId: string, j: any, extra: Partial<Message>, fallbackCtx: string): Message {
    const p = j?.payload ?? j?.message_metadata?.[0] ?? {}; const id = String(p.item_id ?? ""); if (!id) throw new Error("Instagram did not confirm the message.");
    if (chatId.startsWith("new:")) { const real = String(p.thread_id ?? ""); if (!real) throw new Error("Instagram did not say which conversation was created."); chatId = real; }
    this.seen.add(`${chatId}|${id}`); this.ctxOf.set(`${chatId}|${id}`, String(p.client_context ?? fallbackCtx));
    const ts = tsNum(p.timestamp); if (ts > (this.lastTs[chatId] ?? 0)) { this.lastTs[chatId] = ts; this.dirty = true; }
    this.noteItem(chatId, id, ts, true);
    return { id, chatId, accountId: this.accountId, sender: "Me", senderId: this.viewer(), text: "", time: ts ? iso(ts) : new Date().toISOString(), fromMe: true, status: "sent", ...extra };
  }

  async send(chatId: string, msg: OutgoingMessage): Promise<Message> {
    const original = chatId;
    if (!chatId.startsWith("new:")) await this.approveIfRequest(chatId);
    const sent: Message[] = [];
    for (const a of msg.attachments ?? []) { const m = await this.sendAttachment(chatId, a); sent.push(m); chatId = m.chatId; } // the first item of a provisional chat creates the real thread
    if (msg.text || !sent.length) {
      const f = this.base(chatId);
      const { text: out, ids } = this.withMentions(msg);
      f.text = out; if (ids.length) f.mentioned_user_ids = JSON.stringify(ids); // hypothesis: field name of the web client's group mentions
      const urls = out.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
      const asLink = urls.length > 0 && !msg.replyToMessageId; // Instagram builds the preview card itself from link_urls
      if (asLink) { delete f.text; f.link_text = out; f.link_urls = JSON.stringify(urls.slice(0, 5)); }
      let replyTo: Message["replyTo"];
      if (msg.replyToMessageId) {
        f.replied_to_item_id = msg.replyToMessageId; const rc = this.ctxOf.get(`${chatId}|${msg.replyToMessageId}`); if (rc) f.replied_to_client_context = rc;
        replyTo = { messageId: msg.replyToMessageId };
      }
      const j = await this.api.json<any>("POST", `/api/v1/direct_v2/threads/broadcast/${asLink ? "link" : "text"}/`, { form: f });
      sent.push(this.ack(chatId, j, { text: out, ...(replyTo ? { replyTo } : {}) }, f.client_context));
    }
    for (const m of sent.slice(0, -1)) this.emit({ type: "message", data: m });
    if (sent[0] && sent[0].chatId !== original) this.emit({ type: "chats-changed", data: {} });
    return sent[sent.length - 1];
  }

  private async sendAttachment(chatId: string, a: OutgoingAttachment): Promise<Message> {
    const f = this.base(chatId); const uploadId = String(Date.now());
    const isImg = a.kind === "image" || a.kind === "sticker", isVoice = a.kind === "voice" || a.kind === "audio", isVid = a.kind === "video";
    if (!isImg && !isVoice && !isVid) throw new Error("Instagram direct messages only accept photos, videos and voice messages from here.");
    if (a.data.length > 100 * 1024 * 1024) throw new Error("That file is too large for Instagram.");
    const name = `${uploadId}_0_${Math.floor(Math.random() * 9e9 + 1e9)}`;
    const dim = isImg ? imageSize(a.data) : undefined;
    const params: Record<string, unknown> = isImg
      ? { media_type: 1, upload_id: uploadId, upload_media_height: dim?.height ?? 0, upload_media_width: dim?.width ?? 0, image_compression: JSON.stringify({ lib_name: "moz", lib_version: "3.1.m", quality: "80" }), xsharing_user_ids: "[]", retry_context: JSON.stringify({ num_step_auto_retry: 0, num_reupload: 0, num_step_manual_retry: 0 }) }
      : isVoice ? { media_type: 11, upload_id: uploadId, is_direct_voice: "1", upload_media_duration_ms: a.durationMs ?? 0, xsharing_user_ids: "[]" }
      : { media_type: 2, upload_id: uploadId, upload_media_duration_ms: a.durationMs ?? 0, xsharing_user_ids: "[]", is_direct_video: "1" };
    await this.api.request("POST", `/rupload_${isImg ? "igphoto" : "igvideo"}/${name}`, { body: a.data, headers: {
      "X-Instagram-Rupload-Params": JSON.stringify(params), "X-Entity-Name": name, "X-Entity-Length": String(a.data.length), "X-Entity-Type": isImg ? (a.mime || "image/jpeg") : isVoice ? "audio/mp4" : "video/mp4",
      Offset: "0", "Content-Type": "application/octet-stream" } });
    f.upload_id = uploadId;
    let path: string;
    if (isImg) { path = "configure_photo"; f.allow_full_aspect_ratio = "true"; }
    else if (isVoice) { path = "share_voice"; f.waveform = JSON.stringify((a.waveform ?? []).map((x) => Math.max(0, Math.min(1, x / 100)))); f.waveform_sampling_frequency_hz = "10"; }
    else { path = "configure_video"; f.video_result = ""; f.sampled = "true"; }
    const j = await this.api.json<any>("POST", `/api/v1/direct_v2/threads/broadcast/${path}/`, { form: f });
    const m = this.ack(chatId, j, {}, f.client_context);
    m.attachments = [{ id: `${m.id}:0`, kind: isImg ? (a.kind === "sticker" ? "sticker" : "image") : isVoice ? "voice" : "video", mime: a.mime, ...(a.name ? { name: a.name } : {}), size: a.data.length, ...(dim ? dim : {}), ...(a.durationMs ? { durationMs: a.durationMs } : {}), ...(a.waveform ? { waveform: a.waveform } : {}) }];
    return m;
  }

  async react(chatId: string, messageId: string, emoji: string | null): Promise<void> {
    const key = `${chatId}|${messageId}`; const f = this.base(chatId); delete f.action;
    Object.assign(f, { item_type: "reaction", reaction_type: "like", node_type: "item", item_id: messageId, super_react_type: "none" });
    if (emoji === null) { f.reaction_status = "deleted"; f.emoji = this.myReact.get(key) ?? "❤️"; this.myReact.delete(key); }
    else { f.reaction_status = "created"; f.emoji = emoji; this.myReact.set(key, emoji); bounded(this.myReact, 2000); }
    await this.api.json("POST", "/api/v1/direct_v2/threads/broadcast/reaction/", { form: f });
  }
  async delete(chatId: string, messageId: string): Promise<void> {
    await this.api.json("POST", `/api/v1/direct_v2/threads/${encodeURIComponent(chatId)}/items/${encodeURIComponent(messageId)}/delete/`, { form: { _uuid: this.device.uuid } });
    this.emit({ type: "message-update", data: { chatId, messageId, patch: { deleted: true } } });
  }
  async setTyping(chatId: string, typing: boolean): Promise<void> {
    // Typing indicators only exist on the realtime channel; without it this is silently skipped (never an HTTP poll).
    try { if (this.rt?.isOpen) this.rt.publish(TOPICS.sendMessage, { action: "indicate_activity", thread_id: chatId, client_context: clientCtx(), activity_status: typing ? "1" : "0" }); } catch { /* ignore */ }
  }
  async markRead(chatId: string, upToMessageId: string): Promise<void> {
    await this.api.json("POST", `/api/v1/direct_v2/threads/${encodeURIComponent(chatId)}/items/${encodeURIComponent(upToMessageId)}/seen/`, { form: { action: "mark_seen", thread_id: chatId, item_id: upToMessageId, use_unified_inbox: "true", _uuid: this.device.uuid } });
    const t = this.threads.get(chatId); if (t) { t.read_state = 0; }
  }

  private async resolveUser(handle: string): Promise<IgUser> {
    const h = handle.trim().replace(/^@/, "").toLowerCase(); if (!/^[a-z0-9._]{1,30}$/.test(h)) throw new Error("Enter an Instagram username like @name.");
    const r = await this.api.json<any>("GET", `/api/v1/users/search/?q=${encodeURIComponent(h)}&count=5`);
    const u = (r.users ?? []).find((x: IgUser) => (x.username ?? "").toLowerCase() === h); if (!u) throw new Error("No Instagram account with that username was found.");
    this.users.set(String(u.pk), u); return u;
  }
  async startChat(handle: string): Promise<Chat> {
    const u = await this.resolveUser(handle);
    const r = await this.api.json<any>("GET", `/api/v1/direct_v2/threads/get_by_participants/?recipient_users=${encodeURIComponent(JSON.stringify([String(u.pk)]))}&seq_id=${this.iris?.seq_id ?? 0}&limit=1`).catch((e) => { if (e instanceof IgError && e.kind === "not-found") return {}; throw e; });
    const t = r.thread as IgThread | undefined;
    if (!t?.thread_id) // Instagram creates the thread with the first message: hand out a provisional chat that send() resolves
      return { id: `new:${u.pk}`, accountId: this.accountId, provider: "instagram", kind: "dm", name: userLabel(u), provisional: true };
    this.ingest(t, true, false);
    return mapThread(this.threads.get(String(t.thread_id)) ?? t, this.accountId, this.viewer(), this.users, this.requests.has(String(t.thread_id)));
  }
  async acceptRequest(chatId: string): Promise<void> { await this.approveIfRequest(chatId); }
  async declineRequest(chatId: string): Promise<void> {
    await this.api.json("POST", `/api/v1/direct_v2/threads/${encodeURIComponent(chatId)}/decline/`, { form: { _uuid: this.device.uuid } });
    this.requests.delete(chatId); this.threads.delete(chatId); this.emit({ type: "chats-changed", data: {} });
  }
  /** `@Name` spans chosen in the composer become `@username` (what Instagram shows) plus the ids of the mentioned people; only people of this chat. */
  private withMentions(msg: OutgoingMessage): { text: string; ids: string[] } {
    let out = "", at = 0; const ids: string[] = [];
    for (const m of [...(msg.mentions ?? [])].sort((a, b) => a.start - b.start)) {
      const u = this.users.get(m.id); const text = msg.text ?? "";
      if (!u?.username || !/^\d+$/.test(m.id) || m.start < at || text[m.start] !== "@") continue;
      out += text.slice(at, m.start) + "@" + u.username; at = m.start + m.length; if (!ids.includes(m.id)) ids.push(m.id);
    }
    return { text: out + (msg.text ?? "").slice(at), ids };
  }
  private group(chatId: string): IgThread {
    const t = this.threads.get(chatId); if (!t || chatId.startsWith("new:")) throw new Error("Unknown chat.");
    if (!t.is_group) throw new Error("Only group chats have members to manage.");
    return t;
  }
  async addMembers(chatId: string, handles: string[]): Promise<void> {
    const t = this.group(chatId); const ids: string[] = [];
    for (const h of handles) { const id = String((await this.resolveUser(h)).pk); if (!ids.includes(id) && !(t.users ?? []).some((u) => String(u.pk) === id)) ids.push(id); }
    if (!ids.length) return;
    await this.api.json("POST", `/api/v1/direct_v2/threads/${encodeURIComponent(chatId)}/add_user/`, { form: { user_ids: JSON.stringify(ids), _uuid: this.device.uuid } }); // hypothesis: endpoint of the app
    this.dropThread(chatId);
  }
  async removeMember(chatId: string, memberId: string): Promise<void> {
    this.group(chatId); if (!/^\d+$/.test(memberId)) throw new Error("Unknown member.");
    await this.api.json("POST", `/api/v1/direct_v2/threads/${encodeURIComponent(chatId)}/remove_users/`, { form: { user_ids: JSON.stringify([memberId]), _uuid: this.device.uuid } }); // hypothesis; only group admins may
    const t = this.threads.get(chatId); if (t?.users) t.users = t.users.filter((u) => String(u.pk) !== memberId);
    this.emit({ type: "chats-changed", data: { chatId } });
  }
  /** Re-read a thread after a membership change. */
  private dropThread(chatId: string) { void this.fetchThread(chatId).then((t) => { this.threads.set(chatId, { ...this.threads.get(chatId), ...t }); this.emit({ type: "chats-changed", data: { chatId } }); }).catch(() => this.emit({ type: "chats-changed", data: { chatId } })); }
  async blockChat(chatId: string, blocked: boolean): Promise<void> {
    const t = this.threads.get(chatId);
    if (!t || t.is_group || chatId.startsWith("new:")) throw new Error("Only a one-to-one chat can be blocked. In a group, block people from the Instagram app.");
    const other = (t.users ?? []).find((u) => String(u.pk) !== this.viewer()); if (!other) throw new Error("Unknown person.");
    await this.api.json("POST", `/api/v1/friendships/${blocked ? "block" : "unblock"}/${encodeURIComponent(String(other.pk))}/`, { form: { user_id: String(other.pk), _uuid: this.device.uuid } });
    this.emit({ type: "chats-changed", data: { chatId } });
  }
  // Privacy: the one setting the app exposes through a small, stable endpoint pair (private account).
  private async privacyList(): Promise<PrivacySetting[]> {
    const r = await this.api.json<any>("GET", "/api/v1/accounts/current_user/?edit=true");
    return [{ id: "private_account", label: "Private account", description: "Only people you approve can follow you and see your posts. Messages from people who do not follow you arrive as requests either way.", value: r?.user?.is_private ? "private" : "public", options: [{ value: "public", label: "Public" }, { value: "private", label: "Private" }] }];
  }
  async getPrivacy(): Promise<PrivacySetting[]> { return this.privacyList(); }
  async setPrivacy(id: string, value: string): Promise<PrivacySetting[]> {
    if (id !== "private_account" || (value !== "public" && value !== "private")) throw new Error("Unknown privacy setting or value.");
    await this.api.json("POST", `/api/v1/accounts/${value === "private" ? "set_private" : "set_public"}/`, { form: { _uuid: this.device.uuid } });
    const l = await this.privacyList(); l[0].value = value; return l; // the account endpoint may lag behind: report what we just set
  }
  async createGroup(name: string, memberHandles: string[]): Promise<Chat> {
    if (!memberHandles.length) throw new Error("Pick at least one person.");
    const ids: string[] = []; for (const h of memberHandles) ids.push(String((await this.resolveUser(h)).pk));
    const t = await this.api.json<IgThread>("POST", "/api/v1/direct_v2/create_group_thread/", { form: { recipient_users: JSON.stringify(ids), thread_title: name, _uuid: this.device.uuid } });
    if (!t?.thread_id) throw new Error("Instagram did not create the group.");
    this.ingest(t, true, false); this.emit({ type: "chats-changed", data: {} });
    return mapThread(this.threads.get(String(t.thread_id)) ?? t, this.accountId, this.viewer(), this.users);
  }
  async leaveChat(chatId: string): Promise<void> {
    await this.api.json("POST", `/api/v1/direct_v2/threads/${encodeURIComponent(chatId)}/leave/`, { form: { _uuid: this.device.uuid } });
    this.threads.delete(chatId); this.emit({ type: "chats-changed", data: {} });
  }
  async renameChat(chatId: string, name: string): Promise<void> {
    await this.api.json("POST", `/api/v1/direct_v2/threads/${encodeURIComponent(chatId)}/update_title/`, { form: { title: name, _uuid: this.device.uuid } });
    const t = this.threads.get(chatId); if (t) t.thread_title = name; this.emit({ type: "chats-changed", data: { chatId } });
  }
}

const factory: ProviderFactory = {
  name: "instagram", displayName: "Instagram", login: "form", capabilities: CAPABILITIES,
  create: ({ accountId, dataDir }) => new InstagramConnector(accountId, dataDir),
};
export default factory;
