// Microsoft Entra ID (device code + refresh) and Microsoft Graph v1.0 client on Node's fetch.
// Rules: one request in flight at a time (interactive calls before background polls), paced, 429 / Retry-After honoured,
// the Graph token is only ever sent to the Graph origin, and no error text or debug line contains a token, message text, names or ids.
import type { Session } from "./secret.js";

const DEBUG = process.env.UNIMSG_DEBUG === "1";
/** Debug lines carry only the method, a path with every id-like segment masked, no query, the status and the duration. */
export const dbg = (line: string) => { if (DEBUG) process.stderr.write(`[teams] ${line}\n`); };
export const maskPath = (p: string) => p.split("?")[0].split("/").map((s) => (/^[A-Za-z$]{1,32}(\(\))?$/.test(s) || s === "" || s === "v1.0" ? s : "#")).join("/");

export const DEFAULT_AUTH = "https://login.microsoftonline.com";
export const DEFAULT_GRAPH = "https://graph.microsoft.com/v1.0";
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;
/** Endpoints can only be redirected to a loopback address (used by the offline tests), never to a foreign host. */
export function endpoint(envName: string, def: string): string {
  const v = process.env[envName]; if (!v) return def;
  try { const u = new URL(v); if (u.protocol === "http:" && LOOPBACK.test(u.hostname)) return v.replace(/\/$/, ""); } catch { /* ignore */ }
  return def;
}
export const isLoopback = (url: string) => { try { return LOOPBACK.test(new URL(url).hostname); } catch { return false; } };
/** Hosts that may serve public media (GIFs, stickers) referenced from message JSON. Fetched WITHOUT any auth header. */
const MEDIA_HOST = /(^|\.)(giphy\.com|tenor\.com|microsoft\.com|office\.net|office365\.com|teams\.microsoft\.com|sharepoint\.com|asm\.skype\.com|skype\.com)$/;
export function mediaAllowed(url: string): boolean {
  try { const u = new URL(url); return (u.protocol === "https:" && MEDIA_HOST.test(u.hostname)) || (u.protocol === "http:" && LOOPBACK.test(u.hostname)); } catch { return false; }
}

export class GraphError extends Error {
  readonly status: number; readonly code?: string;
  readonly kind: "auth" | "forbidden" | "notfound" | "rate" | "network" | "http";
  readonly retryAfterMs?: number;
  constructor(message: string, kind: GraphError["kind"], status = 0, code?: string, retryAfterMs?: number) {
    super(message); this.name = "GraphError"; this.kind = kind; this.status = status; this.code = code; this.retryAfterMs = retryAfterMs;
  }
}
const FRIENDLY: Record<number, string> = {
  400: "Microsoft Graph rejected the request", 401: "the sign-in is no longer valid", 403: "your account or the app registration is not allowed to do this (missing permission or admin consent)",
  404: "not found (it may have been deleted)", 409: "conflict", 413: "the file is too large", 423: "the resource is locked", 429: "rate limited by Microsoft",
  500: "Microsoft Graph had an internal error", 502: "Microsoft Graph is temporarily unavailable", 503: "Microsoft Graph is temporarily unavailable", 504: "Microsoft Graph timed out",
};

// ---------------------------------------------------------------- Entra ID
export interface TokenResponse { access_token: string; refresh_token?: string; expires_in: number; scope?: string; id_token?: string }
export interface DeviceCode { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }
export class AuthError extends Error {
  /** "revoked": the grant is gone (re-login needed); "pending"/"slow"/"declined"/"expired": device flow states; "network": transient; "bad": rejected input. */
  readonly kind: "revoked" | "pending" | "slow" | "declined" | "expired" | "network" | "bad";
  constructor(message: string, kind: AuthError["kind"]) { super(message); this.name = "AuthError"; this.kind = kind; }
}
const AUTH_ERRORS: Record<string, [AuthError["kind"], string]> = {
  authorization_pending: ["pending", "waiting for approval"], slow_down: ["slow", "slow down"],
  authorization_declined: ["declined", "The sign-in was declined."], access_denied: ["declined", "The sign-in was declined."],
  expired_token: ["expired", "The sign-in code expired. Please start again."], code_expired: ["expired", "The sign-in code expired. Please start again."],
  bad_verification_code: ["expired", "The sign-in code is no longer valid. Please start again."],
  invalid_grant: ["revoked", "The saved Microsoft sign-in is no longer valid."], interaction_required: ["revoked", "Microsoft requires you to sign in again."],
  invalid_client: ["bad", "Microsoft does not know this client id (application id), or the app registration is not a public client with 'Allow public client flows' enabled."],
  unauthorized_client: ["bad", "This app registration may not use the device code flow. Enable 'Allow public client flows' in Entra."],
  invalid_scope: ["bad", "Microsoft rejected the requested permissions. Check the API permissions of the app registration."],
  invalid_request: ["bad", "Microsoft rejected the sign-in request. Check the tenant and client id."],
};
async function authPost<T>(authority: string, tenant: string, path: string, form: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${authority}/${tenant}/oauth2/v2.0/${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(30_000) });
  } catch { throw new AuthError("Could not reach Microsoft sign-in (network problem).", "network"); }
  let j: any = null; try { j = await res.json(); } catch { /* not json */ }
  dbg(`POST /oauth2/v2.0/${path} ${res.status}`);
  if (res.ok && j) return j as T;
  const e = typeof j?.error === "string" ? j.error : "";
  const known = AUTH_ERRORS[e];
  if (known) throw new AuthError(known[1], known[0]);
  if (res.status >= 500 || res.status === 429) throw new AuthError("Microsoft sign-in is temporarily unavailable.", "network");
  if (res.status === 400 || res.status === 401) throw new AuthError("Microsoft rejected the sign-in request.", "bad");
  throw new AuthError(`Microsoft sign-in failed (HTTP ${res.status}).`, "network");
}
export const requestDeviceCode = (authority: string, tenant: string, clientId: string, scope: string) =>
  authPost<DeviceCode>(authority, tenant, "devicecode", { client_id: clientId, scope });
export const pollDeviceToken = (authority: string, tenant: string, clientId: string, deviceCode: string) =>
  authPost<TokenResponse>(authority, tenant, "token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: deviceCode });
export const refreshToken = (authority: string, s: Session) =>
  authPost<TokenResponse>(authority, s.tenant, "token", { grant_type: "refresh_token", client_id: s.clientId, refresh_token: s.refreshToken, scope: s.scope });

/** Reads claims from an id_token WITHOUT verifying it: only used for the tenant id (`tid`) and user object id (`oid`) of our own sign-in. */
export function idClaims(idToken?: string): { tid?: string; oid?: string } {
  try { const p = JSON.parse(Buffer.from(idToken!.split(".")[1], "base64url").toString("utf8")); return { tid: typeof p.tid === "string" ? p.tid : undefined, oid: typeof p.oid === "string" ? p.oid : undefined }; } catch { return {}; }
}

// ---------------------------------------------------------------- Graph
export interface ApiOpts {
  base: string;
  /** A valid access token (refreshing as needed). `force` = the previous one was rejected. Throws AuthError("revoked") when the grant is gone. */
  token: (force?: boolean) => Promise<string>;
  paceMs: number;
  onRevoked?: () => void;
  onCooldown?: (ms: number) => void;
}
const LONG_WAIT = 20_000;
type Prio = 0 | 1; // 0 = interactive, 1 = background polling
interface Job { run: () => Promise<void>; prio: Prio }
export interface ReqOpts { body?: unknown; raw?: Uint8Array; contentType?: string; prio?: Prio; absolute?: boolean; noAuth?: boolean; signal?: AbortSignal }
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export class Graph {
  readonly base: string;
  private readonly o: ApiOpts;
  private queue: Job[] = [];
  private busy = false;
  private lastEnd = 0;
  /** No request is sent before this time (set by 429s). */
  cooldownUntil = 0;
  stopped = false;
  constructor(o: ApiOpts) { this.o = o; this.base = o.base; }

  private enqueue<T>(prio: Prio, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((ok, bad) => {
      const job: Job = { prio, run: async () => { try { ok(await fn()); } catch (e) { bad(e); } } };
      const i = this.queue.findIndex((j) => j.prio > prio);
      if (i < 0) this.queue.push(job); else this.queue.splice(i, 0, job);
      void this.pump();
    });
  }
  private async pump() {
    if (this.busy) return; this.busy = true;
    try {
      for (let j = this.queue.shift(); j; j = this.queue.shift()) {
        const gap = this.o.paceMs - (Date.now() - this.lastEnd);
        if (gap > 0) await sleep(gap);
        await j.run(); this.lastEnd = Date.now();
      }
    } finally { this.busy = false; }
  }

  /** JSON request. `path` is relative to the Graph base, or an absolute @odata.nextLink / deltaLink (only followed when it stays on the Graph origin). */
  async json<T = any>(method: string, path: string, o: ReqOpts = {}): Promise<T> {
    const r = await this.request(method, path, o);
    if (r.status === 204 || r.status === 202) return undefined as T;
    const t = await r.text(); if (!t) return undefined as T;
    try { return JSON.parse(t) as T; } catch { throw new GraphError("Microsoft Graph returned an unreadable answer.", "http", r.status); }
  }
  /** A request whose interesting answer is in the HEADERS (202 Accepted + Location / Content-Location, e.g. creating a team). */
  async headers(method: string, path: string, o: ReqOpts = {}): Promise<Headers> {
    const r = await this.request(method, path, o); void r.body?.cancel().catch(() => {}); return r.headers;
  }
  async bytes(path: string, o: ReqOpts = {}): Promise<{ data: Uint8Array; mime: string }> {
    const r = await this.request("GET", path, o);
    return { data: new Uint8Array(await r.arrayBuffer()), mime: (r.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim() };
  }

  private url(path: string, absolute?: boolean): string {
    if (/^https?:\/\//i.test(path) || absolute) {
      const u = new URL(path), b = new URL(this.base);
      if (u.origin !== b.origin) throw new GraphError("Refusing to follow a link to another host.", "http");
      return u.toString();
    }
    return this.base + (path.startsWith("/") ? path : "/" + path);
  }

  private request(method: string, path: string, o: ReqOpts): Promise<Response> {
    return this.enqueue(o.prio ?? 0, () => this.attempt(method, path, o, 0, false));
  }

  private async attempt(method: string, path: string, o: ReqOpts, tries: number, refreshed: boolean): Promise<Response> {
    if (this.stopped) throw new GraphError("Stopped.", "network");
    const wait = this.cooldownUntil - Date.now();
    if (wait > 0) {
      if (wait > LONG_WAIT || o.prio === 1) throw new GraphError("Microsoft asked us to slow down; trying again shortly.", "rate", 429, undefined, wait);
      await sleep(wait);
    }
    const url = this.url(path, o.absolute);
    let token: string;
    try { token = await this.o.token(refreshed); } catch (e) { if (e instanceof AuthError && e.kind === "revoked") { this.o.onRevoked?.(); throw new GraphError("The Microsoft sign-in is no longer valid.", "auth", 401); } throw new GraphError("Could not refresh the Microsoft sign-in (network problem).", "network"); }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    let body: any;
    if (o.raw) { body = o.raw; headers["Content-Type"] = o.contentType ?? "application/octet-stream"; }
    else if (o.body !== undefined) { body = JSON.stringify(o.body); headers["Content-Type"] = "application/json"; }
    const t0 = Date.now();
    let res: Response;
    try { res = await fetch(url, { method, headers, body, redirect: "manual", signal: o.signal ?? AbortSignal.timeout(60_000) }); }
    catch { dbg(`${method} ${maskPath(path.replace(this.base, ""))} network-error`); throw new GraphError("Could not reach Microsoft Graph (network problem).", "network"); }
    dbg(`${method} ${maskPath(path.replace(this.base, ""))} ${res.status} ${Date.now() - t0}ms`);
    // Downloads (drive content, hosted content) may answer with a redirect to a pre-authenticated URL: follow it WITHOUT the token.
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const loc = res.headers.get("location")!;
      if (!mediaAllowed(loc) && !/^https:\/\/[^/]+\.(sharepoint|files\.1drv|microsoftpersonalcontent)\.com\//i.test(loc) && !isLoopback(loc)) throw new GraphError("Refusing to follow a redirect to an unexpected host.", "http", res.status);
      try { const r2 = await fetch(loc, { redirect: "error", signal: AbortSignal.timeout(60_000) }); if (r2.ok) return r2; throw new GraphError(FRIENDLY[r2.status] ?? `HTTP ${r2.status}`, r2.status === 404 ? "notfound" : "http", r2.status); }
      catch (e) { if (e instanceof GraphError) throw e; throw new GraphError("Could not download the file.", "network"); }
    }
    if (res.ok) return res;
    let code: string | undefined;
    try { const j = await res.clone().json() as any; if (typeof j?.error?.code === "string") code = j.error.code; } catch { /* not json */ }
    void res.body?.cancel().catch(() => {});
    if (res.status === 401) {
      if (!refreshed) return this.attempt(method, path, o, tries, true);
      this.o.onRevoked?.(); throw new GraphError(FRIENDLY[401], "auth", 401, code);
    }
    if (res.status === 429 || res.status === 503 || res.status === 504) {
      const ra = Number(res.headers.get("retry-after"));
      const ms = Math.min(15 * 60_000, (Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 5000 * 2 ** tries) + Math.random() * 250);
      if (res.status === 429) { this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms); this.o.onCooldown?.(ms); }
      if (tries < 2 && ms <= LONG_WAIT && o.prio !== 1) { await sleep(ms); return this.attempt(method, path, o, tries + 1, refreshed); }
      throw new GraphError(FRIENDLY[res.status], res.status === 429 ? "rate" : "http", res.status, code, ms);
    }
    const kind = res.status === 403 ? "forbidden" : res.status === 404 ? "notfound" : "http";
    throw new GraphError(FRIENDLY[res.status] ?? `Microsoft Graph returned HTTP ${res.status}`, kind, res.status, code);
  }

  /** Fetch every page of a collection (follows @odata.nextLink), up to `max` items. */
  async all<T>(path: string, o: ReqOpts & { max?: number } = {}): Promise<T[]> {
    const out: T[] = []; let next: string | undefined = path;
    for (let i = 0; next && i < 200; i++) {
      const j: { value?: T[]; "@odata.nextLink"?: string } = await this.json(next === path ? "GET" : "GET", next, o);
      out.push(...(j?.value ?? [])); next = j?.["@odata.nextLink"];
      if (o.max && out.length >= o.max) break;
    }
    return out;
  }
  async download(url: string): Promise<{ data: Uint8Array; mime: string }> {
    if (!mediaAllowed(url)) throw new GraphError("This file is hosted somewhere UniChat will not fetch from.", "http");
    let r: Response;
    try { r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) }); } catch { throw new GraphError("Could not download the file.", "network"); }
    if (!r.ok) throw new GraphError(FRIENDLY[r.status] ?? `HTTP ${r.status}`, r.status === 404 ? "notfound" : "http", r.status);
    return { data: new Uint8Array(await r.arrayBuffer()), mime: (r.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim() };
  }
}
export { sleep };
