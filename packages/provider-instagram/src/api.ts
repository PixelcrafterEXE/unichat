// Thin client for Instagram's UNOFFICIAL private mobile API, on Node's fetch. Everything here is reverse-engineered knowledge
// (see README "Hypotheses"). Rules: requests are serialised and paced like a human-driven app, 429/feedback blocks open a cooldown,
// and no error text or debug line ever contains credentials, tokens, ids of people, message text or response bodies.
import { igFetch, type HttpResponse } from "./http.js";
import { createCipheriv, publicEncrypt, randomBytes, constants } from "node:crypto";
import { randomUUID } from "node:crypto";

const debugOn = () => process.env.UNIMSG_DEBUG === "1"; // read per call: tests switch it on after the module is loaded
/** Debug lines carry only method, a path with all long numbers masked, no query, the status and the duration. */
export const dbg = (line: string) => { if (debugOn()) process.stderr.write(`[ig] ${line}\n`); };
const maskPath = (p: string) => p.split("?")[0].replace(/\d{4,}/g, "#").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "#");

export const DEFAULT_BASE = "https://i.instagram.com";
export const DEFAULT_MQTT = "wss://edge-mqtt.facebook.com/mqtt";
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;
/** The API/MQTT endpoint can only be redirected to a loopback address (used by the offline tests), never to a foreign host. */
export function endpoint(envName: string, def: string): string {
  const v = process.env[envName]; if (!v) return def;
  try { const u = new URL(v); if (LOOPBACK.test(u.hostname)) return v.replace(/\/$/, ""); } catch { /* ignore */ }
  return def;
}
/** Media/avatar CDN URLs come from server JSON; fetch them only from Instagram/Facebook CDNs (or the loopback fake). Never with auth headers. */
export function cdnAllowed(url: string): boolean {
  try { const u = new URL(url); return (u.protocol === "https:" && /(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/.test(u.hostname)) || (u.protocol === "http:" && LOOPBACK.test(u.hostname)); } catch { return false; }
}

export class IgError extends Error {
  readonly status: number; readonly kind: "auth" | "bad-password" | "bad-user" | "2fa" | "challenge" | "rate" | "feedback" | "network" | "http" | "not-found";
  readonly retryAfterMs?: number; readonly data?: any;
  constructor(message: string, kind: IgError["kind"], status = 0, retryAfterMs?: number, data?: any) { super(message); this.name = "IgError"; this.kind = kind; this.status = status; this.retryAfterMs = retryAfterMs; this.data = data; }
}

// ---------------------------------------------------------------- device identity (persistent, so we never look like a new phone)
export interface Device { uuid: string; phoneId: string; androidId: string; deviceId: string; adId: string; pigeonSession: string; userAgent: string; appVersion: string; versionCode: string; bloksVersion: string }
export function newDevice(): Device {
  const appVersion = "275.0.0.27.98", versionCode = "458229237";
  return {
    uuid: randomUUID(), phoneId: randomUUID(), deviceId: randomUUID(), adId: randomUUID(), pigeonSession: randomUUID(),
    androidId: "android-" + randomBytes(8).toString("hex"),
    appVersion, versionCode, bloksVersion: "5f56efad68e1edec7801f630b5c122704ec5378adbee6609a448f105f34a9c73",
    userAgent: `Instagram ${appVersion} Android (29/10; 420dpi; 1080x2137; samsung; SM-G973F; beyond1; exynos9820; en_US; ${versionCode})`,
  };
}

// ---------------------------------------------------------------- password encryption (#PWD_INSTAGRAM:4)
/** publicKeyB64 = base64 of the PEM the server announces in the `ig-set-password-encryption-pub-key` header. */
export function encryptPassword(password: string, keyId: string, publicKeyB64: string, now = Math.floor(Date.now() / 1000)): string {
  const key = randomBytes(32), iv = randomBytes(12);
  const pem = Buffer.from(publicKeyB64, "base64").toString("utf8");
  const rsa = publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, key);
  const c = createCipheriv("aes-256-gcm", key, iv); c.setAAD(Buffer.from(String(now)));
  const enc = Buffer.concat([c.update(password, "utf8"), c.final()]);
  const len = Buffer.alloc(2); len.writeUInt16LE(rsa.length);
  const blob = Buffer.concat([Buffer.from([1, Number(keyId)]), iv, len, rsa, c.getAuthTag(), enc]);
  return `#PWD_INSTAGRAM:4:${now}:${blob.toString("base64")}`;
}

// ---------------------------------------------------------------- session
export interface Session { authorization?: string; userId: string; username?: string; mid?: string; rur?: string; csrf?: string }

export interface ApiOpts { base: string; device: Device; getSession: () => Session | undefined; setSession: (patch: Partial<Session>) => void; paceMs: number; onBlocked: (ms: number, why: string) => void }

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
export const sleepAbortable = (ms: number, sig?: AbortSignal) => new Promise<void>((ok) => { if (sig?.aborted) return ok(); const t = setTimeout(done, ms); sig?.addEventListener("abort", done, { once: true }); function done() { clearTimeout(t); ok(); } });

export class Api {
  blockedUntil = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  private readonly o: ApiOpts;
  constructor(o: ApiOpts) { this.o = o; }
  get base() { return this.o.base; }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const d = this.o.device, s = this.o.getSession();
    const h: Record<string, string> = {
      "User-Agent": d.userAgent, "Accept-Language": "en-US", "Accept-Encoding": "gzip, deflate",
      "X-IG-App-ID": "567067343352427", "X-IG-Device-ID": d.deviceId, "X-IG-Android-ID": d.androidId,
      "X-IG-App-Locale": "en_US", "X-IG-Device-Locale": "en_US", "X-IG-Mapped-Locale": "en_US",
      "X-Pigeon-Session-Id": d.pigeonSession, "X-Pigeon-Rawclienttime": (Date.now() / 1000).toFixed(3),
      "X-IG-Connection-Type": "WIFI", "X-IG-Capabilities": "3brTvx0=", "X-IG-Bandwidth-Speed-KBPS": "-1.000",
      "X-Bloks-Version-Id": d.bloksVersion, "X-FB-HTTP-Engine": "Liger", "X-Bloks-Is-Layout-RTL": "false",
      ...extra,
    };
    if (s) {
      if (s.authorization) h["Authorization"] = s.authorization;
      h["IG-U-DS-USER-ID"] = s.userId; h["IG-INTENDED-USER-ID"] = s.userId;
      if (s.mid) h["X-MID"] = s.mid;
      if (s.rur) h["IG-U-RUR"] = s.rur;
    } else h["IG-INTENDED-USER-ID"] = "0";
    return h;
  }

  /** Serialised + paced. Waits `paceMs` (+ up to 100% jitter) after the previous request so bursts never happen. */
  private slot<T>(f: () => Promise<T>): Promise<T> {
    const run = async () => {
      const gap = this.o.paceMs ? this.o.paceMs * (1 + Math.random()) : 0;
      const wait = this.last + gap - Date.now(); if (wait > 0) await sleep(wait);
      try { return await f(); } finally { this.last = Date.now(); }
    };
    const p = this.chain.then(run, run); this.chain = p.catch(() => undefined); return p;
  }

  /** Raw request. Body: object => form-encoded `signed_body=SIGNATURE.<json>` when signed, else plain form; Uint8Array => sent as is. */
  async request(method: "GET" | "POST", path: string, o: { form?: Record<string, unknown>; signed?: boolean; body?: Uint8Array; headers?: Record<string, string>; anon?: boolean; noBlock?: boolean; allowError?: boolean } = {}): Promise<{ status: number; json: any; headers: Headers }> {
    if (!o.noBlock && Date.now() < this.blockedUntil) throw new IgError(`Instagram asked this client to slow down. Trying again in about ${Math.ceil((this.blockedUntil - Date.now()) / 60000)} min.`, "rate", 429, this.blockedUntil - Date.now());
    return this.slot(async () => {
      const t = Date.now();
      let body: BodyInit | undefined; const h = this.headers(o.headers);
      if (o.anon) delete h["Authorization"];
      if (o.body) { body = o.body as unknown as BodyInit; }
      else if (o.form) {
        h["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
        body = o.signed ? "signed_body=SIGNATURE." + encodeURIComponent(JSON.stringify(o.form))
          : new URLSearchParams(Object.entries(o.form).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
      }
      let res: HttpResponse;
      try { res = await igFetch(this.o.base + path, { method, headers: h, body, redirect: "manual", signal: AbortSignal.timeout(30000) }); }
      catch { dbg(`${method} ${maskPath(path)} network-error`); throw new IgError("Could not reach Instagram. Check the network connection.", "network"); }
      dbg(`${method} ${maskPath(path)} ${res.status} ${Date.now() - t}ms`);
      this.learn(res);
      let json: any = undefined; const txt = await res.text().catch(() => "");
      try { json = txt ? JSON.parse(txt) : undefined; } catch { /* not JSON */ }
      if (res.status >= 300 && res.status < 400) throw new IgError("Instagram redirected the request (possible block).", "http", res.status);
      if (!o.allowError && (res.status >= 400 || json?.status === "fail")) throw this.classify(res.status, json, res.headers, !!o.noBlock); // allowError: the caller only wants the headers
      return { status: res.status, json, headers: res.headers };
    });
  }
  async json<T = any>(method: "GET" | "POST", path: string, o: Parameters<Api["request"]>[2] = {}): Promise<T> { return (await this.request(method, path, o)).json as T; }

  /** Keep rotating session material (Instagram updates these on nearly every response). */
  private learn(res: HttpResponse) {
    const auth = res.headers.get("ig-set-authorization"), mid = res.headers.get("ig-set-x-mid"), rur = res.headers.get("ig-set-ig-u-rur"), uid = res.headers.get("ig-set-ig-u-ds-user-id");
    const patch: Partial<Session> = {};
    if (auth && auth !== "Bearer IGT:2:") patch.authorization = auth;
    if (mid) patch.mid = mid; if (rur) patch.rur = rur;
    if (uid && !this.o.getSession()) patch.userId = uid;
    for (const c of res.headers.getSetCookie?.() ?? []) { const m = /^csrftoken=([^;]+)/.exec(c); if (m) patch.csrf = m[1]; }
    if (Object.keys(patch).length) this.o.setSession(patch);
  }

  private classify(status: number, j: any, h: Headers, noBlock: boolean): IgError {
    const msg = String(j?.message ?? ""), type = String(j?.error_type ?? "");
    if (j?.two_factor_required) return new IgError("Two-factor authentication required.", "2fa", status, undefined, j);
    if (/code_invalid|invalid_code|code_validation/i.test(type)) return new IgError("That code was not accepted. Check it and try again.", "http", status);
    if (type === "bad_password" || /password you entered is incorrect|bad_password/i.test(msg)) return new IgError("Wrong username or password.", "bad-password", status);
    if (type === "invalid_user" || /can't find an account|invalid_user/i.test(msg)) return new IgError("Instagram answered \"no such account\". If the username is right, this usually means Instagram is refusing this unofficial login (new device or network, VPN, an account made with Facebook login), not that the account is gone. Open Instagram in the phone app once, approve any \"Was this you?\" prompt, then try again from the same network. Check the spelling and try your e-mail address if it keeps failing.", "bad-user", status);
    if (type === "needs_upgrade" || /version of Instagram is out of date/i.test(msg)) return new IgError("Instagram refuses this client as an outdated app, so the unofficial login no longer works (your password was not the problem). Instagram checks the app version and fingerprint; there is nothing to fix on your side.", "http", status);
    if (/challenge|checkpoint/i.test(msg + type) || j?.challenge) return new IgError("Instagram wants to verify that it is really you (checkpoint).", "challenge", status, undefined, j);
    if (/login_required/i.test(msg) || (status === 401 && !j?.two_factor_info)) return new IgError("Instagram no longer accepts the saved session.", "auth", status);
    if (status === 429 || /rate_limit|too many|wait a few minutes/i.test(msg + type)) {
      const ra = Number(h.get("retry-after")); const ms = (ra > 0 ? ra * 1000 : 5 * 60_000) + Math.random() * 5000;
      if (!noBlock) { this.blockedUntil = Date.now() + ms; this.o.onBlocked(ms, "rate"); }
      return new IgError("Instagram is rate limiting this client.", "rate", status, ms);
    }
    if (/feedback_required|sentry_block|action_blocked|spam/i.test(msg + type)) {
      if (!noBlock) { this.blockedUntil = Date.now() + 30 * 60_000; this.o.onBlocked(30 * 60_000, "feedback"); }
      return new IgError("Instagram temporarily restricted this action (anti-spam block). The client now pauses.", "feedback", status, 30 * 60_000);
    }
    if (status === 404) return new IgError("Not found on Instagram.", "not-found", status);
    return new IgError(`Instagram refused the request (HTTP ${status}).`, "http", status);
  }

  /** Binary download from a CDN: allowlisted hosts only, never with credentials. */
  async download(url: string): Promise<{ data: Uint8Array; mime: string }> {
    if (!cdnAllowed(url)) throw new IgError("Refusing to download from an unexpected host.", "http");
    return this.slot(async () => {
      let res: HttpResponse;
      try { res = await igFetch(url, { headers: { "User-Agent": this.o.device.userAgent }, redirect: "error", signal: AbortSignal.timeout(60000) }); }
      catch { throw new IgError("Could not download the media.", "network"); }
      dbg(`GET <cdn> ${res.status}`);
      if (!res.ok) throw new IgError(`Media download failed (HTTP ${res.status}).`, "http", res.status);
      return { data: new Uint8Array(await res.arrayBuffer()), mime: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0] };
    });
  }
}
