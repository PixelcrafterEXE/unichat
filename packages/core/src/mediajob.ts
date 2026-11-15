// "Download all media": walks the archive's attachment descriptors of ONE account and fetches the ones that are not in the sealed media
// cache yet (so they survive sign-out). Throttled, cancelable, resumable (a new run simply skips what is cached), with a size estimate first.
import type { Connector } from "./provider.js";
import type { Message } from "./model.js";
import { cardsOf } from "./model.js";
import type { MediaCache } from "./media.js";
import type { Store } from "./store.js";

export interface MediaRef { chatId: string; messageId: string; attachmentId: string; size?: number; name?: string }
export interface MediaChatStat { files: number; cached: number; missing: number; bytesMissing: number }
export interface MediaEstimate {
  accountId: string;
  /** Files that exist in the archive / are cached already / still missing. */
  files: number; cached: number; missing: number;
  /** Sum of the known sizes of the missing files, and how many of them have no size. */
  bytes: number; unknownSize: number;
  chats: Record<string, MediaChatStat>;
}
export interface MediaProgress {
  jobId: string; accountId: string; total: number; done: number; failed: number; bytes: number; totalBytes: number;
  state: "running" | "done" | "cancelled" | "limit" | "stopped"; finished: boolean;
  /** Why it stopped early ("limit": maxBytes reached; "stopped": account signed out / connection lost). */
  message?: string; errors?: string[];
  /** Failure counts per reason (provider errors may carry a short `reason`; otherwise the error is classified: timeout, error). */
  reasons?: Record<string, number>;
}

/** Every downloadable item of a message: attachments and card images (same key the `attachment` RPC caches under). */
export function mediaRefs(m: Message): { attachmentId: string; size?: number; name?: string }[] {
  if (m.deleted || m.system) return [];
  const out = (m.attachments ?? []).map((a) => ({ attachmentId: a.id, size: a.size, name: a.name }));
  for (const c of cardsOf(m)) if (c.image?.attachmentId && !out.some((o) => o.attachmentId === c.image!.attachmentId)) out.push({ attachmentId: c.image.attachmentId, size: undefined, name: undefined });
  return out;
}
export const mediaKey = (chatId: string, messageId: string, attachmentId: string) => `${chatId}|${messageId}|${attachmentId}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> => new Promise((ok, fail) => { const t = setTimeout(() => fail(new Error("timed out")), ms); p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); fail(e); }); });

/** Short stable reason for a failed download: the provider's `reason`, else timeout / error. */
export function failReason(e: unknown): string {
  const r = (e as { reason?: unknown })?.reason;
  if (typeof r === "string" && r) return r.slice(0, 40);
  return /timed out/i.test(String((e as Error)?.message)) ? "timeout" : "error";
}

export class MediaDownloader {
  private jobs = new Map<string, { id: string; cancelled: boolean; p: MediaProgress }>();
  private seq = 0;
  constructor(private store: Store, private media: MediaCache, private connOf: (accountId: string) => Connector | undefined,
    private emit: (e: string, d: unknown) => void, private o: { gapMs?: number; concurrency?: number; timeoutMs?: number } = {}) {}

  /** Stream the account's archive page by page (yielding to the event loop), calling `f` per message. */
  private async walk(accountId: string, f: (m: Message) => void) {
    if (this.store.scanMessages) {
      let after: { chatId: string; id: string } | undefined;
      for (;;) {
        const page = this.store.scanMessages({ after, limit: 500, accountId });
        for (const m of page) f(m);
        if (page.length < 500) return;
        const l = page[page.length - 1]; after = { chatId: l.chatId, id: l.id };
        await new Promise<void>((r) => setImmediate(r));
      }
    }
    let n = 0;
    for (const r of this.store.exportRecords()) { if (r.t === "message" && r.v.chatId.startsWith(accountId + ":")) f(r.v); if (++n % 2000 === 0) await new Promise<void>((r) => setImmediate(r)); }
  }

  /** What is in the archive and what is missing from the cache; `chatIds` limits it to those chats. Also returns the missing items. */
  async scan(accountId: string, chatIds?: string[]): Promise<{ estimate: MediaEstimate; missing: MediaRef[] }> {
    const only = chatIds?.length ? new Set(chatIds) : undefined;
    const est: MediaEstimate = { accountId, files: 0, cached: 0, missing: 0, bytes: 0, unknownSize: 0, chats: {} };
    const missing: MediaRef[] = [];
    await this.walk(accountId, (m) => {
      if (only && !only.has(m.chatId)) return;
      for (const r of mediaRefs(m)) {
        const st = (est.chats[m.chatId] ??= { files: 0, cached: 0, missing: 0, bytesMissing: 0 });
        est.files++; st.files++;
        if (this.media.has(accountId, mediaKey(m.chatId, m.id, r.attachmentId))) { est.cached++; st.cached++; continue; }
        est.missing++; st.missing++; st.bytesMissing += r.size ?? 0;
        if (r.size) est.bytes += r.size; else est.unknownSize++;
        missing.push({ chatId: m.chatId, messageId: m.id, attachmentId: r.attachmentId, size: r.size, name: r.name });
      }
    });
    return { estimate: est, missing };
  }

  running(accountId: string) { return [...this.jobs.values()].find((j) => j.p.accountId === accountId)?.p; }
  list() { return [...this.jobs.values()].map((j) => ({ ...j.p })); }
  cancel(key: string) { for (const j of this.jobs.values()) if (j.id === key || j.p.accountId === key) j.cancelled = true; return this.jobs.size > 0; }

  async start(accountId: string, chatIds?: string[], maxBytes?: number): Promise<{ jobId: string; estimate: MediaEstimate; finished: Promise<MediaProgress> }> {
    const live = this.running(accountId);
    if (live) throw new Error("Media for this account is already being downloaded.");
    if (!this.connOf(accountId)) throw new Error("This account is signed out, so its media can't be downloaded any more.");
    const { estimate, missing } = await this.scan(accountId, chatIds);
    const job = { id: `media-${++this.seq}`, cancelled: false, p: { jobId: "", accountId, total: missing.length, done: 0, failed: 0, bytes: 0, totalBytes: estimate.bytes, state: "running", finished: false } as MediaProgress };
    job.p.jobId = job.id; this.jobs.set(job.id, job);
    const gap = this.o.gapMs ?? 200, workers = Math.max(1, this.o.concurrency ?? 2), timeoutMs = this.o.timeoutMs ?? 60_000;
    let next = 0, lastEmit = 0, lastStart = 0;
    const errors: string[] = [];
    const reasons: Record<string, number> = {};
    const extra = () => ({ ...(errors.length ? { errors: errors.slice(0, 5) } : {}), ...(Object.keys(reasons).length ? { reasons: { ...reasons } } : {}) });
    const push = (force = false) => { if (force || Date.now() - lastEmit > 250) { lastEmit = Date.now(); this.emit("media-progress", { ...job.p, ...extra() }); } };
    const stop = (state: MediaProgress["state"], message?: string) => { if (job.p.state === "running") { job.p.state = state; job.p.message = message; } };
    const worker = async () => {
      for (;;) {
        if (job.cancelled) return stop("cancelled");
        if (maxBytes && job.p.bytes >= maxBytes) return stop("limit", "Stopped at the size limit you set.");
        const conn = this.connOf(accountId);
        if (!conn) return stop("stopped", "The account was signed out while downloading.");
        const i = next++; if (i >= missing.length) return;
        const r = missing[i];
        const at = Math.max(Date.now(), lastStart + gap); lastStart = at; if (at > Date.now()) await sleep(at - Date.now());
        try {
          if (this.media.has(accountId, mediaKey(r.chatId, r.messageId, r.attachmentId))) { job.p.done++; push(); continue; }
          const native = r.chatId.slice(accountId.length + 1);
          const blob = await withTimeout(conn.downloadAttachment(native, r.messageId, r.attachmentId), timeoutMs);
          this.media.put(accountId, mediaKey(r.chatId, r.messageId, r.attachmentId), blob);
          job.p.bytes += blob.data.length; job.p.done++;
        } catch (e) { job.p.failed++; job.p.done++; const why = failReason(e); reasons[why] = (reasons[why] ?? 0) + 1; if (errors.length < 5) errors.push(((e as Error).message || "failed").slice(0, 120)); }
        push();
      }
    };
    const finished = (async () => {
      this.emit("media-progress", { ...job.p });
      await Promise.all(Array.from({ length: workers }, worker));
      if (job.p.state === "running") job.p.state = "done";
      job.p.finished = true; this.jobs.delete(job.id);
      const fin = { ...job.p, ...extra() }; this.emit("media-progress", fin); return fin;
    })();
    return { jobId: job.id, estimate, finished };
  }
}
