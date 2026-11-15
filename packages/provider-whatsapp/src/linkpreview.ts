// Link previews for outgoing text: find the first URL, fetch its metadata (Open Graph) with SSRF protection.
// Never logs URLs, hosts or page content. Pure Node (http/https/dns), no Baileys runtime dependency except the
// optional thumbnail helper which is injected.
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/** Previews are on unless the host sets UNIMSG_WA_LINK_PREVIEW=0 (the contract has no provider-level setting for it). */
export const LINK_PREVIEWS_ENABLED = process.env.UNIMSG_WA_LINK_PREVIEW !== "0";

export const MAX_REDIRECTS = 3;
export const MAX_BODY = 1_000_000;
export const MAX_IMAGE = 1_000_000;
export const TIMEOUT_MS = 5000;
export const MAX_THUMB = 64 * 1024;

export interface LinkPreview {
  /** the URL exactly as it appears in the message text */
  matchedText: string;
  canonicalUrl: string;
  title: string;
  description?: string;
  /** JPEG, <= 64 KB; absent when no image could be fetched/shrunk */
  jpegThumbnail?: Buffer;
}

export interface PreviewOptions {
  /** hostname -> addresses. Tests inject this; the default is the system resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Override of the "is this address forbidden" check. TESTS ONLY: never set in production code paths. */
  isBlocked?: (ip: string) => boolean;
  /** Shrinks an image to a small JPEG (sharp/jimp via Baileys); may throw when no image library is installed. */
  makeThumb?: (image: Buffer) => Promise<Buffer>;
  timeoutMs?: number;
}

// ---------------------------------------------------------------- URL detection
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/i;
/** First http(s) URL (or bare www.) of a text, with trailing punctuation removed. */
export function firstUrl(text: string): string | undefined {
  const m = URL_RE.exec(text);
  if (!m) return undefined;
  let u = m[0];
  for (;;) {
    const last = u[u.length - 1];
    if (last && ".,;:!?*_~".includes(last)) { u = u.slice(0, -1); continue; }
    // a closing bracket belongs to the URL only when it has its opener inside
    if (last && ")]}".includes(last)) {
      const open = last === ")" ? "(" : last === "]" ? "[" : "{";
      if (u.split(open).length < u.split(last).length) { u = u.slice(0, -1); continue; }
    }
    break;
  }
  return u.length > 4 ? u : undefined;
}

// ---------------------------------------------------------------- address policy
function parseV4(s: string): number[] | undefined {
  const p = s.split(".");
  if (p.length !== 4) return undefined;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : undefined;
}
function blockedV4(a: number[]): boolean {
  const [a0, a1, a2] = a as [number, number, number, number];
  return a0 === 0 || a0 === 10 || a0 === 127 || a0 >= 224 ||
    (a0 === 100 && a1 >= 64 && a1 <= 127) || (a0 === 169 && a1 === 254) || (a0 === 172 && a1 >= 16 && a1 <= 31) ||
    (a0 === 192 && a1 === 168) || (a0 === 192 && a1 === 0 && (a2 === 0 || a2 === 2)) || (a0 === 198 && (a1 === 18 || a1 === 19)) ||
    (a0 === 198 && a1 === 51 && a2 === 100) || (a0 === 203 && a1 === 0 && a2 === 113);
}
/** Expand an IPv6 literal to 8 16-bit groups. */
function expandV6(s: string): number[] | undefined {
  s = s.split("%")[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const v4 = parseV4(dotted[1]!);
    if (!v4) return undefined;
    s = s.slice(0, -dotted[1]!.length) + ((v4[0]! << 8) | v4[1]!).toString(16) + ":" + ((v4[2]! << 8) | v4[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const side = (x: string) => (x ? x.split(":") : []);
  const head = side(halves[0]!), tail = halves.length === 2 ? side(halves[1]!) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < (halves.length === 2 ? 1 : 0)) return undefined;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  return groups.map((g) => parseInt(g, 16));
}
/** True for every address a link preview must never touch (private, loopback, link-local, multicast, reserved, unparsable). */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) { const a = parseV4(ip); return !a || blockedV4(a); }
  if (kind !== 6) return true;
  const g = expandV6(ip);
  if (!g) return true;
  const v4of = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return blockedV4(v4of(g[6]!, g[7]!)); // ::ffff:a.b.c.d, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return blockedV4(v4of(g[6]!, g[7]!)); // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return blockedV4(v4of(g[1]!, g[2]!)); // 6to4 embeds a v4 address
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  return false;
}

const defaultResolve = async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

// ---------------------------------------------------------------- guarded HTTP GET
interface Fetched { status: number; type: string; body: Buffer; finalUrl: URL; truncated: boolean }
const fail = (why: string) => new Error(`link preview: ${why}`);

/** One request to an already-validated address (connect by IP, TLS name / Host header stay the hostname: no DNS rebinding). */
function requestOnce(url: URL, ip: string, accept: (type: string) => boolean, cap: number, deadline: number, accepts: string): Promise<{ status: number; type: string; location?: string; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(fail("timeout"));
    const mod = url.protocol === "https:" ? https : http;
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const req = mod.request({
      host: ip, port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80, path: url.pathname + url.search, method: "GET",
      servername: isIP(host) ? undefined : host,
      headers: { Host: url.host, "User-Agent": "Mozilla/5.0 (compatible; UniChat link preview)", Accept: accepts, "Accept-Encoding": "identity" },
      timeout: left,
    } as http.RequestOptions);
    const timer = setTimeout(() => req.destroy(fail("timeout")), left);
    const done = (f: () => void) => { clearTimeout(timer); f(); };
    req.on("timeout", () => req.destroy(fail("timeout")));
    req.on("error", (e) => done(() => reject(e)));
    req.on("response", (res) => {
      const status = res.statusCode ?? 0;
      const type = String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
      if (status >= 300 && status < 400) { res.resume(); return done(() => resolve({ status, type, ...(location ? { location } : {}), body: Buffer.alloc(0), truncated: false })); }
      if (status !== 200 || !accept(type)) { res.destroy(); return done(() => reject(fail(status !== 200 ? "status" : "content type"))); }
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > cap) { chunks.push(c.subarray(0, c.length - (size - cap))); res.destroy(); return done(() => resolve({ status, type, body: Buffer.concat(chunks), truncated: true })); }
        chunks.push(c);
      });
      res.on("end", () => done(() => resolve({ status, type, body: Buffer.concat(chunks), truncated: false })));
      res.on("error", (e) => done(() => reject(e)));
      res.on("close", () => done(() => resolve({ status, type, body: Buffer.concat(chunks), truncated: size > cap })));
    });
    req.end();
  });
}

/** GET with SSRF protection: every hop (first request and each redirect) is resolved and ALL its addresses must be public. */
async function guardedGet(start: string, o: PreviewOptions, accept: (t: string) => boolean, cap: number, deadline: number, accepts: string): Promise<Fetched> {
  let url = new URL(start);
  const resolve = o.resolve ?? defaultResolve;
  const blocked = o.isBlocked ?? isBlockedAddress;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw fail("scheme");
    if (url.username || url.password) throw fail("credentials in url");
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (!host) throw fail("host");
    const addrs = isIP(host) ? [host] : await resolve(host);
    if (!addrs.length || addrs.some((a) => blocked(a))) throw fail("address not allowed");
    const r = await requestOnce(url, addrs[0]!, accept, cap, deadline, accepts);
    if (r.status >= 300 && r.status < 400) {
      if (!r.location || hop === MAX_REDIRECTS) throw fail("redirects");
      url = new URL(r.location, url);
      continue;
    }
    return { status: r.status, type: r.type, body: r.body, finalUrl: url, truncated: r.truncated };
  }
  throw fail("redirects");
}

// ---------------------------------------------------------------- HTML metadata
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}
export interface PageMeta { title?: string; description?: string; image?: string; canonical?: string }
export function parseMeta(html: string): PageMeta {
  const meta: Record<string, string> = {};
  let canonical: string | undefined;
  for (const m of html.matchAll(/<(meta|link)\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (m[1]!.toLowerCase() === "link") { if ((a.rel ?? "").toLowerCase().split(/\s+/).includes("canonical") && a.href) canonical ??= a.href; continue; }
    const key = (a.property ?? a.name ?? "").toLowerCase();
    if (key && a.content !== undefined && meta[key] === undefined) meta[key] = a.content;
  }
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const clean = (s: string | undefined) => { const v = s ? decodeEntities(s).replace(/\s+/g, " ").trim() : ""; return v || undefined; };
  const title = clean(meta["og:title"]) ?? clean(meta["twitter:title"]) ?? clean(t);
  const description = clean(meta["og:description"]) ?? clean(meta["twitter:description"]) ?? clean(meta["description"]);
  const image = clean(meta["og:image"]) ?? clean(meta["og:image:url"]) ?? clean(meta["twitter:image"]);
  const canon = clean(meta["og:url"]) ?? clean(canonical);
  return { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(image ? { image } : {}), ...(canon ? { canonical: canon } : {}) };
}

const charsetOf = (type: string, head: string): string => {
  const m = /charset=["']?([\w-]+)/i.exec(type) ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  const cs = (m?.[1] ?? "utf-8").toLowerCase();
  try { new TextDecoder(cs); return cs; } catch { return "utf-8"; }
};
const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const httpUrl = (s: string, base: URL): string | undefined => {
  try { const u = new URL(s, base); return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined; } catch { return undefined; }
};
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Build a preview for the first URL of `text`, or undefined (no URL, blocked address, not HTML, no title, any failure).
 * Never throws. The whole attempt (page + image) shares one 5 s deadline.
 */
export async function buildLinkPreview(text: string, o: PreviewOptions = {}): Promise<LinkPreview | undefined> {
  const matched = firstUrl(text);
  if (!matched) return undefined;
  const deadline = Date.now() + (o.timeoutMs ?? TIMEOUT_MS);
  try {
    const start = /^https?:\/\//i.test(matched) ? matched : "https://" + matched;
    const page = await guardedGet(start, o, (t) => t === "text/html" || t === "application/xhtml+xml", MAX_BODY, deadline, "text/html,application/xhtml+xml");
    const raw = page.body;
    const cs = charsetOf(page.type, raw.subarray(0, 2048).toString("latin1"));
    const html = new TextDecoder(cs).decode(raw);
    const meta = parseMeta(html);
    if (!meta.title) return undefined;
    const canonical = (meta.canonical && httpUrl(meta.canonical, page.finalUrl)) ?? page.finalUrl.href;
    const out: LinkPreview = { matchedText: matched, canonicalUrl: canonical, title: clip(meta.title, 200), ...(meta.description ? { description: clip(meta.description, 300) } : {}) };
    const imgUrl = meta.image && httpUrl(meta.image, page.finalUrl);
    if (imgUrl) {
      try {
        const img = await guardedGet(imgUrl, o, (t) => /^image\/(jpeg|jpg|png|webp|gif)$/.test(t), MAX_IMAGE, deadline, "image/jpeg,image/*");
        if (!img.truncated) {
          let thumb: Buffer | undefined;
          if (isJpeg(img.body) && img.body.length <= MAX_THUMB) thumb = img.body;
          else if (o.makeThumb) { try { const t = await o.makeThumb(img.body); if (isJpeg(t) && t.length <= MAX_THUMB) thumb = t; } catch { /* no image library installed */ } }
          if (thumb) out.jpegThumbnail = thumb;
        }
      } catch { /* preview without thumbnail */ }
    }
    return out;
  } catch { return undefined; }
}
