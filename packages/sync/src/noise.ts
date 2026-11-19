// Noise_XXpsk0_25519_ChaChaPoly_SHA256, implemented from the Noise Protocol Framework spec (rev 34) with node:crypto primitives only
// (X25519, ChaCha20-Poly1305, SHA-256, HMAC). No home-grown primitive: this file is the standard state machine around them.
//   -> psk, e                    (the psk is mixed in FIRST, so msg1's payload is already encrypted under it and a wrong psk is detected at once)
//   <- e, ee, s, es
//   -> s, se
// `prologue` (plaintext header both sides saw) is hashed into the transcript. After the handshake `split()` yields two CipherStates whose
// nonces are strict 64-bit counters: a replayed, reordered, duplicated or modified frame fails authentication.
import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, timingSafeEqual } from "node:crypto";
import { chachaOpen, chachaSeal } from "@unimsg/core";

const NAME = "Noise_XXpsk0_25519_ChaChaPoly_SHA256";
const SPKI = Buffer.from("302a300506032b656e032100", "hex"), PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
export interface KeyPair { pub: Buffer; priv: Buffer }
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { pub: Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32), priv: Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).subarray(-32) };
}
function dh(priv: Buffer, pub: Buffer): Buffer {
  const out = diffieHellman({ privateKey: createPrivateKey({ key: Buffer.concat([PKCS8, priv]), format: "der", type: "pkcs8" }), publicKey: createPublicKey({ key: Buffer.concat([SPKI, pub]), format: "der", type: "spki" }) });
  if (out.every((b) => b === 0)) throw new Error("noise: invalid public key"); // low-order point
  return Buffer.from(out);
}
const sha = (...b: Buffer[]) => { const h = createHash("sha256"); for (const x of b) h.update(x); return h.digest(); };
const hmac = (k: Buffer, ...d: Buffer[]) => { const h = createHmac("sha256", k); for (const x of d) h.update(x); return h.digest(); };
function hkdf(ck: Buffer, ikm: Buffer, n: 2 | 3): Buffer[] {
  const t = hmac(ck, ikm), o1 = hmac(t, Buffer.from([1])), o2 = hmac(t, o1, Buffer.from([2]));
  return n === 2 ? [o1, o2] : [o1, o2, hmac(t, o2, Buffer.from([3]))];
}
const nonce = (n: bigint) => { const b = Buffer.alloc(12); b.writeBigUInt64LE(n, 4); return b; };

export class CipherState {
  n = 0n;
  constructor(public k?: Buffer) {}
  encrypt(ad: Buffer, pt: Buffer): Buffer {
    if (!this.k) return pt;
    if (this.n >= 2n ** 63n) throw new Error("noise: nonce exhausted");
    return chachaSeal(this.k, nonce(this.n++), pt, ad); // not createCipheriv: Electron's crypto has no chacha20-poly1305 (see core/chacha.ts)
  }
  decrypt(ad: Buffer, ct: Buffer): Buffer {
    if (!this.k) return ct;
    if (ct.length < 16) throw new Error("noise: short ciphertext");
    const pt = chachaOpen(this.k, nonce(this.n), ct, ad); this.n++; return pt; // the counter only advances on success
  }
}

export interface HandshakeOpts { initiator: boolean; s: KeyPair; psk: Buffer; prologue: Buffer }
export class Handshake {
  private ck: Buffer; private h: Buffer; private cs = new CipherState();
  private e?: KeyPair; re?: Buffer; rs?: Buffer; private step = 0;
  constructor(private o: HandshakeOpts) {
    this.h = Buffer.from(NAME).length <= 32 ? Buffer.concat([Buffer.from(NAME), Buffer.alloc(32 - NAME.length)]) : sha(Buffer.from(NAME));
    this.ck = this.h; this.mixHash(o.prologue);
  }
  private mixHash(d: Buffer) { this.h = sha(this.h, d); }
  private mixKey(ikm: Buffer) { const [ck, k] = hkdf(this.ck, ikm, 2); this.ck = ck; this.cs = new CipherState(k); }
  private mixKeyAndHash(ikm: Buffer) { const [ck, th, k] = hkdf(this.ck, ikm, 3); this.ck = ck; this.mixHash(th); this.cs = new CipherState(k); }
  private encHash(pt: Buffer) { const c = this.cs.encrypt(this.h, pt); this.mixHash(c); return c; }
  private decHash(ct: Buffer) { const p = this.cs.decrypt(this.h, ct); this.mixHash(ct); return p; }
  /** The remote party's static public key, once known (after msg2 for the initiator, after msg3 for the responder). */
  get remoteStatic() { return this.rs; }
  /** Channel-binding value, identical on both sides once complete. */
  get transcript() { return this.h; }
  get complete() { return this.step === 3; }

  write(payload: Buffer): Buffer {
    const out: Buffer[] = [];
    const myTurn = this.o.initiator ? this.step === 0 || this.step === 2 : this.step === 1;
    if (!myTurn) throw new Error("noise: not our turn");
    if (this.step === 0) { // -> psk, e
      this.mixKeyAndHash(this.o.psk);
      this.e = generateKeyPair(); out.push(this.e.pub); this.mixHash(this.e.pub); this.mixKey(this.e.pub);
    } else if (this.step === 1) { // <- e, ee, s, es
      this.e = generateKeyPair(); out.push(this.e.pub); this.mixHash(this.e.pub); this.mixKey(this.e.pub);
      this.mixKey(dh(this.e.priv, this.re!));
      out.push(this.encHash(this.o.s.pub));
      this.mixKey(dh(this.o.s.priv, this.re!));
    } else { // -> s, se
      out.push(this.encHash(this.o.s.pub));
      this.mixKey(dh(this.o.s.priv, this.re!));
    }
    out.push(this.encHash(payload)); this.step++;
    return Buffer.concat(out);
  }
  read(msg: Buffer): Buffer {
    const myTurn = this.o.initiator ? this.step === 1 : this.step === 0 || this.step === 2;
    if (!myTurn) throw new Error("noise: not our turn");
    let off = 0;
    const take = (n: number) => { if (off + n > msg.length) throw new Error("noise: truncated handshake message"); const b = msg.subarray(off, off + n); off += n; return Buffer.from(b); };
    if (this.step === 0) { // responder reads: psk, e
      this.mixKeyAndHash(this.o.psk);
      this.re = take(32); this.mixHash(this.re); this.mixKey(this.re);
    } else if (this.step === 1) { // initiator reads: e, ee, s, es
      this.re = take(32); this.mixHash(this.re); this.mixKey(this.re);
      this.mixKey(dh(this.e!.priv, this.re));
      this.rs = this.decHash(take(48));
      this.mixKey(dh(this.e!.priv, this.rs));
    } else { // responder reads: s, se
      this.rs = this.decHash(take(48));
      this.mixKey(dh(this.e!.priv, this.rs));
    }
    const p = this.decHash(msg.subarray(off)); this.step++;
    return p;
  }
  split(): { send: CipherState; recv: CipherState } {
    if (!this.complete) throw new Error("noise: handshake not finished");
    const [a, b] = hkdf(this.ck, Buffer.alloc(0), 2);
    const c1 = new CipherState(a), c2 = new CipherState(b);
    return this.o.initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }
}
export const sameKey = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);
export const deviceIdOf = (pub: Uint8Array) => createHash("sha256").update(pub).digest("hex").slice(0, 32);
