// D2M mediator client (PROTOCOL-NOTES.md section 5): handshake, reflect/reflected with acks, proxying of CSP bytes, transactions, device management.
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { cat, type DeviceGroupKeys } from "./keys.js";
import { box, beforenm, secretbox, secretboxOpen, randomNonce } from "./nacl.js";
import { decode, encode, type Msg } from "./proto.js";
import { BeginTransaction, ClientUrlInfo, D2mClientHello, D2mServerHello, D2mServerInfo, DeviceInfo, DevicesInfo, DropDevice, Enum, Envelope, SharedDeviceData, TransactionInfo, TransactionScope } from "./schemas.js";
import { dbg } from "./config.js";

export const T = { PROXY: 0x00, SERVER_HELLO: 0x10, CLIENT_HELLO: 0x11, SERVER_INFO: 0x12, QUEUE_DRY: 0x20, LEADER: 0x21, GET_DEVICES: 0x30, DEVICES: 0x31, DROP: 0x32, DROP_ACK: 0x33,
  SET_SDD: 0x34, TX_BEGIN: 0x40, TX_ACK: 0x41, TX_COMMIT: 0x42, TX_COMMIT_ACK: 0x43, TX_REJECTED: 0x44, TX_ENDED: 0x45, REFLECT: 0x80, REFLECT_ACK: 0x81, REFLECTED: 0x82, REFLECTED_ACK: 0x83 } as const;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const container = (type: number, payload: Uint8Array) => { const o = new Uint8Array(4 + payload.length); o[0] = type; o.set(payload, 4); return o; };
export class MediatorClose extends Error { code: number; constructor(code: number) { super(`mediator closed (${code})`); this.code = code; } }
/** Close codes that forbid an automatic reconnect (41xx, PROTOCOL-NOTES 5). */
export const noAutoReconnect = (c: number) => c >= 4100 && c <= 4199;

export interface MediatorOpts {
  url: string; serverGroup: string; keys: DeviceGroupKeys; deviceId: bigint; label: string; platformDetails: string; appVersion: string;
  expectedSlot: number; /** Enum.slotState */
}
export interface Reflected { id: number; flags: number; timestamp: bigint; envelope: Msg }
export interface ServerInfo { maxDeviceSlots: number; deviceSlotState: number; reflectionQueueLength: number; currentTime: bigint; sharedVersion?: number }

/** Events: reflected(Reflected), dry(), leader(), proxy(Uint8Array), close(code) */
export class Mediator extends EventEmitter {
  private ws?: WebSocket; private reflectId = 1;
  private acks = new Map<number, (ts: bigint) => void>();
  private waiters: { type: number; resolve: (p: Uint8Array) => void; reject: (e: Error) => void }[] = [];
  private closed?: number; private early = new Map<number, Uint8Array>();
  private held: [string, unknown[]][] | undefined = [];
  dry = false; leader = false;
  info?: ServerInfo;
  private o: MediatorOpts;
  constructor(o: MediatorOpts) { super(); this.o = o; this.setMaxListeners(0); }

  async connect(timeoutMs = 20_000): Promise<ServerInfo> {
    const urlInfo = encode(ClientUrlInfo, { deviceGroupId: this.o.keys.dgpkPublic, serverGroup: this.o.serverGroup });
    const ws = this.ws = new WebSocket(this.o.url + hex(urlInfo), { handshakeTimeout: timeoutMs, maxPayload: 1 << 20 });
    ws.on("message", (d: Buffer) => { try { this.onMessage(new Uint8Array(d)); } catch { dbg("mediator: bad message, closing"); ws.close(4010); } });
    ws.on("close", (c: number) => { this.closed = c; const e = new MediatorClose(c); for (const w of this.waiters.splice(0)) w.reject(e); this.emit("close", c); });
    ws.on("error", () => { /* reported via close */ });
    const opened = new Promise<void>((ok, fail) => { ws.once("open", ok); ws.once("close", (c: number) => fail(new MediatorClose(c || 1006))); });
    await opened;
    const hello = decode(D2mServerHello, await this.wait(T.SERVER_HELLO, timeoutMs));
    if (hello.esk?.length !== 32 || hello.challenge?.length !== 32) throw new Error("mediator: bad server hello");
    const nonce = randomNonce();
    const response = cat(nonce, box(hello.challenge, nonce, hello.esk, this.o.keys.dgpkSecret));
    const di = encode(DeviceInfo, { padding: new Uint8Array(randomBytes(1 + (randomBytes(1)[0] % 32))), platform: Enum.platformDesktop, platformDetails: this.o.platformDetails, appVersion: this.o.appVersion, label: this.o.label });
    const n2 = randomNonce();
    this.send(T.CLIENT_HELLO, encode(D2mClientHello, {
      version: 0, response, deviceId: this.o.deviceId, deviceSlotsExhaustedPolicy: 0, deviceSlotExpirationPolicy: 1, expectedDeviceSlotState: this.o.expectedSlot,
      encryptedDeviceInfo: cat(n2, secretbox(di, n2, this.o.keys.dgdik)),
    }));
    const si = decode(D2mServerInfo, await this.wait(T.SERVER_INFO, timeoutMs));
    this.info = { maxDeviceSlots: si.maxDeviceSlots ?? 0, deviceSlotState: si.deviceSlotState ?? 0, reflectionQueueLength: si.reflectionQueueLength ?? 0, currentTime: si.currentTime ?? 0n };
    if (si.encryptedSharedDeviceData?.length > 24) {
      const p = secretboxOpen(si.encryptedSharedDeviceData.subarray(24), si.encryptedSharedDeviceData.subarray(0, 24), this.o.keys.dgsddk);
      if (p) this.info.sharedVersion = decode(SharedDeviceData, p).version;
    }
    return this.info;
  }
  /** Events that arrive before the owner attached its handlers (reflection queue, proxy bytes, dry, leader) are held until flow(). */
  private out(name: string, ...args: unknown[]) { if (this.held) this.held.push([name, args]); else this.emit(name, ...args); }
  flow() { const h = this.held ?? []; this.held = undefined; for (const [n, a] of h) this.emit(n, ...a); }
  private send(type: number, payload: Uint8Array) { if (this.closed !== undefined || !this.ws) throw new MediatorClose(this.closed ?? 1006); this.ws.send(container(type, payload)); }
  private wait(type: number, ms: number): Promise<Uint8Array> {
    const e = this.early.get(type); if (e) { this.early.delete(type); return Promise.resolve(e); }
    return new Promise((resolve, reject) => {
      const tm = setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); reject(new Error("mediator: timeout")); }, ms);
      const w = { type, resolve: (p: Uint8Array) => { clearTimeout(tm); resolve(p); }, reject: (e: Error) => { clearTimeout(tm); reject(e); } };
      if (this.closed !== undefined) { clearTimeout(tm); reject(new MediatorClose(this.closed)); } else this.waiters.push(w);
    });
  }
  private onMessage(m: Uint8Array) {
    if (m.length < 4) throw new Error("short");
    const type = m[0], p = m.subarray(4);
    const wi = this.waiters.findIndex((w) => w.type === type);
    if (wi >= 0) { this.waiters.splice(wi, 1)[0].resolve(p); return; }
    if (type === T.SERVER_HELLO || type === T.SERVER_INFO) { this.early.set(type, p.slice()); return; } // arrived before wait() was called
    switch (type) {
      case T.PROXY: this.out("proxy", p.slice()); break;
      case T.QUEUE_DRY: this.dry = true; this.out("dry"); break;
      case T.LEADER: this.leader = true; this.out("leader"); break;
      case T.REFLECT_ACK: { const dv = new DataView(p.buffer, p.byteOffset, p.length); const id = dv.getUint32(4, true); this.acks.get(id)?.(dv.getBigUint64(8, true)); this.acks.delete(id); break; }
      case T.REFLECTED: {
        const hl = p[0]; const dv = new DataView(p.buffer, p.byteOffset, p.length);
        const flags = dv.getUint16(2, true), id = dv.getUint32(4, true), timestamp = dv.getBigUint64(8, true);
        const enc = p.subarray(hl);
        const plain = enc.length > 40 ? secretboxOpen(enc.subarray(24), enc.subarray(0, 24), this.o.keys.dgrk) : undefined;
        if (!plain) { dbg("reflected message undecryptable, dropped"); if (!(flags & 1)) this.ackReflected(id); break; }
        this.out("reflected", { id, flags, timestamp, envelope: decode(Envelope, plain) } satisfies Reflected);
        break;
      }
      case T.TX_ENDED: this.emit("tx-ended"); break;
      default: dbg(`mediator: unhandled type ${type}`);
    }
  }
  ackReflected(id: number) { const b = new Uint8Array(8); new DataView(b.buffer).setUint32(4, id, true); this.send(T.REFLECTED_ACK, b); }
  sendProxy(bytes: Uint8Array) { this.send(T.PROXY, bytes); }

  /** Reflect an envelope (our device id + padding added). Resolves with the server timestamp of the reflect-ack. */
  reflect(body: Msg, ephemeral = false): Promise<bigint> {
    const env = encode(Envelope, { padding: new Uint8Array(randomBytes(randomBytes(1)[0] % 16)), deviceId: this.o.deviceId, protocolVersion: Enum.d2dVersion, ...body });
    const n = randomNonce(), enc = cat(n, secretbox(env, n, this.o.keys.dgrk));
    const id = this.reflectId++;
    const h = new Uint8Array(8); const dv = new DataView(h.buffer); dv.setUint8(0, 8); dv.setUint16(2, ephemeral ? 1 : 0, true); dv.setUint32(4, id, true);
    return new Promise((ok, fail) => {
      const tm = setTimeout(() => { this.acks.delete(id); fail(new Error("mediator: reflect not acknowledged")); }, 30_000);
      this.acks.set(id, (ts) => { clearTimeout(tm); ok(ts); });
      this.once("close", () => { clearTimeout(tm); fail(new MediatorClose(this.closed ?? 1006)); });
      try { this.send(T.REFLECT, cat(h, enc)); } catch (e) { clearTimeout(tm); fail(e as Error); }
    });
  }

  private scope(s: number) { const n = randomNonce(); return cat(n, secretbox(encode(TransactionScope, { scope: s }), n, this.o.keys.dgtsk)); }
  /** Run `fn` inside a transaction. `precondition` runs after every Begin ack (false = commit without doing anything). */
  async transaction<R>(scope: number, fn: () => Promise<R>, precondition?: () => boolean): Promise<R | undefined> {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (precondition && !precondition()) return undefined;
      this.send(T.TX_BEGIN, encode(BeginTransaction, { encryptedScope: this.scope(scope), ttl: 30 }));
      const outcome = await new Promise<"ack" | "rejected">((ok, fail) => {
        const onClose = () => fail(new MediatorClose(this.closed ?? 1006));
        this.once("close", onClose);
        const wa = this.wait(T.TX_ACK, 20_000).then(() => "ack" as const), wr = this.wait(T.TX_REJECTED, 20_000).then(() => "rejected" as const);
        Promise.race([wa, wr]).then((r) => { this.off("close", onClose); ok(r); }, (e) => { this.off("close", onClose); fail(e); });
        wa.catch(() => {}); wr.catch(() => {});
      });
      if (outcome === "rejected") { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); this.waiters = this.waiters.filter((w) => w.type !== T.TX_ACK); continue; }
      this.waiters = this.waiters.filter((w) => w.type !== T.TX_REJECTED);
      try {
        if (precondition && !precondition()) return undefined;
        return await fn();
      } finally { try { this.send(T.TX_COMMIT, new Uint8Array(0)); await this.wait(T.TX_COMMIT_ACK, 20_000); } catch { /* connection gone: the server aborts the transaction itself */ } }
    }
    throw new Error("mediator: transaction was rejected repeatedly");
  }

  async devices(): Promise<Map<bigint, Msg>> {
    this.send(T.GET_DEVICES, new Uint8Array(0));
    const m = decode(DevicesInfo, await this.wait(T.DEVICES, 20_000));
    return (m.augmentedDeviceInfo as Map<bigint, Msg>) ?? new Map();
  }
  async dropDevice(id: bigint, selfDrop = false) {
    this.send(T.DROP, encode(DropDevice, { deviceId: id }));
    if (selfDrop) { await Promise.race([this.wait(T.DROP_ACK, 20_000), new Promise<void>((ok) => this.once("close", () => ok()))]).catch(() => {}); return; }
    await this.wait(T.DROP_ACK, 20_000);
  }
  /** Leave this device group (drop our own slot) inside a DROP_DEVICE transaction; resolves true when the server confirmed (ack or 4113). */
  async dropSelf(): Promise<boolean> {
    try {
      await this.transaction(Enum.scope.DROP_DEVICE, async () => { await this.dropDevice(this.o.deviceId, true); });
      return true;
    } catch (e) { return e instanceof MediatorClose && e.code === 4113; }
  }
  decryptDeviceInfo(enc: Uint8Array): Msg | undefined { const p = enc.length > 40 ? secretboxOpen(enc.subarray(24), enc.subarray(0, 24), this.o.keys.dgdik) : undefined; return p ? decode(DeviceInfo, p) : undefined; }
  ping() { try { this.ws?.ping(); } catch { /* ignore */ } }
  close(code = 1000) { try { this.ws?.close(code); } catch { /* ignore */ } }
  get isClosed() { return this.closed !== undefined; }
  get closedWith() { return this.closed; }
}
void beforenm; void TransactionInfo;
