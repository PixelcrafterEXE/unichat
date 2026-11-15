// "Mark as read" written back to the services: a rate-limited, cancelable batch over many chats with progress and partial-failure reporting.
export type ReadStatus = "ok" | "local" | "failed";
/** `local`: nothing could/should be sent to the service (no support, receipts switched off, signed out, no stored message): the caller clears its local counter only. */
export interface ReadResult { chatId: string; status: ReadStatus; reason?: "no-support" | "receipts-off" | "signed-out" | "no-messages" | "error"; error?: string }
export interface ReadProgress {
  jobId: string; scope: string; total: number; done: number; ok: number; local: number; failed: number; finished: boolean; cancelled?: boolean;
  /** Only on the final event: every chat that did not succeed on the service. */
  failures?: ReadResult[];
  /** Only on the final event: chats whose counter should be cleared locally (ok + local), as chat ids of the rows the UI lists (merge ids for merged chats). */
  cleared?: string[];
}

export class ReadJobs {
  private jobs = new Map<string, { cancelled: boolean }>();
  private last = 0; private seq = 0;
  constructor(private emit: (e: string, d: unknown) => void, private gapMs = 330) {}
  setGap(ms: number) { this.gapMs = ms; }
  /** Space provider calls apart (shared by every job and single calls) so a "mark all" never floods a service. */
  async throttle() {
    const now = Date.now(), at = Math.max(now, this.last + this.gapMs);
    this.last = at;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
  cancel(jobId: string) { const j = this.jobs.get(jobId); if (j) j.cancelled = true; return !!j; }
  /**
   * `items`: one per row the UI lists; `run` marks one row (a merged row marks all its members) and says what happened.
   * Returns the job id immediately; `finished` resolves with the final progress.
   */
  start(scope: string, items: string[], run: (id: string) => Promise<ReadResult>): { jobId: string; total: number; finished: Promise<ReadProgress> } {
    const jobId = `read-${++this.seq}`, ctl = { cancelled: false }; this.jobs.set(jobId, ctl);
    const p: ReadProgress = { jobId, scope, total: items.length, done: 0, ok: 0, local: 0, failed: 0, finished: false };
    const failures: ReadResult[] = [], cleared: string[] = [];
    const finished = (async () => {
      this.emit("mark-read-progress", { ...p });
      for (const id of items) {
        if (ctl.cancelled) break;
        let r: ReadResult;
        try { r = await run(id); } catch (e) { r = { chatId: id, status: "failed", reason: "error", error: (e as Error).message }; }
        p[r.status]++; p.done++;
        if (r.status === "failed") failures.push(r); else cleared.push(id);
        this.emit("mark-read-progress", { ...p });
      }
      p.finished = true; if (ctl.cancelled) p.cancelled = true;
      const final = { ...p, failures, cleared };
      this.jobs.delete(jobId); this.emit("mark-read-progress", final); return final;
    })();
    return { jobId, total: items.length, finished };
  }
}
