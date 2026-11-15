// Threema provider via the Threema Gateway in end-to-end mode (own Gateway ID with its own key pair). See README.md for what this is and is NOT.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type {
  Attachment, Capabilities, Chat, Connector, Contact, CoreEvent, DeliveryStatus, HistoryQuery, LoginPrompt, Message, OutgoingMessage, ProviderFactory, Reaction,
} from "@unimsg/core";
import { Gateway, GatewayError, dbg } from "./api.js";
import { box, boxOpen, publicKeyOf, randomNonce, secretbox, secretboxOpen } from "./nacl.js";
import {
  ID_RE, MAX_TEXT_BYTES, RECEIPT, T, blobNonce, frame, hex, macOk, normaliseId, parseFileJson, parseGroupText, parseReceipt, receiptPayload, textPayload, unframe, unhex,
} from "./proto.js";
import { STATE_FILE, loadSealed, loadSession, saveSealed, saveSession, wipeAll, type Session } from "./secret.js";

const CALLBACK_PATH = "/threema/callback";
const MAX_MSGS = 600, MAX_BODY = 64 * 1024, MAX_FILE = 50 * 1024 * 1024;

/** Provider-level (maximal) capabilities. A connector without a callback listener reports a send-only subset. */
export const CAPABILITIES: Capabilities = {
  spaces: false, reactions: true, edits: false, deletes: false, replies: false, attachments: true, typing: false, readReceipts: true, markRead: true,
  startChat: true, createGroup: false, backfill: false, e2ee: true,
  polls: false, location: false, contactCards: false, avatars: false, privacy: false, sync: false, refreshChat: false,
};
const SEND_ONLY: Capabilities = { ...CAPABILITIES, reactions: false, readReceipts: false, markRead: false };

interface State {
  contacts: Record<string, { pk?: string; name?: string }>;
  groups: Record<string, { name: string }>;
  msgs: Message[];
  files: Record<string, { blob: string; key: string; mime: string; name?: string }>;
  seen: string[];
  unread: Record<string, string[]>;
}
const emptyState = (): State => ({ contacts: {}, groups: {}, msgs: [], files: {}, seen: [], unread: {} });
const fileKey = (chatId: string, msgId: string) => `${chatId}\u0000${msgId}`;

const TITLE =
  "Threema Gateway login. This is NOT your personal Threema account: it connects a separate Threema Gateway ID (starts with *) that you own, " +
  "and your contacts talk to THAT ID. Enter its Gateway ID, API secret and private key (hex). Optionally give a local port to receive replies " +
  "(see the README: Threema only delivers incoming messages to a public HTTPS callback URL that you must set up yourself).";

class ThreemaConnector implements Connector {
  private emit: (e: CoreEvent) => void = () => {};
  private session?: Session;
  private api?: Gateway;
  private mySk?: Uint8Array;
  private st: State = emptyState();
  private server?: Server;
  private listening = false;
  private stopped = true;
  private retry?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();
  private promptN = 0;
  private reconnectN = 0;
  private accountId: string; private dataDir: string;
  constructor(accountId: string, dataDir: string) { this.accountId = accountId; this.dataDir = dataDir; }

  get capabilities(): Capabilities { return this.listening ? CAPABILITIES : SEND_ONLY; }

  // ---------------------------------------------------------------- lifecycle
  async start(emit: (e: CoreEvent) => void): Promise<void> {
    this.emit = emit; this.stopped = false;
    this.session = loadSession(this.dataDir);
    if (!this.session) { this.state("needs-login"); this.prompt(); return; }
    this.st = { ...emptyState(), ...(loadSealed<State>(this.dataDir, STATE_FILE) ?? {}) };
    this.state("connecting");
    void this.begin();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    await this.closeListener();
  }
  async logout(): Promise<void> {
    await this.stop();
    this.session = undefined; this.api = undefined; this.mySk = undefined; this.st = emptyState();
    wipeAll(this.dataDir);   // Gateway IDs have no device list: nothing to remove remotely
  }

  private state(s: "connecting" | "needs-login" | "connected" | "disconnected", detail?: string) {
    this.emit({ type: "account", data: { id: this.accountId, state: s, detail } });
  }
  private err(code: string, message: string, fatal = false) { this.emit({ type: "error", data: { id: this.accountId, code, message, fatal } }); }
  private prompt(error?: string) {
    const p: LoginPrompt = {
      accountId: this.accountId, promptId: `threema-${++this.promptN}`, kind: "form", title: TITLE, error,
      warning: {
        severity: "warning",
        text: "Needs a Threema Gateway ID (not your personal ID; costs credits). Without a public HTTPS URL UniChat can only send.",
      },
      fields: [
        { name: "gatewayId", label: "Gateway ID (*XXXXXXX)", type: "text", placeholder: "*MYGATEW", required: true },
        { name: "secret", label: "API secret", type: "password", required: true },
        { name: "privateKey", label: "Private key (64 hex characters)", type: "password", placeholder: "private:... or hex", required: true },
        { name: "callbackPort", label: "Local port to receive callbacks (empty = send only)", type: "text", placeholder: "8765" },
        { name: "confirm", label: "I understand this is a Gateway bridge identity, not my personal Threema account", type: "checkbox", required: true },
      ],
    };
    this.emit({ type: "login", data: p });
  }

  async submitLogin(_promptId: string, v: Record<string, string>): Promise<void> {
    try {
      const gatewayId = normaliseId(v.gatewayId ?? "");
      if (!/^\*[0-9A-Z]{7}$/.test(gatewayId)) throw new Error("The Gateway ID must be 8 characters and start with * (for example *MYGATEW).");
      const secret = (v.secret ?? "").trim();
      if (!secret) throw new Error("Enter the API secret of the Gateway ID.");
      const keyHex = (v.privateKey ?? "").trim().replace(/^private:/i, "");
      if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("The private key must be 64 hex characters (optionally prefixed with private:).");
      const portStr = (v.callbackPort ?? "").trim();
      const callbackPort = portStr === "" ? 0 : Number(portStr);
      if (!Number.isInteger(callbackPort) || callbackPort < 0 || callbackPort > 65535) throw new Error("The callback port must be a number from 1 to 65535, or empty.");
      if (v.confirm !== "true") throw new Error("Please confirm that you understand this is a Gateway identity.");
      const sk = unhex(keyHex), pk = publicKeyOf(sk);
      const api = new Gateway(gatewayId, secret);
      await api.credits();                                   // proves ID + secret
      const registered = await api.pubkey(gatewayId).catch(() => "");
      if (registered && registered !== hex(pk)) throw new Error("This private key does not belong to the Gateway ID (its public key differs from the one registered at Threema).");
      this.session = { gatewayId, secret, privateKey: keyHex.toLowerCase(), callbackPort };
      saveSession(this.dataDir, this.session);
    } catch (e) {
      const m = e instanceof Error ? e.message : "Login failed.";
      this.prompt(m);
      throw new Error(m);
    }
    this.state("connecting");
    void this.begin();
  }

  /** Verify the credentials (retrying on network trouble), open the callback listener, report connected. */
  private async begin() {
    const s = this.session; if (!s) return;
    this.api = new Gateway(s.gatewayId, s.secret); this.mySk = unhex(s.privateKey);
    try { await this.api.credits(); }
    catch (e) {
      if (this.stopped) return;
      if (e instanceof GatewayError && e.status === 401) return this.lostLogin();
      this.state("disconnected", "Cannot reach the Threema Gateway; retrying.");
      const wait = Math.min(Number(process.env.UNIMSG_THREEMA_RETRY_MS ?? 5000) * 2 ** Math.min(this.reconnectN++, 4), 60000);
      this.retry = setTimeout(() => void this.begin(), wait);
      return;
    }
    if (this.stopped) return;
    this.reconnectN = 0;
    await this.openListener();
    if (this.stopped) return;
    this.state("connected", this.listening
      ? `Receiving callbacks on ${process.env.UNIMSG_THREEMA_CALLBACK_HOST ?? "127.0.0.1"}:${s.callbackPort}${CALLBACK_PATH} (needs a public HTTPS URL pointing here)`
      : "Send-only: no callback port configured, so replies cannot arrive.");
  }
  private lostLogin() {
    wipeAll(this.dataDir); this.session = undefined; this.api = undefined;
    void this.closeListener();
    this.state("needs-login"); this.prompt("The Threema Gateway no longer accepts the saved Gateway ID or secret. Enter them again.");
  }

  // ---------------------------------------------------------------- callback listener
  private async openListener() {
    const port = this.session?.callbackPort ?? 0;
    await this.closeListener();
    if (!port) return;
    const srv = createServer((req, res) => void this.onHttp(req, res));
    srv.requestTimeout = 15000; srv.headersTimeout = 10000;
    const ok = await new Promise<boolean>((done) => {
      srv.once("error", () => done(false));
      srv.listen(port, process.env.UNIMSG_THREEMA_CALLBACK_HOST ?? "127.0.0.1", () => done(true));
    });
    if (!ok) { this.err("callback-port", "The callback port is already in use or not allowed, so incoming Threema messages are off. Choose another port."); return; }
    this.server = srv; this.listening = true;
  }
  private async closeListener() {
    const s = this.server; this.server = undefined; this.listening = false;
    if (s) { s.closeAllConnections?.(); await new Promise((ok) => s.close(ok)); }
  }
  private async onHttp(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const end = (code: number) => { res.writeHead(code); res.end(); };
    try {
      if (req.method !== "POST" || req.url?.split("?")[0] !== CALLBACK_PATH) return end(404);
      const chunks: Buffer[] = []; let n = 0;
      for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) return end(413); chunks.push(c as Buffer); }
      const p = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const f = { from: p.get("from") ?? "", to: p.get("to") ?? "", messageId: p.get("messageId") ?? "", date: p.get("date") ?? "", nonce: p.get("nonce") ?? "", box: p.get("box") ?? "" };
      if (!this.session || !macOk(this.session.secret, f, p.get("mac") ?? "")) { dbg("callback rejected: bad MAC"); return end(403); }
      const code = await (this.chain = this.chain.then(() => this.incoming(f, p.get("nickname") ?? undefined), () => this.incoming(f, p.get("nickname") ?? undefined)));
      end(code as number);
    } catch { dbg("callback failed"); end(500); }
  }

  private async pubkeyOf(id: string): Promise<Uint8Array> {
    const c = this.st.contacts[id];
    if (c?.pk) return unhex(c.pk);
    const pk = await this.api!.pubkey(id);
    this.st.contacts[id] = { ...c, pk }; this.save();
    return unhex(pk);
  }
  private save() {
    this.st.msgs = this.st.msgs.slice(-MAX_MSGS);
    const keep = new Set(this.st.msgs.map((m) => fileKey(m.chatId, m.id)));
    for (const k of Object.keys(this.st.files)) if (!keep.has(k)) delete this.st.files[k];
    this.st.seen = this.st.seen.slice(-1000);
    try { saveSealed(this.dataDir, STATE_FILE, this.st); } catch { dbg("could not save state"); }
  }

  /** Handle one MAC-verified callback; returns the HTTP status for the Gateway (non-200 makes it retry). */
  private async incoming(f: { from: string; to: string; messageId: string; date: string; nonce: string; box: string }, nickname?: string): Promise<number> {
    try {
      if (!this.session || f.to !== this.session.gatewayId || !ID_RE.test(f.from) || !/^[0-9a-f]{16}$/i.test(f.messageId)) return 200;
      const mid = f.messageId.toLowerCase();
      if (this.st.seen.includes(mid)) return 200;
      let pk: Uint8Array;
      try { pk = await this.pubkeyOf(f.from); }
      catch (e) { if (e instanceof GatewayError && e.status === 404) return 200; return 503; }   // transient: let the Gateway retry
      const plain = boxOpen(unhex(f.box), unhex(f.nonce), pk, this.mySk!);
      const fr = plain && unframe(plain);
      this.st.seen.push(mid);
      if (!fr) { this.err("undecryptable", "A Threema message could not be decrypted and was dropped."); return 200; }
      const name = nickname?.trim().slice(0, 64);
      const c = (this.st.contacts[f.from] ??= {});
      if (name && (!c.name || c.name === f.from)) c.name = name;
      const time = new Date(Math.min(Number(f.date) * 1000 || Date.now(), Date.now() + 60000)).toISOString();
      switch (fr.type) {
        case T.TEXT: this.addIncoming(f.from, mid, time, new TextDecoder().decode(fr.data)); break;
        case T.FILE: {
          const j = parseFileJson(fr.data);
          if (!j) { dbg("unparseable file message"); break; }
          const kind: Attachment["kind"] = j.m.startsWith("image/") ? "image" : j.m.startsWith("video/") ? "video" : j.m.startsWith("audio/") ? "audio" : "file";
          this.st.files[fileKey(f.from, mid)] = { blob: j.b.toLowerCase(), key: j.k.toLowerCase(), mime: j.m, name: j.n };
          this.addIncoming(f.from, mid, time, j.d ?? "", [{ id: "file", kind, mime: j.m, name: j.n, size: typeof j.s === "number" ? j.s : undefined }]);
          break;
        }
        case T.GROUP_TEXT: {
          const g = parseGroupText(fr.data); if (!g) break;
          const chatId = `g:${g.creator}:${g.groupId}`;
          this.st.groups[chatId] ??= { name: "Threema group" };
          this.addIncoming(chatId, mid, time, g.text, undefined, f.from);
          break;
        }
        case T.RECEIPT: this.onReceipt(f.from, fr.data); this.save(); break;
        default: dbg(`ignored message type 0x${fr.type.toString(16)}`);
      }
      return 200;
    } catch { dbg("incoming handling failed"); return 200; }
  }

  private addIncoming(chatId: string, id: string, time: string, text: string, attachments?: Attachment[], senderId = chatId) {
    const m: Message = { id, chatId, sender: this.st.contacts[senderId]?.name ?? senderId, senderId, text, time, fromMe: false, attachments };
    this.st.msgs.push(m); (this.st.unread[chatId] ??= []).push(id);
    this.save();
    this.emit({ type: "message", data: m });
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  private onReceipt(from: string, data: Uint8Array) {
    const r = parseReceipt(data); if (!r) return;
    for (const id of r.ids) {
      const m = this.st.msgs.find((x) => x.chatId === from && x.id === id && x.fromMe);
      if (!m) continue;
      if (r.status === RECEIPT.RECEIVED || r.status === RECEIPT.READ) {
        const status: DeliveryStatus = r.status === RECEIPT.READ ? "read" : "delivered";
        if (m.status === "read" || (m.status === "delivered" && status === "delivered")) continue;
        m.status = status;
        this.emit({ type: "receipt", data: { chatId: from, messageId: id, status, by: from, at: new Date().toISOString() } });
      } else if (r.status === RECEIPT.ACK || r.status === RECEIPT.DECLINE) {
        const emoji = r.status === RECEIPT.ACK ? "👍" : "👎";
        const reactions = (m.reactions ?? []).map((x) => ({ ...x, senderIds: x.senderIds.filter((s) => s !== from) })).filter((x) => x.senderIds.length);
        reactions.push({ emoji, senderIds: [from] });
        m.reactions = reactions;
        this.emit({ type: "message-update", data: { chatId: from, messageId: id, patch: { reactions } } });
      }
    }
  }

  // ---------------------------------------------------------------- read
  async spaces() { return []; }
  async chats(): Promise<Chat[]> {
    const out: Chat[] = [];
    const ids = new Set([...Object.keys(this.st.contacts).filter((id) => this.st.contacts[id].pk || this.st.msgs.some((m) => m.chatId === id)), ...Object.keys(this.st.groups)]);
    for (const id of ids) {
      const last = [...this.st.msgs].reverse().find((m) => m.chatId === id);
      const group = id.startsWith("g:");
      out.push({
        id, accountId: this.accountId, provider: "threema", kind: group ? "group" : "dm",
        name: group ? this.st.groups[id]?.name ?? "Threema group" : this.st.contacts[id]?.name ?? id,
        lastMessageAt: last?.time, preview: last ? last.text || (last.attachments?.length ? "Attachment" : "") : undefined,
        unread: this.st.unread[id]?.length ?? 0, readOnly: group || undefined,
      });
    }
    return out.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  }
  async history(chatId: string, q: HistoryQuery): Promise<Message[]> {
    let all = this.st.msgs.filter((m) => m.chatId === chatId);
    if (q.beforeMessageId) { const i = all.findIndex((m) => m.id === q.beforeMessageId); if (i >= 0) all = all.slice(0, i); }
    return all.slice(-q.limit).map((m) => ({ ...m, accountId: this.accountId }));
  }
  async members(chatId: string): Promise<Contact[]> {
    if (chatId.startsWith("g:")) return [];
    return [{ id: chatId, name: this.st.contacts[chatId]?.name ?? chatId, handle: chatId }];
  }
  async downloadAttachment(chatId: string, messageId: string, _attachmentId: string) {
    const f = this.st.files[fileKey(chatId, messageId)];
    if (!f || !this.api) throw new Error("This attachment is no longer available.");
    const enc = await this.api.download(f.blob);
    const data = secretboxOpen(enc, blobNonce(1), unhex(f.key));
    if (!data) throw new Error("The attachment could not be decrypted.");
    return { data, mime: f.mime, name: f.name };
  }

  // ---------------------------------------------------------------- write
  private async sendRaw(to: string, type: number, payload: Uint8Array): Promise<string> {
    if (!this.api || !this.mySk) throw new Error("Not connected to the Threema Gateway.");
    const pk = await this.pubkeyOf(to);
    const nonce = randomNonce();
    try { return await this.api.sendE2E(to, hex(nonce), hex(box(frame(type, payload), nonce, pk, this.mySk))); }
    catch (e) { if (e instanceof GatewayError && e.status === 401) this.lostLogin(); throw e; }
  }

  async send(chatId: string, msg: OutgoingMessage): Promise<Message> {
    if (chatId.startsWith("g:")) throw new Error("Threema groups are receive-only here: send to the person directly.");
    if (!ID_RE.test(chatId)) throw new Error("This is not a Threema ID.");
    if (msg.location || msg.poll || msg.event || msg.contacts?.length) throw new Error("Threema (via the Gateway) only supports text and files in UniChat.");
    const atts = msg.attachments ?? [];
    if (new TextEncoder().encode(msg.text).length > MAX_TEXT_BYTES) throw new Error("This message is too long for Threema (limit 3500 bytes).");
    const now = new Date().toISOString();
    const mk = (id: string, text: string, attachments?: Attachment[]): Message => ({
      id, chatId, accountId: this.accountId, sender: "You", senderId: this.session!.gatewayId, text, time: now, fromMe: true, status: "sent", attachments,
    });
    const done: Message[] = [];
    if (!atts.length) {
      if (!msg.text.trim()) throw new Error("Nothing to send.");
      done.push(mk(await this.sendRaw(chatId, T.TEXT, textPayload(msg.text)), msg.text));
    }
    for (const [i, a] of atts.entries()) {
      if (a.data.length > MAX_FILE) throw new Error("This file is too large for Threema (limit 50 MB).");
      const key = new Uint8Array(randomBytes(32));
      const blob = await this.api!.upload(secretbox(a.data, blobNonce(1), key));
      const media = a.kind === "image" || a.kind === "video" || a.kind === "audio" ? 1 : 0;
      const json = { b: blob, k: hex(key), m: a.mime, n: a.name, s: a.data.length, j: media, i: media, ...(i === 0 && msg.text ? { d: msg.text } : {}) };
      const id = await this.sendRaw(chatId, T.FILE, textPayload(JSON.stringify(json)));
      this.st.files[fileKey(chatId, id)] = { blob, key: hex(key), mime: a.mime, name: a.name };
      done.push(mk(id, i === 0 ? msg.text : "", [{ id: "file", kind: a.kind, mime: a.mime, name: a.name, size: a.data.length }]));
    }
    for (const m of done) this.st.msgs.push(m);
    this.save();
    for (const m of done.slice(1)) this.emit({ type: "message", data: m });
    this.emit({ type: "chats-changed", data: { chatId } });
    return done[0];
  }

  async react(chatId: string, messageId: string, emoji: string | null): Promise<void> {
    const m = this.st.msgs.find((x) => x.chatId === chatId && x.id === messageId && !x.fromMe);
    if (!m) throw new Error("Threema reactions only work on messages you received.");
    if (emoji === null) throw new Error("Threema cannot withdraw an acknowledgement once sent.");
    const status = emoji === "👍" ? RECEIPT.ACK : emoji === "👎" ? RECEIPT.DECLINE : 0;
    if (!status) throw new Error("Threema only knows 👍 (acknowledge) and 👎 (decline).");
    await this.sendRaw(chatId, T.RECEIPT, receiptPayload(status, [unhex(messageId)]));
    const me = this.session!.gatewayId;
    const reactions: Reaction[] = [{ emoji, senderIds: [me], mine: true }];
    m.reactions = reactions; this.save();
    this.emit({ type: "message-update", data: { chatId, messageId, patch: { reactions } } });
  }

  async markRead(chatId: string, upToMessageId: string): Promise<void> {
    const list = this.st.unread[chatId] ?? [];
    const i = list.indexOf(upToMessageId);
    const ids = i < 0 ? list : list.slice(0, i + 1);
    if (!ids.length || chatId.startsWith("g:")) { delete this.st.unread[chatId]; this.save(); return; }
    for (let o = 0; o < ids.length; o += 50) await this.sendRaw(chatId, T.RECEIPT, receiptPayload(RECEIPT.READ, ids.slice(o, o + 50).map(unhex)));
    this.st.unread[chatId] = list.slice(ids.length);
    if (!this.st.unread[chatId].length) delete this.st.unread[chatId];
    this.save();
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  async startChat(handle: string): Promise<Chat> {
    const id = normaliseId(handle);
    if (!ID_RE.test(id)) throw new Error("A Threema ID is 8 characters (letters A-Z and digits).");
    try { await this.pubkeyOf(id); }
    catch (e) { if (e instanceof GatewayError && e.status === 404) throw new Error("Threema does not know this ID."); throw e; }
    this.save();
    this.emit({ type: "chats-changed", data: { chatId: id } });
    return { id, accountId: this.accountId, provider: "threema", kind: "dm", name: this.st.contacts[id]?.name ?? id };
  }
}

const factory: ProviderFactory = {
  name: "threema", displayName: "Threema Gateway", login: "form", deprecated: true, capabilities: CAPABILITIES,
  create: ({ accountId, dataDir }) => new ThreemaConnector(accountId, dataDir),
};
export default factory;
