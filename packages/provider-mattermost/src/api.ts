// Thin Mattermost REST client on Node's fetch. Never puts tokens, passwords, bodies or ids-of-people into error text.
const DEBUG = process.env.UNIMSG_DEBUG === "1";
export const dbg = (line: string) => { if (DEBUG) process.stderr.write(`[mm] ${line}\n`); };

export class MmError extends Error {
  readonly status: number; readonly serverId?: string;
  constructor(message: string, status: number, serverId?: string) { super(message); this.name = "MmError"; this.status = status; this.serverId = serverId; }
}

/** "communicating.tuhh.de" | "https://x/chat/" -> "https://communicating.tuhh.de" (no trailing slash). Throws plain English. */
export function normaliseServer(input: string): string {
  let s = input.trim();
  if (!s) throw new Error("Enter the server address, e.g. communicating.tuhh.de");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try { u = new URL(s); } catch { throw new Error("That does not look like a server address."); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("The server address must start with https://");
  if (u.username || u.password) throw new Error("Do not put a user name or password into the server address.");
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol === "http:" && !loopback) throw new Error("Plain http:// would send your login in clear text. Use https://.");
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

const FRIENDLY: Record<number, string> = {
  400: "the server rejected the request", 401: "the session is no longer valid", 403: "your account is not allowed to do this on this server",
  404: "not found on the server", 413: "the file is too large for this server", 429: "rate limited by the server", 500: "the server had an internal error",
  502: "the server is temporarily unavailable", 503: "the server is temporarily unavailable", 504: "the server timed out",
};

export interface Res<T> { status: number; headers: Headers; body: T }

export class Api {
  token?: string;
  onUnauthorized?: () => void;
  private blockedUntil = 0;
  private active = 0;
  private waiters: (() => void)[] = [];
  readonly base: string; private readonly maxConcurrent: number;
  constructor(base: string, token?: string, maxConcurrent = 4) { this.base = base; this.token = token; this.maxConcurrent = maxConcurrent; }

  private async slot<T>(f: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) await new Promise<void>((ok) => this.waiters.push(ok));
    this.active++;
    try { return await f(); } finally { this.active--; this.waiters.shift()?.(); }
  }

  /** Low-level request with 429 handling. `auth:false` = never send the token and never treat 401 as a dead session. */
  async raw(method: string, path: string, o: { json?: unknown; form?: FormData; auth?: boolean; timeoutMs?: number; accept?: string } = {}): Promise<Response> {
    const auth = o.auth !== false;
    for (let attempt = 0; ; attempt++) {
      const wait = this.blockedUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 65000)));
      const headers: Record<string, string> = { "X-Requested-With": "XMLHttpRequest" };
      if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
      let body: BodyInit | undefined;
      if (o.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(o.json); }
      else if (o.form) body = o.form;
      let res: Response;
      try {
        res = await this.slot(() => fetch(this.base + "/api/v4" + path, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs ?? 30000) }));
      } catch (e) {
        const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { name?: string }).name ?? "error";
        throw new MmError(`Cannot reach the Mattermost server (${code}).`, 0);
      }
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after") ?? "");
      if (res.status === 429) {
        await res.arrayBuffer().catch(() => {});
        if (attempt >= 3) throw new MmError("The server is rate limiting us; try again in a minute.", 429);
        const secs = Number.isFinite(reset) && reset > 0 ? Math.min(reset, 60) : 1 + attempt;
        this.blockedUntil = Math.max(this.blockedUntil, Date.now() + secs * 1000);
        dbg(`429, waiting ${secs}s`);
        continue;
      }
      if (remaining === "0" && Number.isFinite(reset) && reset > 0) this.blockedUntil = Math.max(this.blockedUntil, Date.now() + Math.min(reset, 60) * 1000);
      if (res.status >= 300 && res.status < 400) { await res.arrayBuffer().catch(() => {}); throw new MmError("The server redirected the request (check the server address; use the exact https:// address).", res.status); }
      if (res.ok) return res;
      let id: string | undefined;
      try { id = ((await res.json()) as { id?: string }).id; } catch { /* not json */ }
      if (res.status === 401 && auth) this.onUnauthorized?.();
      throw new MmError(`Mattermost: ${FRIENDLY[res.status] ?? "request failed"} (HTTP ${res.status}${id ? ", " + id : ""}).`, res.status, id);
    }
  }

  async json<T = any>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const res = await this.raw(method, path, { json: body, auth });
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  get<T = any>(path: string) { return this.json<T>("GET", path); }
  async bytes(path: string): Promise<{ data: Uint8Array; mime: string }> {
    const res = await this.raw("GET", path, { timeoutMs: 120000 });
    return { data: new Uint8Array(await res.arrayBuffer()), mime: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0] };
  }
}
