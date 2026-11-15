// Pure Matrix event -> UniChat model mapping. No SDK imports, so it is unit-testable with fixture events.
import type { Attachment, AttachmentKind, Card, Message, Poll, Reaction } from "@unimsg/core";

/** The subset of a Matrix client-server event we need (decrypted content for encrypted events). */
export interface RawEvent {
  event_id: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: Record<string, any>;
  unsigned?: Record<string, any>;
  state_key?: string;
}

export interface MapCtx {
  accountId?: string;
  chatId: string;
  selfId: string;
  nameOf(userId: string): string;
  /** Latest valid replacement event (already checked: same sender), if any. */
  edit?: RawEvent;
  reactions?: Reaction[];
  /** Resolve the target of a reply for the preview. */
  replyPreview?(eventId: string): { sender?: string; textPreview?: string } | undefined;
  status?: Message["status"];
  /** For poll start events: related m.poll.response / m.poll.end events (any order; filtered here). */
  pollRelated?: RawEvent[];
  /** Is this user currently joined to the room? (votes from non-members are ignored). Default: everybody. */
  isMember?(userId: string): boolean;
  /** May this user end someone else's poll (redact power level)? */
  canEndPoll?(userId: string): boolean;
  /** Known joined member count of the room (membership rows are only shown for small rooms). */
  memberCount?: number;
  /** Other events of the same room that may relate to this one (call answer/hangup). */
  callRelated?: RawEvent[];
  now?: number;
}

export const UNDECRYPTABLE_TEXT = "[Encrypted message – keys not available yet]";

export function isRedacted(ev: RawEvent): boolean {
  return !!ev.unsigned?.redacted_because;
}

/** Relation info of an event (m.relates_to), if any. */
export function relationOf(ev: RawEvent): { relType?: string; eventId?: string; key?: string; replyTo?: string } {
  const r = ev.content?.["m.relates_to"];
  if (!r || typeof r !== "object") return {};
  return { relType: r.rel_type, eventId: r.event_id, key: r.key, replyTo: r["m.in_reply_to"]?.event_id };
}

/** m.thread relation: `root` is the thread root, `replyTo` the event to show as the reply target (a real in_reply_to, else the root). */
export function threadOf(ev: RawEvent): { root: string; replyTo: string } | undefined {
  const r = ev.content?.["m.relates_to"];
  if (!r || r.rel_type !== "m.thread" || typeof r.event_id !== "string") return undefined;
  const real = r["m.in_reply_to"]?.event_id;
  return { root: r.event_id, replyTo: typeof real === "string" && !r.is_falling_back ? real : r.event_id };
}

/** Strip legacy reply fallback ("> <@u> quote\n\nreal text"). */
export function stripReplyFallback(body: string, isReply: boolean): string {
  if (!isReply || !body.startsWith("> ")) return body;
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].startsWith(">")) i++;
  if (i < lines.length && lines[i] === "") i++;
  return lines.slice(i).join("\n");
}


// ---------------------------------------------------------------- formatted bodies (org.matrix.custom.html) and mentions
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—" };
const decodeEntities = (t: string) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return Number.isFinite(n) ? String.fromCodePoint(n) : m; } catch { return m; } }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const safeDecode = (t: string) => { try { return decodeURIComponent(t); } catch { return t; } };
const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MATRIX_TO_USER = /^https?:\/\/matrix\.to\/#\/((?:@|%40)[^?/]+)|^matrix:u\/([^?/]+)/i;

/** Custom emoji seen in received messages (`<img data-mx-emoticon>`): lower-case shortcode -> mxc:// url. Shared by all Matrix accounts in this process (names only, no ids). */
export const emoticons = new Map<string, string>();

/** Render a Matrix `org.matrix.custom.html` body as readable text: **bold**, *italic*, ~~strike~~, `code`, fenced code, "- " / "1. " lists,
 *  "> " quotes, `text (url)` links, `@Name` user pills, `||spoilers||`. The reply fallback (<mx-reply>) is removed. Unknown tags keep their text. */
export function htmlToText(html: string): string {
  html = html.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  type Buf = { text: string; kind: "root" | "quote" | "pre" };
  const bufs: Buf[] = [{ text: "", kind: "root" }];
  const cur = () => bufs[bufs.length - 1];
  const lists: { ordered: boolean; n: number }[] = [];
  const links: { href: string; start: number; buf: Buf }[] = [];
  const nl = (n: number) => { const b = cur(); if (!b.text) return; const have = /\n*$/.exec(b.text)![0].length; if (have < n) b.text += "\n".repeat(n - have); };
  const put = (t: string) => { cur().text += t; };
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+|<)/g;
  let m: RegExpExecArray | null;
  const closers: string[] = []; // per open inline tag: the marker to emit on close
  const stackMark: { tag: string; mark: string }[] = [];
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      const t = decodeEntities(m[4]);
      put(cur().kind === "pre" ? t : t.replace(/\s+/g, " "));
      continue;
    }
    const close = m[1] === "/"; const tag = m[2].toLowerCase(); const attrs = m[3] ?? "";
    const attr = (n: string) => { const r = new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs); return r ? decodeEntities(r[2] ?? r[3] ?? r[4] ?? "") : undefined; };
    const inlineMark = (open: string, shut = open) => { if (!close) { put(open); stackMark.push({ tag, mark: shut }); } else { const i = stackMark.map((x) => x.tag).lastIndexOf(tag); if (i >= 0) { put(stackMark[i].mark); stackMark.splice(i, 1); } } };
    switch (tag) {
      case "br": put("\n"); break;
      case "p": case "div": case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": case "table": case "tr":
        if (/^h/.test(tag) && close) inlineMark("**");
        nl(tag === "p" || /^h/.test(tag) ? 2 : 1);
        if (/^h/.test(tag) && !close) inlineMark("**");
        break;
      case "hr": nl(1); put("---"); nl(1); break;
      case "strong": case "b": inlineMark("**"); break;
      case "em": case "i": inlineMark("*"); break;
      case "del": case "s": case "strike": inlineMark("~~"); break;
      case "u": break;
      case "code": if (cur().kind !== "pre") inlineMark("`"); break;
      case "pre":
        if (!close) { nl(1); bufs.push({ text: "", kind: "pre" }); }
        else if (cur().kind === "pre") { const b = bufs.pop()!; nl(1); put("```\n" + b.text.replace(/^\n+|\n+$/g, "") + "\n```"); nl(1); }
        break;
      case "blockquote":
        if (!close) { nl(1); bufs.push({ text: "", kind: "quote" }); }
        else if (cur().kind === "quote") { const b = bufs.pop()!; nl(1); put(b.text.trim().split("\n").map((l) => (l ? "> " + l : ">")).join("\n")); nl(1); }
        break;
      case "ul": case "ol":
        if (!close) { nl(1); lists.push({ ordered: tag === "ol", n: Number(attr("start") ?? 1) || 1 }); } else { lists.pop(); nl(1); }
        break;
      case "li":
        if (!close) { nl(1); const l = lists[lists.length - 1]; put("  ".repeat(Math.max(0, lists.length - 1)) + (l?.ordered ? `${l.n++}. ` : "- ")); } else nl(1);
        break;
      case "a":
        if (!close) links.push({ href: attr("href") ?? "", start: cur().text.length, buf: cur() });
        else {
          const l = links.pop(); if (!l) break;
          const b = l.buf; let label = b.text.slice(l.start).trim();
          const pill = MATRIX_TO_USER.exec(l.href);
          let rep = label;
          if (pill) rep = label.startsWith("@") ? label : "@" + (label || safeDecode(pill[1] ?? pill[2]).replace(/^@/, ""));
          else if (/^https?:\/\//i.test(l.href) && label && label !== l.href && label.replace(/\/$/, "") !== l.href.replace(/\/$/, "")) rep = `${label} (${l.href})`;
          else if (!label) rep = l.href;
          b.text = b.text.slice(0, l.start) + rep;
        }
        break;
      case "span": case "font":
        if (!close) { const sp = attrs.includes("data-mx-spoiler"); if (sp) put("||"); stackMark.push({ tag, mark: sp ? "||" : "" }); } else inlineMark(""); break;
      case "img": {
        // MSC2545 custom emoji / sticker-like inline images: keep the :shortcode: and remember where its picture lives (Connector.avatar kind "emoji")
        const emo = /\bdata-mx-emoticon\b/i.test(attrs) ? (attr("alt") || attr("title") || "").replace(/^:+|:+$/g, "") : "";
        const src = attr("src");
        if (/^[\w+\-.]{1,64}$/.test(emo) && src && /^mxc:\/\/[^/\s]+\/\S+$/.test(src)) { emoticons.set(emo.toLowerCase(), src); put(`:${emo}:`); }
        else put(attr("alt") || attr("title") || "[image]");
        break;
      }
      default: break;
    }
  }
  void closers;
  while (bufs.length > 1) { const b = bufs.pop()!; put(b.text); }
  return cur().text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Content fields for an outgoing text with structured mentions: `m.mentions` + an HTML body with matrix.to pills. Plain text without mentions
 *  returns {} (the message stays a plain `m.text`). Invalid/overlapping spans are ignored. */
export function mentionContent(text: string, mentions: { id: string; name: string; start: number; length: number }[] | undefined): Record<string, unknown> {
  const ok = (mentions ?? []).filter((m) => /^@[^:\s@]+:\S+$/.test(m.id) && Number.isInteger(m.start) && Number.isInteger(m.length) && m.start >= 0 && m.length > 0 && m.start + m.length <= text.length)
    .sort((a, b) => a.start - b.start);
  const spans: typeof ok = [];
  for (const m of ok) if (!spans.length || m.start >= spans[spans.length - 1].start + spans[spans.length - 1].length) spans.push(m);
  if (!spans.length) return {};
  let html = ""; let pos = 0;
  const body = (t: string) => escapeHtml(t).replace(/\n/g, "<br>");
  for (const m of spans) {
    html += body(text.slice(pos, m.start)) + `<a href="https://matrix.to/#/${encodeURIComponent(m.id)}">${escapeHtml(text.slice(m.start, m.start + m.length))}</a>`;
    pos = m.start + m.length;
  }
  html += body(text.slice(pos));
  return { format: "org.matrix.custom.html", formatted_body: html, "m.mentions": { user_ids: [...new Set(spans.map((m) => m.id))] } };
}

/** First http(s) URL in a text (trailing punctuation removed), for sending a link preview. */
export function firstHttpUrl(text: string): string | undefined {
  const m = /\bhttps?:\/\/[^\s<>"')\]]+/i.exec(text);
  if (!m) return undefined;
  const u = m[0].replace(/[.,;:!?]+$/, "");
  try { const p = new URL(u); return p.protocol === "https:" || p.protocol === "http:" ? u : undefined; } catch { return undefined; }
}

/** Outgoing MSC4095 preview (`com.beeper.linkpreviews`) from the homeserver's `/preview_url` answer (OpenGraph keys). Undefined when it has no title and no description. */
export function linkPreviewContent(url: string, og: Record<string, unknown>): Record<string, unknown> | undefined {
  const s = (k: string, max: number) => (typeof og[k] === "string" && og[k] ? (og[k] as string).slice(0, max) : undefined);
  const title = s("og:title", 200), description = s("og:description", 400);
  if (!title && !description) return undefined;
  const p: Record<string, unknown> = { matched_url: url, "og:url": s("og:url", 2000) ?? url };
  if (title) p["og:title"] = title;
  if (description) p["og:description"] = description;
  const img = s("og:image", 500);
  if (img && /^mxc:\/\//.test(img)) {
    p["og:image"] = img;
    for (const k of ["og:image:width", "og:image:height", "matrix:image:size"]) if (typeof og[k] === "number") p[k] = og[k];
    const t = s("og:image:type", 100); if (t) p["og:image:type"] = t;
  }
  return { "com.beeper.linkpreviews": [p] };
}

/** MSC4095 link previews attached by the sender (`com.beeper.linkpreviews` / `org.matrix.msc4095.url_previews`): first one as a link card. We never fetch URLs. */
function linkPreviewCard(content: Record<string, any>): Card | undefined {
  const arr = content["com.beeper.linkpreviews"] ?? content["org.matrix.msc4095.url_previews"] ?? content["m.url_previews"];
  const p = Array.isArray(arr) ? arr.find((x) => x && typeof x === "object") : undefined;
  if (!p) return undefined;
  const title = String(p["og:title"] ?? p.title ?? "").slice(0, 200);
  const url = String(p.matched_url ?? p["og:url"] ?? p.url ?? "");
  if (!title && !url) return undefined;
  const card: Card = { kind: "link", title: title || url };
  const desc = p["og:description"] ?? p.description; if (typeof desc === "string" && desc) card.body = desc.slice(0, 400);
  if (/^https?:\/\//i.test(url)) card.url = url;
  return card;
}

function attachmentKind(msgtype: string | undefined, content: Record<string, any>, type: string): AttachmentKind | undefined {
  if (type === "m.sticker") return "sticker";
  const voice = content["org.matrix.msc3245.voice"] !== undefined || content["m.voice"] !== undefined;
  switch (msgtype) {
    case "m.image": return "image";
    case "m.video": return "video";
    case "m.audio": return voice ? "voice" : "audio";
    case "m.file": return "file";
    default: return undefined;
  }
}

/** Text shown for an event body, honouring the edit if present. */
function bodyOf(content: Record<string, any>, isReply: boolean): string {
  if (content.format === "org.matrix.custom.html" && typeof content.formatted_body === "string" && content.formatted_body) {
    const t = htmlToText(content.formatted_body);
    if (t) return t;
  }
  const body = typeof content.body === "string" ? content.body : "";
  return stripReplyFallback(body, isReply);
}

/** Map a message-like event (m.room.message / m.sticker). Returns null for events that are not messages. */
export function mapMessage(ev: RawEvent, ctx: MapCtx): Message | null {
  if (isSpecialType(ev.type)) return mapSpecial(ev, ctx);
  if (ev.type !== "m.room.message" && ev.type !== "m.sticker" && ev.type !== "m.room.encrypted" && !isPollStart(ev.type)) return null;
  const rel = relationOf(ev);
  if (rel.relType === "m.replace") return null; // edits are patches, not messages
  const fromMe = ev.sender === ctx.selfId;
  const base: Message = {
    id: ev.event_id, chatId: ctx.chatId, accountId: ctx.accountId,
    sender: ctx.nameOf(ev.sender), senderId: ev.sender, text: "",
    time: new Date(ev.origin_server_ts).toISOString(), fromMe,
  };
  if (fromMe) base.status = ctx.status ?? "sent";
  if (ctx.reactions?.length) base.reactions = ctx.reactions;

  if (isRedacted(ev)) return { ...base, deleted: true };
  if (ev.type === "m.room.encrypted") return { ...base, text: UNDECRYPTABLE_TEXT };

  const content = ev.content ?? {};
  if (isPollStart(ev.type)) {
    const ps = parsePollStart(ev);
    if (!ps) return { ...base, text: pollFallbackText(content) };
    return { ...base, text: "", poll: tallyPoll(ev, ps, ctx.pollRelated ?? [], ctx.selfId, ctx.isMember, ctx.canEndPoll) };
  }
  const thr = threadOf(ev);
  const replyTarget = thr ? thr.replyTo : rel.replyTo;
  if (replyTarget) {
    const p = ctx.replyPreview?.(replyTarget);
    // `thread: true` is the flat-view hint for m.thread replies (the reply points at the previous message of the thread, or its root).
    base.replyTo = { messageId: replyTarget, sender: p?.sender, textPreview: p?.textPreview, ...(thr ? { thread: true } : {}) } as Message["replyTo"];
  }
  if (ctx.edit && !isRedacted(ctx.edit)) {
    const nc = ctx.edit.content?.["m.new_content"];
    if (nc && typeof nc === "object") {
      base.editedAt = new Date(ctx.edit.origin_server_ts).toISOString();
      return finish(base, ev, nc, !!replyTarget, content);
    }
  }
  return finish(base, ev, content, !!replyTarget, content);
}

/** Parse "geo:lat,lng[;u=..]" (RFC 5870). */
export function parseGeoUri(uri: unknown): { lat: number; lng: number } | undefined {
  if (typeof uri !== "string") return undefined;
  const m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i.exec(uri.trim());
  if (!m) return undefined;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;
}
export function locationContent(l: { lat: number; lng: number; name?: string }) {
  const geo_uri = `geo:${l.lat},${l.lng}`;
  return { msgtype: "m.location", body: l.name ? `${l.name} (${geo_uri})` : `Location ${geo_uri}`, geo_uri };
}

const KNOWN_MSGTYPES = new Set(["m.text", "m.notice", "m.emote", "m.image", "m.video", "m.audio", "m.file", "m.location", "m.key.verification.request"]);

function finish(base: Message, ev: RawEvent, textContent: Record<string, any>, isReply: boolean, origContent: Record<string, any>): Message {
  const kind = attachmentKind(origContent.msgtype, origContent, ev.type);
  if (kind) {
    const info = origContent.info ?? {};
    const hasSource = !!(origContent.url || origContent.file);
    const filename: string | undefined = typeof origContent.filename === "string" ? origContent.filename : undefined;
    const body = bodyOf(textContent, isReply);
    // MSC2530: if `filename` is set and differs from body, body is a caption. Otherwise body is the file name.
    const caption = filename && body !== filename ? body : "";
    const name = filename ?? (kind === "sticker" ? undefined : body || undefined);
    if (hasSource) {
      const a: Attachment = { id: "0", kind, mime: info.mimetype ?? "application/octet-stream", name };
      if (typeof info.size === "number") a.size = info.size;
      if (typeof info.w === "number") a.width = info.w;
      if (typeof info.h === "number") a.height = info.h;
      if (typeof info.duration === "number") a.durationMs = info.duration;
      // GIFs as muted looping videos (Element / Gomuks / Beeper bridges set these info flags)
      if (kind === "video" && (info["fi.mau.gif"] === true || info["fi.mau.loop"] === true || info["xyz.amorgan.gif"] === true || info["fi.mau.no_audio"] === true && info["fi.mau.autoplay"] === true)) a.gif = true;
      const blk = origContent["org.matrix.msc1767.audio"] as { duration?: number; waveform?: unknown } | undefined;
      if (blk && typeof blk === "object") {
        if (a.durationMs === undefined && typeof blk.duration === "number") a.durationMs = blk.duration;
        if (Array.isArray(blk.waveform) && blk.waveform.every((v) => typeof v === "number")) a.waveform = (blk.waveform as number[]).slice(0, 200).map((v) => Math.max(0, Math.min(100, Math.round(v / 10.24))));
      }
      base.attachments = [a];
      base.text = kind === "sticker" ? "" : caption;
      return base;
    }
  }
  if (origContent.msgtype === "m.location") {
    const g = parseGeoUri(origContent.geo_uri);
    if (g) {
      const body = bodyOf(textContent, isReply);
      base.location = { ...g, name: body && !body.includes("geo:") ? body : undefined };
      base.text = "";
      return base;
    }
  }
  let text = bodyOf(textContent, isReply);
  if (origContent.msgtype === "m.emote") text = `* ${base.sender} ${text}`;
  base.text = text;
  const mt = origContent.msgtype;
  if (typeof mt === "string" && !KNOWN_MSGTYPES.has(mt)) base.card = { kind: "other", title: mt, body: text || undefined };
  if (!base.card && (mt === "m.text" || mt === "m.notice")) { const lp = linkPreviewCard(origContent); if (lp) base.card = lp; }
  if (mt === "m.key.verification.request") { base.system = { kind: "info" }; base.text = "Key verification requested"; }
  return base;
}

/** Build the Reaction[] list from m.reaction events grouped by key. */
export function groupReactions(reactions: Iterable<{ key: string; sender: string }>, selfId?: string): Reaction[] {
  const m = new Map<string, Set<string>>();
  for (const r of reactions) {
    if (!r.key) continue;
    if (!m.has(r.key)) m.set(r.key, new Set());
    m.get(r.key)!.add(r.sender);
  }
  return [...m].map(([emoji, s]) => (selfId && s.has(selfId) ? { emoji, senderIds: [...s], mine: true } : { emoji, senderIds: [...s] }));
}

/** Pick the most recent valid edit for `target` out of candidate m.replace events. */
export function pickEdit(target: RawEvent, candidates: RawEvent[]): RawEvent | undefined {
  let best: RawEvent | undefined;
  for (const c of candidates) {
    const r = relationOf(c);
    if (r.relType !== "m.replace" || r.eventId !== target.event_id) continue;
    if (c.sender !== target.sender || c.type !== target.type || isRedacted(c)) continue;
    if (!c.content?.["m.new_content"]) continue;
    if (!best || c.origin_server_ts > best.origin_server_ts) best = c;
  }
  return best;
}

/** Accept "@user:server", "user:server" or a bare "user" (resolved against our own server). Returns undefined if invalid. */
export function normalizeUserId(handle: string, selfId: string): string | undefined {
  let h = handle.trim();
  if (!h) return undefined;
  if (!h.startsWith("@")) h = "@" + h;
  if (!h.includes(":")) {
    const domain = selfId.slice(selfId.indexOf(":") + 1);
    if (!domain || domain === selfId) return undefined;
    h = `${h}:${domain}`;
  }
  return /^@[^:\s@]+:[^\s@]+$/.test(h) ? h : undefined;
}

/** Parse an alias (#x:srv), room id (!x:srv), matrix.to link or matrix: URI, with optional ?via= servers. */
export function parseSpaceInvite(input: string): { target: string; via: string[] } | undefined {
  let s = input.trim();
  if (!s) return undefined;
  let via: string[] = [];
  const q = s.indexOf("?");
  if (q >= 0) {
    via = new URLSearchParams(s.slice(q + 1)).getAll("via").filter(Boolean);
    s = s.slice(0, q);
  }
  const mt = /^https?:\/\/matrix\.to\/#\/(.+)$/i.exec(s);
  const uri = /^matrix:(r|roomid)\/(.+)$/i.exec(s);
  if (mt) { try { s = decodeURIComponent(mt[1]); } catch { return undefined; } }
  else if (uri) s = (uri[1].toLowerCase() === "r" ? "#" : "!") + decodeURIComponent(uri[2]);
  else { try { s = decodeURIComponent(s); } catch { return undefined; } }
  s = s.replace(/\/+$/, "");
  // a matrix.to event link (!room:srv/$event) -> room part only
  s = s.split("/")[0];
  // room ids of room version 12 have no ":server" part ("!opaquehash"); aliases always do
  return /^(#[^:\s]+:[^\s]+|![^:\s]+(:[^\s]+)?)$/.test(s) ? { target: s, via } : undefined;
}

// ---------------------------------------------------------------- polls (MSC3381)
// The SDK (45) parses the key named like the event type ("m.poll.start" / "org.matrix.msc3381.poll.start"); the final
// spec shape uses content "m.poll" and "m.selections". We accept every variant and send both shapes in one event.
const POLL_START = ["m.poll.start", "org.matrix.msc3381.poll.start"];
const POLL_RESPONSE = ["m.poll.response", "org.matrix.msc3381.poll.response"];
const POLL_END = ["m.poll.end", "org.matrix.msc3381.poll.end"];
export const isPollStart = (t: string) => POLL_START.includes(t);
export const isPollResponse = (t: string) => POLL_RESPONSE.includes(t);
export const isPollEnd = (t: string) => POLL_END.includes(t);
export const isPollEvent = (t: string) => isPollStart(t) || isPollResponse(t) || isPollEnd(t);

/** Text of an MSC1767 text-ish object: m.text / org.matrix.msc1767.text (string or [{body}]) / m.message / body. */
function textOf(o: any): string {
  if (!o || typeof o !== "object") return "";
  for (const k of ["m.text", "org.matrix.msc1767.text", "m.message", "org.matrix.msc1767.message", "body"]) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v)) { const b = v.find((x) => typeof x?.body === "string" && x.body); if (b) return b.body; }
  }
  return "";
}

export interface PollStart { question: string; options: { id: string; text: string }[]; multiple: boolean; max: number }

export function parsePollStart(ev: RawEvent): PollStart | undefined {
  const c = ev.content ?? {};
  const p = c["m.poll"] ?? c["m.poll.start"] ?? c["org.matrix.msc3381.poll.start"];
  if (!p || typeof p !== "object") return undefined;
  const question = textOf(p.question);
  if (!question || !Array.isArray(p.answers)) return undefined;
  const seen = new Set<string>();
  const options: PollStart["options"] = [];
  for (const a of p.answers.slice(0, 20)) {
    const id = typeof a?.id === "string" && a.id ? a.id : typeof a?.["m.id"] === "string" ? a["m.id"] : "";
    const text = textOf(a);
    if (!id || !text || seen.has(id)) continue;
    seen.add(id); options.push({ id, text });
  }
  if (!options.length) return undefined;
  const max = Number.isFinite(p.max_selections) && p.max_selections > 0 ? Math.floor(p.max_selections) : 1;
  return { question, options, multiple: max > 1, max };
}

/** Selected option ids of a response event, or undefined if the event is not a valid response. */
export function parsePollResponse(ev: RawEvent): string[] | undefined {
  const c = ev.content ?? {};
  const v = c["m.selections"] ?? c["org.matrix.msc3381.selections"]
    ?? c["m.poll.response"]?.answers ?? c["org.matrix.msc3381.poll.response"]?.answers;
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

function pollFallbackText(c: Record<string, any>): string { return textOf(c) || "[poll]"; }

/** Tally a poll. Latest response per member wins, responses after the end are ignored, ending by the poll's creator or (MSC3381) by anyone with redact power (`canEnd`). */
export function tallyPoll(start: RawEvent, ps: PollStart, related: RawEvent[], selfId: string, isMember: (u: string) => boolean = () => true, canEnd: (u: string) => boolean = () => false): Poll {
  const rel = related.filter((e) => !isRedacted(e) && relationOf(e).eventId === start.event_id && relationOf(e).relType === "m.reference");
  const end = rel.filter((e) => isPollEnd(e.type) && (e.sender === start.sender || canEnd(e.sender)))
    .sort((a, b) => a.origin_server_ts - b.origin_server_ts || a.event_id.localeCompare(b.event_id))[0];
  const latest = new Map<string, RawEvent>();
  for (const e of rel) {
    if (!isPollResponse(e.type) || !isMember(e.sender)) continue;
    if (end && e.origin_server_ts > end.origin_server_ts) continue;
    const cur = latest.get(e.sender);
    if (!cur || e.origin_server_ts > cur.origin_server_ts || (e.origin_server_ts === cur.origin_server_ts && e.event_id > cur.event_id)) latest.set(e.sender, e);
  }
  const ids = new Set(ps.options.map((o) => o.id));
  const voters = new Map<string, string[]>(ps.options.map((o) => [o.id, []]));
  for (const [user, e] of latest) {
    const picked = parsePollResponse(e);
    if (!picked) continue; // malformed: counts as spoiled
    const valid = [...new Set(picked)].filter((i) => ids.has(i));
    if (valid.length !== new Set(picked).size) continue; // unknown option id: spoiled response
    for (const id of valid.slice(0, ps.max)) voters.get(id)!.push(user);
  }
  const options = ps.options.map((o) => ({ id: o.id, text: o.text, voters: voters.get(o.id)! }));
  const poll: Poll = { question: ps.question, options, multiple: ps.multiple };
  if (end) poll.closed = true;
  poll.mine = options.filter((o) => o.voters.includes(selfId)).map((o) => o.id);
  return poll;
}

/** Content for an outgoing poll start: both the SDK-era keys and the final-spec keys, so Element and spec clients render it. */
export function pollStartContent(question: string, optionTexts: string[], multiple: boolean, newId: () => string) {
  const answers = optionTexts.map((t) => ({ id: newId(), text: t }));
  const max = multiple ? answers.length : 1;
  const fallback = `${question}\n${answers.map((a, i) => `${i + 1}. ${a.text}`).join("\n")}`;
  return {
    body: fallback, "m.text": fallback,
    "m.poll": { question: { "m.text": question }, kind: "m.disclosed", max_selections: max, answers: answers.map((a) => ({ "m.id": a.id, id: a.id, "m.text": a.text })) },
    "m.poll.start": { question: { "m.text": question }, kind: "m.poll.disclosed", max_selections: max, answers: answers.map((a) => ({ id: a.id, "m.text": a.text })) },
  };
}
export function pollResponseContent(startEventId: string, optionIds: string[]) {
  return {
    "m.selections": optionIds, "m.poll.response": { answers: optionIds },
    "m.relates_to": { rel_type: "m.reference", event_id: startEventId },
  };
}
export function pollEndContent(startEventId: string) {
  return { "m.poll.end": {}, "m.text": "The poll has ended.", "m.relates_to": { rel_type: "m.reference", event_id: startEventId } };
}

// ---------------------------------------------------------------- special events: state rows, calls, widgets, verification
const STATE_TYPES = new Set(["m.room.name", "m.room.topic", "m.room.avatar", "m.room.create", "m.room.encryption", "m.room.member", "m.room.power_levels", "m.room.tombstone"]);
const CALL_INVITE = "m.call.invite";
const CALL_END = new Set(["m.call.hangup", "m.call.answer", "m.call.reject"]);
const GROUP_CALL = ["org.matrix.msc3401.call"];
const WIDGET = ["im.vector.modular.widgets", "m.widget"];
const VERIF = new Set(["m.key.verification.done", "m.key.verification.cancel"]);
const VERIF_NOISE = new Set(["m.key.verification.start", "m.key.verification.ready", "m.key.verification.accept", "m.key.verification.key", "m.key.verification.mac"]);

export function isCallEnd(t: string) { return CALL_END.has(t); }
export const isSpecialType = (t: string) => STATE_TYPES.has(t) || t === CALL_INVITE || CALL_END.has(t) || t === "m.call.candidates" || t === "m.call.select_answer" || t === "m.call.negotiate"
  || GROUP_CALL.includes(t) || WIDGET.includes(t) || VERIF.has(t) || VERIF_NOISE.has(t) || t.startsWith("org.matrix.msc3401.call.");

function baseOf(ev: RawEvent, ctx: MapCtx): Message {
  const fromMe = ev.sender === ctx.selfId;
  const m: Message = { id: ev.event_id, chatId: ctx.chatId, accountId: ctx.accountId, sender: ctx.nameOf(ev.sender), senderId: ev.sender, text: "", time: new Date(ev.origin_server_ts).toISOString(), fromMe };
  return m;
}
const info = (m: Message, text: string): Message => ({ ...m, text, system: { kind: "info" } });

/** Call card for an m.call.invite event given the rest of the room's call events. */
export function callCard(invite: RawEvent, related: RawEvent[], selfId: string, now = Date.now()): Card {
  const id = invite.content?.call_id;
  const rel = related.filter((e) => CALL_END.has(e.type) && e.content?.call_id === id && !isRedacted(e));
  const answer = rel.find((e) => e.type === "m.call.answer");
  const stop = rel.filter((e) => e.type !== "m.call.answer").sort((a, b) => a.origin_server_ts - b.origin_server_ts)[0];
  const video = typeof invite.content?.offer?.sdp === "string" && invite.content.offer.sdp.includes("m=video");
  const kind = video ? "Video call" : "Voice call";
  const fromMe = invite.sender === selfId;
  const lifetime = Number.isFinite(invite.content?.lifetime) ? invite.content.lifetime : 60_000;
  let status: string;
  const rows: { label: string; value: string }[] = [];
  if (answer && stop) {
    status = "ended";
    const secs = Math.max(0, Math.round((stop.origin_server_ts - answer.origin_server_ts) / 1000));
    if (secs > 0) rows.push({ label: "Duration", value: secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s` });
  } else if (answer) status = "in progress";
  else if (stop?.type === "m.call.reject") status = "declined";
  else if (stop || invite.origin_server_ts + lifetime < now) status = fromMe ? "no answer" : "missed";
  else status = "ringing";
  return { kind: "call", title: `${kind} – ${status}`, subtitle: fromMe ? "Outgoing" : "Incoming", when: new Date(invite.origin_server_ts).toISOString(), rows: rows.length ? rows : undefined };
}

function widgetUrl(c: Record<string, any>): string | undefined {
  if (c.type === "jitsi" && typeof c.data?.domain === "string" && typeof c.data?.conferenceId === "string") return `https://${c.data.domain}/${c.data.conferenceId}`;
  const u = c.url ?? c.data?.url;
  return typeof u === "string" && /^https?:\/\//i.test(u) && !u.includes("$matrix_") ? u : typeof u === "string" && /^https?:\/\//i.test(u) ? u.split("?")[0] : undefined;
}

function powerLabel(n: number): string | undefined { return n >= 100 ? "admin" : n >= 50 ? "moderator" : undefined; }

function mapSpecial(ev: RawEvent, ctx: MapCtx): Message | null {
  const t = ev.type, c = ev.content ?? {};
  if (VERIF_NOISE.has(t) || t === "m.call.candidates" || t === "m.call.select_answer" || t === "m.call.negotiate" || CALL_END.has(t)) return null;
  const base = baseOf(ev, ctx);
  if (isRedacted(ev)) return STATE_TYPES.has(t) ? null : { ...base, deleted: true };
  const actor = base.sender;
  const name = (id: string | undefined) => (id ? ctx.nameOf(id) : "someone");
  switch (t) {
    case "m.key.verification.done": return info(base, `Key verification completed (${actor})`);
    case "m.key.verification.cancel": return info(base, "Key verification cancelled");
    case CALL_INVITE: {
      const card = callCard(ev, ctx.callRelated ?? [], ctx.selfId, ctx.now);
      return { ...base, text: card.title, card };
    }
  }
  if (GROUP_CALL.includes(t)) {
    const type = c["m.type"] ?? c.type;
    if (!type && !c["m.terminated"]) return null;
    const video = type !== "m.voice" && type !== "voice";
    const ended = !!c["m.terminated"];
    const title = `Group ${video ? "video" : "voice"} call – ${ended ? "ended" : "started"}`;
    return { ...base, text: title, card: { kind: "call", title, subtitle: actor, when: base.time } };
  }
  if (t.startsWith("org.matrix.msc3401.call")) return null; // member events etc.: far too noisy
  if (WIDGET.includes(t)) {
    if (!c || !c.type || !(c.url || c.data)) return null; // removed widget
    const url = widgetUrl(c);
    const title = (typeof c.name === "string" && c.name) || String(c.type);
    return { ...base, text: `${actor} added a widget: ${title}`, card: { kind: "link", title, subtitle: String(c.type), url }, system: { kind: "info" } };
  }
  // state rows
  const prev = (ev.unsigned?.prev_content ?? {}) as Record<string, any>;
  switch (t) {
    case "m.room.create": return info(base, `${actor} created the room`);
    case "m.room.name": return info(base, c.name ? `${actor} changed the room name to "${c.name}"` : `${actor} removed the room name`);
    case "m.room.topic": return info(base, `${actor} changed the topic`);
    case "m.room.avatar": return info(base, c.url || c.info ? `${actor} changed the room picture` : `${actor} removed the room picture`);
    case "m.room.encryption": return info(base, "End-to-end encryption was enabled");
    case "m.room.tombstone": return info(base, "This room has been upgraded to a new room");
    case "m.room.power_levels": {
      const now = (c.users ?? {}) as Record<string, number>, was = (prev.users ?? {}) as Record<string, number>;
      const parts: string[] = [];
      for (const u of new Set([...Object.keys(now), ...Object.keys(was)])) {
        const a = powerLabel(now[u] ?? 0), b = powerLabel(was[u] ?? 0);
        if (a === b) continue;
        if (a && (!b || (now[u] ?? 0) > (was[u] ?? 0))) parts.push(`${name(u)} was made ${a}`);
        else parts.push(b && !a ? `${name(u)} is no longer ${b}` : `${name(u)} is now ${a ?? "a member"}`);
      }
      return parts.length ? info(base, parts.join("; ")) : null;
    }
    case "m.room.member": {
      if (ctx.memberCount !== undefined && ctx.memberCount > 50) return null;
      const target = ev.state_key ?? ev.sender, who = typeof c.displayname === "string" && c.displayname ? c.displayname : name(target);
      const pm = prev.membership as string | undefined, m = c.membership as string | undefined;
      if (m === pm) return null; // profile change only
      const self = target === ev.sender;
      switch (m) {
        case "join": return info(base, `${who} joined`);
        case "invite": return info(base, `${actor} invited ${who}`);
        case "leave": return info(base, pm === "ban" ? `${actor} unbanned ${who}` : self ? (pm === "invite" ? `${who} declined the invitation` : `${who} left`) : pm === "invite" ? `${actor} revoked the invitation for ${who}` : `${actor} removed ${who}`);
        case "ban": return info(base, `${actor} banned ${who}`);
        default: return null;
      }
    }
  }
  return null;
}
