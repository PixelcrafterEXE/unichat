// Portable, encrypted, streamed archive container used by the backup / migration feature (`*.unimsg-backup`).
// Nothing here knows about messages: it stores a sequence of ENTRIES (a JSON head plus an optional binary body).
//
//   file      = "UNIMSGBK" | u16 version | u32 headerLen | header JSON | frame* | final frame
//   frame     = u32 ctLen | u8 flags | ciphertext(+16 byte GCM tag)         flags: 1 = final (footer) frame
//   plaintext = gzip|zstd|none of ( entry* | u32 0 )                         entry = u32 headLen | head JSON {..., size} | body[size]
//
//  - Key: scrypt(passphrase, salt, N>=2^14 (default 2^16), r=8, p=1) -> 64 bytes: AES-256 key + key-check HMAC key.
//    The header carries an HMAC "check" of the derived key, so a wrong passphrase is told apart from damage.
//  - Every frame is AES-256-GCM with nonce = random 4 byte prefix || u64 frame counter and AAD = sha256(preamble) ||
//    flags || counter: frames cannot be reordered, dropped, duplicated or moved to another file undetected; the header is bound
//    to every frame. The file must end with the final frame (footer: sha256 + size of the plaintext, entry counts, manifest hash),
//    so truncation and trailing garbage are detected.
//  - Everything is streamed with back-pressure; memory use is a few chunks (plus one entry body that the caller buffers itself).
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, renameSync, rmSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

export const MAGIC = Buffer.from("UNIMSGBK", "latin1");
export const FORMAT_VERSION = 1;
const CHUNK = 64 * 1024;
const MAX_HEADER = 64 * 1024, MAX_ENTRY_HEAD = 1024 * 1024, MAX_FOOTER = 1024 * 1024;
const zx = zlib as any;
export const zstdAvailable = typeof zx.createZstdCompress === "function";

export type BackupErrorCode = "not-a-backup" | "unsupported-version" | "bad-passphrase" | "corrupt" | "truncated" | "cancelled" | "unsupported-compression" | "too-large" | "not-empty" | "invalid";
/** Errors with a message that is fit to show to the user as is. */
export class BackupError extends Error {
  constructor(public code: BackupErrorCode, message: string) { super(message); this.name = "BackupError"; }
}
const E = {
  notBackup: () => new BackupError("not-a-backup", "This file is not an UniChat backup."),
  corrupt: () => new BackupError("corrupt", "This backup is damaged or has been modified, so nothing was imported."),
  truncated: () => new BackupError("truncated", "This backup is incomplete (the file was cut off, e.g. an interrupted copy or download), so nothing was imported."),
  badPass: () => new BackupError("bad-passphrase", "Wrong passphrase. Nothing was imported."),
  cancelled: () => new BackupError("cancelled", "Cancelled."),
};

export interface ArchiveHeader {
  v: number;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: "aes-256-gcm"; comp: "gzip" | "zstd" | "none"; chunk: number;
  np: string;      // base64 nonce prefix
  check: string;   // hex HMAC proving the passphrase
}
export interface Footer { entries: number; bytes: number; sha256: string; manifestSha256: string; kinds: Record<string, number> }
export interface EntryOut { head: Record<string, unknown>; body?: Uint8Array | AsyncIterable<Uint8Array>; /** required for streamed bodies */ size?: number }
export interface EntryIn { head: Record<string, unknown> & { size: number }; body: AsyncIterable<Buffer> }

const passKey = (pass: string, salt: Buffer, N: number, r: number, p: number) => new Promise<Buffer>((ok, fail) =>
  scrypt(pass.normalize("NFKC"), salt, 64, { N, r, p, maxmem: 256 * N * r }, (e, k) => (e ? fail(e) : ok(k))));
const checkOf = (key: Buffer) => createHmac("sha256", key.subarray(32)).update("unimsg-backup-passphrase-check").digest("hex");
const counterBuf = (c: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(c)); return b; };
const ivOf = (np: Buffer, c: number) => Buffer.concat([np, counterBuf(c)]);
const aadOf = (base: Buffer, flags: number, c: number) => Buffer.concat([base, Buffer.from([flags]), counterBuf(c)]);
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const asBuf = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

function compressor(c: ArchiveHeader["comp"], level: number) {
  if (c === "gzip") return zlib.createGzip({ level });
  if (c === "zstd") { if (!zstdAvailable) throw new BackupError("unsupported-compression", "This Node version cannot write zstd archives."); return zx.createZstdCompress(); }
  return new PassThrough();
}
function decompressor(c: ArchiveHeader["comp"]) {
  if (c === "gzip") return zlib.createGunzip();
  if (c === "zstd") { if (!zstdAvailable) throw new BackupError("unsupported-compression", "This backup is compressed with zstd, which this device's Node version can't read. Re-export it with gzip."); return zx.createZstdDecompress(); }
  if (c === "none") return new PassThrough();
  throw new BackupError("unsupported-compression", "This backup uses an unknown compression method.");
}

export interface WriteOptions {
  passphrase: string;
  manifest: Record<string, unknown>;
  entries: AsyncIterable<EntryOut> | Iterable<EntryOut>;
  comp?: ArchiveHeader["comp"]; level?: number;
  /** scrypt cost; default 2^16 (64 MiB), minimum 2^14 (tests). */
  kdfN?: number;
  signal?: AbortSignal;
  /** called with the number of PLAINTEXT bytes produced so far */
  onBytes?: (n: number) => void;
}
export interface WriteResult { size: number; sha256: string; footer: Footer }

/** Write `file` atomically (".part" then rename): on any failure or cancel nothing is left behind. */
export async function writeArchive(file: string, o: WriteOptions): Promise<WriteResult> {
  if (!o.passphrase) throw new BackupError("invalid", "A passphrase is required.");
  const N = o.kdfN ?? 1 << 16; if (N < 1 << 14) throw new Error("scrypt cost too low");
  const comp = o.comp ?? "gzip", salt = randomBytes(16), np = randomBytes(4);
  const key = await passKey(o.passphrase, salt, N, 8, 1);
  const header: ArchiveHeader = { v: FORMAT_VERSION, kdf: { name: "scrypt", N, r: 8, p: 1, salt: salt.toString("base64") }, cipher: "aes-256-gcm", comp, chunk: CHUNK, np: np.toString("base64"), check: checkOf(key) };
  const hj = Buffer.from(JSON.stringify(header), "utf8");
  const ver = Buffer.alloc(2); ver.writeUInt16BE(FORMAT_VERSION);
  const preamble = Buffer.concat([MAGIC, ver, u32(hj.length), hj]);
  const base = createHash("sha256").update(preamble).digest();
  const aesKey = key.subarray(0, 32);

  const plainHash = createHash("sha256"), outHash = createHash("sha256");
  let plainBytes = 0, nEntries = 0; const kinds: Record<string, number> = {};
  let manifestSha = "";
  const note = (b: Buffer) => { plainHash.update(b); plainBytes += b.length; o.onBytes?.(plainBytes); return b; };

  async function* plain(): AsyncGenerator<Buffer> {
    const mj = Buffer.from(JSON.stringify(o.manifest), "utf8"); manifestSha = createHash("sha256").update(mj).digest("hex");
    async function* all(): AsyncGenerator<EntryOut> { yield { head: { kind: "manifest" }, body: mj }; yield* o.entries; }
    for await (const e of all()) {
      if (o.signal?.aborted) throw E.cancelled();
      const declared = e.body === undefined ? 0 : ArrayBuffer.isView(e.body) ? (e.body as Uint8Array).byteLength : e.size;
      if (declared === undefined) throw new Error("streamed entry bodies need a size");
      const hb = Buffer.from(JSON.stringify({ ...e.head, size: declared }), "utf8");
      if (hb.length > MAX_ENTRY_HEAD) throw new Error("entry head too large");
      yield note(u32(hb.length)); yield note(hb);
      let sent = 0;
      if (e.body !== undefined) {
        if (ArrayBuffer.isView(e.body)) { sent = e.body.byteLength; yield note(asBuf(e.body)); }
        else for await (const piece of e.body) { if (o.signal?.aborted) throw E.cancelled(); sent += piece.byteLength; yield note(asBuf(piece)); }
      }
      if (sent !== declared) throw new Error(`entry ${String(e.head.kind)} declared ${declared} bytes but produced ${sent}`);
      nEntries++; const k = String(e.head.kind); kinds[k] = (kinds[k] ?? 0) + 1;
    }
    yield note(u32(0));
  }

  let outBytes = 0;
  async function* encrypt(src: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    const out = (b: Buffer) => { outHash.update(b); outBytes += b.length; return b; };
    yield out(preamble);
    let counter = 0, pend: Buffer[] = [], len = 0;
    const frame = (pt: Buffer, flags: number) => {
      const c = createCipheriv("aes-256-gcm", aesKey, ivOf(np, counter)); c.setAAD(aadOf(base, flags, counter));
      const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]); counter++;
      return out(Buffer.concat([u32(ct.length), Buffer.from([flags]), ct]));
    };
    for await (const piece of src) {
      pend.push(piece); len += piece.length;
      if (len >= CHUNK) { const all = Buffer.concat(pend, len); let off = 0; while (all.length - off >= CHUNK) { yield frame(all.subarray(off, off + CHUNK), 0); off += CHUNK; } pend = [all.subarray(off)]; len = all.length - off; }
    }
    if (len) yield frame(Buffer.concat(pend, len), 0);
    const footer: Footer = { entries: nEntries, bytes: plainBytes, sha256: plainHash.digest("hex"), manifestSha256: manifestSha, kinds };
    footerOut = footer;
    yield frame(Buffer.from(JSON.stringify(footer), "utf8"), 1);
  }
  let footerOut: Footer | undefined;

  const part = file + ".part";
  try {
    await pipeline(Readable.from(plain(), { objectMode: false }), compressor(comp, o.level ?? 3), encrypt, createWriteStream(part, { mode: 0o600 }), { signal: o.signal });
    renameSync(part, file);
  } catch (e) {
    try { rmSync(part, { force: true }); } catch { /* ignore */ }
    if (o.signal?.aborted || (e as Error)?.name === "AbortError") throw E.cancelled();
    throw e;
  }
  return { size: outBytes, sha256: outHash.digest("hex"), footer: footerOut! };
}

/** Pull-based byte reader over an async iterable. */
class ByteReader {
  private q: Buffer[] = []; private len = 0; private done = false;
  consumed = 0;
  constructor(private it: AsyncIterator<Uint8Array>) {}
  private async fill(n: number) {
    while (this.len < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true; else if (r.value.byteLength) { this.q.push(asBuf(r.value)); this.len += r.value.byteLength; }
    }
  }
  private take(n: number): Buffer {
    this.consumed += n; this.len -= n;
    if (this.q[0].length === n) return this.q.shift()!;
    if (this.q[0].length > n) { const o = this.q[0].subarray(0, n); this.q[0] = this.q[0].subarray(n); return o; }
    const parts: Buffer[] = []; let need = n;
    while (need > 0) { const b = this.q[0]; if (b.length <= need) { parts.push(this.q.shift()!); need -= b.length; } else { parts.push(b.subarray(0, need)); this.q[0] = b.subarray(need); need = 0; } }
    return Buffer.concat(parts, n);
  }
  /** Exactly n bytes, or null when the stream is already at its end (zero bytes available). Partial => truncated. */
  async exact(n: number): Promise<Buffer | null> {
    if (n === 0) return Buffer.alloc(0);
    await this.fill(n);
    if (this.len === 0) return null;
    if (this.len < n) throw E.truncated();
    return this.take(n);
  }
  async need(n: number): Promise<Buffer> { const b = await this.exact(n); if (!b) throw E.truncated(); return b; }
  async *stream(n: number): AsyncGenerator<Buffer> {
    while (n > 0) { await this.fill(1); if (!this.len) throw E.truncated(); const b = this.take(Math.min(n, this.q[0].length)); n -= b.length; yield b; }
  }
  async atEnd() { await this.fill(1); return this.len === 0; }
}

export interface OpenedArchive {
  header: ArchiveHeader;
  manifest: Record<string, any>;
  /** Single pass over the entries after the manifest. Fully consuming it verifies the footer (hash, size, counts); a problem throws. */
  entries(): AsyncGenerator<EntryIn>;
  footer(): Footer | undefined;
  /** Bytes of the ENCRYPTED file consumed so far. */
  position(): number;
  close(): void;
}

/** Read the header, check the passphrase and read the manifest. Throws BackupError. Cheap: touches only the start of the file. */
export async function openArchive(file: string, passphrase: string, signal?: AbortSignal): Promise<OpenedArchive> {
  const rs = createReadStream(file, { highWaterMark: 1 << 20 });
  const raw = new ByteReader(rs[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>);
  let closed = false;
  const close = () => { if (!closed) { closed = true; rs.destroy(); } };
  try {
    let head: Buffer | null;
    try { head = await raw.exact(8); } catch { throw E.notBackup(); }
    if (!head || !head.equals(MAGIC)) throw E.notBackup();
    let vb: Buffer; try { vb = await raw.need(6); } catch { throw E.notBackup(); }
    const ver = vb.readUInt16BE(0), hlen = vb.readUInt32BE(2);
    if (ver !== FORMAT_VERSION) throw new BackupError("unsupported-version", ver > FORMAT_VERSION ? "This backup was made by a newer version of UniChat. Update UniChat and try again." : "This backup uses an old format that is no longer supported.");
    if (hlen === 0 || hlen > MAX_HEADER) throw E.corrupt();
    const hj = await raw.need(hlen);
    let h: ArchiveHeader;
    try { h = JSON.parse(hj.toString("utf8")); } catch { throw E.corrupt(); }
    const k = h?.kdf;
    if (!k || k.name !== "scrypt" || h.cipher !== "aes-256-gcm" || h.v !== ver || typeof k.salt !== "string" || typeof h.np !== "string" || typeof h.check !== "string"
      || !Number.isInteger(k.N) || k.N < 1 << 14 || k.N > 1 << 18 || (k.N & (k.N - 1)) !== 0 || k.r !== 8 || k.p !== 1
      || !Number.isInteger(h.chunk) || h.chunk < 1024 || h.chunk > 1 << 20) throw E.corrupt();
    const np = Buffer.from(h.np, "base64"), salt = Buffer.from(k.salt, "base64");
    if (np.length !== 4 || salt.length < 8) throw E.corrupt();
    const decomp = decompressor(h.comp); decomp.destroy(); // fail early on an unsupported method
    const key = await passKey(passphrase ?? "", salt, k.N, k.r, k.p);
    const want = Buffer.from(h.check, "hex"), got = Buffer.from(checkOf(key), "hex");
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw E.badPass();
    const base = createHash("sha256").update(Buffer.concat([MAGIC, vb, hj])).digest();
    const aesKey = key.subarray(0, 32);

    let footer: Footer | undefined;
    async function* decrypt(): AsyncGenerator<Buffer> {
      let counter = 0;
      for (;;) {
        if (signal?.aborted) throw E.cancelled();
        const fh = await raw.exact(5);
        if (!fh) throw E.truncated();
        const ctLen = fh.readUInt32BE(0), flags = fh[4];
        if (ctLen < 16 || ctLen > Math.max(h.chunk, MAX_FOOTER) + 16 || flags > 1) throw E.corrupt();
        const ct = await raw.need(ctLen);
        let pt: Buffer;
        try {
          const d = createDecipheriv("aes-256-gcm", aesKey, ivOf(np, counter)); d.setAAD(aadOf(base, flags, counter)); d.setAuthTag(ct.subarray(ctLen - 16));
          pt = Buffer.concat([d.update(ct.subarray(0, ctLen - 16)), d.final()]);
        } catch { throw E.corrupt(); }
        counter++;
        if (flags === 1) {
          try { footer = JSON.parse(pt.toString("utf8")); } catch { throw E.corrupt(); }
          if (!(await raw.atEnd())) throw E.corrupt(); // data after the final frame
          return;
        }
        yield pt;
      }
    }
    const plainHash = createHash("sha256"); let plainBytes = 0;
    const sink = new PassThrough(); sink.on("error", () => {}); // errors surface through the reader; a closed archive must not crash the process
    pipeline(Readable.from(decrypt(), { objectMode: false }), decompressor(h.comp), sink).catch((e) => sink.destroy(e instanceof BackupError ? e : (e as any)?.code?.startsWith?.("Z_") || (e as any)?.code?.startsWith?.("ZSTD") ? E.corrupt() : e));
    async function* counted(): AsyncGenerator<Uint8Array> { for await (const b of sink) { plainHash.update(b as Buffer); plainBytes += (b as Buffer).length; yield b as Buffer; } }
    const pr = new ByteReader(counted());

    // manifest = first entry
    const readHead = async (): Promise<(Record<string, any> & { size: number }) | null> => {
      const l = await pr.need(4); const n = l.readUInt32BE(0);
      if (n === 0) return null;
      if (n > MAX_ENTRY_HEAD) throw E.corrupt();
      let j: any; try { j = JSON.parse((await pr.need(n)).toString("utf8")); } catch (e) { if (e instanceof BackupError) throw e; throw E.corrupt(); }
      if (!j || typeof j.size !== "number" || j.size < 0 || !Number.isSafeInteger(j.size)) throw E.corrupt();
      return j;
    };
    const mh = await readHead();
    if (!mh || mh.kind !== "manifest" || mh.size > 4 * 1024 * 1024) throw E.corrupt();
    const mj = await pr.need(mh.size);
    let manifest: Record<string, any>; try { manifest = JSON.parse(mj.toString("utf8")); } catch { throw E.corrupt(); }
    const manifestSha = createHash("sha256").update(mj).digest("hex");

    return {
      header: h, manifest, footer: () => footer, position: () => raw.consumed, close,
      async *entries() {
        try {
          for (;;) {
            const eh = await readHead();
            if (!eh) break;
            let left = eh.size, used = false;
            const body = (async function* () { used = true; for await (const b of pr.stream(eh.size)) { left -= b.length; yield b; } })();
            yield { head: eh, body };
            if (!used) for await (const b of pr.stream(eh.size)) left -= b.length; // caller ignored the body: skip it
            else if (left > 0) for await (const b of pr.stream(left)) left -= b.length; // caller stopped early
          }
          if (!(await pr.atEnd())) throw E.corrupt();
          // footer was decoded by decrypt() before the plaintext stream ended
          if (!footer) throw E.truncated();
          if (footer.sha256 !== plainHash.digest("hex") || footer.bytes !== plainBytes || footer.manifestSha256 !== manifestSha) throw E.corrupt();
        } catch (e) { close(); throw e; }
        close();
      },
    };
  } catch (e) { close(); throw e; }
}

/** Read and authenticate the WHOLE archive without keeping anything. Returns manifest + footer, or throws a BackupError. */
export async function verifyArchive(file: string, passphrase: string, o: { signal?: AbortSignal; onProgress?: (done: number) => void } = {}): Promise<{ manifest: Record<string, any>; footer: Footer }> {
  const a = await openArchive(file, passphrase, o.signal);
  try {
    let n = 0;
    for await (const e of a.entries()) { for await (const _ of e.body) { /* drain */ } if (++n % 64 === 0) o.onProgress?.(a.position()); }
    o.onProgress?.(a.position());
    return { manifest: a.manifest, footer: a.footer()! };
  } finally { a.close(); }
}

/** Header + manifest only (needs the passphrase: the manifest is encrypted). */
export async function inspectArchive(file: string, passphrase: string): Promise<{ manifest: Record<string, any>; header: ArchiveHeader }> {
  const a = await openArchive(file, passphrase);
  a.close();
  return { manifest: a.manifest, header: a.header };
}

export async function collectBody(body: AsyncIterable<Uint8Array>, max = 256 * 1024 * 1024): Promise<Buffer> {
  const parts: Buffer[] = []; let n = 0;
  for await (const b of body) { n += b.byteLength; if (n > max) throw new BackupError("too-large", "A backup entry is unexpectedly large."); parts.push(asBuf(b)); }
  return Buffer.concat(parts, n);
}
