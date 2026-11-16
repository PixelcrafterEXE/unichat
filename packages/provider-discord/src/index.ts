// Discord provider: REST v10 + Gateway v10, own small clients on Node's fetch and `ws`. See README.md (read the user-token warning).
import type {
  Capabilities, Card, Chat, Connector, Contact, CoreEvent, HistoryQuery, LoginPrompt, Message, OutgoingMessage, PrivacySetting, Profile, ProfilePatch, ProviderFactory, Space,
} from "@unimsg/core";
import { Api, DEFAULT_BASE, DEFAULT_CDN, DEFAULT_GATEWAY, DcError, type CaptchaChallenge, dbg, endpoint, newIdentity, type Identity, type Mode } from "./api.js";
import { BOT_INTENTS, Gateway, INTENT } from "./gateway.js";
import {
  CT, P, basePermissions, channelPermissions, emojiKey, emojiPath, emojiText, isChatType, isThread, mapChat, mapMessage, mapReactions, mapSpace, mapPoll, patchOf, previewOf, snowflakeGt, snowflakeTime, userName,
  type DcChannel, type DcEmoji, type DcGuild, type DcMember, type DcMessage, type DcUser, type MediaRef, type MsgCtx,
} from "./map.js";
import { exportPortableSession, importPortableSession, loadIdentity, loadSession, saveIdentity, saveSession, wipeSession, type Session } from "./secret.js";

/** Bot mode (official API). `markRead` only clears Unimsg's local counter (bots have no read state); bots cannot vote in polls or manage group DMs. */
export const CAPABILITIES_BOT: Capabilities = {
  spaces: true, reactions: true, pinMessages: true, edits: true, deletes: true, replies: true, attachments: true, typing: true,
  readReceipts: false, markRead: true, customEmoji: true, mentions: true,
  startChat: true, createGroup: false, backfill: true, fetchHistory: true, e2ee: false,
  leaveChat: true, manageMembers: false, renameChat: false, chatPicture: false, block: false, polls: true, pollVote: false, location: false, contactCards: false,
  voiceNotes: true, avatars: true, refreshChat: false, sync: false, privacy: false, leaveSpace: true, createSpace: false, joinSpace: false,
  // topic needs Manage Channels (the UI only offers it where Chat.canManage); events need Manage/Create Events; bots may change their own name + avatar
  chatDescription: true, events: true, eventEdit: true, profile: { displayName: true, avatar: true },
};
/** User mode: real read acks, poll votes, and group DM management (create / rename / add / remove recipients; server channels are flagged `canManage: false`). */
export const CAPABILITIES_USER: Capabilities = {
  ...CAPABILITIES_BOT, presence: true, pollVote: true, createGroup: true, manageMembers: true, renameChat: true,
  // user accounts only: group DM icon, blocking, own profile incl. bio, the few privacy settings Discord's settings endpoint exposes, new / joined servers
  chatPicture: true, block: true, profile: { displayName: true, about: true, avatar: true }, privacy: true, createSpace: true, joinSpace: true,
};
/** Provider-level defaults (what an account without a session looks like). */
export const CAPABILITIES: Capabilities = CAPABILITIES_BOT;
/** Consent for user mode: the login checkbox sends "true"; "YES" (the old typed confirmation) is still accepted. */
export const isConsent = (v: string | undefined) => /^(true|yes|on|1)$/i.test((v ?? "").trim());

const WARNING =
  "Using your own account's token breaks Discord's Terms of Service and can get the account terminated. Use a throw-away account, or a bot token (allowed, but it only sees servers it was invited to). " +
  "UniChat never asks for your password. Tick the box to confirm.";

const dataUri = (i: { data: Uint8Array; mime: string }) => `data:${i.mime};base64,${Buffer.from(i.data).toString("base64")}`;
interface DcSettings { friend_source_flags?: { all?: boolean; mutual_friends?: boolean; mutual_guilds?: boolean }; default_guilds_restricted?: boolean; explicit_content_filter?: number }
function privacyOf(s: DcSettings): PrivacySetting[] {
  const f = s.friend_source_flags ?? { all: true };
  const fr = f.all ? "everyone" : f.mutual_friends && f.mutual_guilds ? "both" : f.mutual_friends ? "friends_of_friends" : f.mutual_guilds ? "server_members" : "nobody";
  return [
    { id: "dm_new_servers", label: "Direct messages from members of new servers", description: "Applies to servers you join from now on.", value: s.default_guilds_restricted ? "deny" : "allow", options: [{ value: "allow", label: "Allowed" }, { value: "deny", label: "Not allowed" }] },
    { id: "friend_requests", label: "Who can send you friend requests", value: fr, options: [{ value: "everyone", label: "Everyone" }, { value: "both", label: "Friends of friends and server members" }, { value: "friends_of_friends", label: "Friends of friends" }, { value: "server_members", label: "Server members" }, { value: "nobody", label: "Nobody" }] },
    { id: "explicit_filter", label: "Scan direct messages for explicit images", value: String(s.explicit_content_filter ?? 1), options: [{ value: "0", label: "Do not scan" }, { value: "1", label: "Scan messages from people who are not friends" }, { value: "2", label: "Scan all messages" }] },
  ];
}
const sleepers = new Set<() => void>();
const sleep = (ms: number) => new Promise<void>((ok) => { const t = setTimeout(done, ms); function done() { clearTimeout(t); sleepers.delete(done); ok(); } sleepers.add(done); });
const wake = () => { for (const f of [...sleepers]) f(); };
const bounded = <K, V>(m: Map<K, V>, k: K, v: V, max: number) => { m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value as K); };

class DiscordConnector implements Connector {
  /** Read live by the Hub: depends on the login mode of THIS account. */
  get capabilities(): Capabilities { return this.session?.mode === "user" ? CAPABILITIES_USER : CAPABILITIES_BOT; }
  private emit: (e: CoreEvent) => void = () => {};
  private api?: Api;
  private gw?: Gateway;
  private session?: Session;
  private identity?: Identity;
  private me?: DcUser;
  private guilds = new Map<string, DcGuild>();
  private channels = new Map<string, DcChannel>();
  private ownMember = new Map<string, DcMember>();
  private users = new Map<string, DcUser>();
  private unread = new Map<string, number>();
  private previews = new Map<string, string>();
  private lastSeen = new Map<string, string>();
  private raw = new Map<string, DcMessage>();
  private refs = new Map<string, MediaRef>();
  private reactors = new Map<string, Map<string, Set<string>>>();
  private authors = new Map<string, Set<string>>();
  private emojis = new Map<string, { id: string; animated: boolean }>();
  private sent = new Set<string>();
  private typingTimers = new Map<string, NodeJS.Timeout>();
  private typingSentAt = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private stopped = true;
  private everReady = false;
  private promptN = 0;
  private touchTimer?: NodeJS.Timeout;
  private touchChat: string | null | undefined;
  private noContentIntent = false;
  private catchUpWanted = false;
  private awaitingGuilds = new Set<string>();
  private catchUpTimer?: NodeJS.Timeout;

  private readonly accountId: string; private readonly dataDir: string;
  constructor(accountId: string, dataDir: string) { this.accountId = accountId; this.dataDir = dataDir; }

  // ---------------------------------------------------------------- lifecycle
  async start(emit: (e: CoreEvent) => void): Promise<void> {
    this.emit = emit; this.stopped = false;
    this.session = loadSession(this.dataDir);
    if (!this.session) { this.state("needs-login"); this.prompt(); return; }
    this.state("connecting");
    this.begin();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.gw?.stop(); this.gw = undefined; this.api?.close();
    for (const t of this.typingTimers.values()) clearTimeout(t);
    this.typingTimers.clear(); clearTimeout(this.touchTimer); clearTimeout(this.catchUpTimer);
    wake();
  }
  async logout(): Promise<void> {
    // The token belongs to the user (or the bot's owner): there is no remote "log out" for it. Wiping locally is all we can do;
    // README tells the user how to revoke it (reset the bot token / change the account password).
    await this.stop();
    wipeSession(this.dataDir); this.session = undefined; this.api = undefined; this.me = undefined;
  }

  private state(state: "connecting" | "needs-login" | "connected" | "disconnected" | "signed-out", detail?: string) {
    this.emit({ type: "account", data: { id: this.accountId, state, ...(detail ? { detail } : {}) } });
  }
  private err(code: string, message: string, fatal = false) { this.emit({ type: "error", data: { id: this.accountId, code, message, fatal } }); }
  private prompt(error?: string) {
    const p: LoginPrompt = {
      accountId: this.accountId, promptId: `login-${++this.promptN}`, kind: "form", title: "Sign in to Discord with a token you obtained yourself.", ...(error ? { error } : {}),
      warning: { severity: "danger", text: WARNING },
      fields: [
        { name: "mode", label: "Login mode", type: "select", value: "bot", options: [
          { value: "bot", label: "Bot (official, allowed; sees only the servers you invite it to)" },
          { value: "user", label: "My own account (against Discord's rules; sees your servers and DMs)" }] },
        { name: "token", label: "Token", type: "password", help: [
          { title: "How do I get a BOT token?", steps: [
            "Open the Discord Developer Portal and click New Application, give it a name.",
            "Open the Bot tab, click Reset Token and copy the token (you only see it once).",
            "On the same tab switch on Message Content Intent (and optionally Server Members Intent), then save.",
            "Open OAuth2 > URL Generator, tick the scope \"bot\" and the permissions View Channels, Read Message History, Send Messages, Add Reactions, Attach Files; open the generated URL and add the bot to your server.",
            "Paste the token here and choose Bot."], link: { href: "https://discord.com/developers/applications", label: "Open the Discord Developer Portal" } },
          { title: "How do I get my own account's token? (user mode)", steps: [
            "Use a desktop browser, open discord.com/app and log in as usual.",
            "Press F12 to open the developer tools and switch to the Network tab; type \"api\" into the filter box.",
            "In Discord, click on any channel or react to a message so that a request to discord.com/api shows up in the list.",
            "Click one of those requests, open Headers, scroll to Request Headers and copy the value after \"authorization:\" (one long text, without quotes).",
            "Paste it here and choose \"My own account\". Treat it like a password: anyone with it can act as you. Changing your Discord password makes it invalid.",
            "Remember: this is automation of a personal account and can get it suspended. A throw-away account is safer."] },
        ] },
        { name: "confirm", label: "I have read the warning. I understand that a user token violates Discord's Terms of Service and can get the account terminated.", type: "checkbox", required: true },
      ],
    };
    this.emit({ type: "login", data: p });
  }

  // ---------------------------------------------------------------- login
  /**
   * Best-effort: show Discord's hCaptcha to the user through the generic "captcha" login prompt and wait for the solved token (the Api gives up after ~3 min).
   * Discord's hCaptcha site key is configured for discord.com and may refuse to render on other origins; the UI then offers "Open Discord instead".
   */
  private captchas = new Map<string, (token: string | undefined) => void>();
  private askCaptcha(c: CaptchaChallenge): Promise<string | undefined> {
    if (c.service !== "hcaptcha") return Promise.resolve(undefined);
    const promptId = `captcha-${++this.promptN}`;
    return new Promise((ok) => {
      const done = (t: string | undefined) => { if (this.captchas.delete(promptId)) { clearTimeout(timer); ok(t); } };
      const timer = setTimeout(() => done(undefined), 185000);
      this.captchas.set(promptId, done);
      this.emit({ type: "login", data: { accountId: this.accountId, promptId, kind: "captcha", service: "hcaptcha", sitekey: c.sitekey, ...(c.rqdata ? { rqdata: c.rqdata } : {}),
        title: "Discord wants to check that you are human", hint: "Discord asks for this when you message someone new. Solving it lets UniChat continue.", link: { href: "https://discord.com/channels/@me", label: "Open Discord instead" }, expiresAt: Date.now() + 180000 } });
    });
  }
  async submitLogin(promptId: string, v: Record<string, string>): Promise<void> {
    const cap = this.captchas.get(promptId);
    if (cap) { cap((v.token ?? "").trim() || undefined); return; }
    if (promptId.startsWith("captcha-")) return; // late answer after the wait ended: nothing to do
    const mode = (v.mode ?? "").trim().toLowerCase();
    if (mode !== "bot" && mode !== "user") throw new Error('Type "bot" (official bot token) or "user" (your own account token) in the mode field.');
    let token = (v.token ?? "").trim().replace(/^["']|["']$/g, "").replace(/^Bot\s+/i, "");
    if (!token) throw new Error("Paste the token.");
    if (/\s/.test(token)) throw new Error("A Discord token has no spaces; check what you pasted.");
    if (mode === "user" && !isConsent(v.confirm))
      throw new Error("User-token mode violates Discord's Terms of Service and can get the account terminated. To continue anyway, tick the confirmation box.");
    const identity = mode === "user" ? loadIdentity(this.dataDir, newIdentity, false) : undefined;
    const probe = new Api({ base: endpoint("UNIMSG_DISCORD_BASE", DEFAULT_BASE), token, mode, identity, paceMs: 0 });
    let me: DcUser;
    try { me = await probe.get<DcUser>("/users/@me"); }
    catch (e) {
      if (e instanceof DcError && e.kind === "auth") throw new Error(mode === "bot" ? "Discord rejected this bot token. Copy it again from the Developer Portal (Bot > Reset Token); it is only shown once." : "Discord rejected this user token. It may be wrong, expired (it changes when you change your password or log out) or revoked.");
      throw e;
    } finally { probe.close(); }
    this.session = { mode, token, userId: me.id };
    saveSession(this.dataDir, this.session);
    if (identity) saveIdentity(this.dataDir, identity); // only after the token was accepted: the client identity is fixed from now on
    this.stopped = false;
    this.state("connecting");
    this.begin();
  }

  private needsLogin(why: string) {
    if (!this.session) return;
    this.gw?.stop(); this.gw = undefined; this.api?.close();
    wipeSession(this.dataDir); this.session = undefined; this.api = undefined;
    this.state("needs-login", why);
    this.prompt("Discord no longer accepts this token. Please enter a new one.");
  }

  // ---------------------------------------------------------------- connect
  private begin() {
    const s = this.session!;
    this.identity = s.mode === "user" ? loadIdentity(this.dataDir, newIdentity) : undefined;
    const pace = Number(process.env.UNIMSG_DISCORD_PACE_MS ?? (s.mode === "user" ? 700 : 50));
    const api = this.api = new Api({
      base: endpoint("UNIMSG_DISCORD_BASE", DEFAULT_BASE), token: s.token, mode: s.mode, identity: this.identity, paceMs: pace,
      onUnauthorized: () => { if (this.api === api) this.needsLogin("Discord rejected the token"); },
      onCaptcha: (c) => this.askCaptcha(c),
      onCooldown: (ms) => this.err("rate", `Discord asked us to slow down; pausing requests for about ${Math.max(1, Math.round(ms / 1000))} s.`),
    });
    this.startGateway(s);
  }
  private startGateway(s: Session) {
    this.gw?.stop();
    const gw = this.gw = new Gateway({
      url: endpoint("UNIMSG_DISCORD_GATEWAY", DEFAULT_GATEWAY), token: s.token, mode: s.mode, identity: this.identity, zlib: process.env.UNIMSG_DISCORD_ZLIB !== "0",
      intents: BOT_INTENTS | (this.noContentIntent ? 0 : INTENT.MESSAGE_CONTENT),
      onDispatch: (t, d) => { this.chain = this.chain.then(() => this.onEvent(t, d)).catch(() => this.err("event", `Could not handle event "${t}".`)); },
      onUp: (k) => { this.state("connected"); if (k === "ready") this.touch(null); },
      onDown: () => { if (!this.stopped) this.state("disconnected"); },
      onProblem: (m) => this.err("gateway", m),
      onFatal: (why) => {
        if (this.stopped) return false;
        if (why === "auth") { this.needsLogin("Discord rejected the token"); return false; }
        if (why === "intents" && !this.noContentIntent && s.mode === "bot") {
          this.noContentIntent = true; gw.intents &= ~INTENT.MESSAGE_CONTENT;
          this.err("intents", "The Message Content intent is not enabled for this bot (Developer Portal > Bot > Privileged Gateway Intents). Messages in servers will arrive without their text until you enable it.");
          return true;
        }
        this.err("gateway", "Discord refused the connection settings (invalid or disallowed intents / API version).", true);
        this.state("disconnected", "Discord refused the gateway connection");
        return false;
      },
    });
    gw.start();
  }
  private ready(): Api { if (!this.api || !this.me) throw new Error("Not connected to Discord yet."); return this.api; }
  private get userMode() { return this.session?.mode === "user"; }

  // ---------------------------------------------------------------- caches
  private cacheUser(u: DcUser | undefined) { if (u?.id) { this.users.delete(u.id); this.users.set(u.id, { ...this.users.get(u.id), ...u }); if (this.users.size > 8000) this.users.delete(this.users.keys().next().value!); } }
  private registerEmoji = (n: string, id: string, a: boolean) => { this.emojis.set(n, { id, animated: a }); if (this.emojis.size > 5000) this.emojis.delete(this.emojis.keys().next().value!); };
  private mctx(guildId?: string): MsgCtx {
    return {
      me: this.me!.id, accountId: this.accountId,
      user: (id, hint) => { if (hint) this.cacheUser(hint); return hint?.member?.nick || (this.users.get(id) ? userName(this.users.get(id)) : undefined); },
      role: (id) => this.guilds.get(guildId ?? "")?.roles?.find((r) => r.id === id)?.name,
      channel: (id) => this.channels.get(id)?.name,
      emoji: this.registerEmoji,
      known: undefined,
    };
  }
  private ctxFor(m: DcMessage): MsgCtx {
    const x = this.mctx(m.guild_id ?? this.channels.get(m.channel_id)?.guild_id);
    x.known = (key) => { const s = this.reactors.get(m.id)?.get(key); return s ? [...s] : undefined; };
    return x;
  }
  private note(m: DcMessage): Message {
    if (m.author) this.cacheUser(m.author);
    for (const u of m.mentions ?? []) this.cacheUser(u);
    if (m.referenced_message?.author) this.cacheUser(m.referenced_message.author);
    const { msg, refs } = mapMessage(m, this.ctxFor(m));
    bounded(this.raw, m.id, m, 3000);
    for (const [k, r] of refs) bounded(this.refs, `${m.id}/${k}`, r, 6000);
    if (m.author && !msg.system) { let s = this.authors.get(m.channel_id); if (!s) { s = new Set(); bounded(this.authors, m.channel_id, s, 500); } s.add(m.author.id); if (s.size > 300) s.delete(s.values().next().value!); }
    const last = this.lastSeen.get(m.channel_id);
    if (!last || snowflakeGt(m.id, last)) this.lastSeen.set(m.channel_id, m.id);
    return msg;
  }
  private touch(chatId: string | null) {
    this.touchChat = this.touchTimer ? (this.touchChat === chatId ? chatId : null) : chatId;
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = undefined; const c = this.touchChat; this.touchChat = undefined;
      if (this.stopped) return;
      this.emit({ type: "chats-changed", data: c ? { chatId: c } : {} });
    }, 120);
  }

  // ---------------------------------------------------------------- guild / channel state
  private ingestGuild(g0: DcGuild, ownMember?: DcMember) {
    // User-account gateways wrap the server's own fields (name, icon, owner_id...) in `properties`: flatten them so every reader sees a name.
    const props = (g0 as { properties?: Partial<DcGuild> }).properties;
    const g: DcGuild = props ? { ...props, ...g0, name: g0.name ?? props.name ?? "Server", id: g0.id } as DcGuild : g0;
    if (!g.name && !g.unavailable) g.name = "Server";
    const old = this.guilds.get(g.id);
    if (g.unavailable && !g.name) { if (!old) this.guilds.set(g.id, { id: g.id, name: "Server", unavailable: true }); return; }
    const guild: DcGuild = { ...old, ...g, unavailable: g.unavailable ?? false, roles: g.roles ?? old?.roles, emojis: g.emojis ?? old?.emojis };
    delete guild.channels; delete guild.threads;
    this.guilds.set(g.id, guild);
    for (const e of g.emojis ?? []) if (e.id && e.name) this.registerEmoji(e.name, e.id, !!e.animated);
    for (const c of [...(g.channels ?? []), ...(g.threads ?? [])]) { this.channels.set(c.id, { ...c, guild_id: g.id }); this.baseline(c); }
    const m = ownMember ?? (g as { members?: (DcMember & { user?: DcUser })[] }).members?.find((x) => x.user?.id === this.me?.id);
    if (m) this.ownMember.set(g.id, m);
    for (const mem of (g as { members?: DcMember[] }).members ?? []) this.cacheUser(mem.user);
  }
  /** Remember how far each chat had got the first time we saw it, so a later lost session knows what to catch up. */
  private baseline(c: DcChannel) { if (!this.lastSeen.has(c.id)) this.lastSeen.set(c.id, c.last_message_id ?? "0"); }
  private async loadOwnMember(gid: string) {
    if (this.userMode || this.ownMember.has(gid) || !this.me) return; // user mode: never one request per server; the gateway tells us what is visible
    try { this.ownMember.set(gid, await this.api!.get<DcMember>(`/guilds/${gid}/members/${this.me.id}`, 1)); }
    catch (e) { if (e instanceof DcError && e.kind === "auth") throw e; /* unknown: channels stay visible */ }
  }
  private permsOf(ch: DcChannel): bigint | undefined {
    if (!ch.guild_id || !this.me) return undefined;
    const g = this.guilds.get(ch.guild_id), m = this.ownMember.get(ch.guild_id);
    if (!g || (!m && g.owner_id !== this.me.id)) return undefined;
    return channelPermissions(g, ch, ch.parent_id ? this.channels.get(ch.parent_id) : undefined, this.me.id, m);
  }
  private visible(ch: DcChannel): boolean {
    if (!isChatType(ch.type)) return false;
    if (!ch.guild_id) return true;
    if (ch.type === CT.PRIVATE_THREAD) return true; // listed to us = we are in it
    const p = ch.type === CT.PUBLIC_THREAD || ch.type === CT.ANNOUNCEMENT_THREAD ? this.permsOf(this.channels.get(ch.parent_id ?? "") ?? ch) : this.permsOf(ch);
    return p === undefined || (p & P.VIEW_CHANNEL) !== 0n;
  }
  private chatOf(ch: DcChannel): Chat {
    if (ch.recipients) for (const u of ch.recipients) this.cacheUser(u);
    return mapChat(ch, {
      accountId: this.accountId, me: this.me!.id, unread: this.unread.get(ch.id) ?? 0, perms: this.permsOf(ch), parent: ch.parent_id ? this.channels.get(ch.parent_id) : undefined,
      category: isThread(ch.type) ? this.channels.get(this.channels.get(ch.parent_id ?? "")?.parent_id ?? "") : ch.parent_id ? this.channels.get(ch.parent_id) : undefined, preview: this.previews.get(ch.id), user: (id) => this.users.get(id),
    });
  }

  // ---------------------------------------------------------------- gateway events
  private async onEvent(t: string, d: any) {
    if (this.stopped || !d && t !== "RESUMED") return;
    switch (t) {
      case "READY": return this.onReady(d);
      case "GUILD_CREATE": {
        const first = !this.guilds.get(d.id)?.name || this.guilds.get(d.id)?.unavailable;
        this.ingestGuild(d); await this.loadOwnMember(d.id);
        this.awaitingGuilds.delete(d.id); void this.maybeCatchUp();
        if (first || true) { this.emit({ type: "spaces-changed", data: {} }); this.touch(null); }
        return;
      }
      case "GUILD_UPDATE": { this.ingestGuild(d); this.emit({ type: "spaces-changed", data: {} }); this.touch(null); return; }
      case "GUILD_DELETE": {
        if (d.unavailable) return; // outage: keep what we have
        this.guilds.delete(d.id); this.ownMember.delete(d.id);
        for (const [id, c] of this.channels) if (c.guild_id === d.id) { this.channels.delete(id); this.unread.delete(id); }
        this.emit({ type: "spaces-changed", data: {} }); this.touch(null); return;
      }
      case "GUILD_ROLE_CREATE": case "GUILD_ROLE_UPDATE": {
        const g = this.guilds.get(d.guild_id); if (!g || !d.role) return;
        g.roles = [...(g.roles ?? []).filter((r) => r.id !== d.role.id), d.role]; this.touch(null); return;
      }
      case "GUILD_ROLE_DELETE": { const g = this.guilds.get(d.guild_id); if (g) g.roles = (g.roles ?? []).filter((r) => r.id !== d.role_id); this.touch(null); return; }
      case "GUILD_MEMBER_UPDATE": {
        this.cacheUser(d.user);
        if (d.user?.id === this.me?.id) { this.ownMember.set(d.guild_id, { roles: d.roles ?? [], nick: d.nick, communication_disabled_until: d.communication_disabled_until }); this.touch(null); }
        return;
      }
      case "GUILD_EMOJIS_UPDATE": { for (const e of d.emojis ?? []) if (e.id && e.name) this.registerEmoji(e.name, e.id, !!e.animated); return; }
      case "USER_UPDATE": { if (d.id === this.me?.id) this.me = { ...this.me, ...d }; this.cacheUser(d); return; }
      case "CHANNEL_CREATE": case "CHANNEL_UPDATE": case "THREAD_CREATE": case "THREAD_UPDATE": {
        if (d.recipient_ids && !d.recipients) d.recipients = d.recipient_ids.map((id: string) => this.users.get(id) ?? { id, username: "Unknown" });
        this.channels.set(d.id, { ...this.channels.get(d.id), ...d }); this.baseline(d);
        this.touch(d.id); return;
      }
      case "CHANNEL_DELETE": case "THREAD_DELETE": { this.channels.delete(d.id); this.unread.delete(d.id); this.touch(null); return; }
      case "THREAD_LIST_SYNC": { for (const c of d.threads ?? []) this.channels.set(c.id, { ...c, guild_id: d.guild_id }); this.touch(null); return; }
      case "MESSAGE_CREATE": return this.onCreate(d);
      case "MESSAGE_UPDATE": return this.onUpdate(d);
      case "MESSAGE_DELETE": { this.dropMsg(d.id); this.emit({ type: "message-update", data: { chatId: d.channel_id, messageId: d.id, patch: { deleted: true } } }); return; }
      case "MESSAGE_DELETE_BULK": { for (const id of d.ids ?? []) { this.dropMsg(id); this.emit({ type: "message-update", data: { chatId: d.channel_id, messageId: id, patch: { deleted: true } } }); } return; }
      case "MESSAGE_REACTION_ADD": case "MESSAGE_REACTION_REMOVE": return this.onReaction(t === "MESSAGE_REACTION_ADD", d);
      case "MESSAGE_REACTION_REMOVE_ALL": case "MESSAGE_REACTION_REMOVE_EMOJI": return this.onReactionClear(d);
      case "MESSAGE_POLL_VOTE_ADD": case "MESSAGE_POLL_VOTE_REMOVE": return this.onPollVote(t.endsWith("ADD"), d);
      case "MESSAGE_ACK": { // user mode: another client of this account read the chat
        const last = this.channels.get(d.channel_id)?.last_message_id;
        const mentions = Number(d.mention_count) || 0;
        this.unread.set(d.channel_id, mentions || (last && snowflakeGt(last, d.message_id) ? 1 : 0));
        this.touch(d.channel_id); return;
      }
      case "TYPING_START": {
        const uid = d.user_id as string, cid = d.channel_id as string;
        if (!uid || !cid || uid === this.me?.id) return;
        if (d.member?.user) this.cacheUser(d.member.user);
        this.emit({ type: "typing", data: { chatId: cid, senderId: uid, typing: true } });
        const k = cid + "/" + uid; clearTimeout(this.typingTimers.get(k));
        this.typingTimers.set(k, setTimeout(() => this.clearTyping(cid, uid), 9000));
        return;
      }
      case "PRESENCE_UPDATE": return this.onPresence(d?.user?.id, d?.status);
      case "READY_SUPPLEMENTAL": { for (const f of d?.merged_presences?.friends ?? []) this.onPresence(f?.user_id, f?.status); return; } // hypothesis (community docs): initial friend statuses
      default: return; // VOICE_*, ... not exposed
    }
  }
  /** User mode only (a bot gets no presence without the privileged GUILD_PRESENCES intent): friends' status, reported ONLY for people we have a 1:1 DM with (server members are ignored). */
  private presenceOn = true;
  setPresenceEnabled(on: boolean) { this.presenceOn = on; }
  private onPresence(uid?: string, status?: string) {
    if (!this.presenceOn || this.session?.mode !== "user" || !uid || uid === this.me?.id || !status) return;
    const online = status === "online" || status === "idle" || status === "dnd"; // offline / invisible -> false
    for (const [cid, c] of this.channels) if (c.type === CT.DM && c.recipients?.[0]?.id === uid) this.emit({ type: "presence", data: { accountId: this.accountId, chatId: cid, contactId: uid, online } });
  }
  private dropMsg(id: string) { this.raw.delete(id); this.reactors.delete(id); }
  private clearTyping(chatId: string, uid: string) {
    const k = chatId + "/" + uid; const t = this.typingTimers.get(k); if (!t) return;
    clearTimeout(t); this.typingTimers.delete(k);
    this.emit({ type: "typing", data: { chatId, senderId: uid, typing: false } });
  }

  private async onReady(d: any) {
    this.me = d.user; this.cacheUser(d.user);
    for (const u of d.users ?? []) this.cacheUser(u);
    // Channels/guilds of a previous session are dropped on a fresh READY (GUILD_CREATE re-sends them).
    const guilds: DcGuild[] = d.guilds ?? [];
    if (this.everReady) for (const [id, c] of this.channels) if (c.guild_id) this.channels.delete(id); // a fresh session re-sends every server
    const merged: { guild_id?: string; roles?: string[]; nick?: string }[][] = d.merged_members ?? [];
    guilds.forEach((g, i) => {
      const m = merged[i]?.[0]; // hypothesis: user READY lists our own member per guild, aligned with `guilds`
      this.ingestGuild(g, m ? { roles: m.roles ?? [], nick: m.nick } : undefined);
    });
    for (const c of d.private_channels ?? []) {
      if (!c.recipients && c.recipient_ids) c.recipients = c.recipient_ids.map((id: string) => this.users.get(id) ?? { id, username: "Unknown" });
      this.channels.set(c.id, c); this.baseline(c);
    }
    if (this.userMode) {
      const entries: { id: string; last_message_id?: string; mention_count?: number }[] = d.read_state?.entries ?? (Array.isArray(d.read_state) ? d.read_state : []);
      for (const e of entries) {
        const ch = this.channels.get(e.id); const mention = e.mention_count ?? 0;
        const behind = ch?.last_message_id && e.last_message_id && snowflakeGt(ch.last_message_id, e.last_message_id);
        if (mention || behind) this.unread.set(e.id, mention || 1);
      }
    }
    const was = this.everReady; this.everReady = true;
    this.emit({ type: "spaces-changed", data: {} });
    this.touch(null);
    if (!this.userMode) {
      // bots: own member per server (permission-aware channel list), then previews of the most recently active chats
      for (const g of guilds) await this.loadOwnMember(g.id).catch(() => {});
      this.touch(null);
      const recent = [...this.channels.values()].filter((c) => (c.type === 0 || c.type === 5 || c.type === 1) && c.last_message_id && this.visible(c) && !this.previews.has(c.id))
        .sort((a, b) => (snowflakeGt(a.last_message_id!, b.last_message_id!) ? -1 : 1)).slice(0, 15);
      for (const c of recent) {
        try { const l = await this.api!.get<DcMessage[]>(`/channels/${c.id}/messages?limit=1`, 1); if (l[0]) { const m = this.note(l[0]); this.previews.set(c.id, previewOf(m)); } }
        catch (e) { if (e instanceof DcError && e.kind === "auth") return; }
      }
      this.touch(null);
    }
    if (was) {
      this.catchUpWanted = true; this.awaitingGuilds = new Set(guilds.filter((g) => g.unavailable).map((g) => g.id));
      clearTimeout(this.catchUpTimer); this.catchUpTimer = setTimeout(() => { this.awaitingGuilds.clear(); void this.maybeCatchUp(); }, 20000);
      await this.maybeCatchUp();
    }
  }
  private async maybeCatchUp() {
    if (!this.catchUpWanted || this.awaitingGuilds.size > 0 || this.stopped) return;
    this.catchUpWanted = false; clearTimeout(this.catchUpTimer);
    await this.catchUp();
  }

  /** After a lost session (no RESUME possible) fetch what arrived meanwhile in the chats that moved; delivered as historical (no notifications). */
  private async catchUp() {
    const cands = [...this.channels.values()].filter((c) => isChatType(c.type) && c.last_message_id && this.lastSeen.has(c.id) && snowflakeGt(c.last_message_id, this.lastSeen.get(c.id)!) && this.visible(c)).slice(0, this.userMode ? 8 : 25);
    for (const c of cands) {
      try {
        const l = await this.api!.get<DcMessage[]>(`/channels/${c.id}/messages?after=${this.lastSeen.get(c.id)}&limit=50`, 1);
        for (const m of l.sort((a, b) => (snowflakeGt(a.id, b.id) ? 1 : -1))) {
          const msg = this.note(m); this.previews.set(c.id, previewOf(msg) || this.previews.get(c.id) || "");
          if (!msg.fromMe) this.unread.set(c.id, (this.unread.get(c.id) ?? 0) + 1);
          this.emit({ type: "message", data: { ...msg, historical: true } });
        }
      } catch (e) { if (e instanceof DcError && e.kind === "auth") return; }
    }
    this.touch(null);
  }

  private async onCreate(m: DcMessage) {
    if (!this.me) return;
    if (!this.channels.has(m.channel_id)) {
      try { const c = await this.api!.get<DcChannel>(`/channels/${m.channel_id}`, 1); if (!c.recipients && (c as { recipient_ids?: string[] }).recipient_ids) c.recipients = (c as any).recipient_ids.map((id: string) => this.users.get(id) ?? { id, username: "Unknown" }); this.channels.set(c.id, c); this.touch(c.id); }
      catch (e) { if (e instanceof DcError && e.kind === "auth") throw e; return; }
    }
    const ch = this.channels.get(m.channel_id)!;
    ch.last_message_id = m.id;
    const echo = this.sent.delete(m.id);
    const msg = this.note(m);
    const pv = previewOf(msg); if (pv && !msg.system) this.previews.set(m.channel_id, pv);
    if (m.author) this.clearTyping(m.channel_id, m.author.id);
    if (echo) return; // our own send(): the caller already got this message
    if (!msg.fromMe && !msg.system && this.visible(ch)) this.unread.set(m.channel_id, (this.unread.get(m.channel_id) ?? 0) + 1);
    if (msg.fromMe) this.unread.delete(m.channel_id);
    if (!this.visible(ch)) return;
    this.emit({ type: "message", data: msg });
  }

  private async fetchRaw(chatId: string, id: string): Promise<DcMessage | undefined> {
    const c = this.raw.get(id); if (c) return c;
    try { const l = await this.api!.get<DcMessage[]>(`/channels/${chatId}/messages?around=${id}&limit=1`); const m = l.find((x) => x.id === id); if (m) { this.note(m); return m; } } catch (e) { if (e instanceof DcError && e.kind === "auth") throw e; }
    return undefined;
  }

  private async onUpdate(u: Partial<DcMessage> & { id: string; channel_id: string }) {
    const old = this.raw.get(u.id);
    const merged = { ...(old ?? {}), ...u } as DcMessage;
    if (old?.author && !u.author) merged.author = old.author;
    if (u.author) this.cacheUser(u.author);
    for (const x of u.mentions ?? []) this.cacheUser(x);
    bounded(this.raw, u.id, merged, 3000);
    const x = this.ctxFor(merged);
    const { refs } = mapMessage(merged, x);
    for (const [k, r] of refs) bounded(this.refs, `${u.id}/${k}`, r, 6000);
    const patch = patchOf(merged, u, x, old);
    const pv = ("content" in u) ? previewOf(mapMessage(merged, x).msg) : "";
    if (pv && this.channels.get(u.channel_id)?.last_message_id === u.id) { this.previews.set(u.channel_id, pv); this.touch(u.channel_id); }
    if (Object.keys(patch).length) this.emit({ type: "message-update", data: { chatId: u.channel_id, messageId: u.id, patch } });
  }

  private reactionPatch(m: DcMessage) {
    return mapReactions(m.reactions, this.me!.id, this.registerEmoji, (k) => { const s = this.reactors.get(m.id)?.get(k); return s ? [...s] : undefined; }) ?? [];
  }
  private async onReaction(add: boolean, d: { user_id: string; channel_id: string; message_id: string; emoji: DcEmoji; member?: { user?: DcUser } }) {
    this.cacheUser(d.member?.user);
    const m = await this.fetchRaw(d.channel_id, d.message_id); if (!m) return;
    const me = this.me!.id, key = emojiKey(d.emoji);
    const list = (m.reactions ??= []);
    let r = list.find((x) => emojiKey(x.emoji) === key);
    let users = this.reactors.get(m.id); if (!users) { users = new Map(); bounded(this.reactors, m.id, users, 1500); }
    let set = users.get(key); if (!set) { set = new Set(); users.set(key, set); }
    if (add) {
      if (d.user_id === me && r?.me) { /* already counted (fetched after the event) */ }
      else if (set.has(d.user_id)) { /* duplicate */ }
      else if (!r) list.push(r = { count: 1, me: d.user_id === me, emoji: d.emoji });
      else { r.count++; if (d.user_id === me) r.me = true; }
      set.add(d.user_id);
    } else if (r) {
      if (set.has(d.user_id) || d.user_id === me && r.me || r.count > 0) { r.count = Math.max(0, r.count - 1); if (d.user_id === me) r.me = false; }
      set.delete(d.user_id);
      if (r.count === 0) m.reactions = list.filter((x) => x !== r);
    }
    this.emit({ type: "message-update", data: { chatId: d.channel_id, messageId: m.id, patch: { reactions: this.reactionPatch(m) } } });
  }
  private onReactionClear(d: { channel_id: string; message_id: string; emoji?: DcEmoji }) {
    const m = this.raw.get(d.message_id); if (!m) return;
    if (d.emoji) { const k = emojiKey(d.emoji); m.reactions = (m.reactions ?? []).filter((x) => emojiKey(x.emoji) !== k); this.reactors.get(m.id)?.delete(k); }
    else { m.reactions = []; this.reactors.delete(m.id); }
    this.emit({ type: "message-update", data: { chatId: d.channel_id, messageId: m.id, patch: { reactions: this.reactionPatch(m) } } });
  }
  private async onPollVote(add: boolean, d: { user_id: string; channel_id: string; message_id: string; answer_id: number }) {
    const m = await this.fetchRaw(d.channel_id, d.message_id); if (!m?.poll) return;
    const res = (m.poll.results ??= { answer_counts: [] }); const counts = (res.answer_counts ??= []);
    let c = counts.find((x) => x.id === d.answer_id); if (!c) counts.push(c = { id: d.answer_id, count: 0 });
    c.count = Math.max(0, c.count + (add ? 1 : -1)); if (d.user_id === this.me!.id) c.me_voted = add;
    this.emit({ type: "message-update", data: { chatId: d.channel_id, messageId: m.id, patch: { poll: mapPoll(m.poll, this.me!.id) } } });
  }

  // ---------------------------------------------------------------- read
  async spaces(): Promise<Space[]> { this.ready(); return [...this.guilds.values()].filter((g) => !g.unavailable).map((g) => mapSpace(g, this.accountId)); }
  async chats(): Promise<Chat[]> {
    this.ready();
    const cat = (c: DcChannel) => { const p = this.channels.get(isThread(c.type) ? (this.channels.get(c.parent_id ?? "")?.parent_id ?? "") : (c.parent_id ?? "")); return p?.type === CT.CATEGORY ? p : undefined; };
    // the network's own order: uncategorised channels first, then categories by position, channels by position
    const key = (c: DcChannel) => [c.guild_id ?? "", cat(c) ? (cat(c)!.position ?? 0) + 1 : 0, cat(c)?.id ?? "", c.position ?? 0] as const;
    return [...this.channels.values()].filter((c) => this.visible(c) && (c.guild_id ? this.guilds.has(c.guild_id) : true))
      .sort((a, b) => { const x = key(a), y = key(b); return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2].localeCompare(y[2]) || x[3] - y[3] || a.id.localeCompare(b.id); }).map((c) => { const ch = this.chatOf(c), rev = c.type === CT.DM ? c.recipients?.[0]?.avatar : c.type === CT.GROUP_DM ? c.icon : undefined; return rev ? { ...ch, avatarRev: rev } : ch; }); // avatarRev = Discord's avatar / icon hash
  }

  async history(chatId: string, q: HistoryQuery): Promise<Message[]> {
    const api = this.ready();
    const limit = Math.max(1, Math.min(100, q.limit || 50));
    if (q.beforeMessageId && !/^\d+$/.test(q.beforeMessageId)) throw new Error("Unknown message id.");
    if (!/^\d+$/.test(chatId)) throw new Error("Unknown chat.");
    const l = await this.forbid("read this channel's history", () => api.get<DcMessage[]>(`/channels/${chatId}/messages?limit=${limit}${q.beforeMessageId ? `&before=${q.beforeMessageId}` : ""}`));
    return l.sort((a, b) => (snowflakeGt(a.id, b.id) ? 1 : -1)).map((m) => this.note(m));
  }

  /** Servers you share with a person: only user accounts can ask (the profile lists the mutual servers); a bot has no such view. */
  async mutualSpaces(contactId: string): Promise<string[]> {
    const api = this.ready(); if (this.session?.mode !== "user" || !/^\d+$/.test(contactId)) return [];
    const p = await api.get<{ mutual_guilds?: { id: string }[] }>(`/users/${contactId}/profile?with_mutual_guilds=true&with_mutual_friends_count=false`, 1);
    return (p.mutual_guilds ?? []).map((g) => g.id).filter((id) => this.guilds.has(id));
  }

  async members(chatId: string): Promise<Contact[]> {
    const api = this.ready(), me = this.me!.id;
    const ch = this.channels.get(chatId);
    const toContact = (u: DcUser, nick?: string | null): Contact => ({ id: u.id, name: userName(u, nick), handle: "@" + u.username });
    if (ch && (ch.type === CT.DM || ch.type === CT.GROUP_DM)) return [this.me!, ...(ch.recipients ?? [])].map((u) => toContact(u));
    const out = new Map<string, Contact>();
    if (ch?.guild_id && !this.userMode) { // bots: REST member list (needs the privileged Server Members intent; a refusal is fine). One page only.
      try {
        const g = this.guilds.get(ch.guild_id);
        const l = await api.get<(DcMember & { user: DcUser })[]>(`/guilds/${ch.guild_id}/members?limit=100`, 1);
        for (const m of l) {
          this.cacheUser(m.user);
          const p = g ? channelPermissions(g, ch, ch.parent_id ? this.channels.get(ch.parent_id) : undefined, m.user.id, m) : undefined;
          if (p === undefined || p & P.VIEW_CHANNEL) out.set(m.user.id, toContact(m.user, m.nick));
        }
      } catch (e) { if (e instanceof DcError && e.kind === "auth") throw e; }
    }
    for (const id of this.authors.get(chatId) ?? []) { const u = this.users.get(id); if (u && !out.has(id)) out.set(id, toContact(u)); }
    if (!out.has(me)) out.set(me, toContact(this.me!));
    return [...out.values()];
  }

  async downloadAttachment(chatId: string, messageId: string, attachmentId: string) {
    const api = this.ready();
    const get = () => this.refs.get(`${messageId}/${attachmentId}`);
    let ref = get();
    if (!ref) { this.raw.delete(messageId); await this.fetchRaw(chatId, messageId); ref = get(); }
    if (!ref) throw new Error("That attachment is no longer available.");
    try { const r = await api.fetchMedia(ref.url); return { data: r.data, mime: ref.mime || r.mime, ...(ref.name ? { name: ref.name } : {}) }; }
    catch (e) { // signed CDN links expire: refresh the message once and retry
      if (!(e instanceof DcError) || e.kind !== "notfound") throw e;
      this.raw.delete(messageId); this.refs.delete(`${messageId}/${attachmentId}`);
      await this.fetchRaw(chatId, messageId);
      const fresh = get(); if (!fresh) throw new Error("That attachment is no longer available.");
      const r = await api.fetchMedia(fresh.url); return { data: r.data, mime: fresh.mime || r.mime, ...(fresh.name ? { name: fresh.name } : {}) };
    }
  }

  async avatar(t: { kind: "chat" | "space" | "contact" | "emoji"; id: string }) {
    const api = this.ready(); const cdn = endpoint("UNIMSG_DISCORD_CDN", DEFAULT_CDN);
    const userIcon = (u: DcUser | undefined) => (u?.avatar ? `${cdn}/avatars/${u.id}/${u.avatar}.png?size=128` : undefined);
    let url: string | undefined;
    if (t.kind === "emoji") {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(t.id)) return undefined;
      const e = this.emojis.get(t.id) ?? (/^\d+$/.test(t.id) ? { id: t.id, animated: false } : undefined);
      if (e) url = `${cdn}/emojis/${e.id}.${e.animated ? "gif" : "png"}?size=64`;
    } else if (t.kind === "space") {
      const g = this.guilds.get(t.id); if (g?.icon) url = `${cdn}/icons/${g.id}/${g.icon}.png?size=128`;
    } else if (t.kind === "contact") url = userIcon(this.users.get(t.id));
    else {
      const c = this.channels.get(t.id);
      if (c?.type === CT.DM) url = userIcon(c.recipients?.[0]);
      else if (c?.type === CT.GROUP_DM && c.icon) url = `${cdn}/channel-icons/${c.id}/${c.icon}.png?size=128`;
    }
    if (!url) return undefined;
    try { return await api.fetchMedia(url, 1); } catch (e) { if (e instanceof DcError && e.kind !== "auth") return undefined; throw e; }
  }

  // ---------------------------------------------------------------- write
  private forbid<T>(what: string, f: () => Promise<T>): Promise<T> {
    return f().catch((e) => {
      if (e instanceof DcError && e.kind === "forbidden") throw new Error(`Discord refused: you do not have permission to ${what} here.`);
      if (e instanceof DcError && e.kind === "notfound") throw new Error("Discord says this no longer exists (it may have been deleted).");
      throw e;
    });
  }
  /** Outgoing text: `:name:` of a known custom emoji -> <:name:id>; @username of a user we have seen -> <@id>. Nothing else is rewritten. */
  private outText(text: string): string {
    return text
      .replace(/(?<![<\w]):(\w{2,32}):/g, (s, n: string) => { const e = this.emojis.get(n); return e ? `<${e.animated ? "a" : ""}:${n}:${e.id}>` : s; })
      .replace(/(?<![\w<@])@([a-z0-9_.]{2,32})\b/g, (s, n: string) => { for (const u of this.users.values()) if (u.username === n) return `<@${u.id}>`; return s; });
  }

  async send(chatId: string, msg: OutgoingMessage): Promise<Message> {
    const api = this.ready();
    if (!/^\d+$/.test(chatId)) throw new Error("Unknown chat.");
    if (msg.event) return this.sendEvent(chatId, msg);
    // Structured mentions (users only, never roles/@everyone): the `@Name` spans become <@id>; the rest goes through the usual conversions.
    let content = "", at = 0;
    for (const m of [...(msg.mentions ?? [])].sort((a, b) => a.start - b.start)) {
      if (!/^\d{15,22}$/.test(m.id) || m.start < at || (msg.text ?? "")[m.start] !== "@") continue;
      content += this.outText(msg.text.slice(at, m.start)) + `<@${m.id}>`; at = m.start + m.length;
    }
    content += this.outText((msg.text ?? "").slice(at));
    const body: Record<string, unknown> = { content, allowed_mentions: { parse: ["users"], replied_user: true } };
    if (msg.replyToMessageId) body.message_reference = { message_id: msg.replyToMessageId, fail_if_not_exists: false };
    if (msg.poll) {
      if (msg.poll.options.length < 2 || msg.poll.options.length > 10) throw new Error("A Discord poll needs 2 to 10 answers.");
      body.poll = { question: { text: msg.poll.question }, answers: msg.poll.options.map((o) => ({ poll_media: { text: o } })), duration: 24, allow_multiselect: !!msg.poll.multiple, layout_type: 1 };
    }
    if (!content && !msg.attachments?.length && !msg.poll) throw new Error("Nothing to send.");
    const sentOne = () => this.forbid("send messages", async () => {
      if (msg.attachments?.length) {
        // A Discord voice message is ONE audio/ogg attachment with the IS_VOICE_MESSAGE flag, duration and a base64 waveform (bytes 0-255), no text.
        const only = msg.attachments.length === 1 ? msg.attachments[0] : undefined;
        const voice = only && only.kind === "voice" && /^audio\/ogg/i.test(only.mime) && !content && !msg.poll ? only : undefined;
        if (voice) {
          body.flags = 1 << 13;
          body.attachments = [{ id: 0, filename: "voice-message.ogg", duration_secs: Math.max(0.1, (voice.durationMs ?? 1000) / 1000), waveform: Buffer.from((voice.waveform?.length ? voice.waveform : [50]).slice(0, 256).map((v) => Math.max(0, Math.min(255, Math.round(v * 2.55))))).toString("base64") }];
          return api.upload<DcMessage>(`/channels/${chatId}/messages`, body, [{ name: "voice-message.ogg", mime: "audio/ogg", data: voice.data }]);
        }
        body.attachments = msg.attachments.map((a, i) => ({ id: i, filename: a.name || `file${i}` }));
        return api.upload<DcMessage>(`/channels/${chatId}/messages`, body, msg.attachments.map((a, i) => ({ name: a.name || `file${i}`, mime: a.mime, data: a.data })));
      }
      return api.json<DcMessage>("POST", `/channels/${chatId}/messages`, body);
    }).catch((e) => { if (e instanceof DcError && e.status === 413) throw new Error("The file is too large for this server (Discord's upload limit applies)."); throw e; });
    const raw = await sentOne();
    this.sent.add(raw.id); if (this.sent.size > 500) this.sent.delete(this.sent.values().next().value!);
    const m = this.note(raw);
    const c = this.channels.get(chatId); if (c) c.last_message_id = raw.id;
    const pv = previewOf(m); if (pv) this.previews.set(chatId, pv);
    this.unread.delete(chatId);
    return { ...m, status: "sent", fromMe: true };
  }

  private async emojiArg(emoji: string): Promise<string> {
    const custom = /^:(\w{2,32}):$/.exec(emoji);
    if (custom) { const e = this.emojis.get(custom[1]); if (!e) throw new Error("That custom emoji is not known to this account yet."); return encodeURIComponent(`${custom[1]}:${e.id}`); }
    if (!emoji || emoji.length > 32) throw new Error("Unsupported emoji.");
    return encodeURIComponent(emoji);
  }
  async react(chatId: string, messageId: string, emoji: string | null) {
    const api = this.ready();
    if (emoji === null) { // the UI does not say which one: remove all of mine on this message
      const m = await this.fetchRaw(chatId, messageId);
      for (const r of (m?.reactions ?? []).filter((x) => x.me)) await this.forbid("remove reactions", () => api.json("DELETE", `/channels/${chatId}/messages/${messageId}/reactions/${emojiPath(r.emoji)}/@me`));
      return;
    }
    const e = await this.emojiArg(emoji);
    await this.forbid("add reactions", () => api.json("PUT", `/channels/${chatId}/messages/${messageId}/reactions/${e}/@me`));
  }
  /** Pin / unpin (needs Manage Messages in servers; any participant in DMs). The gateway echoes it as MESSAGE_UPDATE {pinned}. */
  async pin(chatId: string, messageId: string, pinned: boolean) {
    const api = this.ready();
    if (!/^\d+$/.test(chatId) || !/^\d+$/.test(messageId)) throw new Error("Unknown message.");
    await this.forbid("pin messages", () => api.json(pinned ? "PUT" : "DELETE", `/channels/${chatId}/pins/${messageId}`));
    const old = this.raw.get(messageId); if (old) this.note({ ...old, pinned });
    this.emit({ type: "message-update", data: { chatId, messageId, patch: pinned ? { pinned: true, pinnedAt: new Date().toISOString(), pinnedBy: this.me?.id } : { pinned: false } } });
  }
  /** The channel's pinned messages (GET /channels/{id}/pins; Discord caps a channel at 50), newest pinned first as Discord lists them. */
  async pins(chatId: string): Promise<Message[]> {
    const api = this.ready();
    if (!/^\d+$/.test(chatId)) throw new Error("Unknown chat.");
    const l = await this.forbid("read the pinned messages", () => api.get<DcMessage[]>(`/channels/${chatId}/pins`));
    return l.map((m) => ({ ...this.note({ ...m, pinned: true }), pinned: true }));
  }
  async edit(chatId: string, messageId: string, newText: string) {
    const raw = await this.forbid("edit this message", () => this.ready().json<DcMessage>("PATCH", `/channels/${chatId}/messages/${messageId}`, { content: this.outText(newText) }));
    this.note({ ...(this.raw.get(messageId) ?? {}), ...raw });
  }
  async delete(chatId: string, messageId: string) { await this.forbid("delete this message", () => this.ready().json("DELETE", `/channels/${chatId}/messages/${messageId}`)); this.dropMsg(messageId); }
  async setTyping(chatId: string, typing: boolean) {
    if (!typing) return;
    const now = Date.now(); if (now - (this.typingSentAt.get(chatId) ?? 0) < 8000) return; // the indicator lasts ~10 s
    this.typingSentAt.set(chatId, now); if (this.typingSentAt.size > 200) this.typingSentAt.delete(this.typingSentAt.keys().next().value!);
    await this.ready().json("POST", `/channels/${chatId}/typing`, undefined, 1).catch((e) => { if (e instanceof DcError && e.kind === "auth") throw e; });
  }
  async markRead(chatId: string, upTo: string) {
    const api = this.ready();
    const n = this.unread.get(chatId) ?? 0;
    if (this.userMode && n > 0 && /^\d+$/.test(upTo)) await api.json("POST", `/channels/${chatId}/messages/${upTo}/ack`, { token: null }, 1); // hypothesis: body shape of the web client
    this.unread.delete(chatId); // bot mode: counters are local only, there is no read state on Discord
    this.touch(chatId);
  }
  async vote(chatId: string, messageId: string, optionIds: string[]) {
    const api = this.ready();
    if (!this.userMode) throw new Error("Discord does not let bots vote in polls.");
    await this.forbid("vote in this poll", () => api.json("PUT", `/channels/${chatId}/polls/${messageId}/answers/@me`, { answer_ids: optionIds.map(String) })); // hypothesis: endpoint used by the web client
  }

  private async resolveUserId(handle: string): Promise<string> {
    const h = handle.trim().replace(/^<@!?(\d+)>$/, "$1").replace(/^@/, "");
    if (!h) throw new Error("Enter a user id, or the username of someone you have already seen in a chat.");
    if (/^\d{15,22}$/.test(h)) return h;
    const lc = h.toLowerCase();
    for (const u of this.users.values()) if (u.id !== this.me?.id && (u.username.toLowerCase() === lc || (u.global_name ?? "").toLowerCase() === lc)) return u.id;
    if (!this.userMode) { // bots: search the servers they are in (a few only)
      for (const g of [...this.guilds.keys()].slice(0, 5)) {
        try { const l = await this.api!.get<{ user: DcUser }[]>(`/guilds/${g}/members/search?query=${encodeURIComponent(h)}&limit=3`, 1); const hit = l.find((x) => x.user.username.toLowerCase() === lc) ?? l[0]; if (hit) { this.cacheUser(hit.user); return hit.user.id; } }
        catch (e) { if (e instanceof DcError && e.kind === "auth") throw e; }
      }
    }
    throw new Error("Discord cannot look people up by name here. Use their numeric user id (Discord settings > Advanced > Developer Mode, then right-click the person > Copy User ID).");
  }
  async startChat(handle: string): Promise<Chat> {
    const api = this.ready();
    const id = await this.resolveUserId(handle);
    const c = await this.forbid("message this person", () => api.json<DcChannel & { recipient_ids?: string[] }>("POST", "/users/@me/channels", { recipient_id: id }));
    if (!c.recipients) c.recipients = [this.users.get(id) ?? { id, username: "Unknown" }];
    this.channels.set(c.id, c);
    this.touch(c.id);
    return this.chatOf(c);
  }
  private groupDm(chatId: string): DcChannel {
    if (!this.userMode) throw new Error("Discord bots cannot manage group DMs.");
    const c = this.channels.get(chatId);
    if (!c || c.type !== CT.GROUP_DM) throw new Error("Only group DMs can be managed from here. Members of a server channel come from the server's roles.");
    return c;
  }
  async createGroup(name: string, memberHandles: string[]): Promise<Chat> {
    if (!this.userMode) throw new Error("Discord bots cannot create group DMs.");
    const api = this.ready(); const ids: string[] = [];
    for (const h of memberHandles) { const id = await this.resolveUserId(h); if (!ids.includes(id)) ids.push(id); }
    if (!ids.length) throw new Error("Pick at least one person.");
    if (ids.length > 9) throw new Error("A Discord group DM holds at most 10 people (including you).");
    const c = await this.forbid("create this group", () => api.json<DcChannel & { recipient_ids?: string[] }>("POST", "/users/@me/channels", { recipients: ids }));
    if (!c.recipients) c.recipients = ids.map((id) => this.users.get(id) ?? { id, username: "Unknown" });
    if (name.trim()) { await this.forbid("rename this group", () => api.json("PATCH", `/channels/${c.id}`, { name: name.trim() })); c.name = name.trim(); }
    this.channels.set(c.id, c); this.touch(c.id);
    return this.chatOf(c);
  }
  async renameChat(chatId: string, name: string) {
    const n = name.trim(); if (!n) throw new Error("Give the group a name.");
    const g = this.channels.get(chatId);
    const c = g?.guild_id && this.userMode && !isThread(g.type) && ((this.permsOf(g) ?? 0n) & P.MANAGE_CHANNELS) ? g : this.groupDm(chatId);
    await this.forbid("rename this " + (c.guild_id ? "channel (needs Manage Channels)" : "group"), () => this.ready().json("PATCH", `/channels/${chatId}`, { name: n })); c.name = n; this.touch(chatId);
  }
  async addMembers(chatId: string, handles: string[]) {
    const c = this.groupDm(chatId);
    for (const h of handles) { const id = await this.resolveUserId(h); if (c.recipients?.some((u) => u.id === id)) continue; await this.forbid("add people to this group", () => this.ready().json("PUT", `/channels/${chatId}/recipients/${id}`, {})); c.recipients = [...(c.recipients ?? []), this.users.get(id) ?? { id, username: "Unknown" }]; }
    this.touch(chatId);
  }
  async removeMember(chatId: string, memberId: string) {
    const c = this.groupDm(chatId); if (!/^\d+$/.test(memberId)) throw new Error("Unknown member.");
    await this.forbid("remove this person (only the group's owner can)", () => this.ready().json("DELETE", `/channels/${chatId}/recipients/${memberId}`));
    c.recipients = (c.recipients ?? []).filter((u) => u.id !== memberId); this.touch(chatId);
  }
  async leaveChat(chatId: string) {
    const api = this.ready(); const c = this.channels.get(chatId);
    if (!c) throw new Error("Unknown chat.");
    if (c.type === CT.DM || c.type === CT.GROUP_DM) await api.json("DELETE", `/channels/${chatId}`); // closes the DM / leaves the group DM
    else if (isThread(c.type)) await this.forbid("leave this thread", () => api.json("DELETE", `/channels/${chatId}/thread-members/@me`));
    else throw new Error("A server channel cannot be left. Leave the whole server instead, or mute the channel in the Discord app.");
    this.channels.delete(chatId); this.unread.delete(chatId);
    this.touch(null);
  }
  // ---- channel topic, group icon -----------------------------------------------------------------------------------------
  private manageable(chatId: string): DcChannel {
    const c = this.channels.get(chatId); if (!c) throw new Error("Unknown chat.");
    if (c.type === CT.DM) throw new Error("A direct message has no description or name to change.");
    if (isThread(c.type)) throw new Error("Threads cannot be changed from here.");
    return c;
  }
  async setChatDescription(chatId: string, text: string) {
    const c = this.manageable(chatId);
    if (!c.guild_id) throw new Error("Group DMs have no description on Discord. Only server channels have a topic.");
    const topic = text.trim().slice(0, c.type === CT.FORUM ? 4096 : 1024);
    await this.forbid("change the topic (needs the Manage Channels permission)", () => this.ready().json("PATCH", `/channels/${chatId}`, { topic: topic || null }));
    c.topic = topic || null; this.touch(chatId);
  }
  async setChatPicture(chatId: string, image: { data: Uint8Array; mime: string } | null) {
    const c = this.groupDm(chatId); // user mode only: server channels have no picture
    if (image && !/^image\/(png|jpe?g|gif|webp)$/i.test(image.mime)) throw new Error("Use a PNG, JPEG, GIF or WebP picture.");
    await this.forbid("change the group picture", () => this.ready().json("PATCH", `/channels/${chatId}`, { icon: image ? dataUri(image) : null }));
    delete c.icon; this.touch(chatId);
  }

  // ---- own profile ------------------------------------------------------------------------------------------------------
  private bio?: string;
  async getProfile(): Promise<Profile> {
    const api = this.ready(), me = this.me!;
    const out: Profile = { displayName: me.global_name || me.username, handle: "@" + me.username };
    if (this.userMode && this.bio === undefined) { // hypothesis: the web client's profile endpoint; an absent bio is fine
      try { const p = await api.get<{ user_profile?: { bio?: string }; user?: { bio?: string } }>(`/users/${me.id}/profile?with_mutual_guilds=false&with_mutual_friends_count=false`, 1); this.bio = p.user_profile?.bio ?? p.user?.bio ?? ""; }
      catch (e) { if (e instanceof DcError && e.kind === "auth") throw e; this.bio = ""; }
    }
    if (this.userMode && this.bio) out.about = this.bio;
    if (me.avatar) { const a = await this.avatar({ kind: "contact", id: me.id }).catch(() => undefined); if (a) out.avatar = a; }
    return out;
  }
  async updateProfile(patch: ProfilePatch): Promise<Profile> {
    const api = this.ready();
    const body: Record<string, unknown> = {};
    if (patch.displayName !== undefined) {
      const n = patch.displayName.trim(); if (!n) throw new Error("Enter a name.");
      if (n.length > 32) throw new Error("A Discord name has at most 32 characters.");
      body[this.userMode ? "global_name" : "username"] = n; // a bot has no display name: its username is the name (Discord limits how often that can change)
    }
    if (patch.avatar !== undefined) {
      if (patch.avatar && !/^image\/(png|jpe?g|gif|webp)$/i.test(patch.avatar.mime)) throw new Error("Use a PNG, JPEG, GIF or WebP picture.");
      body.avatar = patch.avatar ? dataUri(patch.avatar) : null;
    }
    if (patch.about !== undefined && !this.userMode) throw new Error("A bot has no 'about me' text.");
    if (Object.keys(body).length) {
      const u = await this.forbid("change your profile", () => api.json<DcUser>("PATCH", "/users/@me", body));
      this.me = { ...this.me!, ...u }; this.cacheUser(this.me);
    }
    if (patch.about !== undefined) {
      const about = patch.about.trim().slice(0, 190);
      await this.forbid("change your about-me text", () => api.json("PATCH", "/users/@me/profile", { bio: about })); // hypothesis: endpoint of the web client
      this.bio = about;
    }
    return this.getProfile();
  }

  // ---- blocking -----------------------------------------------------------------------------------------------------------
  async blockChat(chatId: string, blocked: boolean) {
    if (!this.userMode) throw new Error("Discord bots cannot block people.");
    const c = this.channels.get(chatId);
    if (!c || c.type !== CT.DM) throw new Error("Only a direct message can be blocked. In a group, block people from the Discord app.");
    const other = c.recipients?.find((u) => u.id !== this.me?.id); if (!other) throw new Error("Unknown person.");
    const api = this.ready();
    if (blocked) await this.forbid("block this person", () => api.json("PUT", `/users/@me/relationships/${other.id}`, { type: 2 }));
    else await this.forbid("unblock this person", () => api.json("DELETE", `/users/@me/relationships/${other.id}`));
    this.touch(chatId);
  }

  // ---- privacy (hypothesis: the legacy user-settings endpoint, fields as the web client's Privacy & Safety page uses them) --------
  async getPrivacy(): Promise<PrivacySetting[]> {
    if (!this.userMode) throw new Error("Only user accounts have privacy settings.");
    return privacyOf(await this.forbid("read your privacy settings", () => this.ready().get<DcSettings>("/users/@me/settings")));
  }
  async setPrivacy(id: string, value: string): Promise<PrivacySetting[]> {
    if (!this.userMode) throw new Error("Only user accounts have privacy settings.");
    const def = privacyOf({}).find((x) => x.id === id); if (!def || !def.options.some((o) => o.value === value)) throw new Error("Unknown privacy setting or value.");
    const body: Record<string, unknown> =
      id === "dm_new_servers" ? { default_guilds_restricted: value === "deny" } :
      id === "friend_requests" ? { friend_source_flags: { all: value === "everyone", mutual_friends: value === "friends_of_friends" || value === "both", mutual_guilds: value === "server_members" || value === "both" } } :
      { explicit_content_filter: Number(value) };
    const s = await this.forbid("change this privacy setting", () => this.ready().json<DcSettings>("PATCH", "/users/@me/settings", body));
    return privacyOf(s ?? {});
  }

  // ---- servers -----------------------------------------------------------------------------------------------------------
  async createSpace(name: string, _description?: string): Promise<Space> {
    if (!this.userMode) throw new Error("Discord bots cannot create servers.");
    const n = name.trim(); if (n.length < 2 || n.length > 100) throw new Error("A server name has 2 to 100 characters.");
    const g = await this.forbid("create a server", () => this.ready().json<DcGuild>("POST", "/guilds", { name: n }));
    this.ingestGuild(g); this.emit({ type: "spaces-changed", data: {} }); this.touch(null);
    return mapSpace(this.guilds.get(g.id) ?? g, this.accountId);
  }
  async joinSpace(invite: string): Promise<Space> {
    if (!this.userMode) throw new Error("A bot cannot join a server by itself: a server admin has to open the bot's OAuth2 invite link.");
    const t = invite.trim();
    const code = /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]{2,32})\/?(?:[?#].*)?$/i.exec(t)?.[1] ?? (/^[A-Za-z0-9-]{2,32}$/.test(t) ? t : "");
    if (!code) throw new Error("That is not a Discord invite. Paste a link like discord.gg/abcdef, or just the code.");
    const r = await this.forbid("join with this invite", () => this.ready().json<{ guild?: DcGuild }>("POST", `/invites/${code}`, {})); // the real service may ask for a captcha: then join in the Discord app
    if (!r?.guild?.id) throw new Error("Discord did not say which server you joined. It may need a confirmation in the Discord app.");
    this.ingestGuild({ ...r.guild, name: r.guild.name ?? "Server" }); this.emit({ type: "spaces-changed", data: {} }); this.touch(null);
    return mapSpace(this.guilds.get(r.guild.id)!, this.accountId);
  }

  // ---- scheduled events ------------------------------------------------------------------------------------------------------
  private eventBody(e: { name?: string; description?: string; start?: string; end?: string; place?: string; videoCall?: boolean }, create: boolean): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    if (e.name !== undefined) b.name = e.name.slice(0, 100);
    if (e.description !== undefined) b.description = e.description.slice(0, 1000);
    const iso = (v: string) => { const t = Date.parse(v); if (!Number.isFinite(t)) throw new Error("That date is not valid."); return new Date(t).toISOString(); };
    if (e.start !== undefined) b.scheduled_start_time = iso(e.start);
    if (create) { // an external event (no voice channel) needs a place and an end time
      const st = Date.parse(e.start ?? ""); const end = e.end ? Date.parse(e.end) : st + 3600_000;
      if (!Number.isFinite(st) || !Number.isFinite(end) || end <= st) throw new Error("The end must be after the start.");
      b.scheduled_end_time = new Date(end).toISOString(); b.privacy_level = 2; b.entity_type = 3;
      b.entity_metadata = { location: (e.place || (e.videoCall ? "Online" : "To be announced")).slice(0, 100) };
    } else {
      if (e.end !== undefined) b.scheduled_end_time = iso(e.end);
      if (e.place !== undefined) b.entity_metadata = { location: e.place.slice(0, 100) };
    }
    return b;
  }
  private eventCard(guildId: string, ev: { id: string; name: string; description?: string | null; scheduled_start_time: string; scheduled_end_time?: string | null; entity_metadata?: { location?: string } | null; status?: number }): Card {
    return {
      kind: "event", title: ev.name, ...(ev.description ? { body: ev.description } : {}), when: new Date(ev.scheduled_start_time).toISOString(),
      ...(ev.scheduled_end_time ? { until: new Date(ev.scheduled_end_time).toISOString() } : {}), ...(ev.entity_metadata?.location ? { place: ev.entity_metadata.location } : {}),
      url: `https://discord.com/events/${guildId}/${ev.id}`, ...(ev.status === 4 ? { canceled: true } : {}), editable: true,
    };
  }
  private async sendEvent(chatId: string, msg: OutgoingMessage): Promise<Message> {
    const api = this.ready(), e = msg.event!;
    const ch = this.channels.get(chatId);
    if (!ch?.guild_id) throw new Error("Events belong to a server. Open a server channel to create one.");
    const ev = await this.forbid("create events in this server (needs Manage Events)", () => api.json<any>("POST", `/guilds/${ch.guild_id}/scheduled-events`, this.eventBody(e, true)));
    const card = this.eventCard(ch.guild_id, ev);
    const m = await this.send(chatId, { ...msg, event: undefined, text: [msg.text, card.url].filter(Boolean).join("\n") });
    return { ...m, card, cards: [card] };
  }
  async editEvent(chatId: string, messageId: string, patch: { name?: string; description?: string; start?: string; end?: string; place?: string; canceled?: boolean }) {
    const api = this.ready();
    const raw = await this.fetchRaw(chatId, messageId);
    const ref = /discord\.com\/events\/(\d+)\/(\d+)/.exec(raw?.content ?? "");
    if (!ref) throw new Error("That message does not hold a Discord event.");
    const body = this.eventBody(patch, false); if (patch.canceled) body.status = 4; // 4 = canceled
    if (!Object.keys(body).length) return;
    const ev = await this.forbid("change this event (needs Manage Events)", () => api.json<any>("PATCH", `/guilds/${ref[1]}/scheduled-events/${ref[2]}`, body));
    const card = this.eventCard(ref[1], ev);
    this.emit({ type: "message-update", data: { chatId, messageId, patch: { card, cards: [card] } } });
  }


  async leaveSpace(spaceId: string) {
    await this.ready().json("DELETE", `/users/@me/guilds/${spaceId}`);
    this.guilds.delete(spaceId); this.ownMember.delete(spaceId);
    for (const [id, c] of this.channels) if (c.guild_id === spaceId) { this.channels.delete(id); this.unread.delete(id); }
    this.emit({ type: "spaces-changed", data: {} }); this.touch(null);
  }
}

const factory: ProviderFactory = {
  name: "discord", displayName: "Discord", login: "form", capabilities: CAPABILITIES,
  create: ({ accountId, dataDir }) => new DiscordConnector(accountId, dataDir),
  exportSession: async (dir) => exportPortableSession(dir),
  importSession: async (dir) => importPortableSession(dir),
};
export default factory;
void basePermissions; void emojiText; void snowflakeTime; void dbg; void sleep;
