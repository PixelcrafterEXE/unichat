// Signal Android "local backup" (legacy format, file signal-YYYY-MM-DD-HH-MM-SS.backup): reader.
//
// Stream layout (Signal-Android FullBackupBase / BackupFrameInputStream):
//   [u32be len][BackupFrame{header: iv(16), salt(32)}]            plain
//   then repeated:  [u32be len][ciphertext || mac10]              frame, AES-256-CTR, mac = HMAC-SHA256(macKey, ciphertext)[0..10]
//   a frame of type attachment/avatar/sticker is followed by `length` bytes of ciphertext + mac10 (that mac also covers the iv)
//   IV for the n-th encrypted item: first 4 bytes = (initialCounter + n) as u32be, the other 12 bytes = header iv bytes 4..15
// Keys: backupKey = first 32 bytes of the SHA-512 chain over (salt || passphrase || passphrase), 250000 rounds
//       (round i>0: SHA-512(prev || passphrase)); then HKDF-SHA256(ikm=backupKey, salt=32 zero bytes, info="Backup Export") -> 64 bytes
//       = cipherKey(32) || macKey(32). The passphrase is the 30 digits Signal shows (spaces/dashes are ignored).
// Everything is streamed: memory use is one frame (<= 64 MiB cap) plus, only when the caller asks for it, one attachment.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { BackupError } from "../container.js";
import { pbDouble, pbFields, pbNum, pbString } from "./proto.js";

export const KDF_ROUNDS = 250_000;
export const MAX_FRAME = 64 * 1024 * 1024;
export const MAX_BLOB = 512 * 1024 * 1024;

export type SqlValue = string | number | bigint | Buffer | null;
export type LegacyFrame =
  | { kind: "header"; iv: Buffer; salt: Buffer; version?: number }
  | { kind: "version"; version: number }
  | { kind: "statement"; sql: string; params: SqlValue[] }
  | { kind: "preference"; file: string; key: string; value?: string }
  | { kind: "keyvalue"; key: string; value: string | number | boolean | undefined }
  | { kind: "attachment"; rowId: number; attachmentId: number; length: number }
  | { kind: "avatar"; name: string; recipientId?: string; length: number }
  | { kind: "sticker"; rowId: number; length: number }
  | { kind: "end" }
  | { kind: "unknown" };

/** The user types the 30 digits in any grouping. Everything but digits/letters is dropped. */
export const normalizePassphrase = (p: string) => String(p ?? "").replace(/[\s\-_.]/g, "");
/** True when the text looks like Signal's 30-digit passphrase (what the UI validates before it starts the slow key derivation). */
export const looksLikePassphrase = (p: string) => /^\d{30}$/.test(normalizePassphrase(p));

export function deriveBackupKey(passphrase: string, salt: Uint8Array, rounds = KDF_ROUNDS): Buffer {
  const input = Buffer.from(normalizePassphrase(passphrase), "utf8");
  let hash: Buffer = input;
  // round 0 hashes salt||input||input (the Java code feeds `salt` once, then update(hash=input) + digest(input))
  for (let i = 0; i < rounds; i++) {
    const h = createHash("sha512");
    if (i === 0) h.update(salt);
    hash = h.update(hash).update(input).digest();
  }
  return hash.subarray(0, 32);
}
export function deriveFrameKeys(backupKey: Uint8Array): { cipherKey: Buffer; macKey: Buffer } {
  const k = Buffer.from(hkdfSync("sha256", backupKey, Buffer.alloc(32), Buffer.from("Backup Export"), 64));
  return { cipherKey: k.subarray(0, 32), macKey: k.subarray(32, 64) };
}

/** Exact-length reads over a file handle with a 1 MiB read-ahead buffer. */
export class FileReader {
  private buf = Buffer.alloc(0); private off = 0; pos = 0;
  constructor(private fh: FileHandle, readonly size: number) {}
  async read(n: number): Promise<Buffer> {
    if (n < 0 || n > MAX_BLOB) throw new BackupError("corrupt", "This file is damaged (bad length field).");
    if (this.buf.length - this.off >= n) { const r = this.buf.subarray(this.off, this.off + n); this.off += n; this.pos += n; return Buffer.from(r); }
    const out = Buffer.allocUnsafe(n); let got = 0;
    const have = this.buf.length - this.off; if (have) { this.buf.copy(out, 0, this.off); got = have; this.off = this.buf.length; }
    while (got < n) {
      const want = n - got;
      if (want >= (1 << 20)) { const { bytesRead } = await this.fh.read(out, got, want, this.pos + got); if (!bytesRead) throw truncated(); got += bytesRead; continue; }
      const chunk = Buffer.allocUnsafe(1 << 20); const { bytesRead } = await this.fh.read(chunk, 0, chunk.length, this.pos + got);
      if (!bytesRead) throw truncated();
      this.buf = chunk.subarray(0, bytesRead); this.off = 0;
      const take = Math.min(want, bytesRead); this.buf.copy(out, got, 0, take); this.off = take; got += take;
    }
    this.pos += n; return out;
  }
  atEnd() { return this.pos >= this.size; }
}
const truncated = () => new BackupError("truncated", "This backup file is incomplete (cut off), so nothing was imported.");

export function parseFrame(raw: Uint8Array): LegacyFrame {
  let out: LegacyFrame = { kind: "unknown" };
  for (const f of pbFields(raw)) {
    const b = f.v as Uint8Array;
    switch (f.n) {
      case 1: if (f.w === 2) { let iv = Buffer.alloc(0), salt = Buffer.alloc(0), version: number | undefined; for (const h of pbFields(b)) { if (h.n === 1) iv = Buffer.from(h.v as Uint8Array); else if (h.n === 2) salt = Buffer.from(h.v as Uint8Array); else if (h.n === 3 && typeof h.v === "bigint") version = Number(h.v); } out = { kind: "header", iv, salt, version }; } break;
      case 2: if (f.w === 2) {
        let sql = ""; const params: SqlValue[] = [];
        for (const s of pbFields(b)) {
          if (s.n === 1) sql = pbString(s.v);
          else if (s.n === 2) {
            let v: SqlValue = null;
            for (const p of pbFields(s.v as Uint8Array)) {
              if (p.n === 1) v = pbString(p.v); else if (p.n === 2) { const n = BigInt.asIntN(64, p.v as bigint); v = n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n; }
              else if (p.n === 3) v = pbDouble(p.v); else if (p.n === 4) v = Buffer.from(p.v as Uint8Array); else if (p.n === 5) v = null;
            }
            params.push(v);
          }
        }
        out = { kind: "statement", sql, params };
      } break;
      case 3: if (f.w === 2) { let file = "", key = "", value: string | undefined; for (const s of pbFields(b)) { if (s.n === 1) file = pbString(s.v); else if (s.n === 2) key = pbString(s.v); else if (s.n === 3) value = pbString(s.v); } out = { kind: "preference", file, key, value }; } break;
      case 4: if (f.w === 2) { let rowId = 0, attachmentId = 0, length = 0; for (const s of pbFields(b)) { if (s.n === 1) rowId = pbNum(s.v); else if (s.n === 2) attachmentId = pbNum(s.v); else if (s.n === 3) length = pbNum(s.v); } out = { kind: "attachment", rowId, attachmentId, length }; } break;
      case 5: if (f.w === 2) { let version = 0; for (const s of pbFields(b)) if (s.n === 1) version = pbNum(s.v); out = { kind: "version", version }; } break;
      case 6: out = { kind: "end" }; break;
      case 7: if (f.w === 2) { let name = "", recipientId: string | undefined, length = 0; for (const s of pbFields(b)) { if (s.n === 1) name = pbString(s.v); else if (s.n === 2) length = pbNum(s.v); else if (s.n === 3) recipientId = pbString(s.v); } out = { kind: "avatar", name, recipientId, length }; } break;
      case 8: if (f.w === 2) { let rowId = 0, length = 0; for (const s of pbFields(b)) { if (s.n === 1) rowId = pbNum(s.v); else if (s.n === 2) length = pbNum(s.v); } out = { kind: "sticker", rowId, length }; } break;
      case 9: if (f.w === 2) {
        let key = "", value: string | number | boolean | undefined;
        for (const s of pbFields(b)) { if (s.n === 1) key = pbString(s.v); else if (s.n === 7) value = pbString(s.v); else if (s.n === 3) value = s.v === 1n; else if (s.n === 5 || s.n === 6) value = pbNum(s.v); else if (s.n === 4) value = pbDouble(s.v); }
        out = { kind: "keyvalue", key, value };
      } break;
    }
  }
  return out;
}

export interface ReadOptions {
  signal?: AbortSignal;
  /** Decide per attachment/avatar/sticker frame whether its bytes are needed. Not wanted blobs are still MAC-checked, then dropped. */
  wantBlob?: (f: LegacyFrame) => boolean;
  /** bytes consumed so far / file size */
  onProgress?: (pos: number, size: number) => void;
  /** Test hook: fewer KDF rounds are NOT accepted for real files; only the test encoder (which writes the same count) uses the default. */
  rounds?: number;
}
export interface Item { frame: LegacyFrame; blob?: Buffer }

/** Open a legacy backup and stream its frames. Throws BackupError with user-facing messages. Every MAC is verified before its content is yielded. */
export async function* readLegacyBackup(path: string, passphrase: string, o: ReadOptions = {}): AsyncGenerator<Item> {
  const fh = await open(path, "r");
  try {
    const st = await fh.stat(), r = new FileReader(fh, st.size);
    if (st.size < 40) throw new BackupError("not-a-backup", "This file is not a Signal backup (too small).");
    const hl = (await r.read(4)).readUInt32BE(0);
    if (hl < 20 || hl > 1 << 16) throw new BackupError("not-a-backup", "This is not a Signal Android backup file. Choose the signal-….backup file created by Signal > Settings > Chats > Chat backups.");
    let hdr: LegacyFrame;
    try { hdr = parseFrame(await r.read(hl)); } catch { throw new BackupError("not-a-backup", "This is not a Signal Android backup file."); }
    if (hdr.kind !== "header" || hdr.iv.length !== 16 || hdr.salt.length < 8) throw new BackupError("not-a-backup", "This is not a Signal Android backup file.");
    if (hdr.version) throw new BackupError("unsupported-version", `This backup uses a newer file layout (header version ${hdr.version}) that this importer does not know yet.`);
    if (!looksLikePassphrase(passphrase)) throw new BackupError("bad-passphrase", "Enter the 30-digit passphrase that Signal showed when the backup was created.");
    const backupKey = deriveBackupKey(passphrase, hdr.salt, o.rounds ?? KDF_ROUNDS);
    const { cipherKey, macKey } = deriveFrameKeys(backupKey); backupKey.fill(0);
    const iv = Buffer.from(hdr.iv); let counter = iv.readUInt32BE(0), first = true;
    const nextIv = () => { iv.writeUInt32BE(counter >>> 0, 0); counter = (counter + 1) >>> 0; return Buffer.from(iv); };
    const macOk = (m: Buffer, theirs: Buffer) => { const ours = m.subarray(0, 10); return ours.length === theirs.length && timingSafeEqual(ours, theirs); };
    const badMac = () => (first ? new BackupError("bad-passphrase", "Wrong passphrase, or this is not a Signal backup. Check the 30 digits and try again.") : new BackupError("corrupt", "This backup is damaged (a checksum failed), so nothing was imported."));
    o.onProgress?.(r.pos, r.size);
    for (let n = 0; ; n++) {
      if (o.signal?.aborted) throw new BackupError("cancelled", "Cancelled.");
      if (r.atEnd()) throw new BackupError("truncated", "This backup is incomplete (no end marker), so nothing was imported.");
      const len = (await r.read(4)).readUInt32BE(0);
      if (len < 10 || len > MAX_FRAME) throw badMac();
      const body = await r.read(len), ct = body.subarray(0, len - 10), theirs = body.subarray(len - 10);
      if (!macOk(createHmac("sha256", macKey).update(ct).digest(), theirs)) throw badMac();
      first = false;
      const dec = createDecipheriv("aes-256-ctr", cipherKey, nextIv());
      let frame: LegacyFrame;
      try { frame = parseFrame(Buffer.concat([dec.update(ct), dec.final()])); } catch { throw new BackupError("corrupt", "This backup contains an unreadable record, so nothing was imported."); }
      const length = frame.kind === "attachment" || frame.kind === "avatar" || frame.kind === "sticker" ? frame.length : 0;
      if (length > 0 || frame.kind === "attachment" || frame.kind === "avatar" || frame.kind === "sticker") {
        const aiv = nextIv(), d = createDecipheriv("aes-256-ctr", cipherKey, aiv), mac = createHmac("sha256", macKey).update(aiv);
        const want = !!o.wantBlob?.(frame) && length <= MAX_BLOB, keep: Buffer[] = [];
        for (let left = length; left > 0;) {
          const chunk = await r.read(Math.min(left, 1 << 20)); left -= chunk.length; mac.update(chunk);
          const plain = d.update(chunk); if (want) keep.push(plain);
          if (o.signal?.aborted) throw new BackupError("cancelled", "Cancelled.");
        }
        const theirMac = await r.read(10);
        if (!macOk(mac.digest(), theirMac)) throw badMac();
        if (want) keep.push(d.final());
        o.onProgress?.(r.pos, r.size);
        yield { frame, blob: want ? Buffer.concat(keep) : undefined };
        continue;
      }
      if (n % 64 === 0) o.onProgress?.(r.pos, r.size);
      yield { frame };
      if (frame.kind === "end") { o.onProgress?.(r.size, r.size); return; }
    }
  } finally { await fh.close().catch(() => {}); }
}
