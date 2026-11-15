// Heartbeat between the UI and an in-process backend (Android bridge). The bridge has no connection state of its own that the page can see: the backend
// may be frozen, its process may have been killed and restarted, or the WebView may have been suspended for hours. A ping tells the truth.
//   up --(downAfter missed pings)--> down  ("Reconnecting...", pending calls fail, new calls fail fast, core-connection "down")
//   down --(a ping answered)--> up         (core-connection "up": the UI reloads what it missed)
//   down for restartAfter misses --> restart() once per cooldown (the native side restarts the app process after checking for itself)
// Pure logic (timers and clock injectable) so it is unit-tested without a browser: src/heartbeat.test.ts.
export interface HeartbeatOptions {
  ping(): Promise<unknown>;
  /** Ask the native side to restart the backend process. Resolves when it was asked (the process may die right after). */
  restart?(): Promise<unknown>;
  emit(state: "up" | "down"): void;
  /** is the page visible? Hidden pages do not ping (the WebView is suspended anyway); the first ping happens on resume (kick()). */
  visible?(): boolean;
  intervalMs?: number;     // while up and visible (default 10 s)
  retryMs?: number;        // while down (default 2 s)
  timeoutMs?: number;      // one ping (default 6 s)
  downAfter?: number;      // misses before "down" (default 2)
  restartAfter?: number;   // misses before asking for a restart (default 8: ~1 min of silence)
  restartCooldownMs?: number; // (default 120 s)
  setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout; now?: () => number;
}

export class Heartbeat {
  state: "up" | "down" = "up";
  misses = 0;
  restarts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false; private stopped = true; private lastRestart = -Infinity; private gen = 0;
  private pending = new Set<(e: Error) => void>();
  private o: Required<Pick<HeartbeatOptions, "intervalMs" | "retryMs" | "timeoutMs" | "downAfter" | "restartAfter" | "restartCooldownMs">> & HeartbeatOptions;
  constructor(o: HeartbeatOptions) {
    this.o = { intervalMs: 10_000, retryMs: 2_000, timeoutMs: 6_000, downAfter: 2, restartAfter: 8, restartCooldownMs: 120_000, ...o };
  }
  private st = (f: () => void, ms: number) => (this.o.setTimeout ?? setTimeout)(f, ms);
  private ct = (t: ReturnType<typeof setTimeout>) => (this.o.clearTimeout ?? clearTimeout)(t);
  private now = () => (this.o.now ?? Date.now)();

  start() { if (!this.stopped) return; this.stopped = false; this.schedule(this.o.intervalMs); }
  stop() { this.stopped = true; if (this.timer) this.ct(this.timer); this.timer = undefined; }
  /** Wrap a transport call: fails fast while down, and fails when the heartbeat declares the backend down while it is waiting. */
  guard<T>(call: () => Promise<T>): Promise<T> {
    if (this.state === "down") return Promise.reject(new Error("Not connected to the backend. Reconnecting…"));
    return new Promise<T>((ok, err) => {
      const fail = (e: Error) => err(e);
      this.pending.add(fail);
      call().then((v) => { this.pending.delete(fail); ok(v); }, (e) => { this.pending.delete(fail); err(e); });
    });
  }
  /** Page became visible / app resumed / the network changed: check now instead of waiting for the next beat. */
  kick() { if (this.stopped) return; if (this.timer) this.ct(this.timer); this.timer = undefined; void this.beat(); }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) this.ct(this.timer);
    this.timer = this.st(() => { this.timer = undefined; void this.beat(); }, ms);
    (this.timer as any)?.unref?.();
  }
  private async beat() {
    if (this.stopped || this.running) return;
    if (this.o.visible && !this.o.visible() && this.state === "up") { this.schedule(this.o.intervalMs); return; }
    this.running = true; const gen = ++this.gen;
    let ok = false;
    try {
      ok = await new Promise<boolean>((res) => {
        const t = this.st(() => res(false), this.o.timeoutMs);
        this.o.ping().then(() => { this.ct(t); res(true); }, () => { this.ct(t); res(false); });
      });
    } catch { ok = false; }
    this.running = false;
    if (this.stopped || gen !== this.gen) return;
    if (ok) {
      this.misses = 0;
      if (this.state === "down") { this.state = "up"; this.o.emit("up"); }
    } else {
      this.misses++;
      if (this.state === "up" && this.misses >= this.o.downAfter) {
        this.state = "down"; this.o.emit("down");
        const e = new Error("Connection to the backend was lost"); for (const f of [...this.pending]) f(e); this.pending.clear();
      }
      if (this.state === "down" && this.misses >= this.o.restartAfter && this.o.restart && this.now() - this.lastRestart >= this.o.restartCooldownMs) {
        this.lastRestart = this.now(); this.restarts++; this.misses = this.o.downAfter; // give the restart time before asking again
        try { await this.o.restart(); } catch { /* the native side is gone too: nothing more to do than keep pinging */ }
      }
    }
    this.schedule(this.state === "down" || this.misses > 0 ? this.o.retryMs : this.o.intervalMs);
  }
}
