// Lightweight start-up / stage timing + event-loop-lag log of the Android backend: <dataDir>/backend.log (capped: when it passes
// MAX_BYTES it is rotated to backend.log.1). No message content is ever logged, only stage names, counts, sizes and durations.
// Read it with: adb shell run-as app.unimsg.android cat files/unimsg-data/backend.log
// Other packages call it through globalThis.__unimsgPlog (they have no dependency on this app).
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 256 * 1024;
const t0 = Date.now();
let file = "", size = 0;

export function initPerfLog(dataDir: string) {
  file = join(dataDir, "backend.log");
  try { size = statSync(file).size; } catch { size = 0; }
  plog("start", { pid: process.pid, node: process.version });
}

export function plog(stage: string, data?: Record<string, unknown> | string | number) {
  const mem = process.memoryUsage();
  const extra = data === undefined ? "" : " " + (typeof data === "object" ? Object.entries(data).map(([k, v]) => `${k}=${v}`).join(" ") : String(data));
  const line = `${new Date().toISOString()} +${((Date.now() - t0) / 1000).toFixed(2)}s rss=${Math.round(mem.rss / 1048576)}M heap=${Math.round(mem.heapUsed / 1048576)}M ext=${Math.round((mem.external + mem.arrayBuffers) / 1048576)}M ${stage}${extra}\n`;
  if (!file) { console.log("[perf] " + line.trim()); return; }
  try {
    if (size > MAX_BYTES) { try { renameSync(file, file + ".1"); } catch { /* ignore */ } size = 0; }
    appendFileSync(file, line); size += line.length;
  } catch { /* log must never break the backend */ }
}

/** Runs `f` and logs its duration (sync or async). */
export function timed<T>(stage: string, f: () => T, data?: Record<string, unknown>): T {
  const s = Date.now();
  const done = (extra: string) => plog(stage, { ms: Date.now() - s, ...(data ?? {}), ...(extra ? { err: extra } : {}) });
  try {
    const r = f();
    if (r && typeof (r as any).then === "function") return (r as any).then((v: unknown) => { done(""); return v; }, (e: unknown) => { done(String((e as Error)?.message ?? e)); throw e; }) as T;
    done(""); return r;
  } catch (e) { done(String((e as Error)?.message ?? e)); throw e; }
}

/** Event-loop lag: a 100 ms timer; logs each stall over 500 ms and a 10 s summary while there was one (or every 60 s). */
export function startLagMonitor() {
  let last = Date.now(), worst = 0, count = 0, lastLine = Date.now();
  const t = setInterval(() => {
    const now = Date.now(), lag = now - last - 100; last = now;
    if (lag > 500) { count++; worst = Math.max(worst, lag); plog("loop-stall", { lagMs: lag }); }
    if (now - lastLine >= (count ? 10_000 : 60_000)) { plog("loop", { stalls: count, worstMs: worst, cpuUserS: (process.cpuUsage().user / 1e6).toFixed(1), cpuSysS: (process.cpuUsage().system / 1e6).toFixed(1) }); lastLine = now; worst = 0; count = 0; }
  }, 100);
  t.unref();
}

(globalThis as any).__unimsgPlog = plog;

/**
 * Diagnostics on demand: when <dataDir>/profile.on exists (its content = seconds, default 60) the V8 sampling profiler runs for that long
 * from the start of the backend and writes <dataDir>/backend.cpuprofile; the marker is removed first, so it profiles ONE start.
 * Switch it on with: adb shell run-as app.unimsg.android sh -c 'echo 90 > files/unimsg-data/profile.on'
 */
export async function maybeProfile(dataDir: string) {
  const marker = join(dataDir, "profile.on");
  if (!existsSync(marker)) return;
  let secs = 60; try { secs = Math.max(5, Math.min(300, Number(readFileSync(marker, "utf8").trim()) || 60)); } catch { /* default */ }
  try { rmSync(marker, { force: true }); } catch { /* ignore */ }
  try {
    const { Session } = await import("node:inspector");
    const s = new Session(); s.connect();
    const post = (m: string, p?: object) => new Promise<any>((ok, no) => s.post(m, p as any, (e: Error | null, r: unknown) => (e ? no(e) : ok(r))));
    await post("Profiler.enable"); await post("Profiler.setSamplingInterval", { interval: 2000 }); await post("Profiler.start");
    plog("profiler-started", { seconds: secs });
    setTimeout(() => { post("Profiler.stop").then((r) => { writeFileSync(join(dataDir, "backend.cpuprofile"), JSON.stringify(r.profile)); plog("profiler-written"); }, (e) => plog("profiler-failed", String(e?.message ?? e))); }, secs * 1000).unref();
  } catch (e) { plog("profiler-unavailable", String((e as Error)?.message ?? e)); }
}
