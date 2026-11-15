// Full-text search backend on SQLite FTS5, in an IN-MEMORY database (":memory:").
//
// Security model (same as the plain in-memory index in search.ts): message payloads are sealed (AES-GCM) in the archive, so FTS5 over
// the archive itself would leak plaintext. This index therefore lives ONLY in RAM: it is rebuilt from the sealed store at every start
// (streamed page by page with progress, yielding to the event loop) and kept current by the Hub's store wrapper. Nothing is ever written
// to disk: no file database, journal off, temp_store=MEMORY (no sort spill files), no persisted FTS shadow tables.
//
// Tokenizer: unicode61 with remove_diacritics 2 ("cafe" finds "Café"), prefix indexes for 2 and 3 characters. Text is indexed per
// message: text, attachment file names, poll question/options, location, shared contacts and card text (store.messageSearchRaw).
// Chat and contact NAMES change often, so they are matched against the Hub's chat list at query time (hub-extras.ts), not indexed here.
// Unavailable (older Android nodejs-mobile, sql.js builds) -> createSearchIndex() returns the plain scanning SearchIndex, same interface.
import type { Message } from "./model.js";
import type { Store } from "./store.js";
import { messageSearchRaw } from "./store.js";
import { SearchIndex, effRange, finish, type RawHit, type SearchOptions, type SearchOutcome, type SearchRequest } from "./search.js";
import { fold, hasMask, messageFlags, textMatcher, type ParsedQuery, type Unit } from "./searchquery.js";

type Db = { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint }; get(...a: unknown[]): any; all(...a: unknown[]): any[] } };

function openMemoryDb(): Db | undefined {
  try {
    const mod = (process as any).getBuiltinModule?.("node:sqlite");
    if (!mod?.DatabaseSync) return undefined;
    const db: Db = new mod.DatabaseSync(":memory:");
    db.exec("PRAGMA temp_store=MEMORY; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;");
    db.exec("CREATE VIRTUAL TABLE _probe USING fts5(a, tokenize='unicode61 remove_diacritics 2'); DROP TABLE _probe;");
    return db;
  } catch { return undefined; }
}

const q = (u: Unit) => `"${u.tokens.join(" ")}"${u.prefix ? "*" : ""}`;
/** FTS5 MATCH expression of the text part (all tokens are letters/digits, so quoting is injection-safe). */
export function ftsExpression(pq: ParsedQuery): string {
  const pos = pq.units.map(q).join(" AND ");
  return pq.not.length ? `(${pos}) NOT (${pq.not.map(q).join(" OR ")})` : pos;
}

export class FtsIndex extends SearchIndex {
  private db: Db;
  private n = 0; private charTotal = 0; private evictedMs = 0;
  private st!: { find: ReturnType<Db["prepare"]>; insM: ReturnType<Db["prepare"]>; updM: ReturnType<Db["prepare"]>; insF: ReturnType<Db["prepare"]>; delF: ReturnType<Db["prepare"]>; delM: ReturnType<Db["prepare"]> };
  constructor(store: Store, o: SearchOptions, db: Db) {
    super(store, { maxEntries: 1_500_000, maxChars: 400_000_000, maxPerMessage: 2000, ...o });
    this.db = db; this.create();
  }
  private create() {
    this.db.exec(`DROP TABLE IF EXISTS f; DROP TABLE IF EXISTS m;
      CREATE TABLE m(rid INTEGER PRIMARY KEY, chatId TEXT NOT NULL, id TEXT NOT NULL, accountId TEXT NOT NULL, ms INTEGER NOT NULL, fromMe INTEGER NOT NULL, sender TEXT NOT NULL, flags INTEGER NOT NULL, len INTEGER NOT NULL);
      CREATE UNIQUE INDEX m_k ON m(chatId, id); CREATE INDEX m_ms ON m(ms); CREATE INDEX m_acc ON m(accountId);
      CREATE VIRTUAL TABLE f USING fts5(body, tokenize='unicode61 remove_diacritics 2', prefix='2 3');`);
    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS sel(c TEXT PRIMARY KEY) WITHOUT ROWID");
    this.st = {
      find: this.db.prepare("SELECT rid, len FROM m WHERE chatId=? AND id=?"),
      insM: this.db.prepare("INSERT INTO m(chatId,id,accountId,ms,fromMe,sender,flags,len) VALUES(?,?,?,?,?,?,?,?)"),
      updM: this.db.prepare("UPDATE m SET accountId=?, ms=?, fromMe=?, sender=?, flags=?, len=? WHERE rid=?"),
      insF: this.db.prepare("INSERT INTO f(rowid, body) VALUES(?,?)"),
      delF: this.db.prepare("DELETE FROM f WHERE rowid=?"),
      delM: this.db.prepare("DELETE FROM m WHERE rid=?"),
    };
  }
  get engine(): "fts5" { return "fts5"; }
  get size() { return this.n; }
  protected reset() { this.create(); this.n = 0; this.charTotal = 0; this.evictedMs = 0; }
  protected evicted() { return this.evictedMs; }
  protected beginPage() { this.paging = true; this.db.exec("BEGIN"); }
  protected endPage() { this.db.exec("COMMIT"); this.paging = false; this.boundFts(); }

  upsert(m: Message) {
    const old = this.st.find.get(m.chatId, m.id);
    if (m.deleted || m.system) { if (old) this.drop(old.rid, old.len); return; }
    const body = messageSearchRaw(m).slice(0, this.o.maxPerMessage);
    if (!body.trim()) { if (old) this.drop(old.rid, old.len); return; }
    const acc = m.accountId ?? m.chatId.split(":")[0], ms = SearchIndex.ms(m.time), sender = fold(m.sender ?? "");
    if (old) {
      this.st.updM.run(acc, ms, m.fromMe ? 1 : 0, sender, messageFlags(m), body.length, old.rid);
      this.st.delF.run(old.rid); this.st.insF.run(old.rid, body); this.charTotal += body.length - old.len;
    } else {
      const rid = this.st.insM.run(m.chatId, m.id, acc, ms, m.fromMe ? 1 : 0, sender, messageFlags(m), body.length).lastInsertRowid;
      this.st.insF.run(rid, body); this.n++; this.charTotal += body.length;
    }
    if (!this.paging) this.boundFts();
  }
  private paging = false;
  private drop(rid: number | bigint, len: number) { this.st.delF.run(rid); this.st.delM.run(rid); this.n--; this.charTotal -= len; }
  remove(chatId: string, id: string) { const o = this.st.find.get(chatId, id); if (o) this.drop(o.rid, o.len); }
  private purge(where: string, arg: string | number) {
    const rows = this.db.prepare(`SELECT rid, len FROM m WHERE ${where}`).all(arg);
    this.db.exec("BEGIN"); try { for (const r of rows) this.drop(r.rid, r.len); } finally { this.db.exec("COMMIT"); }
  }
  removeAccount(accountId: string) { this.purge("accountId=?", accountId); }
  removeBefore(iso: string) { this.purge("ms<?", SearchIndex.ms(iso)); }

  /** Over the bound: drop the oldest ~10 %. */
  private boundFts() {
    if (this.n <= this.o.maxEntries && this.charTotal <= this.o.maxChars) return;
    const cut = Math.max(1, Math.ceil(this.n * 0.1));
    const rows = this.db.prepare("SELECT rid, len, ms FROM m ORDER BY ms LIMIT ?").all(cut);
    this.db.exec("BEGIN"); try { for (const r of rows) { this.drop(r.rid, r.len); this.evictedMs = Math.max(this.evictedMs, r.ms); } } finally { this.db.exec("COMMIT"); }
  }

  search(req: SearchRequest): SearchOutcome {
    const { pq } = req, mask = hasMask(pq), now = Date.now(), { since, until } = effRange(req);
    const where: string[] = [], args: unknown[] = [];
    const textual = pq.units.length > 0;
    if (textual) { where.push("f MATCH ?"); args.push(ftsExpression(pq)); }
    if (since !== undefined) { where.push("m.ms>=?"); args.push(since); }
    if (until !== undefined) { where.push("m.ms<?"); args.push(until); }
    if (mask) { where.push("(m.flags & ?)=?"); args.push(mask, mask); }
    if (pq.from.length) { where.push("(" + pq.from.map((f) => (f === "me" ? "m.fromMe=1" : "instr(m.sender,?)>0")).join(" OR ") + ")"); for (const f of pq.from) if (f !== "me") args.push(f); }
    if (req.accountIds) { const l = [...req.accountIds]; where.push(`m.accountId IN (${l.map(() => "?").join(",") || "NULL"})`); args.push(...l); }
    if (req.chatIds) {
      this.db.exec("DELETE FROM sel");
      const ins = this.db.prepare("INSERT OR IGNORE INTO sel(c) VALUES(?)");
      this.db.exec("BEGIN"); try { for (const c of req.chatIds) ins.run(c); } finally { this.db.exec("COMMIT"); }
      where.push("m.chatId IN (SELECT c FROM sel)");
    }
    const from = textual ? "f JOIN m ON m.rid=f.rowid" : "m", w = where.length ? "WHERE " + where.join(" AND ") : "";
    const per = this.db.prepare(`SELECT m.chatId AS c, COUNT(*) AS n FROM ${from} ${w} GROUP BY m.chatId`).all(...args);
    const perChat = new Map<string, number>(); let total = 0;
    for (const r of per) { perChat.set(r.c, Number(r.n)); total += Number(r.n); }
    // rank: bm25 (smaller = better) pulled up by recency (up to 3 points for today, half for a month ago)
    const rank = textual ? "bm25(f) - 3.0/(1.0+MAX(0,?-m.ms)/2592000000.0)" : "0";
    const rows = total ? this.db.prepare(`SELECT m.chatId, m.id, m.accountId, m.ms, m.fromMe, ${rank} AS r FROM ${from} ${w} ORDER BY r, m.ms DESC, m.chatId, m.id LIMIT ? OFFSET ?`)
      .all(...(textual ? [now] : []), ...args, req.limit, req.offset) : [];
    const hits: RawHit[] = rows.map((r) => ({ chatId: r.chatId, id: r.id, accountId: r.accountId, ms: Number(r.ms), score: textual ? -Number(r.r) : 0, fromMe: !!r.fromMe }));
    let deep = false;
    if (req.deep && this.evicted() > 0) {
      // older than the index covers: scan the sealed archive (slow), merge the extra matches after the indexed ones
      const extra: RawHit[] = [], match = textMatcher(pq);
      const senderOk = (s: string, me: boolean) => !pq.from.length || pq.from.some((f) => (f === "me" ? me : s.includes(f)));
      deep = this.deepScan(req, (m) => {
        if (this.st.find.get(m.chatId, m.id)) return; // still indexed
        const ms = SearchIndex.ms(m.time), text = fold(messageSearchRaw(m).slice(0, this.o.maxPerMessage));
        if ((since !== undefined && ms < since) || (until !== undefined && ms >= until) || (mask && (messageFlags(m) & mask) !== mask) || !senderOk(fold(m.sender ?? ""), !!m.fromMe)) return;
        if ((req.accountIds && !req.accountIds.has(m.accountId ?? m.chatId.split(":")[0])) || (req.chatIds && !req.chatIds.has(m.chatId)) || !match(text)) return;
        extra.push({ chatId: m.chatId, id: m.id, accountId: m.accountId ?? m.chatId.split(":")[0], ms, score: 0, fromMe: !!m.fromMe });
      }, new Set());
      if (extra.length) {
        const r = finish(extra, { ...req, offset: 0, limit: 1e9 }, true);
        for (const e of r.hits) perChat.set(e.chatId, (perChat.get(e.chatId) ?? 0) + 1);
        total += r.total;
        const room = Math.max(0, req.limit - hits.length), skip = Math.max(0, req.offset - (total - r.total));
        hits.push(...r.hits.slice(skip, skip + room));
      }
    }
    return { hits, total, perChat, deep };
  }
}

/** FTS5 when this runtime has it (and `backend` allows), else the plain in-memory scan. */
export function createSearchIndex(store: Store, o: SearchOptions = {}): SearchIndex {
  if (o.backend !== "memory") {
    const db = openMemoryDb();
    if (db) return new FtsIndex(store, o, db);
    if (o.backend === "fts") throw new Error("SQLite FTS5 is not available in this runtime.");
  }
  return new SearchIndex(store, o);
}
