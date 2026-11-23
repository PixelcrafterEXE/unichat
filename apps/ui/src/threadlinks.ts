import type { Message } from "./types";

/**
 * Mattermost thread links for messages that came without them (saved before threads could be opened, or synced from a
 * device that had not been updated): a reply always quotes its thread's first post, so the reply links to that thread,
 * and a first post whose replies are loaded shows how many there are. A link the network sent is kept as it is.
 */
export function withThreadLinks(ms: Message[], providerOf: (chatId: string) => string): Message[] {
  const replies = new Map<string, number>();
  for (const m of ms) if (m.replyTo && !m.deleted && providerOf(m.chatId) === "mattermost") { const k = m.chatId + "|" + m.replyTo.messageId; replies.set(k, (replies.get(k) ?? 0) + 1); }
  if (!replies.size) return ms;
  return ms.map((m) => {
    if (m.thread || m.system || providerOf(m.chatId) !== "mattermost") return m;
    if (m.replyTo) return { ...m, thread: { id: "thread~" + m.replyTo.messageId } };
    const n = replies.get(m.chatId + "|" + m.id);
    return n ? { ...m, thread: { id: "thread~" + m.id, count: n } } : m;
  });
}
