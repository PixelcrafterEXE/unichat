// Pure Discord -> UniChat mapping (no I/O). Types are the subset of the REST/Gateway JSON we use.
import type { Attachment, Card, Chat, Message, MessagePatch, Poll, Reaction, Space } from "@unimsg/core";

export interface DcUser { id: string; username: string; global_name?: string | null; avatar?: string | null; bot?: boolean; discriminator?: string }
export interface DcRole { id: string; name: string; permissions: string; position?: number }
export interface DcOverwrite { id: string; type: 0 | 1; allow: string; deny: string }
export interface DcEmoji { id?: string | null; name?: string | null; animated?: boolean }
export interface DcChannel {
  id: string; type: number; guild_id?: string; name?: string; topic?: string | null; parent_id?: string | null; position?: number;
  permission_overwrites?: DcOverwrite[]; last_message_id?: string | null; recipients?: DcUser[]; icon?: string | null; owner_id?: string;
  thread_metadata?: { archived?: boolean; locked?: boolean }; last_pin_timestamp?: string | null;
  /** threads: messages in it (Discord leaves out the starter message) */
  message_count?: number;
}
export interface DcGuild { id: string; name: string; icon?: string | null; owner_id?: string; roles?: DcRole[]; emojis?: DcEmoji[]; unavailable?: boolean; permissions?: string; channels?: DcChannel[]; threads?: DcChannel[]; member_count?: number }
export interface DcMember { roles: string[]; nick?: string | null; communication_disabled_until?: string | null; user?: DcUser }
export interface DcAttachment { id: string; filename: string; content_type?: string; size?: number; width?: number | null; height?: number | null; url: string; proxy_url?: string; duration_secs?: number; waveform?: string; flags?: number }
export interface DcEmbedMedia { url?: string; proxy_url?: string; width?: number; height?: number }
export interface DcEmbed {
  type?: string; title?: string; description?: string; url?: string; color?: number; timestamp?: string; footer?: { text: string }; author?: { name: string; url?: string };
  provider?: { name?: string }; image?: DcEmbedMedia; thumbnail?: DcEmbedMedia; video?: DcEmbedMedia; fields?: { name: string; value: string; inline?: boolean }[];
}
export interface DcSticker { id: string; name: string; format_type: number }
export interface DcPoll {
  question: { text?: string }; answers: { answer_id: number; poll_media: { text?: string; emoji?: DcEmoji } }[]; expiry?: string | null; allow_multiselect?: boolean;
  results?: { is_finalized?: boolean; answer_counts?: { id: number; count: number; me_voted?: boolean }[] };
}
export interface DcMessage {
  id: string; channel_id: string; guild_id?: string; author?: DcUser; member?: DcMember; content?: string; timestamp?: string; edited_timestamp?: string | null;
  type?: number; flags?: number; mentions?: (DcUser & { member?: DcMember })[]; mention_roles?: string[]; attachments?: DcAttachment[]; embeds?: DcEmbed[];
  reactions?: { count: number; me?: boolean; emoji: DcEmoji }[]; referenced_message?: DcMessage | null; message_reference?: { message_id?: string; channel_id?: string; type?: number };
  /** the thread started from this message */
  thread?: DcChannel;
  pinned?: boolean; message_snapshots?: { message: DcMessage }[]; sticker_items?: DcSticker[]; poll?: DcPoll; call?: { ended_timestamp?: string | null }; webhook_id?: string;
}

// ---------------------------------------------------------------- permissions
export const P = {
  ADMINISTRATOR: 1n << 3n, MANAGE_CHANNELS: 1n << 4n, ADD_REACTIONS: 1n << 6n, VIEW_CHANNEL: 1n << 10n, SEND_MESSAGES: 1n << 11n, MANAGE_MESSAGES: 1n << 13n,
  ATTACH_FILES: 1n << 15n, READ_MESSAGE_HISTORY: 1n << 16n, MANAGE_THREADS: 1n << 34n, SEND_MESSAGES_IN_THREADS: 1n << 38n,
};
const ALL = (1n << 64n) - 1n;
const big = (s: string | undefined) => { try { return BigInt(s ?? "0"); } catch { return 0n; } };

/** Guild-level permissions of a member (base permissions, before channel overwrites). */
export function basePermissions(g: DcGuild, userId: string, m: DcMember | undefined): bigint {
  if (g.owner_id === userId) return ALL;
  const roles = new Map((g.roles ?? []).map((r) => [r.id, r]));
  let p = big(roles.get(g.id)?.permissions);
  for (const r of m?.roles ?? []) p |= big(roles.get(r)?.permissions);
  return p & P.ADMINISTRATOR ? ALL : p;
}
export function channelPermissions(g: DcGuild, ch: DcChannel, parent: DcChannel | undefined, userId: string, m: DcMember | undefined, base = basePermissions(g, userId, m)): bigint {
  if (base === ALL) return ALL;
  const src = isThread(ch.type) ? parent : ch;
  let p = base;
  const ow = src?.permission_overwrites ?? [];
  const ev = ow.find((o) => o.id === g.id);
  if (ev) p = (p & ~big(ev.deny)) | big(ev.allow);
  let allow = 0n, deny = 0n;
  for (const o of ow) if (o.type === 0 && o.id !== g.id && m?.roles.includes(o.id)) { allow |= big(o.allow); deny |= big(o.deny); }
  p = (p & ~deny) | allow;
  const mo = ow.find((o) => o.type === 1 && o.id === userId);
  if (mo) p = (p & ~big(mo.deny)) | big(mo.allow);
  if (m?.communication_disabled_until && Date.parse(m.communication_disabled_until) > Date.now()) p &= P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY;
  return p;
}

// ---------------------------------------------------------------- channels
export const CT = { TEXT: 0, DM: 1, VOICE: 2, GROUP_DM: 3, CATEGORY: 4, ANNOUNCEMENT: 5, ANNOUNCEMENT_THREAD: 10, PUBLIC_THREAD: 11, PRIVATE_THREAD: 12, STAGE: 13, FORUM: 15, MEDIA: 16 };
export const isThread = (t: number) => t === 10 || t === 11 || t === 12;
/** Channel types that hold messages we can show as a chat. Voice / stage / category / forum containers are not chats. */
export const isChatType = (t: number) => t === 0 || t === 1 || t === 3 || t === 5 || isThread(t);

export const userName = (u: DcUser | undefined, nick?: string | null) => nick || u?.global_name || u?.username || "Unknown";

export interface ChatCtx {
  accountId: string; me: string; unread: number; perms?: bigint; parent?: DcChannel; category?: DcChannel; preview?: string;
  user(id: string): DcUser | undefined;
}
export function dmName(ch: DcChannel, x: { me: string; user(id: string): DcUser | undefined }): string {
  const others = (ch.recipients ?? []).filter((r) => r.id !== x.me);
  if (ch.type === CT.DM) return others[0] ? userName(others[0]) : "Direct message";
  return ch.name || others.map((r) => userName(r)).join(", ") || "Group DM";
}
export function mapChat(ch: DcChannel, x: ChatCtx): Chat {
  const dm = ch.type === CT.DM, group = ch.type === CT.GROUP_DM;
  const c: Chat = { id: ch.id, accountId: x.accountId, provider: "discord", kind: dm ? "dm" : group ? "group" : "channel", name: dm || group ? dmName(ch, x) : (ch.name ?? "channel") };
  if (ch.guild_id) c.spaceId = ch.guild_id;
  if (x.unread > 0) c.unread = x.unread;
  const t = ch.last_message_id ? snowflakeTime(ch.last_message_id) : undefined;
  if (t) c.lastMessageAt = new Date(t).toISOString();
  if (x.preview) c.preview = x.preview;
  // The channel's category is a real field now (Chat.category): the UI groups by it. Threads say where they live and sit in their parent's category.
  if (x.category?.name) c.category = x.category.name;
  // server channels: members are managed by roles; name + topic only with Manage Channels; group DMs: anyone in them
  if (ch.guild_id) c.canManage = !isThread(ch.type) && x.perms !== undefined && (x.perms & P.MANAGE_CHANNELS) !== 0n;
  const topic = (ch.topic ?? "").replace(/\s+/g, " ").trim();
  const thread = isThread(ch.type) ? (x.parent ? `Thread in #${x.parent.name}` : "Thread") : "";
  const desc = thread ? thread + (topic ? " — " + topic : "") : topic;
  if (desc) c.description = desc;
  if (ch.type === CT.ANNOUNCEMENT) c.description = (c.description ? c.description + " " : "") + "[announcements]";
  if (x.perms !== undefined && ch.guild_id) {
    const sendBit = isThread(ch.type) ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES;
    if (!(x.perms & sendBit) || (isThread(ch.type) && (ch.thread_metadata?.locked || ch.thread_metadata?.archived) && !(x.perms & P.MANAGE_THREADS))) c.readOnly = true;
  }
  return c;
}
export function mapSpace(g: DcGuild, accountId: string): Space { return { id: g.id, accountId, provider: "discord", name: g.name, ...(g.icon ? { avatarRev: g.icon } : {}) }; } // icon = Discord's picture hash

export const DISCORD_EPOCH = 1420070400000;
export function snowflakeTime(id: string): number | undefined { try { return Number((BigInt(id) >> 22n) + BigInt(DISCORD_EPOCH)); } catch { return undefined; } }
/** Numeric snowflake comparison (ids are strings of different lengths over the years). */
export function snowflakeGt(a: string, b: string): boolean { try { return BigInt(a) > BigInt(b); } catch { return false; } }

// ---------------------------------------------------------------- content
export interface TextCtx {
  user(id: string, hint?: DcUser & { member?: DcMember }): string | undefined;
  role(id: string): string | undefined;
  channel(id: string): string | undefined;
  emoji(name: string, id: string, animated: boolean): void;
}
const fmtUtc = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** Mentions -> @names / #channels, custom emoji <:n:id> -> :n:, timestamps -> readable UTC. Markdown is passed through untouched. */
export function renderContent(content: string, m: Pick<DcMessage, "mentions">, x: TextCtx): string {
  const byId = new Map((m.mentions ?? []).map((u) => [u.id, u]));
  return content
    .replace(/<@!?(\d+)>/g, (_s, id: string) => "@" + (x.user(id, byId.get(id)) ?? "unknown-user"))
    .replace(/<@&(\d+)>/g, (_s, id: string) => "@" + (x.role(id) ?? "unknown-role"))
    .replace(/<#(\d+)>/g, (_s, id: string) => "#" + (x.channel(id) ?? "unknown-channel"))
    .replace(/<(a?):(\w{2,32}):(\d+)>/g, (_s, a: string, n: string, id: string) => { x.emoji(n, id, a === "a"); return `:${n}:`; })
    .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_s, t: string) => fmtUtc(Number(t)))
    .replace(/<\/([\w -]{1,32}):\d+>/g, (_s, n: string) => "/" + n);
}

export const emojiText = (e: DcEmoji, reg?: (n: string, id: string, a: boolean) => void): string => {
  if (e.id && e.name) { reg?.(e.name, e.id, !!e.animated); return `:${e.name}:`; }
  return e.name ?? "?";
};
/** Path segment for the reactions endpoints. */
export const emojiPath = (e: DcEmoji) => encodeURIComponent(e.id ? `${e.name}:${e.id}` : (e.name ?? ""));
export const emojiKey = (e: DcEmoji) => (e.id ? `${e.name}:${e.id}` : (e.name ?? ""));

/** Reactions only tell us how many people reacted (and whether I did): `senderIds` lists the reactors we know (events, me), `count` is the exact total whenever that list is incomplete. */
export function mapReactions(list: DcMessage["reactions"], me: string, reg?: (n: string, id: string, a: boolean) => void, known?: (key: string) => string[] | undefined): Reaction[] | undefined {
  if (!list?.length) return undefined;
  return list.filter((r) => r.count > 0).map((r) => {
    const key = emojiKey(r.emoji);
    const ids = new Set(known?.(key) ?? []);
    if (r.me) ids.add(me); else ids.delete(me);
    const out = [...ids].slice(0, r.count);
    return { emoji: emojiText(r.emoji, reg), senderIds: out, ...(r.count > out.length ? { count: r.count } : {}), ...(r.me ? { mine: true } : {}) };
  });
}

// ---------------------------------------------------------------- media
const FLAG_VOICE = 1 << 13;
export function waveformOf(b64: string | undefined): number[] | undefined {
  if (!b64) return undefined;
  try {
    const raw = Buffer.from(b64, "base64"); if (!raw.length) return undefined;
    const n = Math.min(64, raw.length);
    return Array.from({ length: n }, (_v, i) => { const a = Math.floor((i * raw.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * raw.length) / n)); let mx = 0; for (let k = a; k < b; k++) mx = Math.max(mx, raw[k]); return Math.round((mx / 255) * 100); });
  } catch { return undefined; }
}
const kindOf = (mime: string): Attachment["kind"] => mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";
const guessMime = (name: string) => ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", pdf: "application/pdf" } as Record<string, string>)[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

export interface MediaRef { url: string; mime: string; name?: string }
export interface Mapped { attachments: Attachment[]; refs: Map<string, MediaRef>; cards?: Card[]; hideText?: boolean }

const GIF_PROVIDER = /(^|\.)(tenor\.com|giphy\.com)$/;
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };

/** Attachments + stickers + gif embeds + embed images, and the first meaningful embed as a Card. `refs` maps attachment id -> where to download. */
export function mapMedia(m: DcMessage): Mapped {
  const attachments: Attachment[] = []; const refs = new Map<string, MediaRef>();
  for (const a of m.attachments ?? []) {
    const mime = a.content_type?.split(";")[0] || guessMime(a.filename);
    const voice = ((a.flags ?? 0) & FLAG_VOICE) !== 0 || (!!a.waveform && mime.startsWith("audio/"));
    const t: Attachment = { id: a.id, kind: voice ? "voice" : kindOf(mime), mime, name: a.filename };
    if (a.size) t.size = a.size; if (a.width) t.width = a.width; if (a.height) t.height = a.height;
    if (a.duration_secs) t.durationMs = Math.round(a.duration_secs * 1000);
    const wf = voice ? waveformOf(a.waveform) : undefined; if (wf) t.waveform = wf;
    attachments.push(t); refs.set(a.id, { url: a.url, mime, name: a.filename });
  }
  for (const s of m.sticker_items ?? []) {
    if (s.format_type === 3) continue; // Lottie (JSON animation): cannot be shown; the sticker name goes into the text
    const gif = s.format_type === 4, ext = gif ? "gif" : "png", id = "s" + s.id;
    attachments.push({ id, kind: "sticker", mime: gif ? "image/gif" : "image/png", name: s.name });
    refs.set(id, { url: `${CDN_STICKERS}/${s.id}.${ext}`, mime: gif ? "image/gif" : "image/png", name: s.name });
  }
  const cards: Card[] = []; let hideText = false;
  (m.embeds ?? []).forEach((e, i) => {
    const gifv = e.type === "gifv" || (e.video?.url && GIF_PROVIDER.test(hostOf(e.url ?? e.video.url ?? "")) && e.type !== "video");
    if (gifv) {
      const src = e.video?.proxy_url || e.video?.url || e.thumbnail?.proxy_url || e.thumbnail?.url;
      if (src) {
        const id = `e${i}v`; const isVideo = !!e.video;
        const mime = isVideo ? (/\.webm(\?|$)/.test(src) ? "video/webm" : "video/mp4") : (/\.gif(\?|$)/.test(src) ? "image/gif" : "image/png");
        attachments.push({ id, kind: isVideo ? "video" : "image", mime, name: "animation" + (isVideo ? ".mp4" : ".gif"), gif: true, ...(e.video?.width ? { width: e.video.width } : {}), ...(e.video?.height ? { height: e.video.height } : {}) });
        refs.set(id, { url: src, mime });
        if (e.url && (m.content ?? "").trim() === e.url) hideText = true;
      }
      return;
    }
    if (e.type === "image") { // a plain image link: the picture itself is the message
      const src = e.thumbnail?.proxy_url || e.thumbnail?.url || e.image?.proxy_url || e.image?.url;
      if (src) { const id = `e${i}i`; attachments.push({ id, kind: "image", mime: guessMime(src.split("?")[0]), ...(e.thumbnail?.width ? { width: e.thumbnail.width, height: e.thumbnail.height } : {}) }); refs.set(id, { url: src, mime: guessMime(src.split("?")[0]) }); if (e.url && (m.content ?? "").trim() === e.url) hideText = true; }
      return;
    }
    // every other embed is one card; its picture is a preview image loaded through downloadAttachment (id `e<i>i`, not listed in Message.attachments)
    const big = e.image, small = e.thumbnail, pic = big ?? small;
    const src = pic?.proxy_url || pic?.url;
    const title = e.title || e.author?.name || e.provider?.name || e.url;
    if (!title && !e.description && !src) return;
    const card: Card = { kind: e.type === "link" || e.type === "article" || e.type === "video" ? "link" : "other", title: String(title ?? "") };
    const sub = e.author?.name && e.title ? e.author.name : e.provider?.name && e.title ? e.provider.name : undefined;
    if (sub) card.subtitle = sub;
    if (e.description) card.body = e.description;
    if (e.footer?.text) card.footer = e.footer.text;
    if (e.url) card.url = e.url;
    if (e.timestamp) card.when = new Date(e.timestamp).toISOString();
    if (e.fields?.length) card.rows = e.fields.map((f) => ({ label: f.name, value: f.value }));
    if (src) {
      const id = `e${i}i`; const mime = guessMime(hostOf(src) ? new URL(src).pathname : src);
      card.image = { attachmentId: id, ...(pic?.width ? { width: pic.width } : {}), ...(pic?.height ? { height: pic.height } : {}), ...(big ? {} : { layout: "thumb" as const }) };
      refs.set(id, { url: src, mime });
    }
    cards.push(card);
  });
  return { attachments, refs, ...(cards.length ? { cards } : {}), ...(hideText ? { hideText } : {}) };
}
const CDN_STICKERS = "https://media.discordapp.net/stickers";

export function mapPoll(p: DcPoll, me: string): Poll {
  const counts = new Map((p.results?.answer_counts ?? []).map((c) => [c.id, c]));
  const mine: string[] = [];
  const options = p.answers.map((a) => {
    const c = counts.get(a.answer_id); const id = String(a.answer_id);
    const voters: string[] = [];
    if (c?.me_voted) { voters.push(me); mine.push(id); }
    const emoji = a.poll_media.emoji ? emojiText(a.poll_media.emoji) + " " : "";
    return { id, text: emoji + (a.poll_media.text ?? ""), voters, ...((c?.count ?? 0) > voters.length ? { count: c!.count } : {}) }; // Discord reports counts, not voters
  });
  return { question: p.question.text ?? "", options, multiple: !!p.allow_multiselect, ...(p.results?.is_finalized || (p.expiry && Date.parse(p.expiry) < Date.now()) ? { closed: true } : {}), ...(mine.length ? { mine } : {}) };
}

// ---------------------------------------------------------------- messages
export const MT = { DEFAULT: 0, RECIPIENT_ADD: 1, RECIPIENT_REMOVE: 2, CALL: 3, NAME_CHANGE: 4, ICON_CHANGE: 5, PIN: 6, JOIN: 7, REPLY: 19, SLASH: 20, THREAD_STARTER: 21, CONTEXT: 23 };

export function systemText(m: DcMessage, who: string, target?: string): string | undefined {
  switch (m.type) {
    case 1: return `${who} added ${target ?? "someone"} to the group`;
    case 2: return target && target !== who ? `${who} removed ${target} from the group` : `${who} left the group`;
    case 3: return m.call?.ended_timestamp ? "The call ended" : `${who} started a call`;
    case 4: return `${who} changed the name${m.content ? ` to "${m.content}"` : ""}`;
    case 5: return `${who} changed the group icon`;
    case 6: return `${who} pinned a message`;
    case 7: return `${who} joined the server`;
    case 8: return `${who} boosted the server`;
    case 9: case 10: case 11: return `${who} boosted the server (level ${m.type - 8} reached)`;
    case 12: return `${who} added a followed channel`;
    case 14: case 15: return "The server's discovery status changed";
    case 18: return `${who} started a thread${m.content ? `: ${m.content}` : ""}`;
    case 22: return "Invite reminder: wondering who to invite?";
    case 24: return `AutoMod${m.content ? ": " + m.content : " acted on a message"}`;
    case 46: return "A poll has ended";
    default: return undefined;
  }
}
const NORMAL = new Set([0, 19, 20, 21, 23]);

export interface MsgCtx extends TextCtx { me: string; accountId?: string; known?: (key: string) => string[] | undefined }
const clip = (s: string) => (s.length > 120 ? s.slice(0, 117) + "..." : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Map one Discord message (live or history). Never returns undefined: unknown types become info lines. */
export function mapMessage(m: DcMessage, x: MsgCtx): { msg: Message; refs: Map<string, MediaRef> } {
  const name = (u?: DcUser, member?: DcMember) => (u ? x.user(u.id, { ...u, ...(member ? { member } : {}) }) ?? userName(u) : "Unknown");
  const author = m.author;
  const base: Message = {
    id: m.id, chatId: m.channel_id, sender: name(author, m.member), senderId: author?.id ?? "", text: "",
    time: new Date(m.timestamp ?? snowflakeTime(m.id) ?? Date.now()).toISOString(), fromMe: author?.id === x.me,
  };
  if (x.accountId) base.accountId = x.accountId;
  if (!NORMAL.has(m.type ?? 0)) {
    const target = m.mentions?.[0] ? name(m.mentions[0]) : undefined;
    const t = systemText(m, base.sender, target) ?? (m.content ? oneLine(m.content) : "Notice from Discord");
    const msg: Message = { ...base, sender: "", senderId: "", fromMe: false, text: t, system: { kind: "info" } };
    // "X started a thread: name": the reference points at the thread, so the line can open it
    const tid = m.type === 18 ? m.thread?.id ?? m.message_reference?.channel_id : undefined;
    if (tid && tid !== m.channel_id) msg.thread = threadLink(tid, m.thread ?? undefined, m.content);
    return { msg, refs: new Map() };
  }
  // thread starter: the interesting content is the message the thread was started from
  let src = m;
  if (m.type === MT.THREAD_STARTER && m.referenced_message) src = { ...m.referenced_message, id: m.id, channel_id: m.channel_id, guild_id: m.guild_id };
  const snap = m.message_reference?.type === 1 ? m.message_snapshots?.[0]?.message : undefined;
  if (snap) { src = { ...snap, id: m.id, channel_id: m.channel_id, author: m.author, member: m.member, guild_id: m.guild_id, mentions: snap.mentions ?? [] }; base.forwarded = true; }
  if (src !== m && m.type === MT.THREAD_STARTER) { base.sender = name(src.author, src.member); base.senderId = src.author?.id ?? ""; base.fromMe = src.author?.id === x.me; }
  const media = mapMedia(src);
  let text = renderContent(src.content ?? "", src, x);
  if (media.hideText) text = "";
  const stickers = (src.sticker_items ?? []).filter((s) => s.format_type === 3);
  if (stickers.length && !text) text = stickers.map((s) => `[sticker: ${s.name}]`).join(" ");
  base.text = text;
  if (media.attachments.length) base.attachments = media.attachments;
  if (media.cards) base.cards = media.cards;
  if (src.poll) base.poll = mapPoll(src.poll, x.me);
  if (src.poll && !base.text) base.text = "";
  const reactions = mapReactions(m.reactions, x.me, (n, id, a) => x.emoji(n, id, a), x.known);
  if (reactions) base.reactions = reactions;
  if (m.edited_timestamp) base.editedAt = new Date(m.edited_timestamp).toISOString();
  if (m.pinned) base.pinned = true;
  if (m.thread?.id && m.type !== MT.THREAD_STARTER) base.thread = threadLink(m.thread.id, m.thread);
  const ref = m.message_reference;
  if (ref?.message_id && ref.type !== 1 && m.type !== MT.THREAD_STARTER) {
    const r = m.referenced_message;
    base.replyTo = { messageId: ref.message_id, ...(r ? { sender: name(r.author, r.member), textPreview: clip(oneLine(renderContent(r.content ?? "", r, x)) || (r.attachments?.length ? "[attachment]" : "")) } : {}) };
  }
  if (base.fromMe) base.status = "sent";
  return { msg: base, refs: media.refs };
}

/** Message.thread for a Discord thread channel (`ch` when known: its name and reply count). */
export function threadLink(id: string, ch?: DcChannel, name?: string): NonNullable<Message["thread"]> {
  const n = ch?.name ?? (name || undefined);
  return { id, ...(n ? { name: n } : {}), ...(typeof ch?.message_count === "number" ? { count: ch.message_count } : {}) };
}

/** Short text for chat-list previews. */
export function previewOf(msg: Message): string {
  const t = oneLine(msg.text);
  if (t) return clip(t);
  if (msg.attachments?.length) { const a = msg.attachments[0]; return a.gif ? "[GIF]" : a.kind === "sticker" ? "[sticker]" : a.kind === "voice" ? "[voice message]" : a.kind === "image" ? "[photo]" : "[attachment]"; }
  if (msg.poll) return "[poll] " + msg.poll.question;
  if (msg.cards?.[0]) return msg.cards[0].title;
  return "";
}

/** Build a MessagePatch for MESSAGE_UPDATE from the merged message and the keys the update carried. */
export function patchOf(merged: DcMessage, upd: Partial<DcMessage>, x: MsgCtx, prev?: DcMessage): MessagePatch {
  const { msg } = mapMessage(merged, x);
  const patch: MessagePatch = {};
  if ("content" in upd || "mentions" in upd) patch.text = msg.text;
  if (upd.edited_timestamp) patch.editedAt = new Date(upd.edited_timestamp).toISOString();
  if ("embeds" in upd || "attachments" in upd) { patch.attachments = msg.attachments ?? []; if (msg.cards) patch.cards = msg.cards; }
  if (patch.text === undefined && "embeds" in upd && prev && mapMessage(prev, x).msg.text !== msg.text) patch.text = msg.text; // a bare gif link is hidden once its embed arrives
  if ("poll" in upd && msg.poll) patch.poll = msg.poll;
  if ("reactions" in upd) patch.reactions = msg.reactions ?? [];
  if ("pinned" in upd && (!prev || !!upd.pinned !== !!prev.pinned)) { // MESSAGE_UPDATE carries the flag only (no time, no pinner): the time is when we heard of it
    patch.pinned = !!upd.pinned;
    if (upd.pinned) patch.pinnedAt = new Date().toISOString();
  }
  return patch;
}
