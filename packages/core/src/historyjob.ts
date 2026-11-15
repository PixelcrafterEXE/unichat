// "Fetch chat history": for messengers that only load a chat's history when it is opened (WhatsApp on-demand history, Discord, Matrix,
// Mattermost), walk the chats of ONE account and page backwards through Connector.history() into the archive, so search and offline
// reading see the whole conversation. Throttled per messenger (the provider may add its own pacing: history() is simply awaited),
// cancelable, resumable (per-chat position is persisted; a job that was running when the app stopped comes back as "interrupted"),
// and ends with a summary: counts per failure reason.
import type { Connector } from "./provider.js";
import type { Chat, Message } from "./model.js";
import type { Store } from "./store.js";

export type FailReason = "rate-limited" | "no-access" | "timeout" | "not-supported" | "error";
export interface HistoryProgress {
  jobId: string; accountId: string; provider?: string;
  /** 0 = everything; otherwise only messages newer than this many days are wanted. */
  days: number;
  state: "running" | "done" | "cancelled" | "stopped" | "interrupted";
  chatsTotal: number; chatsDone: number;
  /** New messages written to the archive / history() calls made. */
  messages: number; pages: number;
  current?: string;
  /** Chats that could not be completed, by reason. */
  failures: Partial<Record<FailReason, number>>;
  /** A few example error messages (no message text). */
  errors?: string[];
  finished: boolean; message?: string; startedAt: number; endedAt?: number;
}
interface Saved { p: HistoryProgress; chatIds: string[]; pos: Record<string, { oldest?: string; done?: boolean }> }
export interface HistoryJobOptions { gapMs?: number | Record<string, number>; pageSize?: number; maxPerChat?: number; timeoutMs?: number; retries?: number }
const DEFAULT_GAP: Record<string, number> = { discord: 1100, whatsapp: 1500, matrix: 300, mattermost: 300, instagram: 1500 };
const KEY = "fetchHistory.jobs";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> => new Promise((ok, fail) => { const t = setTimeout(() => fail(new Error("timed out")), ms); t.unref?.(); p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); fail(e); }); });

export function classifyError(e: unknown): FailReason {
  const s = `${(e as any)?.code ?? ""} ${(e as Error)?.message ?? e}`.toLowerCase();
  if (/429|rate.?limit|too many|slow ?down|retry.?after/.test(s)) return "rate-limited";
  if (/403|forbidden|missing access|permission|not allowed|not a member|unauthori|401/.test(s)) return "no-access";
  if (/timed? ?out|timeout|etimedout/.test(s)) return "timeout";
  if (/not supported|unsupported|not implemented/.test(s)) return "not-supported";
  return "error";
}

export class HistoryFetcher {
  private live = new Map<string, { cancelled: boolean; p: HistoryProgress }>();
  private seq = 0;
  constructor(private store: Store, private chatsOf: (accountId: string, explicit?: boolean) => Promise<Chat[]>, private connOf: (accountId: string) => Connector | undefined,
    private providerOf: (accountId: string) => string | undefined, private emit: (e: string, d: unknown) => void, private o: HistoryJobOptions = {}) {}

  private load(): Record<string, Saved> { try { return JSON.parse(this.store.getSetting(KEY) ?? "{}"); } catch { return {}; } }
  private save(s: Saved) { const all = this.load(); all[s.p.accountId] = s; this.store.setSetting(KEY, JSON.stringify(all)); }

  /** Status of every job (running now, finished, or interrupted by a restart). */
  list(): HistoryProgress[] {
    const out: HistoryProgress[] = [];
    for (const [acc, s] of Object.entries(this.load())) {
      const l = [...this.live.values()].find((j) => j.p.accountId === acc);
      if (l) { out.push({ ...l.p }); continue; }
      // saved as "running" but nobody is running it: the app stopped in between
      out.push(s.p.state === "running" ? { ...s.p, state: "interrupted", finished: false, message: "Interrupted when UniChat stopped. Resume to continue where it left off." } : s.p);
    }
    return out;
  }
  cancel(key: string) { let n = 0; for (const j of this.live.values()) if (j.p.jobId === key || j.p.accountId === key) { j.cancelled = true; n++; } return n > 0; }

  async start(accountId: string, o: { chatIds?: string[]; days?: number; resume?: boolean } = {}): Promise<{ jobId: string; finished: Promise<HistoryProgress> }> {
    if ([...this.live.values()].some((j) => j.p.accountId === accountId)) throw new Error("Chat history of this account is already being fetched.");
    const conn = this.connOf(accountId);
    if (!conn) throw new Error("This account is signed out, so its history can't be fetched any more.");
    if (!conn.capabilities.fetchHistory) throw new Error("This messenger can't fetch older chat history on request.");
    const provider = this.providerOf(accountId) ?? "";
    let saved = o.resume ? this.load()[accountId] : undefined;
    if (saved && saved.p.state === "done") saved = undefined;
    let chatIds: string[];
    if (saved) chatIds = saved.chatIds;
    else {
      const only = o.chatIds?.length ? new Set(o.chatIds) : undefined;
      // default: every chat incl. archived chats and groups, but not chats of archived communities (explicitly chosen chats are always fetched)
      const all = (await this.chatsOf(accountId, !!only)).filter((c) => !c.readOnly && !c.offline && (!only || only.has(c.id)));
      // most recently active first: the chats people care about get their history first
      chatIds = all.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "")).map((c) => c.id);
    }
    const days = saved ? saved.p.days : Math.max(0, Number(o.days) || 0);
    const p: HistoryProgress = saved ? { ...saved.p, state: "running", finished: false, message: undefined, endedAt: undefined }
      : { jobId: "", accountId, provider, days, state: "running", chatsTotal: chatIds.length, chatsDone: 0, messages: 0, pages: 0, failures: {}, finished: false, startedAt: Date.now() };
    p.jobId = `history-${Date.now().toString(36)}-${++this.seq}`;
    const st: Saved = { p, chatIds, pos: saved?.pos ?? {} };
    const job = { cancelled: false, p }; this.live.set(p.jobId, job);
    const gapCfg = this.o.gapMs, gap = typeof gapCfg === "number" ? gapCfg : gapCfg?.[provider] ?? DEFAULT_GAP[provider] ?? 500;
    const pageSize = this.o.pageSize ?? 100, maxPerChat = this.o.maxPerChat ?? 50_000, timeoutMs = this.o.timeoutMs ?? 90_000, retries = this.o.retries ?? 3;
    const cutoff = days > 0 ? Date.now() - days * 864e5 : 0;
    const errors: string[] = p.errors ? [...p.errors] : [];
    let lastEmit = 0, lastCall = 0;
    const push = (force = false) => { this.save(st); if (force || Date.now() - lastEmit > 300) { lastEmit = Date.now(); this.emit("history-progress", { ...p, ...(errors.length ? { errors: errors.slice(0, 5) } : {}) }); } };
    const fail = (r: FailReason, e?: unknown) => { p.failures[r] = (p.failures[r] ?? 0) + 1; if (e && errors.length < 5) errors.push(`${r}: ${((e as Error)?.message ?? String(e)).replace(/\s+/g, " ").slice(0, 100)}`); };
    const names = new Map<string, string>();

    const one = async (chatId: string): Promise<"ok" | "stopped" | "cancelled"> => {
      const pos = (st.pos[chatId] ??= {}); let stored = 0, pages = 0;
      for (;;) {
        if (job.cancelled) return "cancelled";
        const c = this.connOf(accountId); if (!c) return "stopped";
        let page: Message[] | undefined;
        for (let attempt = 0; ; attempt++) {
          const wait = Math.max(0, lastCall + gap * (attempt ? 2 ** attempt : 1) - Date.now()); if (wait) await sleep(wait);
          if (job.cancelled) return "cancelled";
          lastCall = Date.now();
          try { page = await withTimeout(c.history(chatId.slice(accountId.length + 1), { limit: pageSize, ...(pos.oldest ? { beforeMessageId: pos.oldest } : {}) }), timeoutMs); p.pages++; pages++; break; }
          catch (e) { const r = classifyError(e); if (r === "rate-limited" && attempt < retries) continue; fail(r, e); return "ok"; }
        }
        if (!page.length) { pos.done = true; return "ok"; }
        const ms = page.map((m) => ({ ...m, chatId, accountId }));
        const fresh = ms.filter((m) => !this.store.getMessage(chatId, m.id)).length;
        this.store.putMessages(ms); p.messages += fresh; stored += ms.length;
        const oldest = ms.reduce((a, b) => (Date.parse(b.time) < Date.parse(a.time) ? b : a));
        if (oldest.id === pos.oldest) { pos.done = true; return "ok"; } // the provider gave nothing older: this is the beginning
        pos.oldest = oldest.id;
        if (cutoff && Date.parse(oldest.time) < cutoff) { pos.done = true; return "ok"; }
        if (stored >= maxPerChat || pages > maxPerChat / Math.max(1, pageSize) + 5) { pos.done = true; return "ok"; }
        push();
      }
    };
    const finished = (async () => {
      this.emit("history-progress", { ...p });
      const chats = new Map((await this.chatsOf(accountId).catch(() => [])).map((c) => [c.id, c.name]));
      for (const [k, v] of chats) names.set(k, v);
      for (const id of chatIds) {
        if (st.pos[id]?.done) continue;
        p.current = names.get(id) ?? id.slice(accountId.length + 1); push();
        let r: Awaited<ReturnType<typeof one>>;
        try { r = await one(id); } catch (e) { fail("error", e); r = "ok"; }
        if (r === "cancelled") { p.state = "cancelled"; break; }
        if (r === "stopped") { p.state = "stopped"; p.message = "The account was signed out or disconnected while fetching."; break; }
        st.pos[id].done = true; p.chatsDone++; push(true);
      }
      p.current = undefined;
      if (p.state === "running") p.state = "done";
      p.finished = true; p.endedAt = Date.now(); if (errors.length) p.errors = errors.slice(0, 5);
      this.live.delete(p.jobId); this.save(st);
      const fin = { ...p }; this.emit("history-progress", fin); return fin;
    })();
    void finished.catch(() => {});
    return { jobId: p.jobId, finished };
  }
}
