// Minimal protobuf wire reader/writer (no schema, no dependencies). The Signal backup formats only need a handful of messages,
// and a tiny hand-written reader keeps untrusted input handling auditable and memory-flat.
export interface PbField { n: number; w: number; v: bigint | Uint8Array }

/** Iterate the fields of one message. Throws on malformed input (truncated varint / length). Unknown fields are returned, never rejected. */
export function* pbFields(buf: Uint8Array): Generator<PbField> {
  let i = 0;
  const varint = (): bigint => {
    let r = 0n, s = 0n;
    for (let k = 0; k < 10; k++) {
      if (i >= buf.length) throw new Error("protobuf: truncated varint");
      const b = buf[i++]!; r |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) return r; s += 7n;
    }
    throw new Error("protobuf: varint too long");
  };
  while (i < buf.length) {
    const key = Number(varint()), n = key >>> 3, w = key & 7;
    if (n === 0) throw new Error("protobuf: bad field number");
    if (w === 0) yield { n, w, v: varint() };
    else if (w === 1) { if (i + 8 > buf.length) throw new Error("protobuf: truncated"); yield { n, w, v: buf.subarray(i, i + 8) }; i += 8; }
    else if (w === 5) { if (i + 4 > buf.length) throw new Error("protobuf: truncated"); yield { n, w, v: buf.subarray(i, i + 4) }; i += 4; }
    else if (w === 2) { const l = Number(varint()); if (l < 0 || i + l > buf.length) throw new Error("protobuf: truncated"); yield { n, w, v: buf.subarray(i, i + l) }; i += l; }
    else throw new Error("protobuf: unsupported wire type " + w);
  }
}
export const pbString = (v: bigint | Uint8Array): string => (typeof v === "bigint" ? String(v) : Buffer.from(v).toString("utf8"));
export const pbDouble = (v: bigint | Uint8Array): number => (typeof v === "bigint" ? Number(v) : Buffer.from(v).readDoubleLE(0));
export const pbNum = (v: bigint | Uint8Array): number => (typeof v === "bigint" ? Number(BigInt.asIntN(64, v)) : 0);

/** Read a varint-length-delimited message stream from an in-memory buffer (used by the new backup format's frame list). */
export function readVarint(buf: Uint8Array, at: number): { v: number; next: number } | undefined {
  let r = 0, s = 0, i = at;
  for (let k = 0; k < 10; k++) {
    if (i >= buf.length) return undefined;
    const b = buf[i++]!; r += (b & 0x7f) * 2 ** s; if (!(b & 0x80)) return { v: r, next: i }; s += 7;
  }
  throw new Error("protobuf: varint too long");
}

// ---- writer (used by the test fixtures; kept next to the reader so both stay in sync) ----
export class PbWriter {
  private parts: Buffer[] = [];
  private varintBytes(v: bigint | number): Buffer {
    let x = BigInt.asUintN(64, BigInt(v)); const out: number[] = [];
    while (x > 0x7fn) { out.push(Number(x & 0x7fn) | 0x80); x >>= 7n; }
    out.push(Number(x)); return Buffer.from(out);
  }
  private key(n: number, w: number) { this.parts.push(this.varintBytes((n << 3) | w)); }
  varint(n: number, v: bigint | number | boolean) { this.key(n, 0); this.parts.push(this.varintBytes(typeof v === "boolean" ? (v ? 1 : 0) : v)); return this; }
  bytes(n: number, b: Uint8Array | string) { const x = typeof b === "string" ? Buffer.from(b, "utf8") : Buffer.from(b); this.key(n, 2); this.parts.push(this.varintBytes(x.length), x); return this; }
  double(n: number, d: number) { this.key(n, 1); const b = Buffer.alloc(8); b.writeDoubleLE(d); this.parts.push(b); return this; }
  msg(n: number, w: PbWriter) { return this.bytes(n, w.done()); }
  done(): Buffer { return Buffer.concat(this.parts); }
}
export const lengthDelimited = (b: Uint8Array): Buffer => { const w = new PbWriter() as any; return Buffer.concat([w.varintBytes(b.length), Buffer.from(b)]); };
