// Mattermost provider: REST API v4 + WebSocket events on Node's fetch and `ws`. See README.md.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import type {
  Capabilities, Chat, Connector, Contact, CoreEvent, HistoryQuery, LoginPrompt, Message, MessagePatch, OutgoingMessage, ProviderFactory, Profile, ProfilePatch, Space,
} from "@unimsg/core";
import { Api, MmError, dbg, normaliseServer } from "./api.js";
import { emojiFromName, emojiToName } from "./emoji.js";
import {
  applyMentions, parseTeamInvite, teamSlug, iso, mapChat, mapPost, mapReactions, mapSpace, otherUserId, parseJson, threadChatId, threadRoot, profileName, userName,
  type MmChannel, type MmFile, type MmMember, type MmPost, type MmReaction, type MmTeam, type MmUser, type PostList,
} from "./map.js";

export const CAPABILITIES: Capabilities = {
  spaces: true, reactions: true, pinMessages: true, edits: true, deletes: true, replies: true, attachments: true, typing: true,
  readReceipts: false, markRead: true, customEmoji: true, // Mattermost has no per-message receipts (see README: the UI gates markRead on this flag)
  startChat: true, createGroup: true, backfill: true, fetchHistory: true, e2ee: false,
  leaveChat: true, manageMembers: true, renameChat: true, mentions: true, createSpace: true, joinSpace: true, leaveSpace: true, block: false, polls: false, location: false, contactCards: false,
  avatars: true, refreshChat: true, sync: true, privacy: false, presence: true,
  profile: { displayName: true, about: true, avatar: true },
};

const SESSION_FILE = "mattermost-session.json";
interface Session { server: string; token: string; userId?: string; viaLogin?: boolean }
interface ClientConfig { [k: string]: string }

const TITLE =
  "Mattermost login. Enter the server (e.g. communicating.tuhh.de) and EITHER your login + password " +
  "(leave the token empty) OR a token. If your organisation uses single sign-on (SAML / GitLab / Shibboleth) the password does not work: " +
  "create a Personal Access Token (Profile > Security > Personal Access Tokens, if your admin allows it) or, after signing in with your browser, copy the " +
  "value of the MMAUTHTOKEN cookie (browser developer tools > Storage/Application > Cookies) and paste it as the token.";

const sleepers = new Set<() => void>();
const sleep = (ms: number) => new Promise<void>((ok) => { const t = setTimeout(done, ms); function done() { clearTimeout(t); sleepers.delete(done); ok(); } sleepers.add(done); });
const wake = () => { for (const f of [...sleepers]) f(); };

class MattermostConnector implements Connector {
  readonly capabilities = CAPABILITIES;
  private emit: (e: CoreEvent) => void = () => {};
  private api?: Api;
  private session?: Session;
  private me?: MmUser;
  private teams = new Map<string, MmTeam>();
  private channels = new Map<string, MmChannel>();
  private chanMembers = new Map<string, MmMember>();
  private users = new Map<string, MmUser>();
  private missingUsers = new Set<string>();
  private previews = new Map<string, string>();
  private posts = new Map<string, MmPost>();
  /** Threads opened as chats of their own: root post id -> channel id. */
  private threads = new Map<string, string>();
  private files = new Map<string, MmFile>();
  private pending = new Set<string>();
  private seen = new Set<string>();
  private typingTimers = new Map<string, NodeJS.Timeout>();
  private fmt = "username";
  private maxFile = 50 * 1024 * 1024;
  private ws?: WebSocket;
  private seq = 0;
  private stopped = true;
  private running = false;
  private highWater = 0;
  private chain: Promise<void> = Promise.resolve();
  private promptN = 0;
  private pendingMfa?: { server: string; loginId: string; password: string };

  private readonly accountId: string; private readonly dataDir: string;
  constructor(accountId: string, dataDir: string) { this.accountId = accountId; this.dataDir = dataDir; }

  // ---------------------------------------------------------------- lifecycle
  async start(emit: (e: CoreEvent) => void): Promise<void> {
    this.emit = emit; this.stopped = false;
    this.session = this.readSession();
    if (!this.session) { this.state("needs-login"); this.prompt(); return; }
    this.state("connecting");
    this.begin();
  }
  // ---------------------------------------------------------------- presence: POST /users/status/ids for the peers of our direct messages, once a minute (one request, at most 200 ids)
  private presenceOn = true; private presenceTimer?: ReturnType<typeof setInterval>; private presenceSeen = new Map<string, string>();
  setPresenceEnabled(on: boolean) { this.presenceOn = on; if (!on) { this.presenceSeen.clear(); } else if (this.api && !this.stopped) void this.pollStatus(); }
  private async pollStatus() {
    const api = this.api, me = this.me?.id; if (!api || !me || this.stopped || !this.presenceOn) return;
    const peers = new Map<string, string[]>(); // user id -> direct channels
    for (const c of this.channels.values()) if (c.type === "D" && !c.delete_at) { const o = otherUserId(c, me); if (o && o !== me) peers.set(o, [...(peers.get(o) ?? []), c.id]); }
    const ids = [...peers.keys()].slice(0, 200); if (!ids.length) return;
    let r: { user_id: string; status: string; last_activity_at?: number }[];
    try { r = await api.json("POST", "/users/status/ids", ids); } catch { return; } // best effort; a failed poll is simply retried
    if (this.stopped || !this.presenceOn || !Array.isArray(r)) return;
    for (const x of r) {
      const online = x.status === "online" || x.status === "away" || x.status === "dnd", la = x.last_activity_at;
      const lastSeen = !online && typeof la === "number" && la > 0 ? new Date(la).toISOString() : undefined;
      const sig = `${online}|${lastSeen ?? ""}`; if (this.presenceSeen.get(x.user_id) === sig) continue; this.presenceSeen.set(x.user_id, sig);
      for (const chatId of peers.get(x.user_id) ?? []) this.emit({ type: "presence", data: { accountId: this.accountId, chatId, contactId: x.user_id, online, ...(lastSeen ? { lastSeen } : {}) } });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true; if (this.presenceTimer) { clearInterval(this.presenceTimer); this.presenceTimer = undefined; }
    for (const t of this.typingTimers.values()) clearTimeout(t);
    this.typingTimers.clear();
    try { this.ws?.terminate(); } catch { /* ignore */ }
    this.ws = undefined;
    wake();
  }
  async logout(): Promise<void> {
    const s = this.session, api = this.api;
    await this.stop();
    this.wipe();
    this.pendingMfa = undefined;
    if (s?.viaLogin && api) {
      try { await api.json("POST", "/users/logout"); } catch { throw new Error("You were signed out locally, but the server did not confirm the logout. You can end the session in Mattermost under Profile > Security > Active Sessions."); }
    }
  }

  private state(state: "connecting" | "needs-login" | "connected" | "disconnected" | "signed-out", detail?: string) {
    this.emit({ type: "account", data: { id: this.accountId, state, ...(detail ? { detail } : {}) } });
  }
  private err(code: string, message: string, fatal = false) { this.emit({ type: "error", data: { id: this.accountId, code, message, fatal } }); }
  private prompt(error?: string, mfa = false) {
    const id = `${mfa ? "mfa" : "login"}-${++this.promptN}`;
    const p: LoginPrompt = mfa
      ? { accountId: this.accountId, promptId: id, kind: "form", title: "Mattermost asks for your two-factor (MFA) code.", fields: [{ name: "mfa", label: "MFA code", type: "code" }], ...(error ? { error } : {}) }
      : { accountId: this.accountId, promptId: id, kind: "form", title: TITLE, ...(error ? { error } : {}), fields: [
        { name: "server", label: "Server", type: "text", placeholder: "communicating.tuhh.de" },
        { name: "login_id", label: "Username or email (password login)", type: "text" },
        { name: "password", label: "Password", type: "password" },
        { name: "token", label: "Access token or MMAUTHTOKEN cookie (instead of password)", type: "password" },
      ] };
    this.emit({ type: "login", data: p });
  }

  // ---------------------------------------------------------------- session
  private readSession(): Session | undefined {
    try {
      const f = join(this.dataDir, SESSION_FILE);
      if (!existsSync(f)) return undefined;
      const s = JSON.parse(readFileSync(f, "utf8")) as Session;
      return s.server && s.token ? s : undefined;
    } catch { return undefined; }
  }
  private saveSession(s: Session) {
    mkdirSync(this.dataDir, { recursive: true });
    const f = join(this.dataDir, SESSION_FILE);
    writeFileSync(f, JSON.stringify(s), { mode: 0o600 });
    chmodSync(f, 0o600);
  }
  private wipe() { this.session = undefined; this.api = undefined; try { rmSync(join(this.dataDir, SESSION_FILE), { force: true }); } catch { /* ignore */ } }

  private needsLogin() {
    if (!this.session) return;
    this.wipe();
    try { this.ws?.terminate(); } catch { /* ignore */ }
    wake();
    this.state("needs-login", "The server no longer accepts the saved session");
    this.prompt("Your Mattermost session has expired or was revoked. Please sign in again.");
  }

  // ---------------------------------------------------------------- login
  private async detect(server: string): Promise<ClientConfig | undefined> {
    try { return await new Api(server).json<ClientConfig>("GET", "/config/client?format=old", undefined, false); } catch { return undefined; }
  }
  private ssoHint(c?: ClientConfig): string {
    const sso = c && (c.EnableSaml === "true" || c.EnableSignUpWithGitLab === "true" || c.EnableSignUpWithOffice365 === "true" || c.EnableSignUpWithGoogle === "true" || c.EnableSignUpWithOpenId === "true");
    const pat = c?.EnableUserAccessTokens === "true";
    return (sso ? "This server uses single sign-on. " : "") +
      (pat ? "Create a Personal Access Token (Profile > Security > Personal Access Tokens) and paste it as the token. " : "Personal access tokens look disabled on this server. ") +
      "Alternatively sign in with your browser and paste the value of the MMAUTHTOKEN cookie as the token.";
  }

  async submitLogin(promptId: string, v: Record<string, string>): Promise<void> {
    if (promptId.startsWith("mfa") && this.pendingMfa) {
      const p = this.pendingMfa;
      const code = (v.mfa ?? "").trim();
      if (!code) throw new Error("Enter the MFA code.");
      return this.passwordLogin(p.server, p.loginId, p.password, code);
    }
    const server = normaliseServer(v.server ?? "");
    const token = (v.token ?? "").trim().replace(/^Bearer\s+/i, "").replace(/^MMAUTHTOKEN=/, "");
    const loginId = (v.login_id ?? "").trim(), password = v.password ?? "";
    if (!token && !(loginId && password)) throw new Error("Enter login name and password, or paste a token.");
    const cfg = await this.detect(server);
    if (token) {
      const api = new Api(server, token);
      let me: MmUser;
      try { me = await api.get<MmUser>("/users/me"); }
      catch (e) {
        if (e instanceof MmError && e.status === 401) throw new Error("The server rejected this token. A personal access token must be enabled by an admin and not revoked; an MMAUTHTOKEN cookie stops working when you sign out in the browser or it expires. " + this.ssoHint(cfg));
        throw e;
      }
      return this.finish({ server, token, userId: me.id });
    }
    if (cfg && cfg.EnableSignUpWithEmail !== "true" && cfg.EnableSignInWithEmail !== "true" && cfg.EnableSignInWithUsername !== "true" && cfg.EnableLdap !== "true")
      throw new Error("This server does not allow password login. " + this.ssoHint(cfg));
    return this.passwordLogin(server, loginId, password, undefined, cfg);
  }

  private async passwordLogin(server: string, loginId: string, password: string, mfa?: string, cfg?: ClientConfig): Promise<void> {
    const api = new Api(server);
    try {
      const res = await api.raw("POST", "/users/login", { json: { login_id: loginId, password, ...(mfa ? { token: mfa } : {}) }, auth: false });
      const token = res.headers.get("token");
      const me = (await res.json()) as MmUser;
      if (!token) throw new Error("The server accepted the login but sent no session token. Use a personal access token instead.");
      this.pendingMfa = undefined;
      return this.finish({ server, token, userId: me.id, viaLogin: true });
    } catch (e) {
      if (!(e instanceof MmError)) throw e;
      if (/mfa/i.test(e.serverId ?? "")) {
        this.pendingMfa = { server, loginId, password };
        this.prompt(mfa ? "That MFA code was not accepted. Try the next code." : undefined, true);
        return;
      }
      this.pendingMfa = undefined;
      if (e.serverId === "api.user.login.use_auth_service.app_error") throw new Error("This account signs in through single sign-on, so a password does not work. " + this.ssoHint(cfg ?? await this.detect(server)));
      if (e.status === 401) throw new Error("Wrong login name or password. " + (cfg?.EnableSaml === "true" ? this.ssoHint(cfg) : ""));
      throw e;
    }
  }

  private finish(s: Session) {
    this.saveSession(s);
    this.session = s;
    this.state("connecting");
    this.begin();
  }

  // ---------------------------------------------------------------- run loop
  private begin() {
    if (this.running) return;
    this.running = true; this.stopped = false;
    void this.run().finally(() => { this.running = false; });
  }

  private async run() {
    let attempt = 0, first = true;
    while (!this.stopped && this.session) {
      const s = this.session;
      const api = (this.api = new Api(s.server, s.token));
      api.onUnauthorized = () => { if (this.api === api) this.needsLogin(); };
      try {
        const prevHigh = first ? 0 : this.highWater;
        await this.bootstrap(api);
        void this.pollStatus(); if (!this.presenceTimer) this.presenceTimer = setInterval(() => { void this.pollStatus(); }, 60_000);
        if (!first && prevHigh) await this.catchUp(prevHigh);
        first = false;
        const connected = await this.connectWs(s);
        if (connected) attempt = 0;
      } catch (e) {
        if (this.stopped || !this.session) return;
        if (e instanceof MmError && e.status === 401) { this.needsLogin(); return; }
        // A server we could not reach (status 0: DNS, no route, timeout) is retried right below, and on a phone that just woke
        // up the first try regularly lands before the network is back. Telling the user at once turned every app start into an
        // error popup while the account went green seconds later, so the first attempts stay a state, not a message.
        const transient = e instanceof MmError && e.status === 0;
        if (!transient || attempt >= 3) this.err("connect", e instanceof MmError ? e.message : "Connection problem; retrying.");
      }
      if (this.stopped || !this.session) return;
      this.state("disconnected");
      const delay = Math.min(60000, 1000 * 2 ** Math.min(attempt++, 6)) * (0.5 + Math.random() * 0.5);
      dbg(`reconnect in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }

  private connectWs(s: Session): Promise<boolean> {
    return new Promise((resolve) => {
      let hello = false;
      const origin = new URL(s.server).origin;
      const ws = new WebSocket(s.server.replace(/^http/, "ws") + "/api/v4/websocket", { headers: { Authorization: `Bearer ${s.token}`, Origin: origin }, handshakeTimeout: 15000 });
      this.ws = ws;
      let alive = true;
      const ping = setInterval(() => { if (!alive) return ws.terminate(); alive = false; try { ws.ping(); } catch { /* closing */ } }, 30000);
      const helloTimer = setTimeout(() => { if (!hello) ws.terminate(); }, 20000);
      ws.on("pong", () => { alive = true; });
      ws.on("open", () => { try { ws.send(JSON.stringify({ seq: ++this.seq, action: "authentication_challenge", data: { token: s.token } })); } catch { /* closing */ } });
      ws.on("message", (raw) => {
        alive = true;
        const ev = parseJson<WsEvent>(raw.toString());
        if (!ev) return;
        if (ev.event === "hello") { hello = true; this.state("connected"); dbg("ws hello"); return; }
        if (!ev.event) return;
        this.chain = this.chain.then(() => this.onEvent(ev)).catch(() => this.err("event", `Could not handle event "${String(ev.event)}".`));
      });
      ws.on("unexpected-response", (_req, res) => { if (res.statusCode === 401) this.needsLogin(); res.resume(); });
      ws.on("error", () => { /* close follows */ });
      ws.on("close", () => { clearInterval(ping); clearTimeout(helloTimer); if (this.ws === ws) this.ws = undefined; resolve(hello); });
    });
  }

  // ---------------------------------------------------------------- loading
  private cacheUser(u: MmUser) {
    this.users.delete(u.id); this.users.set(u.id, u);
    if (this.users.size > 5000) { const k = this.users.keys().next().value; if (k && k !== this.me?.id) this.users.delete(k); }
  }
  private async ensureUsers(ids: string[]) {
    const need = [...new Set(ids)].filter((i) => i && !this.users.has(i) && !this.missingUsers.has(i));
    for (let i = 0; i < need.length; i += 200) {
      const chunk = need.slice(i, i + 200);
      const got = await this.api!.json<MmUser[]>("POST", "/users/ids", chunk);
      for (const u of got) this.cacheUser(u);
      for (const id of chunk) if (!this.users.has(id)) { this.missingUsers.add(id); if (this.missingUsers.size > 5000) this.missingUsers.clear(); }
    }
  }
  private uname = (id: string) => userName(this.users.get(id), this.fmt);

  private async bootstrap(api: Api) {
    const ping = await api.raw("GET", "/system/ping");
    await ping.arrayBuffer().catch(() => {});
    const ver = ping.headers.get("x-version-id") ?? "";
    const major = parseInt(ver, 10);
    if (Number.isFinite(major) && major < 6) this.err("version", `Mattermost server version ${major}.x is older than the supported 6.x-9.x; some features may not work.`);
    dbg(`server major=${Number.isFinite(major) ? major : "?"}`);
    this.me = await api.get<MmUser>("/users/me");
    this.cacheUser(this.me);
    if (this.session && this.session.userId !== this.me.id) { this.session.userId = this.me.id; this.saveSession(this.session); }
    try {
      const c = await api.json<ClientConfig>("GET", "/config/client?format=old");
      this.fmt = c.TeammateNameDisplay || "username";
      const mf = Number(c.MaxFileSize); if (mf > 0) this.maxFile = mf;
    } catch (e) { if (e instanceof MmError && e.status === 401) throw e; }
    await this.loadNameFormat();
    await this.loadAll();
    dbg(`loaded teams=${this.teams.size} channels=${this.channels.size}`);
  }
  private async loadNameFormat() {
    try {
      const prefs = await this.api!.get<{ name: string; value: string }[]>("/users/me/preferences/display_settings");
      const f = prefs.find((p) => p.name === "name_format")?.value;
      if (f) this.fmt = f;
    } catch { /* default */ }
  }

  private async loadAll() {
    const api = this.api!;
    const teams = await api.get<MmTeam[]>("/users/me/teams");
    this.teams = new Map(teams.filter((t) => !t.delete_at).map((t) => [t.id, t]));
    let chans: MmChannel[]; let mems: MmMember[] = [];
    try { chans = await api.get<MmChannel[]>("/users/me/channels"); }
    catch (e) {
      if (!(e instanceof MmError) || e.status !== 404) throw e;
      const by = new Map<string, MmChannel>();
      for (const t of this.teams.keys()) for (const c of await api.get<MmChannel[]>(`/users/me/teams/${t}/channels`)) by.set(c.id, c);
      chans = [...by.values()];
    }
    try {
      const seen = new Set<string>();
      for (let page = 0; page < 50; page++) {
        const got = await api.get<MmMember[]>(`/users/me/channel_members?page=${page}&per_page=200`);
        const fresh = got.filter((m) => !seen.has(m.channel_id));
        fresh.forEach((m) => seen.add(m.channel_id)); mems.push(...fresh);
        if (got.length < 200 || !fresh.length) break;
      }
    } catch (e) {
      if (!(e instanceof MmError) || e.status !== 404) throw e;
      for (const t of this.teams.keys()) mems.push(...(await api.get<MmMember[]>(`/users/me/teams/${t}/channels/members`)));
    }
    this.channels = new Map(chans.filter((c) => !c.delete_at).map((c) => [c.id, c]));
    this.chanMembers = new Map(mems.map((m) => [m.channel_id, m]));
    await this.ensureUsers([this.me!.id, ...[...this.channels.values()].map((c) => otherUserId(c, this.me!.id)).filter((x): x is string => !!x)]);
    const prev = this.highWater;
    this.highWater = Math.max(prev, ...[...this.channels.values()].map((c) => c.last_post_at ?? 0));
    // previews for the most recently active chats only (one request each)
    const recent = [...this.channels.values()].filter((c) => !this.previews.has(c.id)).sort((a, b) => (b.last_post_at ?? 0) - (a.last_post_at ?? 0)).slice(0, 30);
    await Promise.all(recent.map(async (c) => {
      try {
        const l = await api.get<PostList>(`/channels/${c.id}/posts?per_page=1`);
        const p = l.posts[l.order[0]];
        if (p) { this.setPreview(p); this.cachePost(p); }
      } catch (e) { if (e instanceof MmError && e.status === 401) throw e; }
    }));
  }

  private cachePost(p: MmPost) {
    this.posts.delete(p.id); this.posts.set(p.id, p);
    if (this.posts.size > 3000) this.posts.delete(this.posts.keys().next().value!);
    for (const f of p.metadata?.files ?? []) this.files.set(f.id, f);
    if (this.files.size > 5000) this.files.delete(this.files.keys().next().value!);
    this.highWater = Math.max(this.highWater, p.create_at, p.edit_at ?? 0, p.delete_at ?? 0);
  }
  private setPreview(p: MmPost) {
    if (p.type?.startsWith("system_")) return;
    const t = (p.message || (p.metadata?.files?.length || p.file_ids?.length ? "[attachment]" : "")).replace(/\s+/g, " ").trim();
    if (t) this.previews.set(p.channel_id, t.length > 120 ? t.slice(0, 117) + "..." : t);
  }

  private chatOf(c: MmChannel): Chat {
    return mapChat(c, { accountId: this.accountId, me: this.me!.id, fmt: this.fmt, user: (id) => this.users.get(id), member: this.chanMembers.get(c.id), preview: this.previews.get(c.id) });
  }
  private msgCtx(extraFiles?: MmFile[]) {
    return { me: this.me!.id, accountId: this.accountId, name: this.uname, post: (id: string) => this.posts.get(id), extraFiles };
  }

  private async catchUp(since: number) {
    const api = this.api!;
    let n = 0;
    for (const c of this.channels.values()) {
      if ((c.last_post_at ?? 0) <= since) continue;
      const l = await api.get<PostList>(`/channels/${c.id}/posts?since=${since}`);
      const ps = Object.values(l.posts).sort((a, b) => a.create_at - b.create_at);
      await this.ensureUsers(ps.map((p) => p.user_id));
      for (const p of ps) {
        const known = this.seen.has(p.id) || this.posts.has(p.id);
        if (p.delete_at) { this.updateAll(p, { deleted: true }); this.cachePost(p); continue; }
        this.cachePost(p); this.setPreview(p);
        if (p.create_at > since && !known) {
          this.rememberSeen(p.id);
          if (p.root_id && this.noteThread(p.root_id, p.channel_id)) this.emit({ type: "chats-changed", data: { chatId: threadChatId(p.root_id) } });
          const m = p.root_id ? undefined : mapPost(p, this.msgCtx()); if (m) this.emit({ type: "message", data: m }); // a reply: only in its thread
          if (m || p.root_id) n++;
          for (const t of this.threadsOf(p)) { const tm = mapPost(p, { ...this.msgCtx(), inThread: t }); if (tm) this.emit({ type: "message", data: tm }); }
        }
        else this.updateAll(p, { text: p.message, ...(p.edit_at ? { editedAt: iso(p.edit_at) } : {}), reactions: mapReactions(p.metadata?.reactions, this.me!.id) ?? [] });
      }
    }
    dbg(`catch-up delivered ${n} messages`);
    this.emit({ type: "chats-changed", data: {} });
  }
  private rememberSeen(id: string) { this.seen.add(id); if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!); }

  // ---------------------------------------------------------------- websocket events
  private async loadChannel(id: string): Promise<MmChannel | undefined> {
    try {
      const api = this.api!;
      const c = await api.get<MmChannel>(`/channels/${id}`);
      const m = await api.get<MmMember>(`/channels/${id}/members/me`);
      this.channels.set(c.id, c); this.chanMembers.set(c.id, m);
      const o = otherUserId(c, this.me!.id); if (o) await this.ensureUsers([o]);
      return c;
    } catch (e) { if (e instanceof MmError && e.status === 401) throw e; return undefined; }
  }

  private async onEvent(ev: WsEvent) {
    const d = ev.data ?? {}, b = ev.broadcast ?? {};
    const me = this.me!.id;
    switch (ev.event) {
      case "posted": {
        const p = parseJson<MmPost>(d.post); if (!p) return;
        this.highWater = Math.max(this.highWater, p.create_at);
        if ((p.pending_post_id && this.pending.has(p.pending_post_id)) || this.seen.has(p.id)) { this.cachePost(p); return; }
        this.rememberSeen(p.id);
        let c = this.channels.get(p.channel_id);
        if (!c) { c = await this.loadChannel(p.channel_id); if (c) this.emit({ type: "chats-changed", data: { chatId: c.id } }); }
        if (c) { c.total_msg_count = (c.total_msg_count ?? 0) + (p.root_id ? 0 : 1); c.last_post_at = p.create_at; if (p.user_id === me) { const m = this.chanMembers.get(c.id); if (m) m.msg_count = c.total_msg_count; } }
        await this.ensureUsers([p.user_id]);
        if (p.root_id && !this.posts.has(p.root_id)) { try { this.cachePost(await this.api!.get<MmPost>(`/posts/${p.root_id}`)); } catch { /* preview only */ } }
        this.cachePost(p); this.setPreview(p);
        this.clearTyping(p.channel_id, p.user_id); if (p.root_id) this.clearTyping(threadChatId(p.root_id), p.user_id);
        // a reply belongs to its thread only (listed under the chat from now on), not to the chat itself
        if (p.root_id && this.noteThread(p.root_id, p.channel_id)) this.emit({ type: "chats-changed", data: { chatId: threadChatId(p.root_id) } });
        const m = p.root_id ? undefined : mapPost(p, this.msgCtx());
        if (m) this.emit({ type: "message", data: m });
        for (const t of this.threadsOf(p)) { const tm = mapPost(p, { ...this.msgCtx(), inThread: t }); if (tm) this.emit({ type: "message", data: tm }); }
        if (p.root_id) this.bumpReplies(p.root_id);
        return;
      }
      case "post_edited": {
        const p = parseJson<MmPost>(d.post); if (!p) return;
        const old = this.posts.get(p.id);
        if (old && !p.metadata) p.metadata = old.metadata;
        this.cachePost(p); this.setPreview(p);
        const pinChanged = !!old && !!old.is_pinned !== !!p.is_pinned, textSame = !!old && old.message === p.message && (old.edit_at ?? 0) === (p.edit_at ?? 0);
        if (pinChanged || (!old && p.is_pinned)) this.updateAll(p, p.is_pinned ? { pinned: true, pinnedAt: iso(p.update_at || Date.now()) } : { pinned: false });
        if (pinChanged && textSame) return; // pinning bumps update_at: that is not an edit
        this.updateAll(p, { text: p.message, editedAt: iso(p.edit_at || p.update_at || Date.now()) });
        return;
      }
      case "post_deleted": {
        const p = parseJson<MmPost>(d.post); if (!p) return;
        this.posts.delete(p.id);
        this.updateAll({ ...p, channel_id: p.channel_id || b.channel_id }, { deleted: true });
        return;
      }
      case "reaction_added": case "reaction_removed": {
        const r = parseJson<MmReaction>(d.reaction); if (!r) return;
        let post = this.posts.get(r.post_id);
        if (!post) { try { post = await this.api!.get<MmPost>(`/posts/${r.post_id}`); } catch { return; } }
        const list = (post.metadata?.reactions ?? []).filter((x) => !(x.user_id === r.user_id && x.emoji_name === r.emoji_name));
        if (ev.event === "reaction_added") list.push(r);
        post.metadata = { ...post.metadata, reactions: list };
        this.cachePost(post);
        this.updateAll(post, { reactions: mapReactions(list, me) ?? [] });
        return;
      }
      case "typing": {
        const uid = d.user_id as string | undefined, cid = b.channel_id as string | undefined;
        if (!uid || !cid || uid === me) return;
        const at = d.parent_id ? (this.threads.has(String(d.parent_id)) ? threadChatId(String(d.parent_id)) : "") : cid; // typing in a thread shows only in that thread's chat
        if (!at) return;
        this.emit({ type: "typing", data: { chatId: at, senderId: uid, typing: true } });
        const k = at + "/" + uid; clearTimeout(this.typingTimers.get(k));
        this.typingTimers.set(k, setTimeout(() => this.clearTyping(at, uid), 6000));
        return;
      }
      case "channel_viewed": {
        const cid = d.channel_id as string; const c = this.channels.get(cid), m = this.chanMembers.get(cid);
        if (c && m) { m.msg_count = c.total_msg_count ?? 0; m.mention_count = 0; }
        this.emit({ type: "chats-changed", data: { chatId: cid } });
        return;
      }
      case "multiple_channels_viewed": {
        for (const cid of Object.keys((d.channel_times as Record<string, number>) ?? {})) { const c = this.channels.get(cid), m = this.chanMembers.get(cid); if (c && m) { m.msg_count = c.total_msg_count ?? 0; m.mention_count = 0; } }
        this.emit({ type: "chats-changed", data: {} });
        return;
      }
      case "channel_created": case "direct_added": case "group_added": {
        const cid = (d.channel_id as string) || (b.channel_id as string);
        if (cid && (await this.loadChannel(cid))) this.emit({ type: "chats-changed", data: { chatId: cid } });
        return;
      }
      case "channel_updated": {
        const c = parseJson<MmChannel>(d.channel); if (!c) return;
        const old = this.channels.get(c.id);
        if (old) this.channels.set(c.id, { ...old, ...c, total_msg_count: c.total_msg_count ?? old.total_msg_count });
        this.emit({ type: "chats-changed", data: { chatId: c.id } });
        return;
      }
      case "channel_deleted": {
        const cid = d.channel_id as string; this.channels.delete(cid); this.chanMembers.delete(cid);
        this.emit({ type: "chats-changed", data: {} });
        return;
      }
      case "user_added": {
        if (d.user_id === me) { const cid = b.channel_id as string; if (cid && (await this.loadChannel(cid))) this.emit({ type: "chats-changed", data: { chatId: cid } }); }
        return;
      }
      case "user_removed": {
        if (b.user_id === me || d.user_id === me) { const cid = (d.channel_id as string) || (b.channel_id as string); if (cid) { this.channels.delete(cid); this.chanMembers.delete(cid); } this.emit({ type: "chats-changed", data: {} }); }
        return;
      }
      case "user_updated": {
        const u = parseJson<MmUser>(d.user); if (u?.id && this.users.has(u.id)) { this.cacheUser({ ...this.users.get(u.id)!, ...u }); this.emit({ type: "chats-changed", data: {} }); }
        return;
      }
      case "preferences_changed": {
        const old = this.fmt; await this.loadNameFormat();
        if (old !== this.fmt) this.emit({ type: "chats-changed", data: {} });
        return;
      }
      case "added_to_team": case "leave_team": case "update_team": case "delete_team": case "restore_team": {
        await this.loadAll();
        this.emit({ type: "spaces-changed", data: {} }); this.emit({ type: "chats-changed", data: {} });
        return;
      }
      default: return; // hello, status_change, new_user, ...: not exposed
    }
  }
  private clearTyping(chatId: string, uid: string) {
    const k = chatId + "/" + uid; const t = this.typingTimers.get(k);
    if (!t) return;
    clearTimeout(t); this.typingTimers.delete(k);
    this.emit({ type: "typing", data: { chatId, senderId: uid, typing: false } });
  }

  // ---------------------------------------------------------------- read
  private ready(): Api { if (!this.api || !this.me) throw new Error("Not connected to Mattermost yet."); return this.api; }

  async spaces(): Promise<Space[]> { this.ready(); return [...this.teams.values()].map((t) => ({ ...mapSpace(t, this.accountId), ...(t.last_team_icon_update ? { avatarRev: String(t.last_team_icon_update) } : {}) })); }
  async chats(): Promise<Chat[]> {
    this.ready(); // avatarRev = the other person's last_picture_update (Mattermost bumps it on every change)
    const list = [...this.channels.values()].map((c) => { const uid = otherUserId(c, this.me!.id), rev = uid ? this.users.get(uid)?.last_picture_update : undefined; return rev ? { ...this.chatOf(c), avatarRev: String(rev) } : this.chatOf(c); });
    for (const [root, cid] of this.threads) { const t = this.threadChat(root, cid); if (t) list.push(t); }
    return list;
  }

  // ---------------------------------------------------------------- threads (a root post and its replies, opened as a chat)
  private threadChat(root: string, cid: string): Chat | undefined {
    const c = this.channels.get(cid); if (!c) return undefined;
    const p = this.posts.get(root), parent = this.chatOf(c);
    const t = (p?.message ?? "").replace(/\s+/g, " ").trim();
    const chat: Chat = { id: threadChatId(root), parentId: cid, accountId: this.accountId, provider: "mattermost", kind: parent.kind, name: t ? (t.length > 60 ? t.slice(0, 57) + "..." : t) : "Thread", unread: 0, description: `Thread in ${parent.kind === "channel" ? "~" : ""}${parent.name}` };
    if (parent.spaceId) chat.spaceId = parent.spaceId;
    if (p) chat.lastMessageAt = iso(Math.max(p.create_at, (p as any).last_reply_at ?? 0));
    if (c.delete_at) chat.readOnly = true;
    return chat;
  }
  private async rootPost(root: string): Promise<MmPost> {
    let p = this.posts.get(root);
    if (!p) { p = await this.forbid("open this thread", () => this.ready().get<MmPost>(`/posts/${root}`)); this.cachePost(p); }
    return p;
  }
  /** The channel a chat id posts to, and the thread root for a thread chat. */
  private async target(chatId: string): Promise<{ channel: string; root?: string }> {
    const root = threadRoot(chatId);
    if (!root) return { channel: chatId };
    return { channel: this.threads.get(root) ?? (await this.rootPost(root)).channel_id, root };
  }
  /** A thread of a chat became known (a reply arrived, or its root has replies): true when it is new, so the list should be refreshed. */
  private noteThread(root: string, cid: string): boolean { if (this.threads.has(root)) return false; this.threads.set(root, cid); return true; }
  /** Thread chats a post also shows in (its own thread, once known). */
  private threadsOf(p: Pick<MmPost, "id" | "root_id">): string[] {
    const root = p.root_id || p.id;
    return this.threads.has(root) ? [threadChatId(root)] : [];
  }
  async openThread(threadId: string): Promise<Chat> {
    this.ready();
    const root = threadRoot(threadId); if (!root) throw new Error("Unknown thread.");
    let p = await this.rootPost(root);
    if (p.root_id) p = await this.rootPost(p.root_id); // a reply's id: open the thread it belongs to
    if (p.delete_at) throw new Error("This thread was deleted.");
    if (!this.channels.has(p.channel_id) && !(await this.loadChannel(p.channel_id))) throw new Error("You can't see this thread.");
    this.threads.set(p.id, p.channel_id);
    await this.ensureUsers([p.user_id]);
    return this.threadChat(p.id, p.channel_id)!;
  }
  private async threadHistory(root: string, q: HistoryQuery): Promise<Message[]> {
    const api = this.ready(), limit = Math.max(1, Math.min(200, q.limit || 50));
    const l = await this.forbid("read this thread", () => api.get<PostList>(`/posts/${root}/thread`));
    let ps = Object.values(l.posts ?? {}).filter((p) => p.id === root || p.root_id === root).sort((a, b) => a.create_at - b.create_at);
    if (ps[0]) this.threads.set(root, ps[0].channel_id);
    if (q.beforeMessageId) { const i = ps.findIndex((p) => p.id === q.beforeMessageId); ps = i < 0 ? [] : ps.slice(0, i); }
    ps = ps.slice(-limit);
    await this.ensureUsers(ps.map((p) => p.user_id));
    for (const p of ps) this.cachePost(p);
    const ctx = { ...this.msgCtx(), inThread: threadChatId(root) };
    return ps.map((p) => mapPost(p, ctx)).filter((m): m is Message => !!m);
  }

  async history(chatId: string, q: HistoryQuery): Promise<Message[]> {
    const api = this.ready();
    const root = threadRoot(chatId); if (root) return this.threadHistory(root, q);
    const limit = Math.max(1, Math.min(200, q.limit || 50));
    // collapsed threads: the chat holds the root posts only, a thread's replies are in its own chat (listed under this one)
    const l = await api.get<PostList>(`/channels/${chatId}/posts?per_page=${limit}&collapsedThreads=true${q.beforeMessageId ? `&before=${encodeURIComponent(q.beforeMessageId)}` : ""}`);
    const ps = l.order.map((id) => l.posts[id]).filter((p): p is MmPost => !!p && !p.root_id);
    let found = false; for (const p of ps) if (p.reply_count && !p.delete_at && this.noteThread(p.id, p.channel_id)) found = true;
    if (found) this.emit({ type: "chats-changed", data: {} });
    await this.ensureUsers(ps.map((p) => p.user_id));
    for (const p of Object.values(l.posts)) this.cachePost(p);
    const missing = [...new Set(ps.map((p) => p.root_id).filter((r): r is string => !!r && !this.posts.has(r)))].slice(0, 10);
    await Promise.all(missing.map(async (id) => { try { this.cachePost(await api.get<MmPost>(`/posts/${id}`)); } catch { /* preview only */ } }));
    await this.ensureUsers([...missing].map((id) => this.posts.get(id)?.user_id ?? ""));
    const ctx = this.msgCtx();
    return ps.reverse().map((p) => mapPost(p, ctx)).filter((m): m is Message => !!m);
  }

  async members(chatId: string): Promise<Contact[]> {
    const api = this.ready();
    chatId = (await this.target(chatId)).channel;
    const ids: string[] = [];
    for (let page = 0; page < 5; page++) {
      const got = await api.get<{ user_id: string }[]>(`/channels/${chatId}/members?page=${page}&per_page=200`);
      ids.push(...got.map((m) => m.user_id));
      if (got.length < 200) break;
    }
    await this.ensureUsers(ids);
    return ids.map((id) => { const u = this.users.get(id); return { id, name: userName(u, this.fmt), ...(u ? { handle: "@" + u.username } : {}) }; });
  }

  async downloadAttachment(_chatId: string, _messageId: string, attachmentId: string) {
    const api = this.ready();
    let info = this.files.get(attachmentId);
    if (!info) { try { info = await api.get<MmFile>(`/files/${attachmentId}/info`); } catch { /* name optional */ } }
    const r = await api.bytes(`/files/${attachmentId}`);
    return { data: r.data, mime: info?.mime_type || r.mime, ...(info?.name ? { name: info.name } : {}) };
  }

  async avatar(t: { kind: "chat" | "space" | "contact" | "emoji"; id: string }) {
    const api = this.ready();
    try {
      if (t.kind === "emoji") { // custom emoji (often animated GIFs): look the id up by name, then fetch the image
        if (!/^[A-Za-z0-9_+-]{1,64}$/.test(t.id)) return undefined;
        const e = await api.get<{ id: string }>(`/emoji/name/${encodeURIComponent(t.id)}`);
        return await api.bytes(`/emoji/${e.id}/image`);
      }
      if (t.kind === "space") {
        const team = this.teams.get(t.id);
        if (!team?.last_team_icon_update) return undefined;
        return await api.bytes(`/teams/${t.id}/image?_=${team.last_team_icon_update}`);
      }
      let uid = t.id;
      if (t.kind === "chat") { const c = this.channels.get(t.id); uid = (c && otherUserId(c, this.me!.id)) || ""; }
      if (!uid) return undefined;
      await this.ensureUsers([uid]);
      const u = this.users.get(uid);
      if (!u?.last_picture_update) return undefined; // default generated picture: let the UI draw its own
      return await api.bytes(`/users/${uid}/image?_=${u.last_picture_update}`);
    } catch (e) { if (e instanceof MmError && e.status !== 401) return undefined; throw e; }
  }

  // ---------------------------------------------------------------- write
  private async rootOf(messageId: string): Promise<string> {
    let p = this.posts.get(messageId);
    if (!p) { p = await this.ready().get<MmPost>(`/posts/${messageId}`); this.cachePost(p); }
    return p.root_id || p.id;
  }

  async send(chatId: string, msg: OutgoingMessage): Promise<Message> {
    const api = this.ready();
    const { channel, root } = await this.target(chatId);
    const asked = chatId; chatId = channel;
    const c = this.channels.get(chatId);
    if (c?.delete_at) throw new Error("This channel is archived; you cannot post in it.");
    const infos: MmFile[] = [];
    for (const a of msg.attachments ?? []) {
      if (a.data.length > this.maxFile) throw new Error(`The file is too large: this server accepts at most ${Math.floor(this.maxFile / 1048576)} MB.`);
      const form = new FormData();
      form.append("channel_id", chatId);
      form.append("files", new Blob([a.data as BlobPart], { type: a.mime }), a.name || "file");
      const up = await (await api.raw("POST", `/files?channel_id=${chatId}`, { form, timeoutMs: 300000 })).json() as { file_infos: MmFile[] };
      infos.push(...up.file_infos);
    }
    const pendingId = `${this.me!.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    this.pending.add(pendingId); if (this.pending.size > 500) this.pending.delete(this.pending.values().next().value!);
    if (msg.mentions?.length) await this.ensureUsers(msg.mentions.map((m) => m.id));
    // Mattermost mentions are plain "@username" text (the server notifies and highlights them)
    const text = msg.mentions?.length ? applyMentions(msg.text, msg.mentions, (id) => this.users.get(id)?.username) : msg.text;
    const body: Record<string, unknown> = { channel_id: chatId, message: text, pending_post_id: pendingId };
    if (root) body.root_id = root;
    else if (msg.replyToMessageId) body.root_id = await this.rootOf(msg.replyToMessageId);
    if (infos.length) body.file_ids = infos.map((f) => f.id);
    const p = await api.json<MmPost>("POST", "/posts", body);
    if (p.root_id && this.noteThread(p.root_id, p.channel_id)) this.emit({ type: "chats-changed", data: { chatId: threadChatId(p.root_id) } }); // a reply from the chat itself starts / joins its thread
    this.rememberSeen(p.id); this.cachePost(p); this.setPreview(p);
    if (c) { c.last_post_at = p.create_at; c.total_msg_count = (c.total_msg_count ?? 0) + (p.root_id ? 0 : 1); const m = this.chanMembers.get(c.id); if (m) m.msg_count = c.total_msg_count; }
    for (const f of infos) this.files.set(f.id, f);
    await this.ensureUsers(p.root_id ? [p.root_id && this.posts.get(p.root_id)?.user_id || ""] : []);
    // the server's echo is skipped (rememberSeen): the other views of this post (channel / open thread) get it from here
    const copies = [...(p.root_id ? [] : [chatId]), ...this.threadsOf(p)].filter((v) => v !== asked); // a reply's only view is its thread
    for (const v of copies) { const m = mapPost(p, { ...this.msgCtx(infos), ...(threadRoot(v) ? { inThread: v } : {}) }); if (m) this.emit({ type: "message", data: m }); }
    if (p.root_id) this.bumpReplies(p.root_id);
    return mapPost(p, { ...this.msgCtx(infos), ...(root ? { inThread: asked } : {}) })!;
  }

  /** A change to a post, for the channel and an open thread it shows in. */
  private updateAll(p: MmPost, patch: MessagePatch) {
    for (const chatId of [...(p.root_id ? [] : [p.channel_id]), ...this.threadsOf(p)]) this.emit({ type: "message-update", data: { chatId, messageId: p.id, patch } });
  }
  /** A reply arrived: the root's "N replies" link counts it. */
  private bumpReplies(root: string) {
    const r = this.posts.get(root); if (!r) return;
    r.reply_count = (r.reply_count ?? 0) + 1;
    this.emit({ type: "message-update", data: { chatId: r.channel_id, messageId: r.id, patch: { thread: { id: threadChatId(r.id), count: r.reply_count } } } });
  }

  async react(_chatId: string, messageId: string, emoji: string | null) {
    const api = this.ready(), me = this.me!.id;
    if (emoji === null) {
      // the UI sends null for "remove my reaction" without saying which one: remove all of mine on this post
      const post = await api.get<MmPost>(`/posts/${messageId}`);
      for (const r of (post.metadata?.reactions ?? []).filter((x) => x.user_id === me))
        await api.json("DELETE", `/users/${me}/posts/${messageId}/reactions/${encodeURIComponent(r.emoji_name)}`);
      return;
    }
    const name = emojiToName(emoji);
    if (!name) throw new Error("This emoji has no Mattermost equivalent in UniChat's table. Try a common one such as 👍 ❤️ 😂 🎉.");
    await api.json("POST", "/reactions", { user_id: me, post_id: messageId, emoji_name: name, create_at: 0 });
  }
  /** POST /posts/{id}/pin and /unpin (needs permission to edit others' posts in channels where that is restricted). The server echoes post_edited with is_pinned. */
  async pin(chatId: string, messageId: string, pinned: boolean) {
    await this.ready().json("POST", `/posts/${messageId}/${pinned ? "pin" : "unpin"}`);
    const cached = this.posts.get(messageId); if (cached) this.cachePost({ ...cached, is_pinned: pinned });
    const patch = pinned ? { pinned: true, pinnedAt: new Date().toISOString(), pinnedBy: this.me?.id } : { pinned: false };
    const p = this.posts.get(messageId);
    if (p) this.updateAll(p, patch); else this.emit({ type: "message-update", data: { chatId, messageId, patch } });
  }
  /** GET /channels/{id}/pinned: the channel's pinned posts, newest first. */
  async pins(chatId: string): Promise<Message[]> {
    chatId = (await this.target(chatId)).channel;
    const list = await this.ready().get<PostList>(`/channels/${chatId}/pinned`);
    const ps = Object.values(list.posts ?? {}).filter((p) => p.channel_id === chatId && !p.delete_at).sort((a, b) => b.create_at - a.create_at);
    await this.ensureUsers(ps.map((p) => p.user_id));
    for (const p of ps) { p.is_pinned = true; this.cachePost(p); }
    return ps.map((p) => mapPost(p, this.msgCtx())).filter((m): m is Message => !!m);
  }
  async edit(_chatId: string, messageId: string, newText: string) { await this.ready().json("PUT", `/posts/${messageId}/patch`, { message: newText }); }
  async delete(_chatId: string, messageId: string) { await this.ready().json("DELETE", `/posts/${messageId}`); }
  async setTyping(chatId: string, typing: boolean) {
    if (!typing || this.ws?.readyState !== WebSocket.OPEN) return;
    const root = threadRoot(chatId), channel = root ? this.threads.get(root) : chatId; if (!channel) return;
    this.ws.send(JSON.stringify({ seq: ++this.seq, action: "user_typing", data: { channel_id: channel, parent_id: root ?? "" } }));
  }
  async markRead(chatId: string, _upTo: string) {
    if (threadRoot(chatId)) return; // a thread has no read state of its own here (its replies count in the channel)
    await this.ready().json("POST", "/channels/members/me/view", { channel_id: chatId });
    const c = this.channels.get(chatId), m = this.chanMembers.get(chatId);
    if (c && m) { m.msg_count = c.total_msg_count ?? 0; m.mention_count = 0; }
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  private async resolveUser(handle: string): Promise<MmUser> {
    const api = this.ready(); const h = handle.trim();
    if (!h) throw new Error("Enter a username (@name) or an email address.");
    try {
      const u = h.includes("@") && !h.startsWith("@") ? await api.get<MmUser>(`/users/email/${encodeURIComponent(h)}`) : await api.get<MmUser>(`/users/username/${encodeURIComponent(h.replace(/^@/, ""))}`);
      this.cacheUser(u); return u;
    } catch (e) { if (e instanceof MmError && e.status === 404) throw new Error("No such Mattermost user (or their email address is hidden from you)."); throw e; }
  }
  private async adopt(c: MmChannel): Promise<Chat> {
    this.channels.set(c.id, c);
    if (!this.chanMembers.has(c.id)) this.chanMembers.set(c.id, { channel_id: c.id, msg_count: c.total_msg_count ?? 0 });
    const o = otherUserId(c, this.me!.id); if (o) await this.ensureUsers([o]);
    return this.chatOf(c);
  }
  async startChat(handle: string): Promise<Chat> {
    const u = await this.resolveUser(handle);
    const c = await this.ready().json<MmChannel>("POST", "/channels/direct", [this.me!.id, u.id]);
    const chat = await this.adopt(c);
    this.emit({ type: "chats-changed", data: { chatId: c.id } });
    return chat;
  }
  async createGroup(_name: string, handles: string[]): Promise<Chat> {
    // Mattermost group messages have no name and no team; the name is ignored (the server derives it from the members).
    const users = await Promise.all(handles.map((h) => this.resolveUser(h)));
    const ids = [...new Set(users.map((u) => u.id).filter((i) => i !== this.me!.id))];
    if (ids.length < 2) throw new Error("A group message needs at least two other people (for one person, start a direct chat).");
    if (ids.length > 7) throw new Error("Mattermost group messages are limited to 8 people including you.");
    const c = await this.ready().json<MmChannel>("POST", "/channels/group", ids);
    const chat = await this.adopt(c);
    this.emit({ type: "chats-changed", data: { chatId: c.id } });
    return chat;
  }
  private forbid<T>(what: string, f: () => Promise<T>): Promise<T> {
    return f().catch((e) => { if (e instanceof MmError && e.status === 403) throw new Error(`Mattermost refused: you do not have permission to ${what} here (ask a channel or team admin).`); throw e; });
  }
  async leaveChat(chatId: string) {
    const api = this.ready(), me = this.me!.id, c = this.channels.get(chatId);
    if (c?.type === "D" || c?.type === "G") {
      const other = c.type === "D" ? otherUserId(c, me)! : c.id;
      await api.json("PUT", `/users/${me}/preferences`, [{ user_id: me, category: c.type === "D" ? "direct_channel_show" : "group_channel_show", name: other, value: "false" }]);
    } else await this.forbid("leave this channel", () => api.json("DELETE", `/channels/${chatId}/members/${me}`));
    this.channels.delete(chatId); this.chanMembers.delete(chatId);
    this.emit({ type: "chats-changed", data: {} });
  }
  async addMembers(chatId: string, handles: string[]) {
    const api = this.ready();
    if (this.channels.get(chatId)?.type === "G" || this.channels.get(chatId)?.type === "D") throw new Error("People cannot be added to a direct or group message; create a new group instead.");
    for (const h of handles) { const u = await this.resolveUser(h); await this.forbid("add members", () => api.json("POST", `/channels/${chatId}/members`, { user_id: u.id })); }
  }
  async removeMember(chatId: string, memberId: string) { await this.forbid("remove members", () => this.ready().json("DELETE", `/channels/${chatId}/members/${memberId}`)); }
  async renameChat(chatId: string, name: string) {
    const n = name.trim(); if (!n) throw new Error("The name cannot be empty.");
    const c = await this.forbid("rename this channel", () => this.ready().json<MmChannel>("PUT", `/channels/${chatId}/patch`, { display_name: n }));
    const old = this.channels.get(chatId); if (old) old.display_name = c.display_name;
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  // ---------------------------------------------------------------- teams (communities)
  private async teamsChanged() {
    await this.loadAll();
    this.emit({ type: "spaces-changed", data: {} }); this.emit({ type: "chats-changed", data: {} });
  }
  async createSpace(name: string, description?: string): Promise<Space> {
    const display = name.trim(); if (!display) throw new Error("The team needs a name.");
    const body = { name: teamSlug(display, () => Math.random().toString(36).slice(2, 8)), display_name: display.slice(0, 64), type: "I", ...(description?.trim() ? { description: description.trim().slice(0, 255) } : {}) };
    let t: MmTeam;
    try { t = await this.forbid("create teams", () => this.ready().json<MmTeam>("POST", "/teams", body)); }
    catch (e) { if (e instanceof MmError && e.status === 400) { t = await this.ready().json<MmTeam>("POST", "/teams", { ...body, name: `${body.name.slice(0, 50)}-${Math.random().toString(36).slice(2, 6)}` }); } else throw e; } // name taken
    await this.teamsChanged();
    return mapSpace(t, this.accountId);
  }
  async joinSpace(invite: string): Promise<Space> {
    const api = this.ready(), me = this.me!.id;
    const what = parseTeamInvite(invite);
    if (!what) throw new Error("Enter a team name, the team's web address, or an invite link from your Mattermost server.");
    let team: MmTeam;
    if (what.kind === "invite") {
      try { const r = await api.json<{ team_id: string }>("POST", `/teams/members/invite?invite_id=${encodeURIComponent(what.id)}`); team = await api.get<MmTeam>(`/teams/${r.team_id}`); }
      catch (e) { if (e instanceof MmError && (e.status === 404 || e.status === 400)) throw new Error("This invite link is not valid (any more)."); throw e; }
    } else {
      try { team = await api.get<MmTeam>(`/teams/name/${encodeURIComponent(what.name)}`); }
      catch (e) { if (e instanceof MmError && e.status === 404) throw new Error("No team with that name was found (or it is not open to you)."); throw e; }
      if (!this.teams.has(team.id)) await this.forbid("join this team (it needs an invite link)", () => api.json("POST", `/teams/${team.id}/members`, { team_id: team.id, user_id: me }));
    }
    await this.teamsChanged();
    return mapSpace(this.teams.get(team.id) ?? team, this.accountId);
  }
  async leaveSpace(spaceId: string): Promise<void> {
    if (!this.teams.has(spaceId)) throw new Error("You are not in that team.");
    await this.forbid("leave this team", () => this.ready().json("DELETE", `/teams/${spaceId}/members/${this.me!.id}`));
    await this.teamsChanged();
  }

  async refreshChat(chatId: string): Promise<string> {
    const api = this.ready();
    const root = threadRoot(chatId);
    if (root) { const ms = await this.threadHistory(root, { limit: 200 }); for (const m of ms) this.emit({ type: "message", data: { ...m, historical: true } }); return `Re-fetched the thread's ${ms.length} messages`; }
    const l = await api.get<PostList>(`/channels/${chatId}/posts?per_page=60`);
    const ps = l.order.map((id) => l.posts[id]).filter((p): p is MmPost => !!p).reverse();
    await this.ensureUsers(ps.map((p) => p.user_id));
    for (const p of Object.values(l.posts)) this.cachePost(p);
    let n = 0;
    for (const p of ps) { const m = mapPost(p, this.msgCtx()); if (m) { this.emit({ type: "message", data: { ...m, historical: true } }); n++; } }
    return `Re-fetched the latest ${n} messages`;
  }
  async sync(): Promise<void> {
    this.ready(); await this.loadAll();
    this.emit({ type: "spaces-changed", data: {} }); this.emit({ type: "chats-changed", data: {} });
  }

  // ---------------------------------------------------------------- profile
  private async profileOf(u: MmUser): Promise<Profile> {
    const p: Profile = { displayName: profileName(u), handle: "@" + u.username };
    if (u.position) p.about = u.position;
    if (u.last_picture_update) { try { p.avatar = await this.ready().bytes(`/users/${u.id}/image?_=${u.last_picture_update}`); } catch { /* none */ } }
    return p;
  }
  async getProfile(): Promise<Profile> { return this.profileOf(await this.ready().get<MmUser>("/users/me")); }
  async updateProfile(patch: ProfilePatch): Promise<Profile> {
    const api = this.ready();
    const body: Record<string, string> = {};
    if (patch.displayName !== undefined) { if (!patch.displayName.trim()) throw new Error("The name cannot be empty."); body.nickname = patch.displayName.trim(); }
    if (patch.about !== undefined) body.position = patch.about.trim();
    const explain = (f: () => Promise<unknown>) => f().catch((e) => { if (e instanceof MmError && (e.status === 400 || e.status === 403)) throw new Error("The server does not let you change this field (it may be managed by your organisation's directory)."); throw e; });
    if (Object.keys(body).length) await explain(() => api.json("PUT", "/users/me/patch", body));
    if (patch.avatar === null) await explain(() => api.json("DELETE", "/users/me/image"));
    else if (patch.avatar) {
      const form = new FormData(); form.append("image", new Blob([patch.avatar.data as BlobPart], { type: patch.avatar.mime }), "avatar");
      await explain(() => api.raw("POST", "/users/me/image", { form }));
    }
    const u = await api.get<MmUser>("/users/me"); this.cacheUser(u); this.me = u;
    return this.profileOf(u);
  }
}

interface WsEvent { event?: string; data?: Record<string, any>; broadcast?: Record<string, any>; seq?: number }

const factory: ProviderFactory = {
  name: "mattermost", displayName: "Mattermost", login: "form", capabilities: CAPABILITIES,
  create: ({ accountId, dataDir }) => new MattermostConnector(accountId, dataDir),
};
export default factory;
export { emojiFromName, emojiToName };
