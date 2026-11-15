// Graph JSON -> UniChat model. Pure functions, no I/O.
import type { Attachment, Card, Chat, Contact, Message, Reaction, Space } from "@unimsg/core";

// ---------------------------------------------------------------- Graph shapes (only what we read)
export interface Identity { id?: string; displayName?: string; userIdentityType?: string }
export interface IdSet { user?: Identity | null; application?: Identity | null; device?: Identity | null }
export interface GAttachment { id?: string; contentType?: string; contentUrl?: string | null; content?: string | null; name?: string | null; thumbnailUrl?: string | null }
export interface GMention { id: number; mentionText?: string; mentioned?: IdSet }
export interface GReaction { reactionType: string; createdDateTime?: string; user?: IdSet }
export interface GMessage {
  id: string; replyToId?: string | null; messageType?: string; createdDateTime?: string; lastModifiedDateTime?: string; lastEditedDateTime?: string | null; deletedDateTime?: string | null;
  subject?: string | null; summary?: string | null; importance?: string; from?: IdSet | null; body?: { contentType?: string; content?: string | null };
  attachments?: GAttachment[]; mentions?: GMention[]; reactions?: GReaction[]; eventDetail?: Record<string, any> | null; chatId?: string | null;
  channelIdentity?: { teamId?: string; channelId?: string } | null; replies?: GMessage[]; "@removed"?: { reason?: string };
}
export interface GMember { id?: string; userId?: string; displayName?: string; email?: string | null; roles?: string[] }
export interface GChat {
  id: string; topic?: string | null; chatType: "oneOnOne" | "group" | "meeting" | string; createdDateTime?: string; lastUpdatedDateTime?: string;
  members?: GMember[]; lastMessagePreview?: (GMessage & { isDeleted?: boolean }) | null; viewpoint?: { lastMessageReadDateTime?: string; isHidden?: boolean } | null;
}
export interface GTeam { id: string; displayName?: string; description?: string | null; isArchived?: boolean }
export interface GChannel { id: string; displayName?: string; description?: string | null; membershipType?: "standard" | "private" | "shared" | string; isArchived?: boolean }

export const chanChatId = (teamId: string, channelId: string) => `${teamId}/${channelId}`;
export const splitChan = (chatId: string): { teamId: string; channelId: string } | undefined => {
  const i = chatId.indexOf("/"); return i > 0 ? { teamId: chatId.slice(0, i), channelId: chatId.slice(i + 1) } : undefined;
};

// ---------------------------------------------------------------- HTML -> text
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"' };
export const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
  return ENT[e.toLowerCase()] ?? m;
});
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attr = (tag: string, name: string) => { const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag); return m ? decodeEntities(m[2] ?? m[3] ?? "") : undefined; };

export interface HtmlImage { src: string; alt?: string; hostedId?: string; kind: "emoji" | "sticker" | "image"; width?: number; height?: number }
/** Teams body HTML -> plain text. Mentions (<at>) become "@Name", links "text (url)", <attachment> placeholders vanish, images are returned separately. */
export function htmlToText(html: string): { text: string; images: HtmlImage[] } {
  const images: HtmlImage[] = [];
  let s = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<attachment\b[^>]*>(\s*<\/attachment>)?/gi, "");
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attr(tag, "src") ?? "", alt = attr(tag, "alt"), item = attr(tag, "itemtype") ?? "", cls = attr(tag, "class") ?? "";
    const hosted = /\/hostedContents\/([^/]+)\/\$value/i.exec(src)?.[1];
    if (/schema\.skype\.com\/Emoji/i.test(item) || /emoji/i.test(cls)) return alt ?? attr(tag, "title") ?? "";
    const w = Number(attr(tag, "width")), h = Number(attr(tag, "height"));
    images.push({ src, alt, hostedId: hosted ? decodeURIComponent(hosted) : undefined, kind: /sticker/i.test(item) || /sticker/i.test(cls) ? "sticker" : "image", ...(w > 0 ? { width: w } : {}), ...(h > 0 ? { height: h } : {}) });
    return "";
  });
  s = s.replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, (_m, inner: string) => "@" + decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/^@/, ""));
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (tag, inner: string) => {
    const href = attr(tag.slice(0, tag.indexOf(">") + 1), "href"); const label = inner.replace(/<[^>]+>/g, "");
    const l = decodeEntities(label).trim();
    return !href || /^(mailto:)?/i.test(href) && href.replace(/^mailto:/i, "") === l || href === l || href.replace(/\/$/, "") === l.replace(/\/$/, "") ? l || (href ?? "") : `${l} (${href})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|h[1-6]|blockquote|pre|table)>/gi, "\n").replace(/<li\b[^>]*>/gi, "\n• ").replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s).replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: s, images };
}
/** Plain text -> Teams HTML. */
export const textToHtml = (t: string) => escapeHtml(t).replace(/\r?\n/g, "<br>");

// ---------------------------------------------------------------- reactions
const REACTION_EMOJI: Record<string, string> = { like: "\u{1F44D}", heart: "❤️", laugh: "\u{1F606}", surprised: "\u{1F62E}", sad: "\u{1F641}", angry: "\u{1F620}" };
const EMOJI_REACTION = Object.fromEntries(Object.entries(REACTION_EMOJI).map(([k, v]) => [v, k]));
export const reactionToEmoji = (t: string) => REACTION_EMOJI[t] ?? t;
/** Emoji -> Graph reactionType: the six classic names, otherwise the Unicode emoji itself (accepted by v1.0 setReaction). */
export const emojiToReaction = (e: string) => EMOJI_REACTION[e] ?? EMOJI_REACTION[e.replace(/️/g, "")] ?? e;
export function mapReactions(rs: GReaction[] | undefined, me?: string): Reaction[] {
  const by = new Map<string, Reaction>();
  for (const r of rs ?? []) {
    const e = reactionToEmoji(r.reactionType); const id = r.user?.user?.id;
    const x = by.get(e) ?? { emoji: e, senderIds: [] }; if (id && !x.senderIds.includes(id)) x.senderIds.push(id);
    if (id && id === me) x.mine = true; by.set(e, x);
  }
  return [...by.values()];
}

// ---------------------------------------------------------------- cards
function tryJson(s: string | null | undefined): any { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } }
/** Adaptive / hero / thumbnail cards -> a generic "other" Card. */
export function mapCard(a: GAttachment): Card | undefined {
  const ct = a.contentType ?? "";
  if (/adaptive/i.test(ct)) {
    const c = tryJson(a.content); if (!c || typeof c !== "object") return undefined;
    const texts: { t: string; strong: boolean }[] = []; const rows: { label: string; value: string }[] = []; const buttons: string[] = [];
    const walk = (n: any, depth = 0) => {
      if (!n || typeof n !== "object" || depth > 8) return;
      if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
      if (n.type === "TextBlock" && typeof n.text === "string") texts.push({ t: n.text, strong: n.weight === "Bolder" || n.weight === "bolder" || n.size === "Large" || n.size === "ExtraLarge" || n.style === "heading" });
      if (n.type === "FactSet" && Array.isArray(n.facts)) for (const f of n.facts) if (f?.title) rows.push({ label: String(f.title), value: String(f.value ?? "") });
      if (n.type === "RichTextBlock" && Array.isArray(n.inlines)) texts.push({ t: n.inlines.map((i: any) => (typeof i === "string" ? i : i?.text ?? "")).join(""), strong: false });
      if ((n.type?.startsWith?.("Action.")) && typeof n.title === "string") buttons.push(n.title);
      for (const k of ["body", "items", "columns", "actions", "card", "facts"]) if (n[k] && k !== "facts") walk(n[k], depth + 1);
    };
    walk(c);
    const title = (texts.find((x) => x.strong) ?? texts[0])?.t ?? a.name ?? "Card";
    const rest = texts.filter((x) => x.t !== title).map((x) => x.t).join("\n");
    return { kind: "other", title, ...(rest ? { body: rest } : {}), ...(rows.length ? { rows } : {}), ...(buttons.length ? { buttons } : {}) };
  }
  if (/card\.(hero|thumbnail|o365connector|receipt|signin)/i.test(ct)) {
    const c = tryJson(a.content); if (!c || typeof c !== "object") return undefined;
    const title = String(c.title ?? c.summary ?? a.name ?? "Card");
    const buttons = Array.isArray(c.buttons) ? c.buttons.map((b: any) => String(b?.title ?? b?.name ?? "")).filter(Boolean) : undefined;
    return { kind: "other", title, ...(c.subtitle ? { subtitle: String(c.subtitle) } : {}), ...(c.text ? { body: String(c.text) } : {}), ...(buttons?.length ? { buttons } : {}) };
  }
  return undefined;
}

// ---------------------------------------------------------------- system events
function who(i?: IdSet | null) { return i?.user?.displayName || i?.application?.displayName || "Someone"; }
const names = (m: any) => (Array.isArray(m) ? m.map((x) => x?.displayName).filter(Boolean).join(", ") : "") || "someone";
/** systemEventMessage -> short human text; unknown event types fall back to a neutral line. */
export function systemText(m: GMessage): string {
  const d = m.eventDetail ?? {}; const t = String(d["@odata.type"] ?? "").replace(/^#microsoft\.graph\./, ""); const by = who(d.initiator);
  switch (t) {
    case "membersAddedEventMessageDetail": return `${by} added ${names(d.members)}`;
    case "membersDeletedEventMessageDetail": return `${by} removed ${names(d.members)}`;
    case "membersJoinedEventMessageDetail": return `${names(d.members)} joined`;
    case "membersLeftEventMessageDetail": return `${names(d.members)} left`;
    case "chatRenamedEventMessageDetail": return `${by} renamed the chat${d.chatDisplayName ? ` to "${d.chatDisplayName}"` : ""}`;
    case "callStartedEventMessageDetail": return "A call started";
    case "callEndedEventMessageDetail": return `Call ended${d.callDuration ? ` (${String(d.callDuration).replace(/^PT/, "").toLowerCase()})` : ""}`;
    case "callRecordingEventMessageDetail": return "A call recording is available";
    case "callTranscriptEventMessageDetail": return "A call transcript is available";
    case "meetingPolicyUpdatedEventMessageDetail": return "Meeting policy updated";
    case "channelAddedEventMessageDetail": return `${by} added a channel`;
    case "channelDeletedEventMessageDetail": return `${by} deleted a channel`;
    case "channelRenamedEventMessageDetail": return `${by} renamed the channel`;
    case "teamsAppInstalledEventMessageDetail": return `${by} added an app`;
    case "teamsAppRemovedEventMessageDetail": return `${by} removed an app`;
    case "tabAddedEventMessageDetail": return `${by} added a tab`;
    case "tabDeletedEventMessageDetail": return `${by} removed a tab`;
    case "conversationMemberRoleUpdatedEventMessageDetail": return `${by} changed a member's role`;
    default: return "Chat updated";
  }
}

// ---------------------------------------------------------------- messages
export interface MapCtx {
  chatId: string; me?: string;
  /** Registers the parent of a channel reply (for later edit / delete / react). */
  noteParent?: (messageId: string, parentId: string) => void;
}
export function mapMessage(m: GMessage, c: MapCtx): Message {
  const created = m.createdDateTime ?? new Date().toISOString();
  const senderId = m.from?.user?.id ?? m.from?.application?.id ?? "system";
  const fromMe = !!c.me && m.from?.user?.id === c.me;
  const base: Message = { id: m.id, chatId: c.chatId, sender: who(m.from), senderId, text: "", time: created, fromMe };
  if (m.replyToId) c.noteParent?.(m.id, m.replyToId);
  if (m.messageType === "systemEventMessage") { base.sender = "Teams"; base.senderId = "system"; base.fromMe = false; base.text = systemText(m); base.system = { kind: "info" }; return base; }
  if (m.deletedDateTime) { base.deleted = true; return base; }
  const body = m.body?.content ?? "";
  const { text: t0, images } = m.body?.contentType === "text" ? { text: decodeEntities(body).trim(), images: [] as HtmlImage[] } : htmlToText(body);
  let text = t0;
  if (m.subject) text = text ? `${m.subject}\n${text}` : m.subject;
  if (m.importance === "urgent") text = `[Urgent] ${text}`.trim(); else if (m.importance === "high") text = `[Important] ${text}`.trim();
  const atts: Attachment[] = []; const cards: Card[] = [];
  for (const a of m.attachments ?? []) {
    const ct = a.contentType ?? "";
    if (ct === "messageReference") {
      const r = tryJson(a.content) ?? {};
      if (r.messageId) base.replyTo = { messageId: String(r.messageId), ...(r.messageSender?.user?.displayName ? { sender: String(r.messageSender.user.displayName) } : {}), ...(r.messagePreview ? { textPreview: decodeEntities(String(r.messagePreview)).slice(0, 200) } : {}) };
    } else if (ct === "reference" && a.id) {
      const name = a.name ?? undefined; const mime = guessMime(name);
      atts.push({ id: `ref:${a.id}`, kind: mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file", mime, ...(name ? { name } : {}) });
    } else if (/giphy|image\//i.test(ct) && a.contentUrl) {
      atts.push({ id: `url:${a.id ?? atts.length}`, kind: "image", mime: ct.startsWith("image/") ? ct : "image/gif", gif: /gif/i.test(ct) || /giphy|tenor/i.test(a.contentUrl), ...(a.name ? { name: a.name } : {}) });
    } else {
      const card = mapCard(a); if (card) cards.push(card);
      else if (ct && !/^application\/vnd\.microsoft\.card\./i.test(ct) && ct !== "tab" && ct !== "meetingReference" && a.name) text = text || `[${a.name}]`;
    }
  }
  for (const im of images) {
    const idx = atts.length;
    if (im.hostedId) atts.push({ id: `hc:${im.hostedId}`, kind: im.kind === "sticker" ? "sticker" : "image", mime: "image/png", ...(im.width ? { width: im.width } : {}), ...(im.height ? { height: im.height } : {}), ...(/\.gif|giphy|tenor/i.test(im.src) ? { gif: true } : {}) });
    else if (im.src) atts.push({ id: `img:${idx}:${Buffer.from(im.src).toString("base64url")}`, kind: im.kind === "sticker" ? "sticker" : "image", mime: /\.gif/i.test(im.src) || /giphy|tenor/i.test(im.src) ? "image/gif" : "image/png", ...(/\.gif|giphy|tenor/i.test(im.src) ? { gif: true } : {}) });
  }
  base.text = text;
  if (atts.length) base.attachments = atts;
  if (cards.length) { base.card = cards[0]; base.cards = cards; if (!base.text) base.text = cards[0].title; }
  const rx = mapReactions(m.reactions, c.me); if (rx.length) base.reactions = rx;
  if (m.lastEditedDateTime) base.editedAt = m.lastEditedDateTime;
  if (fromMe) base.status = "sent";
  return base;
}
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav", pdf: "application/pdf", txt: "text/plain", zip: "application/zip" };
export const guessMime = (name?: string) => MIME[(name?.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream";

/** The patch for an already delivered message (edit / delete / reaction change). */
export function patchOf(msg: Message): import("@unimsg/core").MessagePatch {
  return { text: msg.text, ...(msg.editedAt ? { editedAt: msg.editedAt } : {}), deleted: !!msg.deleted, reactions: msg.reactions ?? [], ...(msg.attachments ? { attachments: msg.attachments } : {}), ...(msg.card ? { card: msg.card, cards: msg.cards } : {}) };
}

// ---------------------------------------------------------------- chats, spaces, contacts
export function memberName(m: GMember): string { return m.displayName || m.email || "Unknown"; }
export function chatName(c: GChat, me?: string): string {
  if (c.topic) return c.topic;
  const others = (c.members ?? []).filter((m) => m.userId !== me);
  if (c.chatType === "oneOnOne") return others[0] ? memberName(others[0]) : "Chat";
  const n = others.map(memberName);
  if (!n.length) return c.chatType === "meeting" ? "Meeting chat" : "Group chat";
  return n.length > 4 ? `${n.slice(0, 4).join(", ")} +${n.length - 4}` : n.join(", ");
}
export function previewText(m?: GMessage | null): string | undefined {
  if (!m) return undefined;
  if (m.messageType === "systemEventMessage") return systemText(m);
  if ((m as any).isDeleted || m.deletedDateTime) return "Message deleted";
  const t = m.body?.contentType === "text" ? decodeEntities(m.body?.content ?? "") : htmlToText(m.body?.content ?? "").text;
  return t.replace(/\s+/g, " ").trim().slice(0, 140) || (m.attachments?.length ? "Attachment" : undefined);
}
export function mapChat(c: GChat, accountId: string, me?: string): Chat {
  const last = c.lastMessagePreview;
  const lastAt = last?.createdDateTime ?? c.lastUpdatedDateTime;
  const read = c.viewpoint?.lastMessageReadDateTime;
  const unread = !!(last?.createdDateTime && last.from?.user?.id !== me && last.messageType !== "systemEventMessage" && (!read || Date.parse(read) < Date.parse(last.createdDateTime)));
  return {
    id: c.id, accountId, provider: "teams", kind: c.chatType === "oneOnOne" ? "dm" : "group", name: chatName(c, me),
    ...(lastAt ? { lastMessageAt: lastAt } : {}), ...(previewText(last) ? { preview: previewText(last) } : {}),
    ...(unread ? { unread: 1, unreadApprox: true } : {}),
    ...(c.chatType === "meeting" ? { category: "Meetings" } : {}),
  };
}
export const mapSpace = (t: GTeam, accountId: string): Space => ({ id: t.id, accountId, provider: "teams", name: t.displayName || "Team", ...(t.isArchived ? { archived: true } : {}) });
export function mapChannel(ch: GChannel, t: GTeam, accountId: string, canSend: boolean): Chat {
  return {
    id: chanChatId(t.id, ch.id), accountId, provider: "teams", spaceId: t.id, networkSpaceId: t.id, kind: "channel", name: ch.displayName || "Channel",
    ...(ch.description ? { description: ch.description } : {}), ...(ch.membershipType === "private" ? { category: "Private channels" } : ch.membershipType === "shared" ? { category: "Shared channels" } : {}),
    ...(!canSend || ch.isArchived || t.isArchived ? { readOnly: true } : {}),
  };
}
export const mapMember = (m: GMember): Contact => ({ id: m.userId ?? m.id ?? "", name: memberName(m), ...(m.email ? { handle: m.email } : {}) });
