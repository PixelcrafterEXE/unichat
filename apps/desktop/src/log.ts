// The desktop app had nowhere to say anything: started from a launcher its console goes nowhere, so a problem that only
// happens on a real machine (a pairing that is refused, a connector that reconnects) left no trace at all, while the Android
// build has logcat. Everything the main process prints is mirrored into <dataDir>/logs/desktop.log, kept to the last two files.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 2 << 20; // 2 MB, then one rotation: desktop.log -> desktop.log.1

/** Mirrors console output into `dir/logs/desktop.log`. Returns the file it writes to; never throws (a log must not stop the app). */
export function startFileLog(dir: string, out: Console = console): string {
  const logs = join(dir, "logs"), file = join(logs, "desktop.log");
  try { mkdirSync(logs, { recursive: true }); } catch { return file; }
  const write = (level: string, args: unknown[]) => {
    try {
      const line = `${new Date().toISOString()} ${level} ${args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ")}\n`;
      try { if (statSync(file).size + line.length > MAX_BYTES) { rmSync(file + ".1", { force: true }); renameSync(file, file + ".1"); } } catch { /* first line, or a file that vanished */ }
      appendFileSync(file, line);
    } catch { /* a full or read-only disk must not take the app with it */ }
  };
  for (const level of ["log", "info", "warn", "error"] as const) {
    const orig = out[level].bind(out);
    out[level] = (...args: unknown[]) => { orig(...args); write(level.toUpperCase(), args); };
  }
  return file;
}
