// ChaCha20-Poly1305 (RFC 8439) via node:crypto, ciphertext || 16-byte tag.
import { createCipheriv, createDecipheriv } from "node:crypto";
export function chachaSeal(key: Uint8Array, nonce: Uint8Array, pt: Uint8Array, aad?: Uint8Array): Uint8Array {
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 } as any) as any;
  if (aad) c.setAAD(aad);
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}
export function chachaOpen(key: Uint8Array, nonce: Uint8Array, box: Uint8Array, aad?: Uint8Array): Uint8Array | undefined {
  if (box.length < 16) return undefined;
  try {
    const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 } as any) as any;
    if (aad) d.setAAD(aad);
    d.setAuthTag(box.subarray(box.length - 16));
    return Buffer.concat([d.update(box.subarray(0, box.length - 16)), d.final()]);
  } catch { return undefined; }
}
