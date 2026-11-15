// Big mock dataset for performance work (`?mock&big=1`): ~600 chats in 8 communities, categories, 20 merged chats and
// 100k messages (one chat with 10k). Histories are generated lazily per chat (deterministic), so start-up stays honest:
// what is measured is the UI, not the generator. Never loaded without `big`.
import type { Attachment, Chat, ChatMerge, Message, Space } from "./types";

export const BIG = typeof location !== "undefined" && new URLSearchParams(location.search).has("big");

const FIRST = ["Anna", "Ben", "Carl", "Dana", "Eva", "Finn", "Greta", "Hugo", "Ida", "Jonas", "Kira", "Lea", "Max", "Nora", "Otto", "Pia", "Quentin", "Rosa", "Sam", "Tina", "Uwe", "Vera", "Wim", "Xenia", "Yusuf", "Zoe"];
const LAST = ["Becker", "Fischer", "Lorenz", "Schmidt", "Weber", "Wagner", "Hoffmann", "Koch", "Richter", "Klein", "Wolf", "Neumann", "Braun", "Krüger", "Hartmann"];
const WORDS = "the a to and of in for is on that with we you it be are at this have from or one had by word but not what all were when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part".split(" ");
const EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉"];

function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const PIC = "data:image/svg+xml;base64," + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="100%" height="100%" fill="#3a76f0"/><circle cx="120" cy="80" r="40" fill="#25d366"/></svg>`);
export const BIG_FILE = { b64: btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="100%" height="100%" fill="#3a76f0"/><circle cx="320" cy="210" r="120" fill="#25d366"/></svg>`), mime: "image/svg+xml", name: "photo.svg" };

/** Number of messages per chat id (filled by seedBig). */
const counts = new Map<string, number>();
let idSeq = 1_000_000;

function gen(chatId: string, n: number, mine: string[]): Message[] {
  const r = rng(chatId), out: Message[] = [], now = Date.now();
  let t = now - 60_000;
  const people = chatId.includes("grp") || chatId.includes("ch") ? ["Ana", "Ben", "Cleo", "Dev"] : [chatId.split(":").pop()!];
  for (let i = n - 1; i >= 0; i--) {
    const fromMe = r() < 0.4, words = 1 + Math.floor(r() * (r() < 0.08 ? 60 : 14));
    let text = ""; for (let k = 0; k < words; k++) text += (k ? " " : "") + WORDS[Math.floor(r() * WORDS.length)];
    if (r() < 0.02) text += " https://example.org/some/rather/long/path/that/should/wrap/properly?x=1&y=2";
    const id = "b" + (idSeq + i) + ":" + chatId.length, sender = fromMe ? "You" : people[Math.floor(r() * people.length)];
    const msg: Message = { id, chatId, sender, senderId: sender, text, time: new Date(t).toISOString(), fromMe, ...(fromMe ? { status: "read" as const } : {}) };
    if (r() < 0.05) { const att: Attachment = { id: "a" + id, kind: "image", mime: "image/svg+xml", name: "photo.svg", width: 640, height: 420, size: 120_000, thumbnailDataUrl: PIC }; msg.attachments = [att]; }
    if (r() < 0.12) msg.reactions = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ emoji: EMOJI[Math.floor(r() * EMOJI.length)], senderIds: ["Ana"], count: 1 + Math.floor(r() * 4), mine: r() < 0.1 }));
    out.push(msg);
    t -= (r() < 0.9 ? 20_000 + r() * 240_000 : 3_600_000 + r() * 40_000_000);
  }
  void mine;
  return out.reverse().sort((a, b) => a.time.localeCompare(b.time));
}

/** A `store` whose big chats materialise their history on first access. */
export function lazyStore(): Record<string, Message[]> {
  const real: Record<string, Message[]> = {};
  return new Proxy(real, {
    get(t, k: string) { if (typeof k === "string" && !(k in t) && counts.has(k)) t[k] = gen(k, counts.get(k)!, []); return t[k]; },
    has(t, k: string) { return k in t || counts.has(k as string); },
  });
}

export interface BigCtx { chats: Chat[]; spaces: Space[]; merges: Map<string, ChatMerge>; mk: (id: string, provider: string, accountId: string, name: string, kind: Chat["kind"], o?: Partial<Chat>) => Chat; }

/** Add ~600 chats, 8 communities (with categories), 20 merges. Returns the total message count. */
export function seedBig({ chats, spaces, merges, mk }: BigCtx): number {
  const r = rng("big-seed"), now = Date.now();
  let total = 0;
  const give = (id: string, n: number) => { counts.set(id, n); total += n; };
  const name = () => FIRST[Math.floor(r() * FIRST.length)] + " " + LAST[Math.floor(r() * LAST.length)];
  const stamp = (i: number) => new Date(now - i * 7 * 60_000 - Math.floor(r() * 60_000)).toISOString();
  let idx = 0;
  // 8 communities (WhatsApp / Matrix / Discord), 30 channels each, in 4 categories
  const comm: [string, string, string][] = [["wa-1", "whatsapp", "Hiking Club XL"], ["wa-1", "whatsapp", "Neighbourhood XL"], ["mx-1", "matrix", "Rustaceans"], ["mx-1", "matrix", "Self-Hosters XL"],
    ["mx-1", "matrix", "Matrix HQ XL"], ["dc-1", "discord", "Dev Guild"], ["dc-2", "discord", "Gaming Friends"], ["dc-1", "discord", "Design Club"]];
  comm.forEach(([acc, prov, nm], ci) => {
    const sid = `${acc}:big-sp${ci}`; spaces.push({ id: sid, accountId: acc, provider: prov, name: nm });
    for (let k = 0; k < 30; k++) {
      const id = `${acc}:big-ch${ci}-${k}`;
      chats.push(mk(id, prov, acc, `${["general", "random", "help", "news", "dev", "ops", "memes", "music"][k % 8]}-${k}`, "channel", { spaceId: sid, category: ["Text", "Voice", "Projects", "Archive"][k % 4], preview: "Last message in this channel", lastMessageAt: stamp(idx++), ...(r() < 0.2 ? { unread: 1 + Math.floor(r() * 40) } : {}) }));
      give(id, 20 + Math.floor(r() * 120));
    }
  });
  // 360 personal chats: DMs and groups, WhatsApp + Matrix
  for (let i = 0; i < 360; i++) {
    const group = i % 4 === 0, acc = i % 3 === 0 ? "mx-1" : "wa-1", prov = acc === "mx-1" ? "matrix" : "whatsapp";
    const id = `${acc}:big-${group ? "grp" : "dm"}${i}`;
    chats.push(mk(id, prov, acc, group ? `${["Family", "Trail friends", "Work", "Book club", "Climbing"][i % 5]} ${i}` : name(), group ? "group" : "dm", { preview: "Hey, are you around later this week?", lastMessageAt: stamp(idx++), ...(r() < 0.2 ? { unread: 1 + Math.floor(r() * 9) } : {}), ...(i % 40 === 0 ? { pinned: true } : {}) }));
    give(id, i === 0 ? 10_000 : i < 11 ? 3000 : i < 70 ? 700 : 15 + Math.floor(r() * 25));
  }
  // 20 merged chats: the same person on WhatsApp and Matrix
  for (let i = 0; i < 20; i++) {
    const nm = FIRST[i] + " Merge" + i, a = `wa-1:big-mw${i}`, b = `mx-1:big-mm${i}`;
    chats.push(mk(a, "whatsapp", "wa-1", nm, "dm", { preview: "WhatsApp hello", lastMessageAt: stamp(idx++) }), mk(b, "matrix", "mx-1", nm, "dm", { preview: "Matrix hello", lastMessageAt: stamp(idx++) }));
    give(a, 400); give(b, 300);
    merges.set("merge:big" + i, { id: "merge:big" + i, members: [a, b], primary: a, createdAt: new Date().toISOString() });
  }
  // fill up to ~100k messages in the personal chats that are still small
  const bigChats = chats.filter((c) => c.id.includes(":big-"));
  let k = 0; while (total < 100_000) { const c = bigChats[(k += 7) % bigChats.length]; counts.set(c.id, counts.get(c.id)! + 50); total += 50; }
  return total;
}
