// Sync side-database ("sync.db", or in memory): per-entity change log + sealed key/value state.
// It holds NO message content: each row is (entity key, local sequence number, HLC stamp, merge metadata, who delivered it).
// The sequence number is the local change feed: every local or remote change of an entity gets a fresh, strictly increasing `seq`,
// peers remember "applied your entries up to seq N", so replication is resumable, idempotent and needs no clock agreement.
// Secrets (device private key, group keys, peer list) live in `kv`, sealed AES-256-GCM with the same data key as the message store.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { accountOfKey } from "./crdt.js";

export interface Entity { key: string; seq: number; hlc: string; meta?: any; tomb: boolean; src: string; time?: string; acct: string }
const P = "s1:";

/** The sealed sync state could not be opened with the supplied data key (AES-GCM authentication failed): the data folder was sealed with a different key. Nothing is deleted or rewritten. */
export class WrongKeyError extends Error {
  readonly code = "WRONG_KEY";
  constructor(what = "sync state") { super(`the ${what} is sealed with a different data key than the one supplied`); this.name = "WrongKeyError"; }
}
/** True for a wrong-key failure from this package or from node:crypto's GCM tag check. */
export function isWrongKey(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "WRONG_KEY" || /unable to authenticate data/i.test(String((e as Error | null)?.message ?? ""));
}

export class Ledger {
  private db: DatabaseSync; private seq = 0; readonly id: string;
  constructor(file: string = ":memory:", private dataKey?: Uint8Array) {
    if (dataKey && dataKey.length !== 32) throw new Error("data key must be 32 bytes");
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") { this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL"); try { chmodSync(file, 0o600); } catch { /* best effort */ } }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_entities (key TEXT PRIMARY KEY, seq INTEGER NOT NULL, hlc TEXT NOT NULL, meta TEXT, tomb INTEGER NOT NULL DEFAULT 0, src TEXT NOT NULL DEFAULT '', time TEXT, acct TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS sync_by_seq ON sync_entities(seq);
      CREATE INDEX IF NOT EXISTS sync_by_acct ON sync_entities(acct);
      CREATE TABLE IF NOT EXISTS sync_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_blobs (ref TEXT PRIMARY KEY, hash TEXT NOT NULL, size INTEGER NOT NULL, acct TEXT NOT NULL, fetched INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS sync_blobs_hash ON sync_blobs(hash);
      CREATE TABLE IF NOT EXISTS sync_want (ref TEXT PRIMARY KEY, acct TEXT NOT NULL, chat TEXT NOT NULL, msg TEXT NOT NULL, att TEXT NOT NULL, size INTEGER NOT NULL, time TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, next INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS sync_want_time ON sync_want(time);`);
    this.seq = Number((this.db.prepare("SELECT COALESCE(MAX(seq),0) n FROM sync_entities").get() as { n: number }).n);
    try { this.id = this.kvGet<string>("ledgerId") ?? (() => { const i = randomBytes(8).toString("hex"); this.kvSet("ledgerId", i); return i; })(); }
    catch (e) { this.close(); throw e; } // do not leave the file handle open when the key is wrong
  }
  close() { try { this.db.close(); } catch { /* closed */ } }
  // ---- sealed kv ----
  private seal(s: string): string {
    if (!this.dataKey) return s;
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", this.dataKey, iv), ct = Buffer.concat([c.update(s, "utf8"), c.final()]);
    return P + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  }
  private open(s: string): string {
    if (!s.startsWith(P)) return s;
    if (!this.dataKey) throw new Error("sync state is sealed but no data key was supplied");
    const b = Buffer.from(s.slice(P.length), "base64"), d = createDecipheriv("aes-256-gcm", this.dataKey, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
    try { return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); }
    catch (e) { if (isWrongKey(e)) throw new WrongKeyError(); throw e; }
  }
  kvGet<T>(k: string): T | undefined { const r = this.db.prepare("SELECT v FROM sync_kv WHERE k=?").get(k) as { v: string } | undefined; return r ? JSON.parse(this.open(r.v)) as T : undefined; }
  kvSet(k: string, v: unknown) { this.db.prepare("INSERT OR REPLACE INTO sync_kv VALUES (?,?)").run(k, this.seal(JSON.stringify(v))); }
  kvDel(k: string) { this.db.prepare("DELETE FROM sync_kv WHERE k=?").run(k); }
  // ---- entities ----
  private row(r: any): Entity { return { key: r.key, seq: Number(r.seq), hlc: r.hlc, meta: r.meta ? JSON.parse(r.meta) : undefined, tomb: !!r.tomb, src: r.src, time: r.time ?? undefined, acct: r.acct }; }
  get(key: string): Entity | undefined { const r = this.db.prepare("SELECT * FROM sync_entities WHERE key=?").get(key); return r ? this.row(r) : undefined; }
  /** Insert or replace the entity with the next local sequence number. */
  put(e: { key: string; hlc: string; meta?: unknown; tomb?: boolean; src?: string; time?: string }): number {
    const seq = ++this.seq;
    this.db.prepare("INSERT OR REPLACE INTO sync_entities (key, seq, hlc, meta, tomb, src, time, acct) VALUES (?,?,?,?,?,?,?,?)")
      .run(e.key, seq, e.hlc, e.meta === undefined ? null : JSON.stringify(e.meta), e.tomb ? 1 : 0, e.src ?? "", e.time ?? null, accountOfKey(e.key));
    return seq;
  }
  /** Used by bootstrap: never overwrites an entity that already has a (real) stamp. */
  putIfAbsent(e: { key: string; hlc: string; meta?: unknown; time?: string }): boolean {
    if (this.db.prepare("SELECT 1 FROM sync_entities WHERE key=?").get(e.key)) return false;
    this.put(e); return true;
  }
  /** Entities after `cursor` in sequence order (at most `limit`). */
  since(cursor: number, limit: number): Entity[] { return (this.db.prepare("SELECT * FROM sync_entities WHERE seq>? ORDER BY seq LIMIT ?").all(cursor, limit) as unknown[]).map((r) => this.row(r)); }
  maxSeq() { return this.seq; }
  count() { return Number((this.db.prepare("SELECT COUNT(*) n FROM sync_entities").get() as { n: number }).n); }
  /** Local housekeeping (retention purge, account removal): drops rows WITHOUT recording a change, so nothing is propagated. */
  dropMessagesBefore(iso: string) { return Number(this.db.prepare("DELETE FROM sync_entities WHERE key LIKE 'msg\u0001%' AND time<?").run(iso).changes); }
  dropAccount(acct: string) { this.blobDropAccount(acct); return Number(this.db.prepare("DELETE FROM sync_entities WHERE acct=? AND key NOT LIKE 'ac\u0001%'").run(acct).changes); }
  // ---- media blob index (content hash of cached attachments) and the want list (attachments we lack) ----
  blobSet(ref: string, hash: string, size: number, acct: string, fetched = false) { this.db.prepare("INSERT OR REPLACE INTO sync_blobs VALUES (?,?,?,?,?)").run(ref, hash, size, acct, fetched ? 1 : 0); }
  blobGet(ref: string): { hash: string; size: number } | undefined { const r = this.db.prepare("SELECT hash, size FROM sync_blobs WHERE ref=?").get(ref) as any; return r ? { hash: r.hash, size: Number(r.size) } : undefined; }
  /** Any cached attachment with this content hash (deduplication: the bytes are copied, not fetched again). */
  blobByHash(hash: string): { ref: string; acct: string; size: number } | undefined { const r = this.db.prepare("SELECT ref, acct, size FROM sync_blobs WHERE hash=? LIMIT 1").get(hash) as any; return r ? { ref: r.ref, acct: r.acct, size: Number(r.size) } : undefined; }
  /** bytes fetched from peers by sync (the "max total" budget of the background policy) */
  blobTotal(): number { return Number((this.db.prepare("SELECT COALESCE(SUM(size),0) n FROM sync_blobs WHERE fetched=1").get() as { n: number }).n); }
  blobDropAccount(acct: string) { this.db.prepare("DELETE FROM sync_blobs WHERE acct=?").run(acct); this.db.prepare("DELETE FROM sync_want WHERE acct=?").run(acct); }
  wantAdd(w: { ref: string; acct: string; chat: string; msg: string; att: string; size: number; time: string }) { this.db.prepare("INSERT OR IGNORE INTO sync_want (ref, acct, chat, msg, att, size, time) VALUES (?,?,?,?,?,?,?)").run(w.ref, w.acct, w.chat, w.msg, w.att, w.size, w.time); }
  wantNext(now: number, limit: number): { ref: string; acct: string; chat: string; msg: string; att: string; size: number; time: string; tries: number }[] {
    return (this.db.prepare("SELECT * FROM sync_want WHERE next<=? ORDER BY time DESC LIMIT ?").all(now, limit) as any[]).map((r) => ({ ref: r.ref, acct: r.acct, chat: r.chat, msg: r.msg, att: r.att, size: Number(r.size), time: r.time, tries: Number(r.tries) }));
  }
  wantDone(ref: string) { this.db.prepare("DELETE FROM sync_want WHERE ref=?").run(ref); }
  wantRetry(ref: string, next: number) { this.db.prepare("UPDATE sync_want SET tries=tries+1, next=? WHERE ref=?").run(next, ref); }
  wantCount(): number { return Number((this.db.prepare("SELECT COUNT(*) n FROM sync_want").get() as { n: number }).n); }
  tx<T>(f: () => T): T {
    this.db.exec("BEGIN"); try { const r = f(); this.db.exec("COMMIT"); return r; } catch (e) { try { this.db.exec("ROLLBACK"); } catch { /* none */ } throw e; }
  }
}
