// FAKE Threema infrastructure on 127.0.0.1 for the offline tests: rendezvous relay, mediator (D2M) with an embedded chat server (CSP), blob mirror
// + directory over HTTP. Written from the same public docs as the client (so it can only prove self-consistency, see README), NEVER talks to a real host.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { CSP_SERVER_KEYS_HEX } from "../config.js";
import { P, parseWire, sealOutgoing, u64le, type Wire } from "../csp.js";
import { cat, cspVouch, deriveDeviceGroupKeys, type DeviceGroupKeys } from "../keys.js";
import { beforenm, box, boxOpen, generateKeyPair, randomNonce, secretbox, secretboxOpen } from "../nacl.js";
import { decode, encode } from "../proto.js";
import { BeginTransaction, ClientUrlInfo, D2mClientHello, D2mServerHello, D2mServerInfo, DevicesInfo, DropDevice, TransactionInfo } from "../schemas.js";
import { T } from "../mediator.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex"), unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const wsPort = (s: WebSocketServer) => (s.address() as { port: number }).port;
const listen = (s: Server | WebSocketServer) => new Promise<void>((ok) => (s as Server).listen ? (s as Server).listen(0, "127.0.0.1", ok) : (s as WebSocketServer).address() ? ok() : (s as any).once("listening", ok));

// ---------------------------------------------------------------- rendezvous relay
export class FakeRendezvous {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }); paths = new Map<string, WebSocket[]>(); connections = 0;
  constructor() {
    this.wss.on("connection", (ws, req) => {
      this.connections++;
      const p = (req.url ?? "/").replace(/^\//, ""); const peers = this.paths.get(p) ?? []; if (peers.length >= 2) return ws.close(4000, "session full");
      peers.push(ws); this.paths.set(p, peers);
      ws.on("message", (d: Buffer, bin: boolean) => { const o = peers.find((x) => x !== ws); if (o && o.readyState === 1) o.send(d, { binary: bin }); });
      ws.on("close", (c) => { const o = peers.find((x) => x !== ws); if (o && o.readyState === 1) o.close(c === 1005 ? 1000 : c); });
    });
  }
  async start() { await listen(this.wss); return `ws://127.0.0.1:${wsPort(this.wss)}/`; }
  close() { return new Promise<void>((ok) => { for (const c of this.wss.clients) c.terminate(); this.wss.close(() => ok()); }); }
}

// ---------------------------------------------------------------- chat server + mediator
export interface Peer { id: string; sk: Uint8Array; pk: Uint8Array }
export const newPeer = (id: string): Peer => { const k = generateKeyPair(); return { id, sk: k.secretKey, pk: k.publicKey }; };

interface Dev { id: bigint; queue: { id: number; ts: bigint; flags: number; env: Uint8Array }[]; nextId: number; conn?: Conn; info: Uint8Array; policy: number; since: bigint }
class DevGroup { devs = new Map<bigint, Dev>(); leader?: bigint; tx?: { dev: bigint; scope: Uint8Array }; keys!: DeviceGroupKeys; identity!: string; sharedData?: Uint8Array; maxSlots: number; constructor(maxSlots: number) { this.maxSlots = maxSlots; } }
interface Conn { ws: WebSocket; dev: Dev; grp: DevGroup; csp?: CspSrv; dryDone: boolean }

/** Server side of the CSP handshake/frames (what the real chat server does behind the mediator). */
class CspSrv {
  private tsk = generateKeyPair(); private sck = new Uint8Array(randomBytes(16)); private buf = new Uint8Array(0); private cck?: Uint8Array; private tckPub?: Uint8Array;
  private state = 0; private ssn = 1; private csn = 1; private key?: Uint8Array; identity = ""; unblocked = false;
  private be: FakeBackend; private send: (b: Uint8Array) => void; private onPayload: (t: number, d: Uint8Array) => void; private fail: (why: string) => void;
  constructor(be: FakeBackend, send: (b: Uint8Array) => void, onPayload: (t: number, d: Uint8Array) => void, fail: (why: string) => void) { this.be = be; this.send = send; this.onPayload = onPayload; this.fail = fail; }
  private n = (c: Uint8Array, i: number) => cat(c, u64le(i));
  feed(b: Uint8Array) { this.buf = cat(this.buf, b); this.pump(); }
  private pump() {
    for (;;) {
      if (this.state === 0) {
        if (this.buf.length < 48) return; this.tckPub = this.buf.slice(0, 32); this.cck = this.buf.slice(32, 48); this.buf = this.buf.slice(48);
        const bx = secretbox(cat(this.tsk.publicKey, this.cck), this.n(this.sck, this.ssn++), beforenm(this.tckPub, this.be.cspKey.secretKey));
        this.send(cat(this.sck, bx)); this.key = beforenm(this.tckPub, this.tsk.secretKey); this.state = 1;
      } else if (this.state === 1) {
        if (this.buf.length < 144) return; const ld = secretboxOpen(this.buf.slice(0, 144), this.n(this.cck!, this.csn++), this.key!);
        if (!ld) return this.fail("login box"); const extLen = ld[38] | (ld[39] << 8);
        if (this.buf.length < 144 + extLen) return;
        const ext = secretboxOpen(this.buf.slice(144, 144 + extLen), this.n(this.cck!, this.csn++), this.key!); this.buf = this.buf.slice(144 + extLen);
        this.identity = new TextDecoder().decode(ld.subarray(0, 8)); const ckPub = this.be.identityPk.get(this.identity);
        if (!ext || !ckPub || new TextDecoder().decode(ld.subarray(8, 38)) !== "threema-clever-extension-field") return this.fail("login");
        const sckBack = ld.subarray(40, 56), vouch = ld.subarray(80, 112);
        const expect = cat(beforenm(ckPub, this.be.cspKey.secretKey), beforenm(ckPub, this.tsk.secretKey)); void expect;
        // vouch recomputed from the SERVER's point of view: DH(SK.secret, CK.public) and DH(TSK.secret, CK.public) equal the client's DHs
        const ok = timingSafeEqual(sckBack, this.sck) && timingSafeEqual(vouch, this.be.vouchFor(ckPub, this.tsk, this.sck, this.tckPub!));
        if (!ok) return this.fail("vouch");
        this.be.extensions.push(ext);
        this.send(secretbox(new Uint8Array(16), this.n(this.sck, this.ssn++), this.key!)); this.state = 2;
      } else {
        if (this.buf.length < 2) return; const len = this.buf[0] | (this.buf[1] << 8); if (this.buf.length < 2 + len) return;
        const p = secretboxOpen(this.buf.slice(2, 2 + len), this.n(this.cck!, this.csn++), this.key!); this.buf = this.buf.slice(2 + len);
        if (!p) return this.fail("frame"); this.onPayload(p[0], p.slice(4));
      }
    }
  }
  payload(type: number, data: Uint8Array) { const bx = secretbox(cat(Uint8Array.of(type, 0, 0, 0), data), this.n(this.sck, this.ssn++), this.key!); this.send(cat(Uint8Array.of(bx.length & 255, bx.length >> 8), bx)); }
}

export class FakeBackend {
  cspKey = (() => { const k = generateKeyPair(); return k; })();
  identityPk = new Map<string, Uint8Array>(); groups = new Map<string, DevGroup>();
  queue = new Map<string, Wire[]>(); outbox: Wire[] = []; acksSeen = 0; received: { type: number }[] = []; extensions: Uint8Array[] = [];
  reflectedLog: { by: bigint; env: Uint8Array }[] = []; serverTimeSkewMs = 0; closeOnClientHello = 0; connections = 0; cspClosers: (() => void)[] = [];
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  maxSlots: number;
  constructor(maxSlots = 3) { this.maxSlots = maxSlots; this.wss.on("connection", (ws, req) => this.onConn(ws, req.url ?? "/")); }
  async start() { await listen(this.wss); return `ws://127.0.0.1:${wsPort(this.wss)}/`; }
  get cspKeyHex() { return hex(this.cspKey.publicKey); }
  vouchFor(ckPub: Uint8Array, tsk: { secretKey: Uint8Array; publicKey: Uint8Array }, sck: Uint8Array, tckPub: Uint8Array) {
    // identical formula, evaluated with the server's secrets: cspVouch() takes (ckSecret, skPub, tskPub): use DH symmetry via a pseudo key pair
    return cspVouchServer(ckPub, this.cspKey.secretKey, tsk.secretKey, sck, tckPub);
  }
  registerIdentity(id: string, pk: Uint8Array) { this.identityPk.set(id, pk); }
  /** A device group exists as soon as a phone-side participant created it (the client derives the same keys from the DGK). */
  registerGroup(identity: string, dgk: Uint8Array, serverGroup = "ab") { void serverGroup; const keys = deriveDeviceGroupKeys(dgk); const g = new DevGroup(this.maxSlots); g.keys = keys; g.identity = identity; this.groups.set(hex(keys.dgpkPublic), g); return g; }
  dropFromServer(g: DevGroup, id: bigint, code = 4113) { const d = g.devs.get(id); d?.conn?.ws.close(code); g.devs.delete(id); if (g.leader === id) g.leader = undefined; }
  closeAll(code = 1011) { for (const g of this.groups.values()) for (const d of g.devs.values()) d.conn?.ws.close(code); }

  private ct(type: number, payload: Uint8Array) { const o = new Uint8Array(4 + payload.length); o[0] = type; o.set(payload, 4); return o; }
  private onConn(ws: WebSocket, url: string) {
    this.connections++;
    const hexInfo = url.replace(/^\//, ""); let info; try { info = decode(ClientUrlInfo, unhex(hexInfo)); } catch { return ws.close(4010); }
    const grp = this.groups.get(hex(info.deviceGroupId ?? new Uint8Array())); if (!grp) return ws.close(4010);
    const esk = generateKeyPair(), challenge = new Uint8Array(randomBytes(32)); let conn: Conn | undefined;
    ws.send(this.ct(T.SERVER_HELLO, encode(D2mServerHello, { version: 0, esk: esk.publicKey, challenge })));
    ws.on("message", (raw: Buffer) => {
      const m = new Uint8Array(raw); const type = m[0], p = m.subarray(4);
      if (!conn) {
        if (type !== T.CLIENT_HELLO) return ws.close(4010);
        const ch = decode(D2mClientHello, p); const r = ch.response as Uint8Array;
        const ok = r?.length === 72 && boxOpen(r.subarray(24), r.subarray(0, 24), grp.keys.dgpkPublic, esk.secretKey);
        if (!ok || !timingSafeEqual(ok, challenge)) return ws.close(4010);
        if (this.closeOnClientHello) return ws.close(this.closeOnClientHello);
        const id = ch.deviceId as bigint; let dev = grp.devs.get(id);
        if (ch.expectedDeviceSlotState !== (dev ? 1 : 0)) return ws.close(4115);
        if (!dev) { if (grp.devs.size >= grp.maxSlots) return ws.close(4111); dev = { id, queue: [], nextId: 1, info: ch.encryptedDeviceInfo, policy: ch.deviceSlotExpirationPolicy, since: 0n }; grp.devs.set(id, dev); }
        if (dev.conn) dev.conn.ws.close(4112);
        dev.info = ch.encryptedDeviceInfo; dev.since = BigInt(Date.now());
        conn = dev.conn = { ws, dev, grp, dryDone: false };
        ws.send(this.ct(T.SERVER_INFO, encode(D2mServerInfo, { currentTime: BigInt(Date.now() + this.serverTimeSkewMs), maxDeviceSlots: grp.maxSlots, deviceSlotState: ch.expectedDeviceSlotState, encryptedSharedDeviceData: grp.sharedData ?? new Uint8Array(0), reflectionQueueLength: dev.queue.length })));
        this.flush(conn);
        // chat server connection of this device (proxy)
        conn.csp = new CspSrv(this, (b) => ws.readyState === 1 && ws.send(this.ct(T.PROXY, b)), (t, d) => this.onCsp(conn!, t, d), () => ws.close(4001));
        return;
      }
      this.onD2m(conn, type, p);
    });
    ws.on("close", () => { if (conn && conn.dev.conn === conn) { conn.dev.conn = undefined; if (conn.grp.leader === conn.dev.id) { conn.grp.leader = undefined; this.elect(conn.grp); } if (conn.grp.tx?.dev === conn.dev.id) { const t = conn.grp.tx; conn.grp.tx = undefined; this.broadcastTxEnd(conn.grp, t.dev, t.scope); } } });
  }
  private flush(c: Conn) {
    for (const q of c.dev.queue) this.sendReflected(c, q);
    c.ws.send(this.ct(T.QUEUE_DRY, new Uint8Array(0))); c.dryDone = true; this.elect(c.grp);
  }
  private sendReflected(c: Conn, q: { id: number; ts: bigint; flags: number; env: Uint8Array }) {
    const h = new Uint8Array(16); const dv = new DataView(h.buffer); h[0] = 16; dv.setUint16(2, q.flags, true); dv.setUint32(4, q.id, true); dv.setBigUint64(8, q.ts, true);
    c.ws.send(this.ct(T.REFLECTED, cat(h, q.env)));
  }
  private elect(g: DevGroup) {
    if (g.leader !== undefined && g.devs.get(g.leader)?.conn) return;
    const c = [...g.devs.values()].find((d) => d.conn?.dryDone)?.conn; if (!c) return;
    g.leader = c.dev.id; c.ws.send(this.ct(T.LEADER, new Uint8Array(0)));
  }
  private broadcastTxEnd(g: DevGroup, dev: bigint, scope: Uint8Array) { for (const d of g.devs.values()) if (d.id !== dev && d.conn) d.conn.ws.send(this.ct(T.TX_ENDED, encode(TransactionInfo, { deviceId: dev, encryptedScope: scope }))); }
  /** Reflect an envelope (already encrypted by the sender) into the queues of every other device. */
  reflectFrom(g: DevGroup, from: bigint | undefined, env: Uint8Array, flags = 0): bigint {
    const ts = BigInt(Date.now()); this.reflectedLog.push({ by: from ?? 0n, env });
    for (const d of g.devs.values()) { if (d.id === from) continue; const q = { id: d.nextId++, ts, flags, env }; if (!(flags & 1) || d.conn) d.queue.push(q); if (d.conn?.dryDone) this.sendReflected(d.conn, q); }
    return ts;
  }
  private onD2m(c: Conn, type: number, p: Uint8Array) {
    const g = c.grp;
    switch (type) {
      case T.PROXY: c.csp?.feed(p); break;
      case T.REFLECT: { const hl = p[0], dv = new DataView(p.buffer, p.byteOffset, p.length); const flags = dv.getUint16(2, true), id = dv.getUint32(4, true);
        if (g.tx && g.tx.dev !== c.dev.id) return; // reflection is held back while another device owns a transaction (not modelled further)
        const ts = this.reflectFrom(g, c.dev.id, p.slice(hl), flags);
        if (!(flags & 1)) { const a = new Uint8Array(16); const adv = new DataView(a.buffer); adv.setUint32(4, id, true); adv.setBigUint64(8, ts, true); c.ws.send(this.ct(T.REFLECT_ACK, a)); } break; }
      case T.REFLECTED_ACK: { const id = new DataView(p.buffer, p.byteOffset, p.length).getUint32(4, true); c.dev.queue = c.dev.queue.filter((q) => q.id !== id); break; }
      case T.TX_BEGIN: { const b = decode(BeginTransaction, p); if (g.tx) { c.ws.send(this.ct(T.TX_REJECTED, encode(TransactionInfo, { deviceId: g.tx.dev, encryptedScope: g.tx.scope }))); } else { g.tx = { dev: c.dev.id, scope: b.encryptedScope }; c.ws.send(this.ct(T.TX_ACK, new Uint8Array(0))); } break; }
      case T.TX_COMMIT: { const t = g.tx; g.tx = undefined; c.ws.send(this.ct(T.TX_COMMIT_ACK, new Uint8Array(0))); if (t) this.broadcastTxEnd(g, t.dev, t.scope); break; }
      case T.GET_DEVICES: {
        const m = new Map<bigint, object>(); for (const d of g.devs.values()) m.set(d.id, { encryptedDeviceInfo: d.info, ...(d.conn ? { connectedSince: d.since } : { lastDisconnectAt: d.since }), deviceSlotExpirationPolicy: d.policy });
        c.ws.send(this.ct(T.DEVICES, encode(DevicesInfo, { augmentedDeviceInfo: m }))); break; }
      case T.DROP: { const id = decode(DropDevice, p).deviceId as bigint; const self = id === c.dev.id; c.ws.send(this.ct(T.DROP_ACK, encode(DropDevice, { deviceId: id }))); this.dropFromServer(g, id, 4113); if (self) c.ws.close(4113); break; }
      case T.SET_SDD: g.sharedData = p.slice(); break;
      default: break;
    }
  }
  // ---- chat server behaviour
  private onCsp(c: Conn, t: number, d: Uint8Array) {
    const csp = c.csp!; this.received.push({ type: t });
    switch (t) {
      case P.UNBLOCK: csp.unblocked = true; this.deliverQueued(csp, csp.identity); break;
      case P.OUT_MSG: { const w = parseWire(d); this.outbox.push(w); if (!(w.flags & 4)) csp.payload(P.OUT_ACK, cat(new TextEncoder().encode(w.receiver), u64le(w.messageId))); break; }
      case P.IN_ACK: { this.acksSeen++; const id = new DataView(d.buffer, d.byteOffset, d.length).getBigUint64(8, true); const q = this.queue.get(csp.identity) ?? []; this.queue.set(csp.identity, q.filter((w) => w.messageId !== id)); break; }
      case P.ECHO_REQ: csp.payload(P.ECHO_RES, d); break;
      default: break;
    }
  }
  private deliverQueued(csp: CspSrv, id: string) { for (const w of this.queue.get(id) ?? []) csp.payload(P.IN_MSG, cat(...[this.wireBytes(w)])); csp.payload(P.QUEUE_DONE, new Uint8Array(0)); }
  private wireBytes(w: Wire) { return rebuild(w); }
  /** A contact sends a message to `to` (queued; delivered to the leader once it unblocked incoming messages). */
  send(from: Peer, to: string, toPk: Uint8Array, type: number, body: Uint8Array, o: { id?: bigint; flags?: number; at?: number; nickname?: string } = {}): Wire {
    const wire = parseWire(sealOutgoing({ identity: from.id, ck: from.sk, peer: to, peerPk: toPk, type, body, messageId: o.id ?? BigInt("0x" + hex(randomBytes(8))), createdAtMs: o.at ?? Date.now(), nonce: randomNonce(), flags: o.flags ?? 1, nickname: o.nickname }));
    (this.queue.get(to) ?? this.queue.set(to, []).get(to)!).push(wire);
    for (const g of this.groups.values()) if (g.identity === to) { const lc = g.leader !== undefined ? g.devs.get(g.leader)?.conn?.csp : undefined; if (lc?.unblocked) lc.payload(P.IN_MSG, rebuild(wire)); }
    return wire;
  }
  replay(w: Wire) { for (const g of this.groups.values()) { const c = g.leader !== undefined ? g.devs.get(g.leader)?.conn?.csp : undefined; c?.payload(P.IN_MSG, rebuild(w)); } }
  async close() { await new Promise<void>((ok) => { for (const c of this.wss.clients) c.terminate(); this.wss.close(() => ok()); }); }
}
function rebuild(w: Wire): Uint8Array {
  const h = new Uint8Array(32); const dv = new DataView(h.buffer); const e = new TextEncoder();
  h.set(e.encode(w.sender), 0); h.set(e.encode(w.receiver), 8); dv.setBigUint64(16, w.messageId, true); dv.setUint32(24, w.createdAtS, true); h[28] = w.flags; dv.setUint16(30, w.metadataBox.length, true);
  return cat(h, w.legacyNickname, w.metadataBox, w.nonce, w.messageBox);
}
import { blake2b } from "../blake2b.js";
function cspVouchServer(ckPub: Uint8Array, skSecret: Uint8Array, tskSecret: Uint8Array, sck: Uint8Array, tckPub: Uint8Array) {
  const vouchKey = blake2b(new Uint8Array(0), { key: cat(beforenm(ckPub, skSecret), beforenm(ckPub, tskSecret)), salt: "v2", personal: "3ma-csp" });
  return blake2b(cat(sck, tckPub), { key: vouchKey });
}
void cspVouch; void box; void CSP_SERVER_KEYS_HEX;

// ---------------------------------------------------------------- blob mirror + directory (HTTP)
export class FakeHttp {
  blobs = new Map<string, { data: Uint8Array; persist: boolean; scope: string }>(); doneCalls: string[] = []; dir = new Map<string, { pk: Uint8Array; featureMask: bigint }>();
  rateLimitNext = 0; dirCalls = 0; blobCalls = 0; authHeaderSeen = false; lastQuery = new URLSearchParams(); expectedGroup = "";
  srv: Server = createServer((q, r) => void this.handle(q, r));
  async start() { await listen(this.srv); return `http://127.0.0.1:${(this.srv.address() as { port: number }).port}/`; }
  private async body(q: IncomingMessage): Promise<Buffer> { const c: Buffer[] = []; for await (const x of q) c.push(x as Buffer); return Buffer.concat(c); }
  private async handle(q: IncomingMessage, r: ServerResponse) {
    const u = new URL(q.url ?? "/", "http://x"); this.authHeaderSeen ||= !!q.headers.authorization;
    if (this.rateLimitNext > 0) { this.rateLimitNext--; r.writeHead(429).end(); return; }
    if (u.pathname === "/identity/fetch_bulk" && q.method === "POST") {
      this.dirCalls++; const ids = (JSON.parse((await this.body(q)).toString()) as { identities: string[] }).identities;
      r.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ identities: ids.filter((i) => this.dir.has(i)).map((i) => ({ identity: i, type: 0, publicKey: Buffer.from(this.dir.get(i)!.pk).toString("base64"), state: 0, featureMask: Number(this.dir.get(i)!.featureMask) })) })); return;
    }
    this.blobCalls++; this.lastQuery = u.searchParams;
    if (this.expectedGroup && u.searchParams.get("deviceGroupId") !== this.expectedGroup) { r.writeHead(403).end(); return; }
    if (u.pathname === "/upload" && q.method === "POST") {
      const raw = await this.body(q); const ct = q.headers["content-type"] ?? ""; const bnd = /boundary=(.+)$/.exec(ct)?.[1]; if (!bnd) { r.writeHead(400).end(); return; }
      const s = raw.toString("latin1"); const start = s.indexOf("\r\n\r\n") + 4, end = s.lastIndexOf("\r\n--" + bnd);
      const data = new Uint8Array(raw.subarray(start, end)); const id = hex(randomBytes(16));
      this.blobs.set(id, { data, persist: u.searchParams.get("persist") === "1", scope: u.searchParams.get("scope") ?? "" }); r.writeHead(200, { "content-type": "text/plain" }).end(id + "\n"); return;
    }
    const m = /^\/([0-9a-f]{32})(\/done)?$/.exec(u.pathname);
    if (m && q.method === "GET") { const b = this.blobs.get(m[1]); if (!b) { r.writeHead(404).end(); return; } r.writeHead(200).end(Buffer.from(b.data)); return; }
    if (m && m[2] && q.method === "POST") { this.doneCalls.push(m[1]); r.writeHead(204).end(); return; }
    r.writeHead(404).end();
  }
  addBlob(data: Uint8Array) { const id = hex(randomBytes(16)); this.blobs.set(id, { data, persist: true, scope: "public" }); return id; }
  close() { return new Promise<void>((ok) => { this.srv.closeAllConnections(); this.srv.close(() => ok()); }); }
}
