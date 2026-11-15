// Instagram direct-message JSON (private API shapes) -> UniChat model. Pure functions, no I/O. Unknown item types never throw:
// they become a readable placeholder text so nothing is silently lost.
import type { Attachment, Card, Chat, Contact, Location, Message, Reaction } from "@unimsg/core";

export interface IgUser { pk: string | number; username?: string; full_name?: string; profile_pic_url?: string; is_private?: boolean }
export interface IgItem { item_id: string; user_id?: string | number; timestamp?: string | number; item_type?: string; text?: string; client_context?: string; is_sent_by_viewer?: boolean; [k: string]: any }
export interface IgThread {
  thread_id: string; thread_title?: string; users?: IgUser[]; viewer_id?: string | number; is_group?: boolean; muted?: boolean; archived?: boolean; is_archived?: boolean;
  last_activity_at?: string | number; items?: IgItem[]; last_seen_at?: Record<string, { timestamp?: string | number; item_id?: string }>; read_state?: number;
  pending?: boolean; left_users?: IgUser[]; oldest_cursor?: string; has_older?: boolean; [k: string]: any;
}

/** Instagram timestamps are microseconds since the epoch (sometimes strings). */
export function iso(ts: unknown): string { const n = Number(ts); if (!n) return new Date(0).toISOString(); return new Date(n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000).toISOString(); }
export const tsNum = (ts: unknown) => Number(ts) || 0;
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
export const userLabel = (u?: IgUser) => u ? (u.full_name?.trim() || u.username || "Instagram user") : "Instagram user";

export function mapUser(u: IgUser): Contact { return { id: str(u.pk), name: userLabel(u), ...(u.username ? { handle: "@" + u.username } : {}) }; }

export function mapReactions(item: IgItem, viewerId: string): Reaction[] | undefined {
  const r = item.reactions; if (!r) return item.reactions === undefined ? undefined : [];
  const by = new Map<string, string[]>();
  for (const e of r.emojis ?? []) { const k = str(e.emoji) || "❤️"; (by.get(k) ?? by.set(k, []).get(k)!).push(str(e.sender_id)); }
  // The classic "heart" (likes) is returned separately from emoji reactions.
  for (const l of r.likes ?? []) { const a = by.get("❤️") ?? by.set("❤️", []).get("❤️")!; if (!a.includes(str(l.sender_id))) a.push(str(l.sender_id)); }
  return [...by].map(([emoji, senderIds]) => ({ emoji, senderIds, ...(senderIds.includes(viewerId) ? { mine: true } : {}) }));
}

const bestImage = (iv: any): { url: string; width?: number; height?: number } | undefined => {
  const c = (iv?.candidates ?? []).filter((x: any) => x?.url); if (!c.length) return undefined;
  return c.slice().sort((a: any, b: any) => (b.width ?? 0) - (a.width ?? 0))[0];
};
const bestVideo = (vv: any): { url: string; width?: number; height?: number } | undefined => (vv ?? []).find((x: any) => x?.url);
const downsample = (w: number[] | undefined): number[] | undefined => {
  if (!w?.length) return undefined; const out: number[] = [];
  for (let i = 0; i < 64; i++) { const a = Math.floor((i * w.length) / 64), b = Math.max(a + 1, Math.floor(((i + 1) * w.length) / 64)); let m = 0; for (let j = a; j < b && j < w.length; j++) m = Math.max(m, Math.abs(w[j])); out.push(Math.round(Math.min(1, m) * 100)); }
  return out;
};
const postUrl = (m: any, reel = false) => m?.code ? `https://www.instagram.com/${reel ? "reel" : "p"}/${m.code}/` : undefined;

/** What the mapper learned about downloadable media: attachment id -> source URL (kept by the connector, never sent to the UI). */
export interface MediaRef { url: string; mime: string; name?: string }
export interface MappedItem { message: Message; media: Map<string, MediaRef>; unsent?: boolean }

export function mapItem(item: IgItem, chatId: string, viewerId: string, users: Map<string, IgUser>, accountId?: string): MappedItem {
  const senderId = str(item.user_id);
  const fromMe = item.is_sent_by_viewer ?? senderId === viewerId;
  const media = new Map<string, MediaRef>();
  const m: Message = {
    id: str(item.item_id), chatId, ...(accountId ? { accountId } : {}),
    sender: fromMe ? "Me" : userLabel(users.get(senderId)), senderId, text: "", time: iso(item.timestamp), fromMe,
  };
  if (fromMe) m.status = "sent";
  const reactions = mapReactions(item, viewerId); if (reactions) m.reactions = reactions;
  const rt = item.replied_to_message;
  if (rt?.item_id) m.replyTo = { messageId: str(rt.item_id), sender: str(rt.user_id) === viewerId ? "Me" : userLabel(users.get(str(rt.user_id))), ...(rt.text ? { textPreview: String(rt.text).slice(0, 200) } : rt.item_type && rt.item_type !== "text" ? { textPreview: `[${rt.item_type}]` } : {}) };
  if (item.forward_score > 0 || item.is_forward) m.forwarded = true;
  // preview image of a card: loaded through downloadAttachment like any media, but NOT listed in Message.attachments
  const cardImg = (n: number, im: { url: string; width?: number; height?: number } | undefined): Card["image"] | undefined => {
    if (!im?.url) return undefined; const id = `${m.id}:c${n}`; media.set(id, { url: im.url, mime: "image/jpeg" });
    return { attachmentId: id, ...(im.width ? { width: im.width } : {}), ...(im.height ? { height: im.height } : {}) };
  };
  const addImg = (n: number, url: string | undefined, kind: Attachment["kind"], mime: string, extra: Partial<Attachment> = {}) => {
    if (!url) return; const id = `${m.id}:${n}`; media.set(id, { url, mime });
    (m.attachments ??= []).push({ id, kind, mime, ...extra });
  };
  const type = String(item.item_type ?? "");
  const who = (u?: any) => u?.username ? "@" + u.username : "someone";
  switch (type) {
    case "text": m.text = str(item.text); break;
    case "like": m.text = "❤️"; break;
    case "link": {
      const l = item.link ?? {}; m.text = str(l.text ?? item.text);
      const ctx = l.link_context;
      if (ctx?.link_url) m.card = { kind: "link", title: str(ctx.link_title) || ctx.link_url, ...(ctx.link_summary ? { body: str(ctx.link_summary) } : {}), url: ctx.link_url };
      break;
    }
    case "media": {
      const md = item.media ?? {}; const w = md.original_width, h = md.original_height;
      const v = bestVideo(md.video_versions);
      if (v) addImg(0, v.url, "video", "video/mp4", { width: w ?? v.width, height: h ?? v.height, ...(md.video_duration ? { durationMs: Math.round(md.video_duration * 1000) } : {}) });
      else { const im = bestImage(md.image_versions2); addImg(0, im?.url, "image", "image/jpeg", { width: w ?? im?.width, height: h ?? im?.height }); }
      if (!m.attachments) m.text = "[Photo or video is no longer available]";
      break;
    }
    case "raven_media": case "visual_media": // view-once / replayable disappearing media: deliberately not downloaded
      m.text = item.visual_media?.seen_count || item.visual_media?.view_mode === "permanent" ? "[Disappearing photo/video: already opened, open Instagram to view]" : "[Disappearing photo/video: open Instagram to view it]"; break;
    case "voice_media": {
      const a = item.voice_media?.media?.audio ?? {};
      addImg(0, a.audio_src, "voice", "audio/mp4", { ...(a.duration ? { durationMs: Math.round(Number(a.duration)) } : {}), ...(downsample(a.waveform_data) ? { waveform: downsample(a.waveform_data) } : {}) });
      if (!m.attachments) m.text = "[Voice message is no longer available]";
      break;
    }
    case "animated_media": {
      const img = item.animated_media?.images?.fixed_height ?? item.animated_media?.images?.original ?? {};
      const sticker = !!item.animated_media?.is_sticker;
      const w = Number(img.width) || undefined, h = Number(img.height) || undefined;
      if (img.mp4 && !sticker) addImg(0, img.mp4, "video", "video/mp4", { width: w, height: h, gif: true });
      else addImg(0, img.url ?? img.webp, sticker ? "sticker" : "image", img.url ? "image/gif" : "image/webp", { width: w, height: h });
      if (!m.attachments) m.text = sticker ? "[Sticker]" : "[GIF]";
      break;
    }
    case "media_share": case "clip": case "felt_tracking": case "felt_media": {
      const md = item.media_share ?? item.clip?.clip ?? item.clip ?? {}; const reel = type === "clip" || md.product_type === "clips";
      const cap = md.caption?.text ? String(md.caption.text).slice(0, 500) : undefined;
      const url = postUrl(md, reel); const by = md.user?.username;
      m.text = `Shared ${reel ? "a reel" : "a post"}${by ? " by @" + by : ""}${item.text ? ": " + item.text : ""}`;
      m.card = { kind: "other", title: `${reel ? "Reel" : "Post"}${by ? " by @" + by : ""}`, ...(cap ? { body: cap } : {}), ...(url ? { url } : {}), ...(cardImg(0, bestImage(md.image_versions2)) ? { image: cardImg(0, bestImage(md.image_versions2)) } : {}) };
      break;
    }
    case "story_share": {
      const ss = item.story_share ?? {}; const by = ss.media?.user?.username;
      m.text = ss.message ? `[Story: ${ss.message}]` : `Shared a story${by ? " by @" + by : ""}${item.text ? ": " + item.text : ""}`;
      const ssi = cardImg(0, bestImage(ss.media?.image_versions2));
      m.card = { kind: "other", title: `Story${by ? " by @" + by : ""}`, ...(ss.message ? { subtitle: String(ss.message) } : {}), ...(ssi ? { image: ssi } : {}) };
      break;
    }
    case "reel_share": { // story reply / reaction / mention
      const rs = item.reel_share ?? {}; const t = String(rs.type ?? "reply"); const owner = who(rs.media?.user);
      const body = str(rs.text);
      if (t === "mention" || item.reel_share?.mentioned_user_id) m.text = fromMe ? `Mentioned ${owner === "someone" ? "them" : owner} in your story` : "Mentioned you in their story";
      else if (t === "reaction") m.text = `${fromMe ? "Reacted to their story" : "Reacted to your story"}${body ? ": " + body : ""}`;
      else m.text = `${fromMe ? "Replied to their story" : "Replied to your story"}${body ? ": " + body : ""}`;
      const rsi = cardImg(0, bestImage(rs.media?.image_versions2));
      m.card = { kind: "other", title: t === "mention" ? "Story mention" : "Story", ...(body ? { subtitle: body } : {}), ...(rsi ? { image: rsi } : {}) };
      break;
    }
    case "profile": {
      const p = item.profile ?? {}; m.text = `Shared a profile: @${p.username ?? "?"}`;
      m.card = { kind: "link", title: userLabel(p), subtitle: p.username ? "@" + p.username : undefined, ...(p.username ? { url: `https://www.instagram.com/${p.username}/` } : {}) };
      break;
    }
    case "location": case "venue": {
      const l = item.location ?? item.venue ?? {};
      if (typeof l.lat === "number" && typeof l.lng === "number") { m.location = { lat: l.lat, lng: l.lng, ...(l.name ? { name: String(l.name) } : {}), ...(l.address ? { address: String(l.address) } : {}) } as Location; m.text = `Location: ${l.name ?? ""}`.trim(); }
      else m.text = `Shared a place: ${l.name ?? ""}`.trim();
      break;
    }
    case "action_log": m.text = str(item.action_log?.description); m.system = { kind: "info" }; break;
    case "video_call_event": { const d = str(item.video_call_event?.description) || "Video call"; m.text = d; m.card = { kind: "call", title: d }; break; }
    case "placeholder": m.text = `[${str(item.placeholder?.message) || "This message is not available"}]`; break;
    default:
      if (type.startsWith("xma")) { // newer "shared content" wrapper
        const x = (item[type] ?? [])[0] ?? item[type] ?? {}; const title = str(x.title_text ?? x.header_title_text) || "Shared content";
        m.text = str(item.text) || `Shared: ${title}`;
        const xi = cardImg(0, x.preview_url ? { url: String(x.preview_url) } : undefined);
        m.card = { kind: "other", title, ...(x.subtitle_text ? { subtitle: String(x.subtitle_text) } : {}), ...(x.target_url ? { url: String(x.target_url) } : {}), ...(xi ? { image: xi } : {}) };
      } else m.text = str(item.text) || `[Unsupported Instagram message (${type || "unknown"})]`;
  }
  return { message: m, media };
}

/** Short text for chat lists. */
export function previewOf(m: Message): string {
  if (m.text) return m.text.slice(0, 120);
  const a = m.attachments?.[0]; if (!a) return "";
  return a.kind === "voice" ? "Voice message" : a.kind === "image" ? "Photo" : a.kind === "video" ? "Video" : a.kind === "sticker" ? "Sticker" : "Attachment";
}

export function mapThread(t: IgThread, accountId: string, viewerId: string, users: Map<string, IgUser>, pendingRequest = false): Chat {
  const others = (t.users ?? []).filter((u) => str(u.pk) !== viewerId);
  const group = !!t.is_group || others.length > 1;
  const name = group ? (t.thread_title?.trim() || others.map(userLabel).join(", ") || "Group chat") : (others[0] ? userLabel(others[0]) : t.thread_title || "Instagram user");
  const newest = t.items?.[0]; const last = newest ? mapItem(newest, t.thread_id, viewerId, users).message : undefined;
  const seen = tsNum(t.last_seen_at?.[viewerId]?.timestamp);
  const unread = (t.read_state ?? 0) > 0 || (!!newest && !last?.fromMe && tsNum(newest.timestamp) > seen && !!seen) ? 1 : 0;
  return {
    id: t.thread_id, accountId, provider: "instagram", kind: group ? "group" : "dm", name,
    ...(t.last_activity_at || newest ? { lastMessageAt: iso(t.last_activity_at ?? newest?.timestamp) } : {}),
    ...(last ? { preview: previewOf(last) } : {}),
    ...(unread ? { unread, unreadApprox: true } : {}), // Instagram gives no count: 1 = "something new"
    ...(t.muted ? { muted: true } : {}), ...(t.archived || t.is_archived ? { archived: true } : {}),
    ...(pendingRequest ? { request: true } : {}),
    // picture change hint: the CDN path of the other person's picture (the query part is a signature that expires and would look like a change)
    ...(!group && others[0]?.profile_pic_url ? { avatarRev: others[0].profile_pic_url.split("?")[0].slice(-160) } : {}),
  };
}
