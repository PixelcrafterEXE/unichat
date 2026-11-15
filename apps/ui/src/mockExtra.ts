// Mock backend for global search, mark-as-read write-back and "download all media" (same RPC surface as the Hub).
import type { Account, Chat, Message } from "./types";
import { isMergeId } from "../../../packages/core/src/model";
import { messageSearchRaw } from "../../../packages/core/src/store";
import { fold, hasMask, isEmptyQuery, messageFlags, parseQuery, snippetFor, textMatcher } from "../../../packages/core/src/searchquery";

type Emit = (ev: string, d: unknown) => void;
export interface MockCtx { store: Record<string, Message[]>; chats: Chat[]; accounts: Account[]; merges: Map<string, { members: string[] }>; emit: Emit; snapshot: () => Promise<{ chats: Chat[] }> }
const METHODS = new Set(["searchAll", "markChatRead", "markAllRead", "cancelMarkRead", "estimateMedia", "downloadAllMedia", "cancelMediaDownload", "archiveMedia", "mediaJobs", "fetchHistory", "cancelFetchHistory", "fetchHistoryJobs"]);
export const mockExtraHandles = (m: string) => METHODS.has(m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const g = globalThis as any;
g.__mockFailRead = new Set<string>();      // test hook: chats whose markRead fails
g.__mockReadLog = [] as { chatId: string; at: number }[];
const cached = new Set<string>();           // `${chatId}|${messageId}|${attachmentId}` saved in the offline cache
g.__mockMediaCached = cached;
let seq = 0; const cancelled = new Set<string>();
const accOf = (c: MockCtx, id: string) => c.accounts.find((a) => id.startsWith(a.id + ":"));

function media(c: MockCtx, accountId: string, chatIds?: string[]) {
  const out: { chatId: string; messageId: string; attachmentId: string; size: number; key: string }[] = [];
  for (const [chatId, list] of Object.entries(c.store)) {
    if (!chatId.startsWith(accountId + ":") || (chatIds && !chatIds.includes(chatId))) continue;
    for (const m of list) if (!m.deleted) for (const a of m.attachments ?? []) out.push({ chatId, messageId: m.id, attachmentId: a.id, size: a.size ?? 0, key: `${chatId}|${m.id}|${a.id}` });
  }
  return out;
}

// "Fetch chat history": walks the account's chats, "fetches" 3 older messages per chat. Hooks: __mockHistGap (ms per chat), __mockHistFail {chatId: reason}.
g.__mockHistFail = {} as Record<string, string>;
const histJobs = new Map<string, any>(); const histCancel = new Set<string>(); g.__mockHistJobs = histJobs;

export async function mockExtraCall(method: string, p: any, c: MockCtx): Promise<any> {
  switch (method) {
    case "searchAll": {
      // same semantics as the core backends (shared parser: packages/core/src/searchquery.ts)
      const query = String(p.query ?? "").trim(), pq = parseQuery(query), limit = p.limit ?? 40;
      const parsed = { terms: pq.units.map((u) => u.tokens.join(" ")), filters: pq.filters, errors: pq.errors };
      const index = { ready: true, messages: 0, truncated: false, engine: "fts5" };
      if (isEmptyQuery(pq)) return { query, groups: [], total: 0, index, tookMs: 0, parsed };
      if (query === "boom") throw new Error("Search failed in the mock (simulated)");
      if (query === "slowpoke") await sleep(900);
      const { chats } = await c.snapshot(); const byId = new Map(chats.map((x) => [x.id, x]));
      const t = (s?: string) => (s ? Date.parse(s) : NaN);
      let until = t(p.until); if (until === until) until += /^\d{4}-\d{2}-\d{2}$/.test(p.until ?? "") ? 864e5 : 1;
      const since = t(p.since), match = textMatcher(pq), mask = hasMask(pq);
      const only = p.chatIds?.length ? new Set<string>(p.chatIds.flatMap((id: string) => (isMergeId(id) ? c.merges.get(id)?.members ?? [] : [id]))) : undefined;
      const inSet = pq.in.length ? new Set(chats.filter((x) => pq.in.some((v) => fold(x.name ?? "").includes(v))).flatMap((x) => [x.id, ...(x.mergeMembers ?? [])])) : undefined;
      const hits: { m: Message; ms: number }[] = [];
      for (const [chatId, list] of Object.entries(c.store)) {
        const ch = byId.get(chatId), a = accOf(c, chatId);
        if (p.accountIds?.length && !p.accountIds.includes(a?.id)) continue;
        if (p.kinds?.length && !(ch && p.kinds.includes(ch.kind))) continue;
        if (p.providers?.length && !(a && p.providers.includes(a.provider))) continue;
        if ((only && !only.has(chatId)) || (inSet && !inSet.has(chatId))) continue;
        for (const m of list) {
          const ms = Date.parse(m.time);
          if (m.deleted || m.system || (since === since && ms < since) || (until === until && ms >= until)) continue;
          if ((pq.after !== undefined && ms < pq.after) || (pq.before !== undefined && ms >= pq.before)) continue;
          if (mask && (messageFlags(m) & mask) !== mask) continue;
          if (pq.from.length && !pq.from.some((f) => (f === "me" ? !!m.fromMe : fold(m.sender ?? "").includes(f)))) continue;
          if (!match(fold(messageSearchRaw(m)))) continue;
          hits.push({ m: { ...m, accountId: a?.id }, ms });
        }
      }
      hits.sort((x, y) => y.ms - x.ms);
      const off = parseInt(p.before ?? "0", 10) || 0, groups = new Map<string, any>(), totals = new Map<string, number>();
      const view = (id: string) => byId.get(id)?.mergedInto ?? id;
      for (const h of hits) totals.set(view(h.m.chatId), (totals.get(view(h.m.chatId)) ?? 0) + 1);
      for (const h of hits.slice(off, off + limit)) {
        const key = view(h.m.chatId), row = byId.get(key), real = byId.get(h.m.chatId);
        const gr = groups.get(key) ?? (groups.set(key, { chatId: key, name: row?.name ?? key, kind: row?.kind, provider: row?.provider ?? "", accountId: h.m.accountId, total: totals.get(key), hits: [],
          providers: [...new Set((row?.mergeMembers ?? [key]).map((id) => accOf(c, id)?.provider).filter(Boolean))], ...(row?.offline ? { offline: row.offline } : {}) }), groups.get(key));
        const sn = snippetFor(messageSearchRaw(h.m), pq);
        gr.hits.push({ chatId: h.m.chatId, messageId: h.m.id, accountId: h.m.accountId, time: h.m.time, sender: h.m.sender, fromMe: h.m.fromMe, ...sn, ...(real?.offline ? { offline: real.offline } : {}), score: 1 });
      }
      const nm = textMatcher({ ...pq, not: [] });
      const named = !off && pq.units.length ? chats.filter((x) => !x.mergedInto && nm(fold(x.name ?? "")) && (!only || only.has(x.id))).slice(0, 8).map((x) => ({ chatId: x.id, name: x.name, kind: x.kind, provider: x.provider, accountId: accOf(c, x.id)?.id ?? "", providers: [x.provider] })) : [];
      return { query, groups: [...groups.values()], total: hits.length, ...(off + limit < hits.length ? { next: String(off + limit) } : {}), index, tookMs: 3, parsed, ...(named.length ? { chats: named } : {}) };
    }
    case "fetchHistory": {
      const a = c.accounts.find((x) => x.id === p.accountId); if (a?.state !== "connected") throw new Error("This account is signed out, so its history can't be fetched any more.");
      if (!(a.capabilities ?? (g.__mockProviders ?? []).find((x: any) => x.name === a.provider)?.capabilities)?.fetchHistory) throw new Error("This messenger can't fetch older chat history on request.");
      if ([...histJobs.values()].some((j) => j.accountId === p.accountId && !j.finished)) throw new Error("Chat history of this account is already being fetched.");
      const { chats } = await c.snapshot();
      const only = p.chatIds?.length ? new Set<string>(p.chatIds) : undefined;
      const rows = chats.filter((x) => accOf(c, x.id)?.id === p.accountId && !x.mergedInto && (!only || only.has(x.id)));
      const jobId = "history-" + ++seq, prog: any = { jobId, accountId: p.accountId, days: p.days ?? 0, state: "running", chatsTotal: rows.length, chatsDone: 0, messages: 0, pages: 0, failures: {}, finished: false, startedAt: Date.now() };
      histJobs.set(jobId, prog);
      void (async () => {
        c.emit("history-progress", { ...prog });
        for (const r of rows) {
          if (histCancel.has(jobId)) { prog.state = "cancelled"; break; }
          prog.current = r.name; c.emit("history-progress", { ...prog });
          await sleep(g.__mockHistGap ?? 150);
          const why = g.__mockHistFail[r.id];
          if (why) prog.failures[why] = (prog.failures[why] ?? 0) + 1;
          else {
            const list = (c.store[r.id] ??= []), oldest = Math.min(...list.map((m) => Date.parse(m.time)), Date.now());
            for (let i = 1; i <= 3; i++) list.unshift({ id: `fh-${r.id}-${seq}-${i}`, chatId: r.id, sender: "Earlier", senderId: "e", text: `fetched earlier message ${i} in ${r.name}`, time: new Date(oldest - i * 3600e3).toISOString(), fromMe: false } as Message);
            prog.messages += 3; prog.pages++;
          }
          prog.chatsDone++; c.emit("history-progress", { ...prog });
        }
        prog.current = undefined; if (prog.state === "running") prog.state = "done"; prog.finished = true; prog.endedAt = Date.now(); c.emit("history-progress", { ...prog });
      })();
      return { jobId };
    }
    case "cancelFetchHistory": for (const j of histJobs.values()) if (!j.finished && (j.jobId === p.jobId || j.accountId === p.accountId)) histCancel.add(j.jobId); return { cancelled: true };
    case "fetchHistoryJobs": return [...histJobs.values()].map((j) => ({ ...j }));
    case "markChatRead": return markRow(c, p.chatId, p.sendReceipts !== false);
    case "markAllRead": {
      const { chats } = await c.snapshot(); const scope = String(p.scope ?? "all");
      const rows = chats.filter((x) => !x.mergedInto && (x.unread ?? 0) > 0 && (scope === "all" || ((scope === "personal" || scope === "home") ? !x.spaceId : c.accounts.some((a) => a.id === scope) ? (accOf(c, x.id)?.id === scope) : x.spaceId === scope)));
      const jobId = "read-" + ++seq, total = rows.length;
      const prog: any = { jobId, scope, total, done: 0, ok: 0, local: 0, failed: 0, finished: false }, failures: any[] = [], cleared: string[] = [];
      void (async () => {
        c.emit("mark-read-progress", { ...prog });
        for (const r of rows) {
          if (cancelled.has(jobId)) { prog.cancelled = true; break; }
          await sleep(g.__mockReadGap ?? 120);
          const res = await markRow(c, r.id, p.sendReceipts !== false, true); prog[res.status]++; prog.done++;
          if (res.status === "failed") failures.push(res); else cleared.push(r.id);
          c.emit("mark-read-progress", { ...prog });
        }
        prog.finished = true; c.emit("mark-read-progress", { ...prog, failures, cleared });
      })();
      return { jobId, total };
    }
    case "cancelMarkRead": cancelled.add(p.jobId); return { cancelled: true };
    case "estimateMedia": case "archiveMedia": {
      const list = media(c, p.accountId, p.chatIds), miss = list.filter((x) => !cached.has(x.key));
      const a = c.accounts.find((x) => x.id === p.accountId), live = a?.state === "connected";
      if (method === "estimateMedia") return { accountId: p.accountId, files: list.length, cached: list.length - miss.length, missing: miss.length, bytes: miss.reduce((n, x) => n + x.size, 0), unknownSize: miss.filter((x) => !x.size).length, chats: {}, available: live, running: null };
      const chats: Record<string, any> = {};
      for (const x of list) { const s = (chats[x.chatId] ??= { files: 0, missing: 0, bytesMissing: 0 }); s.files++; if (!cached.has(x.key)) { s.missing++; s.bytesMissing += x.size; } }
      return { accountId: p.accountId, files: list.length, missing: miss.length, chats };
    }
    case "downloadAllMedia": {
      const a = c.accounts.find((x) => x.id === p.accountId); if (a?.state !== "connected") throw new Error("This account is signed out, so its media can't be downloaded any more.");
      const miss = media(c, p.accountId, p.chatIds).filter((x) => !cached.has(x.key)), jobId = "media-" + ++seq;
      const est = { accountId: p.accountId, files: miss.length, cached: 0, missing: miss.length, bytes: miss.reduce((n, x) => n + x.size, 0), unknownSize: 0, chats: {} };
      const prog: any = { jobId, accountId: p.accountId, total: miss.length, done: 0, failed: 0, bytes: 0, totalBytes: est.bytes, state: "running", finished: false };
      (g.__mockMediaJobs ??= new Map()).set(jobId, prog); // listed by mediaJobs while the panel is closed and re-opened
      void (async () => {
        c.emit("media-progress", { ...prog });
        for (const x of miss) {
          if (cancelled.has(jobId)) { prog.state = "cancelled"; break; }
          await sleep(g.__mockMediaGap ?? 150); cached.add(x.key); prog.done++; prog.bytes += x.size; c.emit("media-progress", { ...prog });
        }
        if (prog.state === "running") prog.state = "done";
        prog.finished = true; c.emit("media-progress", { ...prog });
      })();
      return { jobId, estimate: est };
    }
    case "cancelMediaDownload": for (const k of [p.jobId, ...Array.from({ length: seq }, (_, i) => "media-" + (i + 1))]) cancelled.add(k); return { cancelled: true };
    case "mediaJobs": return [...(g.__mockMediaJobs ?? new Map()).values()].map((x: any) => ({ ...x }));
  }
}

async function markRow(c: MockCtx, rowId: string, receipts: boolean, throttled = false) {
  const members = isMergeId(rowId) ? c.merges.get(rowId)?.members ?? [] : [rowId];
  let ok = 0, reason: string | undefined, error: string | undefined;
  for (const id of members) {
    const a = accOf(c, id), ch = c.chats.find((x) => x.id === id);
    if (!a || !ch) { reason ??= "no-support"; continue; }
    if (a.state !== "connected") { reason ??= "signed-out"; continue; }
    if (a.provider === "instagram" || a.provider === "signal") { reason ??= "no-support"; continue; }
    if (!receipts) { reason ??= "receipts-off"; continue; }
    if (g.__mockFailRead.has(id)) { error = "rate limited"; continue; }
    g.__mockReadLog.push({ chatId: id, at: Date.now() }); ch.unread = 0; delete ch.unreadApprox; ok++;
  }
  const r = error ? { chatId: rowId, status: "failed", reason: "error", error } : ok ? { chatId: rowId, status: "ok" } : { chatId: rowId, status: "local", reason: reason ?? "no-messages" };
  if (r.status !== "failed") c.emit("chat-read", { chatId: rowId, status: r.status });
  void throttled; return r;
}
