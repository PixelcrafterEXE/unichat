// Plaintext padding used inside Signal's Double Ratchet payloads: content | 0x80 | 0x00...
// padded so total length is a multiple of 160 bytes (matches Signal-Desktop `padMessage`).
const BLOCK = 160;

export function padContent(plain: Uint8Array): Uint8Array<ArrayBuffer> {
  const padded = Math.ceil((plain.length + 1) / BLOCK) * BLOCK;
  const out = new Uint8Array(padded);
  out.set(plain);
  out[plain.length] = 0x80;
  return out;
}

/** Strip padding; throws if the terminator is malformed. */
export function unpadContent(padded: Uint8Array): Uint8Array {
  for (let i = padded.length - 1; i >= 0; i--) {
    if (padded[i] === 0x80) return padded.subarray(0, i);
    if (padded[i] !== 0x00) break;
  }
  throw new Error("invalid padding");
}
