import { useEffect, useRef, useState } from "react";
import { Core } from "./api";
import type { Attachment, DeliveryStatus, Space } from "./types";
import { siDiscord, siInstagram, siMatrix, siMattermost, siSignal, siTelegram, siWhatsapp } from "simple-icons";
import { AlertCircle, Check, CheckCheck, Clock, Folder, GitMerge, Link2, MessageCircle } from "./icons";

export const core = new Core();

export const COLORS: Record<string, string> = { whatsapp: "#25d366", signal: "#3a76f0", matrix: "#b05bf0", mesh: "#f0a030" };
export const color = (p: string) => COLORS[p] ?? "#8a8f98";
export const initials = (s?: string) => ((s ?? "").replace(/[^\p{L}\p{N} ]/gu, "").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2) || "?").toUpperCase();
const PALETTE = ["#3b82f6", "#eb459e", "#f0a030", "#23a559", "#3ba7d9", "#9b59b6", "#e67e22", "#16a085"];
export const hue = (s?: string) => PALETTE[[...(s ?? "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];

// Profile pictures are fetched lazily through the backend (providers authenticate / sign the downloads), cached per session.
const avatarCache = new Map<string, Promise<string | null>>(); // insertion order = least recently used first
const AVATAR_CAP = 800; // bounded: each entry holds a decoded blob URL
let avatarEpoch = 0; const avatarListeners = new Set<() => void>();
function trimAvatars() {
  while (avatarCache.size > AVATAR_CAP) {
    const k = avatarCache.keys().next().value as string; const p = avatarCache.get(k); avatarCache.delete(k);
    p?.then((u) => { if (u?.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(u), 30_000); }); // grace period: an image on screen may still use it
  }
}
/** ONE observer for every avatar on the page (a list of 600 chats must not create 600 observers). */
const seen = new Map<Element, () => void>();
let sharedIO: IntersectionObserver | undefined;
function whenVisible(el: Element, cb: () => void): () => void {
  sharedIO ??= new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { const f = seen.get(e.target); seen.delete(e.target); sharedIO!.unobserve(e.target); f?.(); } }, { rootMargin: "100px" });
  seen.set(el, cb); sharedIO.observe(el);
  return () => { seen.delete(el); sharedIO?.unobserve(el); };
}
/** Drop a cached picture (after it was changed) and make every visible Avatar reload. */
export function forgetAvatar(kind: string, id: string) { avatarCache.delete(`${kind}|${id}`); avatarEpoch++; avatarListeners.forEach((l) => l()); }
const missedAvatars = new Set<string>(); // keys that resolved to "no picture": retried when a sync / refresh delivers avatars ('avatars-changed')
try {
  core.on((ev: string, d: any) => {
    if (ev !== "avatars-changed") return;
    for (const k of d?.keys ?? []) { const ui = String(k).replace(/\|full$/, ""); avatarCache.delete(ui); missedAvatars.delete(ui); }
    for (const k of missedAvatars) avatarCache.delete(k); // merged chats resolve through their members, so every miss is retried once
    missedAvatars.clear(); avatarEpoch++; avatarListeners.forEach((l) => l());
  });
} catch { /* no core bridge (tests) */ }
function loadAvatar(kind: "chat" | "space" | "contact" | "emoji", id: string): Promise<string | null> {
  const key = `${kind}|${id}`;
  let p = avatarCache.get(key);
  if (p) { avatarCache.delete(key); avatarCache.set(key, p); } // touch: most recently used
  if (!p) {
    p = core.call("avatar", { kind, id }).then((r: { dataBase64: string; mime: string } | null) => {
      if (!r) { missedAvatars.add(key); return null; }
      const bin = atob(r.dataBase64); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([u8], { type: r.mime }));
    }).catch(() => null);
    avatarCache.set(key, p); trimAvatars();
  }
  return p;
}
/** Real messenger logos (simple-icons, CC0 artwork; the marks belong to their owners). Matrix' mark is black, so it sits on white. */
const BRAND: Record<string, { path: string; bg: string; fg: string; bold?: number }> = {
  whatsapp: { path: siWhatsapp.path, bg: "#25D366", fg: "#fff", bold: 1.5 }, // bold: the thin outline glyph is thickened with a round stroke
  signal: { path: siSignal.path, bg: "#3B45FD", fg: "#fff" },
  matrix: { path: siMatrix.path, bg: "#fff", fg: "#000" },
  discord: { path: siDiscord.path, bg: "#5865F2", fg: "#fff" },
  telegram: { path: siTelegram.path, bg: "#26A5E4", fg: "#fff" },
  mattermost: { path: siMattermost.path, bg: "#0058CC", fg: "#fff" },
  instagram: { path: siInstagram.path, bg: "#E4405F", fg: "#fff" },
  teams: { path: "M20.625 8.127q-.55 0-1.025-.205t-.832-.563t-.563-.832T18 5.502q0-.54.205-1.02t.563-.837q.357-.358.832-.563q.474-.205 1.025-.205q.54 0 1.02.205t.837.563q.358.357.563.837t.205 1.02q0 .55-.205 1.025t-.563.832q-.357.358-.837.563t-1.02.205m0-3.75q-.469 0-.797.328t-.328.797t.328.797t.797.328t.797-.328t.328-.797t-.328-.797t-.797-.328M24 10.002v5.578q0 .774-.293 1.46t-.803 1.194q-.51.51-1.195.803q-.686.293-1.459.293q-.445 0-.908-.105q-.463-.106-.85-.329q-.293.95-.855 1.729t-1.319 1.336t-1.67.861t-1.898.305q-1.148 0-2.162-.398q-1.014-.399-1.805-1.102t-1.312-1.664t-.674-2.086h-5.8q-.411 0-.704-.293T0 16.881V6.873q0-.41.293-.703t.703-.293h8.59q-.34-.715-.34-1.5q0-.727.275-1.365q.276-.639.75-1.114q.475-.474 1.114-.75q.638-.275 1.365-.275t1.365.275t1.114.75q.474.475.75 1.114q.275.638.275 1.365t-.275 1.365q-.276.639-.75 1.113q-.475.475-1.114.75q-.638.276-1.365.276q-.188 0-.375-.024q-.188-.023-.375-.058v1.078h10.875q.469 0 .797.328t.328.797M12.75 2.373q-.41 0-.78.158q-.368.158-.638.434q-.27.275-.428.639q-.158.363-.158.773t.158.78q.159.368.428.638q.27.27.639.428t.779.158t.773-.158q.364-.159.64-.428q.274-.27.433-.639t.158-.779t-.158-.773q-.159-.364-.434-.64q-.275-.275-.639-.433q-.363-.158-.773-.158M6.937 9.814h2.25V7.94H2.814v1.875h2.25v6h1.875zm10.313 7.313v-6.75H12v6.504q0 .41-.293.703t-.703.293H8.309q.152.809.556 1.5q.405.691.985 1.19q.58.497 1.318.779q.738.281 1.582.281q.926 0 1.746-.352q.82-.351 1.436-.966q.615-.616.966-1.43q.352-.815.352-1.752m5.25-1.547v-5.203h-3.75v6.855q.305.305.691.452q.387.146.809.146q.469 0 .879-.176q.41-.175.715-.48q.304-.305.48-.715t.176-.879", bg: "#6264A7", fg: "#fff" }, // official marks from the simple-icons set (CC0 artwork, fetched from the Iconify API); the marks belong to their owners
  threema: { path: "M11.998 20.486a1.757 1.757 0 1 1 0 3.514a1.757 1.757 0 0 1 0-3.514m-6.335 0a1.757 1.757 0 1 1 0 3.514a1.757 1.757 0 0 1 0-3.514m12.671 0a1.757 1.757 0 1 1 0 3.514a1.757 1.757 0 0 1 0-3.514M12 0c5.7 0 10.322 4.066 10.322 9.082S17.7 18.165 12 18.165a11.45 11.45 0 0 1-4.523-.917l-5.171 1.293l1.105-4.42c-1.094-1.442-1.733-3.175-1.733-5.039C1.678 4.066 6.3 0 12 0m-.001 4.235A2.926 2.926 0 0 0 9.072 7.16v1.17h-.115a.47.47 0 0 0-.47.47v4.126c0 .26.21.471.47.471h6.086c.26 0 .47-.21.47-.47V8.798a.47.47 0 0 0-.47-.47h-.115v-1.17a2.927 2.927 0 0 0-2.93-2.924zm0 1.17c.972 0 1.758.786 1.758 1.754v1.17h-3.514v-1.17c0-.968.786-1.754 1.756-1.754", bg: "#7b8190", fg: "#fff" },
};
/** A round provider badge: the messenger's logo on its brand colour. `mesh` (UniChat's own cross-platform groups) gets a link icon. */
export function ProviderIcon({ provider, size = 16, title }: { provider: string; size?: number; title?: string }) {
  const b = BRAND[provider === "threema-md" ? "threema" : provider]; const inner = Math.round(size * (b?.bold ? 0.7 : 0.62));
  return (
    <span className="pi" style={{ width: size, height: size, background: b ? b.bg : provider === "mesh" ? "#f0a030" : provider === "merged" ? "#7c5cf0" : "var(--muted)" }} title={title ?? provider} role="img" aria-label={title ?? provider}>
      {b ? <svg viewBox="0 0 24 24" width={inner} height={inner} fill={b.fg} aria-hidden><path d={b.path} {...(b.bold ? { stroke: b.fg, strokeWidth: b.bold, strokeLinejoin: "round" as const } : {})} /></svg>
        : provider === "mesh" ? <Link2 size={inner} color="#fff" strokeWidth={2.4} /> : provider === "merged" ? <GitMerge size={inner} color="#fff" strokeWidth={2.4} /> : <MessageCircle size={inner} color="#fff" />}
    </span>
  );
}

/** The networks a merged chat spans, as small overlapping round badges (one per distinct provider). */
export function ProviderStack({ providers, size = 14 }: { providers: string[]; size?: number }) {
  const u = [...new Set(providers)];
  return <span className="pstack" aria-label={u.join(", ")}>{u.map((p) => <span key={p} className="pstackitem"><ProviderIcon provider={p} size={size} /></span>)}</span>;
}

export function Avatar({ name, url, size = 36, provider, providers, of, fallback, zoom, online }: { name: string; /** green presence dot */ online?: boolean; url?: string; size?: number; provider?: string; providers?: string[]; of?: { kind: "chat" | "space" | "contact" | "emoji"; id: string }; /** shown when `of` has no picture (e.g. a community cover for a group without its own picture) */ zoom?: boolean; fallback?: { kind: "chat" | "space" | "contact" | "emoji"; id: string; url?: string } }) {
  const [lazy, setLazy] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(avatarEpoch);
  useEffect(() => { const l = () => setEpoch(avatarEpoch); avatarListeners.add(l); return () => { avatarListeners.delete(l); }; }, []);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    setLazy(null);
    if (url || !of || !ref.current) return;
    let live = true;
    const stop = whenVisible(ref.current, () => { loadAvatar(of.kind, of.id).then((u) => (u || !fallback ? u : fallback.url ?? loadAvatar(fallback.kind, fallback.id))).then((u) => live && setLazy(u)); });
    return () => { live = false; stop(); };
  }, [url, of?.kind, of?.id, fallback?.id, epoch]);
  const src = url ?? lazy;
  return (
    <span ref={ref} className={"avatar" + (zoom && src ? " zoomable" : "")} style={{ width: size, height: size, fontSize: size * 0.38, background: src ? "none" : hue(name) }}
      {...(zoom && src ? { role: "button", tabIndex: 0, title: "Enlarge picture", onClick: (e: React.MouseEvent) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent("unichat-zoom", { detail: { url: src, of } })); },
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); window.dispatchEvent(new CustomEvent("unichat-zoom", { detail: { url: src, of } })); } } } : {})}>
      {src ? <img src={src} alt="" onError={() => setLazy(null)} /> : initials(name)}
      {online && <span className="onlinedot" data-online="1" title="Online" aria-label="Online" />}
      {providers && providers.length > 1 ? <span className="avbadge multi"><ProviderStack providers={providers} size={size >= 40 ? 15 : 13} /></span>
        : provider && <span className="avbadge"><ProviderIcon provider={providers?.length === 1 ? providers[0] : provider} size={size >= 40 ? 18 : 15} /></span>}
    </span>
  );
}

/** "online" / "last seen 5 min ago" / "last seen 3 Nov" for a contact (empty when nothing is known). */
export function presenceText(p: { online?: boolean; lastSeen?: string }): string {
  if (p.online) return "online";
  const t = p.lastSeen ? Date.parse(p.lastSeen) : NaN; if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (m < 1) return "last seen just now"; if (m < 60) return `last seen ${m} min ago`;
  const d = new Date(t), today = new Date();
  if (m < 24 * 60 && d.toDateString() === today.toDateString()) return `last seen today at ${fmtTime(p.lastSeen!)}`;
  return `last seen ${d.toLocaleDateString([], { day: "numeric", month: "short" })}`;
}
export const fmtBytes = (n?: number) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
// toLocale*String builds a new formatter on every call (about 0.2 ms each, 1 s for a 2000-message chat on a phone): keep one Intl formatter.
let timeFmt: Intl.DateTimeFormat | undefined, dayFmt: Intl.DateTimeFormat | undefined;
export const fmtTime = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? "Invalid Date" : (timeFmt ??= new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" })).format(d); };
export function dayLabel(iso: string) {
  const d = new Date(iso), t = new Date(), y = new Date(Date.now() - 864e5);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  return same(d, t) ? "Today" : same(d, y) ? "Yesterday" : (dayFmt ??= new Intl.DateTimeFormat([], { weekday: "long", day: "numeric", month: "long" })).format(d);
}
export const toBase64 = (b: Blob) => new Promise<string>((ok, fail) => {
  const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.onerror = () => fail(r.error); r.readAsDataURL(b);
});
/** Crop to a centred square, scale to <= `size`px and encode as JPEG: what every network accepts as a profile picture. */
export async function squareImage(file: Blob, size = 512): Promise<{ dataBase64: string; mime: string; dataUrl: string }> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height), out = Math.min(size, side);
  const c = document.createElement("canvas"); c.width = c.height = out;
  c.getContext("2d")!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
  const blob: Blob = await new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("Couldn't read that image"))), "image/jpeg", 0.9));
  return { dataBase64: await toBase64(blob), mime: "image/jpeg", dataUrl: c.toDataURL("image/jpeg", 0.9) };
}
export function downloadText(filename: string, mime: string, text: string) {
  const a = document.createElement("a"); const url = URL.createObjectURL(new Blob([text], { type: mime + ";charset=utf-8" }));
  a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const vEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
const fold = (line: string) => { const out: string[] = []; let l = line; while (l.length > 74) { out.push(l.slice(0, 74)); l = " " + l.slice(74); } out.push(l); return out.join("\r\n"); };
/** vCard 3.0 for a shared contact: import it into any address book. */
export function vcardOf(c: { name: string; phones?: string[]; emails?: string[]; handle?: string }): string {
  const parts = c.name.trim().split(/\s+/), given = parts[0] ?? "", family = parts.slice(1).join(" ");
  return ["BEGIN:VCARD", "VERSION:3.0", `N:${vEsc(family)};${vEsc(given)};;;`, `FN:${vEsc(c.name)}`,
    ...(c.phones ?? []).map((p) => `TEL;TYPE=CELL:${p.replace(/[^\d+]/g, "")}`), ...(c.emails ?? []).map((e) => `EMAIL;TYPE=INTERNET:${e}`),
    ...(c.handle && !(c.phones ?? []).length ? [`NOTE:${vEsc(c.handle)}`] : []), "END:VCARD"].map(fold).join("\r\n") + "\r\n";
}
const icsTime = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
/** iCalendar (RFC 5545) with one VEVENT: opens in the system calendar app / imports into Google, Outlook, Apple... */
export function icsOf(c: { title: string; body?: string; when?: string; until?: string; place?: string; url?: string; canceled?: boolean }, uid: string): string {
  if (!c.when) throw new Error("This event has no start time");
  const start = new Date(c.when), end = c.until ? new Date(c.until) : new Date(+start + 3600_000);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//UniChat//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${uid.replace(/[^\w.-]/g, "_")}@unimsg`, `DTSTAMP:${icsTime(new Date().toISOString())}`, `DTSTART:${icsTime(start.toISOString())}`, `DTEND:${icsTime(end.toISOString())}`,
    `SUMMARY:${vEsc(c.title)}`, ...(c.body ? [`DESCRIPTION:${vEsc(c.body + (c.url ? "\n" + c.url : ""))}`] : c.url ? [`DESCRIPTION:${vEsc(c.url)}`] : []),
    ...(c.place ? [`LOCATION:${vEsc(c.place)}`] : []), ...(c.url ? [`URL:${c.url}`] : []), ...(c.canceled ? ["STATUS:CANCELLED"] : []), "END:VEVENT", "END:VCALENDAR"].map(fold).join("\r\n") + "\r\n";
}
/**
 * Display size for a picture, independent of its pixel size: the longest side becomes `max` px (small images are scaled UP, large ones
 * down), the aspect ratio is kept, and extreme shapes are clamped so a panorama or a long screenshot never takes over the chat.
 */
export function fitBox(w?: number, h?: number, max = 320): { w: number; h: number } {
  if (!w || !h) return { w: max, h: Math.round(max * 0.66) };
  const ar = Math.min(Math.max(w / h, 1 / 2.2), 2.4); // clamp the shape (the picture is then cropped to fill: object-fit: cover)
  return ar >= 1 ? { w: max, h: Math.max(110, Math.round(max / ar)) } : { w: Math.max(130, Math.round(max * ar)), h: max };
}
// ---------------------------------------------------------------- voice messages
export const fmtDuration = (sec: number) => { const s = Math.max(0, Math.round(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** ~`n` bar heights (0-100) from a series of 0..1 levels (max-pooled), normalised so the loudest bar is 100. */
export function toBars(levels: number[], n = 64): number[] {
  if (!levels.length) return Array(n).fill(8);
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const a = Math.floor((i * levels.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n)); out.push(Math.max(...levels.slice(a, b))); }
  const mx = Math.max(...out, 1e-6);
  return out.map((v) => Math.max(6, Math.round((v / mx) * 100)));
}
/** Waveform of an audio file, by decoding it (falls back to a calm flat shape when the browser can't decode that codec). */
export async function waveformOf(url: string, n = 64): Promise<number[]> {
  const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext; if (!AC) throw new Error("no AudioContext");
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer());
    const ch = buf.getChannelData(0), step = Math.max(1, Math.floor(ch.length / (n * 4))), levels: number[] = [];
    for (let i = 0; i < ch.length; i += step) { let s = 0, c = 0; for (let j = i; j < Math.min(i + step, ch.length); j++) { s += ch[j] * ch[j]; c++; } levels.push(Math.sqrt(s / Math.max(1, c))); }
    return toBars(levels, n);
  } finally { ctx.close?.(); }
}

const OGG_CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let r = (i << 24) >>> 0; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0; t[i] = r >>> 0; } return t; })();
const oggCrc = (b: Uint8Array) => { let c = 0; for (let i = 0; i < b.length; i++) c = (((c << 8) >>> 0) ^ OGG_CRC[((c >>> 24) ^ b[i]) & 0xff]) >>> 0; return c >>> 0; };
/** Samples (48 kHz) in one Opus packet, from its TOC byte (RFC 6716 §3.1). */
function opusSamples(p: Uint8Array): number {
  const toc = p[0], cfg = toc >> 3, code = toc & 3;
  const ms = cfg < 12 ? [10, 20, 40, 60][cfg % 4] : cfg < 16 ? [10, 20][cfg % 2] : [2.5, 5, 10, 20][cfg % 4];
  const frames = code === 0 ? 1 : code === 3 ? (p[1] ?? 1) & 0x3f : 2;
  return Math.round(ms * 48 * frames);
}
/**
 * Remux a MediaRecorder WebM/Opus recording into Ogg/Opus WITHOUT re-encoding. Chrome records WebM only, but WhatsApp / Signal voice
 * notes are Ogg/Opus. Throws if the input isn't WebM with Opus packets, so callers can fall back to sending the original.
 */
export async function webmOpusToOgg(input: Blob): Promise<{ blob: Blob; durationMs: number }> {
  const buf = new Uint8Array(await input.arrayBuffer());
  if (buf[0] !== 0x1a || buf[1] !== 0x45 || buf[2] !== 0xdf || buf[3] !== 0xa3) throw new Error("not a WebM file");
  // --- minimal EBML walk: enter the master elements, collect CodecPrivate (OpusHead) and the frames of (Simple)Blocks
  const MASTER = new Set([0x18538067, 0x1654ae6b, 0xae, 0x1f43b675, 0xa0]); // Segment, Tracks, TrackEntry, Cluster, BlockGroup
  let pos = 0; const packets: Uint8Array[] = []; let head: Uint8Array | undefined;
  const vintLen = (b: number) => { let len = 1; for (let m = 0x80; m && !(b & m); m >>= 1) len++; return len; };
  while (pos < buf.length - 1) {
    const idLen = vintLen(buf[pos]); let id = 0; for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i]; pos += idLen;
    const sLen = vintLen(buf[pos]); let size = buf[pos] & ((1 << (8 - sLen)) - 1), unknown = size === (1 << (8 - sLen)) - 1;
    for (let i = 1; i < sLen; i++) { size = size * 256 + buf[pos + i]; if (buf[pos + i] !== 0xff) unknown = false; } pos += sLen;
    if (MASTER.has(id)) continue;                        // descend: children follow immediately (also for unknown-size masters)
    if (unknown) break;
    const end = Math.min(buf.length, pos + size);
    if (id === 0x63a2) head = buf.slice(pos, end);       // CodecPrivate = OpusHead
    else if (id === 0xa3 || id === 0xa1) {               // SimpleBlock / Block: track vint, int16 timecode, flags, frame (no lacing for Opus)
      const tl = vintLen(buf[pos]); const flags = buf[pos + tl + 2]; const frame = buf.slice(pos + tl + 3, end);
      if (!(flags & 0x06) && frame.length) packets.push(frame);
    }
    pos = end;
  }
  if (!packets.length) throw new Error("no audio packets found");
  const opusHead = head && head.length >= 19 && String.fromCharCode(...head.slice(0, 8)) === "OpusHead" ? head
    : Uint8Array.from([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);  // mono, pre-skip 312, 48 kHz
  const preSkip = opusHead[10] | (opusHead[11] << 8);
  const tags = new TextEncoder().encode("OpusTags"), vendor = new TextEncoder().encode("UniChat");
  const opusTags = new Uint8Array(tags.length + 4 + vendor.length + 4); opusTags.set(tags); new DataView(opusTags.buffer).setUint32(tags.length, vendor.length, true); opusTags.set(vendor, tags.length + 4);
  // --- Ogg pages
  const serial = (Math.random() * 0xffffffff) >>> 0; const pages: Uint8Array[] = []; let seq = 0;
  const page = (type: number, granule: number, pks: Uint8Array[]) => {
    const seg: number[] = []; for (const p of pks) { let n = p.length; while (n >= 255) { seg.push(255); n -= 255; } seg.push(n); }
    const body = new Uint8Array(pks.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of pks) { body.set(p, o); o += p.length; }
    const out = new Uint8Array(27 + seg.length + body.length), dv = new DataView(out.buffer);
    out.set([0x4f, 0x67, 0x67, 0x53, 0, type]); dv.setBigUint64(6, BigInt(granule), true); dv.setUint32(14, serial, true); dv.setUint32(18, seq++, true); out[26] = seg.length; out.set(seg, 27); out.set(body, 27 + seg.length);
    dv.setUint32(22, oggCrc(out), true); pages.push(out);
  };
  page(0x02, 0, [opusHead]); page(0x00, 0, [opusTags]);
  let total = 0, group: Uint8Array[] = [], segs = 0;
  const segCount = (p: Uint8Array) => Math.floor(p.length / 255) + 1;
  const flush = (last: boolean) => { if (group.length) { page(last ? 0x04 : 0x00, preSkip + total, group); group = []; segs = 0; } };
  packets.forEach((p, i) => {
    if (segs + segCount(p) > 250 || group.length >= 40) flush(false);
    group.push(p); segs += segCount(p); total += opusSamples(p);
    if (i === packets.length - 1) flush(true);
  });
  return { blob: new Blob(pages as BlobPart[], { type: "audio/ogg; codecs=opus" }), durationMs: Math.round(total / 48) };
}

export const kindOf = (mime: string): Attachment["kind"] => (mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file");

/** Delivery state: clock=sending, check=sent, double check=delivered, blue double check=read, alert=failed. */
export function Ticks({ status, onInfo }: { status?: DeliveryStatus; /** makes the ticks a button that opens "Message info" */ onInfo?: () => void }) {
  if (!status) return null;
  const title = { sending: "Sending…", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed to send" }[status];
  const c = status === "read" ? "#53bdeb" : status === "failed" ? "#da373c" : "#949ba4";
  const I = status === "sending" ? Clock : status === "failed" ? AlertCircle : status === "sent" ? Check : CheckCheck;
  if (onInfo) return <button type="button" className="ticks tickbtn" title={title + " · Message info"} style={{ color: c }} aria-label="Message info" data-status={status} onClick={(e) => { e.stopPropagation(); onInfo(); }}><I size={14} strokeWidth={2.2} /></button>;
  return <span className="ticks" title={title} style={{ color: c }} role="img" aria-label={title}><I size={14} strokeWidth={2.2} /></span>;
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)"'])/g;
const EMOJI_TOKEN = /(:[A-Za-z0-9_+-]{2,64}:)/;
/** A custom emoji (:name:) from the service, fetched once and shown inline; falls back to the plain text when the service doesn't know it. */
export function CustomEmoji({ scope, name, size = 22 }: { scope: string; name: string; size?: number }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => { let live = true; loadAvatar("emoji", `${scope}:${name}`).then((u) => live && setSrc(u), () => live && setSrc(null)); return () => { live = false; }; }, [scope, name]);
  if (src === undefined) return <span className="cemoji ph" style={{ width: size, height: size }} />;
  return src ? <img className="cemoji" src={src} alt={`:${name}:`} title={`:${name}:`} style={{ height: size }} /> : <>{`:${name}:`}</>;
}
/** Text with links and, when `emojiScope` (the account id) is given, inline custom emoji. A message that is only one emoji is shown large. */
export function Linkified({ text, emojiScope }: { text: string; emojiScope?: string }) {
  const lone = emojiScope && /^\s*:[A-Za-z0-9_+-]{2,64}:\s*$/.test(text);
  return <>{text.split(URL_RE).map((p, i) => i % 2 ? <a key={i} href={p} target="_blank" rel="noreferrer noopener">{p}</a>
    : emojiScope ? p.split(EMOJI_TOKEN).map((q, j) => (j % 2 ? <CustomEmoji key={j} scope={emojiScope} name={q.slice(1, -1)} size={lone ? 48 : 22} /> : q)) : p)}</>;
}

// ---- attachment bytes (lazy, cached per message attachment) ----
const blobCache = new Map<string, Promise<{ url: string; mime: string; name?: string }>>();
export function loadAttachment(chatId: string, messageId: string, attachmentId: string) {
  const key = `${chatId}|${messageId}|${attachmentId}`;
  let p = blobCache.get(key);
  if (!p) {
    p = core.call("attachment", { chatId, messageId, attachmentId }).then((r: { dataBase64: string; mime: string; name?: string }) => {
      const bin = atob(r.dataBase64); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return { url: URL.createObjectURL(new Blob([u8], { type: r.mime })), mime: r.mime, name: r.name };
    });
    p.catch(() => blobCache.delete(key));
    blobCache.set(key, p);
  }
  return p;
}
export function useAttachment(chatId: string, messageId: string, a: Attachment, eager: boolean) {
  const [r, setR] = useState<{ url: string; mime: string; name?: string }>();
  const [err, setErr] = useState(false);
  useEffect(() => { if (eager) loadAttachment(chatId, messageId, a.id).then(setR, () => setErr(true)); }, [chatId, messageId, a.id, eager]);
  return { r, err, load: () => loadAttachment(chatId, messageId, a.id).then((x) => { setR(x); return x; }, () => { setErr(true); return undefined; }) };
}

// ---- local settings ----
export interface Settings { theme: "dark" | "light" | "system"; messageStyle: "bubbles" | "flat"; /** retired: ignored, kept so old saved settings still load */ compact?: boolean; enterToSend: boolean; notifications: boolean; sendReadReceipts: boolean; /** what notifications reveal: full text / only who wrote / nothing */ notifyContent: "full" | "sender" | "hidden"; sendTyping: boolean; autoDownloadMedia: boolean; mapPreviews: boolean; /** Android: keep the background service running and restart it after a reboot */ keepAlive: boolean; /** emoji picker skin tone, 0 = default .. 5 = dark */ skinTone?: number; /** chat list filters (see ChatFilters.tsx) */ chatFilters?: import("./ChatFilters").ChatFilters }
export const DEFAULTS: Settings = { theme: "dark", messageStyle: "bubbles", compact: false, enterToSend: true, notifications: false, sendReadReceipts: true, notifyContent: "full", sendTyping: true, autoDownloadMedia: true, mapPreviews: true, keepAlive: true };
export function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("unimsg.settings") ?? "{}") }; } catch { return DEFAULTS; }
}
export function saveSettings(s: Settings) { try { localStorage.setItem("unimsg.settings", JSON.stringify(s)); } catch { /* private mode */ } }
export function loadSet(key: string): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(key) ?? "[]")); } catch { return new Set(); } }
export function saveSet(key: string, s: Set<string>) { try { localStorage.setItem(key, JSON.stringify([...s])); } catch { /* ignore */ } }

export const EMOJI = "😀 😂 🥹 😍 😘 😎 🤔 😮 😢 😡 👍 👎 👏 🙏 🔥 ❤️ 💔 🎉 ✅ ❌ 👀 🙌 💪 🤝 ☕ 🍕 🥨 🍻 ⛰️ 🚗 ✈️ 📍 📷 🎵 💡 ⭐".split(" ");
export const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** Rail / list icon of a space: a network community shows its cover (or coloured initials); a local folder a folder glyph or emoji on its colour. */
export function SpaceIcon({ space, size = 48 }: { space: Space; size?: number }) {
  if (space.local) return <span className="foldericon" style={{ background: space.color ?? "var(--accent)", width: size, height: size, fontSize: size * 0.46 }}>{space.icon?.startsWith("data:image/") ? <img className="foldericonimg" src={space.icon} alt="" /> : space.icon ? <span className="fe">{space.icon}</span> : <Folder size={size * 0.5} color="#fff" />}</span>;
  return <Avatar name={space.name} url={space.iconUrl} of={{ kind: "space", id: space.id }} size={size} />;
}

/** True on touch-first devices (finger, no hover). */
export const isCoarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
/**
 * Touch long-press: after `ms` without moving more than 10px `fire(x, y)` is called and the click that follows the release is swallowed.
 * (Mouse and keyboard keep using the contextmenu event; on Android the browser fires contextmenu after a long press too, which the handlers
 * already accept. Calling both for one press is harmless: they open the same menu.)
 */
export interface LPState { t?: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean }
/** The handlers behind useLongPress, on explicit state (so a list can share one state object and survive re-renders mid-press). */
export function lpHandlers(st: LPState, fire: (x: number, y: number) => void, ms = 400) {
  const cancel = () => { clearTimeout(st.t); st.t = undefined; };
  return {
    onTouchStart: (e: React.TouchEvent) => {
      if (e.touches.length > 1) return cancel();
      const t = e.touches[0]; st.x = t.clientX; st.y = t.clientY; st.fired = false; cancel();
      st.t = setTimeout(() => { st.fired = true; st.t = undefined; try { navigator.vibrate?.(12); } catch { /* not allowed */ } fire(st.x, st.y); }, ms);
    },
    onTouchMove: (e: React.TouchEvent) => { const t = e.touches[0]; if (Math.hypot(t.clientX - st.x, t.clientY - st.y) > 10) cancel(); },
    onTouchEnd: (e: React.TouchEvent) => { cancel(); if (st.fired && e.cancelable) e.preventDefault(); },
    onTouchCancel: cancel,
    /** first line of an onClick: true when this click is the tail of a long press (and consumes it) */
    swallow: () => { if (st.fired) { st.fired = false; return true; } return false; },
  };
}
export function useLongPress(fire: (x: number, y: number) => void, ms = 400) {
  const st = useRef<LPState>({ x: 0, y: 0, fired: false });
  return lpHandlers(st.current, fire, ms);
}

/** Square media tile of `size` px that never outgrows a phone: min(size, 70vw for 300 / 38vw for 148), always square. */
export const sq = (size: number): React.CSSProperties => ({ width: `min(${size}px, ${size >= 200 ? 70 : 38}vw)`, aspectRatio: "1 / 1", height: "auto" });
