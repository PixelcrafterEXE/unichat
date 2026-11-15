// Decides whether an incoming Hub message becomes an Android notification and what it says. Pure functions + a small
// throttled lookup of mute state so they can be unit-tested under plain Node.
import type { NotifyContent } from "./bridge-protocol.js";

interface Msg { id: string; chatId: string; sender?: string; text?: string; fromMe?: boolean; historical?: boolean; time?: string; deleted?: boolean; system?: unknown; attachments?: { kind?: string }[]; location?: unknown; poll?: unknown }
interface ChatInfo { id: string; name?: string; kind?: string; muted?: boolean; archived?: boolean; spaceId?: string }
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

export function buildNotification(m: Msg, snap: Snapshot | undefined, mode: NotifyContent): { chatId: string; messageId: string; title: string; body: string } | undefined {
  if (m.fromMe || m.historical || m.deleted || m.system) return undefined;
  if (m.time && Date.now() - Date.parse(m.time) > 2 * 60_000) return undefined; // delivered or synced late: not news any more (the device that got it live already notified)
  const chat = snap?.chats?.find((c) => c.id === m.chatId);
  if (chat?.muted || chat?.archived) return undefined;
  if (chat?.spaceId && snap?.spaces?.find((s) => s.id === chat.spaceId)?.muted) return undefined;
  const group = chat?.kind === "group" || chat?.kind === "channel";
  const title = mode === "hidden" ? "UniChat" : (chat?.name || m.sender || "New message");
  const body = mode === "hidden" ? "New message" : mode === "sender" ? "New message" : group && m.sender ? `${m.sender}: ${summarize(m)}` : summarize(m);
  return { chatId: m.chatId, messageId: m.id, title, body };
}

/** Wraps an (expensive) snapshot fetch so notifications never trigger more than one per `ttlMs`. */
export function cachedSnapshot(fetch: () => Promise<Snapshot>, ttlMs = 30_000) {
  let last: Snapshot | undefined, at = 0, inflight: Promise<Snapshot | undefined> | undefined;
  return (): Promise<Snapshot | undefined> => {
    if (last && Date.now() - at < ttlMs) return Promise.resolve(last);
    return inflight ??= fetch().then((s) => { last = s; at = Date.now(); return s; }, () => last).finally(() => { inflight = undefined; });
  };
}
