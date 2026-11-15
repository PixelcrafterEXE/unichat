// Realtime channel: Instagram's app speaks MQTT (3.1.1 dialect "MQTToT") over WebSocket to edge-mqtt.facebook.com. The CONNECT packet
// carries a zlib-deflated compact-Thrift struct as client id, and PUBLISH payloads are deflated JSON. This is a small own implementation
// of exactly that (no dependency). EVERYTHING in this file is reverse-engineered from memory of public client code and could not be
// verified against the real service (see README "Hypotheses"). The connector survives it not working: polling keeps running.
import { deflateSync, inflateSync, inflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { dbg } from "./api.js";

export const TOPICS = { pubsub: "88", sendMessage: "132", sendMessageResponse: "133", subIris: "134", subIrisResponse: "135", messageSync: "146", realtimeSub: "149", regionHint: "150" } as const;
export const SUBSCRIBE_TOPICS = [88, 135, 149, 150, 133, 146];

// ---------------------------------------------------------------- compact Thrift writer (only what CONNECT needs)
export class ThriftWriter {
  private b: number[] = []; private stack: number[] = []; private last = 0;
  private varint(n: bigint) { while (n > 0x7fn) { this.b.push(Number(n & 0x7fn) | 0x80); n >>= 7n; } this.b.push(Number(n)); }
  private zig(n: bigint) { return n >= 0n ? n << 1n : ((-n) << 1n) - 1n; }
  private field(id: number, type: number) { const d = id - this.last; if (d > 0 && d <= 15) this.b.push((d << 4) | type); else { this.b.push(type); this.varint(this.zig(BigInt(id))); } this.last = id; }
  str(id: number, v: string) { this.field(id, 8); const buf = Buffer.from(v); this.varint(BigInt(buf.length)); this.b.push(...buf); }
  i32(id: number, v: number) { this.field(id, 5); this.varint(this.zig(BigInt(v))); }
  i64(id: number, v: bigint | number) { this.field(id, 6); this.varint(this.zig(BigInt(v))); }
  bool(id: number, v: boolean) { this.field(id, v ? 1 : 2); }
  i32List(id: number, v: number[]) { this.field(id, 9); if (v.length < 15) this.b.push((v.length << 4) | 5); else { this.b.push(0xf5); this.varint(BigInt(v.length)); } for (const x of v) this.varint(this.zig(BigInt(x))); }
  begin(id: number) { this.field(id, 12); this.stack.push(this.last); this.last = 0; }
  end() { this.b.push(0); this.last = this.stack.pop() ?? 0; }
  done() { this.b.push(0); return Buffer.from(this.b); }
}

export interface ConnectInfo { userId: string; deviceId: string; userAgent: string; authorization: string; appId?: string }
/** The deflated Thrift blob that goes into the MQTT "client identifier" slot. `authorization` is the session secret: it is only ever put in this payload. */
export function buildConnectPayload(c: ConnectInfo): Buffer {
  const w = new ThriftWriter();
  w.str(1, c.deviceId.replace(/-/g, "").slice(0, 20));
  w.begin(4);
  w.i64(1, BigInt(c.userId)); w.str(2, c.userAgent); w.i64(3, 3n); w.i64(4, 0n); w.i32(5, 1);
  w.bool(6, true); w.bool(7, false); w.str(8, c.deviceId); w.bool(9, true); w.i32(10, 1); w.i32(11, 0);
  w.i64(12, BigInt("0x" + randomBytes(4).toString("hex"))); w.i32List(14, SUBSCRIBE_TOPICS);
  w.str(15, "cookie_auth"); w.i64(16, BigInt(c.appId ?? "567067343352427")); w.str(18, ""); w.i32(19, 3);
  w.end();
  w.str(5, c.authorization);
  return deflateSync(w.done());
}

// ---------------------------------------------------------------- MQTT 3.1.1 packets
const rl = (n: number) => { const o: number[] = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; o.push(d); } while (n > 0); return Buffer.from(o); };
const mstr = (s: string | Buffer) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
export const pkt = (first: number, body: Buffer) => Buffer.concat([Buffer.from([first]), rl(body.length), body]);
export function connectPacket(clientId: Buffer, keepAlive = 20): Buffer {
  return pkt(0x10, Buffer.concat([mstr("MQTToT"), Buffer.from([3, 0x02, keepAlive >> 8, keepAlive & 255]), mstr(clientId)]));
}
export function publishPacket(topic: string, payload: Buffer, id: number): Buffer { const i = Buffer.alloc(2); i.writeUInt16BE(id); return pkt(0x32, Buffer.concat([mstr(topic), i, payload])); }
export interface Packet { type: number; flags: number; body: Buffer }
/** Splits a buffer into packets; returns the rest (incomplete tail). */
export function parsePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = []; let p = 0;
  while (p < buf.length) {
    let m = 1, len = 0, q = p + 1, ok = false;
    while (q < buf.length) { const d = buf[q++]; len += (d & 127) * m; m *= 128; if (!(d & 128)) { ok = true; break; } if (m > 128 ** 4) throw new Error("bad length"); }
    if (!ok || q + len > buf.length) break;
    packets.push({ type: buf[p] >> 4, flags: buf[p] & 15, body: buf.subarray(q, q + len) }); p = q + len;
  }
  return { packets, rest: buf.subarray(p) };
}
export function parsePublish(p: Packet): { topic: string; id?: number; payload: Buffer } {
  const tl = p.body.readUInt16BE(0), topic = p.body.subarray(2, 2 + tl).toString(); let o = 2 + tl; let id: number | undefined;
  if ((p.flags >> 1) & 3) { id = p.body.readUInt16BE(o); o += 2; }
  return { topic, id, payload: p.body.subarray(o) };
}
export const inflate = (b: Buffer): Buffer => { try { return inflateSync(b); } catch { try { return inflateRawSync(b); } catch { return b; } } };

// ---------------------------------------------------------------- the realtime session
export interface SyncOp { op: string; path: string; value?: unknown }
export interface RealtimeOpts {
  url: string; headers: Record<string, string>; connect: () => Buffer | undefined;
  iris: () => { seq_id: number; snapshot_at_ms: number } | undefined;
  onOps: (ops: SyncOp[]) => void;
  onPubsub: (ops: SyncOp[]) => void;
  onClose: (everConnected: boolean, reason: string) => void;
  onOpen: () => void;
}
export class Realtime {
  private ws?: WebSocket; private buf: Buffer = Buffer.alloc(0); private ping?: NodeJS.Timeout; private pid = 1; private connected = false; private closed = false;
  private readonly o: RealtimeOpts;
  constructor(o: RealtimeOpts) { this.o = o; }
  get isOpen() { return this.connected; }
  start() {
    const cp = this.o.connect(); if (!cp) { this.o.onClose(false, "no-session"); return; }
    let ws: WebSocket;
    try { ws = new WebSocket(this.o.url, ["mqtt"], { headers: this.o.headers, handshakeTimeout: 20000 }); } catch { this.o.onClose(false, "ws-init"); return; }
    this.ws = ws;
    ws.on("open", () => ws.send(connectPacket(cp)));
    ws.on("message", (d: Buffer) => this.data(Buffer.isBuffer(d) ? d : Buffer.from(d as any)));
    ws.on("error", () => { /* details can contain URLs/headers: reported via close with a fixed reason */ });
    ws.on("close", () => this.finish("closed"));
    ws.on("unexpected-response", () => this.finish("rejected"));
  }
  private finish(reason: string) {
    if (this.closed) return; this.closed = true; clearInterval(this.ping);
    const was = this.connected; this.connected = false; try { this.ws?.terminate(); } catch { /* ignore */ }
    this.o.onClose(was, reason);
  }
  stop() { this.closed = true; clearInterval(this.ping); this.connected = false; try { this.ws?.terminate(); } catch { /* ignore */ } }
  private data(d: Buffer) {
    let r; try { r = parsePackets(Buffer.concat([this.buf, d])); } catch { return this.finish("protocol"); }
    this.buf = Buffer.from(r.rest);
    for (const p of r.packets) {
      try {
        if (p.type === 2) { // CONNACK
          if (p.body[1] !== 0) return this.finish("refused");
          this.connected = true; this.o.onOpen();
          this.ping = setInterval(() => { try { this.ws?.send(Buffer.from([0xc0, 0])); } catch { /* ignore */ } }, 15000);
          const iris = this.o.iris(); if (iris) this.publish(TOPICS.subIris, { ...iris, level: 0, subscription: "iris" } as any);
        } else if (p.type === 3) {
          const m = parsePublish(p); if (m.id !== undefined) this.ws?.send(pkt(0x40, Buffer.from([m.id >> 8, m.id & 255])));
          this.onPublish(m.topic, inflate(m.payload));
        }
      } catch { dbg("realtime: malformed packet ignored"); }
    }
  }
  private onPublish(topic: string, payload: Buffer) {
    let j: any; try { j = JSON.parse(payload.toString("utf8")); } catch { return; }
    if (topic === TOPICS.messageSync) { const ops: SyncOp[] = []; for (const e of Array.isArray(j) ? j : [j]) for (const x of e?.data ?? []) ops.push(x); this.o.onOps(ops); }
    else if (topic === TOPICS.pubsub) { const ops: SyncOp[] = []; for (const x of j?.data ?? []) ops.push(x); this.o.onPubsub(ops); }
  }
  publish(topic: string, json: object) {
    if (!this.connected) throw new Error("realtime not connected");
    this.ws?.send(publishPacket(topic, deflateSync(Buffer.from(JSON.stringify(json))), (this.pid = (this.pid % 65534) + 1)));
  }
}
