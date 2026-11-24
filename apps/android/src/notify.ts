// Decides whether an incoming Hub message becomes an Android notification and what it says. Pure functions + a small
// throttled lookup of mute state so they can be unit-tested under plain Node.
import type { NotifyContent } from "./bridge-protocol.js";

interface Msg { id: string; chatId: string; mergeId?: string; sender?: string; text?: string; fromMe?: boolean; historical?: boolean; time?: string; deleted?: boolean; system?: unknown; attachments?: { kind?: string }[]; location?: unknown; poll?: unknown }
interface ChatInfo { id: string; name?: string; kind?: string; muted?: boolean; archived?: boolean; starred?: boolean; spaceId?: string; unread?: number }
interface SpaceInfo { id: string; muted?: boolean }
export interface Snapshot { chats?: ChatInfo[]; spaces?: SpaceInfo[] }

export function summarize(m: Msg): string {
  if (m.text) return m.text.length > 300 ? m.text.slice(0, 300) + "…" : m.text;
  const a = m.attachments?.[0];
  if (a) return ({ image: "Photo", video: "Video", audio: "Voice message", voice: "Voice message", file: "File" } as Record<string, string>)[a.kind ?? ""] ?? "Attachment";
  if (m.location) return "Location";
  if (m.poll) return "Poll";
  return "New message";
}

export function buildNotification(m: Msg, snap: Snapshot | undefined, mode: NotifyContent): { chatId: string; messageId: string; title: string; body: string; starred?: boolean; text: string; sender?: string; group: boolean; time: number } | undefined {
  if (m.fromMe || m.historical || m.deleted || m.system) return undefined;
  if (m.time && Date.now() - Date.parse(m.time) > 2 * 60_000) return undefined; // delivered or synced late: not news any more (the device that got it live already notified)
  const chat = snap?.chats?.find((c) => c.id === m.chatId);
  const merged = m.mergeId ? snap?.chats?.find((c) => c.id === m.mergeId) : undefined; // a chat merged with others: its mute / star are the merged chat's
  if (chat?.muted || chat?.archived || merged?.muted || merged?.archived) return undefined;
  if (chat?.spaceId && snap?.spaces?.find((s) => s.id === chat.spaceId)?.muted) return undefined;
  const group = chat?.kind === "group" || chat?.kind === "channel";
  const title = mode === "hidden" ? "UniChat" : (chat?.name || m.sender || "New message");
  const body = mode === "hidden" ? "New message" : mode === "sender" ? "New message" : group && m.sender ? `${m.sender}: ${summarize(m)}` : summarize(m);
  // text / sender / time: the phone lists a chat's unread messages in ONE notification (one line each); never more than `body` reveals
  const text = mode === "full" ? summarize(m) : "New message", sender = mode === "full" && group && m.sender ? m.sender : undefined;
  const t = m.time ? Date.parse(m.time) : NaN;
  return { chatId: m.chatId, messageId: m.id, title: merged && mode !== "hidden" ? merged.name || title : title, body, ...(chat?.starred || merged?.starred ? { starred: true } : {}), text, ...(sender ? { sender } : {}), group, time: Number.isFinite(t) ? t : Date.now() };
}

/**
 * Which posted notifications a chat list makes obsolete. A notification stays on the phone until it is tapped, so a chat read
 * anywhere else -- in the app, by the "Mark as read" action, or on another device through sync -- used to leave it standing.
 * `posted` records what was shown, `readNow` answers with the chats that are no longer unread (and forgets them).
 */
export class PostedNotifications {
  private readonly open = new Set<string>();
  posted(chatId: string) { if (chatId) this.open.add(chatId); }
  /** The chats whose notification can go: no longer unread, or gone from the list entirely. */
  readNow(snap: Snapshot | undefined): string[] {
    if (!this.open.size || !snap?.chats) return [];
    const unread = new Map(snap.chats.map((c) => [c.id, c.unread ?? 0]));
    const done = [...this.open].filter((id) => !unread.get(id));
    for (const id of done) this.open.delete(id);
    return done;
  }
  /** The UI came to the foreground / the backend stops: everything shown so far is the user's problem no more. */
  clear(): string[] { const all = [...this.open]; this.open.clear(); return all; }
  get size() { return this.open.size; }
}

/** Wraps an (expensive) snapshot fetch so notifications never trigger more than one per `ttlMs`. */
export function cachedSnapshot(fetch: () => Promise<Snapshot>, ttlMs = 30_000) {
  let last: Snapshot | undefined, at = 0, inflight: Promise<Snapshot | undefined> | undefined;
  return (): Promise<Snapshot | undefined> => {
    if (last && Date.now() - at < ttlMs) return Promise.resolve(last);
    return inflight ??= fetch().then((s) => { last = s; at = Date.now(); return s; }, () => last).finally(() => { inflight = undefined; });
  };
}

/** Largest avatar (base64 characters) that travels in a notify frame; bigger pictures are skipped (the generic icon stays). ~64 KB of image. */
export const MAX_AVATAR_B64 = 88_000;
type AvatarReply = { dataBase64?: string; mime?: string } | null | undefined;
const looksLikeImage = (mime?: string) => mime === "image/png" || mime === "image/jpeg" || mime === "image/webp";

/**
 * Adds the chat's picture (base64 PNG/JPEG/WebP, <= MAX_AVATAR_B64) to a notification, for Android's large icon.
 * Never in "hidden" mode (no personal picture when the content is hidden). Any failure (no picture, too big, RPC error, slow) returns the
 * notification unchanged: a notification must never be lost or delayed because of a picture. `cache` keeps recent answers (also misses).
 */
export async function withAvatar<N extends { chatId: string }>(n: N, mode: NotifyContent, fetchAvatar: (chatId: string) => Promise<AvatarReply>, cache?: Map<string, { at: number; v?: string }>, opts: { timeoutMs?: number; ttlMs?: number; now?: () => number } = {}): Promise<N & { avatar?: string }> {
  if (mode === "hidden") return n;
  const now = opts.now ?? Date.now, ttl = opts.ttlMs ?? 6 * 3600_000;
  const hit = cache?.get(n.chatId);
  if (hit && now() - hit.at < ttl) return hit.v ? { ...n, avatar: hit.v } : n;
  let v: string | undefined;
  try {
    const r = await Promise.race([fetchAvatar(n.chatId), new Promise<undefined>((res) => { const t = setTimeout(() => res(undefined), opts.timeoutMs ?? 1500); (t as { unref?: () => void }).unref?.(); })]);
    if (r?.dataBase64 && looksLikeImage(r.mime) && r.dataBase64.length <= MAX_AVATAR_B64) v = r.dataBase64;
  } catch { /* no picture */ }
  if (cache) { if (cache.size > 200) cache.delete(cache.keys().next().value!); cache.set(n.chatId, { at: now(), v }); }
  return v ? { ...n, avatar: v } : n;
}
