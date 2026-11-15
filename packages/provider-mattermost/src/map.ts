// Pure Mattermost -> UniChat mapping (no I/O). Types are the subset of the REST/WebSocket JSON we use.
import type { Attachment, Card, Chat, ChatKind, Message, Reaction, Space } from "@unimsg/core";
import { emojiFromName, shortcodesToUnicode } from "./emoji.js";

export interface MmUser { id: string; username: string; first_name?: string; last_name?: string; nickname?: string; position?: string; email?: string; last_picture_update?: number; delete_at?: number }
export interface MmTeam { id: string; display_name: string; name: string; delete_at?: number; last_team_icon_update?: number }
export interface MmChannel {
  id: string; team_id?: string; type: "O" | "P" | "D" | "G"; display_name: string; name: string; header?: string; purpose?: string;
  delete_at?: number; last_post_at?: number; total_msg_count?: number;
}
export interface MmMember { channel_id: string; msg_count?: number; mention_count?: number; notify_props?: { mark_unread?: string } }
export interface MmFile { id: string; name?: string; extension?: string; size?: number; mime_type?: string; width?: number; height?: number }
export interface MmReaction { user_id: string; post_id: string; emoji_name: string }
export interface MmPost {
  id: string; channel_id: string; user_id: string; root_id?: string; message: string; type?: string; create_at: number; update_at?: number;
  edit_at?: number; delete_at?: number; is_pinned?: boolean; pending_post_id?: string; file_ids?: string[]; props?: Record<string, any>;
  metadata?: { files?: MmFile[]; reactions?: MmReaction[]; embeds?: { type: string; url?: string; data?: any }[] };
}
export interface PostList { order: string[]; posts: Record<string, MmPost> }

export const iso = (ms: number) => new Date(ms).toISOString();
const fullName = (u: MmUser) => [u.first_name, u.last_name].filter(Boolean).join(" ").trim();

/** Display name per the server's TeammateNameDisplay: "username" | "nickname_full_name" | "full_name". */
export function userName(u: MmUser | undefined, fmt: string): string {
  if (!u) return "Unknown";
  if (fmt === "full_name") return fullName(u) || u.username;
  if (fmt === "nickname_full_name") return u.nickname || fullName(u) || u.username;
  return u.username;
}
/** Own profile name: nickname, else first+last, else username. */
export const profileName = (u: MmUser) => u.nickname || fullName(u) || u.username;

export function mapSpace(t: MmTeam, accountId: string): Space {
  return { id: t.id, accountId, provider: "mattermost", name: t.display_name || t.name };
}

export function otherUserId(c: MmChannel, me: string): string | undefined {
  if (c.type !== "D") return undefined;
  const [a, b] = c.name.split("__");
  return a === me ? b : a;
}

export interface ChatCtx { accountId: string; me: string; fmt: string; user(id: string): MmUser | undefined; member?: MmMember; preview?: string }
export function mapChat(c: MmChannel, x: ChatCtx): Chat {
  const kind: ChatKind = c.type === "D" ? "dm" : c.type === "G" ? "group" : "channel";
  let name = c.display_name || c.name;
  if (c.type === "D") { const o = otherUserId(c, x.me); name = o ? userName(x.user(o), x.fmt) : name; if (o === x.me) name = userName(x.user(x.me), x.fmt) + " (you)"; }
  const total = c.total_msg_count ?? 0, seen = x.member?.msg_count ?? total;
  const chat: Chat = { id: c.id, accountId: x.accountId, provider: "mattermost", kind, name, unread: Math.max(0, total - seen) };
  if (c.team_id && kind === "channel") chat.spaceId = c.team_id;
  if (c.last_post_at) chat.lastMessageAt = iso(c.last_post_at);
  if (x.preview) chat.preview = x.preview;
  const d = (c.purpose || c.header || "").trim();
  if (d) chat.description = d;
  if (x.member?.notify_props?.mark_unread === "mention") chat.muted = true;
  if (c.delete_at) chat.readOnly = true;
  return chat;
}

export const attachmentKind = (mime: string): Attachment["kind"] =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";
export function mapFile(f: MmFile): Attachment {
  const mime = f.mime_type || "application/octet-stream";
  const a: Attachment = { id: f.id, kind: attachmentKind(mime), mime };
  if (f.name) a.name = f.name;
  if (f.size) a.size = f.size;
  if (f.width) a.width = f.width;
  if (f.height) a.height = f.height;
  return a;
}

export function mapReactions(list: MmReaction[] | undefined, me: string): Reaction[] | undefined {
  if (!list?.length) return undefined;
  const by = new Map<string, Reaction>();
  for (const r of list) {
    const emoji = emojiFromName(r.emoji_name);
    const e = by.get(emoji) ?? { emoji, senderIds: [] };
    if (!e.senderIds.includes(r.user_id)) e.senderIds.push(r.user_id);
    if (r.user_id === me) e.mine = true;
    by.set(emoji, e);
  }
  return [...by.values()];
}

export function mapCard(p: MmPost): Card | undefined {
  for (const e of p.metadata?.embeds ?? []) {
    if (e.type === "opengraph" && e.url) {
      const d = e.data ?? {};
      const title = d.title || d.site_name || e.url;
      return { kind: "link", title: String(title), ...(d.description ? { body: String(d.description) } : {}), url: e.url };
    }
    if (e.type === "permalink" && e.data) {
      const d = e.data;
      return { kind: "link", title: `Message in ${d.channel_display_name || "another channel"}`, ...(d.post?.message ? { body: String(d.post.message).slice(0, 300) } : {}), ...(e.url ? { url: e.url } : {}) };
    }
  }
  return undefined;
}

/** Short English text for system posts we show; undefined = hide the post. */
export function systemText(p: MmPost, name: (id: string) => string): string | undefined {
  const t = p.type ?? "";
  const who = name(p.user_id);
  const prop = p.props ?? {};
  switch (t) {
    case "system_join_channel": case "system_join_team": return `${who} joined`;
    case "system_leave_channel": case "system_leave_team": return `${who} left`;
    case "system_add_to_channel": return `${prop.addedUsername ? "@" + prop.addedUsername : "Someone"} was added by ${who}`;
    case "system_remove_from_channel": return `${prop.removedUsername ? "@" + prop.removedUsername : "Someone"} was removed`;
    case "system_add_to_team": return `${prop.addedUsername ? "@" + prop.addedUsername : "Someone"} was added to the team`;
    case "system_header_change": return `${who} updated the channel header`;
    case "system_purpose_change": return `${who} updated the channel purpose`;
    case "system_displayname_change": return `${who} renamed the channel`;
    case "system_channel_deleted": return `${who} archived the channel`;
    case "system_channel_restored": return `${who} unarchived the channel`;
    case "system_convert_channel": return `${who} changed the channel privacy`;
    default: return undefined;
  }
}

export interface MsgCtx {
  me: string; accountId?: string;
  name(id: string): string;
  /** Lookup of other posts (for reply previews). */
  post?(id: string): MmPost | undefined;
  /** File info for posts whose metadata lacks files (e.g. fresh upload). */
  extraFiles?: MmFile[];
}
const preview = (s: string) => (s.length > 120 ? s.slice(0, 117) + "..." : s);

/** Map one post; undefined for posts we hide. */
export function mapPost(p: MmPost, x: MsgCtx): Message | undefined {
  const fromMe = p.user_id === x.me;
  const base: Message = { id: p.id, chatId: p.channel_id, sender: x.name(p.user_id), senderId: p.user_id, text: shortcodesToUnicode(p.message ?? ""), time: iso(p.create_at), fromMe };
  if (x.accountId) base.accountId = x.accountId;
  if (p.type?.startsWith("system_")) {
    const t = systemText(p, x.name);
    if (t === undefined) return undefined;
    return { ...base, sender: "", senderId: "", text: t, fromMe: false, system: { kind: "info" } };
  }
  if (p.type && p.type !== "" && p.type !== "slack_attachment" && p.type !== "me") { if (!p.message) return undefined; }
  if (p.type === "me" && base.text) base.text = `/me ${base.text}`;
  if (p.root_id) {
    const root = x.post?.(p.root_id);
    base.replyTo = { messageId: p.root_id, ...(root ? { sender: x.name(root.user_id), textPreview: preview(root.message ?? "") } : {}) };
  }
  const files = p.metadata?.files ?? (p.file_ids?.length ? (x.extraFiles?.filter((f) => p.file_ids!.includes(f.id)) ?? p.file_ids.map((id) => ({ id }))) : undefined);
  if (files?.length) base.attachments = files.map(mapFile);
  const reactions = mapReactions(p.metadata?.reactions, x.me);
  if (reactions) base.reactions = reactions;
  const card = mapCard(p);
  if (card) base.card = card;
  if (p.edit_at) base.editedAt = iso(p.edit_at);
  if (p.is_pinned) base.pinned = true;
  if (p.delete_at) base.deleted = true;
  if (fromMe) base.status = "sent";
  return base;
}

export const parseJson = <T>(s: unknown): T | undefined => { try { return typeof s === "string" ? JSON.parse(s) : (s as T); } catch { return undefined; } };

/** Composer @mentions -> Mattermost's plain `@username` text. `usernameOf(userId)` knows the usernames; unknown ids and bad/overlapping spans are left as typed. */
export function applyMentions(text: string, mentions: { id: string; start: number; length: number }[] | undefined, usernameOf: (id: string) => string | undefined): string {
  const ok = (mentions ?? []).filter((m) => Number.isInteger(m.start) && Number.isInteger(m.length) && m.start >= 0 && m.length > 0 && m.start + m.length <= text.length).sort((a, b) => a.start - b.start);
  let out = "", at = 0;
  for (const m of ok) {
    if (m.start < at) continue; // overlapping
    const u = usernameOf(m.id);
    if (!u || !/^[a-z0-9._-]{1,64}$/i.test(u)) continue;
    out += text.slice(at, m.start) + "@" + u; at = m.start + m.length;
  }
  return out + text.slice(at);
}

/** What a user typed to join a team: a team name ("one"), a team URL (https://host/one), or an invite link (https://host/signup_user_complete/?id=INVITE). */
export function parseTeamInvite(input: string): { kind: "invite"; id: string } | { kind: "name"; name: string } | undefined {
  const t = input.trim();
  if (!t) return undefined;
  if (/^https?:\/\//i.test(t)) {
    let u: URL; try { u = new URL(t); } catch { return undefined; }
    const id = u.searchParams.get("id") ?? u.searchParams.get("invite_id");
    if (id && /^[a-z0-9]{8,64}$/i.test(id)) return { kind: "invite", id };
    const seg = u.pathname.split("/").filter(Boolean)[0];
    return seg && /^[a-z0-9][a-z0-9-]{0,63}$/.test(seg.toLowerCase()) && !["signup_user_complete", "login", "select_team"].includes(seg) ? { kind: "name", name: seg.toLowerCase() } : undefined;
  }
  const n = t.replace(/^\/+|\/+$/g, "").toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(n) ? { kind: "name", name: n } : undefined;
}

/** URL-safe team name (2-64 chars: a-z 0-9 -) from a display name; random suffix when nothing usable is left. */
export function teamSlug(display: string, rand: () => string): string {
  const s = display.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 55);
  return s.length >= 2 ? s : `team-${rand()}`;
}
