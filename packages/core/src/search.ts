// Global search over the local archive.
//
// Payloads in the SQLite archive are sealed (AES-GCM), so the database itself cannot search them: FTS5 over plaintext would leak the
// content the encryption protects. Instead the Hub keeps an IN-MEMORY index of lower-cased search text per message:
//   * filled in the background at startup (streamed page by page from Store.scanMessages, yielding to the event loop between pages),
//   * kept current by the Hub from every store write (live messages, edits, deletions, history top-ups, own sends, imports, retention),
//   * BOUNDED: at most `maxEntries` messages / `maxChars` characters in total and `maxPerMessage` characters per message. When the
//     bound is hit the OLDEST messages are dropped from the index (result.index.truncated / coveredFrom tell the UI; `deep: true` scans
//     the sealed store for the older part, slower but complete, within a time budget).
// Tradeoff: ~1 byte per ASCII character of RAM for the index (typically 10-50 MB for hundreds of thousands of messages) in exchange for
// millisecond searches without ever writing plaintext to disk. Long messages are indexed by their first `maxPerMessage` characters.
import { messageSearchRaw, type Store } from "./store.js";
import type { ChatKind, Message } from "./model.js";
import { fold, hasMask, messageFlags, snippetFor, textMatcher, type ParsedQuery } from "./searchquery.js";

export interface SearchOptions { maxEntries?: number; maxChars?: number; maxPerMessage?: number; pageSize?: number; /** "auto" (default): SQLite FTS5 in memory when node:sqlite has it, else the plain in-memory scan. */ backend?: "auto" | "fts" | "memory" }
interface Entry { chatId: string; id: string; accountId: string; ms: number; text: string; fromMe: boolean; sender: string; flags: number }
/** What a backend gets: the parsed query plus the chat-level restrictions the Hub resolved from its chat list. */
export interface SearchRequest { pq: ParsedQuery; chatIds?: Set<string>; accountIds?: Set<string>; since?: number; until?: number; limit: number; offset: number; deep?: { budgetMs: number } }
export interface RawHit { chatId: string; id: string; accountId: string; ms: number; score: number; fromMe: boolean }
export interface SearchOutcome { hits: RawHit[]; total: number; perChat: Map<string, number>; deep: boolean }

export interface SearchQuery {
  query: string;
  /** Hits per page (default 40, max 200). */
  limit?: number;
  /** Opaque cursor: the `next` value of the previous page. */
  before?: string;
  accountIds?: string[];
  /** Only these chats (a merged chat id expands to its members): "search in this chat". */
  chatIds?: string[];
  /** Messenger names (ProviderInfo.name), e.g. ["whatsapp"]. */
  providers?: string[];
  kinds?: ChatKind[];
  /** ISO times, inclusive. */
  since?: string; until?: string;
  /** Also scan the sealed archive for messages older than the in-memory index covers (slow, time-boxed). */
  deep?: boolean;
}
export interface SearchHit {
  chatId: string;        // the real chat (messages keep their own chat id even inside a merged chat)
  messageId: string; accountId: string; time: string; sender: string; fromMe: boolean;
  snippet: string;
  /** [start, end) offsets into `snippet` of every matched term. */
  ranges: [number, number][];
  /** The chat holding this message is a read-only archive (signed-out account). */
  offline?: "signed-out" | "needs-login";
  score: number;
}
export interface SearchGroup {
  /** The chat as the UI lists it: a merged chat's id for members of a merge. */
  chatId: string; name: string; kind?: ChatKind; provider: string; accountId: string; offline?: "signed-out" | "needs-login";
  /** Messengers of the chat (more than one for a merged chat). */
  providers: string[];
  /** Matches of this chat in the whole result (not only on this page). */
  total: number;
  hits: SearchHit[];
}
export interface SearchResult {
  query: string; groups: SearchGroup[];
  /** Number of matching messages overall (all pages). */
  total: number;
  /** Cursor for the next page, absent on the last one. */
  next?: string;
  index: { ready: boolean; messages: number; truncated: boolean; coveredFrom?: string; deep?: boolean; engine?: "fts5" | "memory" };
  tookMs: number;
  /** The parsed query (operators as the UI shows them as chips) and anything in it that could not be used. */
  parsed?: { terms: string[]; filters: { op: string; value: string }[]; errors: string[] };
  /** Chats / contacts whose NAME matches the words of the query (only on the first page). */
  chats?: { chatId: string; name: string; kind?: ChatKind; provider: string; accountId: string; providers: string[] }[];
}

export const searchTerms = (q: string) => [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);

/** ~130 characters around the first match with the offsets of every matched term inside the snippet. */
export function makeSnippet(raw: string, terms: string[]): { snippet: string; ranges: [number, number][] } {
  const flat = raw.replace(/\s/g, " ");
  const low = flat.toLowerCase();
  const sameLen = low.length === flat.length;
  let first = -1;
  for (const t of terms) { const i = sameLen ? low.indexOf(t) : flat.search(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")); if (i >= 0 && (first < 0 || i < first)) first = i; }
  const start = Math.max(0, (first < 0 ? 0 : first) - 40), end = Math.min(flat.length, start + 130);
  const body = flat.slice(start, end), lowBody = body.toLowerCase();
  const pre = start > 0 ? "…" : "", snippet = pre + body + (end < flat.length ? "…" : "");
  const ranges: [number, number][] = [];
  if (lowBody.length === body.length) for (const t of terms) { for (let i = lowBody.indexOf(t); i >= 0; i = lowBody.indexOf(t, i + t.length)) ranges.push([pre.length + i, pre.length + i + t.length]); }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) { const l = merged.at(-1); if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else merged.push([r[0], r[1]]); }
  return { snippet, ranges: merged };
}

export class SearchIndex {
  private entries = new Map<string, Entry>();
  private chars = 0;
  private evictedUpTo = 0;       // newest ms dropped by the bound: everything newer than this is certainly indexed
  private _ready = false;
  private readyP: Promise<void> = Promise.resolve();
  private started = false;
  private gen = 0;               // bumped by rebuild(): a stale fill stops
  protected o: Required<SearchOptions>;
  /** Progress of the (re)fill: number of messages indexed so far; `done` on the last call. */
  onProgress?: (indexed: number, done: boolean) => void;
  protected indexed = 0;
  constructor(protected store: Store, o: SearchOptions = {}) { this.o = { maxEntries: 500_000, maxChars: 48_000_000, maxPerMessage: 1000, pageSize: 300, backend: "auto", ...o }; }

  get ready() { return this._ready; }
  get size(): number { return this.entries.size; }
  get engine(): "fts5" | "memory" { return "memory"; }
  waitReady(ms: number): Promise<boolean> { return Promise.race([this.readyP.then(() => true), new Promise<boolean>((r) => { const t = setTimeout(() => r(false), ms); t.unref?.(); })]); }

  protected key = (chatId: string, id: string) => chatId + "\u0000" + id;
  protected static ms = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

  /** Add or refresh one message (a deleted message and one without searchable text leave the index). */
  upsert(m: Message) {
    const k = this.key(m.chatId, m.id), old = this.entries.get(k);
    if (old) { this.chars -= old.text.length; this.entries.delete(k); }
    if (m.deleted || m.system) return;
    const text = fold(messageSearchRaw(m).slice(0, this.o.maxPerMessage));
    if (!text.trim()) return;
    this.entries.set(k, { chatId: m.chatId, id: m.id, accountId: m.accountId ?? m.chatId.split(":")[0], ms: SearchIndex.ms(m.time), text, fromMe: !!m.fromMe, sender: fold(m.sender ?? ""), flags: messageFlags(m) });
    this.chars += text.length;
    this.bound();
  }
  remove(chatId: string, id: string) { const k = this.key(chatId, id), e = this.entries.get(k); if (e) { this.chars -= e.text.length; this.entries.delete(k); } }
  removeAccount(accountId: string) { for (const [k, e] of this.entries) if (e.accountId === accountId) { this.chars -= e.text.length; this.entries.delete(k); } }
  removeBefore(iso: string) { const t = SearchIndex.ms(iso); for (const [k, e] of this.entries) if (e.ms < t) { this.chars -= e.text.length; this.entries.delete(k); } }

  private bound() {
    if (this.entries.size <= this.o.maxEntries && this.chars <= this.o.maxChars) return;
    // drop the oldest ~10 % (amortised: one sort per ~10 % of growth)
    const all = [...this.entries.values()].sort((a, b) => a.ms - b.ms);
    const drop = Math.max(1, Math.ceil(all.length * 0.1));
    for (const e of all.slice(0, drop)) { this.entries.delete(this.key(e.chatId, e.id)); this.chars -= e.text.length; this.evictedUpTo = Math.max(this.evictedUpTo, e.ms); }
  }

  /** (Re)fill from the store in the background. Resolves when done; cheap to call again (e.g. after a backup import). */
  /** Start filling if nobody did yet (a Hub that was never init()ed, e.g. in tests). */
  ensure() { if (!this.started) void this.rebuild(); }
  rebuild(): Promise<void> {
    this.started = true;
    const my = ++this.gen;
    this.reset(); this._ready = false; this.indexed = 0;
    const p = this.fill(my).catch((e) => { console.error("search index failed:", (e as Error)?.name); }).then(() => { if (my === this.gen) { this._ready = true; this.onProgress?.(this.indexed, true); } });
    this.readyP = p; return p;
  }
  /** Forget everything (before a refill). */
  protected reset() { this.entries = new Map(); this.chars = 0; this.evictedUpTo = 0; }
  protected evicted() { return this.evictedUpTo; }
  /** Called for every message while filling (a subclass batches its writes per page). */
  protected beginPage() {} protected endPage() {}
  private async fill(my: number) {
    const yieldNow = () => new Promise<void>((r) => setImmediate(r));
    if (this.store.scanMessages) {
      let after: { chatId: string; id: string } | undefined;
      for (;;) {
        if (my !== this.gen) return;
        const page = this.store.scanMessages({ after, limit: this.o.pageSize });
        if (!page.length) return;
        this.beginPage(); try { for (const m of page) this.upsert(m); } finally { this.endPage(); }
        this.indexed += page.length; this.onProgress?.(this.indexed, false);
        const last = page[page.length - 1]; after = { chatId: last.chatId, id: last.id };
        if (page.length < this.o.pageSize) return;
        await yieldNow();
      }
    }
    let n = 0;
    for (const r of this.store.exportRecords()) {
      if (my !== this.gen) return;
      if (r.t === "message") { this.upsert(r.v); this.indexed++; }
      if (++n % 2000 === 0) { this.onProgress?.(this.indexed, false); await yieldNow(); }
    }
  }

  stats() { return { messages: this.size, truncated: this.evicted() > 0, coveredFrom: this.evicted() > 0 ? new Date(this.evicted()).toISOString() : undefined, engine: this.engine }; }

  /**
   * All matches of a parsed query by scanning the in-memory entries (the fallback backend; FtsIndex overrides this with SQLite FTS5).
   * The score favours whole phrases, word starts and recent messages; ties go to the newer message.
   */
  search(req: SearchRequest): SearchOutcome {
    const { pq } = req, match = textMatcher(pq), mask = hasMask(pq), now = Date.now(), { since, until } = effRange(req);
    const lows = pq.units.map((u) => u.tokens.join(" "));
    const out: RawHit[] = [];
    const score = (text: string, ms: number) => {
      let s = 10;
      for (const [i, u] of pq.units.entries()) { if (u.tokens.length > 1) s += 3; const j = text.indexOf(lows[i]); if (j >= 0 && !/[\p{L}\p{N}]/u.test(text[j - 1] ?? " ")) s += 2; if (j === 0) s += 1; }
      return s + 3 / (1 + Math.max(0, now - ms) / (30 * 864e5));
    };
    const senderOk = (sender: string, fromMe: boolean) => !pq.from.length || pq.from.some((f) => (f === "me" ? fromMe : sender.includes(f)));
    const consider = (e: Entry) => {
      if (since !== undefined && e.ms < since) return;
      if (until !== undefined && e.ms >= until) return;
      if (mask && (e.flags & mask) !== mask) return;
      if (!senderOk(e.sender, e.fromMe)) return;
      if (req.accountIds && !req.accountIds.has(e.accountId)) return;
      if (req.chatIds && !req.chatIds.has(e.chatId)) return;
      if (!match(e.text)) return;
      out.push({ chatId: e.chatId, id: e.id, accountId: e.accountId, ms: e.ms, score: pq.units.length ? score(e.text, e.ms) : 0, fromMe: e.fromMe });
    };
    for (const e of this.entries.values()) consider(e);
    const deepDone = this.deepScan(req, (m) => consider({ chatId: m.chatId, id: m.id, accountId: m.accountId ?? m.chatId.split(":")[0], ms: SearchIndex.ms(m.time), text: fold(messageSearchRaw(m).slice(0, this.o.maxPerMessage)), fromMe: !!m.fromMe, sender: fold(m.sender ?? ""), flags: messageFlags(m) }), new Set(out.map((h) => this.key(h.chatId, h.id))));
    return finish(out, req, deepDone);
  }

  /** Scan the sealed archive for messages older than the index covers (decrypts every row, so time-boxed). */
  protected deepScan(req: SearchRequest, consider: (m: Message) => void, seen: Set<string>): boolean {
    if (!req.deep || this.evicted() <= 0 || !this.store.scanMessages) return false;
    const until = Date.now() + req.deep.budgetMs;
    let after: { chatId: string; id: string } | undefined;
    for (;;) {
      const page = this.store.scanMessages({ after, limit: this.o.pageSize }); if (!page.length) break;
      for (const m of page) {
        if (SearchIndex.ms(m.time) > this.evicted() || m.deleted || m.system || seen.has(this.key(m.chatId, m.id))) continue;
        consider(m);
      }
      const last = page[page.length - 1]; after = { chatId: last.chatId, id: last.id };
      if (page.length < this.o.pageSize) break;
      if (Date.now() > until) return false;
    }
    return true;
  }
}

/** since (inclusive) / until (exclusive) from the request AND the query's after:/before: operators. */
export function effRange(req: SearchRequest): { since?: number; until?: number } {
  const a = [req.since, req.pq.after].filter((x): x is number => x !== undefined), b = [req.until, req.pq.before].filter((x): x is number => x !== undefined);
  return { since: a.length ? Math.max(...a) : undefined, until: b.length ? Math.min(...b) : undefined };
}
/** Sort (best first), count per chat, and cut the requested page. */
export function finish(all: RawHit[], req: SearchRequest, deep: boolean): SearchOutcome {
  all.sort((a, b) => b.score - a.score || b.ms - a.ms || (a.chatId + a.id).localeCompare(b.chatId + b.id));
  const perChat = new Map<string, number>();
  for (const h of all) perChat.set(h.chatId, (perChat.get(h.chatId) ?? 0) + 1);
  return { hits: all.slice(req.offset, req.offset + req.limit), total: all.length, perChat, deep };
}

/** Build the display part of a hit from the stored message. */
export function hitFor(m: Message, pq: ParsedQuery, score: number): SearchHit {
  const { snippet, ranges } = snippetFor(messageSearchRaw(m), pq);
  return { chatId: m.chatId, messageId: m.id, accountId: m.accountId ?? m.chatId.split(":")[0], time: m.time, sender: m.sender, fromMe: !!m.fromMe, snippet, ranges, score };
}
