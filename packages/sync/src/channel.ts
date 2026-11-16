// Framed, mutually authenticated, encrypted TCP channel.
//   wire:  u32 BE length | body        (max MAX_FRAME; handshake frames are tiny and capped lower BEFORE authentication)
//   1st frame (plaintext "prologue", JSON <= 1 KiB, bound into the Noise transcript): {v, mode: "pair"|"sync", tags?: string[]}
//   then the three Noise_XXpsk0 messages, then transport frames = ChaCha20-Poly1305(counter nonce) of one JSON message each.
// Backpressure: send() resolves when the kernel buffer accepted the frame (awaits 'drain'); the receiver stops reading from the socket
// while its inbox is full, so a slow peer slows the sender down instead of growing memory.
import type { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { Handshake, type KeyPair } from "./noise.js";

export const MAX_FRAME = 512 * 1024, MAX_HANDSHAKE_FRAME = 1024, PROTOCOL_VERSION = 1;
export class ChannelError extends Error { constructor(public code: "closed" | "timeout" | "protocol" | "auth", msg: string, public soft = false) { super(msg); } }

export class Framed {
  private buf = Buffer.alloc(0); private inbox: Buffer[] = []; private waiters: { ok: (b: Buffer) => void; fail: (e: Error) => void }[] = [];
  private err?: Error; maxFrame = MAX_HANDSHAKE_FRAME; private parsed = 0;
  /** the first `preAuth` frames are handshake frames: capped at 1 KiB by their length header, before anything is buffered (later frames are authenticated transport frames and may arrive in the same TCP segment) */
  constructor(readonly socket: Socket, private preAuth = 3) {
    socket.setMaxListeners?.(30); // data/close/error/drain + a few of ours; the default of 10 is too tight for stream classes that add their own
    socket.on("data", (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      while (this.buf.length >= 4) {
        const n = this.buf.readUInt32BE(0);
        if (n > (this.parsed < this.preAuth ? this.maxFrame : MAX_FRAME) || n === 0) return this.fail(new ChannelError("protocol", "bad frame size"));
        if (this.buf.length < 4 + n) break;
        this.parsed++; this.push(Buffer.from(this.buf.subarray(4, 4 + n))); this.buf = this.buf.subarray(4 + n);
      }
      if (this.inbox.length >= 32) socket.pause();
    });
    socket.on("close", () => this.fail(new ChannelError("closed", "connection closed")));
    socket.on("error", (e) => this.fail(new ChannelError("closed", e.message)));
  }
  private push(b: Buffer) { const w = this.waiters.shift(); if (w) w.ok(b); else this.inbox.push(b); }
  private fail(e: Error) { this.err ??= e; for (const w of this.waiters.splice(0)) w.fail(this.err); }
  get failed() { return this.err; }
  /** read one frame during the handshake (small, enforced before authentication) */
  async hello(timeoutMs = 0): Promise<Buffer> { const b = await this.next(timeoutMs); if (b.length > MAX_HANDSHAKE_FRAME) { this.close(); throw new ChannelError("protocol", "handshake frame too large"); } return b; }
  next(timeoutMs = 0): Promise<Buffer> {
    if (this.inbox.length) { const b = this.inbox.shift()!; if (this.inbox.length < 8) this.socket.resume(); return Promise.resolve(b); }
    if (this.err) return Promise.reject(this.err);
    return new Promise((ok, fail) => {
      const w = { ok: (b: Buffer) => { clearTimeout(t); ok(b); }, fail: (e: Error) => { clearTimeout(t); fail(e); } };
      const t = timeoutMs ? setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); fail(new ChannelError("timeout", "timed out")); }, timeoutMs) : undefined;
      this.waiters.push(w); this.socket.resume();
    });
  }
  write(body: Buffer): Promise<void> {
    if (this.err || this.socket.destroyed) return Promise.reject(this.err ?? new ChannelError("closed", "connection closed"));
    const h = Buffer.alloc(4); h.writeUInt32BE(body.length);
    if (this.socket.write(Buffer.concat([h, body]))) return Promise.resolve();
    // ONE drain and ONE close listener per socket however many writes wait (a listener per waiting write leaked: "MaxListenersExceededWarning: 11 close/drain listeners" on NoiseSecretStream)
    return new Promise((ok, fail) => {
      this.drainWaiters.push({ ok, fail });
      if (!this.drainHooked) {
        this.drainHooked = true;
        this.socket.on("drain", () => { for (const w of this.drainWaiters.splice(0)) w.ok(); });
        this.socket.once("close", () => { for (const w of this.drainWaiters.splice(0)) w.fail(new ChannelError("closed", "connection closed")); });
      }
    });
  }
  private drainWaiters: { ok: () => void; fail: (e: Error) => void }[] = []; private drainHooked = false;
  /** A DHT / relay stream drops what it has not sent yet when destroyed (the peer sees a reset instead of our last frame): finish writing first, destroy shortly after. TCP keeps the immediate destroy. */
  close() { const s = this.socket as any; if (s.unichatVia && !s.destroyed) { try { s.end?.(); } catch { /* gone */ } const t = setTimeout(() => s.destroy(), 1500); t.unref?.(); s.once?.("close", () => clearTimeout(t)); } else this.socket.destroy(); }
}

export interface Secure { send(msg: object): Promise<void>; recv(timeoutMs?: number): Promise<any>; close(): void; remoteStatic: Buffer; hello: any; socket: Socket; transcript: Buffer }

export interface HandshakeCommon { s: KeyPair; hello: object; timeoutMs?: number }
export interface DialOpts extends HandshakeCommon {
  mode: "pair" | "sync" | "nearby"; psk: Buffer; tags?: string[];
  /** Decide, once the responder's static key is known and BEFORE we reveal ours, whether to continue. */
  checkRemote(pub: Buffer, hello: any): void;
}
export interface AcceptOpts extends HandshakeCommon {
  /** Pick the psk for the announced mode / key tags, or refuse (return undefined). */
  pskFor(mode: string, tags: string[]): { psk: Buffer; tag?: string } | undefined;
  /** Every refusal (nothing open, wrong code, garbage, unknown mode) takes at least this long (+ up to 25% random) and goes through the same steps, so a stranger cannot tell them apart or probe cheaply (default 300 ms; 0 in tests that do not care). */
  failFloorMs?: number;
  checkRemote(pub: Buffer, hello: any, mode: string): void;
}
const enc = (o: unknown) => Buffer.from(JSON.stringify(o));
function wrap(f: Framed, hs: Handshake, hello: any, remoteStatic: Buffer): Secure {
  const { send, recv } = hs.split(); f.maxFrame = MAX_FRAME;
  return {
    socket: f.socket, remoteStatic, hello, transcript: hs.transcript,
    send: (msg) => { const pt = enc(msg); if (pt.length > MAX_FRAME - 64) return Promise.reject(new ChannelError("protocol", "message too large")); return f.write(send.encrypt(Buffer.alloc(0), pt)); },
    async recv(t = 0) {
      const ct = await f.next(t);
      try { return JSON.parse(recv.decrypt(Buffer.alloc(0), ct).toString("utf8")); }
      catch { f.close(); throw new ChannelError("auth", "frame failed authentication (tampered, replayed or reordered)"); }
    },
    close: () => f.close(),
  };
}
const guard = async <T>(f: Framed, p: Promise<T>): Promise<T> => { try { return await p; } catch (e) { f.close(); throw e; } };

export function dial(socket: Socket, o: DialOpts): Promise<Secure> {
  const f = new Framed(socket, 1), tm = o.timeoutMs ?? 10_000;
  return guard(f, (async () => {
    const pro = enc({ v: PROTOCOL_VERSION, mode: o.mode, tags: o.tags });
    await f.write(pro);
    const hs = new Handshake({ initiator: true, s: o.s, psk: o.psk, prologue: pro });
    await f.write(hs.write(Buffer.alloc(0)));
    let hello: any;
    try { hello = JSON.parse(hs.read(await f.hello(tm)).toString("utf8")); } catch { throw new ChannelError("auth", "the other device did not accept the code / group key"); }
    o.checkRemote(hs.remoteStatic!, hello);
    await f.write(hs.write(enc(o.hello)));
    return wrap(f, hs, hello, hs.remoteStatic!);
  })());
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export function accept(socket: Socket, o: AcceptOpts): Promise<Secure & { mode: string; tag?: string }> {
  const f = new Framed(socket), tm = o.timeoutMs ?? 10_000, t0 = Date.now(), floor = o.failFloorMs ?? 300;
  // What a stranger can learn from us is only "something that speaks this protocol listens here". Every way of saying no looks the same from outside:
  // an unknown mode, a bad prologue, "no pairing is open" and "wrong code" all read the first handshake message (against a random decoy key when
  // there is no real one) and then close after the same minimum delay. Fail-closed: any exception ends in a closed socket, never in a half-open session.
  return guard(f, (async () => {
    let verdict: ChannelError | undefined; // decided now, thrown only after the same steps a real handshake takes
    try {
      const pro = await f.hello(tm);
      let h: { v?: number; mode?: string; tags?: unknown } = {};
      try { h = JSON.parse(pro.toString("utf8")) ?? {}; } catch { verdict = new ChannelError("protocol", "bad prologue"); }
      if (!verdict && (h.v !== PROTOCOL_VERSION || typeof h.mode !== "string")) verdict = new ChannelError("protocol", "unsupported protocol version");
      const tags = Array.isArray(h.tags) ? h.tags.filter((t): t is string => typeof t === "string").slice(0, 8) : [];
      let sel = verdict ? undefined : o.pskFor(h.mode!, tags);
      if (!sel) { verdict ??= new ChannelError("auth", "no matching key", true); sel = { psk: randomBytes(32) }; }
      const hs = new Handshake({ initiator: false, s: o.s, psk: sel.psk, prologue: pro });
      try { hs.read(await f.hello(tm)); } catch (e) { if (e instanceof ChannelError && e.code === "closed") throw e; if (verdict) throw verdict; if (e instanceof ChannelError) throw e; throw new ChannelError("auth", "wrong code or group key"); }
      if (verdict) throw verdict; // (a random decoy key matching is not a thing that happens)
      await f.write(hs.write(enc(o.hello)));
      let hello: any;
      try { hello = JSON.parse(hs.read(await f.hello(tm)).toString("utf8")); } catch (e) { if (e instanceof ChannelError) throw e; throw new ChannelError("auth", "handshake failed"); }
      o.checkRemote(hs.remoteStatic!, hello, h.mode!);
      return Object.assign(wrap(f, hs, hello, hs.remoteStatic!), { mode: h.mode!, tag: sel.tag });
    } catch (e) {
      // a peer that already hung up needs no padding; everybody else waits out the floor so refusals cannot be told apart by timing
      const closed = e instanceof ChannelError && e.code === "closed";
      if (!closed && floor > 0) await sleep(Math.max(0, floor - (Date.now() - t0)) + Math.random() * floor * 0.25);
      throw e instanceof ChannelError ? e : new ChannelError("protocol", "handshake failed");
    }
  })());
}
