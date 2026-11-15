// Hub features that sit on top of the archive: global search, "mark as read" written back to the services, and "download all media".
// Kept out of hub.ts; the Hub only hands over a small port with the few internals these need.
import type { Capabilities, Connector } from "./provider.js";
import type { Account, Chat, ChatKind, ChatMerge, Message, Space } from "./model.js";
import { cardsOf, isMergeId } from "./model.js";
import type { MediaCache } from "./media.js";
import type { Store } from "./store.js";
import { SearchIndex, hitFor, type SearchGroup, type SearchQuery, type SearchResult } from "./search.js";
import { fold, isEmptyQuery, parseQuery, textMatcher } from "./searchquery.js";
import { ReadJobs, type ReadProgress, type ReadResult } from "./readjob.js";
import { MediaDownloader } from "./mediajob.js";
import { HistoryFetcher, type HistoryJobOptions } from "./historyjob.js";

export interface ExtrasPort {
  store: Store; media: MediaCache; index: SearchIndex;
  snapshot(): Promise<{ chats: Chat[]; accounts: Account[]; spaces: Space[] }>;
  /** The account behind a (global) chat id. `conn` is set only while the account is connected (not signed out / unlinked). */
  account(chatId: string): { accountId: string; native: string; provider: string; conn?: Connector; caps?: Capabilities } | undefined;
  liveConn(accountId: string): Connector | undefined;
  provisional(chatId: string): boolean;
  merge(id: string): ChatMerge | undefined;
  emit(event: string, data: unknown): void;
  /** Persist 'read up to the newest incoming message' for a chat (Hub.noteRead). */
  noteRead?(chatId: string): void;
}
export interface ExtrasOptions { markReadGapMs?: number; mediaGapMs?: number; mediaConcurrency?: number; history?: HistoryJobOptions }

const timeout = <T,>(p: Promise<T>, ms: number): Promise<T> => new Promise((ok, fail) => { const t = setTimeout(() => fail(new Error("The messenger didn't confirm in time.")), ms); p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); fail(e); }); });

export class HubExtras {
  readonly reads: ReadJobs;
  readonly media: MediaDownloader;
  readonly history: HistoryFetcher;
  constructor(private port: ExtrasPort, o: ExtrasOptions = {}) {
    let lastIdx = 0; // progress of the search index (re)build for the UI
    port.index.onProgress = (indexed, done) => { if (done || Date.now() - lastIdx > 400) { lastIdx = Date.now(); port.emit("search-index", { indexed, done }); } };
    this.reads = new ReadJobs((e, d) => port.emit(e, d), o.markReadGapMs ?? 330);
    this.media = new MediaDownloader(port.store, port.media, (id) => port.liveConn(id), (e, d) => port.emit(e, d), { gapMs: o.mediaGapMs, concurrency: o.mediaConcurrency });
    this.history = new HistoryFetcher(port.store, async (acc, explicit) => { const snap = await port.snapshot(); const arch = new Set(snap.spaces.filter((s) => s.archived).map((s) => s.id)); return snap.chats.filter((c) => port.account(c.id)?.accountId === acc && (explicit || !(c.spaceId && arch.has(c.spaceId)))); }, (id) => port.liveConn(id), (id) => port.account(id + ":x")?.provider, (e, d) => port.emit(e, d), o.history);
  }

  // ------------------------------------------------------------------ global search
  async searchAll(p: SearchQuery & { wait?: number }): Promise<SearchResult> {
    const t0 = Date.now(), query = String(p.query ?? "").trim(), pq = parseQuery(query);
    const limit = Math.min(200, Math.max(1, Math.floor(Number(p.limit) || 40)));
    const idx = this.port.index;
    const index = () => ({ ready: idx.ready, ...idx.stats() });
    const parsed = { terms: pq.units.map((u) => u.tokens.join(" ")), filters: pq.filters, errors: pq.errors };
    if (isEmptyQuery(pq)) return { query, groups: [], total: 0, index: index(), tookMs: 0, parsed };
    idx.ensure();
    if (!idx.ready) await idx.waitReady(Math.max(0, Math.min(5000, p.wait ?? 1500)));
    const { chats } = await this.port.snapshot();
    const byId = new Map(chats.map((c) => [c.id, c]));
    const prov = (c: Chat) => this.port.account(c.id)?.provider ?? c.provider; // the account knows its messenger (a provider could mislabel a chat)
    // chat-level restrictions -> the set of real chat ids that may match (undefined = every chat)
    const kinds = p.kinds?.length ? new Set<ChatKind>(p.kinds) : undefined, provs = p.providers?.length ? new Set(p.providers) : undefined;
    let chatIds: Set<string> | undefined;
    const narrow = (ids: Set<string>) => { chatIds = chatIds ? new Set([...chatIds].filter((x) => ids.has(x))) : ids; };
    if (kinds || provs) narrow(new Set(chats.filter((c) => (!kinds || kinds.has(c.kind)) && (!provs || provs.has(prov(c)))).map((c) => c.id)));
    if (p.chatIds?.length) narrow(new Set(this.expandIds(p.chatIds)));
    if (pq.in.length) narrow(new Set(chats.filter((c) => { const n = fold(c.name ?? ""); return pq.in.some((v) => n.includes(v)); }).flatMap((c) => [c.id, ...(c.mergeMembers ?? [])])));
    const t = (s?: string) => { const v = s ? Date.parse(s) : NaN; return Number.isFinite(v) ? v : undefined; };
    let until = t(p.until); // a bare date means "through the end of that day"
    if (until !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(p.until!)) until += 864e5;
    else if (until !== undefined) until += 1;
    const offset = Math.max(0, parseInt(String(p.before ?? "0"), 10) || 0);
    const out = idx.search({ pq, chatIds, accountIds: p.accountIds?.length ? new Set(p.accountIds) : undefined, since: t(p.since), until, limit, offset, deep: p.deep ? { budgetMs: 4000 } : undefined });
    const view = (chatId: string) => byId.get(chatId)?.mergedInto ?? chatId;
    const totals = new Map<string, number>();
    for (const [c, n] of out.perChat) totals.set(view(c), (totals.get(view(c)) ?? 0) + n);
    const groups = new Map<string, SearchGroup>();
    for (const h of out.hits) {
      const m = this.port.store.getMessage(h.chatId, h.id); if (!m || m.deleted) continue;
      const key = view(h.chatId), row = byId.get(key), real = byId.get(h.chatId);
      let g = groups.get(key);
      if (!g) {
        const members = row?.mergeMembers?.map((id) => byId.get(id)).filter((x): x is Chat => !!x);
        g = { chatId: key, name: row?.name ?? h.chatId.slice(h.accountId.length + 1), kind: row?.kind, provider: row?.provider === "merged" ? "merged" : real ? prov(real) : this.port.account(h.chatId)?.provider ?? row?.provider ?? "", accountId: h.accountId,
          providers: members ? [...new Set(members.map(prov))] : [real ? prov(real) : row?.provider ?? ""].filter(Boolean), total: totals.get(key) ?? 0, hits: [], ...(row?.offline ? { offline: row.offline } : {}) };
        groups.set(key, g);
      }
      g.hits.push({ ...hitFor(m, pq, h.score), ...(real?.offline ? { offline: real.offline } : {}) });
    }
    const next = offset + limit < out.total ? String(offset + limit) : undefined;
    // chats / contacts whose NAME matches the words (not indexed: names change, the chat list is the truth)
    let named: SearchResult["chats"];
    if (!offset && pq.units.length) {
      const match = textMatcher({ ...pq, not: [] });
      named = chats.filter((c) => !c.mergedInto && match(fold(c.name ?? "")) && (!chatIds || chatIds.has(c.id) || !!c.mergeMembers?.some((x) => chatIds!.has(x))) && (!p.accountIds?.length || p.accountIds.includes(this.port.account(c.id)?.accountId ?? "")))
        .slice(0, 8).map((c) => ({ chatId: c.id, name: c.name ?? c.id, kind: c.kind, provider: prov(c), accountId: this.port.account(c.id)?.accountId ?? c.accountId, providers: [prov(c)] }));
    }
    return { query, groups: [...groups.values()], total: out.total, ...(next ? { next } : {}), index: { ...index(), ...(out.deep ? { deep: true } : {}) }, tookMs: Date.now() - t0, parsed, ...(named?.length ? { chats: named } : {}) };
  }
  private expandIds(ids: string[]): string[] { return ids.flatMap((c) => (isMergeId(c) ? this.port.merge(c)?.members ?? [] : [c])); }

  // ------------------------------------------------------------------ mark as read
  /** Mark ONE real chat read on its service (no throttle unless `throttle`). Never throws. */
  async markOne(chatId: string, sendReceipts: boolean, throttle = false): Promise<ReadResult> {
    const r = await this.markOneRaw(chatId, sendReceipts, throttle);
    if (r.status !== "failed") this.port.noteRead?.(chatId); // remember the read position locally whatever the provider can do (persists reloads, syncs)
    return r;
  }
  private async markOneRaw(chatId: string, sendReceipts: boolean, throttle: boolean): Promise<ReadResult> {
    const local = (reason: ReadResult["reason"]): ReadResult => ({ chatId, status: "local", reason });
    const a = this.port.account(chatId);
    if (!a || this.port.provisional(chatId)) return local("no-support");
    if (!a.conn) return local("signed-out");
    const fn = (a.conn as Connector).markRead;
    const caps = a.caps;
    if (typeof fn !== "function" || !(caps?.markRead ?? caps?.readReceipts)) return local("no-support");
    if (caps?.readReceipts && !sendReceipts) return local("receipts-off"); // marking read on a receipt-sending network tells the sender: respect the user's choice
    const msgs = this.port.store.listMessages(chatId, { limit: 30 });
    const newest = [...msgs].reverse().find((m) => !m.fromMe && !m.system) ?? msgs.at(-1);
    if (!newest) return local("no-messages");
    try {
      if (throttle) await this.reads.throttle();
      await timeout(fn.call(a.conn, a.native, newest.id), 20_000);
      return { chatId, status: "ok" };
    } catch (e) { return { chatId, status: "failed", reason: "error", error: (e as Error).message || "failed" }; }
  }
  /** A row as the UI lists it (a chat or a merged chat): marks it, and for a merge every member (optionally only those of one account). */
  private async markRow(rowId: string, sendReceipts: boolean, throttle: boolean, onlyAccount?: string, onlyUnread?: Map<string, Chat>): Promise<ReadResult> {
    const mg = isMergeId(rowId) ? this.port.merge(rowId) : undefined;
    if (isMergeId(rowId) && !mg) return { chatId: rowId, status: "failed", reason: "error", error: "This merged chat no longer exists." };
    let ids = mg ? mg.members : [rowId];
    if (onlyAccount) ids = ids.filter((c) => this.port.account(c)?.accountId === onlyAccount);
    if (onlyUnread && mg) ids = ids.filter((c) => (onlyUnread.get(c)?.unread ?? 0) > 0);
    const rs: ReadResult[] = [];
    for (const c of ids) rs.push(await this.markOne(c, sendReceipts, throttle));
    const failed = rs.find((r) => r.status === "failed");
    const res: ReadResult = failed ? { ...failed, chatId: rowId } : rs.some((r) => r.status === "ok") ? { chatId: rowId, status: "ok" } : { chatId: rowId, status: "local", reason: rs[0]?.reason ?? "no-messages" };
    if (res.status !== "failed") this.port.emit("chat-read", { chatId: rowId, status: res.status });
    return res;
  }
  async markChatRead(p: { chatId: string; sendReceipts?: boolean }): Promise<ReadResult> {
    if (!p?.chatId) throw new Error("No chat given.");
    return this.markRow(p.chatId, p.sendReceipts !== false, false);
  }
  /** scope: "all", "personal" (chats outside every community/folder), an account id, or a community / folder id. */
  async markAllRead(p: { scope?: string; sendReceipts?: boolean; wait?: boolean }): Promise<{ jobId: string; total: number } | ReadProgress> {
    const scope = String(p?.scope ?? "all"), { chats, accounts } = await this.port.snapshot();
    const isAccount = accounts.some((a) => a.id === scope);
    const byId = new Map(chats.map((c) => [c.id, c]));
    const rows = chats.filter((c) => !c.mergedInto && (c.unread ?? 0) > 0).filter((c) => {
      if (scope === "all") return true;
      if (scope === "personal" || scope === "home") return !c.spaceId;
      if (isAccount) return this.port.account(c.id)?.accountId === scope || !!c.mergeMembers?.some((m) => this.port.account(m)?.accountId === scope && (byId.get(m)?.unread ?? 0) > 0);
      return c.spaceId === scope;
    }).sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
    const sendReceipts = p?.sendReceipts !== false;
    const job = this.reads.start(scope, rows.map((r) => r.id), (id) => this.markRow(id, sendReceipts, true, isAccount ? scope : undefined, byId));
    if (p?.wait) return job.finished;
    return { jobId: job.jobId, total: job.total };
  }

  // ------------------------------------------------------------------ fetch chat history
  async fetchHistory(p: { accountId: string; chatIds?: string[]; days?: number; resume?: boolean; wait?: boolean }) {
    const j = await this.history.start(String(p.accountId), { chatIds: this.expand(p.chatIds), days: p.days, resume: p.resume });
    if (p.wait) return { jobId: j.jobId, result: await j.finished };
    return { jobId: j.jobId };
  }
  cancelFetchHistory(p: { jobId?: string; accountId?: string }) { return { cancelled: this.history.cancel(String(p.jobId ?? p.accountId ?? "")) }; }
  fetchHistoryJobs() { return this.history.list(); }

  /**
   * Shared media of a chat (info sidebar + gallery): newest-first, paged. `kinds` picks what counts ("media" = photos/videos, "files", "voice" = voice notes/audio, "links" = messages with a URL;
   * default media+files). `before` is the `next` cursor of the previous page. Without `before` the answer also carries `count` (per kind, the whole archive) and `places`.
   * Merged chats are collected from all their members.
   */
  chatMedia(p: { chatId: string; limit?: number; before?: string; kinds?: string[] }) {
    const ids = this.expand([String(p.chatId)]) ?? [], want = Math.min(200, Math.max(1, Number(p.limit) || 60));
    const all = ["media", "files", "voice", "links"] as const; type K = (typeof all)[number];
    const kinds = new Set<K>((Array.isArray(p.kinds) ? p.kinds : ["media", "files"]).filter((k): k is K => (all as readonly string[]).includes(k)));
    if (!kinds.size) kinds.add("media");
    const kindsOf = (m: Message): K[] => {
      const k = new Set<K>();
      for (const a of m.attachments ?? []) { if (a.kind === "image" || a.kind === "video") k.add("media"); else if (a.kind === "file") k.add("files"); else if (a.kind === "voice" || a.kind === "audio") k.add("voice"); }
      if (/https?:\/\/\S+/i.test(m.text ?? "") || cardsOf(m).some((c) => c.url)) k.add("links");
      return [...k];
    };
    const keyOf = (m: Message) => `${m.time}\u0000${m.chatId}\u0000${m.id}`;
    const first = !p.before, cur = p.before ? String(p.before) : undefined;
    const count: Record<K, number> = { media: 0, files: 0, voice: 0, links: 0 };
    const out: Message[] = []; let places = 0;
    for (const id of ids) {
      let before: string | undefined = cur ? cur.split("\u0000")[0] + "\u0001" : undefined, scanned = 0, got = 0;
      while (scanned < 50_000) {
        const page = this.port.store.listMessages(id, { ...(before ? { beforeTime: before } : {}), limit: 500 }); // oldest first
        if (!page.length) break;
        scanned += page.length; before = page[0]!.time;
        for (let i = page.length - 1; i >= 0; i--) {
          const m = page[i]!; if (m.deleted) continue;
          if (first) { if (m.location) places++; for (const a of m.attachments ?? []) { if (a.kind === "image" || a.kind === "video") count.media++; else if (a.kind === "file") count.files++; else if (a.kind === "voice" || a.kind === "audio") count.voice++; } if (kindsOf(m).includes("links")) count.links++; }
          if (cur && keyOf(m) >= cur) continue;
          const k = kindsOf(m); if (!k.some((x) => kinds.has(x))) continue;
          if (got <= want) { out.push(m); got++; } // one extra: tells whether there is a next page
        }
        if (page.length < 500 || (!first && got > want)) break; // a later page only needs `want` per member; the first page also counts everything
      }
    }
    out.sort((a, b) => (keyOf(a) < keyOf(b) ? 1 : -1));
    const messages = out.slice(0, want);
    const next = out.length > want ? keyOf(messages[messages.length - 1]!) : undefined;
    return { messages, places: first ? places : undefined, ...(first ? { count } : {}), next };
  }

  // ------------------------------------------------------------------ media
  private expand(chatIds?: string[]): string[] | undefined {
    if (!chatIds?.length) return undefined;
    return chatIds.flatMap((c) => (isMergeId(c) ? this.port.merge(c)?.members ?? [] : [c]));
  }
  async estimateMedia(p: { accountId: string; chatIds?: string[] }) {
    const { estimate } = await this.media.scan(String(p.accountId), this.expand(p.chatIds));
    return { ...estimate, available: !!this.port.liveConn(estimate.accountId), running: this.media.running(estimate.accountId) ?? null };
  }
  async downloadAllMedia(p: { accountId: string; chatIds?: string[]; maxBytes?: number; wait?: boolean }) {
    const j = await this.media.start(String(p.accountId), this.expand(p.chatIds), p.maxBytes && p.maxBytes > 0 ? Number(p.maxBytes) : undefined);
    if (p.wait) return { jobId: j.jobId, estimate: j.estimate, result: await j.finished };
    void j.finished.catch(() => {});
    return { jobId: j.jobId, estimate: j.estimate };
  }
  cancelMediaDownload(p: { jobId?: string; accountId?: string }) { return { cancelled: this.media.cancel(String(p.jobId ?? p.accountId ?? "")) }; }
  mediaJobs() { return this.media.list(); }
  /** Per chat of an account: how many files are not in the offline cache (what a signed-out archive can no longer show). */
  async archiveMedia(p: { accountId: string }) {
    const { estimate } = await this.media.scan(String(p.accountId));
    const chats: Record<string, { files: number; missing: number; bytesMissing: number }> = {};
    for (const [id, s] of Object.entries(estimate.chats)) if (s.files) chats[id] = { files: s.files, missing: s.missing, bytesMissing: s.bytesMissing };
    return { accountId: estimate.accountId, files: estimate.files, missing: estimate.missing, chats };
  }
}
