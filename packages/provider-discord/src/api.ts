// Small Discord REST (v10) client on Node's fetch. Rules (see README): one request in flight at a time, human-like pacing in user
// mode, 429 / X-RateLimit-* honoured, and no error text or debug line ever contains a token, message text, names, or ids.
import { randomBytes } from "node:crypto";

const DEBUG = process.env.UNIMSG_DEBUG === "1";
/** Debug lines carry only method, a path with every id masked, no query, the status and the duration. */
export const dbg = (line: string) => { if (DEBUG) process.stderr.write(`[dc] ${line}\n`); };
const maskPath = (p: string) => p.split("?")[0].replace(/\d{5,}/g, "#");

export type Mode = "bot" | "user";
export const DEFAULT_BASE = "https://discord.com";
export const DEFAULT_GATEWAY = "wss://gateway.discord.gg";
export const DEFAULT_CDN = "https://cdn.discordapp.com";
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

/** Endpoints can only be redirected to a loopback address (used by the offline tests), never to a foreign host. */
export function endpoint(envName: string, def: string): string {
  const v = process.env[envName]; if (!v) return def;
  try { const u = new URL(v); if (LOOPBACK.test(u.hostname)) return v.replace(/\/$/, ""); } catch { /* ignore */ }
  return def;
}
const CDN_HOST = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com|discord\.gg|tenor\.com|giphy\.com)$/;
/** Media URLs come from message JSON; fetch them only from Discord / Tenor / Giphy CDNs (or the loopback fake). Never with auth headers. */
export function cdnAllowed(url: string): boolean {
  try { const u = new URL(url); return (u.protocol === "https:" && CDN_HOST.test(u.hostname)) || (u.protocol === "http:" && LOOPBACK.test(u.hostname)); } catch { return false; }
}
/** A resume_gateway_url sent by the server is only followed when it is a Discord gateway host (or loopback in tests). */
export function gatewayAllowed(url: string): boolean {
  try { const u = new URL(url); return (u.protocol === "wss:" && /(^|\.)(discord\.gg|discord\.media|discord\.com)$/.test(u.hostname)) || (u.protocol === "ws:" && LOOPBACK.test(u.hostname)); } catch { return false; }
}

export class DcError extends Error {
  readonly status: number; readonly code?: number;
  readonly kind: "auth" | "forbidden" | "notfound" | "rate" | "network" | "http" | "verify";
  readonly retryAfterMs?: number;
  constructor(message: string, kind: DcError["kind"], status = 0, code?: number, retryAfterMs?: number) {
    super(message); this.name = "DcError"; this.kind = kind; this.status = status; this.code = code; this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Discord asked for an hCaptcha (user accounts that message someone new): HTTP 400 {captcha_key:["captcha-required"], captcha_sitekey, ...}.
 * The challenge fields are only ever handed to `onCaptcha` and are never part of the message; the solved token is sent once, in the retry, and kept nowhere.
 */
export interface CaptchaChallenge { sitekey: string; service: string; rqdata?: string; rqtoken?: string }
const CAPTCHA_TEXT = "Discord wants you to solve a captcha before this (it does that when you message someone new). Solve it once in the official Discord app or website, then try again.";
export class DcCaptcha extends DcError {
  readonly sitekey: string; readonly service: string; readonly rqdata?: string; readonly rqtoken?: string;
  constructor(c: CaptchaChallenge, message = CAPTCHA_TEXT) { super(message, "verify", 400); this.name = "DcCaptcha"; this.sitekey = c.sitekey; this.service = c.service; this.rqdata = c.rqdata; this.rqtoken = c.rqtoken; }
}
/** The challenge in a captcha answer (HTTP 400), or undefined when it is some other 400. Only well-formed string fields are taken. */
function parseCaptcha(j: any): CaptchaChallenge | undefined {
  if (!j || !Array.isArray(j.captcha_key) || !j.captcha_key.includes("captcha-required")) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v.length < 8192 ? v : undefined);
  const sitekey = str(j.captcha_sitekey); if (!sitekey) return undefined;
  return { sitekey, service: str(j.captcha_service) ?? "hcaptcha", rqdata: str(j.captcha_rqdata), rqtoken: str(j.captcha_rqtoken) };
}
const CAPTCHA_WAIT_MS = 180000;

// ---------------------------------------------------------------- client identity (user mode): fixed, persisted, never rotated
export interface Identity { userAgent: string; locale: string; superProps: string; props: Record<string, string | number | null> }
export function newIdentity(): Identity {
  const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const props = {
    os: "Linux", browser: "Chrome", device: "", system_locale: "en-US", browser_user_agent: ua, browser_version: "130.0.0.0", os_version: "",
    referrer: "", referring_domain: "", release_channel: "stable", client_build_number: 350000, client_event_source: null,
  };
  return { userAgent: ua, locale: "en-US", props, superProps: Buffer.from(JSON.stringify(props)).toString("base64") };
}

export interface ApiOpts {
  base: string; token: string; mode: Mode; identity?: Identity;
  /** Minimum gap between two requests (ms); user mode adds up to 100% random jitter on top. */
  paceMs: number;
  onUnauthorized?: () => void;
  onCooldown?: (ms: number, why: string) => void;
  /** Interactive requests only: show the challenge to the user and resolve with the solved token (undefined = cancelled / gave up). Waited for at most ~3 minutes. */
  onCaptcha?: (c: CaptchaChallenge) => Promise<string | undefined>;
}

/** Longer waits than this are not slept through (the UI would hang): the call fails with a plain message and the cooldown stays in force. */
const LONG_WAIT = 15000;
type Prio = 0 | 1; // 0 = interactive (user clicked), 1 = background
interface Job { run: () => Promise<void>; fail: (e: Error) => void; prio: Prio }
interface MediaJob { url: string; prio: Prio; start: () => void; fail: (e: Error) => void; done: Promise<{ data: Uint8Array; mime: string }> }
/** CDN downloads at once. The API's pacing is for API calls (a user account must look like a person); pictures come
 *  from the CDN without the token, and the official client loads a chat's worth of them in parallel. */
const MEDIA_PARALLEL = 4;

const FRIENDLY: Record<number, string> = {
  400: "Discord rejected the request", 401: "the token is no longer valid", 403: "you do not have permission to do this here",
  404: "not found (it may have been deleted)", 413: "the file is too large for this server", 429: "rate limited by Discord",
  500: "Discord had an internal error", 502: "Discord is temporarily unavailable", 503: "Discord is temporarily unavailable", 504: "Discord timed out",
};

export class Api {
  readonly base: string; readonly mode: Mode; token: string;
  private readonly o: ApiOpts;
  private queue: Job[] = [];
  private busy = false;
  // Pictures had their own place in the API queue above: one at a time, 0.7-1.4 s apart for a user account, first come
  // first served. A chat with thirty pictures took most of a minute, top to bottom -- so the newest, at the bottom where
  // the chat opens, came last, a tap on one just waited its turn, and sending a message waited behind all of them.
  private media: MediaJob[] = [];
  private mediaRunning = 0;
  private mediaByUrl = new Map<string, MediaJob>();
  private lastEnd = 0;
  private globalUntil = 0;
  private buckets = new Map<string, number>();
  private slowUntil = 0;
  stopped = false;
  constructor(o: ApiOpts) { this.o = o; this.base = o.base + "/api/v10"; this.mode = o.mode; this.token = o.token; }

  private enqueue<T>(prio: Prio, f: () => Promise<T>): Promise<T> {
    return new Promise<T>((ok, bad) => {
      const job: Job = { prio, run: () => f().then(ok, bad), fail: bad };
      let i = this.queue.length; while (i > 0 && this.queue[i - 1].prio > prio) i--;
      this.queue.splice(i, 0, job);
      void this.pump();
    });
  }
  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let j = this.queue.shift(); j; j = this.queue.shift()) {
        if (this.stopped) { j.fail(new DcError("Stopped.", "network")); continue; }
        await this.pace();
        await j.run();
        this.lastEnd = Date.now();
      }
    } finally { this.busy = false; }
  }
  private async pace() {
    const slow = Date.now() < this.slowUntil ? 3 : 1;
    const base = this.o.paceMs * slow;
    const gap = this.mode === "user" ? base + Math.random() * base : base;
    const wait = this.lastEnd + gap - Date.now();
    if (wait > 0) await sleep(wait);
  }

  private bucketKey(method: string, path: string) {
    const p = path.split("?")[0];
    // major parameters (channel / guild / webhook) keep their id, everything else is generalised
    const m = /^\/(channels|guilds|webhooks)\/(\d+)/.exec(p);
    return method + " " + (m ? `/${m[1]}/${m[2]}` : "") + p.replace(/^\/(channels|guilds|webhooks)\/\d+/, "").replace(/\d{5,}/g, "#").replace(/\/reactions\/[^/]+/, "/reactions/:e");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Authorization: this.mode === "bot" ? `Bot ${this.token}` : this.token, ...extra };
    if (this.mode === "user" && this.o.identity) {
      h["User-Agent"] = this.o.identity.userAgent; h["X-Super-Properties"] = this.o.identity.superProps;
      h["X-Discord-Locale"] = this.o.identity.locale; h["Accept-Language"] = this.o.identity.locale + ",en;q=0.9";
    } else h["User-Agent"] = "DiscordBot (https://github.com/unimsg, 0.1)";
    return h;
  }

  /** One logical request incl. waiting out rate limits. Throws DcError with plain-English text (never the body, token or ids). */
  raw(method: string, path: string, o: { json?: unknown; form?: FormData; prio?: Prio; timeoutMs?: number } = {}): Promise<Response> {
    return this.enqueue(o.prio ?? 0, () => this.exec(method, path, o, o.prio ?? 0));
  }
  private async exec(method: string, path: string, o: { json?: unknown; form?: FormData; timeoutMs?: number }, prio: Prio = 0): Promise<Response> {
    const key = this.bucketKey(method, path);
    let captchaHeaders: Record<string, string> | undefined; // set for the single retry after a solved captcha
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(this.globalUntil, this.buckets.get(key) ?? 0) - Date.now();
      if (wait > LONG_WAIT) throw new DcError(`Discord is rate limiting this account. UniChat is pausing requests for about ${wait > 90000 ? Math.ceil(wait / 60000) + " minute(s)" : Math.ceil(wait / 1000) + " s"}.`, "rate", 429, undefined, wait);
      if (wait > 0) await sleep(wait + 20);
      const headers = this.headers(captchaHeaders);
      let body: BodyInit | undefined;
      if (o.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(o.json); } else if (o.form) body = o.form;
      const t0 = Date.now();
      let res: Response;
      try { res = await fetch(this.base + path, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs ?? 30000) }); }
      catch (e) {
        const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { name?: string }).name ?? "error";
        throw new DcError(`Cannot reach Discord (${code}).`, "network");
      }
      dbg(`${method} ${maskPath(path)} ${res.status} ${Date.now() - t0}ms`);
      const remaining = res.headers.get("x-ratelimit-remaining");
      const resetAfter = Number(res.headers.get("x-ratelimit-reset-after") ?? "");
      if (remaining === "0" && Number.isFinite(resetAfter) && resetAfter > 0) this.buckets.set(key, Date.now() + resetAfter * 1000 + 50);
      if (this.buckets.size > 500) for (const [k, v] of this.buckets) if (v < Date.now()) this.buckets.delete(k);
      if (res.status === 429) {
        const text = await res.text().catch(() => "");
        let ra = Number(res.headers.get("retry-after") ?? "");
        let global = res.headers.get("x-ratelimit-global") === "true";
        try { const j = JSON.parse(text); if (typeof j.retry_after === "number") ra = j.retry_after; if (j.global) global = true; } catch { ra = Number.isFinite(ra) && ra > 0 ? ra : 60; /* not JSON: Cloudflare-style block */ }
        if (!Number.isFinite(ra) || ra <= 0) ra = 1 + attempt;
        const ms = Math.ceil(ra * 1000) + 100 + Math.floor(Math.random() * 400);
        if (global) this.globalUntil = Math.max(this.globalUntil, Date.now() + ms); else this.buckets.set(key, Date.now() + ms);
        if (this.mode === "user") this.slowUntil = Date.now() + 10 * 60000; // after any 429 a user account slows down for 10 minutes
        this.o.onCooldown?.(ms, "rate-limit");
        dbg(`429, backing off ${Math.round(ms / 1000)}s`);
        if (attempt >= (this.mode === "user" ? 1 : 3) || ms > LONG_WAIT) throw new DcError(`Discord is rate limiting us; UniChat backs off for ${Math.max(1, Math.round(ms / 1000))} s and will try again later.`, "rate", 429, undefined, ms);
        continue;
      }
      if (res.status >= 300 && res.status < 400) { await res.arrayBuffer().catch(() => {}); throw new DcError("Discord redirected the request unexpectedly.", "http", res.status); }
      if (res.ok) return res;
      let code: number | undefined; let captcha: CaptchaChallenge | undefined;
      let badCaptcha = false;
      try { const j = (await res.json()) as { code?: number; captcha_key?: unknown }; code = j.code; if (res.status === 400) { captcha = parseCaptcha(j); badCaptcha = !captcha && Array.isArray(j.captcha_key); } } catch { /* not json */ }
      if (badCaptcha) throw new DcError("Discord did not accept the captcha answer. Solve it once in the official Discord app or website, then try again.", "verify", 400);
      if (captcha) {
        if (captchaHeaders || !this.o.onCaptcha || prio !== 0) throw new DcCaptcha(captcha); // already retried once, nobody to ask, or a background job
        const ch = captcha; let tok: string | undefined;
        try { tok = await Promise.race([this.o.onCaptcha(ch), sleep(CAPTCHA_WAIT_MS).then(() => undefined)]); } catch { tok = undefined; }
        if (!tok || typeof tok !== "string") throw new DcCaptcha(ch);
        captchaHeaders = { "X-Captcha-Key": tok, ...(ch.rqtoken ? { "X-Captcha-Rqtoken": ch.rqtoken } : {}) };
        dbg("captcha solved, retrying once");
        continue;
      }
      if (res.status === 401) { this.o.onUnauthorized?.(); throw new DcError("Discord: the token is no longer valid.", "auth", 401, code); }
      if (res.status === 403 && (code === 40002 || code === 40003)) throw new DcError("Discord asks this account to verify itself (or slow down) before it can be used. Do that in the official app, then try again.", "verify", 403, code);
      const kind = res.status === 403 ? "forbidden" : res.status === 404 ? "notfound" : "http";
      throw new DcError(`Discord: ${FRIENDLY[res.status] ?? "request failed"} (HTTP ${res.status}${code ? ", code " + code : ""}).`, kind, res.status, code);
    }
  }

  async json<T = any>(method: string, path: string, body?: unknown, prio: Prio = 0): Promise<T> {
    const res = await this.raw(method, path, { json: body, prio });
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  get<T = any>(path: string, prio: Prio = 0) { return this.json<T>("GET", path, undefined, prio); }
  /** multipart/form-data: payload_json + files[n] (the Discord way to upload attachments). */
  async upload<T = any>(path: string, payload: unknown, files: { name: string; mime: string; data: Uint8Array }[]): Promise<T> {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data as BlobPart], { type: f.mime }), f.name));
    const res = await this.raw("POST", path, { form, timeoutMs: 300000 });
    return JSON.parse(await res.text()) as T;
  }

  /** Fetch a media URL from an allow-listed CDN. No Authorization header ever. */
  fetchMedia(url: string, prio: Prio = 0): Promise<{ data: Uint8Array; mime: string }> {
    if (!cdnAllowed(url)) return Promise.reject(new DcError("Refusing to download from an unexpected host.", "http"));
    return this.mediaEnqueue(url, prio, async () => {
      let res: Response;
      try { res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(120000), headers: { "User-Agent": this.mode === "user" && this.o.identity ? this.o.identity.userAgent : "DiscordBot (https://github.com/unimsg, 0.1)" } }); }
      catch (e) { throw new DcError(`Cannot reach the Discord media server (${(e as { cause?: { code?: string } }).cause?.code ?? "error"}).`, "network"); }
      dbg(`MEDIA ${res.status}`);
      if (!res.ok) { await res.arrayBuffer().catch(() => {}); throw new DcError(`The media server answered HTTP ${res.status}.`, res.status === 404 || res.status === 403 ? "notfound" : "http", res.status); }
      return { data: new Uint8Array(await res.arrayBuffer()), mime: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0] };
    });
  }

  /**
   * A media download: a few at a time, not paced. Within a priority the most recent request goes first -- a chat opens
   * at its newest message, at the bottom, and those pictures are asked for last. One download per URL: asking again
   * while it waits (a tap on a picture that is still queued) moves it forward instead of fetching it twice.
   */
  private mediaEnqueue(url: string, prio: Prio, f: () => Promise<{ data: Uint8Array; mime: string }>): Promise<{ data: Uint8Array; mime: string }> {
    const had = this.mediaByUrl.get(url);
    if (had) {
      const i = this.media.indexOf(had);
      if (i >= 0 && prio <= had.prio) { this.media.splice(i, 1); had.prio = prio; this.placeMedia(had); } // still waiting: forward
      return had.done;
    }
    let start!: () => void, fail!: (e: Error) => void;
    const done = new Promise<{ data: Uint8Array; mime: string }>((ok, bad) => {
      fail = bad;
      start = () => { this.mediaRunning++; f().then(ok, bad).finally(() => { this.mediaRunning--; this.mediaByUrl.delete(url); this.mediaPump(); }); };
    });
    const job: MediaJob = { url, prio, start, fail, done };
    this.mediaByUrl.set(url, job); this.placeMedia(job); this.mediaPump();
    return done;
  }
  /** ahead of everything of the same or a lower priority (0 = a tap, 1 = everything else) */
  private placeMedia(j: MediaJob) { let i = 0; while (i < this.media.length && this.media[i].prio < j.prio) i++; this.media.splice(i, 0, j); }
  private mediaPump() {
    while (this.mediaRunning < MEDIA_PARALLEL && this.media.length) {
      const j = this.media.shift()!;
      if (this.stopped) { this.mediaByUrl.delete(j.url); j.fail(new DcError("Stopped.", "network")); continue; }
      j.start();
    }
  }

  /** Cancel queued work (stop/logout). */
  close() {
    this.stopped = true; const q = this.queue; this.queue = []; for (const j of q) j.fail(new DcError("Stopped.", "network"));
    const m = this.media; this.media = []; for (const j of m) { this.mediaByUrl.delete(j.url); j.fail(new DcError("Stopped.", "network")); }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const nonce = () => String((BigInt(Date.now() - 1420070400000) << 22n) | BigInt(randomBytes(2).readUInt16BE() & 0x3fffff));
