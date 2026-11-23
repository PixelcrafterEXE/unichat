// In-process fake Mattermost server (http + ws on 127.0.0.1) for the offline tests. Not used at runtime.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export interface FakeOpts { mfa?: boolean; ssoOnly?: boolean; patEnabled?: boolean }

export class FakeMM {
  statuses: Record<string, string> = {}; // presence: user id -> online | away | dnd | offline
  srv!: Server; wss!: WebSocketServer; port = 0;
  log: { method: string; path: string; query: URLSearchParams; body: any; auth?: string; raw: string }[] = [];
  validTokens = new Set<string>(["pat-good"]);
  sockets = new Set<WebSocket>();
  wsAuth: (string | undefined)[] = [];
  wsOrigin: (string | undefined)[] = [];
  wsSent: any[] = [];
  rateLimitNext = 0; // answer the next N requests with 429
  seq = 1000;
  now = 1_700_000_000_000;
  users: Record<string, any> = {
    u_me: { id: "u_me", username: "me", nickname: "Meee", first_name: "Mia", last_name: "Me", last_picture_update: 5 },
    u_bob: { id: "u_bob", username: "bob", first_name: "Bob", last_name: "Builder", last_picture_update: 7 },
    u_carol: { id: "u_carol", username: "carol", first_name: "", last_name: "", last_picture_update: 0 },
  };
  teams = [{ id: "t1", display_name: "Team One", name: "one", last_team_icon_update: 3 }, { id: "t2", display_name: "Team Two", name: "two", last_team_icon_update: 0 }];
  channels: Record<string, any> = {
    c_town: { id: "c_town", team_id: "t1", type: "O", display_name: "Town Square", name: "town-square", purpose: "Everything", total_msg_count: 10, last_post_at: 0 },
    c_priv: { id: "c_priv", team_id: "t1", type: "P", display_name: "Secret", name: "secret", header: "hdr", total_msg_count: 4, last_post_at: 0 },
    c_t2: { id: "c_t2", team_id: "t2", type: "O", display_name: "Off-Topic", name: "off-topic", total_msg_count: 0, last_post_at: 0 },
    c_dm: { id: "c_dm", team_id: "", type: "D", display_name: "", name: "u_bob__u_me", total_msg_count: 2, last_post_at: 0 },
    c_gm: { id: "c_gm", team_id: "", type: "G", display_name: "bob, carol, me", name: "gmhash", total_msg_count: 0, last_post_at: 0 },
  };
  members: Record<string, any> = {
    c_town: { channel_id: "c_town", msg_count: 7, mention_count: 1 }, c_priv: { channel_id: "c_priv", msg_count: 4, notify_props: { mark_unread: "mention" } },
    c_t2: { channel_id: "c_t2", msg_count: 0 }, c_dm: { channel_id: "c_dm", msg_count: 2 }, c_gm: { channel_id: "c_gm", msg_count: 0 },
  };
  posts: Record<string, any[]> = {};
  postById: Record<string, any> = {};
  files: Record<string, { info: any; data: Buffer }> = {};
  config: Record<string, string> = { TeammateNameDisplay: "full_name", MaxFileSize: "1000", EnableUserAccessTokens: "true", EnableSignUpWithEmail: "true", EnableSaml: "false", EnableLdap: "false" };
  nameFormatPref: string | undefined;
  /** Teams the user can join: by name (open) or by invite id. Joining adds the team and its channels, leaving removes them. */
  joinable: Record<string, { team: any; open: boolean; invite?: string; channels: any[] }> = {
    three: { team: { id: "t3", display_name: "Team Three", name: "three", last_team_icon_update: 0 }, open: true, invite: "inv3inv3inv3", channels: [{ id: "c_t3", team_id: "t3", type: "O", display_name: "Lobby", name: "lobby", total_msg_count: 0, last_post_at: 0 }] },
    closed: { team: { id: "t4", display_name: "Closed", name: "closed", last_team_icon_update: 0 }, open: false, invite: "inv4inv4inv4", channels: [] },
  };
  canCreateTeams = true;

  opts: FakeOpts;
  constructor(opts: FakeOpts = {}) {
    this.opts = opts;
    if (opts.ssoOnly) this.config = { ...this.config, EnableSignUpWithEmail: "false", EnableSaml: "true" };
  }

  addPost(channel: string, user: string, message: string, extra: Record<string, any> = {}): any {
    const p = { id: "p" + ++this.seq, channel_id: channel, user_id: user, message, create_at: (this.now += 1000), update_at: this.now, edit_at: 0, delete_at: 0, root_id: "", type: "", props: {}, metadata: {}, ...extra };
    (this.posts[channel] ??= []).push(p); this.postById[p.id] = p;
    this.channels[channel].last_post_at = p.create_at;
    return p;
  }
  private joinTeam(id: string) {
    const j = Object.values(this.joinable).find((x) => x.team.id === id)!;
    if (!this.teams.some((t) => t.id === id)) this.teams.push(j.team);
    for (const c of j.channels) { this.channels[c.id] = { ...c }; this.members[c.id] = { channel_id: c.id, msg_count: 0 }; }
  }
  /** Push a websocket event to all connected clients. */
  push(event: string, data: Record<string, unknown>, broadcast: Record<string, unknown> = {}) {
    const m = JSON.stringify({ event, data, broadcast: { channel_id: "", team_id: "", user_id: "", omit_users: null, ...broadcast }, seq: ++this.seq });
    for (const s of this.sockets) s.send(m);
  }
  pushPosted(p: any) { this.push("posted", { channel_type: this.channels[p.channel_id]?.type, post: JSON.stringify(p), sender_name: "x" }, { channel_id: p.channel_id }); }
  dropSockets() { for (const s of this.sockets) s.terminate(); }
  reqs(re: RegExp) { return this.log.filter((l) => re.test(`${l.method} ${l.path}`)); }

  async start() {
    this.srv = createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.srv.on("upgrade", (req, sock, head) => {
      this.wsAuth.push(req.headers.authorization); this.wsOrigin.push(req.headers.origin);
      if (req.url !== "/api/v4/websocket" || !this.validTokens.has((req.headers.authorization ?? "").replace("Bearer ", ""))) { sock.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"); return void sock.destroy(); }
      this.wss.handleUpgrade(req, sock, head, (ws) => {
        this.sockets.add(ws); ws.on("close", () => this.sockets.delete(ws));
        ws.on("message", (d) => this.wsSent.push(JSON.parse(d.toString())));
        ws.send(JSON.stringify({ event: "hello", data: { server_version: "9.5.0" }, broadcast: {}, seq: 0 }));
      });
    });
    await new Promise<void>((ok) => this.srv.listen(0, "127.0.0.1", ok));
    this.port = (this.srv.address() as { port: number }).port;
  }
  get url() { return `http://127.0.0.1:${this.port}`; }
  async close() { this.dropSockets(); this.wss.close(); this.srv.close(); this.srv.closeAllConnections(); }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://x");
    const path = url.pathname.replace(/^\/api\/v4/, "");
    const ct = req.headers["content-type"] ?? "";
    let body: any; if (ct.includes("json") && raw.length) body = JSON.parse(raw.toString());
    this.log.push({ method: req.method!, path, query: url.searchParams, body, auth: req.headers.authorization, raw: ct.includes("multipart") ? raw.toString("latin1") : "" });
    const json = (o: unknown, code = 200, h: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(o)); };
    const fail = (code: number, id: string) => json({ id, message: "secret server text", status_code: code }, code);
    if (this.rateLimitNext > 0) { this.rateLimitNext--; return json({ id: "api.context.too_many_requests", message: "slow down" }, 429, { "X-RateLimit-Reset": "1", "X-RateLimit-Remaining": "0" }); }
    const m = req.method!;
    if (path === "/system/ping") return json({ status: "OK" }, 200, { "X-Version-Id": "9.5.0.1.abc" });
    if (path === "/config/client") return json(this.config);
    if (path === "/users/login") {
      if (this.opts.ssoOnly) return fail(400, "api.user.login.use_auth_service.app_error");
      if (body.login_id !== "me" || body.password !== "pw") return fail(401, "api.user.login.invalid_credentials_email_username");
      if (this.opts.mfa && body.token !== "123456") return fail(401, "mfa.validate_token.authenticate.app_error");
      this.validTokens.add("sess-tok"); return json(this.users.u_me, 200, { Token: "sess-tok" });
    }
    const tok = (req.headers.authorization ?? "").replace("Bearer ", "");
    if (!this.validTokens.has(tok)) return fail(401, "api.context.session_expired.app_error");
    let r: RegExpMatchArray | null;
    if (path === "/users/status/ids" && m === "POST") return json((body as string[]).map((id) => ({ user_id: id, status: this.statuses[id] ?? "offline", last_activity_at: id === "u_bob" ? 1_700_000_000_000 : 0 })));
    if (path === "/users/logout") { this.validTokens.delete(tok); return json({ status: "OK" }); }
    if (path === "/users/me" && m === "GET") return json(this.users.u_me);
    if (path === "/users/me/patch") { Object.assign(this.users.u_me, body); return json(this.users.u_me); }
    if (path === "/users/me/image") { if (m === "POST") this.users.u_me.last_picture_update = 9; else this.users.u_me.last_picture_update = 0; return json({ status: "OK" }); }
    if (path === "/users/me/teams") return json(this.teams);
    if (path === "/teams" && m === "POST") {
      if (!this.canCreateTeams) return fail(403, "api.team.create_team.permissions.app_error");
      if (this.teams.some((t) => t.name === body.name) || this.joinable[body.name]) return fail(400, "store.sql_team.save.domain_exists.app_error");
      const t = { id: "t_" + ++this.seq, display_name: body.display_name, name: body.name, description: body.description, last_team_icon_update: 0 };
      this.teams.push(t); return json(t, 201);
    }
    if ((r = path.match(/^\/teams\/name\/([\w-]+)$/))) { const n = decodeURIComponent(r[1]); const j = this.joinable[n]; const t = this.teams.find((x) => x.name === n) ?? j?.team; return t ? json(t) : fail(404, "app.team.get_by_name.app_error"); }
    if (path === "/teams/members/invite" && m === "POST") {
      const j = Object.values(this.joinable).find((x) => x.invite === url.searchParams.get("invite_id")); if (!j) return fail(404, "app.team.get_by_invite_id.finding.app_error");
      this.joinTeam(j.team.id); return json({ team_id: j.team.id, user_id: "u_me" }, 201);
    }
    if ((r = path.match(/^\/teams\/(\w+)\/members$/)) && m === "POST") {
      const j = Object.values(this.joinable).find((x) => x.team.id === r![1]); if (!j) return fail(404, "x");
      if (!j.open) return fail(403, "api.team.add_user_to_team.permissions.app_error");
      this.joinTeam(j.team.id); return json({ team_id: j.team.id, user_id: body.user_id }, 201);
    }
    if ((r = path.match(/^\/teams\/(\w+)\/members\/(\w+)$/)) && m === "DELETE") {
      const t = this.teams.find((x) => x.id === r![1]); if (!t) return fail(404, "x");
      this.teams = this.teams.filter((x) => x.id !== t.id);
      for (const c of Object.values(this.channels)) if (c.team_id === t.id) { delete this.channels[c.id]; delete this.members[c.id]; }
      return json({ status: "OK" });
    }
    if ((r = path.match(/^\/teams\/(\w+)$/)) && m === "GET") { const t = this.teams.find((x) => x.id === r![1]) ?? Object.values(this.joinable).find((x) => x.team.id === r![1])?.team; return t ? json(t) : fail(404, "x"); }
    if (path === "/users/me/channels") return json(Object.values(this.channels).filter((c) => !c.delete_at));
    if (path === "/users/me/channel_members") return json(url.searchParams.get("page") === "0" ? Object.values(this.members) : []);
    if (path === "/users/me/preferences/display_settings") return json(this.nameFormatPref ? [{ name: "name_format", value: this.nameFormatPref }] : []);
    if ((r = path.match(/^\/users\/u_me\/preferences$/)) && m === "PUT") return json({ status: "OK" });
    if (path === "/users/ids") return json((body as string[]).map((i) => this.users[i]).filter(Boolean));
    if ((r = path.match(/^\/users\/username\/(.+)$/))) { const u = Object.values(this.users).find((x) => x.username === decodeURIComponent(r![1])); return u ? json(u) : fail(404, "app.user.get_by_username.app_error"); }
    if ((r = path.match(/^\/users\/email\/(.+)$/))) { const u = Object.values(this.users).find((x) => `${x.username}@uni.test` === decodeURIComponent(r![1])); return u ? json(u) : fail(404, "x"); }
    if ((r = path.match(/^\/users\/(\w+)\/image$/))) { res.writeHead(200, { "content-type": "image/png" }); return void res.end(PNG); }
    if ((r = path.match(/^\/teams\/(\w+)\/image$/))) { res.writeHead(200, { "content-type": "image/png" }); return void res.end(PNG); }
    if (path === "/channels/direct" || path === "/channels/group") {
      const ids = body as string[];
      const c = path.endsWith("direct") ? { id: "c_dm2", type: "D", name: [...ids].sort().join("__"), display_name: "", team_id: "", total_msg_count: 0, last_post_at: 0 } : { id: "c_gm2", type: "G", name: "h", display_name: "bob, carol, me", team_id: "", total_msg_count: 0, last_post_at: 0 };
      this.channels[c.id] = c; return json(c, 201);
    }
    if (path === "/channels/members/me/view") { const c = this.channels[body.channel_id]; this.members[body.channel_id].msg_count = c.total_msg_count; return json({ status: "OK" }); }
    if ((r = path.match(/^\/channels\/(\w+)\/posts$/))) {
      const all = [...(this.posts[r[1]] ?? [])].sort((a, b) => b.create_at - a.create_at); const q = url.searchParams;
      let sel = all;
      const since = q.get("since");
      if (since) sel = all.filter((p) => Math.max(p.create_at, p.update_at, p.delete_at) > Number(since));
      else {
        const before = q.get("before"); if (before) sel = all.slice(all.findIndex((p) => p.id === before) + 1);
        sel = sel.slice(0, Number(q.get("per_page") ?? 60));
      }
      const posts: Record<string, any> = {}; for (const p of sel) posts[p.id] = p;
      if (!since) for (const p of sel) if (p.root_id && this.postById[p.root_id]) posts[p.root_id] = this.postById[p.root_id];
      return json({ order: sel.map((p) => p.id), posts });
    }
    if (path === "/posts" && m === "POST") {
      if (body.root_id && this.postById[body.root_id]) this.postById[body.root_id].reply_count = (this.postById[body.root_id].reply_count ?? 0) + 1;
      const p = this.addPost(body.channel_id, "u_me", body.message, { root_id: body.root_id ?? "", pending_post_id: body.pending_post_id, file_ids: body.file_ids ?? [], metadata: { files: (body.file_ids ?? []).map((i: string) => this.files[i].info) } });
      this.pushPosted(p); return json(p, 201);
    }
    if (m === "POST" && (r = path.match(/^\/posts\/(\w+)\/(pin|unpin)$/))) { const p = this.postById[r[1]]; if (!p) return fail(404, "x"); p.is_pinned = r[2] === "pin"; p.update_at = (this.now += 1000); this.push("post_edited", { post: JSON.stringify(p) }, { channel_id: p.channel_id }); return json({ status: "OK" }); }
    if (m === "GET" && (r = path.match(/^\/channels\/(\w+)\/pinned$/))) { const sel = Object.values(this.postById).filter((p: any) => p.channel_id === r![1] && p.is_pinned); const posts: Record<string, any> = {}; for (const p of sel as any[]) posts[p.id] = p; return json({ order: (sel as any[]).map((p) => p.id), posts }); }
    if ((r = path.match(/^\/posts\/(\w+)\/patch$/))) { const p = this.postById[r[1]]; p.message = body.message; p.edit_at = p.update_at = (this.now += 1000); this.push("post_edited", { post: JSON.stringify(p) }, { channel_id: p.channel_id }); return json(p); }
    if (m === "GET" && (r = path.match(/^\/posts\/(\w+)\/thread$/))) {
      const root = this.postById[r[1]]; if (!root) return fail(404, "x");
      const sel = [root, ...Object.values(this.postById).filter((p: any) => p.root_id === root.id)]; const posts: Record<string, any> = {}; for (const p of sel) posts[p.id] = p;
      return json({ order: sel.map((p: any) => p.id).reverse(), posts });
    }
    if ((r = path.match(/^\/posts\/(\w+)$/))) {
      const p = this.postById[r[1]]; if (!p) return fail(404, "x");
      if (m === "DELETE") { p.delete_at = (this.now += 1000); this.push("post_deleted", { post: JSON.stringify(p) }, { channel_id: p.channel_id }); return json({ status: "OK" }); }
      return json(p);
    }
    if (path === "/reactions") {
      const p = this.postById[body.post_id]; (p.metadata.reactions ??= []).push({ user_id: body.user_id, post_id: body.post_id, emoji_name: body.emoji_name });
      this.push("reaction_added", { reaction: JSON.stringify(body) }, { channel_id: p.channel_id }); return json(body);
    }
    if ((r = path.match(/^\/users\/(\w+)\/posts\/(\w+)\/reactions\/(.+)$/)) && m === "DELETE") {
      const uid = r[1], pid = r[2]; const p = this.postById[pid]; const name = decodeURIComponent(r[3]);
      p.metadata.reactions = (p.metadata.reactions ?? []).filter((x: any) => !(x.user_id === uid && x.emoji_name === name));
      this.push("reaction_removed", { reaction: JSON.stringify({ post_id: pid, emoji_name: name, user_id: uid }) }, { channel_id: p.channel_id }); return json({ status: "OK" });
    }
    if (path === "/files" && m === "POST") {
      const name = /filename="([^"]*)"/.exec(raw.toString("latin1"))?.[1] ?? "f";
      const mime = /Content-Type: ([^\r\n]+)/i.exec(raw.toString("latin1").split("filename=")[1] ?? "")?.[1] ?? "application/octet-stream";
      const info = { id: "f" + ++this.seq, name, extension: name.split(".").pop(), size: raw.length, mime_type: mime, width: 0, height: 0 };
      this.files[info.id] = { info, data: Buffer.from("FILEDATA") }; return json({ file_infos: [info] }, 201);
    }
    if ((r = path.match(/^\/files\/(\w+)(\/info)?$/))) { const f = this.files[r[1]]; if (!f) return fail(404, "x"); if (r[2]) return json(f.info); res.writeHead(200, { "content-type": f.info.mime_type }); return void res.end(f.data); }
    if ((r = path.match(/^\/channels\/(\w+)\/members\/me$/))) return this.members[r[1]] ? json(this.members[r[1]]) : fail(404, "x");
    if ((r = path.match(/^\/channels\/(\w+)\/members$/))) {
      if (m === "POST") return this.opts.patEnabled === false ? fail(403, "api.context.permissions.app_error") : json({ channel_id: r[1], user_id: body.user_id }, 201);
      return json(url.searchParams.get("page") === "0" ? [{ user_id: "u_me" }, { user_id: "u_bob" }, { user_id: "u_carol" }] : []);
    }
    if ((r = path.match(/^\/channels\/(\w+)\/members\/(\w+)$/)) && m === "DELETE") return json({ status: "OK" });
    if ((r = path.match(/^\/channels\/(\w+)\/patch$/))) { Object.assign(this.channels[r[1]], body); return json(this.channels[r[1]]); }
    if ((r = path.match(/^\/channels\/(\w+)$/))) return this.channels[r[1]] ? json(this.channels[r[1]]) : fail(404, "x");
    return fail(404, "fake.unknown_route");
  }
}
