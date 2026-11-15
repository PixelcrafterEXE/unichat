// Link previews for OUTGOING messages: find the first URL, fetch the page metadata safely, upload the image as an attachment and
// put a `Preview` into the DataMessage. This contacts the website from the USER'S machine/IP (same as Signal-Desktop does), which is why
// it can be switched off: OutgoingMessage.linkPreview === false, or the account setting synced from the phone (Settings > Chats > Generate link previews).
//
// SSRF protection (the URL is attacker-controlled, e.g. pasted from a chat):
//   * https only (also for every redirect), default port rules of the URL, no credentials in the URL;
//   * the host is resolved FIRST and every returned address must be public (no loopback/private/link-local/CGNAT/multicast/
//     reserved/unique-local/IPv4-mapped-private); the request then connects to that very IP (no second DNS lookup = no rebinding)
//     while TLS still validates the certificate for the original host name;
//   * at most 3 redirects, each re-validated the same way; 1 MB body cap; 5 s overall timeout; only text/html pages
//     (images: only image/* and the same caps);
//   * loopback/private targets can ONLY be enabled by injecting `allowPrivate` (tests); there is no setting or env switch.
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";

export const PREVIEW_MAX_BYTES = 1024 * 1024;
export const PREVIEW_MAX_REDIRECTS = 3;
export const PREVIEW_TIMEOUT_MS = 5_000;
const UA = "Mozilla/5.0 (compatible; Unimsg-LinkPreview/0.1)";

export interface RawResponse { status: number; headers: Record<string, string | string[] | undefined>; body: Readable }
export interface RawGetArgs { url: URL; ip: string; family: 4 | 6; accept: string; signal: AbortSignal }
export interface PreviewDeps {
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Performs the GET to the ALREADY-validated `ip` (default: https with SNI/Host = url host). */
  get?: (a: RawGetArgs) => Promise<RawResponse>;
  /** TESTS ONLY: skip the public-address check. */
  allowPrivate?: boolean;
  timeoutMs?: number;
}

export class PreviewError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "PreviewError"; }
}

// ---------- URL detection ----------
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/i;
const count = (s: string, c: string) => s.split(c).length - 1;
/** First http(s) URL in `text` (trailing punctuation stripped), or undefined. Only https URLs yield a preview. */
export function firstUrl(text: string): { url: string; start: number } | undefined {
  const m = URL_RE.exec(text);
  if (!m) return undefined;
  let u = m[0];
  for (;;) {
    const last = u[u.length - 1];
    if (last && ".,;:!?'\"]}".includes(last)) u = u.slice(0, -1);
    else if (last === ")" && count(u, ")") > count(u, "(")) u = u.slice(0, -1);
    else break;
  }
  return { url: u, start: m.index };
}

// ---------- address policy ----------
export function isPublicAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return isPublicV4(addr.split(".").map(Number) as [number, number, number, number]);
  if (v === 6) return isPublicV6(addr.toLowerCase());
  return false;
}
function isPublicV4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;     // CGNAT
  if (a === 169 && b === 254) return false;                // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF / TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;   // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;                              // multicast + reserved + broadcast
  return true;
}
function isPublicV6(a: string): boolean {
  if (a === "::" || a === "::1") return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a) ?? /^::ffff:0:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isPublicAddress(mapped[1]!);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hexMapped) { const hi = parseInt(hexMapped[1]!, 16), lo = parseInt(hexMapped[2]!, 16); return isPublicV4([hi >> 8, hi & 255, lo >> 8, lo & 255]); }
  if (/^6?4:ff9b:/.test(a) || a.startsWith("64:ff9b:")) return false; // NAT64 (could embed private v4)
  const first = parseInt(a.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false;  // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false;  // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false;  // multicast
  if (first === 0x2001 && /^2001:(0)?(:|db8)/.test(a)) return false; // Teredo/documentation (best effort)
  if (first === 0x2002) return false;             // 6to4 (embeds v4)
  return true;
}

// ---------- fetching ----------
const defaultResolve = async (host: string) => (await lookup(host, { all: true, verbatim: true }));

const defaultGet = (a: RawGetArgs): Promise<RawResponse> => new Promise((resolve, reject) => {
  const req = httpsRequest({
    host: a.ip, family: a.family, port: a.url.port ? Number(a.url.port) : 443, method: "GET", path: `${a.url.pathname}${a.url.search}`,
    servername: isIP(a.url.hostname) ? undefined : a.url.hostname, // SNI + certificate check against the ORIGINAL host name
    headers: { host: a.url.host, "user-agent": UA, accept: a.accept, "accept-encoding": "identity", "accept-language": "en" },
    signal: a.signal,
  }, (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }));
  req.on("error", reject);
  req.end();
});

const hdr = (h: RawResponse["headers"], k: string) => { const v = h[k]; return Array.isArray(v) ? v[0] : v; };

async function readCapped(body: Readable, max: number): Promise<Buffer> {
  const parts: Buffer[] = []; let n = 0;
  for await (const chunk of body) {
    const b = Buffer.from(chunk as Uint8Array);
    n += b.length;
    if (n > max) { body.destroy(); throw new PreviewError("too-large"); }
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/** Validated GET with redirect handling. Resolves the final body (capped) and its content type. */
export async function safeGet(startUrl: string, accept: string, mimeOk: (ct: string) => boolean, deps: PreviewDeps = {}): Promise<{ url: URL; body: Buffer; contentType: string }> {
  const resolve = deps.resolve ?? defaultResolve;
  const get = deps.get ?? defaultGet;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs ?? PREVIEW_TIMEOUT_MS);
  try {
    let url = parseHttps(startUrl);
    for (let hop = 0; ; hop++) {
      const addrs = isIP(url.hostname) ? [{ address: url.hostname.replace(/^\[|\]$/g, ""), family: isIP(url.hostname.replace(/^\[|\]$/g, "")) }] : await resolve(url.hostname);
      if (!addrs.length) throw new PreviewError("dns");
      if (!deps.allowPrivate && addrs.some((x) => !isPublicAddress(x.address))) throw new PreviewError("private-address"); // ALL answers must be public
      const pick = addrs[0]!;
      const res = await get({ url, ip: pick.address, family: pick.family === 6 ? 6 : 4, accept, signal: ac.signal });
      if (res.status >= 300 && res.status < 400 && hdr(res.headers, "location")) {
        res.body.resume();
        if (hop >= PREVIEW_MAX_REDIRECTS) throw new PreviewError("too-many-redirects");
        url = parseHttps(new URL(hdr(res.headers, "location")!, url).toString());
        continue;
      }
      if (res.status !== 200) { res.body.resume(); throw new PreviewError(`http-${res.status}`); }
      const contentType = (hdr(res.headers, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!mimeOk(contentType)) { res.body.resume(); throw new PreviewError("content-type"); }
      const len = Number(hdr(res.headers, "content-length"));
      if (Number.isFinite(len) && len > PREVIEW_MAX_BYTES) { res.body.resume(); throw new PreviewError("too-large"); }
      return { url, body: await readCapped(res.body, PREVIEW_MAX_BYTES), contentType };
    }
  } catch (e) {
    if (e instanceof PreviewError) throw e;
    throw new PreviewError(ac.signal.aborted ? "timeout" : "network");
  } finally { clearTimeout(timer); }
}

function parseHttps(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new PreviewError("bad-url"); }
  if (u.protocol !== "https:") throw new PreviewError("not-https");
  if (u.username || u.password) throw new PreviewError("credentials-in-url");
  if (!u.hostname) throw new PreviewError("bad-url");
  return u;
}

// ---------- HTML metadata ----------
export interface PageMeta { title?: string; description?: string; image?: string }

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const cp = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const clean = (s: string | undefined, max: number) => { const t = s ? decodeEntities(s).replace(/\s+/g, " ").trim() : ""; return t ? t.slice(0, max) : undefined; };

/** og:* / twitter:* / <title> / meta description. `base` resolves relative image URLs. */
export function parseMeta(html: string, base: URL): PageMeta {
  const head = html.slice(0, PREVIEW_MAX_BYTES);
  const metas = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const attrs: Record<string, string> = {};
    for (const a of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    const key = (attrs["property"] ?? attrs["name"])?.toLowerCase();
    if (key && attrs["content"] !== undefined && !metas.has(key)) metas.set(key, attrs["content"]);
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = clean(metas.get("og:title") ?? metas.get("twitter:title") ?? titleTag, 200);
  const description = clean(metas.get("og:description") ?? metas.get("twitter:description") ?? metas.get("description"), 500);
  const rawImage = clean(metas.get("og:image") ?? metas.get("og:image:url") ?? metas.get("twitter:image") ?? metas.get("twitter:image:src"), 2000);
  let image: string | undefined;
  if (rawImage) { try { const u = new URL(decodeEntities(rawImage), base); if (u.protocol === "https:") image = u.toString(); } catch { /* ignore */ } }
  return { title, description, image };
}

export interface FetchedPreview { url: string; title?: string; description?: string; image?: { data: Uint8Array; mime: string } }

/** Fetch metadata (+ image, best effort) for `url`. Throws PreviewError (reason is safe to log) when the page can't be previewed. */
export async function fetchPreview(url: string, deps: PreviewDeps = {}): Promise<FetchedPreview> {
  const page = await safeGet(url, "text/html,application/xhtml+xml", (ct) => ct === "text/html" || ct === "application/xhtml+xml", deps);
  const meta = parseMeta(page.body.toString("utf8"), page.url);
  if (!meta.title && !meta.description && !meta.image) throw new PreviewError("no-metadata");
  const out: FetchedPreview = { url, title: meta.title, description: meta.description };
  if (meta.image) {
    try {
      const img = await safeGet(meta.image, "image/*", (ct) => /^image\/(png|jpe?g|gif|webp)$/.test(ct), deps);
      if (img.body.length > 0) out.image = { data: new Uint8Array(img.body), mime: img.contentType };
    } catch { /* the preview is still useful without the picture */ }
  }
  return out;
}

export const previewDebug = (result: string, hasImage: boolean) => {
  if (process.env.UNIMSG_DEBUG === "1") console.debug(`[signal] link preview: result=${result} image=${hasImage ? 1 : 0}`);
};
