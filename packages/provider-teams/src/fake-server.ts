// A fake Microsoft Entra ID + Microsoft Graph v1.0 on 127.0.0.1 for offline tests. Fixtures only: fake tokens, fake tenants. Never talks to Microsoft.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { GAttachment, GMessage, GMember } from "./map.js";

export interface FUser { id: string; displayName: string; mail: string; photo?: Uint8Array }
export interface FChat { id: string; chatType: "oneOnOne" | "group" | "meeting"; topic: string | null; members: GMember[]; lastRead?: string }
export interface FChannel { id: string; displayName: string; membershipType: "standard" | "private" | "shared"; description?: string }
export interface FTeam { id: string; displayName: string; channels: FChannel[]; photo?: Uint8Array }
export interface FakeOpts { tokenTtlS?: number; pageSize?: number; pendingPolls?: number; scope?: string; tenantId?: string }
export const TENANT_ID = "00000000-0000-4000-8000-0000000000aa";
export const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

export class FakeTeams {
  server!: Server; port = 0; url = ""; graph = ""; auth = "";
  users = new Map<string, FUser>(); chats = new Map<string, FChat>(); teams = new Map<string, FTeam>();
  msgs = new Map<string, GMessage[]>();           // container -> messages (channel replies are flat, with replyToId)
  pinned = new Map<string, { id: string; messageId: string }[]>(); // chat -> pinnedChatMessageInfo
  hosted = new Map<string, { type: string; data: Uint8Array }>(); // "<msgId>/<hcId>"
  files = new Map<string, Uint8Array>();          // share id -> bytes
  drive = new Map<string, Uint8Array>();          // uploaded path -> bytes
  tokens = new Map<string, { userId: string; exp: number; scope: string }>();
  refreshTokens = new Map<string, string>();      // refresh token -> userId
  devices = new Map<string, { polls: number; state: "pending" | "ok" | "declined" | "expired"; scope: string }>();
  hits: string[] = []; authHits: string[] = []; bodies: { path: string; body: any }[] = [];
  failNext = 0; throttleNext = 0; throttleAfterS = "0"; rejectExpand = false; deltaDelay = 0;
  about = ""; photoPuts: string[] = []; ops = new Map<string, number>(); opsPending = 1;
  forbid: RegExp[] = []; invalidClient = false; me = ""; scope: string; opts: Required<FakeOpts>;
  private clock = Date.now() - 3_600_000; private seq = 0;

  constructor(o: FakeOpts = {}) {
    this.opts = { tokenTtlS: 3600, pageSize: 50, pendingPolls: 1, scope: "openid profile offline_access User.Read User.ReadBasic.All Chat.ReadWrite Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All ChannelMessage.Send", tenantId: TENANT_ID, ...o };
    this.scope = this.opts.scope;
  }
  /** Move the clock to real time: messages said afterwards count as live (created after the connector started). */
  live() { this.clock = Math.max(this.clock, Date.now()); }
  now() { this.clock += 1000; return new Date(this.clock).toISOString(); }
  nid() { this.clock += 1000; return String(this.clock); }

  // ---------------------------------------------------------------- world
  user(id: string, displayName: string, mail = `${displayName.split(" ")[0].toLowerCase()}@example.test`) { const u = { id, displayName, mail }; this.users.set(id, u); return u; }
  member(userId: string, roles: string[] = ["owner"]): GMember { const u = this.users.get(userId)!; return { id: "m-" + randomUUID().slice(0, 8), userId, displayName: u.displayName, email: u.mail, roles }; }
  chat(id: string, chatType: FChat["chatType"], userIds: string[], topic: string | null = null) { const c: FChat = { id, chatType, topic, members: userIds.map((u) => this.member(u)) }; this.chats.set(id, c); this.msgs.set(id, []); return c; }
  team(id: string, displayName: string, channels: FChannel[]) { const t = { id, displayName, channels }; this.teams.set(id, t); for (const c of channels) this.msgs.set(`${id}/${c.id}`, []); return t; }
  /** A user says something (html body). Returns the stored message. */
  say(container: string, userId: string, html: string, extra: Partial<GMessage> = {}): GMessage {
    const u = this.users.get(userId)!; const t = this.now();
    const m: GMessage = { id: String(this.clock), messageType: "message", createdDateTime: t, lastModifiedDateTime: t, from: { user: { id: userId, displayName: u.displayName, userIdentityType: "aadUser" } }, body: { contentType: "html", content: html }, importance: "normal", attachments: [], mentions: [], reactions: [], ...extra };
    if (container.includes("/") && extra.replyToId) { /* reply */ }
    this.msgs.get(container)!.push(m); return m;
  }
  system(container: string, detail: Record<string, unknown>) {
    const t = this.now(); const m: GMessage = { id: String(this.clock), messageType: "systemEventMessage", createdDateTime: t, lastModifiedDateTime: t, from: null, body: { contentType: "html", content: "<systemEventMessage/>" }, eventDetail: detail };
    this.msgs.get(container)!.push(m); return m;
  }
  find(container: string, id: string) { return this.msgs.get(container)?.find((m) => m.id === id); }
  touch(m: GMessage) { m.lastModifiedDateTime = this.now(); }
  /** Revoke every refresh token and access token (admin revoked the grant / password changed). */
  revokeAll() { this.refreshTokens.clear(); this.tokens.clear(); }
  expireAccessTokens() { this.tokens.clear(); }
  issue(userId: string, scope = this.scope) {
    const at = "fakeAT-" + randomUUID(), rt = "fakeRT-" + randomUUID();
    this.tokens.set(at, { userId, exp: Date.now() + this.opts.tokenTtlS * 1000, scope }); this.refreshTokens.set(rt, userId);
    const idt = "h." + Buffer.from(JSON.stringify({ tid: this.opts.tenantId, oid: userId })).toString("base64url") + ".s";
    return { access_token: at, refresh_token: rt, expires_in: this.opts.tokenTtlS, scope, id_token: idt, token_type: "Bearer" };
  }

  // ---------------------------------------------------------------- http
  async start() {
    this.server = createServer((q, r) => { this.handle(q, r).catch(() => { try { r.writeHead(500); r.end(); } catch { /* ignore */ } }); });
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    this.port = (this.server.address() as any).port; this.url = `http://127.0.0.1:${this.port}`; this.graph = this.url + "/v1.0"; this.auth = this.url + "/auth";
  }
  async close() { this.server.closeAllConnections?.(); await new Promise<void>((ok) => this.server.close(() => ok())); }
  private send(r: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
    if (body instanceof Uint8Array) { r.writeHead(status, { "Content-Type": headers["Content-Type"] ?? "application/octet-stream", ...headers }); r.end(body); return; }
    r.writeHead(status, { "Content-Type": "application/json", ...headers }); r.end(body === undefined ? undefined : JSON.stringify(body));
  }
  private err(r: ServerResponse, status: number, code: string, headers: Record<string, string> = {}) { this.send(r, status, { error: { code, message: "fake error text must never be surfaced: SERVER-ERROR-DETAIL" } }, headers); }
  private async readBody(q: IncomingMessage): Promise<Buffer> { const ch: Buffer[] = []; for await (const c of q) ch.push(c as Buffer); return Buffer.concat(ch); }

  private async handle(q: IncomingMessage, r: ServerResponse) {
    const u = new URL(q.url!, this.url); const raw = await this.readBody(q);
    if (u.pathname.startsWith("/auth/")) return this.handleAuth(u, raw, r);
    return this.handleGraph(q, u, raw, r);
  }

  private handleAuth(u: URL, raw: Buffer, r: ServerResponse) {
    this.authHits.push(u.pathname);
    const form = new URLSearchParams(raw.toString("utf8"));
    const path = u.pathname.replace(/^\/auth\/[^/]+\/oauth2\/v2\.0\//, "");
    if (this.invalidClient && form.get("client_id") !== CLIENT_ID) return this.send(r, 400, { error: "invalid_client" });
    if (path === "devicecode") {
      const dc = "dc-" + randomUUID(); this.devices.set(dc, { polls: 0, state: "pending", scope: form.get("scope") ?? "" });
      return this.send(r, 200, { device_code: dc, user_code: "ABCD-EFGH", verification_uri: this.url + "/devicelogin", expires_in: 900, interval: 1, message: "ignored" });
    }
    if (path === "token") {
      const g = form.get("grant_type");
      if (g === "refresh_token") {
        const rt = form.get("refresh_token") ?? ""; const uid = this.refreshTokens.get(rt);
        if (!uid) return this.send(r, 400, { error: "invalid_grant", error_description: "AADSTS70008: SECRET-DESC " + rt });
        this.refreshTokens.delete(rt); return this.send(r, 200, this.issue(uid, form.get("scope") ?? this.scope));
      }
      const d = this.devices.get(form.get("device_code") ?? "");
      if (!d) return this.send(r, 400, { error: "bad_verification_code" });
      d.polls++;
      if (d.state === "declined") return this.send(r, 400, { error: "authorization_declined" });
      if (d.state === "expired") return this.send(r, 400, { error: "expired_token" });
      if (d.state === "pending" && d.polls <= this.opts.pendingPolls) return this.send(r, 400, { error: d.polls === 2 ? "slow_down" : "authorization_pending" });
      return this.send(r, 200, this.issue(this.me, d.scope.includes("User.Read") ? this.scope : this.scope));
    }
    this.send(r, 404, {});
  }

  private page<T>(u: URL, items: T[], pathname: string): { value: T[]; "@odata.nextLink"?: string } {
    const top = Math.min(Number(u.searchParams.get("$top")) || this.opts.pageSize, this.opts.pageSize);
    const skip = Number(u.searchParams.get("$skiptoken")) || 0; const out: { value: T[]; "@odata.nextLink"?: string } = { value: items.slice(skip, skip + top) };
    if (skip + top < items.length) { const n = new URL(this.graph + pathname); for (const [k, v] of u.searchParams) n.searchParams.set(k, v); n.searchParams.set("$skiptoken", String(skip + top)); out["@odata.nextLink"] = n.toString(); }
    return out;
  }

  private withReplies(container: string, m: GMessage, expand: boolean) { return expand ? { ...m, replies: (this.msgs.get(container) ?? []).filter((x) => x.replyToId === m.id) } : m; }

  private async handleGraph(q: IncomingMessage, u: URL, raw: Buffer, r: ServerResponse) {
    const method = q.method!; const p = decodeURIComponent(u.pathname).replace(/^\/v1\.0/, "");
    this.hits.push(`${method} ${p}`);
    if (this.deltaDelay && /delta$/.test(p)) await new Promise((ok) => setTimeout(ok, this.deltaDelay));
    const bearer = (q.headers.authorization ?? "").replace(/^Bearer /, ""); const tok = this.tokens.get(bearer);
    if (!tok || tok.exp < Date.now()) return this.err(r, 401, "InvalidAuthenticationToken");
    if (this.throttleNext > 0) { this.throttleNext--; return this.err(r, 429, "TooManyRequests", { "Retry-After": this.throttleAfterS }); }
    if (this.failNext > 0) { this.failNext--; return this.err(r, 500, "InternalServerError"); }
    if (this.forbid.some((x) => x.test(p))) return this.err(r, 403, "Forbidden");
    let body: any; if (raw.length && /json/.test(q.headers["content-type"] ?? "")) { try { body = JSON.parse(raw.toString("utf8")); } catch { return this.err(r, 400, "BadRequest"); } }
    if (body !== undefined) this.bodies.push({ path: `${method} ${p}`, body });
    const meId = tok.userId; const me = this.users.get(meId)!; const m = (re: RegExp) => re.exec(p);
    let x: RegExpExecArray | null;

    if (method === "GET" && p === "/me") return this.send(r, 200, { id: me.id, displayName: me.displayName, mail: me.mail, userPrincipalName: me.mail, ...(u.searchParams.get("$select") === "aboutMe" ? { aboutMe: this.about } : {}) });
    if (method === "PATCH" && p === "/me") { if (!/User\.ReadWrite/.test(tok.scope)) return this.err(r, 403, "Forbidden"); this.about = body.aboutMe; return this.send(r, 204); }
    if (method === "PUT" && p === "/me/photo/$value") { if (!/User\.ReadWrite/.test(tok.scope)) return this.err(r, 403, "Forbidden"); me.photo = new Uint8Array(raw); this.photoPuts.push(String(q.headers["content-type"])); return this.send(r, 200, {}); }
    if (method === "POST" && p === "/teams") {
      if (!/Team\.Create/.test(tok.scope)) return this.err(r, 403, "Forbidden");
      const tid = randomUUID(), op = randomUUID(); this.team(tid, body.displayName, [{ id: "19:gen" + tid.slice(0, 4) + "@thread.tacv2", displayName: "General", membershipType: "standard" }]);
      this.ops.set(op, this.opsPending); return this.send(r, 202, undefined, { "Content-Location": `/teams('${tid}')`, Location: `/teams('${tid}')/operations('${op}')` });
    }
    if (method === "GET" && (x = m(/^\/teams\/([^/]+)\/operations\/([^/]+)$/))) { const left = this.ops.get(x[2]); if (left === undefined) return this.err(r, 404, "NotFound"); this.ops.set(x[2], left - 1); return this.send(r, 200, { id: x[2], status: left > 0 ? "inProgress" : "succeeded" }); }
    if (method === "GET" && p === "/me/photo/$value") return me.photo ? this.send(r, 200, me.photo, { "Content-Type": "image/jpeg" }) : this.err(r, 404, "ImageNotFound");
    if (method === "GET" && (x = m(/^\/users\/([^/]+)\/photo\/\$value$/))) { const uu = this.users.get(x[1]); return uu?.photo ? this.send(r, 200, uu.photo, { "Content-Type": "image/jpeg" }) : this.err(r, 404, "ImageNotFound"); }
    if (method === "GET" && (x = m(/^\/teams\/([^/]+)\/photo\/\$value$/))) { const t = this.teams.get(x[1]); return t?.photo ? this.send(r, 200, t.photo, { "Content-Type": "image/png" }) : this.err(r, 404, "ImageNotFound"); }
    if (method === "GET" && (x = m(/^\/users\/([^/]+)$/))) { const uu = [...this.users.values()].find((v) => v.id === x![1] || v.mail === x![1]); return uu ? this.send(r, 200, { id: uu.id, displayName: uu.displayName, mail: uu.mail }) : this.err(r, 404, "Request_ResourceNotFound"); }

    // ---- chats
    if (method === "GET" && p === "/me/chats") {
      const mine = [...this.chats.values()].filter((c) => c.members.some((mm) => mm.userId === meId));
      const withPrev = mine.map((c) => this.chatJson(c, meId)).sort((a, b) => Date.parse(b.lastMessagePreview?.createdDateTime ?? "2000-01-01") - Date.parse(a.lastMessagePreview?.createdDateTime ?? "2000-01-01"));
      return this.send(r, 200, this.page(u, withPrev, p));
    }
    if (method === "POST" && p === "/chats") {
      const ms: GMember[] = (body.members ?? []).map((mm: any) => { const id = /users\('([^']+)'\)/.exec(mm["user@odata.bind"] ?? "")?.[1] ?? ""; const uu = [...this.users.values()].find((v) => v.id === id || v.mail === id); return uu ? this.member(uu.id, mm.roles) : undefined; }).filter(Boolean);
      if (ms.length !== (body.members ?? []).length) return this.err(r, 404, "Request_ResourceNotFound");
      if (body.chatType === "oneOnOne") { const ids = ms.map((mm) => mm.userId).sort().join(); const ex = [...this.chats.values()].find((c) => c.chatType === "oneOnOne" && c.members.map((mm) => mm.userId).sort().join() === ids); if (ex) return this.send(r, 200, this.chatJson(ex, meId)); }
      const c: FChat = { id: `19:${randomUUID()}@thread.v2`, chatType: body.chatType, topic: body.topic ?? null, members: ms }; this.chats.set(c.id, c); this.msgs.set(c.id, []);
      return this.send(r, 201, this.chatJson(c, meId));
    }
    if ((x = m(/^\/chats\/([^/]+)$/))) {
      const c = this.chats.get(x[1]); if (!c) return this.err(r, 404, "NotFound");
      if (method === "GET") return this.send(r, 200, this.chatJson(c, meId));
      if (method === "PATCH") { if (c.chatType !== "group") return this.err(r, 400, "BadRequest"); c.topic = body.topic; return this.send(r, 200, this.chatJson(c, meId)); }
    }
    if ((x = m(/^\/chats\/([^/]+)\/members(?:\/([^/]+))?$/))) {
      const c = this.chats.get(x[1]); if (!c) return this.err(r, 404, "NotFound");
      if (method === "GET") return this.send(r, 200, { value: c.members });
      if (method === "POST") { const id = /users\('([^']+)'\)/.exec(body["user@odata.bind"] ?? "")?.[1] ?? ""; const uu = [...this.users.values()].find((v) => v.id === id || v.mail === id); if (!uu) return this.err(r, 404, "NotFound"); const mm = this.member(uu.id, body.roles); c.members.push(mm); return this.send(r, 201, mm); }
      if (method === "DELETE") { if (c.chatType !== "group") return this.err(r, 400, "BadRequest"); c.members = c.members.filter((mm) => mm.id !== x![2]); return this.send(r, 204); }
    }
    if (method === "POST" && (x = m(/^\/chats\/([^/]+)\/markChatReadForUser$/))) { const c = this.chats.get(x[1]); if (!c || !body?.user?.id) return this.err(r, 400, "BadRequest"); c.lastRead = this.now(); return this.send(r, 204); }

    if ((x = m(/^\/chats\/([^/]+)\/pinnedMessages(?:\/([^/]+))?$/))) { // pinnedChatMessageInfo
      const c = this.chats.get(x[1]); if (!c) return this.err(r, 404, "NotFound");
      const list = (this.pinned.get(x[1]) ?? (this.pinned.set(x[1], []), this.pinned.get(x[1])!));
      if (method === "GET") return this.send(r, 200, { value: list.map((p) => ({ id: p.id, ...(u.searchParams.get("$expand") === "message" ? { message: this.find(x![1], p.messageId) } : {}) })) });
      if (method === "POST") { const mid = /messages\/([^/]+)$/.exec(body["message@odata.bind"] ?? "")?.[1]; if (!mid || !this.find(x[1], decodeURIComponent(mid))) return this.err(r, 404, "NotFound"); const p = { id: "pin" + ++this.seq, messageId: decodeURIComponent(mid) }; list.push(p); return this.send(r, 201, { id: p.id }); }
      if (method === "DELETE") { const i = list.findIndex((p) => p.id === x![2]); if (i < 0) return this.err(r, 404, "NotFound"); list.splice(i, 1); return this.send(r, 204); }
    }
    // ---- messages (chat + channel share the code through a resolved container)
    const cm = m(/^\/chats\/([^/]+)\/messages(\/.*)?$/), tm = m(/^\/teams\/([^/]+)\/channels\/([^/]+)\/messages(\/.*)?$/);
    if (method === "POST" && (x = m(/^\/users\/([^/]+)\/chats\/([^/]+)\/messages\/([^/]+)\/softDelete$/))) { const mm = this.find(x[2], x[3]); if (!mm || mm.from?.user?.id !== meId) return this.err(r, 404, "NotFound"); mm.deletedDateTime = this.now(); this.touch(mm); return this.send(r, 204); }
    if (cm || tm) {
      let container: string, rest: string;
      if (cm) { if (!this.chats.get(cm[1])?.members.some((mm) => mm.userId === meId)) return this.err(r, 404, "NotFound"); container = cm[1]; rest = cm[2] ?? ""; }
      else { container = `${tm![1]}/${tm![2]}`; if (!this.msgs.has(container)) return this.err(r, 404, "NotFound"); rest = tm![3] ?? ""; }
      const isChan = !!tm; const list = this.msgs.get(container)!;
      if (isChan && /^\/(delta)?$|^$/.test(rest) && method === "GET" && !rest.includes("delta") && !this.scope.includes("ChannelMessage.Read.All")) return this.err(r, 403, "Forbidden");
      if (method === "GET" && rest === "/delta") {
        if (isChan && !this.scope.includes("ChannelMessage.Read.All")) return this.err(r, 403, "Forbidden");
        const tokenQ = u.searchParams.get("$deltatoken"); const f = /lastModifiedDateTime gt (\S+)/.exec(u.searchParams.get("$filter") ?? "")?.[1];
        const since = tokenQ ?? f ?? "1970-01-01T00:00:00Z";
        const items = list.filter((mm) => Date.parse(mm.lastModifiedDateTime!) > Date.parse(since)).map((mm) => (isChan ? mm : mm));
        const pg = this.page(u, items, p) as any;
        if (!pg["@odata.nextLink"]) { const mx = items.reduce((a, mm) => (mm.lastModifiedDateTime! > a ? mm.lastModifiedDateTime! : a), since); pg["@odata.deltaLink"] = `${this.graph}${p}?$deltatoken=${encodeURIComponent(mx)}`; }
        return this.send(r, 200, pg);
      }
      if (method === "GET" && rest === "") {
        if (isChan && !this.scope.includes("ChannelMessage.Read.All")) return this.err(r, 403, "Forbidden");
        const expand = /replies/.test(u.searchParams.get("$expand") ?? ""); if (expand && this.rejectExpand) return this.err(r, 400, "BadRequest");
        let items = list.filter((mm) => !(isChan && mm.replyToId)); const lt = /createdDateTime lt (\S+)/.exec(u.searchParams.get("$filter") ?? "")?.[1];
        if (lt) items = items.filter((mm) => Date.parse(mm.createdDateTime!) < Date.parse(lt));
        items = [...items].sort((a, b) => Date.parse(b.createdDateTime!) - Date.parse(a.createdDateTime!));
        const pg = this.page(u, items, p); pg.value = pg.value.map((mm) => this.withReplies(container, mm, expand)); return this.send(r, 200, pg);
      }
      if (method === "POST" && rest === "") return this.create(r, container, meId, me, body, isChan ? undefined : undefined);
      const mr = /^\/([^/]+)(?:\/replies(?:\/([^/]+))?)?(\/.*)?$/.exec(rest);
      if (mr) {
        const parentId = mr[1], replyId = mr[2]; const sub = mr[3] ?? "";
        const isReplies = /\/replies/.test(rest);
        if (isReplies && !replyId && !sub && method === "POST") return this.create(r, container, meId, me, body, parentId);
        if (isReplies && !replyId && !sub && method === "GET") { if (!this.scope.includes("ChannelMessage.Read.All")) return this.err(r, 403, "Forbidden"); return this.send(r, 200, this.page(u, list.filter((mm) => mm.replyToId === parentId), p)); }
        const target = this.find(container, replyId ?? parentId); if (!target) return this.err(r, 404, "NotFound");
        const mine = target.from?.user?.id === meId;
        if (method === "GET" && sub === "") return this.send(r, 200, target);
        if (method === "PATCH" && sub === "") { if (!mine) return this.err(r, 403, "Forbidden"); target.body = { contentType: body.body?.contentType ?? "html", content: body.body?.content ?? "" }; target.lastEditedDateTime = this.now(); this.touch(target); return this.send(r, 204); }
        if (method === "POST" && sub === "/softDelete") { if (!mine) return this.err(r, 403, "Forbidden"); target.deletedDateTime = this.now(); this.touch(target); return this.send(r, 204); }
        if (method === "POST" && (sub === "/setReaction" || sub === "/unsetReaction")) {
          target.reactions = (target.reactions ?? []).filter((rx) => !(rx.reactionType === body.reactionType && rx.user?.user?.id === meId));
          if (sub === "/setReaction") target.reactions.push({ reactionType: body.reactionType, createdDateTime: this.now(), user: { user: { id: meId, displayName: me.displayName } } });
          this.touch(target); return this.send(r, 204);
        }
        if (method === "GET" && (x = /^\/hostedContents\/([^/]+)\/\$value$/.exec(sub))) { const h = this.hosted.get(`${target.id}/${x[1]}`); return h ? this.send(r, 200, h.data, { "Content-Type": h.type }) : this.err(r, 404, "NotFound"); }
      }
    }
    // ---- teams
    if (method === "GET" && p === "/me/joinedTeams") return this.send(r, 200, { value: [...this.teams.values()].map((t) => ({ id: t.id, displayName: t.displayName })) });
    if (method === "GET" && (x = m(/^\/teams\/([^/]+)\/(allChannels|channels)$/))) { const t = this.teams.get(x[1]); return t ? this.send(r, 200, { value: t.channels }) : this.err(r, 404, "NotFound"); }
    if (method === "GET" && (x = m(/^\/teams\/([^/]+)\/channels\/([^/]+)\/members$/))) return this.err(r, 403, "Forbidden");
    if (method === "GET" && (x = m(/^\/teams\/([^/]+)\/channels\/([^/]+)\/filesFolder$/))) return this.send(r, 200, { id: "folder-1", parentReference: { driveId: "drive-ch" }, name: "General" });
    // ---- files
    if (method === "GET" && (x = m(/^\/shares\/([^/]+)\/driveItem\/content$/))) { const f = this.files.get(x[1]); return f ? this.send(r, 200, f, { "Content-Type": "application/pdf" }) : this.err(r, 404, "itemNotFound"); }
    if (method === "PUT" && (x = m(/^\/(me\/drive\/root|drives\/[^/]+\/items\/[^/]+):\/(.+):\/content$/))) { this.drive.set(x[2], new Uint8Array(raw)); return this.send(r, 201, { id: "item-" + this.drive.size, name: x[2].split("/").pop(), webUrl: `${this.url}/sp/${encodeURIComponent(x[2])}`, eTag: `"{${randomUUID()}},1"`, parentReference: { driveId: "drive-1" } }); }
    if (method === "POST" && (x = m(/^\/(me\/drive|drives\/[^/]+)\/items\/([^/]+)\/createLink$/))) return this.send(r, 201, { link: { webUrl: `${this.url}/sp/link/${x[2]}` } });
    this.err(r, 404, "NotFound");
  }

  private create(r: ServerResponse, container: string, meId: string, me: FUser, body: any, parentId?: string) {
    const html: string = body.body?.content ?? ""; if (!html && !body.attachments?.length) return this.err(r, 400, "BadRequest");
    const extra: Partial<GMessage> = { mentions: body.mentions ?? [], importance: body.importance ?? "normal", subject: body.subject ?? null, attachments: (body.attachments ?? []).map((a: GAttachment) => ({ ...a })) };
    if (parentId) extra.replyToId = parentId;
    const m = this.say(container, meId, html, extra); m.body = { contentType: body.body?.contentType ?? "html", content: html };
    // hostedContents: replace temporary ids in the body
    for (const h of body.hostedContents ?? []) {
      const hid = "hc-" + randomUUID().slice(0, 6); this.hosted.set(`${m.id}/${hid}`, { type: h.contentType, data: Buffer.from(h.contentBytes, "base64") });
      m.body.content = m.body.content!.replace(`../hostedContents/${h["@microsoft.graph.temporaryId"]}/$value`, `${this.graph}/chats/x/messages/${m.id}/hostedContents/${hid}/$value`);
    }
    void me; this.send(r, 201, m);
  }

  private chatJson(c: FChat, _meId: string) {
    const last = [...(this.msgs.get(c.id) ?? [])].sort((a, b) => Date.parse(b.createdDateTime!) - Date.parse(a.createdDateTime!))[0];
    return { id: c.id, chatType: c.chatType, topic: c.topic, createdDateTime: "2026-01-01T00:00:00Z", members: c.members, lastMessagePreview: last ? { id: last.id, createdDateTime: last.createdDateTime, messageType: last.messageType, from: last.from, body: last.body, attachments: last.attachments, isDeleted: !!last.deletedDateTime, eventDetail: last.eventDetail } : null, viewpoint: { lastMessageReadDateTime: c.lastRead ?? "2000-01-01T00:00:00Z", isHidden: false } };
  }
}
