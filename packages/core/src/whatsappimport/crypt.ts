// WhatsApp Android local backup container (msgstore.db.crypt15 / .crypt14): header, key handling and a streaming decrypt to a file.
// Format as implemented by the open-source wa-crypt-tools (ElDavoo) and verified here only against a byte-compatible synthetic writer
// (see fixture.ts), never against a real backup.
//
//   file   = [u8 headerLen][0x01 optional "feature table" flag][BackupPrefix protobuf (headerLen bytes)][ciphertext][gcmTag 16][md5 16]
//   prefix = { 1: key_type, 2: c14_cipher{ 1 cipher_version, 2 key_version, 3 server_salt, 4 google_id, 5 IV }, 3: c15_iv{ 1: IV(16) },
//              4: info{ 1: app_version, 3: jidSuffix, 4: backup_version, ... } }
//   md5    = MD5 of every byte before it (single-file backups). A "multifile" backup has no md5: the last 16 bytes are then the GCM tag.
//   cipher = AES-256-GCM with the 16-byte IV from the header, no AAD. Plaintext = zlib stream holding the SQLite database.
//   crypt15 key: the user's 64 hex digits are the 32-byte ROOT key; AES key = HMAC-SHA256(HMAC-SHA256(key=32 zero bytes, root), "backup encryption" || 0x01)
//   crypt14 key: the 158-byte `key` file (a Java-serialised byte[131]); the AES key is its last 32 bytes. Needs root to obtain from the phone.
import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflate } from "node:zlib";
import { BackupError } from "../container.js";
import { pbFields, pbString } from "../signalimport/proto.js";

export type WaCrypt = 14 | 15;
export interface WaHeader { crypt: WaCrypt; iv: Buffer; headerBytes: number; features: boolean; appVersion?: string; jidSuffix?: string; backupVersion?: number }
export const MAX_PLAIN = 48 * 1024 ** 3;        // decompressed size cap (zip-bomb guard)
export const HEX_KEY = /^[0-9a-fA-F]{64}$/;

/** The key as the user types it: spaces, dashes and line breaks are ignored. */
export const normalizeKey = (s: string) => String(s ?? "").replace(/[\s\-_.]/g, "").toLowerCase();
export const looksLikeKey = (s: string) => HEX_KEY.test(normalizeKey(s));

export function deriveBackupEncryptionKey(root: Uint8Array): Buffer {
  if (root.length !== 32) throw new BackupError("bad-passphrase", "The key must be 64 hex digits (32 bytes).");
  const zero = Buffer.alloc(32), priv = createHmac("sha256", zero).update(root).digest();
  const out = createHmac("sha256", priv).update(Buffer.from("backup encryption")).update(Buffer.from([1])).digest();
  priv.fill(0); return out;
}

/** AES key of a crypt14 `key` file (158 bytes = 27-byte Java serialisation wrapper + 131 payload bytes). */
export function keyFromCrypt14KeyFile(file: Uint8Array): Buffer {
  const b = Buffer.from(file);
  if (b.length < 131 || b.length > 4096) throw new BackupError("bad-passphrase", "That is not a WhatsApp crypt14 key file (it should be 158 bytes).");
  const payload = b.subarray(b.length - 131);
  if (payload[0] !== 0 || payload[1] !== 1) throw new BackupError("bad-passphrase", "That key file has an unsupported cipher version.");
  const gid = payload.subarray(35, 51), hashed = payload.subarray(51, 83);
  if (!createHash("sha256").update(gid).digest().equals(hashed)) throw new BackupError("bad-passphrase", "That key file is damaged (its checksum does not match).");
  return Buffer.from(payload.subarray(99, 131));
}

export function parseHeader(buf: Uint8Array): WaHeader {
  const b = Buffer.from(buf);
  const notWa = () => new BackupError("not-a-backup", "This is not a WhatsApp crypt14/crypt15 backup (the header is not recognised). crypt12 and older are not supported.");
  if (b.length < 20) throw notWa();
  const len = b[0]!; let at = 1; const features = b[1] === 1; if (features) at++;
  if (len < 16 || at + len > b.length) throw notWa();
  let iv15: Buffer | undefined, iv14: Buffer | undefined, appVersion: string | undefined, jidSuffix: string | undefined, backupVersion: number | undefined;
  try {
    for (const f of pbFields(b.subarray(at, at + len))) {
      if (f.n === 3 && f.w === 2) for (const g of pbFields(f.v as Uint8Array)) { if (g.n === 1 && g.w === 2) iv15 = Buffer.from(g.v as Uint8Array); }
      else if (f.n === 2 && f.w === 2) for (const g of pbFields(f.v as Uint8Array)) { if (g.n === 5 && g.w === 2) iv14 = Buffer.from(g.v as Uint8Array); }
      else if (f.n === 4 && f.w === 2) for (const g of pbFields(f.v as Uint8Array)) {
        if (g.n === 1 && g.w === 2) appVersion = pbString(g.v); else if (g.n === 3 && g.w === 2) jidSuffix = pbString(g.v); else if (g.n === 4 && g.w === 0) backupVersion = Number(g.v);
      }
    }
  } catch { throw notWa(); }
  const iv = iv15 ?? iv14; if (!iv || iv.length !== 16) throw notWa();
  return { crypt: iv15 ? 15 : 14, iv, headerBytes: at + len, features, appVersion, jidSuffix, backupVersion };
}

export async function readHeader(file: string): Promise<{ header: WaHeader; size: number }> {
  const fh = await open(file, "r");
  try {
    const size = (await fh.stat()).size, b = Buffer.alloc(Math.min(size, 600)); await fh.read(b, 0, b.length, 0);
    if (size < 64) throw new BackupError("truncated", "This file is too small to be a WhatsApp backup.");
    return { header: parseHeader(b), size };
  } finally { await fh.close(); }
}

async function* chunks(file: string, start: number, end: number, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const rs = createReadStream(file, { start, end: end - 1, highWaterMark: 1 << 20 });
  try { for await (const c of rs) { if (signal?.aborted) throw new BackupError("cancelled", "Cancelled."); yield c as Buffer; } } finally { rs.destroy(); }
}

export interface DecryptOptions { signal?: AbortSignal; onProgress?: (done: number, total: number) => void }
export interface DecryptResult { header: WaHeader; size: number; plainBytes: number; multifile: boolean; kind: "sqlite" }

/**
 * Authenticate and decrypt `src` into the plain SQLite file `dst` (created 0600; removed again on any failure). `key` is the 32-byte AES key
 * (see deriveBackupEncryptionKey / keyFromCrypt14KeyFile). Memory use is independent of the file size.
 */
export async function decryptToFile(src: string, dst: string, key: Uint8Array, o: DecryptOptions = {}): Promise<DecryptResult> {
  const { header, size } = await readHeader(src);
  const total = size * 2; let done = 0; const tick = (n: number) => { done += n; o.onProgress?.(Math.min(done, total), total); };
  // pass 1: is the md5 trailer right? (single-file backups) -> where does the tag sit
  const fh = await open(src, "r"); const trailer = Buffer.alloc(16); await fh.read(trailer, 0, 16, size - 16);
  const tagSingle = Buffer.alloc(16); await fh.read(tagSingle, 0, 16, size - 32); const tagMulti = trailer; await fh.close();
  const md5 = createHash("md5");
  for await (const c of chunks(src, 0, size - 16, o.signal)) { md5.update(c); tick(c.length); }
  const multifile = !md5.digest().equals(trailer);
  const tag = multifile ? Buffer.from(tagMulti) : tagSingle, ctEnd = size - (multifile ? 16 : 32);
  if (ctEnd <= header.headerBytes) throw new BackupError("truncated", "This backup file is incomplete.");
  const dec = createDecipheriv("aes-256-gcm", key, header.iv); dec.setAuthTag(tag);
  let first = true, plain = 0, raw = false;
  async function* plainChunks() {
    for await (const c of chunks(src, header.headerBytes, ctEnd, o.signal)) {
      const p = dec.update(c); tick(c.length);
      if (first && p.length) {
        first = false;
        if (p.subarray(0, 15).toString("latin1") === "SQLite format 3") raw = true;
        else if (!(p[0] === 0x78 && ((p[0]! << 8) | p[1]!) % 31 === 0)) throw new BackupError("bad-passphrase", "Wrong key, or this is not a WhatsApp backup made with it. Check the 64 digits and try again. Nothing was imported.");
      }
      plain += p.length; if (plain > MAX_PLAIN) throw new BackupError("too-large", "The backup expands to an unreasonable size.");
      if (p.length) yield p;
    }
    try { const last = dec.final(); if (last.length) yield last; }
    catch { throw new BackupError(multifile ? "corrupt" : "bad-passphrase", multifile ? "This backup failed its authentication check: the file is damaged, or the key is wrong." : "This backup failed its authentication check although the file is intact: the key is wrong."); }
  }
  const out = createWriteStream(dst, { mode: 0o600 });
  try {
    // the zlib stream is decided after the first chunk: wrap so a raw SQLite file (never seen, but cheap to allow) skips inflate
    const gen = plainChunks(), firstChunk = await gen.next();
    if (firstChunk.done) throw new BackupError("corrupt", "This backup contains no data.");
    const rest = (async function* () { yield firstChunk.value; for await (const c of gen) yield c; })();
    if (raw) await pipeline(Readable.from(rest, { objectMode: false }), out);
    else {
      const inflate = createInflate(); let outBytes = 0;
      inflate.on("data", (d: Buffer) => { outBytes += d.length; if (outBytes > MAX_PLAIN) inflate.destroy(new BackupError("too-large", "The backup expands to an unreasonable size.")); });
      await pipeline(Readable.from(rest, { objectMode: false }), inflate, out);
    }
  } catch (e) {
    out.destroy(); await rm(dst, { force: true });
    if (e instanceof BackupError) throw e;
    if ((e as any)?.code?.startsWith?.("Z_")) throw new BackupError("corrupt", "This backup is damaged (its compressed data is invalid).");
    throw e;
  }
  const st = await stat(dst);
  if (st.size < 100) { await rm(dst, { force: true }); throw new BackupError("corrupt", "The decrypted backup is empty."); }
  const head = Buffer.alloc(16), h2 = await open(dst, "r"); try { await h2.read(head, 0, 16, 0); } finally { await h2.close(); }
  if (head.toString("latin1", 0, 15) !== "SQLite format 3") { await rm(dst, { force: true }); throw new BackupError("corrupt", "The decrypted data is not a SQLite database: this backup is not msgstore.db or uses a layout this importer does not know."); }
  return { header, size, plainBytes: st.size, multifile, kind: "sqlite" };
}

// ------------------------------------------------------------------ writer (synthetic fixtures only; kept next to the reader so both stay in sync)
export function encryptCrypt15(plainSqlite: Uint8Array, rootKey: Uint8Array, o: { iv?: Buffer; jidSuffix?: string; appVersion?: string; features?: boolean; multifile?: boolean; zlib?: Uint8Array } = {}): Buffer {
  const iv = o.iv ?? Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
  const key = deriveBackupEncryptionKey(rootKey);
  return buildContainer(o.zlib ?? plainSqlite, key, iv, { ...o, crypt: 15 });
}
export function encryptCrypt14(compressed: Uint8Array, aesKey: Uint8Array, o: { iv?: Buffer; jidSuffix?: string; appVersion?: string } = {}): Buffer {
  return buildContainer(compressed, aesKey, o.iv ?? Buffer.from("a1a2a3a4a5a6a7a8a9aaabacadaeaf00", "hex"), { ...o, crypt: 14 });
}
function buildContainer(zlibbed: Uint8Array, key: Uint8Array, iv: Buffer, o: { crypt: WaCrypt; jidSuffix?: string; appVersion?: string; features?: boolean; multifile?: boolean }): Buffer {
  const varint = (v: number) => { const out: number[] = []; while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; } out.push(v); return Buffer.from(out); };
  const ld = (n: number, b: Uint8Array) => Buffer.concat([varint((n << 3) | 2), varint(b.length), Buffer.from(b)]);
  const info = Buffer.concat([ld(1, Buffer.from(o.appVersion ?? "2.24.20.78")), ld(3, Buffer.from(o.jidSuffix ?? "01")), Buffer.concat([varint((4 << 3) | 0), varint(1)])]);
  const prefix = Buffer.concat([Buffer.concat([varint(1 << 3), varint(1)]), o.crypt === 15 ? ld(3, ld(1, iv)) : ld(2, ld(5, iv)), ld(4, info)]);
  const head = Buffer.concat([Buffer.from([prefix.length]), o.features === false ? Buffer.alloc(0) : Buffer.from([1]), prefix]);
  const c = createCipheriv("aes-256-gcm", key, iv), ct = Buffer.concat([c.update(zlibbed), c.final()]), tag = c.getAuthTag();
  if (o.multifile) return Buffer.concat([head, ct, tag]);
  const body = Buffer.concat([head, ct, tag]);
  return Buffer.concat([body, createHash("md5").update(body).digest()]);
}
export function crypt14KeyFile(aesKey: Uint8Array, serverSalt = Buffer.alloc(32, 7), googleId = Buffer.alloc(16, 9)): Buffer {
  const payload = Buffer.concat([Buffer.from([0, 1, 3]), serverSalt, googleId, createHash("sha256").update(googleId).digest(), Buffer.alloc(16), Buffer.from(aesKey)]);
  return Buffer.concat([Buffer.from("aced0005" + "7572" + "00025b42" + "acf317f8060854e0" + "02" + "0000" + "7870" + "00000083", "hex"), payload]);
}
