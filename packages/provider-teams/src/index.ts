// Microsoft Teams provider: Microsoft Graph v1.0 (delegated permissions) + OAuth device code flow. See README.md.
// There is NO push: Graph change notifications need a public webhook, so new messages are found by adaptive, conservative POLLING (delta queries).
import { randomUUID } from "node:crypto";
import type {
  Capabilities, Chat, Connector, Contact, CoreEvent, HistoryQuery, LoginPrompt, Message, OutgoingMessage, Profile, ProfilePatch, ProviderFactory, Space,
} from "@unimsg/core";
import {
  AuthError, DEFAULT_AUTH, DEFAULT_GRAPH, Graph, GraphError, dbg, endpoint, idClaims, isLoopback, pollDeviceToken, refreshToken, requestDeviceCode, sleep,
  type TokenResponse,
} from "./api.js";
import {
  chanChatId, emojiToReaction, mapChat, mapChannel, mapMember, mapMessage, mapSpace, patchOf, previewText, splitChan, textToHtml, escapeHtml, guessMime,
  type GChannel, type GChat, type GMember, type GMessage, type GTeam,
} from "./map.js";
import { loadSession, loadSince, saveSession, saveSince, wipeSession, type Session } from "./secret.js";

export const CAPABILITIES: Capabilities = {
  spaces: true, reactions: true, pinMessages: true, edits: true, deletes: true, replies: true, attachments: true,
  typing: false,                       // Graph has no typing indicator API
  readReceipts: false, markRead: true, // markChatReadForUser works, but there are no per-message receipts
  startChat: true, createGroup: true, backfill: true, e2ee: false,
  leaveChat: true, manageMembers: true, renameChat: true, chatPicture: false, block: false, polls: false, location: false, contactCards: false,
  avatars: true, mentions: true, customEmoji: false, privacy: false, refreshChat: false, sync: false, leaveSpace: false, createSpace: false, joinSpace: false,
  profile: { displayName: false, about: false, avatar: false },
};

const BASE_SCOPES = "openid profile offline_access User.Read User.ReadBasic.All Chat.ReadWrite ChatMessage.Send Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send";
const CHANNEL_READ = "ChannelMessage.Read.All";
const FILE_SCOPES = "Files.Read.All Files.ReadWrite";
const PROFILE_SCOPE = "User.ReadWrite";      // own photo + about-me
const TEAM_CREATE = "Team.Create";           // create a team
const HOSTED_MAX = 4 * 1024 * 1024;     // inline images (hostedContents)
const FILE_MAX = 100 * 1024 * 1024;     // simple OneDrive upload (documented limit is 250 MB)
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TENANT = /^(organizations|common|consumers|[0-9a-fA-F-]{36}|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+)$/;

const num = (name: string, def: number) => { const v = process.env[name]; return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : def; };
const TICK = () => num("UNIMSG_TEAMS_POLL_MS", 5000);             // base polling tick; everything else is a multiple
const PACE = () => num("UNIMSG_TEAMS_PACE_MS", 250);
const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));
const enc = encodeURIComponent;

interface Cursor { oldestId: string; next?: string; buffer: GMessage[] }
interface Target { id: string; nextAt: number }
interface DeltaState { link?: string }

class TeamsConnector implements Connector {
  private emit: (e: CoreEvent) => void = () => {};
  private session?: Session;
  private api?: Graph;
  private me?: { id: string; name: string; mail?: string };
  private refreshing?: Promise<string>;
  private stopped = true;
  private loopId = 0;       // bumps on stop / login restart: cancels poll loop + device flow
  private promptN = 0;
  private startedAt = 0;
  private baseline = 0;     // delta "since" for the first poll of a chat
  private connectedOnce = false;
  private fails = 0;

  private chatsRaw = new Map<string, GChat>();
  private teams = new Map<string, GTeam>();
  private chans = new Map<string, { team: GTeam; ch: GChannel }>();
  private chatsLoaded = false;
  private teamsDenied = false;
  private channelsDenied = new Set<string>();
  private warned = new Set<string>();
  private msgCache = new Map<string, GMessage>();
  private parentOf = new Map<string, string>();
  private seen = new Map<string, string>();
  private cursors = new Map<string, Cursor>();
  private senders = new Map<string, Map<string, string>>();
  private deltas = new Map<string, DeltaState>();
  private targets = new Map<string, Target>();
  private hotUntil = new Map<string, number>();
  private previews = new Map<string, { id?: string; read?: string }>();
  private noExpand = false;
  private avatars = new Map<string, { data: Uint8Array; mime: string } | null>();
  private lastListAt = 0; private lastSaveAt = 0; private lastActivity = Date.now();

  private readonly accountId: string; private readonly dataDir: string;
  constructor(accountId: string, dataDir: string) { this.accountId = accountId; this.dataDir = dataDir; }

  get capabilities(): Capabilities {
    const g = this.granted();
    // optional login boxes switch features on: they exist only when the scope was really granted (never assumed)
    return { ...CAPABILITIES, spaces: !g || g.has("team.readbasic.all"), attachments: true,
      createSpace: !!g?.has("team.create"), profile: g?.has("user.readwrite") ? { about: true, avatar: true } : { displayName: false, about: false, avatar: false } };
  }
  private granted(): Set<string> | undefined { const s = this.session?.granted; return s ? new Set(s.toLowerCase().split(/\s+/)) : undefined; }
  private has(scope: string) { const g = this.granted(); return !g || g.has(scope.toLowerCase()); }
  private canReadChannels() { return this.has(CHANNEL_READ); }

  // ---------------------------------------------------------------- lifecycle
  async start(emit: (e: CoreEvent) => void): Promise<void> {
    this.emit = emit; this.stopped = false; this.startedAt = Date.now(); this.api = undefined;
    this.session = loadSession(this.dataDir);
    if (!this.session) { this.state("needs-login"); this.prompt(); return; }
    this.baseline = Math.min(Date.parse(loadSince(this.dataDir) ?? "") || this.startedAt, this.startedAt);
    this.state("connecting");
    void this.boot(++this.loopId);
  }
  async stop(): Promise<void> {
    this.stopped = true; this.loopId++; this.api && (this.api.stopped = true);
  }
  async logout(): Promise<void> {
    await this.stop();
    this.session = undefined; this.api = undefined; this.me = undefined;
    wipeSession(this.dataDir);
    this.clearCaches();
    // Entra offers no per-grant revoke for a public client; the saved refresh token is simply deleted. See README (remove the app under "My apps").
  }
  private clearCaches() {
    for (const m of [this.chatsRaw, this.teams, this.chans, this.msgCache, this.parentOf, this.seen, this.cursors, this.senders, this.deltas, this.targets, this.hotUntil, this.previews, this.avatars] as Map<unknown, unknown>[]) m.clear();
    this.chatsLoaded = false; this.teamsDenied = false; this.channelsDenied.clear(); this.warned.clear(); this.connectedOnce = false;
  }
  private state(state: "connecting" | "needs-login" | "connected" | "disconnected" | "signed-out", detail?: string) {
    this.emit({ type: "account", data: { id: this.accountId, state, ...(detail ? { detail } : {}) } });
  }
  private err(code: string, message: string, fatal = false) { this.emit({ type: "error", data: { id: this.accountId, code, message, fatal } }); }
  private warnOnce(code: string, message: string) { if (this.warned.has(code)) return; this.warned.add(code); this.err(code, message); }

  // ---------------------------------------------------------------- login
  private prompt(error?: string) {
    const p: LoginPrompt = {
      accountId: this.accountId, promptId: `login-${++this.promptN}`, kind: "form",
      title: "Microsoft Teams sign-in (device code). Needs your own Entra app registration; see the README.",
      warning: { severity: "info", text: "Enter your app's Application (client) ID. Leave the tenant empty unless you know it. Channel messages often need admin consent: leave that box unticked if unsure." },
      fields: [
        { name: "client_id", label: "Application (client) ID", type: "text", placeholder: "00000000-0000-0000-0000-000000000000", required: true },
        { name: "tenant", label: "Tenant (optional)", type: "text", placeholder: "organizations" },
        { name: "channels", label: "Also read team channel messages (ChannelMessage.Read.All, needs admin consent)", type: "checkbox" },
        { name: "files", label: "Also open and upload files (Files.Read.All, Files.ReadWrite)", type: "checkbox" },
        { name: "profile", label: "Also let me change my profile picture and about text (User.ReadWrite)", type: "checkbox" },
        { name: "create", label: "Also let me create teams (Team.Create, needs admin consent)", type: "checkbox" },
      ],
      ...(error ? { error } : {}),
    };
    this.emit({ type: "login", data: p });
  }
  private authority() { return endpoint("UNIMSG_TEAMS_AUTH", DEFAULT_AUTH); }

  async submitLogin(_promptId: string, v: Record<string, string>): Promise<void> {
    const clientId = (v.client_id ?? "").trim(), tenant = (v.tenant ?? "").trim() || "organizations";
    if (!GUID.test(clientId)) throw new Error("The client id must be the Application (client) ID of your app registration: a GUID like 00000000-0000-0000-0000-000000000000.");
    if (!TENANT.test(tenant)) throw new Error("The tenant must be empty, 'organizations', a tenant id (GUID) or a domain like contoso.onmicrosoft.com.");
    const scope = [BASE_SCOPES, v.channels === "true" ? CHANNEL_READ : "", v.files === "true" ? FILE_SCOPES : "", v.profile === "true" ? PROFILE_SCOPE : "", v.create === "true" ? TEAM_CREATE : ""].filter(Boolean).join(" ");
    let dc;
    try { dc = await requestDeviceCode(this.authority(), tenant, clientId, scope); } catch (e) { throw new Error(e instanceof AuthError ? e.message : "Sign-in failed."); }
    const id = ++this.loopId;
    this.emit({ type: "login", data: {
      accountId: this.accountId, promptId: `device-${++this.promptN}`, kind: "link", payload: dc.verification_uri,
      hint: `Open this page and enter the code ${dc.user_code} (sign in with the work account you want to use). UniChat is waiting for you to finish.`,
    } });
    void this.pollDevice(id, { clientId, tenant, scope }, dc.device_code, dc.interval, dc.expires_in);
  }
  private async pollDevice(id: number, c: { clientId: string; tenant: string; scope: string }, code: string, interval: number, expires: number) {
    const fast = process.env.UNIMSG_TEAMS_DEVICE_POLL_MS && isLoopback(this.authority()) ? Number(process.env.UNIMSG_TEAMS_DEVICE_POLL_MS) : 0;
    let wait = fast || Math.max(1, interval) * 1000; const deadline = Date.now() + expires * 1000; let netFails = 0;
    while (id === this.loopId && !this.stopped && Date.now() < deadline) {
      await sleep(wait); if (id !== this.loopId || this.stopped) return;
      try {
        const t = await pollDeviceToken(this.authority(), c.tenant, c.clientId, code);
        return this.signedIn(id, c, t);
      } catch (e) {
        const k = e instanceof AuthError ? e.kind : "network";
        if (k === "pending") { netFails = 0; continue; }
        if (k === "slow") { wait += fast || 5000; continue; }
        if (k === "network" && ++netFails < 6) continue;
        this.prompt(e instanceof AuthError ? e.message : "Sign-in failed."); return;
      }
    }
    if (id === this.loopId && !this.stopped) this.prompt("The sign-in code expired. Please start again.");
  }
  private signedIn(id: number, c: { clientId: string; tenant: string; scope: string }, t: TokenResponse) {
    if (!t.refresh_token) { this.prompt("Microsoft did not grant offline access. Add the offline_access permission to the app registration."); return; }
    const claims = idClaims(t.id_token);
    this.session = { clientId: c.clientId, tenant: c.tenant, scope: c.scope, refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000, granted: t.scope, ...(claims.tid ? { tenantId: claims.tid } : {}), ...(claims.oid ? { userId: claims.oid } : {}) };
    saveSession(this.dataDir, this.session);
    this.api = undefined; this.baseline = this.startedAt = Date.now();
    this.state("connecting");
    void this.boot(id);
  }

  // ---------------------------------------------------------------- tokens
  private async accessToken(force = false): Promise<string> {
    const s = this.session; if (!s) throw new AuthError("Not signed in.", "revoked");
    if (!force && s.accessToken && (s.expiresAt ?? 0) - Date.now() > 120_000) return s.accessToken;
    this.refreshing ??= (async () => {
      try {
        const t = await refreshToken(this.authority(), s);
        s.accessToken = t.access_token; s.expiresAt = Date.now() + t.expires_in * 1000;
        if (t.refresh_token) s.refreshToken = t.refresh_token;
        if (t.scope) s.granted = t.scope;
        if (this.session === s) saveSession(this.dataDir, s);
        return s.accessToken;
      } finally { this.refreshing = undefined; }
    })();
    return this.refreshing;
  }
  private needsLogin() {
    if (!this.session) return;
    this.session = undefined; this.loopId++; if (this.api) this.api.stopped = true; this.api = undefined;
    wipeSession(this.dataDir); this.clearCaches();
    this.state("needs-login", "Microsoft no longer accepts the saved sign-in");
    this.prompt("Your Microsoft sign-in expired or was revoked. Please sign in again.");
  }
  private graph(): Graph {
    if (!this.session) throw new Error("Not signed in.");
    this.api ??= new Graph({
      base: endpoint("UNIMSG_TEAMS_GRAPH", DEFAULT_GRAPH), paceMs: PACE(), token: (f) => this.accessToken(f),
      onRevoked: () => this.needsLogin(),
      onCooldown: (ms) => this.warnOnce("rate-limited", `Microsoft asked UniChat to slow down (about ${Math.ceil(ms / 1000)} s). Polling is paused for a moment.`),
    });
    return this.api;
  }
  private ready(): Graph { if (this.stopped) throw new Error("This account is not connected."); return this.graph(); }

  // ---------------------------------------------------------------- boot + poll loop
  private async boot(id: number) {
    for (let n = 0; id === this.loopId && !this.stopped; n++) {
      try {
        const j = await this.graph().json<{ id: string; displayName?: string; mail?: string; userPrincipalName?: string }>("GET", "/me?$select=id,displayName,mail,userPrincipalName");
        this.me = { id: j.id, name: j.displayName ?? "Me", mail: j.mail ?? j.userPrincipalName };
        if (this.session && this.session.userId !== j.id) { this.session.userId = j.id; saveSession(this.dataDir, this.session); }
        this.api!.stopped = false;
        this.connectedOnce = true; this.state("connected");
        if (!this.canReadChannels()) this.warnOnce("channels-not-readable", "Team channel messages cannot be read with the current permissions (ChannelMessage.Read.All needs admin consent). Channels are listed but stay empty; direct and group chats work normally.");
        void this.pollLoop(id);
        return;
      } catch (e) {
        if (id !== this.loopId || this.stopped || !this.session) return;
        if (e instanceof GraphError && e.kind === "auth") return;   // needsLogin() already ran
        this.state("disconnected", e instanceof GraphError ? e.message : "Could not connect");
        await sleep(jitter(Math.min(5 * 60_000, 3000 * 2 ** Math.min(n, 7))));
      }
    }
  }
  private hot(chatId: string, ms = 5 * 60_000) { this.hotUntil.set(chatId, Math.max(this.hotUntil.get(chatId) ?? 0, Date.now() + ms)); const t = this.targets.get(chatId); if (t) t.nextAt = Math.min(t.nextAt, Date.now() + 200); this.lastActivity = Date.now(); }
  private isHot(chatId: string) { return (this.hotUntil.get(chatId) ?? 0) > Date.now(); }

  private async pollLoop(id: number) {
    while (id === this.loopId && !this.stopped) {
      let wait = TICK();
      try {
        await this.pollOnce(id);
        if (this.fails > 0 && this.connectedOnce) this.state("connected");
        this.fails = 0;
      } catch (e) {
        if (id !== this.loopId || this.stopped) return;
        this.fails++;
        if (e instanceof GraphError && e.kind === "auth") return;
        wait = e instanceof GraphError && e.retryAfterMs ? e.retryAfterMs : Math.min(5 * 60_000, TICK() * 2 ** Math.min(this.fails, 6));
        if (this.fails === 3) this.state("disconnected", e instanceof GraphError ? e.message : "Connection problem");
        dbg(`poll failure #${this.fails}`);
      }
      await sleep(jitter(wait));
    }
  }

  /** One scheduler step: (1) the chat list ordering, (2) at most two due delta polls. */
  private async pollOnce(id: number) {
    const tick = TICK(), now = Date.now();
    if (!this.chatsLoaded) await this.loadChats(1);
    // 1. chat list ordering: new chats, chats with a newer last message, read-state changes. Faster while something is happening.
    const idle = now - this.lastActivity > 15 * 60_000;
    if (now - this.lastListAt >= jitter(tick * (idle ? 12 : 4))) {
      this.lastListAt = Date.now();
      const j = await this.graph().json<{ value: GChat[] }>("GET", "/me/chats?$top=25&$orderby=lastMessagePreview/createdDateTime%20desc&$expand=lastMessagePreview", { prio: 1 });
      for (const c of j.value ?? []) {
        const known = this.chatsRaw.has(c.id);
        if (!known) { this.chatsRaw.set(c.id, c); this.emit({ type: "chats-changed", data: { chatId: c.id } }); this.addTarget(c.id, true); this.hot(c.id); continue; }
        const prev = this.previews.get(c.id); const cur = { id: c.lastMessagePreview?.id, read: c.viewpoint?.lastMessageReadDateTime };
        this.previews.set(c.id, cur);
        const created = Date.parse(c.lastMessagePreview?.createdDateTime ?? "") || 0;
        const fresh = prev ? prev.id !== cur.id : created > this.baseline;
        if (fresh) { this.hot(c.id); this.emit({ type: "chats-changed", data: { chatId: c.id } }); }
        else if (prev && prev.read !== cur.read) this.emit({ type: "chats-changed", data: { chatId: c.id } });
      }
      if (Date.now() - this.lastSaveAt > 60_000) { this.lastSaveAt = Date.now(); saveSince(this.dataDir, new Date(Date.now() - 120_000).toISOString()); }
    }
    // 2. due delta polls (hot chats every ~2 ticks, everything else slowly)
    const due = [...this.targets.values()].filter((t) => t.nextAt <= Date.now() && !this.channelsDenied.has(t.id) && (this.canReadChannels() || !splitChan(t.id))).sort((a, b) => a.nextAt - b.nextAt).slice(0, 2);
    for (const t of due) {
      if (id !== this.loopId || this.stopped) return;
      try { await this.deltaPoll(t.id); }
      catch (e) {
        if (e instanceof GraphError && (e.kind === "forbidden" || e.kind === "notfound") && splitChan(t.id)) {
          this.channelsDenied.add(t.id);
          this.warnOnce(e.kind === "forbidden" ? "channels-not-readable" : "channel-gone", e.kind === "forbidden" ? "Some team channels cannot be read (ChannelMessage.Read.All is missing or needs admin consent). They stay empty; sending may still work." : "A team channel is no longer available.");
          continue;
        }
        if (e instanceof GraphError && e.kind === "notfound") { this.targets.delete(t.id); continue; }
        throw e;
      }
      t.nextAt = Date.now() + jitter(this.interval(t.id));
    }
  }
  private interval(chatId: string): number {
    const tick = TICK(); if (this.isHot(chatId)) return tick * 2;
    const n = this.targets.size;
    return Math.max(splitChan(chatId) ? tick * 12 : tick * 60, n * tick * 2);
  }
  private addTarget(chatId: string, soon = false) {
    if (this.targets.has(chatId)) return;
    const tick = TICK(); this.targets.set(chatId, { id: chatId, nextAt: Date.now() + (soon ? tick : jitter(this.interval(chatId)) * Math.random()) });
  }

  private containerPath(chatId: string): string { const c = splitChan(chatId); return c ? `/teams/${enc(c.teamId)}/channels/${enc(c.channelId)}` : `/chats/${enc(chatId)}`; }
  private async deltaPoll(chatId: string) {
    const st = this.deltas.get(chatId) ?? {}; this.deltas.set(chatId, st);
    let url = st.link ?? `${this.containerPath(chatId)}/messages/delta?$filter=lastModifiedDateTime%20gt%20${new Date(this.baseline).toISOString()}`;
    const items: GMessage[] = [];
    for (let i = 0; i < 20; i++) {
      const j = await this.graph().json<{ value?: GMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>("GET", url, { prio: 1 });
      items.push(...(j.value ?? []));
      if (j["@odata.nextLink"]) { url = j["@odata.nextLink"]; continue; }
      if (j["@odata.deltaLink"]) st.link = j["@odata.deltaLink"];
      break;
    }
    items.sort((a, b) => Date.parse(a.createdDateTime ?? "") - Date.parse(b.createdDateTime ?? ""));
    for (const m of items) this.ingest(chatId, m);
  }

  /** Delivers one raw Graph message as `message` (first sight) or `message-update` (changed). */
  private ingest(chatId: string, raw: GMessage) {
    const key = `${chatId}|${raw.id}`;
    if (raw["@removed"]) { if (this.seen.has(key)) this.emit({ type: "message-update", data: { chatId, messageId: raw.id, patch: { deleted: true, text: "" } } }); return; }
    if (!raw.createdDateTime) return;
    const msg = this.map(chatId, raw); const prev = this.seen.get(key);
    this.remember(chatId, raw);
    if (prev === undefined) {
      if (Date.parse(raw.createdDateTime) < this.startedAt) msg.historical = true; else this.hot(chatId);
      this.emit({ type: "message", data: msg });
    } else if (prev !== raw.lastModifiedDateTime) this.emit({ type: "message-update", data: { chatId, messageId: raw.id, patch: patchOf(msg) } });
  }
  private remember(chatId: string, raw: GMessage) {
    const key = `${chatId}|${raw.id}`;
    this.seen.set(key, raw.lastModifiedDateTime ?? raw.createdDateTime ?? ""); this.msgCache.set(key, raw);
    for (const m of [this.seen, this.msgCache] as Map<string, unknown>[]) if (m.size > 6000) for (const k of [...m.keys()].slice(0, 1000)) m.delete(k);
    const sid = raw.from?.user?.id; if (sid) { const mm = this.senders.get(chatId) ?? new Map(); mm.set(sid, raw.from!.user!.displayName ?? "Unknown"); this.senders.set(chatId, mm); }
  }
  private map(chatId: string, raw: GMessage): Message {
    return mapMessage(raw, { chatId, me: this.me?.id, noteParent: (id, p) => this.parentOf.set(`${chatId}|${id}`, p) });
  }

  // ---------------------------------------------------------------- read
  private async loadTeams(): Promise<void> {
    if (this.teamsDenied || !this.has("Team.ReadBasic.All")) { this.teamsDenied = true; this.warnOnce("teams-unavailable", "Teams and channels are not available (Team.ReadBasic.All is missing or blocked). Only chats are shown."); return; }
    const api = this.ready();
    try {
      const teams = await api.all<GTeam>("/me/joinedTeams");
      this.teams.clear(); for (const t of teams) this.teams.set(t.id, t);
      this.chans.clear();
      for (const t of teams) {
        let chs: GChannel[] = [];
        try { chs = await api.all<GChannel>(`/teams/${enc(t.id)}/allChannels`); }
        catch (e) { if (e instanceof GraphError && (e.kind === "forbidden" || e.kind === "notfound")) { try { chs = await api.all<GChannel>(`/teams/${enc(t.id)}/channels`); } catch (e2) { if (!(e2 instanceof GraphError && e2.kind === "forbidden")) throw e2; this.warnOnce("channels-unavailable", "Channels of some teams cannot be listed (Channel.ReadBasic.All is missing)."); } } else throw e; }
        for (const ch of chs) this.chans.set(chanChatId(t.id, ch.id), { team: t, ch });
      }
    } catch (e) {
      if (e instanceof GraphError && e.kind === "forbidden") { this.teamsDenied = true; this.warnOnce("teams-unavailable", "Teams and channels are not available (Team.ReadBasic.All is missing or blocked). Only chats are shown."); return; }
      throw e;
    }
  }
  private async loadChats(prio: 0 | 1 = 0) {
    const api = this.ready();
    const list = await api.all<GChat>("/me/chats?$expand=members,lastMessagePreview&$top=50", { prio });
    this.chatsRaw.clear();
    for (const c of list) { this.chatsRaw.set(c.id, c); this.previews.set(c.id, { id: c.lastMessagePreview?.id, read: c.viewpoint?.lastMessageReadDateTime }); this.addTarget(c.id); }
    await this.loadTeams();
    for (const id of this.chans.keys()) this.addTarget(id);
    for (const id of [...this.targets.keys()]) if (!this.chatsRaw.has(id) && !this.chans.has(id)) this.targets.delete(id);
    this.chatsLoaded = true;
  }
  async spaces(): Promise<Space[]> {
    this.ready(); if (!this.chatsLoaded) await this.loadChats(); else await this.loadTeams();
    return [...this.teams.values()].map((t) => mapSpace(t, this.accountId));
  }
  async chats(): Promise<Chat[]> {
    await this.loadChats();
    const me = this.me?.id; const canSend = this.has("ChannelMessage.Send");
    const out: Chat[] = [...this.chatsRaw.values()].filter((c) => !c.viewpoint?.isHidden).map((c) => mapChat(c, this.accountId, me));
    for (const { team, ch } of this.chans.values()) out.push(mapChannel(ch, team, this.accountId, canSend));
    return out;
  }

  private msgPath(chatId: string, messageId: string): string {
    const parent = this.parentOf.get(`${chatId}|${messageId}`);
    return this.containerPath(chatId) + "/messages/" + enc(parent ?? messageId) + (parent ? `/replies/${enc(messageId)}` : "");
  }
  private async rawMessage(chatId: string, messageId: string, fresh = false): Promise<GMessage> {
    const key = `${chatId}|${messageId}`; const c = this.msgCache.get(key);
    if (c && !fresh) return c;
    const m = await this.ready().json<GMessage>("GET", this.msgPath(chatId, messageId));
    this.remember(chatId, m); return m;
  }

  async history(chatId: string, q: HistoryQuery): Promise<Message[]> {
    const api = this.ready(); const chan = splitChan(chatId);
    if (!chan && !this.chatsRaw.has(chatId)) throw new Error("Unknown chat.");
    if (chan && (!this.canReadChannels() || this.channelsDenied.has(chatId))) return [];
    this.hot(chatId, 10 * 60_000);
    const limit = Math.max(1, Math.min(q.limit, 200));
    let buf: GMessage[] = []; let next: string | undefined; let before: number | undefined;
    const cur = this.cursors.get(chatId);
    if (q.beforeMessageId && cur && cur.oldestId === q.beforeMessageId) { buf = [...cur.buffer]; next = cur.next; }
    else {
      const expand = chan && !this.noExpand ? "&$expand=replies" : "";
      next = `${this.containerPath(chatId)}/messages?$top=${Math.min(limit, 50)}${expand}`;
      if (q.beforeMessageId) {
        const t = (await this.rawMessage(chatId, q.beforeMessageId)).createdDateTime; before = Date.parse(t ?? "");
        next += `&$filter=createdDateTime%20lt%20${t}`;
      } else next += "&$orderby=createdDateTime%20desc";
    }
    for (let i = 0; buf.length < limit && next && i < 20; i++) {
      let j: { value?: GMessage[]; "@odata.nextLink"?: string };
      try { j = await api.json("GET", next); }
      catch (e) {
        if (chan && !this.noExpand && e instanceof GraphError && e.status === 400 && next.includes("$expand=replies")) { this.noExpand = true; next = next.replace("&$expand=replies", ""); continue; }
        if (chan && e instanceof GraphError && e.kind === "forbidden") { this.channelsDenied.add(chatId); this.warnOnce("channels-not-readable", "Some team channels cannot be read (ChannelMessage.Read.All is missing or needs admin consent)."); return []; }
        throw e;
      }
      for (const m of j.value ?? []) { buf.push(m); for (const r of m.replies ?? []) buf.push(r); }
      next = j["@odata.nextLink"];
    }
    const uniq = new Map<string, GMessage>(); for (const m of buf) uniq.set(m.id, m);
    let all = [...uniq.values()].sort((a, b) => Date.parse(b.createdDateTime ?? "") - Date.parse(a.createdDateTime ?? ""));
    if (before !== undefined) all = all.filter((m) => Date.parse(m.createdDateTime ?? "") < before!);
    const page = all.slice(0, limit), rest = all.slice(limit);
    if (page.length) this.cursors.set(chatId, { oldestId: page[page.length - 1].id, next, buffer: rest }); else this.cursors.delete(chatId);
    return page.reverse().map((raw) => { this.remember(chatId, raw); const m = this.map(chatId, raw); m.historical = true; return m; });
  }

  async members(chatId: string): Promise<Contact[]> {
    const api = this.ready(); const chan = splitChan(chatId);
    if (!chan) {
      const ms = await this.wrap("list the members", () => api.all<GMember>(`/chats/${enc(chatId)}/members`));
      return ms.map(mapMember).filter((c) => c.id);
    }
    try { return (await api.all<GMember>(`${this.containerPath(chatId)}/members`)).map(mapMember).filter((c) => c.id); }
    catch (e) {
      if (!(e instanceof GraphError && (e.kind === "forbidden" || e.kind === "notfound"))) throw e;
      return [...(this.senders.get(chatId) ?? new Map()).entries()].map(([id, name]) => ({ id, name }));   // degrade: people who have written here
    }
  }

  async downloadAttachment(chatId: string, messageId: string, attachmentId: string): Promise<{ data: Uint8Array; mime: string; name?: string }> {
    const api = this.ready(); const raw = await this.rawMessage(chatId, messageId);
    const [kind, ...rest] = attachmentId.split(":"); const arg = rest.join(":");
    const att = (id: string) => raw.attachments?.find((a) => a.id === id);
    const cap = (r: { data: Uint8Array; mime: string }) => { if (r.data.length > FILE_MAX * 2) throw new Error("The file is too large."); return r; };
    if (kind === "hc") {
      const r = await this.wrap("download the image", () => api.bytes(`${this.msgPath(chatId, messageId)}/hostedContents/${enc(arg)}/$value`)); return cap(r);
    }
    if (kind === "ref") {
      const a = att(arg); if (!a?.contentUrl) throw new Error("Attachment not found.");
      if (!this.has("Files.Read.All") && !this.has("Files.ReadWrite.All")) throw new Error("Opening files needs the Files permissions. Sign in again with 'Also open and upload files' ticked.");
      const share = "u!" + Buffer.from(a.contentUrl).toString("base64url");
      const r = await this.wrap("download the file", () => api.bytes(`/shares/${share}/driveItem/content`));
      return { ...cap(r), mime: r.mime === "application/octet-stream" ? guessMime(a.name ?? undefined) : r.mime, ...(a.name ? { name: a.name } : {}) };
    }
    if (kind === "url") { const a = att(arg); if (!a?.contentUrl) throw new Error("Attachment not found."); return cap(await this.wrap("download the picture", () => api.download(a.contentUrl!))); }
    if (kind === "img") { const src = Buffer.from(arg.slice(arg.indexOf(":") + 1), "base64url").toString("utf8"); return cap(await this.wrap("download the picture", () => api.download(src))); }
    throw new Error("Attachment not found.");
  }

  // ---------------------------------------------------------------- write
  private async wrap<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) { if (e instanceof GraphError) throw new Error(`Could not ${what}: ${e.message}.`); throw e; }
  }
  private async tenantId(): Promise<string> {
    if (this.session?.tenantId) return this.session.tenantId;
    const j = await this.ready().json<{ value?: { id: string }[] }>("GET", "/organization?$select=id");
    const id = j.value?.[0]?.id; if (!id) throw new Error("Could not determine your tenant id.");
    this.session!.tenantId = id; saveSession(this.dataDir, this.session!); return id;
  }

  async send(chatId: string, msg: OutgoingMessage): Promise<Message> {
    const api = this.ready(); const chan = splitChan(chatId);
    if (chan && !this.has("ChannelMessage.Send")) throw new Error("Sending to channels needs the ChannelMessage.Send permission.");
    if (!chan && !this.chatsRaw.has(chatId)) await this.loadChats();
    // text + mentions
    let html = ""; const mentions: unknown[] = []; let pos = 0;
    const ms = [...(msg.mentions ?? [])].filter((m) => m.start >= 0 && m.length > 0 && m.start + m.length <= msg.text.length).sort((a, b) => a.start - b.start);
    for (const m of ms) {
      if (m.start < pos) continue;
      html += textToHtml(msg.text.slice(pos, m.start)); const i = mentions.length;
      html += `<at id="${i}">${escapeHtml(m.name.replace(/^@/, ""))}</at>`;
      mentions.push({ id: i, mentionText: m.name.replace(/^@/, ""), mentioned: { user: { id: m.id, displayName: m.name.replace(/^@/, ""), userIdentityType: "aadUser" } } });
      pos = m.start + m.length;
    }
    html += textToHtml(msg.text.slice(pos));
    const body: Record<string, any> = { body: { contentType: "html", content: html } };
    const attachments: unknown[] = []; const hosted: unknown[] = [];
    let path = this.containerPath(chatId) + "/messages";
    // reply
    if (msg.replyToMessageId) {
      if (chan) path = this.msgPath(chatId, msg.replyToMessageId).replace(/\/replies\/[^/]+$/, "") + "/replies";
      else {
        let target: GMessage | undefined; try { target = await this.rawMessage(chatId, msg.replyToMessageId); } catch { /* quote without details */ }
        const rid = randomUUID();
        attachments.push({ id: rid, contentType: "messageReference", contentUrl: "", content: JSON.stringify({ messageId: msg.replyToMessageId, messagePreview: target ? (previewText(target) ?? "").slice(0, 100) : "", messageSender: target?.from?.user ? { user: { userIdentityType: "aadUser", id: target.from.user.id, displayName: target.from.user.displayName } } : undefined }), name: null, thumbnailUrl: null });
        body.body.content = `<attachment id="${rid}"></attachment>` + body.body.content;
      }
    }
    // attachments: small images inline (hostedContents), everything else through OneDrive
    for (const [i, a] of (msg.attachments ?? []).entries()) {
      if (a.data.length > FILE_MAX) throw new Error("This file is too large for Teams uploads from UniChat (limit 100 MB).");
      if (a.kind === "image" && a.mime.startsWith("image/") && a.data.length <= HOSTED_MAX) {
        const tid = String(hosted.length + 1);
        hosted.push({ "@microsoft.graph.temporaryId": tid, contentBytes: Buffer.from(a.data).toString("base64"), contentType: a.mime });
        body.body.content += `<p><img src="../hostedContents/${tid}/$value" alt="${escapeHtml(a.name ?? "image")}"></p>`;
        continue;
      }
      if (!this.has("Files.ReadWrite")) throw new Error("Sending files needs the Files permission. Sign in again with 'Also open and upload files' ticked (images up to 4 MB work without it).");
      const name = (a.name ?? `file-${i + 1}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "file";
      const up = await this.wrap("upload the file", () => this.upload(chatId, name, a.data, a.mime));
      const rid = /\{([0-9a-f-]{36})\}/i.exec(up.eTag ?? "")?.[1] ?? randomUUID();
      attachments.push({ id: rid, contentType: "reference", contentUrl: up.link, name });
      body.body.content += `<attachment id="${rid}"></attachment>`;
    }
    if (!msg.text.trim() && !attachments.length && !hosted.length) throw new Error("Nothing to send.");
    if (body.body.content.length > 27_000) throw new Error("This message is too long for Teams (about 28 KB of formatted text).");
    if (mentions.length) body.mentions = mentions;
    if (attachments.length) body.attachments = attachments;
    if (hosted.length) body.hostedContents = hosted;
    const raw = await this.wrap("send the message", () => api.json<GMessage>("POST", path, { body }));
    this.remember(chatId, raw); this.hot(chatId);
    const m = this.map(chatId, raw); m.status = "sent"; m.fromMe = true;
    return m;
  }
  private async upload(chatId: string, name: string, data: Uint8Array, mime: string): Promise<{ link: string; eTag?: string }> {
    const api = this.ready(); const chan = splitChan(chatId); let put: string, drive: string;
    if (chan) {
      const f = await api.json<{ id: string; parentReference?: { driveId?: string } }>("GET", `/teams/${enc(chan.teamId)}/channels/${enc(chan.channelId)}/filesFolder`);
      drive = `/drives/${enc(f.parentReference?.driveId ?? "")}`; put = `${drive}/items/${enc(f.id)}:/${enc(name)}:/content`;
    } else { drive = "/me/drive"; put = `/me/drive/root:/Microsoft%20Teams%20Chat%20Files/${enc(name)}:/content`; }
    const item = await api.json<{ id: string; webUrl?: string; eTag?: string; parentReference?: { driveId?: string } }>("PUT", `${put}?@microsoft.graph.conflictBehavior=rename`, { raw: data, contentType: mime });
    const base = chan ? drive : item.parentReference?.driveId ? `/drives/${enc(item.parentReference.driveId)}` : "/me/drive";
    let link = item.webUrl ?? "";
    try { const l = await api.json<{ link?: { webUrl?: string } }>("POST", `${base}/items/${enc(item.id)}/createLink`, { body: { type: "view", scope: "organization" } }); link = l.link?.webUrl ?? link; }
    catch { /* keep webUrl: recipients may need access */ }
    if (!link) throw new GraphError("Upload gave no link.", "http");
    return { link, eTag: item.eTag };
  }

  /** Re-read a message and push the change (edit / delete / reaction) without waiting for the next poll. */
  private async refresh(chatId: string, messageId: string) {
    try {
      const raw = await this.rawMessage(chatId, messageId, true);
      this.seen.set(`${chatId}|${messageId}`, raw.lastModifiedDateTime ?? "");
      this.emit({ type: "message-update", data: { chatId, messageId, patch: patchOf(this.map(chatId, raw)) } });
    } catch { /* the next poll will deliver it */ }
  }
  async react(chatId: string, messageId: string, emoji: string | null): Promise<void> {
    const api = this.ready(); const p = this.msgPath(chatId, messageId);
    if (emoji) await this.wrap("react", () => api.json("POST", `${p}/setReaction`, { body: { reactionType: emojiToReaction(emoji) } }));
    else {
      const raw = await this.rawMessage(chatId, messageId, true);
      for (const r of raw.reactions ?? []) if (r.user?.user?.id === this.me?.id) await this.wrap("remove the reaction", () => api.json("POST", `${p}/unsetReaction`, { body: { reactionType: r.reactionType } }));
    }
    await this.refresh(chatId, messageId);
  }
  /** Graph pinnedChatMessageInfo: POST /chats/{id}/pinnedMessages (+ DELETE of the info id). Chats only: Graph has no pins for channel messages. Others' pins are learnt through pins(). */
  private pinInfo = new Map<string, string>();
  private async pinList(chatId: string): Promise<{ id: string; message?: GMessage }[]> {
    const l = await this.wrap("read the pinned messages", () => this.ready().all<{ id: string; message?: GMessage }>(`/chats/${enc(chatId)}/pinnedMessages?$expand=message`));
    for (const x of l) if (x.message?.id) this.pinInfo.set(`${chatId}|${x.message.id}`, x.id);
    return l;
  }
  async pin(chatId: string, messageId: string, pinned: boolean): Promise<void> {
    if (splitChan(chatId)) throw new Error("Microsoft Teams cannot pin messages in channels through its API, only in chats.");
    const api = this.ready(), key = `${chatId}|${messageId}`;
    if (pinned) {
      const r = await this.wrap("pin the message", () => api.json<{ id?: string }>("POST", `/chats/${enc(chatId)}/pinnedMessages`, { body: { "message@odata.bind": `${api.base}/chats/${enc(chatId)}/messages/${enc(messageId)}` } }));
      if (r?.id) this.pinInfo.set(key, r.id);
    } else {
      let id = this.pinInfo.get(key);
      if (!id) { await this.pinList(chatId); id = this.pinInfo.get(key); }
      if (!id) throw new Error("That message is not pinned.");
      await this.wrap("unpin the message", () => api.json("DELETE", `/chats/${enc(chatId)}/pinnedMessages/${enc(id!)}`));
      this.pinInfo.delete(key);
    }
    this.emit({ type: "message-update", data: { chatId, messageId, patch: pinned ? { pinned: true, pinnedAt: new Date().toISOString(), pinnedBy: this.me?.id } : { pinned: false } } });
  }
  async pins(chatId: string): Promise<Message[]> {
    if (splitChan(chatId)) return [];
    const out: Message[] = [];
    for (const x of await this.pinList(chatId)) {
      let raw = x.message; if (!raw?.id) continue;
      if (!raw.body) { try { raw = await this.rawMessage(chatId, raw.id); } catch { continue; } } else this.remember(chatId, raw);
      const m = this.map(chatId, raw); if (!m.deleted) out.push({ ...m, pinned: true });
    }
    return out.reverse();
  }
  async edit(chatId: string, messageId: string, newText: string): Promise<void> {
    await this.wrap("edit the message", () => this.ready().json("PATCH", this.msgPath(chatId, messageId), { body: { body: { contentType: "html", content: textToHtml(newText) } } }));
    await this.refresh(chatId, messageId);
  }
  async delete(chatId: string, messageId: string): Promise<void> {
    const api = this.ready(); const me = this.me?.id; if (!me) throw new Error("Not connected yet.");
    const p = splitChan(chatId) ? `${this.msgPath(chatId, messageId)}/softDelete` : `/users/${enc(me)}/chats/${enc(chatId)}/messages/${enc(messageId)}/softDelete`;
    await this.wrap("delete the message", () => api.json("POST", p));
    await this.refresh(chatId, messageId);
  }
  async markRead(chatId: string, _upTo: string): Promise<void> {
    if (splitChan(chatId)) return;   // channels have no read marker in Graph
    const api = this.ready(); const me = this.me?.id; if (!me) return;
    const tenantId = await this.tenantId();
    await this.wrap("mark the chat as read", () => api.json("POST", `/chats/${enc(chatId)}/markChatReadForUser`, { body: { user: { id: me, tenantId } } }));
    const c = this.chatsRaw.get(chatId); if (c) c.viewpoint = { ...c.viewpoint, lastMessageReadDateTime: new Date().toISOString() };
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  private memberBind(handle: string) {
    if (!/^[^\s'"()<>]+$/.test(handle) || !(GUID.test(handle) || /^[^\s@]+@[^\s@]+$/.test(handle))) throw new Error("Enter the person's work email address (user principal name).");
    return { "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `${this.graph().base}/users('${handle}')` };
  }
  private async createChat(chatType: "oneOnOne" | "group", handles: string[], topic?: string): Promise<Chat> {
    const api = this.ready(); const me = this.me?.id; if (!me) throw new Error("Not connected yet.");
    const members = [{ "@odata.type": "#microsoft.graph.aadUserConversationMember", roles: ["owner"], "user@odata.bind": `${api.base}/users('${me}')` }, ...handles.map((h) => this.memberBind(h))];
    let c: GChat;
    try { c = await api.json<GChat>("POST", "/chats", { body: { chatType, ...(topic ? { topic } : {}), members } }); }
    catch (e) { if (e instanceof GraphError && e.kind === "notfound") throw new Error("Nobody with that address was found in your organisation."); if (e instanceof GraphError) throw new Error(`Could not create the chat: ${e.message}.`); throw e; }
    const full = await api.json<GChat>("GET", `/chats/${enc(c.id)}?$expand=members`).catch(() => c);
    this.chatsRaw.set(full.id, full); this.addTarget(full.id, true); this.hot(full.id);
    this.emit({ type: "chats-changed", data: { chatId: full.id } });
    return mapChat(full, this.accountId, me);
  }
  async startChat(handle: string): Promise<Chat> { return this.createChat("oneOnOne", [handle.trim()]); }
  async createGroup(name: string, memberHandles: string[]): Promise<Chat> {
    if (memberHandles.length < 2) throw new Error("A Teams group chat needs at least two other people.");
    return this.createChat("group", memberHandles.map((h) => h.trim()), name.trim() || undefined);
  }
  private async groupOnly(chatId: string): Promise<GChat> {
    if (splitChan(chatId)) throw new Error("Team channels are managed in Teams itself.");
    let c = this.chatsRaw.get(chatId); if (!c?.members) { c = await this.ready().json<GChat>("GET", `/chats/${enc(chatId)}?$expand=members`); this.chatsRaw.set(chatId, c); }
    if (c.chatType !== "group") throw new Error("Only group chats can be changed this way; 1:1 and meeting chats are fixed by Teams.");
    return c;
  }
  async leaveChat(chatId: string): Promise<void> {
    const api = this.ready(); const c = await this.groupOnly(chatId);
    const mine = c.members?.find((m) => m.userId === this.me?.id); if (!mine?.id) throw new Error("Could not find your membership in this chat.");
    await this.wrap("leave the chat", () => api.json("DELETE", `/chats/${enc(chatId)}/members/${enc(mine.id!)}`));
    this.chatsRaw.delete(chatId); this.targets.delete(chatId); this.cursors.delete(chatId);
    this.emit({ type: "chats-changed", data: {} });
  }
  async addMembers(chatId: string, handles: string[]): Promise<void> {
    const api = this.ready(); await this.groupOnly(chatId);
    for (const h of handles) await this.wrap("add the member", () => api.json("POST", `/chats/${enc(chatId)}/members`, { body: { ...this.memberBind(h.trim()), roles: ["owner"], visibleHistoryStartDateTime: "0001-01-01T00:00:00Z" } }));
    this.chatsRaw.delete(chatId); this.emit({ type: "chats-changed", data: { chatId } });
  }
  async removeMember(chatId: string, memberId: string): Promise<void> {
    const api = this.ready(); await this.groupOnly(chatId);
    const ms = await api.all<GMember>(`/chats/${enc(chatId)}/members`); const m = ms.find((x) => x.userId === memberId); if (!m?.id) throw new Error("That person is not in this chat.");
    await this.wrap("remove the member", () => api.json("DELETE", `/chats/${enc(chatId)}/members/${enc(m.id!)}`));
    this.chatsRaw.delete(chatId); this.emit({ type: "chats-changed", data: { chatId } });
  }
  async renameChat(chatId: string, name: string): Promise<void> {
    await this.groupOnly(chatId);
    await this.wrap("rename the chat", () => this.ready().json("PATCH", `/chats/${enc(chatId)}`, { body: { topic: name } }));
    const c = this.chatsRaw.get(chatId); if (c) c.topic = name; this.emit({ type: "chats-changed", data: { chatId } });
  }

  // ---------------------------------------------------------------- avatars + profile
  private async photo(key: string, path: string): Promise<{ data: Uint8Array; mime: string } | undefined> {
    if (this.avatars.has(key)) return this.avatars.get(key) ?? undefined;
    try { const r = await this.ready().bytes(path, { prio: 1 }); const v = r.mime.startsWith("image/") ? r : null; this.avatars.set(key, v); return v ?? undefined; }
    catch (e) { if (e instanceof GraphError && (e.kind === "notfound" || e.kind === "forbidden")) this.avatars.set(key, null); return undefined; }
  }
  async avatar(t: { kind: "chat" | "space" | "contact" | "emoji"; id: string }) {
    if (this.stopped || !this.session) return undefined;
    if (t.kind === "contact") return this.photo("u" + t.id, `/users/${enc(t.id)}/photo/$value`);
    if (t.kind === "space") return this.photo("t" + t.id, `/teams/${enc(t.id)}/photo/$value`);
    if (t.kind === "chat") {
      const c = this.chatsRaw.get(t.id);
      if (c?.chatType === "oneOnOne") { const o = c.members?.find((m) => m.userId && m.userId !== this.me?.id); if (o?.userId) return this.photo("u" + o.userId, `/users/${enc(o.userId)}/photo/$value`); }
    }
    return undefined;
  }
  async getProfile(): Promise<Profile> {
    const api = this.ready(); const me = this.me; const ph = await this.photo("me", "/me/photo/$value");
    let about: string | undefined;
    if (this.has("user.readwrite") && this.granted()) { try { about = (await api.json<{ aboutMe?: string }>("GET", "/me?$select=aboutMe", { prio: 1 }))?.aboutMe || undefined; } catch { /* not readable: fine */ } }
    return { displayName: me?.name, handle: me?.mail, ...(about ? { about } : {}), ...(ph ? { avatar: ph } : {}) };
  }
  /** Own picture (PUT /me/photo/$value) and about-me text (PATCH /me). The display name is managed by the organisation's directory, so it is not offered. */
  async updateProfile(patch: ProfilePatch): Promise<Profile> {
    const api = this.ready();
    if (!this.granted()?.has("user.readwrite")) throw new Error("Changing your profile needs the User.ReadWrite permission: sign in again with the profile box ticked (the app registration needs it too).");
    if (patch.displayName !== undefined) throw new Error("Your name is managed by your organisation and cannot be changed here.");
    if (patch.avatar === null) throw new Error("Microsoft Graph cannot remove a profile picture; upload a new one instead.");
    if (patch.avatar) {
      if (!/^image\/(jpeg|png)$/i.test(patch.avatar.mime)) throw new Error("Use a JPEG or PNG picture.");
      if (patch.avatar.data.length > 4 * 1024 * 1024) throw new Error("That picture is too large (4 MB at most).");
      await this.wrap("change your picture", () => api.json("PUT", "/me/photo/$value", { raw: patch.avatar!.data, contentType: patch.avatar!.mime }));
      this.avatars.delete("me"); this.avatars.set("me", { data: patch.avatar.data, mime: patch.avatar.mime });
    }
    if (patch.about !== undefined) await this.wrap("change your about text", () => api.json("PATCH", "/me", { body: { aboutMe: patch.about!.trim().slice(0, 1000) } }));
    return this.getProfile();
  }

  /** Create a team (Team.Create): Graph answers 202 and builds it asynchronously; we follow the operation until it is done. */
  async createSpace(name: string, description?: string): Promise<Space> {
    const api = this.ready();
    if (!this.granted()?.has("team.create")) throw new Error("Creating teams needs the Team.Create permission: sign in again with the create-teams box ticked (an admin may have to consent).");
    const n = name.trim(); if (n.length < 1 || n.length > 256) throw new Error("A team name has 1 to 256 characters.");
    const h = await this.wrap("create the team", () => api.headers("POST", "/teams", { body: { "template@odata.bind": "https://graph.microsoft.com/v1.0/teamsTemplates('standard')", displayName: n, ...(description?.trim() ? { description: description.trim().slice(0, 1024) } : {}) } }));
    const id = /teams\('?([0-9a-fA-F-]{36})'?\)/.exec(h.get("content-location") ?? h.get("location") ?? "")?.[1];
    const op = /operations\('?([0-9a-fA-F-]{36})'?\)/.exec(h.get("location") ?? "")?.[1];
    if (!id) throw new Error("Microsoft accepted the request but did not say which team it is. Check Teams in a minute.");
    const gap = num("UNIMSG_TEAMS_OP_MS", 2000);
    for (let i = 0; op && i < 20; i++) {
      const o = await api.json<{ status?: string }>("GET", `/teams/${enc(id)}/operations/${enc(op)}`).catch((e) => { if (e instanceof GraphError && e.kind === "notfound") return { status: "inProgress" }; throw e; });
      if (o?.status === "succeeded") break;
      if (o?.status === "failed") throw new Error("Microsoft could not create the team.");
      if (i === 19) throw new Error("The team is still being created; it will appear in a few minutes.");
      await sleep(gap);
    }
    await this.loadTeams().catch(() => {}); if (!this.teams.has(id)) this.teams.set(id, { id, displayName: n } as GTeam);
    this.emit({ type: "spaces-changed", data: {} }); this.emit({ type: "chats-changed", data: {} });
    return mapSpace({ id, displayName: n } as GTeam, this.accountId);
  }
}

const factory: ProviderFactory = {
  name: "teams", displayName: "Microsoft Teams", login: "form", capabilities: CAPABILITIES,
  create: ({ accountId, dataDir }) => new TeamsConnector(accountId, dataDir),
};
export default factory;
void DEFAULT_GRAPH;
