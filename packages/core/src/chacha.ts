// ChaCha20-Poly1305, the IETF construction of RFC 8439, sealed as ciphertext || 16-byte tag.
//
// Electron's crypto is BoringSSL, and its createCipheriv has no "chacha20-poly1305" (ERR_CRYPTO_UNKNOWN_CIPHER). The
// desktop app therefore could not complete a single pairing or sync handshake: the exception surfaced as "wrong code",
// while the phone (nodejs-mobile, OpenSSL), plain Node and every test were fine. Where node:crypto has the cipher it is
// used exactly as before; where it does not, libsodium's crypto_aead_chacha20poly1305_ietf does the same construction --
// sodium-native ships with the desktop app already, for HyperDHT. The bytes are identical either way (chacha.test.ts
// checks both against the RFC's own test vector, and against each other).
import { createCipheriv, createDecipheriv, getCiphers } from "node:crypto";
import { createRequire } from "node:module";

/** This runtime has no ChaCha20-Poly1305 at all: a problem with THIS device, never the other one's code or key. */
export class AeadUnavailable extends Error {}
/** The tag did not verify: wrong key, or tampered data. */
export class AeadAuthError extends Error {}

type Sodium = {
  crypto_aead_chacha20poly1305_ietf_encrypt(c: Uint8Array, m: Uint8Array, ad: Uint8Array | null, nsec: null, npub: Uint8Array, k: Uint8Array): number;
  crypto_aead_chacha20poly1305_ietf_decrypt(m: Uint8Array, nsec: null, c: Uint8Array, ad: Uint8Array | null, npub: Uint8Array, k: Uint8Array): number;
};
const nodeHasIt = (() => { try { return getCiphers().includes("chacha20-poly1305"); } catch { return false; } })();
let sodium: Sodium | undefined;
function loadSodium(): Sodium {
  if (!sodium) {
    try { sodium = createRequire(typeof __filename === "string" ? __filename : import.meta.url)("sodium-native") as Sodium; }
    catch (e) { throw new AeadUnavailable(`this device's crypto has no ChaCha20-Poly1305 and sodium-native could not be loaded (${(e as Error).message})`); }
  }
  return sodium;
}
/** Which implementation runs. Exported so tests can run the libsodium path on a Node that has the cipher built in. */
export const chachaImpl = { useSodium: !nodeHasIt };

const buf = (u: Uint8Array) => (Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength));

export function chachaSeal(key: Uint8Array, nonce: Uint8Array, pt: Uint8Array, ad?: Uint8Array): Buffer {
  if (!chachaImpl.useSodium) {
    const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    if (ad) c.setAAD(ad, { plaintextLength: pt.length });
    return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  }
  const s = loadSodium(), out = Buffer.alloc(pt.length + 16);
  s.crypto_aead_chacha20poly1305_ietf_encrypt(out, buf(pt), ad ? buf(ad) : null, null, buf(nonce), buf(key));
  return out;
}

/** Throws AeadAuthError when the tag does not verify, AeadUnavailable when this device cannot run the cipher. */
export function chachaOpen(key: Uint8Array, nonce: Uint8Array, box: Uint8Array, ad?: Uint8Array): Buffer {
  if (box.length < 16) throw new AeadAuthError("ciphertext shorter than its tag");
  if (!chachaImpl.useSodium) {
    const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    if (ad) d.setAAD(ad, { plaintextLength: box.length - 16 });
    d.setAuthTag(box.subarray(box.length - 16));
    try { return Buffer.concat([d.update(box.subarray(0, box.length - 16)), d.final()]); }
    catch (e) { throw new AeadAuthError((e as Error).message); }
  }
  const s = loadSodium(), out = Buffer.alloc(box.length - 16);
  try { s.crypto_aead_chacha20poly1305_ietf_decrypt(out, null, buf(box), ad ? buf(ad) : null, buf(nonce), buf(key)); }
  catch (e) { throw new AeadAuthError((e as Error).message); }
  return out;
}
