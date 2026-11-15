// Disk cache for profile pictures: <dir>/<hash>.img + <hash>.json. Positive 7 days, negative 1 day.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const POSITIVE_TTL_MS = 7 * 24 * 3600_000;
export const NEGATIVE_TTL_MS = 24 * 3600_000;

export interface AvatarMeta { t: number; neg?: boolean; mime?: string; ttl?: number }
export const isFresh = (m: AvatarMeta, now: number): boolean => now - m.t < (m.ttl ?? (m.neg ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS));

export type AvatarFailure = "absent" | "hidden" | "ratelimit" | "transient";
/**
 * Baileys query errors are Boom(message = error node text, data = numeric code) whose output.statusCode is always 500,
 * so classify by data/message: item-not-found/404 = no picture, not-authorized/401/403 = privacy, rate-overlimit/429 = back off.
 */
export function classifyAvatarError(e: unknown): AvatarFailure {
  const data = (e as { data?: unknown } | undefined)?.data;
  const code = typeof data === "number" ? data : undefined;
  const msg = (e as Error | undefined)?.message ?? "";
  if (code === 429 || /rate-overlimit|rate.?limit|too many/i.test(msg)) return "ratelimit";
  if (code === 404 || /item-not-found/i.test(msg)) return "absent";
  if (code === 401 || code === 403 || /not-authorized|forbidden/i.test(msg)) return "hidden";
  return "transient"; // timeouts, closed connection, 5xx, anything unknown: never cache
}

export const withTimeout = <T>(ms: number, p: Promise<T>, onTimeout: T): Promise<T> =>
  new Promise<T>((resolve) => { const t = setTimeout(() => resolve(onTimeout), ms); p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(onTimeout); }); });

export type CacheResult =
  | { state: "hit"; data: Uint8Array; mime: string; fresh: boolean }
  | { state: "none"; fresh: boolean } // known: no picture
  | { state: "miss" };

export class AvatarCache {
  constructor(private dir: string) {}
  private base(jid: string) { return join(this.dir, createHash("sha1").update(jid).digest("hex").slice(0, 24)); }

  get(jid: string, now = Date.now()): CacheResult {
    try {
      const b = this.base(jid);
      const meta = JSON.parse(readFileSync(b + ".json", "utf8")) as AvatarMeta;
      const fresh = isFresh(meta, now);
      if (meta.neg) return { state: "none", fresh };
      return { state: "hit", data: new Uint8Array(readFileSync(b + ".img")), mime: meta.mime ?? "image/jpeg", fresh };
    } catch { return { state: "miss" }; }
  }
  remove(jid: string) { const b = this.base(jid); rmSync(b + ".img", { force: true }); rmSync(b + ".json", { force: true }); }
  putPositive(jid: string, data: Uint8Array, mime: string, now = Date.now()) {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const b = this.base(jid);
      writeFileSync(b + ".img", data, { mode: 0o600 });
      writeFileSync(b + ".json", JSON.stringify({ t: now, mime } satisfies AvatarMeta), { mode: 0o600 });
    } catch { /* cache is best effort */ }
  }
  putNegative(jid: string, now = Date.now(), ttl?: number) {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.base(jid) + ".json", JSON.stringify({ t: now, neg: true, ...(ttl ? { ttl } : {}) } satisfies AvatarMeta), { mode: 0o600 });
    } catch { /* ignore */ }
  }
}

/** Run at most `n` async tasks at once. */
export function limiter(n: number) {
  let active = 0;
  const q: (() => void)[] = [];
  const next = () => { active--; q.shift()?.(); };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => q.push(r));
    active++;
    try { return await fn(); } finally { next(); }
  };
}
