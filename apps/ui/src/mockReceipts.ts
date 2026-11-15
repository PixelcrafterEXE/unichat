// Mock backend: per-recipient receipts (Message.receipts) like the Hub merges them (per id, times never move backwards).
import type { Contact, Message } from "./types";
type Emit = (ev: string, d: unknown) => void;
type Store = Record<string, Message[]>;
const later = (a?: string, b?: string) => (a && b ? (Date.parse(b) > Date.parse(a) ? b : a) : a ?? b);

/** Record one recipient's delivered/read time on a stored message and announce it the way the Hub does (merged list in a message-update patch + the receipt event). */
export function recordReceipt(store: Store, emit: Emit, chatId: string, messageId: string, by: string, status: "delivered" | "read", at = new Date().toISOString()) {
  const msg = store[chatId]?.find((x) => x.id === messageId); if (!msg) return;
  const rs = (msg.receipts ??= []); let r = rs.find((x) => x.id === by); if (!r) rs.push((r = { id: by }));
  if (status === "read") r.read = later(r.read, at); else r.delivered = later(r.delivered, at);
  emit("message-update", { chatId, messageId, patch: { receipts: rs.map((x) => ({ ...x })) } });
  emit("receipt", { chatId, messageId, status, by, at });
}

/** Staged receipts for a message sent from the mock: a 1:1 peer gets it and reads it; in groups some members do. */
export function sendReceipts(store: Store, emit: Emit, chat: { id: string; kind: string }, messageId: string, status: string, members: Contact[]) {
  if (status !== "delivered" && status !== "read") return;
  const ids = chat.kind === "dm" ? [chat.id] : members.map((c) => c.id);
  const n = status === "read" ? Math.min(2, ids.length) : Math.min(3, ids.length);
  for (const id of ids.slice(0, n)) recordReceipt(store, emit, chat.id, messageId, id, status);
}

const minAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();

/** Seed a few sent messages with receipts (a group, a channel with a big member list, two 1:1 chats). `add` = the mock's message factory. */
export function seedReceipts(store: Store, add: (chatId: string, sender: string, text: string, min: number, extra?: Partial<Message>) => Message, membersOf: (chatId: string) => Contact[]) {
  const fam = membersOf("wa-1:family").map((c) => c.id);
  add("wa-1:family", "You", "Who is bringing the cake?", 30, { status: "read", receipts: [
    { id: fam[0], delivered: minAgo(29), read: minAgo(25) }, { id: fam[1], delivered: minAgo(29), read: minAgo(12) },
    { id: fam[2], delivered: minAgo(28) }, { id: fam[3], delivered: minAgo(27) } ] }); // fam[4]: nothing yet
  const dm = (chat: string, text: string, r: { delivered?: string; read?: string }) => { const x = store[chat]?.find((y) => y.fromMe && y.text === text); if (x) x.receipts = [{ id: chat, ...r }]; };
  dm("wa-1:anna", "Yes! 10am at the station", { delivered: minAgo(1489), read: minAgo(1480) });
  dm("wa-1:ben", "Will pay tomorrow 👍", { delivered: minAgo(579) });
  const tauri = store["mx-1:!rust-general"]?.find((y) => y.fromMe && y.text.startsWith("Anyone tried"));
  if (tauri) { const ids = membersOf("mx-1:!rust-general").map((c) => c.id); tauri.receipts = [{ id: ids[0], read: minAgo(10) }, { id: ids[1], read: minAgo(15) }]; } // Matrix: read only
}
