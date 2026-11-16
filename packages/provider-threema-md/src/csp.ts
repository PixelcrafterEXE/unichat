// Chat Server Protocol client session (login handshake + frames) running over the mediator's `proxy` byte stream, plus the message payload
// structs. Written from csp.struct.yml (Threema-protocol-notes (https://github.com/PixelcrafterEXE/unichat/wiki/Threema-protocol-notes) section 6).
import { EventEmitter } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { cat, cspVouch, metadataKey } from "./keys.js";
import { beforenm, generateKeyPair, secretbox, secretboxOpen } from "./nacl.js";
import { decode, encode, type Msg } from "./proto.js";
import { MessageMetadata } from "./schemas.js";

export const P = { ECHO_REQ: 0x00, ECHO_RES: 0x80, OUT_MSG: 0x01, OUT_ACK: 0x81, IN_MSG: 0x02, IN_ACK: 0x82, UNBLOCK: 0x03, QUEUE_DONE: 0xd0, COOKIE_CHANGED: 0xd2, CLOSE_ERROR: 0xe0, ALERT: 0xe1 } as const;
const td = new TextEncoder();
const u64le = (n: number | bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const cspNonce = (cookie: Uint8Array, n: number) => cat(cookie, u64le(n));
const MAGIC = "threema-clever-extension-field";

export interface CspOpts { identity: string; ck: Uint8Array; serverKeys: Uint8Array[]; deviceId: bigint; deviceCookie: Uint8Array; clientInfo: string; send: (b: Uint8Array) => void }
/** Events: ready(), payload(type, data), fail(Error) */
export class CspSession extends EventEmitter {
  private tck = generateKeyPair(); private cck = new Uint8Array(randomBytes(16));
  private buf = new Uint8Array(0); private state: "hello" | "ack" | "run" | "dead" = "hello";
  private csn = 1; private ssn = 1; private sck?: Uint8Array; private key?: Uint8Array; private tskPub?: Uint8Array; private skPub?: Uint8Array;
  private o: CspOpts;
  constructor(o: CspOpts) { super(); this.o = o; }
  start() { this.o.send(cat(this.tck.publicKey, this.cck)); }
  get ready() { return this.state === "run"; }
  private die(msg: string) { this.state = "dead"; this.emit("fail", new Error(msg)); }
  feed(b: Uint8Array) {
    this.buf = cat(this.buf, b);
    try { this.pump(); } catch { this.die("chat server protocol error"); }
  }
  private pump() {
    for (;;) {
      if (this.state === "hello") {
        if (this.buf.length < 80) return;
        const sck = this.buf.slice(0, 16), bx = this.buf.slice(16, 80); this.buf = this.buf.slice(80);
        for (const sk of this.o.serverKeys) {
          const p = secretboxOpen(bx, cspNonce(sck, 1), beforenm(sk, this.tck.secretKey));
          if (p && p.length === 48 && timingSafeEqual(p.subarray(32), this.cck) && !timingSafeEqual(sck, this.cck)) { this.sck = sck; this.tskPub = p.slice(0, 32); this.skPub = sk; break; }
        }
        if (!this.sck) return this.die("chat server authentication failed");
        this.ssn = 2; this.key = beforenm(this.tskPub!, this.tck.secretKey);
        this.sendLogin(); this.state = "ack";
      } else if (this.state === "ack") {
        if (this.buf.length < 32) return;
        const bx = this.buf.slice(0, 32); this.buf = this.buf.slice(32);
        const p = secretboxOpen(bx, cspNonce(this.sck!, this.ssn++), this.key!);
        if (!p) return this.die("chat server login rejected");
        this.state = "run"; this.emit("ready");
      } else if (this.state === "run") {
        if (this.buf.length < 2) return;
        const len = this.buf[0] | (this.buf[1] << 8);
        if (this.buf.length < 2 + len) return;
        const bx = this.buf.slice(2, 2 + len); this.buf = this.buf.slice(2 + len);
        const p = secretboxOpen(bx, cspNonce(this.sck!, this.ssn++), this.key!);
        if (!p || p.length < 4) return this.die("chat server frame invalid");
        this.emit("payload", p[0], p.slice(4));
      } else return;
    }
  }
  private sendLogin() {
    const ext = (t: number, d: Uint8Array) => cat(Uint8Array.of(t, d.length & 255, d.length >> 8), d);
    const exts = cat(ext(0, td.encode(this.o.clientInfo)), ext(1, u64le(this.o.deviceId)), ext(2, Uint8Array.of(1)), ext(3, this.o.deviceCookie));
    const ld = new Uint8Array(128); ld.set(td.encode(this.o.identity), 0); ld.set(td.encode(MAGIC), 8);
    ld[38] = (exts.length + 16) & 255; ld[39] = (exts.length + 16) >> 8;
    ld.set(this.sck!, 40); ld.set(cspVouch(this.o.ck, this.skPub!, this.tskPub!, this.sck!, this.tck.publicKey), 80);
    const b1 = secretbox(ld, cspNonce(this.cck, this.csn++), this.key!), b2 = secretbox(exts, cspNonce(this.cck, this.csn++), this.key!);
    this.o.send(cat(b1, b2));
  }
  sendPayload(type: number, data: Uint8Array) {
    if (this.state !== "run") throw new Error("chat server not connected");
    const c = cat(Uint8Array.of(type, 0, 0, 0), data);
    const bx = secretbox(c, cspNonce(this.cck, this.csn++), this.key!);
    this.o.send(cat(Uint8Array.of(bx.length & 255, bx.length >> 8), bx));
  }
}

// ---------- e2e container ----------
/** Padding: 1..255 random pad length, total >= 32 (csp.struct.yml e2e.container). */
export function padData(data: Uint8Array): Uint8Array {
  let pad = 1 + (randomBytes(1)[0] % 255);
  if (data.length + pad < 32) pad = 32 - data.length;
  return cat(data, new Uint8Array(pad).fill(pad));
}
export function unpad(p: Uint8Array): Uint8Array | undefined {
  const n = p[p.length - 1]; return n >= 1 && n <= p.length ? p.subarray(0, p.length - n) : undefined;
}

// ---------- message-with-metadata-box ----------
export interface Wire { sender: string; receiver: string; messageId: bigint; createdAtS: number; flags: number; legacyNickname: Uint8Array; metadataBox: Uint8Array; nonce: Uint8Array; messageBox: Uint8Array }
const ascii = (b: Uint8Array) => new TextDecoder().decode(b);
export function parseWire(d: Uint8Array): Wire {
  if (d.length < 8 + 8 + 8 + 4 + 1 + 1 + 2 + 32 + 24) throw new Error("short message");
  const dv = new DataView(d.buffer, d.byteOffset, d.length), ml = dv.getUint16(30, true);
  const o = 64 + ml;
  if (d.length < o + 24 + 16) throw new Error("short message");
  return { sender: ascii(d.subarray(0, 8)), receiver: ascii(d.subarray(8, 16)), messageId: dv.getBigUint64(16, true), createdAtS: dv.getUint32(24, true), flags: d[28],
    legacyNickname: d.slice(32, 64), metadataBox: d.slice(64, o), nonce: d.slice(o, o + 24), messageBox: d.slice(o + 24) };
}
export function buildWire(w: Omit<Wire, "legacyNickname"> & { legacyNickname?: Uint8Array }): Uint8Array {
  const h = new Uint8Array(32); const dv = new DataView(h.buffer);
  h.set(td.encode(w.sender), 0); h.set(td.encode(w.receiver), 8); dv.setBigUint64(16, w.messageId, true); dv.setUint32(24, w.createdAtS, true); h[28] = w.flags; dv.setUint16(30, w.metadataBox.length, true);
  return cat(h, w.legacyNickname ?? new Uint8Array(32), w.metadataBox, w.nonce, w.messageBox);
}
/** Encrypt an outgoing e2e message (type + body) for one receiver. */
export function sealOutgoing(o: { identity: string; ck: Uint8Array; peer: string; peerPk: Uint8Array; type: number; body: Uint8Array; messageId: bigint; createdAtMs: number; nonce: Uint8Array; flags: number; nickname?: string }): Uint8Array {
  const messageBox = secretbox(cat(Uint8Array.of(o.type), padData(o.body)), o.nonce, beforenm(o.peerPk, o.ck));
  const meta = encode(MessageMetadata, { padding: new Uint8Array(randomBytes(Math.max(0, 16 - (o.nickname?.length ?? 0)))), nickname: o.nickname, messageId: o.messageId, createdAt: o.createdAtMs });
  return buildWire({ sender: o.identity, receiver: o.peer, messageId: o.messageId, createdAtS: Math.floor(o.createdAtMs / 1000), flags: o.flags, nonce: o.nonce,
    metadataBox: secretbox(meta, o.nonce, metadataKey(o.ck, o.peerPk)), messageBox });
}
export interface Opened { type: number; body: Uint8Array; metadata?: Msg }
export function openIncoming(w: Wire, ck: Uint8Array, senderPk: Uint8Array): Opened | undefined {
  const p = secretboxOpen(w.messageBox, w.nonce, beforenm(senderPk, ck)); if (!p || p.length < 2) return undefined;
  const body = unpad(p.subarray(1)); if (!body) return undefined;
  let metadata: Msg | undefined;
  if (w.metadataBox.length) { const m = secretboxOpen(w.metadataBox, w.nonce, metadataKey(ck, senderPk)); if (m) { try { metadata = decode(MessageMetadata, m); } catch { /* ignore */ } } }
  return { type: p[0], body, metadata };
}
export const messageAck = (identity: string, id: bigint) => cat(td.encode(identity), u64le(id));
export { u64le };
