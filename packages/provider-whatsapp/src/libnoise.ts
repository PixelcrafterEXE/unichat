// Noise from libraries that write straight to the console (libsignal-node) or log per-message errors (Baileys): classified and
// COUNTED instead of dumped. Real errors (anything not recognised here) pass through untouched. Pure except installConsoleFilter.

/** Kind of a libsignal console line, or undefined when it is not known noise. Only the first (string) argument is inspected. */
export function classifyConsole(args: unknown[]): string | undefined {
  const a = args[0];
  if (typeof a !== "string") return undefined;
  if (a.startsWith("Failed to decrypt message with any known session")) return "signal-no-session";
  if (a.startsWith("Session error:")) return /Bad MAC/i.test(a) ? "signal-bad-mac" : "signal-session-error";
  if (a.startsWith("Decrypted message with closed session")) return "signal-closed-session";
  // libsignal dumps whole session entries on these: never let them reach a log
  if (/^(Closing session:|Opening session:|Removing old closed session:|Migrating session to:|Session already (closed|open)|Closing open session in favor)/.test(a)) return "signal-session-lifecycle";
  if (a.startsWith("WARNING: Expected pubkey of length 33")) return "signal-pubkey";
  return undefined;
}

/** Kind of a Baileys logger.error line about a failed decrypt (message text is static; `err` carries the reason). */
export function classifyDecryptError(msg: string, errMessage: string | undefined): string | undefined {
  if (msg !== "failed to decrypt message") return undefined;
  const e = errMessage ?? "";
  if (/Bad MAC/i.test(e)) return "decrypt-bad-mac";
  if (/No matching sessions/i.test(e)) return "decrypt-no-session";
  if (/No session found|No session record|No sessions/i.test(e)) return "decrypt-no-session";
  if (/SenderKey/i.test(e)) return "decrypt-no-sender-key";
  if (/Invalid PreKey|PreKey|Key used already/i.test(e)) return "decrypt-prekey";
  return "decrypt-other";
}

export class NoiseCounter {
  private counts = new Map<string, number>();
  private total = new Map<string, number>();
  bump(kind: string) { this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1); this.total.set(kind, (this.total.get(kind) ?? 0) + 1); }
  /** One summary line (counts since the last call), or undefined when nothing happened. Resets the interval counts. */
  take(): string | undefined {
    if (!this.counts.size) return undefined;
    const line = [...this.counts].sort().map(([k, n]) => `${k}=${n}`).join(" ");
    this.counts.clear();
    return line;
  }
  totalOf(kind: string) { return this.total.get(kind) ?? 0; }
}

type ConsoleFn = (...a: unknown[]) => void;
const INSTALLED = "__unimsgConsoleFilter";
/**
 * Replace console.{log,info,warn,error} once per process by wrappers that swallow known libsignal noise (counting it) and forward
 * everything else unchanged. Safe to call repeatedly; the counter of the first call wins.
 */
export function installConsoleFilter(counter: NoiseCounter, target: Record<string, unknown> = console as unknown as Record<string, unknown>): boolean {
  if (target[INSTALLED]) return false;
  for (const name of ["log", "info", "warn", "error"] as const) {
    const orig = target[name] as ConsoleFn;
    target[name] = (...args: unknown[]) => {
      const kind = classifyConsole(args);
      if (kind) { counter.bump(kind); return; }
      orig.apply(target, args);
    };
  }
  target[INSTALLED] = true;
  return true;
}
