// In-process fake Instagram (HTTP + MQTT-over-WebSocket) on 127.0.0.1. Test double only: it implements the SAME assumptions as the
// client (it cannot prove they match the real service). Nothing here talks to any Meta host.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createDecipheriv, generateKeyPairSync, privateDecrypt, constants, type KeyObject } from "node:crypto";
import { deflateSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { inflate, parsePackets, parsePublish, pkt } from "./mqtt.js";

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
export interface FakeOpts { twoFactor?: boolean; challenge?: boolean }
export interface Req { method: string; path: string; query: URLSearchParams; headers: IncomingMessage["headers"]; body: any; raw: Buffer; t: number }

export class FakeIG {
  srv!: Server; wss!: WebSocketServer; url = ""; wsUrl = "";
  reqLog: Req[] = []; opts: FakeOpts;
  me = { pk: "1000", username: "fakeme", full_name: "Fake Me", password: "fakepw" };
  users = new Map<string, any>(); threads = new Map<string, any>();
  tokens = new Set<string>(); rateLimitNext = 0; failNext = 0; retryAfter = 2;
  blocked = new Set<string>(); isPrivate = false; notAdmin = false;
  clients = new Set<WebSocket>(); rtConnects = 0; rtRefused = false; rtPublished: { topic: string; json: any }[] = []; rtAuthSeen: boolean[] = [];
  uploads: { path: string; len: number; params: any }[] = [];
  private keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); private seq = 0; private n = 100;
  private authToken = "Bearer IGT:2:" + Buffer.from(JSON.stringify({ ds_user_id: "1000", sessionid: "1000%3ASESSION-SECRET-ABC%3A1" })).toString("base64");

  constructor(opts: FakeOpts = {}) {
    this.opts = opts;
    this.addUser("2001", "alice", "Alice Anderson"); this.addUser("2002", "bob", "Bob Builder"); this.addUser("2003", "carol", "Carol");
  }
  addUser(pk: string, username: string, full_name: string) { const u = { pk, username, full_name, profile_pic_url: "" }; this.users.set(pk, u); return u; }
  now() { return String(Date.now() * 1000 + (++this.seq)); }
  addThread(id: string, userPks: string[], o: { group?: boolean; title?: string; pending?: boolean; muted?: boolean } = {}) {
    const t = { thread_id: id, thread_title: o.title ?? "", users: userPks.map((p) => this.users.get(p)), viewer_id: this.me.pk, is_group: !!o.group, muted: !!o.muted, pending: !!o.pending, items: [] as any[], last_seen_at: {} as any, read_state: 0, last_activity_at: this.now() };
    this.threads.set(id, t); return t;
  }
  /** Add an item (newest first); `from` = user pk. When push, the iris op goes to realtime clients. */
  addItem(tid: string, from: string, item: Record<string, any>, push = false, ts?: string) {
    const t = this.threads.get(tid); const it = { item_id: String(++this.n) + "00", user_id: from, timestamp: ts ?? this.now(), is_sent_by_viewer: from === this.me.pk, client_context: "ctx-" + this.n, ...item };
    t.items.unshift(it); t.last_activity_at = it.timestamp; if (from !== this.me.pk) t.read_state = 1;
    if (push) this.pushOps([{ op: "add", path: `/direct_v2/threads/${tid}/items/${it.item_id}`, value: JSON.stringify(it) }]);
    return it;
  }
  text(tid: string, from: string, text: string, push = false, ts?: string) { return this.addItem(tid, from, { item_type: "text", text }, push, ts); }
  pushOps(data: any[]) { this.send(146, [{ event: "patch", data }]); }
  pushPubsub(data: any[]) { this.send(88, { data }); }
  private send(topic: number, json: unknown) {
    const body = deflateSync(Buffer.from(JSON.stringify(json))); const t = Buffer.from(String(topic)); const tl = Buffer.alloc(2); tl.writeUInt16BE(t.length);
    for (const c of this.clients) c.send(pkt(0x30, Buffer.concat([tl, t, body])));
  }
  dropSockets() { for (const c of this.clients) c.terminate(); this.clients.clear(); }
  reqs(re: RegExp) { return this.reqLog.filter((r) => re.test(`${r.method} ${r.path}`)); }

  async start() {
    this.srv = createServer((q, s) => { void this.handle(q, s); });
    this.wss = new WebSocketServer({ server: this.srv, path: "/mqtt", handleProtocols: (p) => (p.has("mqtt") ? "mqtt" : false) });
    this.wss.on("connection", (ws) => this.onWs(ws));
    await new Promise<void>((ok) => this.srv.listen(0, "127.0.0.1", ok));
    const port = (this.srv.address() as any).port; this.url = `http://127.0.0.1:${port}`; this.wsUrl = `ws://127.0.0.1:${port}/mqtt`;
    for (const u of this.users.values()) u.profile_pic_url = `${this.url}/pic/${u.pk}.png`;
  }
  async close() { this.dropSockets(); this.wss.close(); this.srv.close(); this.srv.closeAllConnections(); }

  private onWs(ws: WebSocket) {
    let buf: Buffer = Buffer.alloc(0);
    ws.on("message", (d: Buffer) => {
      const r = parsePackets(Buffer.concat([buf, d])); buf = Buffer.from(r.rest);
      for (const p of r.packets) {
        if (p.type === 1) {
          const nl = p.body.readUInt16BE(0); let o = 2 + nl + 4; const cl = p.body.readUInt16BE(o); const cid = p.body.subarray(o + 2, o + 2 + cl);
          const ok = inflate(Buffer.from(cid)).includes(Buffer.from(this.authToken)); this.rtAuthSeen.push(ok);
          if (!ok || this.rtRefused) { ws.send(Buffer.from([0x20, 2, 0, 5])); ws.close(); return; }
          this.rtConnects++; this.clients.add(ws); ws.send(Buffer.from([0x20, 2, 0, 0]));
        } else if (p.type === 3) {
          const m = parsePublish(p); if (m.id !== undefined) ws.send(Buffer.from([0x40, 2, m.id >> 8, m.id & 255]));
          const json = JSON.parse(inflate(Buffer.from(m.payload)).toString()); this.rtPublished.push({ topic: m.topic, json });
        } else if (p.type === 12) ws.send(Buffer.from([0xd0, 0]));
      }
    });
    ws.on("close", () => this.clients.delete(ws));
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); }
  private fail(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}) { this.json(res, status, { status: "fail", message, ...extra }); }
  private async handle(q: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = []; for await (const c of q) chunks.push(c as Buffer); const raw = Buffer.concat(chunks);
    const u = new URL(q.url!, this.url); const path = u.pathname; let body: any = {};
    const ct = String(q.headers["content-type"] ?? "");
    if (ct.startsWith("application/x-www-form-urlencoded")) {
      const s = raw.toString(); if (s.startsWith("signed_body=SIGNATURE.")) body = JSON.parse(decodeURIComponent(s.slice("signed_body=SIGNATURE.".length)));
      else body = Object.fromEntries(new URLSearchParams(s));
    }
    const req: Req = { method: q.method!, path, query: u.searchParams, headers: q.headers, body, raw, t: Date.now() }; this.reqLog.push(req);
    if (path.startsWith("/pic/")) { res.writeHead(200, { "content-type": "image/png" }); return void res.end(PNG); }
    if (path.startsWith("/media/")) { res.writeHead(200, { "content-type": path.endsWith(".m4a") ? "audio/mp4" : "image/png" }); return void res.end(PNG); }
    const route = `${q.method} ${path}`;
    if (route === "GET /api/v1/qe/sync/") return void this.json(res, 200, { status: "ok" }, {
      "ig-set-password-encryption-key-id": "77", "ig-set-password-encryption-pub-key": Buffer.from(this.keys.publicKey.export({ type: "spki", format: "pem" }) as string).toString("base64") });
    if (route === "POST /api/v1/accounts/login/") return void this.login(req, res);
    if (route === "POST /api/v1/accounts/two_factor_login/") {
      if (body.verification_code !== "123456") return void this.fail(res, 400, "Please check the security code and try again.", { error_type: "sms_code_validation_code_invalid" });
      return void this.loggedIn(res);
    }
    if (path.startsWith("/api/v1/challenge/")) {
      if (q.method === "GET") return void this.json(res, 200, { status: "ok", step_name: "select_verify_method", step_data: { choice: "1", email: "f***@example.org" } });
      if (body.choice) return void this.json(res, 200, { status: "ok", step_name: "verify_email" });
      if (body.security_code === "654321") return void this.loggedIn(res);
      return void this.fail(res, 400, "bad code", { error_type: "invalid_code" });
    }
    // everything below needs the session
    if (q.headers.authorization !== this.authToken || !this.tokens.has(String(q.headers.authorization))) return void this.fail(res, 403, "login_required", { error_type: "login_required" });
    if (this.rateLimitNext > 0) { this.rateLimitNext--; res.writeHead(429, { "retry-after": String(this.retryAfter), "content-type": "application/json" }); return void res.end(JSON.stringify({ status: "fail", message: "Please wait a few minutes before you try again." })); }
    if (this.failNext > 0) { this.failNext--; return void this.fail(res, 500, "boom SECRET-SERVER-TEXT"); }
    if (route === "POST /api/v1/accounts/logout/") { this.tokens.delete(this.authToken); return void this.json(res, 200, { status: "ok" }); }
    const page = (items: any[], cursor: string | null, limit: number) => { const o = cursor ? Number(cursor) : 0; return { slice: items.slice(o, o + limit), has_older: o + limit < items.length, oldest_cursor: String(o + limit) }; };
    const inboxFor = (pending: boolean) => {
      const all = [...this.threads.values()].filter((t) => !!t.pending === pending).sort((a, b) => Number(b.last_activity_at) - Number(a.last_activity_at));
      const lim = Number(u.searchParams.get("limit") ?? 20), ml = Number(u.searchParams.get("thread_message_limit") ?? 10);
      const pg = page(all, u.searchParams.get("cursor"), lim);
      return { status: "ok", seq_id: 42, snapshot_at_ms: Date.now(), pending_requests_total: [...this.threads.values()].filter((t) => t.pending).length, viewer: { pk: this.me.pk }, inbox: { threads: pg.slice.map((t) => ({ ...t, items: t.items.slice(0, ml) })), has_older: pg.has_older, oldest_cursor: pg.oldest_cursor } };
    };
    if (route === "GET /api/v1/direct_v2/inbox/") return void this.json(res, 200, inboxFor(false));
    if (route === "GET /api/v1/direct_v2/pending_inbox/") return void this.json(res, 200, inboxFor(true));
    if (route === "GET /api/v1/users/search/") { const s = (u.searchParams.get("q") ?? "").toLowerCase(); return void this.json(res, 200, { status: "ok", users: [...this.users.values()].filter((x) => x.username.includes(s)) }); }
    if (route === "GET /api/v1/direct_v2/threads/get_by_participants/") {
      const want = JSON.parse(u.searchParams.get("recipient_users") ?? "[]") as string[];
      const t = [...this.threads.values()].find((x) => !x.is_group && x.users.length === 1 && want.includes(String(x.users[0].pk)));
      return void (t ? this.json(res, 200, { status: "ok", thread: { ...t, items: t.items.slice(0, 5) } }) : this.json(res, 200, { status: "ok" }));
    }
    let m = /^\/api\/v1\/direct_v2\/threads\/([^/]+)\/$/.exec(path);
    if (m && q.method === "GET") {
      const t = this.threads.get(decodeURIComponent(m[1])); if (!t) return void this.fail(res, 404, "not found");
      const pg = page(t.items, u.searchParams.get("cursor"), Number(u.searchParams.get("limit") ?? 20));
      return void this.json(res, 200, { status: "ok", thread: { ...t, items: pg.slice, has_older: pg.has_older, oldest_cursor: pg.oldest_cursor } });
    }
    if (route === "POST /api/v1/direct_v2/create_group_thread/") {
      const t = this.addThread("g" + (++this.n), JSON.parse(body.recipient_users), { group: true, title: body.thread_title }); return void this.json(res, 200, { ...t, status: "ok" });
    }
    m = /^\/api\/v1\/direct_v2\/threads\/([^/]+)\/(add_user|remove_users)\/$/.exec(path);
    if (m && q.method === "POST") {
      const t = this.threads.get(m[1]); if (!t || !t.is_group) return void this.fail(res, 404, "nf");
      const ids = JSON.parse(body.user_ids) as string[];
      if (m[2] === "add_user") { for (const id of ids) if (this.users.has(id) && !t.users.some((x: any) => String(x.pk) === id)) t.users.push(this.users.get(id)); }
      else { if (this.notAdmin) return void this.fail(res, 400, "Only admins can remove people"); t.users = t.users.filter((x: any) => !ids.includes(String(x.pk))); }
      return void this.json(res, 200, { status: "ok", thread: { ...t, items: [] } });
    }
    m = /^\/api\/v1\/friendships\/(block|unblock)\/(\d+)\/$/.exec(path);
    if (m && q.method === "POST") { if (m[1] === "block") this.blocked.add(m[2]); else this.blocked.delete(m[2]); return void this.json(res, 200, { status: "ok", friendship_status: { blocking: m[1] === "block" } }); }
    if (route === "GET /api/v1/accounts/current_user/") return void this.json(res, 200, { status: "ok", user: { pk: this.me.pk, username: this.me.username, is_private: this.isPrivate } });
    if (route === "POST /api/v1/accounts/set_private/" || route === "POST /api/v1/accounts/set_public/") { this.isPrivate = route.endsWith("private/"); return void this.json(res, 200, { status: "ok", user: { is_private: this.isPrivate } }); }
    m = /^\/api\/v1\/direct_v2\/threads\/([^/]+)\/(approve|decline|leave|update_title)\/$/.exec(path);
    if (m && q.method === "POST") {
      const t = this.threads.get(m[1]); if (!t) return void this.fail(res, 404, "nf");
      if (m[2] === "approve") t.pending = false; if (m[2] === "leave" || m[2] === "decline") this.threads.delete(m[1]); if (m[2] === "update_title") t.thread_title = body.title;
      return void this.json(res, 200, { status: "ok" });
    }
    m = /^\/api\/v1\/direct_v2\/threads\/([^/]+)\/items\/([^/]+)\/(delete|seen)\/$/.exec(path);
    if (m && q.method === "POST") {
      const t = this.threads.get(m[1]); if (!t) return void this.fail(res, 404, "nf");
      if (m[3] === "delete") { const i = t.items.findIndex((x: any) => x.item_id === m![2]); if (i < 0 || t.items[i].user_id !== this.me.pk) return void this.fail(res, 400, "cannot"); t.items.splice(i, 1); }
      return void this.json(res, 200, { status: "ok" });
    }
    if (path.startsWith("/rupload_ig")) { this.uploads.push({ path, len: raw.length, params: JSON.parse(String(q.headers["x-instagram-rupload-params"])) }); return void this.json(res, 200, { status: "ok", upload_id: this.uploads[this.uploads.length - 1].params.upload_id }); }
    m = /^\/api\/v1\/direct_v2\/threads\/broadcast\/(text|link|reaction|configure_photo|configure_video|share_voice)\/$/.exec(path);
    if (m && q.method === "POST") {
      let tid: string;
      if (body.recipient_users) { // the first message creates the thread (provisional chat)
        const pks = (JSON.parse(body.recipient_users) as string[][]).flat(); const ex = [...this.threads.values()].find((x) => !x.is_group && x.users.length === 1 && String(x.users[0].pk) === pks[0]);
        tid = ex ? ex.thread_id : this.addThread("t" + (++this.n), pks).thread_id;
      } else tid = JSON.parse(body.thread_ids)[0];
      const t = this.threads.get(tid); if (!t) return void this.fail(res, 404, "nf");
      if (m[1] === "reaction") {
        const it = t.items.find((x: any) => x.item_id === body.item_id); if (!it) return void this.fail(res, 400, "nf");
        it.reactions = it.reactions ?? { likes_count: 0, emojis: [] }; it.reactions.emojis = it.reactions.emojis.filter((e: any) => e.sender_id !== this.me.pk);
        if (body.reaction_status === "created") it.reactions.emojis.push({ emoji: body.emoji, sender_id: this.me.pk, timestamp: this.now() });
        this.pushOps([{ op: "replace", path: `/direct_v2/threads/${tid}/items/${it.item_id}`, value: JSON.stringify(it) }]);
        return void this.json(res, 200, { status: "ok" });
      }
      const base: any = m[1] === "link" ? { item_type: "link", link: { text: body.link_text, link_context: { link_url: JSON.parse(body.link_urls)[0], link_title: "Preview of " + JSON.parse(body.link_urls)[0] } } } : m[1] === "text" ? { item_type: "text", text: body.text } : m[1] === "configure_photo" ? { item_type: "media", media: { media_type: 1, original_width: 1, original_height: 1, image_versions2: { candidates: [{ url: `${this.url}/media/${body.upload_id}.png`, width: 1, height: 1 }] } } }
        : m[1] === "share_voice" ? { item_type: "voice_media", voice_media: { media: { audio: { audio_src: `${this.url}/media/${body.upload_id}.m4a`, duration: 1500, waveform_data: [0.1, 0.9, 0.4] } } } }
        : { item_type: "media", media: { media_type: 2, video_versions: [{ url: `${this.url}/media/${body.upload_id}.png` }] } };
      if (body.replied_to_item_id) base.replied_to_message = t.items.find((x: any) => x.item_id === body.replied_to_item_id) ?? { item_id: body.replied_to_item_id };
      const it = this.addItem(tid, this.me.pk, base); it.client_context = body.client_context;
      return void this.json(res, 200, { status: "ok", action: "item_ack", payload: { client_context: body.client_context, item_id: it.item_id, timestamp: it.timestamp, thread_id: tid } });
    }
    this.fail(res, 404, "unknown route " + route);
  }

  private login(req: Req, res: ServerResponse) {
    const b = req.body;
    try {
      const m = /^#PWD_INSTAGRAM:4:(\d+):(.+)$/.exec(b.enc_password)!; const buf = Buffer.from(m[2], "base64");
      const iv = buf.subarray(2, 14), rl = buf.readUInt16LE(14), rsa = buf.subarray(16, 16 + rl), tag = buf.subarray(16 + rl, 32 + rl), enc = buf.subarray(32 + rl);
      const key = privateDecrypt({ key: this.keys.privateKey as KeyObject, padding: constants.RSA_PKCS1_PADDING }, rsa);
      const d = createDecipheriv("aes-256-gcm", key, iv); d.setAAD(Buffer.from(m[1])); d.setAuthTag(tag);
      const pw = Buffer.concat([d.update(enc), d.final()]).toString();
      if (b.username !== this.me.username) return void this.fail(res, 400, "The username you entered doesn't appear to belong to an account.", { error_type: "invalid_user" });
      if (pw !== this.me.password) return void this.fail(res, 400, "The password you entered is incorrect.", { error_type: "bad_password" });
    } catch { return void this.fail(res, 400, "bad enc_password"); }
    if (this.opts.twoFactor) return void this.json(res, 400, { status: "fail", message: "challenge", two_factor_required: true, two_factor_info: { two_factor_identifier: "2fa-id-1", username: b.username, totp_two_factor_on: true } });
    if (this.opts.challenge) return void this.json(res, 400, { status: "fail", message: "challenge_required", error_type: "checkpoint_challenge_required", challenge: { api_path: "/challenge/12345/abcd/", lock: true } });
    this.loggedIn(res);
  }
  private loggedIn(res: ServerResponse) {
    this.tokens.add(this.authToken);
    this.json(res, 200, { status: "ok", logged_in_user: { pk: this.me.pk, username: this.me.username, full_name: this.me.full_name } }, { "ig-set-authorization": this.authToken, "ig-set-x-mid": "MID-SECRET", "ig-set-ig-u-rur": "RUR" });
  }
}
