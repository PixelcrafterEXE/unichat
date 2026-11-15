// Minimal PNG / JPEG / GIF dimension sniffing (Instagram's upload parameters want width and height).
export function imageSize(b: Uint8Array): { width: number; height: number } | undefined {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { width: v.getUint32(16), height: v.getUint32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: v.getUint16(p + 5), width: v.getUint16(p + 7) };
      p += 2 + v.getUint16(p + 2);
    }
  }
  return undefined;
}
