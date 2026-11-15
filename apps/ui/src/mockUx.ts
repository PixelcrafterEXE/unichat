// Mock-only message-view fixture (open the UI with ?mock&ux): one 1:1 chat, one group and one pair of DMs for a merged chat, built to
// exercise bubbles, runs, reactions, meta placement, placeholders and file cards. Nothing here is used by the normal mock data.
import type { Attachment, Chat, Message } from "./types";

export interface UxCtx {
  chats: Chat[]; store: Record<string, Message[]>; files: Map<string, { b64: string; mime: string; name?: string }>;
  b64: (s: string) => string; svg: (label: string, c1: string, c2: string, w?: number, h?: number) => string; wav: () => string;
  ago: (min: number) => string; nextId: () => number;
}
export const UX_LONG_NAME = "export-rtd-locations-au045-band-rehearsal-room-assets-2026-06-25.csv";

export function seedUx(x: UxCtx) {
  const { chats, store, files, b64, svg, ago } = x;
  const add = (chatId: string, sender: string, text: string, min: number, extra: Partial<Message> = {}) => {
    const id = "ux" + x.nextId(); const msg: Message = { id, chatId, sender, senderId: sender === "You" ? "me" : sender, text, time: ago(min), fromMe: sender === "You", ...extra };
    (store[chatId] ??= []).push(msg); return msg;
  };
  const pic = (msgId: string, label: string, c1: string, c2: string, w = 640, h = 420): Attachment => {
    const id = "uxa" + x.nextId(); files.set(`${msgId}|${id}`, { b64: b64(svg(label, c1, c2, w, h)), mime: "image/svg+xml", name: label + ".svg" });
    return { id, kind: "image", mime: "image/svg+xml", name: label + ".svg", size: 2_400_000, width: w, height: h, thumbnailDataUrl: "data:image/svg+xml;base64," + b64(svg(label, c1, c2, 240, 160)) };
  };
  const withAtt = (chatId: string, sender: string, text: string, min: number, mk: (id: string) => Attachment[], extra: Partial<Message> = {}) => {
    const id = "ux" + x.nextId(); const msg: Message = { id, chatId, sender, senderId: sender === "You" ? "me" : sender, text, time: ago(min), fromMe: sender === "You", attachments: mk(id), ...extra };
    (store[chatId] ??= []).push(msg); return msg;
  };
  const file = (msgId: string, name: string, mime: string, size: number, data = "a,b,c\n1,2,3\n"): Attachment => {
    const id = "uxa" + x.nextId(); files.set(`${msgId}|${id}`, { b64: b64(data), mime, name }); return { id, kind: "file", mime, name, size };
  };
  const D = 1440;
  // ---- 1:1: Lena (WhatsApp)
  const L = "wa-1:ux-lena"; chats.push({ id: L, provider: "whatsapp", accountId: "wa-1", name: "Lena Hoffmann", kind: "dm" });
  add(L, "Lena Hoffmann", "Morning!", D + 130); add(L, "Lena Hoffmann", "Are you coming to the climbing gym tonight?", D + 129);
  add(L, "You", "Yes, probably around 7", D + 120, { status: "read" });
  add(L, "Lena Hoffmann", "Great. I booked the small room for us, it has the new overhang wall that everybody keeps talking about, and the shoes are free if you ask nicely at the desk 🧗", 200);
  add(L, "You", "Perfect, see you there! I will bring the chalk and the new rope that I bought last week at the shop in town, it is really light.", 199, { status: "read" });
  add(L, "Lena Hoffmann", "ok", 198, { reactions: [{ emoji: "👍", senderIds: ["You"], mine: true }] });
  withAtt(L, "Lena Hoffmann", "[Photo]", 150, (id) => [pic(id, "Overhang wall", "#3a76f0", "#25d366")]);
  withAtt(L, "Lena Hoffmann", "Look at the route setter's new project", 149, (id) => [pic(id, "New project", "#eb459e", "#f0a030")], { reactions: [{ emoji: "❤️", senderIds: ["You", "Lena Hoffmann"], mine: true }, { emoji: "🔥", senderIds: ["Lena Hoffmann"] }, { emoji: "😮", senderIds: ["Lena Hoffmann"] }] });
  withAtt(L, "Lena Hoffmann", `[File: ${UX_LONG_NAME}]`, 100, (id) => [file(id, UX_LONG_NAME, "text/csv", 48_300)]);
  withAtt(L, "You", "[File: notes.txt]", 98, (id) => [file(id, "notes.txt", "text/plain", 900)], { status: "delivered" });
  add(L, "Lena Hoffmann", "[Photo]", 90); // a photo that could not be restored
  add(L, "Lena Hoffmann", "[File: climbing-gym-price-list-2026.pdf]", 89);
  withAtt(L, "Lena Hoffmann", "", 60, (id) => { const a = "uxa" + x.nextId(); files.set(`${id}|${a}`, { b64: b64("x"), mime: "audio/wav", name: "voice.wav" }); return [{ id: a, kind: "voice", mime: "audio/wav", durationMs: 14_000, waveform: [10, 25, 60, 90, 40, 70, 100, 55, 30, 45, 80, 35, 20, 65, 50, 15, 30, 70, 40, 20] }]; });
  add(L, "You", "Nice, thanks!", 58, { status: "read", replyTo: { messageId: "x", sender: "Lena Hoffmann", textPreview: "Voice message" } });
  add(L, "Lena Hoffmann", "Here is the gym page:", 40, { card: { kind: "link", title: "Boulderhalle Mitte", body: "Opening hours, prices and the course calendar", url: "https://example.org/gym", image: { attachmentId: "uxc", width: 200, height: 200, layout: "thumb" as const, thumbnailDataUrl: "data:image/svg+xml;base64," + b64(svg("Gym", "#3a76f0", "#23a559", 200, 200)) } } });
  add(L, "Lena Hoffmann", "😂", 30); add(L, "Lena Hoffmann", "مرحبا كيف حالك", 29);
  add(L, "You", "Short one", 20, { status: "sent" });
  add(L, "Lena Hoffmann", "A message that is long enough to wrap into a second line, and then the last word", 10, { reactions: [{ emoji: "👍", senderIds: ["a", "b"] }, { emoji: "🎉", senderIds: ["a"] }, { emoji: "😂", senderIds: ["a", "b", "c"] }, { emoji: "❤️", senderIds: ["a"] }, { emoji: "🙏", senderIds: ["a"] }, { emoji: "🔥", senderIds: ["a"] }] });
  chats.find((c) => c.id === L)!.unread = 0;
  // ---- group: Climbing crew
  const G = "wa-1:ux-crew"; chats.push({ id: G, provider: "whatsapp", accountId: "wa-1", name: "Weekend climbers", kind: "group" });
  add(G, "Jonas", "Who is in for Saturday?", 300); add(G, "Jonas", "Weather looks good", 299); add(G, "Mia", "I am!", 296, { reactions: [{ emoji: "👍", senderIds: ["Jonas", "Tom"] }] });
  add(G, "Mia", "Can someone drive?", 295); add(G, "You", "I can take 3", 290, { status: "read", reactions: [{ emoji: "❤️", senderIds: ["Mia"] }] });
  withAtt(G, "Tom", "[Photo]", 120, (id) => [pic(id, "Crag", "#3a76f0", "#eb459e"), pic(id, "Topo", "#25d366", "#f0a030")]);
  add(G, "Jonas", "Looks amazing", 118, { replyTo: { messageId: "x", sender: "Tom", textPreview: "Photo" } });
  add(G, "Tom", `[File: ${UX_LONG_NAME}]`, 60);
  // ---- merged: Mira on WhatsApp + Matrix
  const W = "wa-1:ux-mira", M = "mx-1:@ux-mira:matrix.org";
  chats.push({ id: W, provider: "whatsapp", accountId: "wa-1", name: "Mira Kowalski", kind: "dm" }, { id: M, provider: "matrix", accountId: "mx-1", name: "Mira Kowalski", kind: "dm" });
  add(W, "Mira Kowalski", "Hey, are you around tomorrow?", D + 300); add(W, "Mira Kowalski", "I wanted to show you the new flat", D + 299);
  add(M, "Mira Kowalski", "Also writing here in case WhatsApp is slow", D + 298); add(M, "You", "Hi Mira, yes!", D + 290, { status: "read" });
  add(W, "Mira Kowalski", "Perfect", 400); add(W, "Mira Kowalski", "See you at 5", 399); add(M, "Mira Kowalski", "Sending the address here", 398);
  add(M, "Mira Kowalski", "Linienstrasse 12", 397, { reactions: [{ emoji: "👍", senderIds: ["You"], mine: true }] });
  add(W, "You", "On my way", 12, { status: "read" }); add(W, "You", "Almost there", 8, { status: "delivered" }); add(M, "You", "Where is the door?", 5, { status: "sent" });
  add(M, "Mira Kowalski", "Second floor, the green one", 3);
}
