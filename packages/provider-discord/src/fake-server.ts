// In-process fake Discord for the offline tests: REST v10 (http) + Gateway v10 (ws, optional zlib-stream) on 127.0.0.1.
// It speaks the protocol as documented/remembered; it is NOT the real service. Tokens, ids and texts are fixtures.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createDeflate, constants as Z } from "node:zlib";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { DcChannel, DcGuild, DcMessage, DcUser } from "./map.js";

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const EPOCH = 1420070400000n;
let seq = 0n;
export const snow = () => String(((BigInt(Date.now()) - EPOCH) << 22n) + ++seq);
export const bits = (...b: number[]) => String(b.reduce((a, x) => a | (1n << BigInt(x)), 0n));
export const PERM = { VIEW: 10, SEND: 11, HISTORY: 16, REACT: 6, ATTACH: 15, ADMIN: 3, MANAGE_MSG: 13 };

export interface FakeOpts { zlib?: boolean; contentIntent?: boolean; heartbeatMs?: number; ackHeartbeats?: boolean }
export interface Req { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any }
interface Sess { ws: WebSocket; token: string; mode: "bot" | "user"; userId: string; intents: number; id: string; send(op: number, d: unknown, t?: string): void }

export class FakeDiscord {
  readonly users = new Map<string, DcUser>();
  readonly guilds = new Map<string, DcGuild & { members: { user: DcUser; roles: string[]; nick?: string }[] }>();
  readonly channels = new Map<string, DcChannel>();
  readonly messages = new Map<string, DcMessage[]>();
  readonly tokens = new Map<string, { mode: "bot" | "user"; userId: string }>();
  readonly log: Req[] = [];
  readonly sessions = new Map<string, Sess>();
  readonly known = new Map<string, { userId: string; seq: number }>(); // session ids that may RESUME
  readonly identifies: { intents?: number; mode: string; capabilities?: number; hasProps: boolean }[] = [];
  readonly resumes: string[] = [];
  readonly acks: string[] = [];
  inflight = 0; maxInflight = 0; stamps: number[] = [];
  rateLimitNext = 0; rateLimitBody: "json" | "html" = "json";
  failNext = 0;
  membersIntent = false;
  blockedChannels = new Set<string>(); // POST -> 403 ("manage:<channel>": PATCH channel -> 403, "events:<guild>": scheduled events -> 403)
  readonly bios = new Map<string, string>();
  readonly relationships = new Map<string, number>();
  readonly invites = new Map<string, string>();
  readonly events = new Map<string, any>();
  settings: Record<string, any> = { friend_source_flags: { all: true }, default_guilds_restricted: false, explicit_content_filter: 1 };
  canResume = true;
  invalidSessionNext = false;
  url = ""; wsUrl = "";
  private srv!: Server; private wss!: WebSocketServer;
  private reactions = new Map<string, Map<string, Set<string>>>();
  readonly opts: FakeOpts;
  constructor(opts: FakeOpts = {}) { this.opts = opts; }

  // ------------------------------------------------------------ fixtures
  user(id: string, username: string, global_name?: string): DcUser { const u: DcUser = { id, username, ...(global_name ? { global_name } : {}), avatar: id.endsWith("1") ? "abcdef" : null }; this.users.set(id, u); return u; }
  token(tok: string, mode: "bot" | "user", userId: string) { this.tokens.set(tok, { mode, userId }); }
  guild(id: string, name: string, owner: string, roles: { id: string; name: string; permissions: string }[] = []) {
    const g = { id, name, owner_id: owner, icon: "ic0n", roles: [{ id, name: "@everyone", permissions: bits(PERM.VIEW, PERM.SEND, PERM.HISTORY, PERM.REACT, PERM.ATTACH) }, ...roles], emojis: [], members: [] } as any;
    this.guilds.set(id, g); return g as DcGuild & { members: { user: DcUser; roles: string[]; nick?: string }[] };
  }
  channel(c: DcChannel): DcChannel { this.channels.set(c.id, c); if (!this.messages.has(c.id)) this.messages.set(c.id, []); return c; }
  member(gid: string, uid: string, roles: string[] = [], nick?: string) { this.guilds.get(gid)!.members.push({ user: this.users.get(uid)!, roles, ...(nick ? { nick } : {}) }); }
  say(channelId: string, authorId: string, content: string, extra: Partial<DcMessage> = {}): DcMessage {
    const ch = this.channels.get(channelId)!;
    const m: DcMessage = { id: snow(), channel_id: channelId, ...(ch.guild_id ? { guild_id: ch.guild_id } : {}), author: this.users.get(authorId)!, content, timestamp: new Date().toISOString(), type: 0, mentions: [], attachments: [], embeds: [], ...extra };
    this.messages.get(channelId)!.push(m); ch.last_message_id = m.id; return m;
  }
  guildsFor(userId: string) { return [...this.guilds.values()].filter((g) => g.owner_id === userId || g.members.some((m) => m.user.id === userId)); }
  private guildPayload(g: DcGuild & { members: any[] }, withMembers = true) {
    const chans = [...this.channels.values()].filter((c) => c.guild_id === g.id && ![10, 11, 12].includes(c.type)).map(({ guild_id: _g, ...c }) => c);
    const threads = [...this.channels.values()].filter((c) => c.guild_id === g.id && [10, 11, 12].includes(c.type)).map(({ guild_id: _g, ...c }) => c);
    return { id: g.id, name: g.name, icon: g.icon, owner_id: g.owner_id, roles: g.roles, emojis: g.emojis, channels: chans, threads, ...(withMembers ? { members: g.members.slice(0, 2) } : {}) };
  }

  // ------------------------------------------------------------ gateway
  dispatch(t: string, d: unknown, filter?: (s: Sess) => boolean) { for (const s of this.sessions.values()) if (!filter || filter(s)) s.send(0, d, t); }
  dropGateway(code = 1006) { for (const s of [...this.sessions.values()]) { try { s.ws.close(code === 1006 ? 4000 : code); } catch { /* ignore */ } } }
  killGatewayHard() { for (const s of [...this.sessions.values()]) s.ws.terminate(); }
  private seqOf = new Map<string, number>();

  // ------------------------------------------------------------ http
  reqs(re: RegExp) { return this.log.filter((r) => re.test(`${r.method} ${r.path}`)); }
  async start() {
    this.srv = createServer((req, res) => { this.inflight++; this.maxInflight = Math.max(this.maxInflight, this.inflight); res.on("close", () => { this.inflight--; }); void this.http(req, res); });
    this.wss = new WebSocketServer({ server: this.srv });
    this.wss.on("connection", (ws, req) => this.gateway(ws, req));
    await new Promise<void>((ok) => this.srv.listen(0, "127.0.0.1", ok));
    const port = (this.srv.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${port}`; this.wsUrl = `ws://127.0.0.1:${port}`;
  }
  async close() { for (const s of this.sessions.values()) s.ws.terminate(); this.wss.close(); this.srv.close(); this.srv.closeAllConnections(); }

  private authed(req: IncomingMessage) {
    const h = req.headers.authorization ?? "";
    const bot = h.startsWith("Bot ");
    const t = this.tokens.get(bot ? h.slice(4) : h);
    return t && (t.mode === "bot") === bot ? t : undefined;
  }
  private json(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(body === undefined ? "" : JSON.stringify(body));
  }
  private async http(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.url);
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    const ct = String(req.headers["content-type"] ?? "");
    if (url.pathname.startsWith("/cdn/")) { // media: no auth header must be sent
      this.log.push({ method: "GET", path: url.pathname, query: url.searchParams, headers: req.headers as any, body: undefined });
      res.writeHead(200, { "content-type": url.pathname.endsWith(".mp4") ? "video/mp4" : url.pathname.endsWith(".gif") ? "image/gif" : "image/png" }); res.end(PNG); return;
    }
    let body: any;
    if (ct.startsWith("application/json") && buf.length) body = JSON.parse(buf.toString("utf8"));
    else if (ct.startsWith("multipart/form-data")) {
      const fd = await new Response(buf, { headers: { "content-type": ct } }).formData();
      const files: { name: string; type: string; size: number }[] = [];
      for (const [k, v] of fd.entries()) if (typeof v !== "string") files.push({ name: `${k}:${(v as File).name}`, type: (v as File).type, size: (v as File).size });
      body = { ...JSON.parse(String(fd.get("payload_json") ?? "{}")), __files: files };
    }
    const path = url.pathname.replace(/^\/api\/v10/, "");
    this.stamps.push(Date.now());
    this.log.push({ method: req.method!, path, query: url.searchParams, headers: req.headers as any, body });
    if (this.rateLimitNext > 0) {
      this.rateLimitNext--;
      if (this.rateLimitBody === "html") { res.writeHead(429, { "content-type": "text/html", "retry-after": "0" }); res.end("<html>Cloudflare</html>"); return; }
      return this.json(res, 429, { message: "You are being rate limited.", retry_after: 0.05, global: false }, { "retry-after": "1", "x-ratelimit-global": "false" });
    }
    if (this.failNext > 0) { this.failNext--; return this.json(res, 500, { message: "boom SECRET-SERVER-TEXT" }); }
    const who = this.authed(req);
    if (!who) return this.json(res, 401, { message: "401: Unauthorized", code: 0 });
    const me = who.userId;
    const m = (re: RegExp) => re.exec(path);
    let r: RegExpExecArray | null;
    const q = url.searchParams, method = req.method!;
    const chan = (id: string) => this.channels.get(id);
    if (method === "GET" && path === "/users/@me") return this.json(res, 200, this.users.get(me));
    if (method === "GET" && (r = m(/^\/guilds\/(\d+)\/members\/search$/))) {
      const qq = (q.get("query") ?? "").toLowerCase();
      return this.json(res, 200, this.guilds.get(r[1])!.members.filter((x) => x.user.username.toLowerCase().startsWith(qq)).map((x) => ({ user: x.user, roles: x.roles })));
    }
    if (method === "GET" && (r = m(/^\/guilds\/(\d+)\/members\/(\d+)$/))) {
      const mem = this.guilds.get(r[1])?.members.find((x) => x.user.id === r![2]);
      return mem ? this.json(res, 200, { user: mem.user, roles: mem.roles, nick: mem.nick }) : this.json(res, 404, { message: "Unknown Member", code: 10007 });
    }
    if (method === "GET" && (r = m(/^\/guilds\/(\d+)\/members$/))) {
      if (!this.membersIntent) return this.json(res, 403, { message: "Missing Access", code: 50001 });
      return this.json(res, 200, this.guilds.get(r[1])!.members.map((x) => ({ user: x.user, roles: x.roles, nick: x.nick })));
    }
    if (method === "POST" && path === "/users/@me/channels" && Array.isArray(body.recipients)) { // group DM (user accounts only)
      if (who.mode !== "user") return this.json(res, 403, { message: "Missing Access", code: 50001 });
      const g = this.channel({ id: snow(), type: 3, owner_id: me, recipients: body.recipients.map((i: string) => this.users.get(String(i))!).filter(Boolean), last_message_id: null });
      this.dispatch("CHANNEL_CREATE", { ...g, recipients: g.recipients }); return this.json(res, 200, g);
    }
    if (method === "PATCH" && (r = m(/^\/channels\/(\d+)$/))) {
      const c = chan(r[1]); if (!c) return this.json(res, 404, { message: "Unknown Channel", code: 10003 });
      if (this.blockedChannels.has("manage:" + c.id)) return this.json(res, 403, { message: "Missing Permissions", code: 50013 });
      for (const k of ["name", "topic", "icon"] as const) if (k in body) (c as any)[k] = body[k];
      this.dispatch("CHANNEL_UPDATE", c); return this.json(res, 200, c);
    }
    if (method === "PATCH" && path === "/users/@me") { const u = this.users.get(me)!; for (const k of ["username", "global_name", "avatar"]) if (k in body) (u as any)[k] = body[k]; this.dispatch("USER_UPDATE", u); return this.json(res, 200, u); }
    if (method === "PATCH" && path === "/users/@me/profile") { if (who.mode !== "user") return this.json(res, 403, { message: "Missing Access", code: 50001 }); this.bios.set(me, body.bio ?? ""); return this.json(res, 200, { bio: body.bio ?? "" }); }
    if (method === "GET" && (r = m(/^\/users\/(\d+)\/profile$/))) return who.mode === "user" ? this.json(res, 200, { user_profile: { bio: this.bios.get(r[1]) ?? "" }, mutual_guilds: this.guildsFor(me).filter((g) => g.owner_id === r![1] || g.members.some((x) => x.user.id === r![1])).map((g) => ({ id: g.id, nick: null })) }) : this.json(res, 403, { message: "Missing Access", code: 50001 });
    if ((r = m(/^\/users\/@me\/relationships\/(\d+)$/))) {
      if (who.mode !== "user") return this.json(res, 403, { message: "Missing Access", code: 50001 });
      if (method === "PUT") this.relationships.set(r[1], body.type); else this.relationships.delete(r[1]);
      return this.json(res, 204);
    }
    if (path === "/users/@me/settings") {
      if (who.mode !== "user") return this.json(res, 403, { message: "Missing Access", code: 50001 });
      if (method === "PATCH") Object.assign(this.settings, body);
      return this.json(res, 200, this.settings);
    }
    if (method === "POST" && path === "/guilds") {
      if (who.mode !== "user") return this.json(res, 403, { message: "Missing Access", code: 50001 });
      const g = this.guild(snow(), String(body.name), me); this.member(g.id, me);
      this.dispatch("GUILD_CREATE", this.guildPayload(g, false), (s) => s.userId === me); return this.json(res, 201, this.guildPayload(g, false));
    }
    if (method === "POST" && (r = m(/^\/invites\/([A-Za-z0-9-]+)$/))) {
      if (who.mode !== "user") return this.json(res, 403, { message: "Missing Access", code: 50001 });
      const gid = this.invites.get(r[1]); const g = gid ? this.guilds.get(gid) : undefined;
      if (!g) return this.json(res, 404, { message: "Unknown Invite", code: 10006 });
      if (!g.members.some((x) => x.user.id === me)) this.member(g.id, me);
      this.dispatch("GUILD_CREATE", this.guildPayload(g, false), (s) => s.userId === me);
      return this.json(res, 200, { code: r[1], guild: { id: g.id, name: g.name, icon: g.icon } });
    }
    if ((r = m(/^\/guilds\/(\d+)\/scheduled-events(?:\/(\d+))?$/))) {
      if (!this.guilds.has(r[1])) return this.json(res, 404, { message: "Unknown Guild", code: 10004 });
      if (this.blockedChannels.has("events:" + r[1])) return this.json(res, 403, { message: "Missing Permissions", code: 50013 });
      if (method === "POST") { const ev = { id: snow(), guild_id: r[1], status: 1, ...body }; this.events.set(ev.id, ev); return this.json(res, 200, ev); }
      const ev = this.events.get(r[2] ?? ""); if (!ev) return this.json(res, 404, { message: "Unknown Guild Scheduled Event", code: 10070 });
      if (method === "PATCH") { Object.assign(ev, body); return this.json(res, 200, ev); }
    }
    if ((r = m(/^\/channels\/(\d+)\/recipients\/(\d+)$/))) {
      const c = chan(r[1]); if (!c || c.type !== 3) return this.json(res, 404, { message: "Unknown Channel", code: 10003 });
      if (method === "PUT") c.recipients = [...(c.recipients ?? []), this.users.get(r[2])!]; else c.recipients = (c.recipients ?? []).filter((u) => u.id !== r![2]);
      this.dispatch("CHANNEL_UPDATE", c); return this.json(res, 204);
    }
    if (method === "POST" && path === "/users/@me/channels") {
      const rid = String(body.recipient_id);
      if (!this.users.has(rid)) return this.json(res, 400, { message: "Invalid Recipient(s)", code: 50033 });
      let dm = [...this.channels.values()].find((c) => c.type === 1 && c.recipients?.some((u) => u.id === rid));
      if (!dm) dm = this.channel({ id: snow(), type: 1, recipients: [this.users.get(rid)!], last_message_id: null });
      return this.json(res, 200, dm);
    }
    if (method === "DELETE" && (r = m(/^\/users\/@me\/guilds\/(\d+)$/))) { this.guilds.delete(r[1]); this.dispatch("GUILD_DELETE", { id: r[1] }); return this.json(res, 204); }
    if (method === "GET" && (r = m(/^\/channels\/(\d+)$/))) { const c = chan(r[1]); return c ? this.json(res, 200, c) : this.json(res, 404, { message: "Unknown Channel", code: 10003 }); }
    if (method === "DELETE" && (r = m(/^\/channels\/(\d+)$/))) { this.channels.delete(r[1]); return this.json(res, 200, {}); }
    if (method === "DELETE" && (r = m(/^\/channels\/(\d+)\/thread-members\/@me$/))) return this.json(res, 204);
    if (method === "POST" && (r = m(/^\/channels\/(\d+)\/typing$/))) return this.json(res, 204);
    if ((r = m(/^\/channels\/(\d+)\/messages$/))) {
      const c = chan(r[1]); if (!c) return this.json(res, 404, { message: "Unknown Channel", code: 10003 });
      if (method === "GET") {
        const all = this.messages.get(c.id) ?? [];
        const lim = Math.min(100, Number(q.get("limit") ?? 50));
        const big = (a: string, b: string) => BigInt(a) > BigInt(b);
        let list = [...all];
        if (q.get("before")) list = list.filter((x) => big(q.get("before")!, x.id));
        if (q.get("after")) list = list.filter((x) => big(x.id, q.get("after")!));
        if (q.get("around")) { const i = list.findIndex((x) => x.id === q.get("around")); list = i < 0 ? [] : list.slice(Math.max(0, i - Math.floor(lim / 2)), i + Math.ceil(lim / 2)); return this.json(res, 200, list.reverse()); }
        const page = q.get("after") ? list.slice(0, lim) : list.slice(-lim);
        return this.json(res, 200, page.reverse());
      }
      if (method === "POST") {
        if (this.blockedChannels.has(c.id)) return this.json(res, 403, { message: "Missing Permissions", code: 50013 });
        const msg = this.say(c.id, me, body.content ?? "", {
          ...(body.message_reference ? { message_reference: body.message_reference, referenced_message: this.messages.get(c.id)!.find((x) => x.id === body.message_reference.message_id) ?? null, type: 19 } : {}),
          ...(body.flags ? { flags: body.flags } : {}),
          ...(body.__files ? { attachments: body.__files.map((f: any, i: number) => ({ id: snow(), filename: f.name.split(":")[1], content_type: f.type, size: f.size, url: `${this.url}/cdn/attachments/${i}/${f.name.split(":")[1]}`,
            ...(body.attachments?.[i]?.duration_secs ? { duration_secs: body.attachments[i].duration_secs, waveform: body.attachments[i].waveform } : {}) })) } : {}),
          ...(body.poll ? { poll: { question: body.poll.question, answers: body.poll.answers.map((a: any, i: number) => ({ answer_id: i + 1, poll_media: a.poll_media })), allow_multiselect: body.poll.allow_multiselect, results: { is_finalized: false, answer_counts: [] } } } : {}),
        });
        this.dispatch("MESSAGE_CREATE", msg);
        return this.json(res, 200, msg);
      }
    }
    if ((r = m(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
      const list = this.messages.get(r[1]) ?? []; const msg = list.find((x) => x.id === r![2]);
      if (!msg) return this.json(res, 404, { message: "Unknown Message", code: 10008 });
      if (method === "PATCH") {
        if (msg.author?.id !== me) return this.json(res, 403, { message: "Cannot edit a message authored by another user", code: 50005 });
        msg.content = body.content; msg.edited_timestamp = new Date().toISOString(); this.dispatch("MESSAGE_UPDATE", msg); return this.json(res, 200, msg);
      }
      if (method === "DELETE") {
        if (msg.author?.id !== me) return this.json(res, 403, { message: "Missing Permissions", code: 50013 });
        this.messages.set(r[1], list.filter((x) => x !== msg)); this.dispatch("MESSAGE_DELETE", { id: msg.id, channel_id: r[1] }); return this.json(res, 204);
      }
    }
    if (method === "POST" && (r = m(/^\/channels\/(\d+)\/messages\/(\d+)\/ack$/))) { this.acks.push(`${r[1]}/${r[2]}`); this.dispatch("MESSAGE_ACK", { channel_id: r[1], message_id: r[2], mention_count: 0 }, (s) => s.mode === "user"); return this.json(res, 200, {}); }
    if ((r = m(/^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/([^/]+)\/@me$/))) {
      const msg = (this.messages.get(r[1]) ?? []).find((x) => x.id === r![2]);
      if (!msg) return this.json(res, 404, { message: "Unknown Message", code: 10008 });
      const name = decodeURIComponent(r[3]); const [en, eid] = name.split(":");
      const emoji = eid ? { id: eid, name: en } : { id: null, name: en };
      const rx = (msg.reactions ??= []); let e = rx.find((x) => (x.emoji.id ?? null) === (emoji.id ?? null) && x.emoji.name === emoji.name);
      if (method === "PUT") { if (!e) rx.push(e = { count: 0, me: false, emoji }); if (!e.me) { e.count++; e.me = true; } this.dispatch("MESSAGE_REACTION_ADD", { user_id: me, channel_id: r[1], message_id: r[2], emoji }); }
      else if (method === "DELETE" && e) { e.count--; e.me = false; if (e.count <= 0) msg.reactions = rx.filter((x) => x !== e); this.dispatch("MESSAGE_REACTION_REMOVE", { user_id: me, channel_id: r[1], message_id: r[2], emoji }); }
      return this.json(res, 204);
    }
    if (method === "PUT" && (r = m(/^\/channels\/(\d+)\/polls\/(\d+)\/answers\/@me$/))) {
      const msg = (this.messages.get(r[1]) ?? []).find((x) => x.id === r![2]); if (!msg?.poll) return this.json(res, 404, { message: "Unknown Message", code: 10008 });
      for (const a of body.answer_ids) this.dispatch("MESSAGE_POLL_VOTE_ADD", { user_id: me, channel_id: r[1], message_id: r[2], answer_id: Number(a) });
      return this.json(res, 204);
    }
    if (method === "GET" && (r = m(/^\/channels\/(\d+)\/pins$/))) return this.json(res, 200, [...(this.messages.get(r[1]) ?? [])].filter((x) => x.pinned).reverse());
    if ((method === "PUT" || method === "DELETE") && (r = m(/^\/channels\/(\d+)\/pins\/(\d+)$/))) {
      if (this.blockedChannels.has("pins:" + r[1])) return this.json(res, 403, { message: "Missing Permissions", code: 50013 });
      const msg = (this.messages.get(r[1]) ?? []).find((x) => x.id === r![2]); if (!msg) return this.json(res, 404, { message: "Unknown Message", code: 10008 });
      msg.pinned = method === "PUT"; this.dispatch("MESSAGE_UPDATE", { id: msg.id, channel_id: r[1], pinned: msg.pinned }); return this.json(res, 204);
    }
    void this.reactions;
    return this.json(res, 404, { message: "404: Not Found", code: 0 });
  }

  // ------------------------------------------------------------ gateway
  private gateway(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? "/", "http://x");
    const zl = url.searchParams.get("compress") === "zlib-stream" && this.opts.zlib !== false;
    const def = zl ? createDeflate({ flush: Z.Z_SYNC_FLUSH }) : undefined;
    let chunks: Buffer[] = []; def?.on("data", (c: Buffer) => chunks.push(c));
    let chain: Promise<void> = Promise.resolve();
    const raw = (payload: unknown) => {
      const text = JSON.stringify(payload);
      if (!def) { try { ws.send(text); } catch { /* closed */ } return; }
      chain = chain.then(() => new Promise<void>((ok) => { def.write(text); def.flush(Z.Z_SYNC_FLUSH, () => { const b = Buffer.concat(chunks); chunks = []; try { ws.send(b); } catch { /* closed */ } ok(); }); }));
    };
    let s: Sess | undefined; let sid = ""; let n = 0;
    const send = (op: number, d: unknown, t?: string) => { if (op === 0) { n++; if (sid) this.known.set(sid, { userId: s!.userId, seq: n }); } raw({ op, d, s: op === 0 ? n : null, t: t ?? null }); };
    raw({ op: 10, d: { heartbeat_interval: this.opts.heartbeatMs ?? 400 }, s: null, t: null });
    ws.on("message", (data) => {
      let p: any; try { p = JSON.parse(data.toString()); } catch { return; }
      if (p.op === 1) { if (this.opts.ackHeartbeats !== false) raw({ op: 11, d: null }); return; }
      if (p.op === 2) {
        const t = this.tokens.get(p.d.token);
        this.identifies.push({ intents: p.d.intents, mode: t?.mode ?? "?", capabilities: p.d.capabilities, hasProps: !!p.d.properties });
        if (!t) { ws.close(4004, "Authentication failed"); return; }
        if (t.mode === "bot" && (p.d.intents & (1 << 15)) && this.opts.contentIntent === false) { ws.close(4014, "Disallowed intent(s)"); return; }
        if (this.invalidSessionNext) { this.invalidSessionNext = false; raw({ op: 9, d: false }); return; }
        sid = "sess-" + Math.random().toString(36).slice(2, 10);
        s = { ws, token: p.d.token, mode: t.mode, userId: t.userId, intents: p.d.intents ?? 0, id: sid, send }; this.sessions.set(sid, s);
        ws.on("close", () => { this.sessions.delete(sid); });
        const me = this.users.get(t.userId)!; const gs = this.guildsFor(t.userId);
        if (t.mode === "bot") {
          send(0, { v: 10, user: me, session_id: sid, resume_gateway_url: this.wsUrl, guilds: gs.map((g) => ({ id: g.id, unavailable: true })), application: { id: "1" } }, "READY");
          for (const g of gs) send(0, this.guildPayload(g), "GUILD_CREATE");
        } else {
          const dms = [...this.channels.values()].filter((c) => c.type === 1 || c.type === 3);
          const entries = [...this.channels.values()].filter((c) => c.last_message_id).map((c) => ({ id: c.id, last_message_id: this.unreadOverride.get(c.id) ?? c.last_message_id, mention_count: this.mentionOverride.get(c.id) ?? 0 }));
          send(0, {
            v: 10, user: me, session_id: sid, resume_gateway_url: this.wsUrl, users: [...this.users.values()],
            guilds: gs.map((g) => this.guildPayload(g, false)), merged_members: gs.map((g) => { const mm = g.members.find((x) => x.user.id === t.userId); return mm ? [{ user_id: mm.user.id, roles: mm.roles, nick: mm.nick }] : []; }),
            private_channels: dms.map((c) => ({ ...c, recipients: undefined, recipient_ids: (c.recipients ?? []).map((u) => u.id) })),
            read_state: { entries },
          }, "READY");
        }
        return;
      }
      if (p.op === 6) {
        this.resumes.push(p.d.session_id);
        const k = this.known.get(p.d.session_id);
        if (!this.tokens.has(p.d.token)) { ws.close(4004, "Authentication failed"); return; }
        if (!k || !this.canResume) { raw({ op: 9, d: false }); return; }
        sid = p.d.session_id; n = k.seq; const t = [...this.tokens.values()].find((x) => x.userId === k.userId)!;
        s = { ws, token: p.d.token, mode: t.mode, userId: k.userId, intents: 0, id: sid, send }; this.sessions.set(sid, s);
        ws.on("close", () => { this.sessions.delete(sid); });
        send(0, {}, "RESUMED");
      }
    });
  }
  readonly mentionOverride = new Map<string, number>();
  readonly unreadOverride = new Map<string, string>();
  void0() { void this.seqOf; }
}
