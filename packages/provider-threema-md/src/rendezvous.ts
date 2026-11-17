// Connection Rendezvous Protocol (relayed WebSocket path only). Both roles are implemented: UniChat is RID (it shows the QR), the fake phone in the
// tests is RRD. Written from md-d2d-rendezvous.proto (Threema-protocol-notes (https://github.com/PixelcrafterEXE/unichat/wiki/Threema-protocol-notes) section 3).
import { randomBytes, timingSafeEqual } from "node:crypto";
import WebSocket from "ws";
import { chachaOpen, chachaSeal } from "./aead.js";
import { cat, deriveAuthKeys, deriveTransportKeys } from "./keys.js";
import { generateKeyPair } from "./nacl.js";
import { decode, encode } from "./proto.js";
import { HsAuth, HsAuthHello, HsHello, Nominate } from "./schemas.js";

export interface Transport {
  send(b: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (b: Uint8Array) => void): void;
  onClose(cb: (code: number) => void): void;
}
export function wsTransport(url: string): Promise<Transport> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url, { handshakeTimeout: 15000, maxPayload: 120 * 1024 * 1024 });
    const msg: ((b: Uint8Array) => void)[] = [], cls: ((c: number) => void)[] = [];
    const early: Uint8Array[] = [];
    ws.on("message", (d: Buffer) => { const u = new Uint8Array(d); if (msg.length) msg.forEach((f) => f(u)); else early.push(u); });
    ws.on("close", (c: number) => cls.forEach((f) => f(c)));
    ws.on("error", () => { /* surfaced through close / the open timeout */ });
    ws.once("open", () => ok({
      send: (b) => ws.send(b), close: (c, r) => { try { ws.close(c ?? 1000, r); } catch { /* ignore */ } },
      onMessage: (cb) => { msg.push(cb); while (early.length) cb(early.shift()!); }, onClose: (cb) => { cls.push(cb); },
    }));
    ws.once("error", () => fail(new Error("rendezvous server unreachable")));
  });
}

const nonce12 = (pid: number, sn: number) => { const n = new Uint8Array(12); const dv = new DataView(n.buffer); dv.setUint32(0, pid, true); dv.setUint32(4, sn, true); return n; };
class Dir { key: Uint8Array; pid: number; sn: number; constructor(key: Uint8Array, pid: number, sn = 1) { this.key = key; this.pid = pid; this.sn = sn; }
  seal(p: Uint8Array) { const c = chachaSeal(this.key, nonce12(this.pid, this.sn), p); this.sn++; return c; }
  open(c: Uint8Array) { const p = chachaOpen(this.key, nonce12(this.pid, this.sn), c); if (!p) throw new Error("rendezvous: decryption failed"); this.sn++; return p; } }
const frame = (b: Uint8Array) => { const o = new Uint8Array(4 + b.length); new DataView(o.buffer).setUint32(0, b.length, true); o.set(b, 4); return o; };

export class RendezvousChannel {
  private buf = new Uint8Array(0);
  private waiters: ((f: Uint8Array | Error) => void)[] = [];
  private frames: Uint8Array[] = [];
  private closedErr?: Error;
  private tx!: Dir; private rx!: Dir;
  rph?: Uint8Array;
  private role: "rid" | "rrd"; private ak: Uint8Array; private pid: number; private t: Transport; private maxFrame: number;
  constructor(role: "rid" | "rrd", ak: Uint8Array, pid: number, t: Transport, maxFrame = 16384) {
    this.role = role; this.ak = ak; this.pid = pid; this.t = t; this.maxFrame = maxFrame;
    t.onMessage((b) => this.feed(b));
    t.onClose((c) => this.fail(new Error(`rendezvous closed (${c})`)));
  }
  private fail(e: Error) { this.closedErr ??= e; for (const w of this.waiters.splice(0)) w(e); }
  private feed(b: Uint8Array) {
    this.buf = cat(this.buf, b);
    for (;;) {
      if (this.buf.length < 4) return;
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0, true);
      if (len > this.maxFrame) { this.fail(new Error("rendezvous: frame too large")); this.t.close(4000); return; }
      if (this.buf.length < 4 + len) return;
      const f = this.buf.slice(4, 4 + len); this.buf = this.buf.slice(4 + len);
      const w = this.waiters.shift(); if (w) w(f); else this.frames.push(f);
    }
  }
  private next(timeoutMs: number): Promise<Uint8Array> {
    if (this.frames.length) return Promise.resolve(this.frames.shift()!);
    if (this.closedErr) return Promise.reject(this.closedErr);
    return new Promise((ok, fail) => {
      const tm = setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); fail(new Error("rendezvous: timeout")); }, timeoutMs);
      const w = (f: Uint8Array | Error) => { clearTimeout(tm); f instanceof Error ? fail(f) : ok(f); };
      this.waiters.push(w);
    });
  }
  private put(p: Uint8Array) { this.t.send(frame(this.tx.seal(p))); }
  private get(timeoutMs: number) { return this.next(timeoutMs).then((f) => this.rx.open(f)); }

  /** Run the handshake. RID waits for the peer's Hello; RRD starts it. `nominator` = the side that sends Nominate (join: the existing device = RRD). */
  async handshake(timeoutMs: number): Promise<{ rph: Uint8Array }> {
    const ak = deriveAuthKeys(this.ak), etk = generateKeyPair();
    const mine = this.role === "rid" ? ak.ridak : ak.rrdak, theirs = this.role === "rid" ? ak.rrdak : ak.ridak;
    this.tx = new Dir(mine, this.pid); this.rx = new Dir(theirs, this.pid);
    let remoteEtk: Uint8Array;
    if (this.role === "rid") {
      const hello = decode(HsHello, await this.get(timeoutMs));
      if (hello.challenge?.length !== 16 || hello.etk?.length !== 32) throw new Error("rendezvous: bad hello");
      const challenge = new Uint8Array(randomBytes(16)); remoteEtk = hello.etk;
      this.put(encode(HsAuthHello, { response: hello.challenge, challenge, etk: etk.publicKey }));
      const auth = decode(HsAuth, await this.get(timeoutMs));
      if (!auth.response || auth.response.length !== 16 || !timingSafeEqual(auth.response, challenge)) { this.t.close(4000); throw new Error("rendezvous: authentication failed"); }
    } else {
      const challenge = new Uint8Array(randomBytes(16));
      this.put(encode(HsHello, { challenge, etk: etk.publicKey }));
      const ah = decode(HsAuthHello, await this.get(timeoutMs));
      if (!ah.response || !timingSafeEqual(ah.response, challenge) || ah.challenge?.length !== 16 || ah.etk?.length !== 32) { this.t.close(4000); throw new Error("rendezvous: authentication failed"); }
      remoteEtk = ah.etk; this.put(encode(HsAuth, { response: ah.challenge }));
    }
    const tk = deriveTransportKeys(this.ak, etk.secretKey, remoteEtk);
    this.rph = tk.rph;
    // the sequence counters continue into the transport-key phase (PROTOCOL-NOTES 3)
    this.tx = Object.assign(new Dir(this.role === "rid" ? tk.ridtk : tk.rrdtk, this.pid), { sn: this.tx.sn });
    this.rx = Object.assign(new Dir(this.role === "rid" ? tk.rrdtk : tk.ridtk, this.pid), { sn: this.rx.sn });
    return { rph: tk.rph };
  }
  /** RRD (nominator in the join protocol) nominates; RID waits for it. After this the frame limit is raised. */
  async nominate() { this.put(encode(Nominate, {})); this.maxFrame = 100 * 1048576; }
  async awaitNominate(timeoutMs: number) { await this.get(timeoutMs); this.maxFrame = 100 * 1048576; }
  send(data: Uint8Array) { this.put(data); }
  recv(timeoutMs: number) { return this.get(timeoutMs); }
  close(code = 1000) { this.t.close(code); }
}
