// Hybrid logical clock. A stamp is a fixed-width string so that plain string comparison is the total order:
//   <13-digit wall ms>-<4 hex counter>-<device id>      (the device id is the deterministic tiebreak)
export const ZERO_WALL = "0000000000000-0000";
export const zeroStamp = (device: string) => `${ZERO_WALL}-${device}`;
/** Entries stamped more than this far in the future are rejected (a wrong or hostile clock must not win every conflict forever). */
export const MAX_FUTURE_MS = 24 * 3600_000;

export function parseStamp(s: string): { wall: number; counter: number; device: string } | undefined {
  const m = /^(\d{13})-([0-9a-f]{4})-(.*)$/.exec(s);
  return m ? { wall: Number(m[1]), counter: parseInt(m[2], 16), device: m[3] } : undefined;
}
export const maxStamp = (a: string, b: string) => (a >= b ? a : b);

export class Clock {
  private last = 0; private counter = 0;
  constructor(readonly device: string, private now: () => number = Date.now) {}
  tick(): string {
    const t = this.now();
    if (t > this.last) { this.last = t; this.counter = 0; } else if (++this.counter > 0xffff) { this.last++; this.counter = 0; }
    return this.fmt();
  }
  /** Fold a received stamp in; false when it is malformed or implausibly far in the future (caller must skip the entry). */
  observe(s: string): boolean {
    const p = parseStamp(s); if (!p) return false;
    if (p.wall > this.now() + MAX_FUTURE_MS) return false;
    if (p.wall > this.last) { this.last = p.wall; this.counter = p.counter; } else if (p.wall === this.last && p.counter > this.counter) this.counter = p.counter;
    return true;
  }
  state() { return { last: this.last, counter: this.counter }; }
  restore(s?: { last: number; counter: number }) { if (s && s.last > this.last) { this.last = s.last; this.counter = s.counter; } }
  private fmt() { return `${String(this.last).padStart(13, "0")}-${this.counter.toString(16).padStart(4, "0")}-${this.device}`; }
}
