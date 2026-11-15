// Crash-safe persistence of an in-memory SQLite image (sql.js) as ONE file. Pure node:fs, no sql.js import, so it is unit-tested
// under plain Node (scripts/persist-test.mjs).
//
// Layout next to <file>:   <file>  current image     <file>.bak  previous good image     <file>.tmp  image being written
// Write  (writeImage):  tmp <- data (fsync) ; if <file> is a valid image: <file> -> <file>.bak (rename) ; tmp -> <file> (rename) ; fsync dir.
//        A crash at any point leaves at least one complete image: before step 3 <file> is untouched; between the two renames
//        <file> is missing but .bak and the complete .tmp exist.
// Read   (loadImage):   candidates in order  <file>, <file>.tmp, <file>.bak ; the first one that passes header validation AND the
//        caller's `open` (e.g. sql.js open + PRAGMA quick_check) wins. A rejected candidate is renamed to <file>.corrupt-<ts> (the
//        newest 2 are kept), never deleted. If files exist but none is usable we THROW: starting from an empty database over an
//        unreadable archive would silently lose it. No files at all -> undefined (fresh database).
import { closeSync, existsSync, fstatSync, ftruncateSync,  fsyncSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeSync, promises as fsp } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

const MAGIC = Buffer.from("SQLite format 3\0", "latin1");

/** Cheap structural check of a SQLite file image: magic, page size, size is a whole number of pages, header page count agrees. */
export function validateImage(b: Uint8Array): string | undefined { return validateHeader(Buffer.from(b.buffer, b.byteOffset, Math.min(b.byteLength, 100)), b.byteLength); }

/** Same check from the first 100 bytes and the file size only (no need to read a 160 MB image to rotate it). */
export function validateHeader(buf: Buffer, size: number): string | undefined {
  if (size < 512 || buf.length < 100) return "too short";
  if (!buf.subarray(0, 16).equals(MAGIC)) return "bad magic";
  let ps = buf.readUInt16BE(16); if (ps === 1) ps = 65536;
  if (ps < 512 || (ps & (ps - 1)) !== 0) return "bad page size " + ps;
  if (size % ps !== 0) return `size ${size} is not a multiple of the page size ${ps}`;
  const pages = buf.readUInt32BE(28);
  // the header page count is only trustworthy when the "version-valid-for" counter equals the change counter
  if (pages > 0 && buf.readUInt32BE(24) === buf.readUInt32BE(92) && pages * ps !== size) return `header says ${pages} pages but file has ${size / ps}`;
  return undefined;
}

export function writeImage(file: string, data: Uint8Array, mode = 0o600): void {
  const tmp = file + ".tmp", bak = file + ".bak";
  const fd = openSync(tmp, "w", mode);
  try { let off = 0; while (off < data.length) off += writeSync(fd, data, off, data.length - off); fsyncSync(fd); } finally { closeSync(fd); }
  if (existsSync(file)) {
    if (fileLooksValid(file)) renameSync(file, bak);
  }
  renameSync(tmp, file);
  try { const d = openSync(dirname(file), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* not supported on this fs */ }
}

function fileLooksValid(file: string): boolean {
  try { const fd = openSync(file, "r"); try { const h = Buffer.alloc(100); readSync(fd, h, 0, 100, 0); return validateHeader(h, fstatSync(fd).size) === undefined; } finally { closeSync(fd); } } catch { return false; /* unreadable: do not rotate it */ }
}

/**
 * Same file protocol as writeImage, but the bytes go out on the libuv thread pool in 4 MB pieces, so the event loop keeps running while a
 * 160 MB image is written + fsynced (that used to block it for 2-3 s per save). The image is written to <file>.wip first (the loader ignores
 * it); only a COMPLETE, fsynced image is renamed to .tmp and then follows the usual rotation. `stillWanted()` is checked before the
 * renames: when a synchronous save overtook this one (shutdown), the stale image is dropped instead of replacing the newer one.
 */
export async function writeImageAsync(file: string, data: Uint8Array, stillWanted: () => boolean, mode = 0o600): Promise<boolean> {
  const wip = file + ".wip", tmp = file + ".tmp", bak = file + ".bak", PIECE = 4 << 20;
  const fh = await fsp.open(wip, "w", mode);
  try {
    for (let off = 0; off < data.length; off += PIECE) { if (!stillWanted()) { await fh.close().catch(() => {}); await fsp.rm(wip, { force: true }); return false; } let o = off; const end = Math.min(data.length, off + PIECE); while (o < end) o += (await fh.write(data, o, end - o, o)).bytesWritten; }
    await fh.sync();
  } finally { await fh.close().catch(() => {}); }
  if (!stillWanted()) { await fsp.rm(wip, { force: true }); return false; }
  await fsp.rename(wip, tmp);
  if (!stillWanted()) { await fsp.rm(tmp, { force: true }); return false; }
  if (existsSync(file) && fileLooksValid(file)) renameSync(file, bak);
  renameSync(tmp, file);
  try { const d = await fsp.open(dirname(file), "r"); try { await d.sync(); } finally { await d.close(); } } catch { /* not supported on this fs */ }
  return true;
}

export interface Loaded { data: Uint8Array; source: "main" | "tmp" | "bak" }

export function loadImage(file: string, open?: (data: Uint8Array) => void, log: (m: string) => void = () => {}): Loaded | undefined {
  const cands: [string, Loaded["source"]][] = [[file, "main"], [file + ".tmp", "tmp"], [file + ".bak", "bak"]];
  const present = cands.filter(([p]) => existsSync(p) && statSync(p).size > 0);
  if (!present.length) return undefined;
  const errors: string[] = [];
  for (const [p, source] of present) {
    try {
      const data = readFileSync(p);
      const bad = validateImage(data);
      if (bad) throw new Error(bad);
      open?.(data);
      if (source === "main") rmSync(file + ".tmp", { force: true }); // stale partial write of an earlier crash
      if (source !== "main") log(`database restored from ${basename(p)} (the main file was ${errors.length ? "unusable" : "missing"})`);
      return { data, source };
    } catch (e) {
      errors.push(`${basename(p)}: ${(e as Error).message}`);
      if (source !== "tmp") quarantine(p); else rmSync(p, { force: true }); // a bad .tmp is just an interrupted write
    }
  }
  throw new Error("database is corrupt and no usable backup exists (" + errors.join("; ") + "); the damaged files were kept as *.corrupt-*");
}

function quarantine(p: string) {
  const ts = Date.now();
  try { renameSync(p, `${p}.corrupt-${ts}`); } catch { return; }
  const base = basename(p) + ".corrupt-", dir = dirname(p);
  const old = readdirSync(dir).filter((f) => f.startsWith(base)).sort().slice(0, -2);
  for (const f of old) rmSync(join(dir, f), { force: true });
}


// ---------------------------------------------------------------------------------------------------------------------------------------
// Incremental saves. A full save writes (and fsyncs) the whole 160 MB image although a sync batch touched a few hundred KB: on a phone that
// is seconds of I/O, ~160 MB of extra RAM while it runs and gigabytes of flash writes per hour. Instead the engine keeps one 8-byte hash per
// 4 KB chunk of the image it last saved; a save exports the image, hashes it, and writes ONLY the changed chunks:
//   1. changed runs -> <file>.jnl (redo journal: header, runs, SHA-256 trailer), fsync            (a crash before the trailer: journal ignored, <file> untouched)
//   2. runs -> <file> in place, ftruncate to the new size, fsync, delete the journal              (a crash in here: recoverJournal() replays it on the next start)
// Loading replays a complete journal first (recoverJournal), so <file> is always either the old or the new image. The .bak copy is a full image
// made when the engine opens a database (see refreshBackup) or when a save rewrites most of the file.
export const CHUNK = 4096;
const JMAGIC = Buffer.from("UNIJNL1\0", "latin1");

/**
 * 8 bytes (two independent 32-bit lanes) per 4 KB chunk. A plain JS multiply-xorshift loop over 32-bit words: ~10x faster than SHA-1 here
 * (SHA-1 over 160 MB cost 0.7-2.4 s on the phone, and it runs on the only thread). This is change detection, not security: a missed change
 * would need both lanes to collide (2^-64 per changed chunk).
 */
export function chunkHashes(data: Uint8Array): Buffer {
  const n = Math.ceil(data.length / CHUNK), out = Buffer.allocUnsafe(n * 8);
  // 32-bit words; the image length is a multiple of the SQLite page size (>= 512), so only an unaligned view needs a copy
  const aligned = data.byteOffset % 4 === 0 ? data : new Uint8Array(data);
  const words = new Int32Array(aligned.buffer, aligned.byteOffset, aligned.length >> 2), per = CHUNK >> 2;
  for (let i = 0; i < n; i++) {
    let h1 = 0x811c9dc5 | 0, h2 = 0x2545f491 | 0; const end = Math.min(words.length, (i + 1) * per);
    for (let j = i * per; j < end; j++) {
      const w = words[j]!;
      h1 = Math.imul(h1 ^ w, 0x01000193); h1 ^= h1 >>> 13;
      h2 = Math.imul(h2 + w, 0x85ebca6b) ^ (h2 >>> 15); h2 = (h2 << 7) | (h2 >>> 25);
    }
    out.writeInt32LE(h1, i * 8); out.writeInt32LE(h2, i * 8 + 4);
  }
  return out;
}

/** New hashes + the changed chunk numbers (a chunk is changed when its hash differs or it did not exist before). */
export function diffChunks(data: Uint8Array, old: Buffer): { hashes: Buffer; changed: number[] } {
  const hashes = chunkHashes(data), n = hashes.length / 8, changed: number[] = [];
  for (let i = 0; i < n; i++) if (i * 8 >= old.length || hashes.compare(old, i * 8, i * 8 + 8, i * 8, i * 8 + 8) !== 0) changed.push(i);
  return { hashes, changed };
}

/** Group chunk numbers into runs [firstChunk, chunkCount]. */
function runs(changed: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const c of changed) { const last = out[out.length - 1]; if (last && last[0] + last[1] === c) last[1]++; else out.push([c, 1]); }
  return out;
}

/** Write the changed chunks of `data` into `file` through a redo journal (see above). `file` must exist and hold the image that `changed` was computed against. */
export function saveIncremental(file: string, data: Uint8Array, changed: number[]): void {
  const jnl = file + ".jnl", rs = runs(changed);
  const head = Buffer.alloc(24); JMAGIC.copy(head, 0); head.writeBigUInt64BE(BigInt(data.length), 8); head.writeUInt32BE(CHUNK, 16); head.writeUInt32BE(rs.length, 20);
  const fd = openSync(jnl, "w", 0o600), sum = createHash("sha256");
  try {
    const put = (b: Uint8Array) => { sum.update(b); let o = 0; while (o < b.length) o += writeSync(fd, b, o, b.length - o); };
    put(head);
    for (const [first, count] of rs) {
      const from = first * CHUNK, to = Math.min(data.length, (first + count) * CHUNK), h = Buffer.alloc(8); h.writeUInt32BE(first, 0); h.writeUInt32BE(to - from, 4);
      put(h); put(data.subarray(from, to));
    }
    const tail = sum.digest(); let o = 0; while (o < tail.length) o += writeSync(fd, tail, o, tail.length - o);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  applyRuns(file, data.length, rs.map(([first, count]) => ({ at: first * CHUNK, bytes: data.subarray(first * CHUNK, Math.min(data.length, (first + count) * CHUNK)) })));
  rmSync(jnl, { force: true });
}

function applyRuns(file: string, size: number, list: { at: number; bytes: Uint8Array }[]) {
  const fd = openSync(file, "r+");
  try {
    for (const r of list) { let o = 0; while (o < r.bytes.length) o += writeSync(fd, r.bytes, o, r.bytes.length - o, r.at + o); }
    ftruncateSync(fd, size); fsyncSync(fd);
  } finally { closeSync(fd); }
}

/** Replay a complete journal left by a crash between its fsync and the end of the in-place writes; drop an incomplete one. Call before loadImage. Returns what it did. */
export function recoverJournal(file: string, log: (m: string) => void = () => {}): "none" | "replayed" | "dropped" {
  const jnl = file + ".jnl";
  if (!existsSync(jnl)) return "none";
  try {
    const b = readFileSync(jnl);
    const ok = b.length >= 24 + 32 && b.subarray(0, 8).equals(JMAGIC) && createHash("sha256").update(b.subarray(0, b.length - 32)).digest().equals(b.subarray(b.length - 32));
    if (!ok || !existsSync(file)) { rmSync(jnl, { force: true }); return "dropped"; }
    const size = Number(b.readBigUInt64BE(8)), n = b.readUInt32BE(20), list: { at: number; bytes: Uint8Array }[] = [];
    let p = 24;
    for (let i = 0; i < n; i++) { const first = b.readUInt32BE(p), len = b.readUInt32BE(p + 4); p += 8; list.push({ at: first * CHUNK, bytes: b.subarray(p, p + len) }); p += len; }
    applyRuns(file, size, list); rmSync(jnl, { force: true });
    log(`replayed an interrupted save (${n} runs)`); return "replayed";
  } catch (e) { log("could not replay the save journal: " + (e as Error).message); rmSync(jnl, { force: true }); return "dropped"; }
}

/** Copy of the current image as <file>.bak (async, reflink/copy_file_range where the fs has it): the fallback of loadImage when the main file is ever unusable. */
export async function refreshBackup(file: string): Promise<void> {
  const tmp = file + ".bak.tmp";
  try { await fsp.copyFile(file, tmp); await fsp.rename(tmp, file + ".bak"); } catch { await fsp.rm(tmp, { force: true }); }
}
