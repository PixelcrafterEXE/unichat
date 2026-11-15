// COPY of packages/provider-threema/src/nacl.ts (that package does not export it); `beforenm` is exported here = X25519HSalsa20 as used by Threema's KDFs.
// NaCl crypto_box / crypto_secretbox (X25519 + XSalsa20 + Poly1305) on Node's crypto (X25519) plus a small Salsa20/HSalsa20/Poly1305.
// Verified against libsodium vectors in nacl.test.ts. Not constant-time in Poly1305 (BigInt): acceptable for a local desktop client, see README.
import { createPrivateKey, createPublicKey, diffieHellman, randomBytes, timingSafeEqual } from "node:crypto";

const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const SIGMA = new TextEncoder().encode("expand 32-byte k");

function core(inp: Uint8Array, key: Uint8Array, hsalsa: boolean): Uint32Array {
  const j = new Uint32Array(16);
  j[0] = le32(SIGMA, 0); j[5] = le32(SIGMA, 4); j[10] = le32(SIGMA, 8); j[15] = le32(SIGMA, 12);
  for (let i = 0; i < 4; i++) { j[1 + i] = le32(key, 4 * i); j[11 + i] = le32(key, 16 + 4 * i); j[6 + i] = le32(inp, 4 * i); }
  const x = Uint32Array.from(j);
  const qr = (a: number, b: number, c: number, d: number) => {
    x[b] ^= rotl((x[a] + x[d]) >>> 0, 7); x[c] ^= rotl((x[b] + x[a]) >>> 0, 9);
    x[d] ^= rotl((x[c] + x[b]) >>> 0, 13); x[a] ^= rotl((x[d] + x[c]) >>> 0, 18);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(5, 9, 13, 1); qr(10, 14, 2, 6); qr(15, 3, 7, 11);
    qr(0, 1, 2, 3); qr(5, 6, 7, 4); qr(10, 11, 8, 9); qr(15, 12, 13, 14);
  }
  if (hsalsa) return Uint32Array.from([x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]]);
  for (let i = 0; i < 16; i++) x[i] = (x[i] + j[i]) >>> 0;
  return x;
}
const words = (w: Uint32Array) => { const o = new Uint8Array(w.length * 4); new DataView(o.buffer).setUint32(0, 0, true); w.forEach((v, i) => new DataView(o.buffer).setUint32(i * 4, v, true)); return o; };

function hsalsa20(key: Uint8Array, n16: Uint8Array) { return words(core(n16, key, true)); }
/** XSalsa20 keystream of `len` bytes. */
function xsalsaStream(len: number, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  const sub = hsalsa20(key, nonce.subarray(0, 16));
  const out = new Uint8Array(len);
  const inp = new Uint8Array(16); inp.set(nonce.subarray(16, 24), 0);
  const dv = new DataView(inp.buffer);
  for (let blk = 0, o = 0; o < len; blk++, o += 64) {
    dv.setUint32(8, blk >>> 0, true); dv.setUint32(12, Math.floor(blk / 2 ** 32), true);
    out.set(words(core(inp, sub, false)).subarray(0, Math.min(64, len - o)), o);
  }
  return out;
}

const P = (1n << 130n) - 5n;
const leBig = (b: Uint8Array) => { let r = 0n; for (let i = b.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(b[i]); return r; };
function poly1305(msg: Uint8Array, key: Uint8Array): Uint8Array {
  const rb = Uint8Array.from(key.subarray(0, 16));
  for (const i of [3, 7, 11, 15]) rb[i] &= 15;
  for (const i of [4, 8, 12]) rb[i] &= 252;
  const r = leBig(rb), s = leBig(key.subarray(16, 32));
  let h = 0n;
  for (let o = 0; o < msg.length; o += 16) {
    const blk = msg.subarray(o, Math.min(o + 16, msg.length));
    h = ((h + leBig(blk) + (1n << BigInt(8 * blk.length))) * r) % P;
  }
  let t = (h + s) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) { out[i] = Number(t & 255n); t >>= 8n; }
  return out;
}

export function secretbox(msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  if (nonce.length !== 24 || key.length !== 32) throw new Error("bad nonce/key length");
  const ks = xsalsaStream(32 + msg.length, nonce, key);
  const out = new Uint8Array(16 + msg.length);
  for (let i = 0; i < msg.length; i++) out[16 + i] = msg[i] ^ ks[32 + i];
  out.set(poly1305(out.subarray(16), ks.subarray(0, 32)), 0);
  return out;
}
export function secretboxOpen(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | undefined {
  if (nonce.length !== 24 || key.length !== 32 || box.length < 16) return undefined;
  const ks = xsalsaStream(32 + box.length - 16, nonce, key);
  const tag = poly1305(box.subarray(16), ks.subarray(0, 32));
  if (!timingSafeEqual(tag, box.subarray(0, 16))) return undefined;
  const out = new Uint8Array(box.length - 16);
  for (let i = 0; i < out.length; i++) out[i] = box[16 + i] ^ ks[32 + i];
  return out;
}

const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex"), SPKI = Buffer.from("302a300506032b656e032100", "hex");
export function publicKeyOf(sk: Uint8Array): Uint8Array {
  const pub = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8, sk]), format: "der", type: "pkcs8" }));
  return new Uint8Array(pub.export({ format: "der", type: "spki" }).subarray(12));
}
export function generateKeyPair() { const sk = randomBytes(32); return { secretKey: new Uint8Array(sk), publicKey: publicKeyOf(sk) }; }
/** crypto_box_beforenm: HSalsa20(X25519(sk, pk), 0). */
export function beforenm(pk: Uint8Array, sk: Uint8Array): Uint8Array {
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: Buffer.concat([PKCS8, sk]), format: "der", type: "pkcs8" }),
    publicKey: createPublicKey({ key: Buffer.concat([SPKI, pk]), format: "der", type: "spki" }),
  });
  return hsalsa20(shared, new Uint8Array(16));
}
export const box = (msg: Uint8Array, nonce: Uint8Array, theirPk: Uint8Array, mySk: Uint8Array) => secretbox(msg, nonce, beforenm(theirPk, mySk));
export const boxOpen = (b: Uint8Array, nonce: Uint8Array, theirPk: Uint8Array, mySk: Uint8Array) => secretboxOpen(b, nonce, beforenm(theirPk, mySk));
export const randomNonce = () => new Uint8Array(randomBytes(24));
