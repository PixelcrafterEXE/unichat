// A small fetch-compatible HTTP client on node:http(s).
// Why not global fetch: Node's fetch (undici) adds browser headers (Sec-Fetch-Mode: cors, ...) that cannot be removed, and Instagram answers every
// request carrying them with 400 "SecFetch Policy violation" (the whole API, including the login key request). The mobile app never sends them.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";

export interface HttpInit { method?: string; headers?: Record<string, string>; body?: BodyInit | Uint8Array | string; redirect?: "manual" | "error" | "follow"; signal?: AbortSignal }
export interface HttpResponse { status: number; ok: boolean; headers: Headers; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }

export function igFetch(url: string, init: HttpInit = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url), mod = u.protocol === "http:" ? httpRequest : httpsRequest;
    const body = init.body === undefined || init.body === null ? undefined : typeof init.body === "string" ? Buffer.from(init.body) : init.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.from(String(init.body));
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) headers["Content-Length"] = String(body.length);
    const req = mod(u, { method: init.method ?? "GET", headers, signal: init.signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        let raw = Buffer.concat(chunks);
        try {
          const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
          if (enc === "gzip") raw = gunzipSync(raw); else if (enc === "deflate") raw = inflateSync(raw); else if (enc === "br") raw = brotliDecompressSync(raw);
        } catch { /* undecodable body: keep the raw bytes */ }
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) { if (Array.isArray(v)) for (const x of v) h.append(k, x); else if (v !== undefined) h.set(k, v); }
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, headers: h, text: async () => raw.toString("utf8"), arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
