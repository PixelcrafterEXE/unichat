// Queue that asks the phone to resend messages we could not decrypt (placeholder resend). Pure and timer-injected so it is
// testable with a fake clock. The pending set is a plain JSON object (kept in the provider cache => survives restarts).

export interface Pending {
  chatId: string; id: string; rj?: string; pj?: string; fromMe: boolean;
  attempts: number;
  /** epoch ms when the next request (or the final give-up) is due */
  next: number;
  /** after the last request: waiting out the grace period before giving up */
  final?: boolean;
  gaveUp?: boolean;
  /** requests Baileys swallowed ("already requested") that were not counted as an attempt */
  skips?: number;
}
export interface Timers { now(): number; set(fn: () => void, ms: number): unknown; clear(h: unknown): void }
export interface ResendOptions {
  timers: Timers;
  request(e: Pending): Promise<unknown>;
  canRun(): boolean;
  onGiveUp(e: Pending): void;
  onChange(): void;
  spacingMs?: number;      // min gap between request starts
  concurrency?: number;    // Baileys blocks ~5s inside each request
  backoffMs?: number[];    // wait after request #k (k = 1..n); n+1 requests in total
  finalWaitMs?: number;    // grace after the last request before giving up
}

export class ResendQueue {
  private timer: unknown;
  private inflight = 0;
  private nextStartAt = 0;
  private readonly spacing: number; private readonly conc: number; private readonly backoff: number[]; private readonly finalWait: number;
  constructor(private readonly entries: Record<string, Pending>, private readonly o: ResendOptions) {
    this.spacing = o.spacingMs ?? 1500;
    this.conc = o.concurrency ?? 3;
    this.backoff = o.backoffMs ?? [30_000, 300_000, 3_600_000];
    this.finalWait = o.finalWaitMs ?? 120_000;
    // JSON turns the in-flight marker Infinity into null: after a restart an interrupted request is simply due again
    const now = o.timers.now();
    for (const e of Object.values(entries)) if (typeof e.next !== "number" || !Number.isFinite(e.next)) e.next = now;
  }

  /** The request was not really sent (Baileys already had one in flight): give the attempt back, at most twice. */
  skipped(id: string) {
    const e = this.entries[id];
    if (!e || (e.skips ?? 0) >= 2 || e.attempts <= 0) return;
    e.skips = (e.skips ?? 0) + 1; e.attempts--;
  }

  has(id: string) { return !!this.entries[id]; }
  size() { return Object.values(this.entries).filter((e) => !e.gaveUp).length; }
  list(chatId?: string) { return Object.values(this.entries).filter((e) => !chatId || e.chatId === chatId); }

  add(e: Pick<Pending, "chatId" | "id" | "rj" | "pj" | "fromMe">) {
    if (this.entries[e.id]) return;
    this.entries[e.id] = { ...e, attempts: 0, next: this.o.timers.now() };
    this.o.onChange();
    this.pump();
  }
  remove(id: string): boolean {
    if (!this.entries[id]) return false;
    delete this.entries[id];
    this.o.onChange();
    return true;
  }
  /** Connection (re)opened or user pressed "ask again": everything still pending is due now (given-up ones restart only with `revive`). */
  kick(revive = false) {
    const now = this.o.timers.now();
    for (const e of Object.values(this.entries)) {
      if (e.gaveUp && !revive) continue;
      if (e.gaveUp) { e.gaveUp = false; e.attempts = 0; e.final = false; }
      if (e.next !== Infinity) e.next = Math.min(e.next, now);
      if (e.final) { e.final = false; e.attempts = Math.min(e.attempts, this.backoff.length); }
    }
    this.o.onChange();
    this.pump();
  }

  private schedule(at: number) {
    if (this.timer !== undefined) this.o.timers.clear(this.timer);
    this.timer = this.o.timers.set(() => { this.timer = undefined; this.pump(); }, Math.max(0, at - this.o.timers.now()));
  }

  pump() {
    if (this.timer !== undefined) { this.o.timers.clear(this.timer); this.timer = undefined; }
    if (!this.o.canRun()) return;
    for (;;) {
      const live = Object.values(this.entries).filter((e) => !e.gaveUp && e.next !== Infinity).sort((a, b) => a.next - b.next);
      const first = live[0];
      if (!first) return;
      const now = this.o.timers.now();
      if (first.next > now) return this.schedule(first.next);
      if (first.final) { first.gaveUp = true; this.o.onGiveUp(first); this.o.onChange(); continue; }
      if (this.inflight >= this.conc) return; // a finishing request pumps again
      if (now < this.nextStartAt) return this.schedule(this.nextStartAt);
      this.nextStartAt = now + this.spacing;
      this.inflight++;
      first.attempts++;
      first.next = Infinity; // in flight
      const entry = first;
      this.o.request(entry).catch(() => {}).finally(() => {
        this.inflight--;
        if (this.entries[entry.id] === entry) {
          const t = this.o.timers.now();
          if (entry.attempts > this.backoff.length) { entry.final = true; entry.next = t + this.finalWait; }
          else entry.next = t + this.backoff[Math.max(0, entry.attempts - 1)]!;
          this.o.onChange();
        }
        this.pump();
      });
    }
  }
}
