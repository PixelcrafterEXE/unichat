// Lazy media sync. The ledger carries messages (with attachment metadata) but not the attachment bytes. Bytes move by CONTENT HASH:
//   want list   an attachment a replicated message mentions and this device lacks (sync_want), filled when messages arrive
//   on demand   the user opens it: Hub "attachment" -> fetchMedia (any policy, any size up to HARD_MAX)
//   background  a per-device policy (off | wifi | all) with max file size and max total drains the want list newest first
// A transfer asks a peer {chat,msg,att} -> {hash,size,mime,name} (peer must hold it and sync mode of the account must not be "none" on BOTH sides),
// reuses any local copy with the same hash (dedup), otherwise pulls 192 KiB ranges. Received ranges are kept SEALED on disk (AES-GCM with this
// device's key) so an interrupted transfer resumes at the byte where it stopped; at the end the SHA-256 is checked before the bytes enter the
// Hub's media cache (itself sealed with the data key). A wrong hash discards the part file.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ledger } from "./ledger.js";

export const HARD_MAX = 256 * 1024 * 1024, RANGE = 192 * 1024;
export interface MediaPolicy { mode: "off" | "wifi" | "all"; maxFileMB: number; maxTotalMB: number }
export const DEFAULT_POLICY: MediaPolicy = { mode: "off", maxFileMB: 25, maxTotalMB: 2048 };
export function cleanPolicy(p: any, cur: MediaPolicy = DEFAULT_POLICY): MediaPolicy {
  const num = (v: unknown, d: number, lo: number, hi: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  return { mode: ["off", "wifi", "all"].includes(p?.mode) ? p.mode : cur.mode, maxFileMB: num(p?.maxFileMB ?? cur.maxFileMB, cur.maxFileMB, 1, 256), maxTotalMB: num(p?.maxTotalMB ?? cur.maxTotalMB, cur.maxTotalMB, 16, 1_000_000) };
}
export const refOf = (chat: string, msg: string, att: string) => `${chat}|${msg}|${att}`;
export const acctOfChat = (chat: string) => (chat.startsWith("mesh:") || chat.startsWith("merge:") || chat.startsWith("folder:") ? "" : chat.split(":")[0]);
export interface Blob { data: Uint8Array; mime: string; name?: string }
export interface MediaApi { get(acct: string, key: string): Blob | undefined; put(acct: string, key: string, v: Blob): void; has(acct: string, key: string): boolean }
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Sealed, append-only part file: records [u32 len][iv 12][tag 16][ciphertext]. */
export class PartFile {
  constructor(private file: string, private key: Buffer) {}
  size(): number {
    if (!existsSync(this.file)) return 0;
    let off = 0, n = 0; const b = readFileSync(this.file);
    while (off + 4 <= b.length) { const len = b.readUInt32BE(off); if (off + 4 + 28 + len > b.length) break; n += len; off += 4 + 28 + len; }
    if (off !== b.length) rmSync(this.file, { force: true }), appendFileSync(this.file, b.subarray(0, off), { mode: 0o600 }); // drop a torn tail record
    return n;
  }
  append(chunk: Buffer) {
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", this.key, iv), ct = Buffer.concat([c.update(chunk), c.final()]), h = Buffer.alloc(4); h.writeUInt32BE(chunk.length);
    appendFileSync(this.file, Buffer.concat([h, iv, c.getAuthTag(), ct]), { mode: 0o600 });
  }
  readAll(): Buffer {
    const b = readFileSync(this.file), parts: Buffer[] = []; let off = 0;
    while (off + 4 <= b.length) {
      const len = b.readUInt32BE(off), iv = b.subarray(off + 4, off + 16), tag = b.subarray(off + 16, off + 32), ct = b.subarray(off + 32, off + 32 + len);
      const d = createDecipheriv("aes-256-gcm", this.key, iv); d.setAuthTag(tag); parts.push(Buffer.concat([d.update(ct), d.final()])); off += 32 + len;
    }
    return Buffer.concat(parts);
  }
  remove() { rmSync(this.file, { force: true }); }
}

export interface BlobDeps {
  ledger: Ledger; media: MediaApi; dir: string; sealKey: Buffer;
  modeNone(acct: string): boolean;
  /** run an RPC against the given peer */
  ask(peer: string, method: string, p: unknown, ms?: number): Promise<any>;
  peers(): string[];
  progress(p: BlobProgress | null): void;
}
export interface BlobProgress { ref: string; name?: string; got: number; total: number; peer: string }
export class Blobs {
  private reading?: { hash: string; at: number; data: Buffer };
  private inflight = new Map<string, Promise<Blob | undefined>>();
  stats = { fetched: 0, fetchedBytes: 0, deduped: 0, failed: 0, served: 0, servedBytes: 0 };
  constructor(private d: BlobDeps) { mkdirSync(join(d.dir, "blobs"), { recursive: true, mode: 0o700 }); }

  // ---------------------------------------------------------------- serving (the peer asks us)
  /** {hash,size,mime,name} of an attachment we hold, or null. The hash is computed once and remembered. */
  query(p: { chat: string; msg: string; att: string }): { hash: string; size: number; mime: string; name?: string } | null {
    const acct = acctOfChat(String(p?.chat ?? "")); if (!acct || this.d.modeNone(acct)) return null;
    const ref = refOf(p.chat, p.msg, p.att), b = this.d.media.get(acct, ref); if (!b) return null;
    let e = this.d.ledger.blobGet(ref);
    if (!e || e.size !== b.data.length) { e = { hash: sha(b.data), size: b.data.length }; this.d.ledger.blobSet(ref, e.hash, e.size, acct); }
    return { hash: e.hash, size: e.size, mime: b.mime, ...(b.name ? { name: b.name } : {}) };
  }
  range(p: { chat: string; msg: string; att: string; hash: string; off: number; len: number }): { d: string } | null {
    const acct = acctOfChat(String(p?.chat ?? "")); if (!acct || this.d.modeNone(acct)) return null;
    const len = Math.min(RANGE, Math.max(1, Math.floor(Number(p.len) || RANGE))), off = Math.max(0, Math.floor(Number(p.off) || 0));
    let r = this.reading; // one decrypted copy kept briefly: a transfer reads it in many ranges
    if (!r || r.hash !== p.hash || Date.now() - r.at > 30_000) {
      const b = this.d.media.get(acct, refOf(p.chat, p.msg, p.att)); if (!b || sha(b.data) !== p.hash) return null;
      r = this.reading = { hash: p.hash, at: Date.now(), data: Buffer.from(b.data) };
    }
    r.at = Date.now(); const out = r.data.subarray(off, off + len);
    this.stats.served++; this.stats.servedBytes += out.length;
    return { d: out.toString("base64") };
  }

  // ---------------------------------------------------------------- fetching (we ask peers)
  /** Make sure the attachment is in the local media cache; resolves the blob or undefined when no peer has it / it is not allowed. */
  fetch(ref: { chat: string; msg: string; att: string }, o: { maxBytes?: number } = {}): Promise<Blob | undefined> {
    const k = refOf(ref.chat, ref.msg, ref.att), cur = this.inflight.get(k); if (cur) return cur;
    const p = this.doFetch(ref, o.maxBytes ?? HARD_MAX).finally(() => this.inflight.delete(k)); this.inflight.set(k, p); return p;
  }
  private async doFetch(ref: { chat: string; msg: string; att: string }, max: number): Promise<Blob | undefined> {
    const acct = acctOfChat(ref.chat), key = refOf(ref.chat, ref.msg, ref.att);
    if (!acct || this.d.modeNone(acct)) return undefined;
    const have = this.d.media.get(acct, key); if (have) return have;
    for (const peer of this.d.peers()) {
      let meta: any;
      try { meta = await this.d.ask(peer, "blob.q", ref, 15_000); } catch { continue; }
      if (!meta || typeof meta.hash !== "string" || !/^[0-9a-f]{64}$/.test(meta.hash) || !Number.isInteger(meta.size) || meta.size < 0) continue;
      if (meta.size > max) { this.stats.failed++; continue; }
      // dedup: the same bytes already cached under another attachment (forwarded files, re-sent pictures)
      const dup = this.d.ledger.blobByHash(meta.hash);
      if (dup) { const b = this.d.media.get(dup.acct, dup.ref); if (b && sha(b.data) === meta.hash) { const out = { data: b.data, mime: String(meta.mime ?? b.mime), name: meta.name ?? b.name }; this.d.media.put(acct, key, out); this.d.ledger.blobSet(key, meta.hash, meta.size, acct, false); this.stats.deduped++; return out; } }
      const part = new PartFile(join(this.d.dir, "blobs", meta.hash + ".part"), this.d.sealKey);
      try {
        let got = part.size(); if (got > meta.size) { part.remove(); got = 0; }
        while (got < meta.size) {
          this.d.progress({ ref: key, name: meta.name, got, total: meta.size, peer });
          const r = await this.d.ask(peer, "blob.get", { ...ref, hash: meta.hash, off: got, len: RANGE }, 30_000);
          const buf = r?.d ? Buffer.from(String(r.d), "base64") : Buffer.alloc(0);
          if (!buf.length) throw new Error("the other device stopped sending");
          if (got + buf.length > meta.size) throw new Error("the other device sent too much");
          part.append(buf); got += buf.length;
        }
        const data = got === 0 ? Buffer.alloc(0) : part.readAll();
        if (data.length !== meta.size || sha(data) !== meta.hash) { part.remove(); throw new Error("the received file did not match its hash"); }
        const out = { data: new Uint8Array(data), mime: String(meta.mime ?? "application/octet-stream").slice(0, 120), ...(meta.name ? { name: String(meta.name).slice(0, 255) } : {}) };
        this.d.media.put(acct, key, out); this.d.ledger.blobSet(key, meta.hash, meta.size, acct, true);
        part.remove(); this.stats.fetched++; this.stats.fetchedBytes += meta.size; this.d.progress(null);
        return out;
      } catch { this.stats.failed++; this.d.progress(null); /* the part file stays: the next attempt resumes */ }
    }
    return undefined;
  }
  /** Delete stale part files (older than a week). */
  sweep() { try { const dir = join(this.d.dir, "blobs"); for (const f of readdirSync(dir)) { const p = join(dir, f); if (Date.now() - statSync(p).mtimeMs > 7 * 864e5) rmSync(p, { force: true }); } } catch { /* ignore */ } }
}
