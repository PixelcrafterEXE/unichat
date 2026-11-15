// Threema Gateway HTTP client (msgapi.threema.ch). The secret travels in the query/body as the API requires, but is never put into errors or logs.
export const DEFAULT_BASE = "https://msgapi.threema.ch";
export const dbg = (m: string) => { if (process.env.UNIMSG_DEBUG) process.stderr.write(`[threema] ${m}\n`); };

export class GatewayError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.name = "GatewayError"; this.status = status; }
}

/** UNIMSG_THREEMA_BASE is honoured for loopback hosts only (tests); anything else is ignored. */
export function baseUrl(): string {
  const e = process.env.UNIMSG_THREEMA_BASE;
  if (!e) return DEFAULT_BASE;
  try { const u = new URL(e); if (["127.0.0.1", "localhost", "[::1]"].includes(u.host.replace(/:\d+$/, ""))) return e.replace(/\/$/, ""); } catch { /* fall through */ }
  dbg("ignoring non-loopback UNIMSG_THREEMA_BASE");
  return DEFAULT_BASE;
}

const MEANING: Record<number, string> = {
  400: "The Threema Gateway rejected the request (bad parameters).",
  401: "The Threema Gateway rejected the Gateway ID or secret.",
  402: "No Threema Gateway credits left. Buy credits in the Gateway portal.",
  404: "Threema does not know this ID.",
  413: "The message or file is too large for the Threema Gateway.",
  429: "The Threema Gateway is rate limiting this ID. Try again in a moment.",
};

export class Gateway {
  private from: string; private secret: string; private base: string;
  constructor(from: string, secret: string, base = baseUrl()) { this.from = from; this.secret = secret; this.base = base; }
  private async call(method: "GET" | "POST", path: string, o: { query?: Record<string, string>; form?: Record<string, string>; blob?: Uint8Array } = {}): Promise<Response> {
    const q = new URLSearchParams({ from: this.from, secret: this.secret, ...(o.query ?? {}) });
    let body: BodyInit | undefined; const headers: Record<string, string> = {};
    if (o.form) { body = new URLSearchParams({ ...o.form, from: this.from, secret: this.secret }); }
    if (o.blob) { const fd = new FormData(); fd.append("blob", new Blob([o.blob as BlobPart]), "blob"); body = fd; }
    let r: Response;
    try {
      r = await fetch(`${this.base}${path}${o.form ? "" : "?" + q}`, { method, body, headers, signal: AbortSignal.timeout(30000) });
    } catch { throw new GatewayError(0, "Cannot reach the Threema Gateway. Check your internet connection."); }
    if (!r.ok) {
      dbg(`${method} ${path.replace(/\/[^/]*$/, "/…")} -> ${r.status}`);
      throw new GatewayError(r.status, MEANING[r.status] ?? `The Threema Gateway failed (HTTP ${r.status}).`);
    }
    return r;
  }
  async credits(): Promise<number> { return Number((await (await this.call("GET", "/credits")).text()).trim()); }
  async pubkey(id: string): Promise<string> { return (await (await this.call("GET", `/pubkeys/${encodeURIComponent(id)}`)).text()).trim().toLowerCase(); }
  async sendE2E(to: string, nonceHex: string, boxHex: string): Promise<string> {
    return (await (await this.call("POST", "/send_e2e", { form: { to, nonce: nonceHex, box: boxHex } })).text()).trim();
  }
  async upload(data: Uint8Array): Promise<string> { return (await (await this.call("POST", "/upload_blob", { blob: data })).text()).trim(); }
  async download(blobId: string): Promise<Uint8Array> { return new Uint8Array(await (await this.call("GET", `/blobs/${encodeURIComponent(blobId)}`)).arrayBuffer()); }
}
