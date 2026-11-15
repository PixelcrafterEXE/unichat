// Durable job scheduler. Jobs live in the Store, so they survive restarts; a
// single timer wakes the loop at the next due time. Failures retry with
// exponential backoff. Runs wherever the Hub runs (in-app or standalone).
import { randomUUID } from "node:crypto";
import type { Job, Store } from "./store.js";

type Handler = (payload: any) => Promise<void>;
/** A handler throws this when the job cannot run NOW but should later (e.g. the device that holds the account is offline): it stays pending, nothing is counted as a failed try. */
export class JobWaiting extends Error { constructor(reason: string, public waitMs = 30_000) { super(reason); this.name = "JobWaiting"; } }
/** A handler throws this when the job must not run any more (late, not allowed): it is marked failed at once; `late` = it was too old to send. */
export class JobAbort extends Error { constructor(reason: string, public late = false) { super(reason); this.name = "JobAbort"; } }
const mark = (j: Job, k: string, v: boolean) => { if (j.payload && typeof j.payload === "object") { if (v) (j.payload as any)[k] = true; else delete (j.payload as any)[k]; } };
const MAX_TIMER = 2 ** 31 - 1;

export class Scheduler {
  private handlers = new Map<string, Handler>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private started = false;

  constructor(private store: Store, private onChange: (j: Job) => void = () => {}) {}

  register(kind: string, h: Handler) { this.handlers.set(kind, h); }

  enqueue(o: { kind: string; payload: unknown; runAt?: number; maxAttempts?: number }): Job {
    const job: Job = { id: randomUUID(), kind: o.kind, payload: o.payload, runAt: o.runAt ?? Date.now(),
      attempts: 0, maxAttempts: o.maxAttempts ?? 6, status: "pending" };
    this.store.putJob(job);
    this.onChange(job);
    this.arm();
    return job;
  }

  /** Only pending jobs can be cancelled. */
  cancel(id: string): boolean {
    const j = this.store.getJob(id);
    if (!j || j.status !== "pending") return false;
    j.status = "failed"; j.lastError = "cancelled";
    this.store.putJob(j); this.onChange(j);
    return true;
  }

  /** Run the jobs that are waiting for something (see JobWaiting) right now, e.g. because that something just came back. */
  wake() {
    let n = 0;
    for (const j of this.store.listJobs("pending")) if ((j.payload as any)?.waiting && j.runAt > Date.now()) { j.runAt = Date.now(); this.store.putJob(j); n++; }
    if (n) this.arm(); return n;
  }
  /** A failed job the user does not want any more: gone from the list (kept as done, nothing is deleted from the store). */
  discard(id: string): boolean {
    const j = this.store.getJob(id); if (!j || j.status !== "failed") return false;
    j.status = "done"; j.lastError = "discarded"; this.store.putJob(j); this.onChange(j); return true;
  }
  start() { this.started = true; this.arm(); }
  stop() { this.started = false; clearTimeout(this.timer); }

  private arm() {
    if (!this.started) return;
    clearTimeout(this.timer);
    const next = this.store.nextRunAt();
    if (next === undefined) return;
    this.timer = setTimeout(() => void this.tick(), Math.min(Math.max(next - Date.now(), 0), MAX_TIMER));
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const job of this.store.dueJobs(Date.now())) {
        const h = this.handlers.get(job.kind);
        try {
          if (!h) throw new Error(`no handler for job kind "${job.kind}"`);
          await h(job.payload);
          job.status = "done"; mark(job, "waiting", false);
        } catch (e: any) {
          if (e instanceof JobWaiting) { job.lastError = e.message; mark(job, "waiting", true); job.runAt = Date.now() + e.waitMs; this.store.putJob(job); this.onChange(job); continue; }
          if (e instanceof JobAbort) { job.status = "failed"; job.lastError = e.message; mark(job, "waiting", false); mark(job, e.late ? "late" : "aborted", true); this.store.putJob(job); this.onChange(job); continue; }
          job.attempts++;
          job.lastError = String(e?.message ?? e);
          if (job.attempts >= job.maxAttempts) job.status = "failed";
          else job.runAt = Date.now() + Math.min(2 ** job.attempts * 1000, 15 * 60_000); // 2s,4s,… cap 15min
        }
        this.store.putJob(job);
        this.onChange(job);
      }
    } finally {
      this.running = false;
      this.arm(); // re-arm for the next due job (or a retry we just scheduled)
    }
  }
}
