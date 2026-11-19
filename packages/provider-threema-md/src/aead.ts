// ChaCha20-Poly1305 (RFC 8439), ciphertext || 16-byte tag. The shared helper also works in Electron, whose crypto has
// no chacha20-poly1305 in createCipheriv (see core/chacha.ts) -- through node:crypto alone this never worked on desktop.
import { AeadAuthError, chachaOpen as open, chachaSeal } from "@unimsg/core/chacha"; // its own entry point: the whole of core is more than this provider's tests can load
export { chachaSeal };
export function chachaOpen(key: Uint8Array, nonce: Uint8Array, box: Uint8Array, aad?: Uint8Array): Uint8Array | undefined {
  try { return open(key, nonce, box, aad); } catch (e) { if (e instanceof AeadAuthError) return undefined; throw e; }
}
