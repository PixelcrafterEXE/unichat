// Minimal protobuf wire codec driven by small hand-written schemas (see schemas.ts). Written from the public wire-format description
// (varint / 64-bit / length-delimited), NOT generated from Threema's .proto files. Unknown fields are skipped; absent fields stay undefined.
export type Scalar = "u32" | "u64" | "f64" | "bool" | "string" | "bytes";
export interface Field { n: number; t: Scalar | Schema | { map: [Scalar, Scalar | Schema] }; rep?: boolean; /** fixed64 is encoded as 8 bytes LE, u64 as varint */ }
export type Schema = { [name: string]: Field };
export type Msg = { [k: string]: any };

export class Writer {
  private parts: number[] = [];
  varint(v: bigint | number) { let x = BigInt(v); if (x < 0n) x &= (1n << 64n) - 1n; do { let b = Number(x & 0x7fn); x >>= 7n; if (x > 0n) b |= 0x80; this.parts.push(b); } while (x > 0n); }
  tag(n: number, wt: number) { this.varint((n << 3) | wt); }
  raw(b: Uint8Array) { for (const x of b) this.parts.push(x); }
  bytes(): Uint8Array { return Uint8Array.from(this.parts); }
}
const enc = new TextEncoder(), dec = new TextDecoder("utf-8", { fatal: false });

function writeScalar(w: Writer, f: { n: number }, t: Scalar, v: any) {
  switch (t) {
    case "u32": w.tag(f.n, 0); w.varint(v); break;
    case "u64": w.tag(f.n, 0); w.varint(BigInt(v)); break;
    case "bool": w.tag(f.n, 0); w.varint(v ? 1 : 0); break;
    case "f64": { w.tag(f.n, 1); const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); w.raw(b); break; }
    case "string": { const b = enc.encode(String(v)); w.tag(f.n, 2); w.varint(b.length); w.raw(b); break; }
    case "bytes": { const b = v as Uint8Array; w.tag(f.n, 2); w.varint(b.length); w.raw(b); break; }
  }
}
export function encode(schema: Schema, msg: Msg): Uint8Array {
  const w = new Writer();
  // field number order, like the reference serialisers (also makes fixtures deterministic)
  for (const [name, f] of Object.entries(schema).sort((a, b) => a[1].n - b[1].n)) {
    const val = msg[name]; if (val === undefined || val === null) continue;
    const items: any[] = f.rep ? val : [val];
    for (const v of items) {
      if (typeof f.t === "string") writeScalar(w, f, f.t, v);
      else if ("map" in f.t && Array.isArray((f.t as any).map)) {
        const [kt, vt] = (f.t as any).map as [Scalar, Scalar | Schema];
        for (const [k, mv] of (v instanceof Map ? [...v.entries()] : Object.entries(v))) {
          const ew = new Writer(); const kk = kt === "string" ? String(k) : BigInt(k as any);
          writeScalar(ew, { n: 1 }, kt, kk);
          if (typeof vt === "string") writeScalar(ew, { n: 2 }, vt, mv); else { const inner = encode(vt, mv as Msg); ew.tag(2, 2); ew.varint(inner.length); ew.raw(inner); }
          const eb = ew.bytes(); w.tag(f.n, 2); w.varint(eb.length); w.raw(eb);
        }
        break;
      } else { const inner = encode(f.t as Schema, v); w.tag(f.n, 2); w.varint(inner.length); w.raw(inner); }
    }
  }
  return w.bytes();
}

interface Raw { n: number; wt: number; v: bigint; b?: Uint8Array }
function* fields(buf: Uint8Array): Generator<Raw> {
  let i = 0;
  const varint = (): bigint => { let r = 0n, s = 0n; for (;;) { if (i >= buf.length) throw new Error("proto: truncated"); const b = buf[i++]; r |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) return r; s += 7n; if (s > 70n) throw new Error("proto: bad varint"); } };
  while (i < buf.length) {
    const key = varint(), n = Number(key >> 3n), wt = Number(key & 7n);
    if (wt === 0) yield { n, wt, v: varint() };
    else if (wt === 1) { if (i + 8 > buf.length) throw new Error("proto: truncated"); yield { n, wt, v: new DataView(buf.buffer, buf.byteOffset + i, 8).getBigUint64(0, true) }; i += 8; }
    else if (wt === 5) { if (i + 4 > buf.length) throw new Error("proto: truncated"); yield { n, wt, v: BigInt(new DataView(buf.buffer, buf.byteOffset + i, 4).getUint32(0, true)) }; i += 4; }
    else if (wt === 2) { const l = Number(varint()); if (i + l > buf.length) throw new Error("proto: truncated"); yield { n, wt, v: 0n, b: buf.subarray(i, i + l) }; i += l; }
    else throw new Error("proto: unsupported wire type");
  }
}
function readScalar(t: Scalar, r: Raw): any {
  switch (t) {
    case "u32": return Number(r.v & 0xffffffffn);
    case "u64": case "f64": return r.v;
    case "bool": return r.v !== 0n;
    case "string": return r.b ? dec.decode(r.b) : "";
    case "bytes": return r.b ? Uint8Array.from(r.b) : new Uint8Array(0);
  }
}
export function decode(schema: Schema, buf: Uint8Array): Msg {
  const out: Msg = {};
  const byNum = new Map<number, [string, Field]>();
  for (const [name, f] of Object.entries(schema)) byNum.set(f.n, [name, f]);
  for (const r of fields(buf)) {
    const e = byNum.get(r.n); if (!e) continue;
    const [name, f] = e;
    let val: any;
    if (typeof f.t === "string") {
      if (f.t === "u32" && r.wt === 2 && r.b) { // packed repeated varints
        const arr: number[] = []; let j = 0; const bb = r.b;
        while (j < bb.length) { let x = 0n, s = 0n; for (;;) { const b = bb[j++]; x |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) break; s += 7n; } arr.push(Number(x)); }
        out[name] = [...(out[name] ?? []), ...arr]; continue;
      }
      val = readScalar(f.t, r);
    } else if ("map" in f.t && Array.isArray((f.t as any).map)) {
      const [kt, vt] = (f.t as any).map as [Scalar, Scalar | Schema]; let k: any, mv: any;
      for (const er of fields(r.b ?? new Uint8Array(0))) { if (er.n === 1) k = readScalar(kt, er); else if (er.n === 2) mv = typeof vt === "string" ? readScalar(vt, er) : decode(vt, er.b ?? new Uint8Array(0)); }
      const m: Map<any, any> = out[name] ?? new Map(); m.set(k, mv); out[name] = m; continue;
    } else val = decode(f.t as Schema, r.b ?? new Uint8Array(0));
    if (f.rep) (out[name] ??= []).push(val); else out[name] = val;
  }
  return out;
}
