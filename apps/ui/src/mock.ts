// In-browser fake backend (open the UI with ?mock). Same call()/event surface as the real Hub,
// including attachments, locations, contact cards, receipts, account linking and chat creation.
import type { Account, Attachment, Chat, ChatMerge, Contact, Message, ProviderInfo, Space } from "./types";
import { BIG, BIG_FILE, lazyStore, seedBig } from "./mockBig";
import { mockBackupCall, mockBackupHandles } from "./mockBackup";
import { mockUpdateCall, mockUpdateHandles } from "./mockUpdate"; // self-update mock
import { mockSyncCall, mockSyncHandles } from "./mockSync"; // device sync mock
import { mockSignalImportAccounts, mockSignalImportCall, mockSignalImportHandles } from "./mockSignalImport"; // Signal history import mock
import { mockSafCall, mockSafHandles } from "./mockSaf"; // Android "Find the backup on this phone" mock
import { mockWhatsAppImportCall, mockWhatsAppImportHandles } from "./mockWhatsAppImport"; // WhatsApp history import mock
import { MOCK_WEBM_B64 } from "./mockVideo";
import { seedUx } from "./mockUx";
import { mockExtraCall, mockExtraHandles } from "./mockExtra";
import { installMatrixVerifyHooks, mockMatrixVerifyCall, mockMatrixVerifyHandles } from "./mockMatrixVerify"; // Matrix emoji verification mock
import { recordReceipt, seedReceipts, sendReceipts } from "./mockReceipts";
import { applyFolders } from "../../../packages/core/src/folders";
import { PERSONAL, isFolderId, type Folder } from "../../../packages/core/src/model";
import { normalizeRailGroups, type RailGroup } from "../../../packages/core/src/railgroups";
import { Categories, applyCategories } from "../../../packages/core/src/categories";

const chatPics = new Map<string, { dataBase64: string; mime: string } | null>();
const caps = (o: object = {}) => ({ spaces: false, reactions: true, edits: true, deletes: true, replies: true, attachments: true,
  typing: true, readReceipts: true, startChat: true, createGroup: true, backfill: false, e2ee: true, location: true, contactCards: true, voiceNotes: true,
  leaveChat: true, manageMembers: true, renameChat: true, chatPicture: true, chatDescription: true, block: true, createSpace: true, joinSpace: true, polls: true, leaveSpace: true, ...o });
const providers: ProviderInfo[] = [
  { name: "whatsapp", displayName: "WhatsApp", login: "qr", capabilities: caps({ pinMessages: true, pinDurations: [86400, 604800, 2592000], spaces: true, receiptDetails: true, presence: true, profile: { displayName: true, about: true, avatar: true }, privacy: true, events: true, eventEdit: true, refreshChat: true, disappearing: true, disappearingDurations: [86400, 604800, 7776000] }) },
  { name: "signal", displayName: "Signal", login: "qr", capabilities: caps({ spaces: false, manageMembers: false, renameChat: false, leaveChat: false, createSpace: false, joinSpace: false, polls: false, leaveSpace: false, sync: true, disappearing: true, disappearingDurations: [30, 300, 3600, 28800, 86400, 604800, 2419200] }) },
  { name: "matrix", displayName: "Matrix", login: "form", capabilities: caps({ pinMessages: true, spaces: true, receiptDetails: true, backfill: true, fetchHistory: true, contactCards: false, presence: true, verification: true, profile: { displayName: true, avatar: true }, privacy: true }) },
  // Discord: the provider-level caps are the defaults; each ACCOUNT overrides them (bot vs user mode), see `accounts` below
  { name: "discord", displayName: "Discord", login: "form", capabilities: caps({ spaces: true, e2ee: false, backfill: true, fetchHistory: true, location: false, contactCards: false, voiceNotes: false, createGroup: false, manageMembers: false, renameChat: false, chatPicture: false, block: false, createSpace: false, joinSpace: false, mentions: true, readReceipts: false, markRead: true, customEmoji: true }) },
  { name: "instagram", displayName: "Instagram", login: "form", capabilities: caps({ spaces: false, e2ee: false, backfill: true, edits: false, location: false, contactCards: false, polls: false, leaveSpace: false, createSpace: false, joinSpace: false, manageMembers: false, chatPicture: false, block: false, requests: true, mentions: false }) },
];
// ?mock&manyproviders=1: a long provider list (the Add account dialog must scroll on a phone)
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("manyproviders")) for (const [n, d] of [["mattermost", "Mattermost"], ["teams", "Microsoft Teams"], ["threema", "Threema"], ["threema-md", "Threema (multi-device)"], ["telegram", "Telegram"], ["slack", "Slack"], ["xmpp", "XMPP"]]) providers.push({ ...providers[4]!, name: n!, displayName: d! });
const accounts: Account[] = mockSignalImportAccounts<Account>([
  { id: "wa-1", provider: "whatsapp", label: "WhatsApp · +49 151 2345", state: "connected", everLinked: true },
  { id: "mx-1", provider: "matrix", label: "@michi:matrix.org", state: "connected", everLinked: true },
  // two accounts of the SAME provider with different effective capabilities (Discord bot vs user token)
  { id: "dc-1", provider: "discord", label: "Discord · UniChat Bot", state: "connected", everLinked: true,
    capabilities: caps({ spaces: true, e2ee: false, fetchHistory: true, voiceNotes: false, location: false, contactCards: false, createGroup: false, manageMembers: false, renameChat: false, chatPicture: false, block: false, createSpace: false, joinSpace: false, mentions: true, polls: true, pollVote: false, readReceipts: false, markRead: true, customEmoji: true, profile: undefined, privacy: undefined }) },
  { id: "dc-2", provider: "discord", label: "Discord · michi (user account)", state: "connected", everLinked: true,
    capabilities: caps({ spaces: true, e2ee: false, fetchHistory: true, voiceNotes: true, location: false, contactCards: false, createGroup: true, manageMembers: true, renameChat: true, chatPicture: false, block: false, createSpace: false, joinSpace: false, mentions: true, polls: true, pollVote: true, readReceipts: false, markRead: true, customEmoji: true, presence: true }) },
  { id: "ig-1", provider: "instagram", label: "Instagram · @michi.hikes", state: "connected", everLinked: true },
]);
const spaces: Space[] = [
  { id: "wa-1:hike", accountId: "wa-1", provider: "whatsapp", name: "Hiking Club" },
  { id: "mx-1:!rust", accountId: "mx-1", provider: "matrix", name: "Rust Community" },
  { id: "mx-1:!self", accountId: "mx-1", provider: "matrix", name: "Self-Hosters" },
  { id: "wa-1:neigh", accountId: "wa-1", provider: "whatsapp", name: "Neighbours" },      // a community where I only sit in the announcement group: 1 chat
  { id: "mx-1:!old", accountId: "mx-1", provider: "matrix", name: "Old Project" },       // archived community with a single chat
  { id: "dc-1:g1", accountId: "dc-1", provider: "discord", name: "UniChat Dev" },          // channels grouped in categories
  { id: "dc-2:g2", accountId: "dc-2", provider: "discord", name: "Friends Server" },
];
const mk = (id: string, provider: string, accountId: string, name: string, kind: Chat["kind"], o: Partial<Chat> = {}): Chat => ({ id, provider, accountId, name, kind, ...o });
const chats: Chat[] = [
  mk("wa-1:anna", "whatsapp", "wa-1", "Anna Becker", "dm", { unread: 2 }),
  mk("wa-1:ben", "whatsapp", "wa-1", "Ben Fischer", "dm"),
  mk("mx-1:@anna:matrix.org", "matrix", "mx-1", "Anna Becker", "dm", { unread: 1 }), // the same person as wa-1:anna, on Matrix: can be merged
  mk("mx-1:@bea:matrix.org", "matrix", "mx-1", "Bea Lorenz", "dm"),
  mk("wa-1:a24", "whatsapp", "wa-1", "A24", "group", { unread: 2 }),
  mk("mx-1:@carl:matrix.org", "matrix", "mx-1", "Carl", "dm", { unread: 1 }),
  mk("wa-1:family", "whatsapp", "wa-1", "Family", "group", { description: "Sunday lunch planning ⛰️" }),
  mk("wa-1:hike-ann", "whatsapp", "wa-1", "Announcements", "channel", { spaceId: "wa-1:hike", readOnly: true, category: "Official" }),
  mk("wa-1:hike-trips", "whatsapp", "wa-1", "Trip planning", "channel", { spaceId: "wa-1:hike", unread: 5 }),
  mk("mx-1:!rust-general", "matrix", "mx-1", "general", "channel", { spaceId: "mx-1:!rust", unread: 12, description: "Everything Rust" }),
  mk("mx-1:!rust-help", "matrix", "mx-1", "help", "channel", { spaceId: "mx-1:!rust" }),
  mk("mx-1:!self-gen", "matrix", "mx-1", "chat", "channel", { spaceId: "mx-1:!self" }),
  mk("mx-1:!self-ops", "matrix", "mx-1", "ops", "channel", { spaceId: "mx-1:!self" }),
  mk("wa-1:neigh-ann", "whatsapp", "wa-1", "Neighbours announcements", "channel", { spaceId: "wa-1:neigh", readOnly: true, preview: "Bins go out on Thursday", lastMessageAt: new Date(Date.now() - 3 * 3600_000).toISOString() }),
  mk("mx-1:!old-gen", "matrix", "mx-1", "old-general", "channel", { spaceId: "mx-1:!old", preview: "Project archived", lastMessageAt: new Date(Date.now() - 90 * 86400_000).toISOString() }),
  mk("wa-1:trail", "whatsapp", "wa-1", "Trail friends", "group", { preview: "Who has the map?", lastMessageAt: new Date(Date.now() - 5 * 3600_000).toISOString() }),
  mk("mesh:1", "mesh", "", "Weekend crew", "group", { description: "Mesh group across WhatsApp + Matrix" }),
  // Discord server with categories (Chat.category); two channels without one stay on top
  mk("dc-1:welcome", "discord", "dc-1", "welcome", "channel", { spaceId: "dc-1:g1", description: "Start here" }),
  mk("dc-1:rules", "discord", "dc-1", "rules", "channel", { spaceId: "dc-1:g1", readOnly: true }),
  mk("dc-1:general", "discord", "dc-1", "general", "channel", { spaceId: "dc-1:g1", category: "Text Channels", unread: 4 }),
  mk("dc-1:dev-talk", "discord", "dc-1", "dev-talk", "channel", { spaceId: "dc-1:g1", category: "Text Channels" }),
  mk("dc-1:roadmap", "discord", "dc-1", "roadmap", "channel", { spaceId: "dc-1:g1", category: "Projects" }),
  mk("dc-1:bugs", "discord", "dc-1", "bugs", "channel", { spaceId: "dc-1:g1", category: "Projects", unread: 2 }),
  mk("dc-2:general", "discord", "dc-2", "general", "channel", { spaceId: "dc-2:g2", category: "Text Channels" }),
  mk("dc-2:dana", "discord", "dc-2", "dana", "dm"),
  mk("dc-2:gdm", "discord", "dc-2", "Climbing group DM", "group"),
  // Instagram: approximate unread (a dot), a pending message request
  mk("ig-1:alice", "instagram", "ig-1", "Alice Anderson", "dm", { unread: 1, unreadApprox: true }),
  mk("ig-1:mallory", "instagram", "ig-1", "Mallory Fan", "dm", { request: true, unread: 1, unreadApprox: true }),
  mk("ig-1:crew", "instagram", "ig-1", "Climbing crew", "group"),
];
const contacts: Contact[] = ["Anna Becker", "Ben Fischer", "Carl", "Tom", "Lea", "ferris", "dana"].map((n, i) => ({ id: "c" + i, name: n, handle: i < 5 ? `+49 151 ${1000 + i * 111}` : `@${n}:matrix.org` }));

// ---- fake media ----
const files = new Map<string, { b64: string; mime: string; name?: string }>();
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const svg = (label: string, c1: string, c2: string, w = 640, h = 420) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><path d="M0 ${h} L${w * 0.3} ${h * 0.45} L${w * 0.5} ${h * 0.7} L${w * 0.72} ${h * 0.3} L${w} ${h} Z" fill="#0004"/><circle cx="${w * 0.8}" cy="${h * 0.2}" r="34" fill="#fff8"/><text x="24" y="${h - 24}" font-family="sans-serif" font-size="30" fill="#fff">${label}</text></svg>`;
function wav(): string { // 0.8s 440Hz tone
  const sr = 8000, n = sr * 0.8, d = new Uint8Array(44 + n);
  const dv = new DataView(d.buffer); const w = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); dv.setUint32(4, 36 + n, true); w(8, "WAVEfmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); w(36, "data"); dv.setUint32(40, n, true);
  for (let i = 0; i < n; i++) d[44 + i] = 128 + Math.round(40 * Math.sin((2 * Math.PI * 440 * i) / sr) * (1 - i / n));
  let s = ""; d.forEach((x) => (s += String.fromCharCode(x))); return btoa(s);
}
let seq = 0;
function img(msgId: string, label: string, c1: string, c2: string): Attachment {
  const id = "att" + ++seq, data = b64(svg(label, c1, c2));
  files.set(`${msgId}|${id}`, { b64: data, mime: "image/svg+xml", name: label + ".svg" });
  const th = b64(svg(label, c1, c2, 240, 160));
  return { id, kind: "image", mime: "image/svg+xml", name: label + ".svg", size: 2_400_000, width: 640, height: 420, thumbnailDataUrl: "data:image/svg+xml;base64," + th };
}
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const store: Record<string, Message[]> = BIG ? lazyStore() : {};
function m(chatId: string, sender: string, text: string, min: number, extra: Partial<Message> = {}): Message {
  const id = "m" + ++seq;
  const msg: Message = { id, chatId, sender, senderId: sender, text, time: ago(min), fromMe: sender === "You", ...extra };
  (store[chatId] ??= []).push(msg); return msg;
}
// Anna
m("wa-1:anna", "Anna Becker", "Are we still on for Saturday?", 1500);
m("wa-1:anna", "You", "Yes! 10am at the station", 1490, { status: "read" });
{ const id = "m" + ++seq; const a = img(id, "Summit view", "#3a76f0", "#25d366");
  store["wa-1:anna"].push({ id, chatId: "wa-1:anna", sender: "Anna Becker", senderId: "Anna", text: "Look at this view from last week 😍", time: ago(60), fromMe: false, attachments: [a, img(id, "Lake", "#eb459e", "#f0a030")],
    reactions: [{ emoji: "❤️", senderIds: ["You"], mine: true }] }); }
for (const [label, w, h, col] of [["tiny 40x40", 40, 40, "#eb459e"], ["panorama 3000x400", 3000, 400, "#23a559"], ["tall 300x2000", 300, 2000, "#f0a030"], ["huge 6000x4000", 6000, 4000, "#3b82f6"]] as [string, number, number, string][]) {
  const id = "m" + ++seq, aid = "att" + ++seq, data = b64(svg(label, col, "#222", 160, Math.round(160 * h / w) || 160)), th = "data:image/svg+xml;base64," + data;
  files.set(`${id}|${aid}`, { b64: data, mime: "image/svg+xml", name: label + ".svg" });
  (store["wa-1:anna"] ??= []).push({ id, chatId: "wa-1:anna", sender: "Anna Becker", senderId: "Anna", text: "", time: ago(70), fromMe: false, attachments: [{ id: aid, kind: "image", mime: "image/svg+xml", name: label, width: w, height: h, thumbnailDataUrl: th }] });
}
// ?mock&media=1: a chat with lots of shared media (the gallery: paging, tabs, long file names, links, voice notes)
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("media")) {
  const cols = [["#3a76f0", "#25d366"], ["#eb459e", "#f0a030"], ["#23a559", "#222"], ["#f0a030", "#3b82f6"], ["#7c5cf0", "#eb459e"]];
  for (let i = 1; i <= 130; i++) { const id = "m" + ++seq, a = img(id, "Photo " + i, cols[i % 5]![0], cols[i % 5]![1]); a.name = `Photo-${i}.svg`;
    (store["wa-1:anna"] ??= []).push({ id, chatId: "wa-1:anna", sender: "Anna Becker", senderId: "Anna", text: i % 9 === 0 ? "Photo " + i : "", time: ago(3000 + i * 40), fromMe: false, attachments: [a] }); }
  const FN = ["Quarterly-report-final-version-2024-with-a-very-long-name-and-more.pdf", "holiday-plan.docx", "budget.xlsx", "Invoice-2024-0815.pdf", "notes.txt", "backup-archive-2024-08-15-full-export-complete.zip", "slides.pptx", "contract-signed-scan-page-1-of-12.pdf",
    "song.mp3", "readme.md", "data-2024.csv", "logo.png", "résumé-Anna-Becker-2024.pdf", "plan.pdf"];
  FN.forEach((name, i) => { const id = "m" + ++seq, aid = "att" + ++seq; files.set(`${id}|${aid}`, { b64: b64("file " + name), mime: "application/octet-stream", name });
    store["wa-1:anna"].push({ id, chatId: "wa-1:anna", sender: "Anna Becker", senderId: "Anna", text: "", time: ago(5000 + i * 50), fromMe: false, attachments: [{ id: aid, kind: "file", mime: "application/octet-stream", name, size: 1200 * (i + 1) * 37 }] }); });
  ["https://example.org/hike", "https://www.wikipedia.org/wiki/Zugspitze", "https://news.example.com/articles/2024/08/long-article-title-about-mountains?utm=1", "https://maps.example.net/place/Garmisch", "https://example.org/pack", "https://github.com/unichat/app"].forEach((u, i) => {
    m("wa-1:anna", "Anna Becker", `Have a look at ${u} when you can`, 7000 + i * 60, i === 1 ? { cards: [{ kind: "link", title: "Zugspitze - Wikipedia", subtitle: "The highest mountain in Germany", url: u }] } : {}); });
  for (let i = 0; i < 5; i++) { const id = "m" + ++seq, aid = "att" + ++seq; files.set(`${id}|${aid}`, { b64: wav(), mime: "audio/wav", name: "voice.wav" });
    store["wa-1:anna"].push({ id, chatId: "wa-1:anna", sender: i % 2 ? "You" : "Anna Becker", senderId: i % 2 ? "You" : "Anna", text: "", time: ago(8000 + i * 70), fromMe: i % 2 === 1, attachments: [{ id: aid, kind: "voice", mime: "audio/wav", durationMs: 800 + i * 1500, waveform: [10, 25, 60, 90, 40, 70, 100, 55, 30, 45, 80, 35] }] }); }
  store["wa-1:anna"].sort((a, b) => a.time.localeCompare(b.time));
}
const locMsg = m("wa-1:anna", "Anna Becker", "", 50, { location: { lat: 47.4212, lng: 10.9853, name: "Zugspitze summit", address: "Garmisch-Partenkirchen" } });
m("wa-1:anna", "You", "Meet here?", 45, { status: "read", replyTo: { messageId: locMsg.id, sender: "Anna Becker", textPreview: "Location: Zugspitze summit" } });
m("wa-1:anna", "Anna Becker", "", 30, { contacts: [{ name: "Tom Hartmann", phones: ["+49 171 5550123"], emails: ["tom@example.org"] }] });
{ const id = "m" + ++seq; const aid = "att" + ++seq; files.set(`${id}|${aid}`, { b64: wav(), mime: "audio/wav", name: "voice.wav" });
  store["wa-1:anna"].push({ id, chatId: "wa-1:anna", sender: "Anna Becker", senderId: "Anna", text: "", time: ago(12), fromMe: false, attachments: [{ id: aid, kind: "voice", mime: "audio/wav", durationMs: 800, waveform: [10,25,60,90,40,70,100,55,30,45,80,35,20,65,50,15] }] }); }
{ const id = "m" + ++seq; const aid = "att" + ++seq; files.set(`${id}|${aid}`, { b64: b64("Packliste\n- Boots\n- Snacks"), mime: "text/plain", name: "packing-list.txt" });
  store["wa-1:anna"].push({ id, chatId: "wa-1:anna", sender: "Anna Becker", senderId: "Anna", text: "Packing list, see https://example.org/hike", time: ago(5), fromMe: false, attachments: [{ id: aid, kind: "file", mime: "text/plain", name: "packing-list.txt", size: 24_000 }] }); }
{ const id = "m" + ++seq; const aid = "att" + ++seq; files.set(`${id}|${aid}`, { b64: b64("not really a video"), mime: "video/mp4", name: "funny.mp4" });
  store["wa-1:ben"] = [...(store["wa-1:ben"] ?? []), { id, chatId: "wa-1:ben", sender: "Ben Fischer", senderId: "Ben", text: "", time: ago(620), fromMe: false, attachments: [{ id: aid, kind: "video", mime: "video/mp4", name: "funny.mp4", gif: true }] }]; }
// Videos: a playable clip, two clips in one message (small tiles), and a QuickTime file the browser can't decode
{ const vid = (id: string, name: string, mime = "video/webm", data = MOCK_WEBM_B64, extra: Partial<Attachment> = {}): Attachment => { const aid = "att" + ++seq; files.set(`${id}|${aid}`, { b64: data, mime, name }); return { id: aid, kind: "video", mime, name, width: 128, height: 72, ...extra }; };
  const a = "m" + ++seq, b = "m" + ++seq, c = "m" + ++seq;
  store["wa-1:ben"].push({ id: a, chatId: "wa-1:ben", sender: "Ben Fischer", senderId: "Ben", text: "Clip from the trail", time: ago(616), fromMe: false, attachments: [vid(a, "trail.webm", "video/webm", MOCK_WEBM_B64, { durationMs: 1500 })] });
  store["wa-1:ben"].push({ id: b, chatId: "wa-1:ben", sender: "Ben Fischer", senderId: "Ben", text: "", time: ago(614), fromMe: false, attachments: [vid(b, "pair-1.webm"), vid(b, "pair-2.webm")] });
  store["wa-1:ben"].push({ id: c, chatId: "wa-1:ben", sender: "Ben Fischer", senderId: "Ben", text: "", time: ago(612), fromMe: false, attachments: [vid(c, "IMG_0042.MOV", "video/quicktime", b64("not decodable"), { durationMs: 4000 })] }); }
m("wa-1:ben", "Ben Fischer", "", 610, { location: { lat: 52.5163, lng: 13.3777, name: "Walking to the station", live: true, updatedAt: new Date().toISOString(), liveUntil: new Date(Date.now() + 36e5).toISOString() } });
m("wa-1:ben", "Ben Fischer", "Did you get my invoice?", 600); m("wa-1:a24", "Chris", "Only one of the two unread messages ever arrived", 90); m("wa-1:ben", "You", "Will pay tomorrow 👍", 580, { status: "delivered" });
m("mx-1:@carl:matrix.org", "Carl", "Matrix bridge is up again", 90);
// Anna on Matrix (merge it with her WhatsApp chat: the two timelines interleave)
m("mx-1:@anna:matrix.org", "Anna Becker", "Hi! This is my new Matrix account 👋", 2100);
m("mx-1:@anna:matrix.org", "You", "Welcome to Matrix!", 2095, { status: "read" });
const trainMsg = m("mx-1:@anna:matrix.org", "Anna Becker", "btw the train leaves at 9:40, not 10", 1495);
m("mx-1:@anna:matrix.org", "Anna Becker", "Sent you the route here on Matrix too", 40, { replyTo: { messageId: trainMsg.id, sender: "Anna Becker", textPreview: "btw the train leaves at 9:40, not 10" } });
m("mx-1:@anna:matrix.org", "You", "Thanks, see you there", 8, { status: "delivered" });
m("mx-1:@bea:matrix.org", "Bea Lorenz", "Do you still have the tent?", 300);
m("wa-1:family", "Mum", "Sunday lunch at 1?", 800);
m("wa-1:family", "Oma", "Good morning everyone", 400); m("wa-1:family", "Oma", "Second message right after the first one", 399); m("wa-1:family", "Oma", "And a third one that is a bit longer so that it wraps onto a second line when the bubble is narrow", 398);
m("wa-1:family", "Mum", "Event: Sunday lunch", 650, { card: { kind: "event", title: "Sunday lunch", when: new Date(Date.now() + 3 * 864e5).toISOString(), until: new Date(Date.now() + 3 * 864e5 + 3 * 36e5).toISOString(), place: "Grandma's place", body: "Bring dessert!", url: "https://chat.whatsapp.com/example-event", editable: true } });
m("wa-1:family", "Dad", "Group invitation: Hiking Club", 600, { card: { kind: "invite", title: "Hiking Club", subtitle: "Group invitation", body: "Weekend trips in the Alps", url: "https://chat.whatsapp.com/example-invite" } });
m("wa-1:family", "", "Mum changed the group name to Family", 560, { system: { kind: "info" }, senderId: "sys" });
m("wa-1:family", "Shop", "How was your delivery?", 540, { card: { kind: "buttons", title: "Delivery feedback", body: "How was your delivery?", buttons: ["Great", "OK", "Poor"], footer: "Reply to rate" } });
m("wa-1:family", "Mum", "Missed voice call", 520, { card: { kind: "call", title: "Missed voice call", when: new Date(Date.now() - 520 * 60000).toISOString() } });
m("wa-1:family", "Dad", "", 700, { poll: { question: "Where should we eat on Sunday?", multiple: false, mine: [], options: [{ id: "o0", text: "Italian place", voters: ["Mum", "Anna"] }, { id: "o1", text: "Beer garden", voters: ["Dad"] }, { id: "o2", text: "At home", voters: [] }] } }); m("wa-1:family", "Dad", "👍", 790);
const ferrisMsg = m("mx-1:!rust-general", "ferris", "Async traits are finally nice to use.", 120);
m("mx-1:!rust-general", "dana", "Agreed, dyn-compatible ones landed too.", 110, { replyTo: { messageId: ferrisMsg.id, sender: "ferris", textPreview: "Async traits are finally nice…" }, reactions: [{ emoji: "👍", senderIds: ["a", "b", "c"] }] });
m("mx-1:!rust-general", "carl", "+1 to what was said back then", 100, { replyTo: { messageId: "old3", sender: "ferris", textPreview: "Older message #4" } });
m("mx-1:!rust-general", "You", "Anyone tried them with Tauri commands?", 20, { status: "delivered", editedAt: ago(19) });
m("wa-1:hike-trips", "Tom", "Proposal: Zugspitze, 14th", 300); m("wa-1:hike-trips", "Lea", "re: the ghost message", 280, { replyTo: { messageId: "ghost", sender: "Tom", textPreview: "(not in history)" } }); m("wa-1:hike-trips", "Lea", "I'm in", 290); m("wa-1:hike-trips", "Tom", "Message deleted", 200, { deleted: true });
m("wa-1:hike-ann", "Admin", "Welcome to the Hiking Club! Be kind.", 5000);
m("mesh:1", "Anna Becker", "Who's driving?", 15);

// ---- Discord: several embeds with preview images, exact counts, poll counts ----
function cardImg(msgId: string, label: string, c1: string, c2: string, w = 640, h = 320) {
  const id = "c" + ++seq; files.set(`${msgId}|${id}`, { b64: b64(svg(label, c1, c2, w, h)), mime: "image/svg+xml", name: label + ".svg" });
  return { attachmentId: id, width: w, height: h, thumbnailDataUrl: "data:image/svg+xml;base64," + b64(svg(label, c1, c2, 64, 32)), alt: label };
}
{ const id = "m" + ++seq;
  (store["dc-1:general"] ??= []).push({ id, chatId: "dc-1:general", sender: "ferris", senderId: "ferris", text: "Release notes are out, check the embeds", time: ago(40), fromMe: false,
    cards: [
      { kind: "other", title: "UniChat 0.4 released", subtitle: "GitHub", body: "Categories, mentions and message requests.", url: "https://example.org/release", image: cardImg(id, "Release banner", "#3a76f0", "#23a559") },
      { kind: "link", title: "Roadmap", body: "What comes next", url: "https://example.org/roadmap", image: { ...cardImg(id, "Thumb", "#eb459e", "#f0a030", 200, 200), layout: "thumb" as const } },
      { kind: "other", title: "Plain embed without an image", body: "Third card, text only" },
    ],
    reactions: [{ emoji: "👍", senderIds: ["ferris", "dana"], count: 42 }, { emoji: "🎉", senderIds: [], count: 7 }, { emoji: "❤️", senderIds: ["kit"] }] }); }
m("dc-1:general", "dana", "Vote on the next feature:", 35, { poll: { question: "Which feature next?", multiple: false, mine: [], options: [
  { id: "1", text: "Threads", voters: ["dana"], count: 120 }, { id: "2", text: "Voice", voters: [], count: 30 }, { id: "3", text: "Stickers", voters: [] }] } });
m("dc-1:general", "ferris", "Welcome everyone", 300); m("dc-1:dev-talk", "dana", "CI is green again", 200); m("dc-1:bugs", "kit", "Crash on startup with an empty config", 50); m("dc-1:roadmap", "ferris", "Q4 plan is pinned", 500);
// Discord run of one sender in #dev-talk: plain follow-ups, one with embeds, one with a reply, then another sender (grouping / indentation)
m("dc-1:dev-talk", "kit", "Morning! Has anyone seen the failing test?", 130); m("dc-1:dev-talk", "kit", "It only fails on CI, never locally", 129);
{ const id = "m" + ++seq; (store["dc-1:dev-talk"] ??= []).push({ id, chatId: "dc-1:dev-talk", sender: "kit", senderId: "kit", text: "Here is the log", time: ago(128), fromMe: false,
    cards: [{ kind: "other", title: "CI run #812", subtitle: "GitHub Actions", body: "1 failed, 214 passed", url: "https://example.org/ci/812", image: cardImg(id, "CI banner", "#da373c", "#f0a030") }] }); }
m("dc-1:dev-talk", "kit", "And a third follow-up that is long enough to wrap onto a second line when the column is narrow, to check the alignment of wrapped text", 127);
m("dc-1:dev-talk", "dana", "Flaky, I will restart it", 120);
m("dc-1:welcome", "ferris", "Start here: read the rules", 900); m("dc-1:rules", "ferris", "Be kind.", 900);
m("dc-2:general", "Anna Becker", "Anyone up for climbing on Saturday?", 60, { poll: { question: "Saturday or Sunday?", multiple: false, mine: [], options: [{ id: "1", text: "Saturday", voters: ["Anna Becker"], count: 5 }, { id: "2", text: "Sunday", voters: [], count: 2 }] } });
m("dc-2:gdm", "Ben Fischer", "Who brings the rope?", 30); m("dc-2:dana", "dana", "hey, got a minute?", 20);
// ---- Instagram: shared reel with preview image, a message request ----
{ const id = "m" + ++seq;
  (store["ig-1:alice"] ??= []).push({ id, chatId: "ig-1:alice", sender: "Alice Anderson", senderId: "Alice", text: "Shared a reel by @bob", time: ago(25), fromMe: false,
    card: { kind: "other", title: "Reel by @bob", body: "Sunrise at the Zugspitze", url: "https://www.instagram.com/reel/ABC/", image: cardImg(id, "Reel preview", "#833ab4", "#fd1d1d", 360, 640) } }); }
m("ig-1:alice", "Alice Anderson", "Did you see this?", 24); m("ig-1:mallory", "Mallory Fan", "Hi! Love your photos, can we talk collabs?", 120); m("ig-1:crew", "Alice Anderson", "Wall opens at 6", 90);
 m("mesh:1", "Carl", "I can, 3 seats", 14);
if (new URLSearchParams(location.search).has("ux")) seedUx({ chats, store, files, b64, svg, wav, ago, nextId: () => ++seq }); // ?mock&ux: message-view fixture for screenshots/tests
for (const c of chats) { const l = store[c.id]?.at(-1); if (l) { c.preview = l.deleted ? "Message deleted" : l.text || (l.location ? "Location" : l.contacts ? "Contact" : l.attachments?.[0]?.kind === "voice" ? "Voice message" : l.attachments ? "Photo" : ""); c.lastMessageAt = l.time; } }

// older filler so "load earlier messages" has something to page through
{ const id = "mx-1:!rust-general"; const old: Message[] = [];
  for (let i = 0; i < 140; i++) old.push({ id: "old" + i, chatId: id, sender: ["ferris", "dana", "kit"][i % 3], senderId: ["ferris", "dana", "kit"][i % 3], text: `Older message #${i + 1}`, time: ago(5000 - i * 20), fromMe: false });
  store[id] = [...old, ...store[id]]; }
// ---- merged chats (local-only, like in the Hub): id "merge:<n>", members keep their own messages
const merges = new Map<string, ChatMerge>();
if (BIG) (globalThis as any).__bigMessages = seedBig({ chats, spaces, merges, mk }); // ?mock&big=1: ~600 chats, 100k messages (see mockBig.ts)
const mergeOfChat = (cid?: string) => [...merges.values()].find((x) => x.members.includes(cid ?? ""))?.id;
const isMerge = (id?: string) => !!id && id.startsWith("merge:");
const cmpMsg = (a: Message, b: Message) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id) || a.chatId.localeCompare(b.chatId);
const lastViaOf = (mg: ChatMerge) => mg.members.flatMap((c) => (store[c] ?? []).slice(-1)).sort(cmpMsg).at(-1)?.chatId;
const profiles: Record<string, { displayName?: string; about?: string; handle?: string; avatar: { dataBase64: string; mime: string } | null }> = {};
const privacyState: Record<string, { id: string; label: string; description?: string; value: string; options: { value: string; label: string }[] }[]> = {};
const privacyOf = (acc: string) => (privacyState[acc] ??= accounts.find((a) => a.id === acc)?.provider === "matrix"
  ? [{ id: "readReceipts", label: "Send read receipts", description: "Who can see that you read a message", value: "public", options: [{ value: "public", label: "Everyone" }, { value: "private", label: "Only the server" }, { value: "off", label: "Nobody" }] }]
  : [{ id: "lastSeen", label: "Last seen", value: "contacts", options: [{ value: "all", label: "Everyone" }, { value: "contacts", label: "My contacts" }, { value: "none", label: "Nobody" }] },
     { id: "readReceipts", label: "Read receipts", description: "If off, you won't see others' read receipts either", value: "all", options: [{ value: "all", label: "On" }, { value: "none", label: "Off" }] }]);
const aliases: Record<string, string> = {};
const flags: Record<string, { pinned?: boolean; muted?: boolean; archived?: boolean; unreadMark?: boolean }> = { "mx-1:!old": { archived: true } };
// local folders (see packages/core/src/folders.ts: the same code the real Hub runs)
const folders: Folder[] = [{ id: "folder:fav", name: "Favourites", color: "#e0a030", icon: "⭐" }];
const chatFolders: Record<string, string> = { "mx-1:@bea:matrix.org": "folder:fav", "wa-1:trail": "folder:fav", "mx-1:@carl:matrix.org": "folder:fav" };
let railOrder: string[] = [];
let railGroups: RailGroup[] = []; // local rail groups (same validation as the Hub)
// user categories inside a view: the very class the Hub runs, on an in-memory settings map. Seed: Hiking Club has the provider heading "Official" plus the user's own "Planning" and an empty "Gear ideas".
const catSettings = new Map<string, string>([
  ["userCategories", JSON.stringify({ "wa-1:hike": [{ id: "cat:seed-planning", name: "Planning", color: "#3b82f6", order: 0 }, { id: "cat:seed-gear", name: "Gear ideas", order: 1 }] })],
  ["chatCategories", JSON.stringify({ "wa-1:hike-trips": "cat:seed-planning" })],
]);
let collapseSingle = true;
const groupMembers: Record<string, Contact[]> = {};
// presence (Capabilities.presence, live only): who is online / when last seen. Seeds: Anna (WhatsApp) and Bea (Matrix) and dana (Discord user account) are online, Ben was seen 2 h ago.
const presenceOf: Record<string, { online: boolean; lastSeen?: string }> = {
  "wa-1:anna": { online: true }, "wa-1:ben": { online: false, lastSeen: new Date(Date.now() - 2 * 3600_000).toISOString() },
  "mx-1:@bea:matrix.org": { online: true }, "dc-2:dana": { online: true },
};
const memberPresence: Record<string, { online: boolean; lastSeen?: string }> = { c0: { online: true }, c1: { online: false, lastSeen: new Date(Date.now() - 2 * 3600_000).toISOString() } };
const membersOf = (id: string) => (groupMembers[id] ??= contacts.slice(0, 5).map((c) => ({ ...c, ...(memberPresence[c.id] ?? {}), id: id + "/" + c.id })));
seedReceipts(store, m, membersOf); // sent messages with per-recipient receipts (Message info)
const original = new Map<string, string>(chats.map((c) => [c.id, c.name]));
const events: Record<string, { kind: "linked" | "unlinked" | "signed-out"; time: string }[]> = {};
const offlineOf = (c: Chat) => { const a = accounts.find((x) => x.id === c.accountId); return a?.state === "signed-out" ? { offline: "signed-out" as const, readOnly: true } : a?.state === "needs-login" && a.everLinked ? { offline: "needs-login" as const, readOnly: true } : {}; };
let retentionDays = 0;
/** The merged row of every merge (member chats stay in the list, flagged `mergedInto`). */
function withMerges(list: Chat[]): Chat[] {
  if (!merges.size) return list;
  const out = list.map((c) => (mergeOfChat(c.id) ? { ...c, mergedInto: mergeOfChat(c.id) } : c));
  for (const mg of merges.values()) {
    const have = mg.members.map((id) => out.find((c) => c.id === id)).filter((c): c is Chat => !!c);
    if (!have.length) continue;
    const primary = have.find((c) => c.id === mg.primary) ?? have[0];
    const newest = have.reduce((a, b) => ((b.lastMessageAt ?? "") > (a.lastMessageAt ?? "") ? b : a));
    const unread = have.reduce((n, c) => n + (c.unread ?? 0), 0), def = mg.name ?? primary.name;
    original.set(mg.id, def);
    out.push(withAlias({ id: mg.id, accountId: "", provider: "merged", kind: "dm", name: def, avatarUrl: primary.avatarUrl, ...(unread ? { unread } : {}), lastMessageAt: newest.lastMessageAt, preview: newest.preview,
      mergeMembers: [primary.id, ...have.filter((c) => c !== primary).map((c) => c.id)], ...(mg.sendVia && mg.members.includes(mg.sendVia) ? { mergeSendVia: mg.sendVia } : {}), mergeLastVia: lastViaOf(mg) ?? newest.id,
      ...(have.every((c) => c.offline) ? { offline: "signed-out" as const, readOnly: true } : {}) }));
  }
  return out;
}
let showPresence = true;
const withAlias = (c: Chat): Chat => ({ ...c, ...(showPresence && c.kind === "dm" && presenceOf[c.id] ? presenceOf[c.id] : {}), ...offlineOf(c), ...(aliases[c.id] ? { name: aliases[c.id], originalName: original.get(c.id) ?? c.name } : {}), ...(flags[c.id] ?? {}), ...(flags[c.id]?.unreadMark && !c.unread ? { unread: 1, unreadApprox: true } : {}) });

type L = (ev: string, data: any) => void;
export function mockTransport() {
  const ls = new Set<L>();
  // like the Hub: events of a chat that belongs to a merge also carry `mergeId` (chatId stays the real chat)
  const emit: L = (e, d) => { const mid = d && typeof d === "object" ? mergeOfChat(d.chatId) : undefined; ls.forEach((l) => l(e, mid ? { ...d, mergeId: mid } : d)); };
  const later = (f: () => void, ms: number) => void setTimeout(f, ms);
  const captchaWait = new Map<string, (t: string) => void>();
  const find = (chatId: string, id: string) => store[chatId]?.find((x) => x.id === id);
  const touch = (chatId: string, msg: Message) => { const c = chats.find((x) => x.id === chatId); if (c) { c.lastMessageAt = msg.time; c.preview = msg.text || (msg.location ? "Location" : msg.contacts ? "Contact" : "Attachment"); } };

  // test hook: deliver a live incoming message into any chat (used by the e2e tests)
  (globalThis as any).__mockInject = (chatId: string, sender: string, text: string) => { const x = m(chatId, sender, text, 0); touch(chatId, x); const c = chats.find((y) => y.id === chatId); if (c) c.unread = (c.unread ?? 0) + 1; emit("message", x); return x; };
  // test hooks: a chat's timer / an incoming message that carries one (like a connector reporting Chat.disappearing / Message.expiresIn)
  (globalThis as any).__mockSetChat = (chatId: string, patch: object) => { const c = chats.find((y) => y.id === chatId); if (c) Object.assign(c, patch); emit("chats-changed", { chatId }); };
  (globalThis as any).__mockInjectExp = (chatId: string, sender: string, text: string, expiresIn: number) => { const x = m(chatId, sender, text, 0); x.expiresIn = expiresIn; touch(chatId, x); emit("message", x); return x; };
  // test hook: a contact's presence changed (like a connector's `presence` event after the Hub made the chat id global)
  (globalThis as any).__mockPresence = (chatId: string, online: boolean, lastSeen?: string) => { presenceOf[chatId] = { online, ...(lastSeen ? { lastSeen } : {}) }; const c = chats.find((x) => x.id === chatId); emit("presence", { accountId: c?.accountId ?? "", chatId, contactId: chatId.split(":").slice(1).join(":"), online, ...(lastSeen ? { lastSeen } : {}) }); };
  (globalThis as any).__mockEmit = emit; // test hook: fire any event
  installMatrixVerifyHooks(emit);
  (globalThis as any).__mockReceipt = (chatId: string, messageId: string, by: string, status: "delivered" | "read", at?: string) => recordReceipt(store, emit, chatId, messageId, by, status, at); // test hook: a recipient got / read my message
  (globalThis as any).__mockCall = (m: string, p?: object) => self.call(m, p); // test hook: call any RPC directly
  (globalThis as any).__mockProviders = providers;
  // test hook: change an account's effective capabilities live (like a connector whose mode changed) and announce it
  (globalThis as any).__mockSetCaps = (id: string, patch: object) => { const a = accounts.find((x) => x.id === id)!; a.capabilities = { ...(a.capabilities ?? providers.find((p) => p.name === a.provider)!.capabilities), ...patch } as any; emit("account", { id, state: a.state, capabilities: a.capabilities }); };
  // test hook: this account is used through another of the user's devices. kind: relay (online), offline, ask, denied; null = ordinary again
  const viaSaved: Record<string, Account["state"]> = {};
  (globalThis as any).__mockRelay = (id: string, kind: "relay" | "offline" | "ask" | "denied" | null, device = "MSLaptop") => {
    const a = accounts.find((x) => x.id === id)!; if (!(id in viaSaved)) viaSaved[id] = a.state;
    if (!kind) { a.state = viaSaved[id]; delete viaSaved[id]; delete a.via; }
    else { a.via = { kind, device, deviceId: "dev-a" }; a.state = kind === "relay" ? "connected" : kind === "offline" ? "disconnected" : "signed-out"; }
    emit("account", { id, state: a.state, via: a.via ?? null }); emit("chats-changed", { accountId: id });
  };
  // test hooks: a scheduled message is waiting for the other device / is too late (what the backend's job handler reports)
  (globalThis as any).__mockJobState = (n: number, state: "waiting" | "late" | "aborted", device = "MSLaptop") => {
    const j = ((globalThis as any).__jobs ?? [])[n]; if (!j) return;
    if (state === "waiting") { j.payload.waiting = true; j.lastError = `Waiting for ${device} to come online`; j.status = "pending"; }
    else { j.status = "failed"; delete j.payload.waiting; j.payload[state] = true; j.lastError = state === "late" ? "This message was due on 14 Nov 2026, 09:00 but could not be sent within 24 hours, so it was not sent. Send it now or delete it." : `${device} doesn't allow sending as this account. Nothing was sent.`; }
    emit("job", j);
  };
  later(() => emit("typing", { chatId: "wa-1:anna", senderId: "Anna", typing: true }), 2500);
  later(() => { emit("typing", { chatId: "wa-1:anna", senderId: "Anna", typing: false });
    const x = m("wa-1:anna", "Anna Becker", "Also: bring snacks 🥨", 0); touch("wa-1:anna", x); emit("message", x); }, 5000);

  function connect(id: string, provider: string, label: string) {
    const a = accounts.find((x) => x.id === id)!; a.state = "connected"; a.label = label;
    const n = id.split("-")[1];
    const p = providers.find((x) => x.name === provider)!;
    const who = provider === "signal" ? ["Maya", "Ola", "Jonas"] : ["Sam", "Priya", "Luca"];
    who.forEach((w, i) => { const cid = `${id}:${w.toLowerCase()}`; chats.push(mk(cid, provider, id, w, "dm", { unread: i === 0 ? 1 : 0 }));
      const x = m(cid, w, `Hi! Message via ${p.displayName} #${n} 👋`, 20 - i); touch(cid, x); });
    chats.push(mk(`${id}:grp`, provider, id, provider === "signal" ? "Berlin Friends" : "Project Chat", "group"));
    m(`${id}:grp`, who[1], "Who's in for Friday?", 30);
    if (p.capabilities.spaces) {
      spaces.push({ id: `${id}:space`, accountId: id, provider, name: provider === "matrix" ? "Matrix HQ" : "Neighbourhood" });
      chats.push(mk(`${id}:space-general`, provider, id, "general", "channel", { spaceId: `${id}:space`, unread: 3 }), mk(`${id}:space-random`, provider, id, "random", "channel", { spaceId: `${id}:space` }));
      m(`${id}:space-general`, who[0], "Welcome to the community!", 60);
    }
    for (let k = 0; k < 6; k++) { const hm = m(`${id}:${who[0].toLowerCase()}`, who[0], `History message ${k}`, 5000 + k, { historical: true } as Partial<Message>); emit("message", hm); }
    emit("account", { id, state: "connected" }); emit("chats-changed", { accountId: id }); emit("spaces-changed", {});
  }

  const categories = new Categories(() => ({ getSetting: (k) => catSettings.get(k), setSetting: (k, v) => void catSettings.set(k, v) }), emit, async () => { const sn = await self.call("snapshot"); return { spaces: sn.spaces.map((x: Space) => x.id), chats: sn.chats }; });
  const self = {
    async call(method: string, p: any = {}): Promise<any> {
      await new Promise((r) => setTimeout(r, 30));
      if (mockBackupHandles(method)) return mockBackupCall(method, p, emit);
      if (mockUpdateHandles(method)) return mockUpdateCall(method, p, emit);
      if (mockSafHandles(method)) return mockSafCall(method, p, emit);
      if (mockSignalImportHandles(method)) return mockSignalImportCall(method, p, emit, accounts); // Signal history import mock
      if (mockWhatsAppImportHandles(method)) return mockWhatsAppImportCall(method, p, emit); // WhatsApp history import mock
      if (mockSyncHandles(method)) return mockSyncCall(method, p, emit); // device sync mock
      if (mockMatrixVerifyHandles(method)) return mockMatrixVerifyCall(method, p, accounts);
      if (mockExtraHandles(method)) return mockExtraCall(method, p, { store, chats, accounts, merges, emit, snapshot: () => self.call("snapshot") });
      if (isMerge(p.chatId)) { // a call addressed to a merged chat: find the member that owns the target (like the Hub)
        const mg = merges.get(p.chatId);
        if (!mg) throw new Error("This merged chat no longer exists.");
        const target = () => (p.via && mg.members.includes(p.via) ? p.via : mg.sendVia && mg.members.includes(mg.sendVia) ? mg.sendVia : lastViaOf(mg) ?? mg.primary);
        if (["attachment", "react", "pin", "edit", "delete", "vote", "editEvent"].includes(method)) { const o = mg.members.find((c) => find(c, p.messageId)); if (!o) throw new Error("That message is not part of this merged chat."); p = { ...p, chatId: o }; }
        else if (["send", "scheduleMessage", "setTyping", "refreshChat"].includes(method)) p = { ...p, chatId: target() };
      }
      if (method === "forward" && isMerge(p.toChatId)) { const mg = merges.get(p.toChatId)!; p = { ...p, toChatId: p.via ?? (mg.sendVia && mg.members.includes(mg.sendVia) ? mg.sendVia : lastViaOf(mg) ?? mg.primary) }; }
      switch (method) {
        case "merges": return [...merges.values()];
        case "mergeChats": {
          const ids: string[] = [...new Set<string>(p.chatIds)]; const mids = ids.filter(isMerge), plain = ids.filter((i) => !isMerge(i));
          for (const id of plain) { const c = chats.find((x) => x.id === id); if (!c) throw new Error("One of these chats doesn't exist (any more)."); if (c.kind !== "dm") throw new Error(`“${c.name}” isn't a 1:1 chat. Only direct messages can be merged.`);
            const o = mergeOfChat(id); if (o && !mids.includes(o)) throw new Error(`“${c.name}” is already part of a merged chat. Unmerge it first.`); }
          const members = [...new Set([...mids.flatMap((i) => merges.get(i)!.members), ...plain])]; if (members.length < 2) throw new Error("Pick at least two different chats to merge.");
          const mg: ChatMerge = mids.length ? merges.get(mids[0])! : { id: "merge:" + ++seq, members: [], primary: plain[0], createdAt: new Date().toISOString() };
          mg.members = members; if (p.name?.trim()) mg.name = p.name.trim(); for (const x of mids.slice(1)) merges.delete(x); merges.set(mg.id, mg);
          emit("chats-changed", { mergeId: mg.id }); return withMerges(chats.map(withAlias)).find((c) => c.id === mg.id); }
        case "addMergeMember": return self.call("mergeChats", { chatIds: [p.mergeId, p.chatId] });
        case "unmergeChat": { merges.delete(p.mergeId); delete aliases[p.mergeId]; delete flags[p.mergeId]; delete chatFolders[p.mergeId]; emit("chats-changed", { mergeId: p.mergeId }); return {}; }
        case "removeMergeMember": { const mg = merges.get(p.mergeId); if (!mg) return {}; const rest = mg.members.filter((c) => c !== p.chatId);
          if (rest.length < 2) merges.delete(mg.id); else { mg.members = rest; if (mg.primary === p.chatId) mg.primary = rest[0]; if (mg.sendVia === p.chatId) delete mg.sendVia; } emit("chats-changed", { mergeId: p.mergeId }); return {}; }
        case "setMergePrimary": { const mg = merges.get(p.mergeId); if (mg && mg.members.includes(p.chatId)) mg.primary = p.chatId; emit("chats-changed", { mergeId: p.mergeId }); return {}; }
        case "setMergeVia": { const mg = merges.get(p.mergeId); if (mg) { if (p.chatId) mg.sendVia = p.chatId; else delete mg.sendVia; } emit("chats-changed", { mergeId: p.mergeId, quiet: true }); return {}; }
        case "mergeSuggestions": {
          const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
          const base = isMerge(p.chatId) ? merges.get(p.chatId)!.members : [p.chatId]; const names = new Set(base.map((id) => norm(chats.find((c) => c.id === id)?.name ?? "")));
          const handleOf = (c: Chat) => (c.provider === "matrix" ? c.id.split(":").slice(1).join(":").replace(/^@/, "").split(":")[0] : "");
          const handles = new Set(base.map((id) => handleOf(chats.find((c) => c.id === id)!)).filter(Boolean));
          return chats.filter((c) => c.kind === "dm" && !base.includes(c.id) && !mergeOfChat(c.id)).flatMap((c) => handles.size && handles.has(handleOf(c)) ? [{ chatId: c.id, reason: "same handle" }] : names.has(norm(c.name)) ? [{ chatId: c.id, reason: "same name" }] : []); }
        case "providers": return providers;
        case "pendingLogins": return [];
        case "accounts": return accounts;
        case "snapshot": { if (typeof location !== "undefined") { const n = Number(new URLSearchParams(location.search).get("failsnap")) || 0, g = globalThis as any; if ((g.__failSnap ??= 0) < n) { g.__failSnap++; throw new Error("The backend did not answer (timeout)"); } } // test hook ?failsnap=N: the first N chat-list calls fail like a backend that is still starting
          if (typeof location !== "undefined" && location.search.includes("slowlist") && !(globalThis as any).__slowListDone) { (globalThis as any).__slowListDone = true; await new Promise((r) => setTimeout(r, 2500)); } // test hook: the first chat list arrives late
          const sp0 = spaces.map((s) => ({ ...s, ...(aliases[s.id] ? { name: aliases[s.id], originalName: original.get(s.id) ?? s.name } : {}), ...(flags[s.id]?.muted ? { muted: true } : {}), ...(flags[s.id]?.archived ? { archived: true } : {}) }));
          const r = applyFolders({ spaces: sp0, chats: withMerges(chats.map(withAlias)), folders, overrides: chatFolders, order: railOrder, collapseSingle, flags });
          const cst = categories.state(), have = new Set(r.spaces.map((x) => x.id)).add(PERSONAL), cats = Object.fromEntries(Object.entries(cst.categories).filter(([k]) => have.has(k)));
          return { merges: [...merges.values()], spaces: r.spaces, chats: applyCategories(r.chats, { categories: cats, chatCategory: cst.chatCategory }), categories: cats, accounts: accounts.map((a) => ({ ...a })) }; }
        case "categories": return categories.get();
        case "createCategory": return categories.create(p);
        case "updateCategory": return categories.update(p);
        case "deleteCategory": return categories.delete(p.id);
        case "setChatCategory": { const f = ((globalThis as any).__failCats as Set<string> | undefined); if (f && (p.chatIds ?? []).some((i: string) => f.has(i))) throw new Error("Simulated failure (test hook)");
          return categories.setChat({ chatIds: p.chatIds ?? (p.chatId ? [p.chatId] : []), categoryId: p.categoryId ?? null }); }
        case "setCategoryOrder": return categories.setOrder(p);
        case "getSettings": return { retentionDays, collapseSingleChatCommunities: collapseSingle, showPresence };
        case "setSetting": if (p.key === "showPresence") { showPresence = !!p.value; emit("chats-changed", {}); return; } if (p.key === "collapseSingleChatCommunities") { collapseSingle = !!p.value; emit("chats-changed", {}); emit("spaces-changed", {}); return; } retentionDays = Number(p.value) || 0; return;
        case "folders": return folders.map((f) => ({ ...f }));
        case "createFolder": { const name = String(p.name ?? "").trim(); if (!name) throw new Error("Give the folder a name.");
          const f: Folder = { id: "folder:" + ++seq, name, ...(p.color ? { color: p.color } : {}), ...(p.icon ? { icon: p.icon } : {}) }; folders.push(f);
          railOrder = [...new Set([...railOrder, ...(await self.call("snapshot")).spaces.map((x: Space) => x.id)])]; emit("spaces-changed", {}); emit("chats-changed", {}); return f; }
        case "updateFolder": { const f = folders.find((x) => x.id === p.id); if (!f) throw new Error("That folder no longer exists.");
          if (p.name !== undefined) { if (!String(p.name).trim()) throw new Error("Give the folder a name."); f.name = String(p.name).trim(); }
          if (p.color !== undefined) { if (p.color) f.color = p.color; else delete f.color; } if (p.icon !== undefined) { if (p.icon) f.icon = p.icon; else delete f.icon; }
          emit("spaces-changed", {}); return { ...f }; }
        case "deleteFolder": { const i = folders.findIndex((x) => x.id === p.id); if (i < 0) throw new Error("That folder no longer exists.");
          folders.splice(i, 1); for (const [c, f] of Object.entries(chatFolders)) if (f === p.id) delete chatFolders[c]; delete flags[p.id]; railOrder = railOrder.filter((x) => x !== p.id); await categories.reconcile();
          emit("spaces-changed", {}); emit("chats-changed", {}); return; }
        case "moveChat": { if (((globalThis as any).__failMoves as Set<string> | undefined)?.has(p.chatId)) throw new Error("Simulated failure (test hook)"); const t = mergeOfChat(p.chatId) ?? p.chatId; const to: string | null = p.folderId ?? null;
          if (to !== null && to !== PERSONAL && !(isFolderId(to) ? folders.some((f) => f.id === to) : spaces.some((x) => x.id === to))) throw new Error("That folder or community no longer exists.");
          if (to) chatFolders[t] = to; else delete chatFolders[t]; await categories.reconcile([t]); emit("chats-changed", { chatId: t }); emit("spaces-changed", {}); return; }
        case "railGroups": return normalizeRailGroups(railGroups, (await self.call("snapshot")).spaces.map((x: Space) => x.id));
        case "setRailGroups": { railGroups = normalizeRailGroups(p.groups, (await self.call("snapshot")).spaces.map((x: Space) => x.id), true); emit("spaces-changed", {}); return railGroups; }
        case "setRailOrder": railOrder = (p.ids ?? []).map(String); emit("spaces-changed", {}); return;
        case "search": { if (isMerge(p.chatId)) { const mg = merges.get(p.chatId)!; const q = String(p.q).toLowerCase();
            return mg.members.flatMap((c) => (store[c] ?? []).filter((x) => !x.deleted && [x.text, ...(x.attachments ?? []).map((a) => a.name ?? ""), x.location?.name, x.card?.title].filter(Boolean).join("\n").toLowerCase().includes(q))).sort(cmpMsg).slice(-(p.limit ?? 50)).map((x) => ({ ...x, mergeId: mg.id })); }
          const q = String(p.q).toLowerCase(); const hay = (x: Message) => [x.text, ...(x.attachments ?? []).map((a) => a.name ?? ""), x.poll?.question, ...(x.poll?.options.map((o) => o.text) ?? []), x.location?.name, ...(x.contacts?.map((c) => c.name) ?? []), x.card?.title, x.card?.body].filter(Boolean).join("\n").toLowerCase();
          return (store[p.chatId] ?? []).filter((x) => !x.deleted && hay(x).includes(q)).slice(-(p.limit ?? 50)); }
        case "signOut": { const a = accounts.find((x) => x.id === p.accountId)!; a.state = "signed-out"; a.signedOutAt = new Date().toISOString();
          (events[a.id] ??= []).push({ kind: "signed-out", time: a.signedOutAt }); emit("account", { id: a.id, state: "signed-out" }); emit("chats-changed", { accountId: a.id }); return a; }
        case "signIn": { const a = accounts.find((x) => x.id === p.accountId)!; a.state = "connecting";
          later(() => emit("login", { accountId: a.id, promptId: "relink", kind: "qr", payload: `https://${a.provider}.link/relink-${Date.now()}`, hint: "Scan with your phone to sign in again" }), 200);
          later(() => { if (a.state !== "connecting") return; a.state = "connected"; (events[a.id] ??= []).push({ kind: "linked", time: new Date().toISOString() }); emit("account", { id: a.id, state: "connected" }); emit("chats-changed", { accountId: a.id }); }, 5000); return a; }
        case "cancelSignIn": { const a = accounts.find((x) => x.id === p.accountId)!; a.state = "signed-out"; emit("account", { id: a.id, state: "signed-out" }); return a; }
        case "chatMedia": {
          if ((globalThis as any).__mockNoChatMedia) throw new Error("unknown method chatMedia"); // test hook: an older backend
          // paged like the real backend: newest first, `kinds` (media / files / voice / links), `before` = cursor of the previous page, `count` on the first page
          const ids = isMerge(p.chatId) ? merges.get(p.chatId)?.members ?? [] : [p.chatId], all = ids.flatMap((c) => store[c] ?? []).filter((x) => !x.deleted);
          { const d = (globalThis as any).__mockSlowChatMedia; if (d && p.before === undefined) await new Promise((r) => setTimeout(r, d)); } // test hook (ms)
          const KINDS = ["media", "files", "voice", "links"], kinds: string[] = (Array.isArray(p.kinds) ? p.kinds : ["media", "files"]).filter((k: string) => KINDS.includes(k));
          const kindsOf = (x: Message) => { const k = new Set<string>(); for (const a of x.attachments ?? []) k.add(a.kind === "image" || a.kind === "video" ? "media" : a.kind === "file" ? "files" : a.kind === "voice" || a.kind === "audio" ? "voice" : ""); if (/https?:\/\/\S+/i.test(x.text ?? "") || (x.cards ?? (x.card ? [x.card] : [])).some((c) => c.url)) k.add("links"); k.delete(""); return [...k]; };
          const key = (x: Message) => `${x.time}\u0000${x.chatId}\u0000${x.id}`, want = Math.min(200, Math.max(1, Number(p.limit) || 60));
          const hits = all.filter((x) => kindsOf(x).some((k) => kinds.includes(k))).sort((a, b) => (key(a) < key(b) ? 1 : -1)).filter((x) => !p.before || key(x) < p.before);
          const page = hits.slice(0, want), first = !p.before;
          const count = { media: 0, files: 0, voice: 0, links: 0 } as Record<string, number>;
          if (first) for (const x of all) { for (const a of x.attachments ?? []) { const k = a.kind === "image" || a.kind === "video" ? "media" : a.kind === "file" ? "files" : a.kind === "voice" || a.kind === "audio" ? "voice" : ""; if (k) count[k]++; } if (kindsOf(x).includes("links")) count.links++; }
          return { messages: page, places: first ? all.filter((x) => x.location).length : undefined, ...(first ? { count } : {}), next: hits.length > want ? key(page[page.length - 1]!) : undefined };
        }
        case "history": {
          { const d = (globalThis as any).__mockSlowHistory; if (d && !p.local && !p.beforeMessageId) await new Promise((r) => setTimeout(r, d)); } // test hook: a source that is slow to answer (ms); `local` reads only the archive
          if (isMerge(p.chatId)) { // unified timeline: the members' stores interleaved by time, paged by (time, id)
            const mg = merges.get(p.chatId)!; const all = mg.members.flatMap((c) => store[c] ?? []).sort(cmpMsg); let end = all.length;
            if (p.beforeMessageId) { const i = all.findIndex((x) => x.id === p.beforeMessageId && (!p.beforeChatId || x.chatId === p.beforeChatId)); if (i >= 0) end = i; }
            const marks: Message[] = p.beforeMessageId ? [] : [...new Set(mg.members.map((c) => chats.find((x) => x.id === c)?.accountId))].flatMap((acc) => (events[acc ?? ""] ?? []).map((e, i) => ({ id: `sys-${acc}-${i}`, chatId: mg.members.find((c) => c.startsWith(acc + ":"))!, sender: "", senderId: "", fromMe: false, time: e.time, system: { kind: e.kind },
              text: `${accounts.find((a) => a.id === acc)?.label}: ` + (e.kind === "signed-out" ? "You signed out. Your chats stay here as a read-only archive." : "Signed in again. Messages in between may be missing.") })));
            return [...all.slice(Math.max(0, end - (p.limit ?? 100)), end), ...marks].sort(cmpMsg).map((x) => ({ ...x, mergeId: mg.id })); }
          if (p.chatId === "mx-1:!self-gen" && !p.beforeMessageId) await new Promise((r) => setTimeout(r, 1800)); // a slow provider
          if (p.chatId === "mx-1:!rust-help" && !(globalThis as any).__helpOk) { (globalThis as any).__helpOk = true; throw new Error("The server didn't answer in time (simulated)"); } // fails once
          const all0 = store[p.chatId] ?? [];
          const acc = chats.find((c) => c.id === p.chatId)?.accountId; const evs = (acc && events[acc]) || [];
          const marks: Message[] = p.beforeMessageId ? [] : evs.map((e, i) => ({ id: `sys-${acc}-${i}`, chatId: p.chatId, sender: "", senderId: "", fromMe: false, time: e.time, system: { kind: e.kind },
            text: e.kind === "signed-out" ? "You signed out. Your chats stay here as a read-only archive." : `Signed in again. Messages from ${new Date(evs[i - 1]?.time ?? e.time).toLocaleString("en-GB")} to ${new Date(e.time).toLocaleString("en-GB")} may be missing.` }));
          const all = marks.length ? [...all0, ...marks].sort((a, b) => a.time.localeCompare(b.time)) : all0; let end = all.length; if (p.beforeMessageId) { const i = all.findIndex((x) => x.id === p.beforeMessageId); if (i >= 0) end = i; } return all.slice(Math.max(0, end - (p.limit ?? 100)), end); }
        case "syncAccount": { const a = accounts.find((x) => x.id === p.accountId); if (a) later(() => emit("chats-changed", { accountId: a.id }), 300); return; }
        case "setDisappearing": {
          const c = chats.find((x) => x.id === p.chatId); if (!c) throw new Error("unknown chat"); const s = Number(p.seconds);
          if (c.id === "wa-1:ben" && (globalThis as any).__mockDisFail) throw new Error("You are not allowed to change this (simulated)");
          c.disappearing = s > 0 ? s : undefined;
          const x: Message = { id: "dis-" + Date.now(), chatId: c.id, sender: "Me", senderId: "me", fromMe: true, time: new Date().toISOString(), system: { kind: "info" }, text: s > 0 ? `Disappearing messages: ${s === 86400 ? "24 hours" : s === 604800 ? "7 days" : s + " seconds"}` : "Disappearing messages turned off" };
          (store[c.id] ??= []).push(x); emit("message", x); emit("chats-changed", { chatId: c.id }); return; }
        case "setChatDescription": { const c = chats.find((x) => x.id === p.chatId); if (c) c.description = String(p.text ?? "") || undefined; emit("chats-changed", { chatId: p.chatId }); return; }
        case "setChatPicture": { chatPics.set(p.chatId, p.dataBase64 ? { dataBase64: p.dataBase64, mime: p.mime } : null); emit("chats-changed", { chatId: p.chatId }); return; }
        case "avatar": { if (isMerge(p.id)) { const mg = merges.get(p.id); return mg ? self.call("avatar", { kind: p.kind, id: mg.primary }) : null; }
          if (p.kind === "chat" && chatPics.has(p.id)) return chatPics.get(p.id); if (p.kind === "contact") { const nm = String(p.id).split(":").pop()!.split("/").pop()!; return { dataBase64: b64(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#6b7cff"/><circle cx="48" cy="38" r="18" fill="#fff9"/><rect x="18" y="62" width="60" height="40" rx="20" fill="#fff9"/><text x="48" y="90" font-size="14" text-anchor="middle" fill="#fff" font-family="sans-serif">${nm.slice(0, 2)}</text></svg>`), mime: "image/svg+xml" }; }
          const withPic = ["wa-1:anna", "wa-1:hike", "mx-1:!rust", "wa-1:family"]; if (!withPic.includes(p.id)) return null;
          const lab = (original.get(p.id) ?? chats.find((c) => c.id === p.id)?.name ?? spaces.find((s) => s.id === p.id)?.name ?? "?").slice(0, 1);
          const col = { "wa-1:anna": "#eb459e", "wa-1:hike": "#23a559", "mx-1:!rust": "#e67e22", "wa-1:family": "#3a76f0" }[p.id as string] ?? "#888";
          return { dataBase64: b64(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${col}"/><circle cx="48" cy="38" r="18" fill="#fff8"/><rect x="18" y="62" width="60" height="40" rx="20" fill="#fff8"/><text x="48" y="90" font-size="14" text-anchor="middle" fill="#fff" font-family="sans-serif">${lab}</text></svg>`), mime: "image/svg+xml" }; }
        case "getProfile": { const a = accounts.find((x) => x.id === p.accountId)!; return (profiles[a.id] ??= { displayName: a.provider === "matrix" ? "Michi" : "Michi S.", about: a.provider === "whatsapp" ? "Busy hiking" : undefined, handle: a.provider === "matrix" ? "@michi:matrix.org" : "+49 151 2345", avatar: null }); }
        case "updateProfile": { const a = accounts.find((x) => x.id === p.accountId)!; const cur = (profiles[a.id] ??= { avatar: null });
          if (p.displayName !== undefined) cur.displayName = p.displayName; if (p.about !== undefined) cur.about = p.about; if (p.avatar !== undefined) cur.avatar = p.avatar; return cur; }
        case "getPrivacy": return privacyOf(p.accountId);
        case "setPrivacy": { const list = privacyOf(p.accountId); const s = list.find((x) => x.id === p.id); if (s) s.value = p.value; return list; }
        case "editEvent": { const x = find(p.chatId, p.messageId); if (x?.card) { const v = p.patch ?? {}; x.card = { ...x.card, ...(v.name ? { title: v.name } : {}), ...(v.description !== undefined ? { body: v.description } : {}), ...(v.start ? { when: v.start } : {}), ...(v.end ? { until: v.end } : {}), ...(v.place !== undefined ? { place: v.place } : {}) };
            emit("message-update", { chatId: p.chatId, messageId: x.id, patch: { card: x.card } }); } return; }
        case "sendJobNow": { const j = ((globalThis as any).__jobs ?? []).find((x: any) => x.id === p.id && x.status === "failed"); if (!j) throw new Error("That message is not waiting for a decision."); j.status = "done"; emit("job", j); return true; }
        case "discardJob": { const j = ((globalThis as any).__jobs ?? []).find((x: any) => x.id === p.id && x.status === "failed"); if (!j) return false; j.status = "done"; emit("job", j); return true; }
        case "scheduleMessage": { const j = { id: "job" + ++seq, kind: "send", runAt: p.at, status: "pending", attempts: 0, maxAttempts: 6, payload: { chatId: p.chatId, text: p.text, clientId: "mockclient" + seq, due: p.at } }; (globalThis as any).__jobs = [...((globalThis as any).__jobs ?? []), j]; return j; }
        case "jobs": return ((globalThis as any).__jobs ?? []).filter((j: any) => !p.status || j.status === p.status);
        case "cancelJob": { (globalThis as any).__jobs = ((globalThis as any).__jobs ?? []).filter((j: any) => j.id !== p.id); return true; }
        case "refreshChat": { await new Promise((r) => setTimeout(r, 300)); return { message: "Asked your phone to resend 1 message" }; }
        case "setChatFlags": { const f = { pinned: !!p.pinned, muted: !!p.muted, archived: !!p.archived, unreadMark: !!p.unreadMark }; if (f.pinned || f.muted || f.archived || f.unreadMark) flags[p.chatId] = f; else delete flags[p.chatId]; emit("chats-changed", { chatId: p.chatId }); return; }
        case "leaveSpace": { const i = spaces.findIndex((x) => x.id === p.spaceId); if (i >= 0) spaces.splice(i, 1); for (let k = chats.length - 1; k >= 0; k--) if (chats[k].spaceId === p.spaceId) chats.splice(k, 1); emit("spaces-changed", {}); emit("chats-changed", {}); return; }
        case "vote": { const x = find(p.chatId, p.messageId); if (!x?.poll) return; const ids = new Set<string>(p.optionIds ?? []);
          x.poll = { ...x.poll, mine: [...ids], options: x.poll.options.map((o) => ({ ...o, voters: [...o.voters.filter((v) => v !== "You"), ...(ids.has(o.id) ? ["You"] : [])] })) };
          emit("message-update", { chatId: p.chatId, messageId: x.id, patch: { poll: x.poll } }); return; }
        case "leaveChat": { const i = chats.findIndex((x) => x.id === p.chatId); if (i >= 0) chats.splice(i, 1); emit("chats-changed", {}); return; }
        case "addMembers": { const arr = membersOf(p.chatId); for (const h of p.handles) arr.push({ id: p.chatId + "/" + h, name: h.replace(/^@|:.*$/g, ""), handle: h }); emit("chats-changed", { chatId: p.chatId }); return; }
        case "removeMember": { groupMembers[p.chatId] = membersOf(p.chatId).filter((m) => m.id !== p.memberId); emit("chats-changed", { chatId: p.chatId }); return; }
        case "renameChat": { const c = chats.find((x) => x.id === p.chatId); if (c) { c.name = p.name; original.set(c.id, p.name); } emit("chats-changed", { chatId: p.chatId }); return; }
        case "blockChat": { const c = chats.find((x) => x.id === p.chatId); if (c) c.blocked = !!p.blocked; emit("chats-changed", { chatId: p.chatId }); return; }
        case "setAlias": { const n = (p.name ?? "").trim(); if (n) aliases[p.chatId] = n; else delete aliases[p.chatId]; emit("chats-changed", { chatId: p.chatId }); return; }
        case "commonChats": { const gs = chats.filter((c: Chat) => c.kind === "group" && !c.mergedInto).slice(0, 2); return { groups: gs, communities: spaces.filter((s) => s.id === "wa-1:hike" || s.id === "mx-1:!self") }; } // communities you share: from the network, not only from the shared groups
        case "members": { if (isMerge(p.chatId)) return (await Promise.all(merges.get(p.chatId)!.members.map(async (cid) => (await self.call("members", { chatId: cid })).map((x: Contact) => ({ ...x, chatId: cid }))))).flat();
          const c = chats.find((x) => x.id === p.chatId);
          if (c?.kind === "dm") return [{ id: c.id, name: c.name, handle: c.provider === "matrix" ? c.id.split(":").slice(1).join(":") : "+49 151 " + (1000 + (c.name.length * 137) % 9000), avatarUrl: undefined }];
          return membersOf(p.chatId); }
        case "attachment": { const f = files.get(`${p.messageId}|${p.attachmentId}`) ?? (BIG ? BIG_FILE : undefined); if (!f) throw new Error("attachment expired"); return { dataBase64: f.b64, mime: f.mime, name: f.name }; }
        case "send": {
          { const slow = Number((globalThis as any).__mockSlowSend) || 0; if (slow) await new Promise((r) => setTimeout(r, slow)); } // e2e hook: a slow backend answer
          ((globalThis as any).__mockSendLog ??= []).push(JSON.parse(JSON.stringify({ chatId: p.chatId, text: p.text, clientId: p.clientId })));
          if (accounts.find((a) => String(p.chatId).startsWith(a.id + ":"))?.state === "signed-out") throw new Error("This account is signed out, so this chat is read-only. Sign in again from Settings to continue.");
          { const v = accounts.find((a) => String(p.chatId).startsWith(a.id + ":"))?.via; if (v?.kind === "offline") throw new Error(`${v.device} is offline, so you can't do that now: this account is read-only until it is back.`); }
          if (String(p.text ?? "").startsWith("/fail")) throw new Error("Network unreachable (simulated)");
          const atts: Attachment[] = []; const id = "m" + ++seq;
          for (const a of p.attachments ?? []) { const aid = "att" + ++seq; files.set(`${id}|${aid}`, { b64: a.dataBase64, mime: a.mime, name: a.name });
            atts.push({ id: aid, kind: a.kind, mime: a.mime, name: a.name, size: Math.round(a.dataBase64.length * 0.75), durationMs: a.durationMs, waveform: a.waveform, thumbnailDataUrl: a.kind === "image" ? `data:${a.mime};base64,${a.dataBase64}` : undefined }); }
          const ref = p.replyToMessageId ? find(p.chatId, p.replyToMessageId) : undefined;
          const evCard = p.event ? { kind: "event" as const, title: p.event.name, body: p.event.description, when: p.event.start, until: p.event.end, place: p.event.place, editable: true } : undefined;
          const poll = p.poll ? { question: p.poll.question, multiple: !!p.poll.multiple, mine: [], options: p.poll.options.map((t: string, i: number) => ({ id: "o" + i, text: t, voters: [] as string[] })) } : undefined;
          (globalThis as any).__lastSend = p;
          let target = p.chatId as string; const reqChat = chats.find((c) => c.id === p.chatId);
          if (reqChat?.request) { reqChat.request = false; delete (reqChat as any).unreadApprox; emit("chats-changed", { chatId: reqChat.id }); } // replying accepts a message request
          if (reqChat?.provisional) { // the first message creates the real thread: re-key the chat, like the Hub does
            target = `${reqChat.accountId}:t${++seq}`; const idx = chats.findIndex((c) => c.id === p.chatId);
            chats[idx] = { ...reqChat, id: target, provisional: undefined }; delete (chats[idx] as any).provisional; original.set(target, reqChat.name);
            emit("chat-resolved", { from: p.chatId, to: target, accountId: reqChat.accountId }); emit("chats-changed", { accountId: reqChat.accountId, chatId: target });
          }
          const x: Message = { id, chatId: target, sender: "You", senderId: "You", text: p.text ?? "", time: new Date().toISOString(), fromMe: true, status: "sending", poll, card: evCard,
            attachments: atts.length ? atts : undefined, location: p.location, contacts: p.contacts,
            replyTo: ref ? { messageId: ref.id, sender: ref.sender, textPreview: ref.text.slice(0, 80) || "Attachment" } : undefined };
          (store[target] ??= []).push(x); touch(target, x);
          const set = (status: Message["status"]) => { x.status = status; emit("receipt", { chatId: target, messageId: id, status }); const tc = chats.find((c) => c.id === target); if (tc && status) sendReceipts(store, emit, tc, id, status, tc.kind === "dm" ? [] : membersOf(target)); };
          later(() => set("sent"), 400); later(() => set("delivered"), 1500); later(() => set("read"), 3500);
          return x; }
        case "forward": { const src = p.message as Message;
          const x = m(p.toChatId, "You", src.text, 0, { forwarded: true, status: "sent", location: src.location, contacts: src.contacts, attachments: src.attachments });
          for (const a of src.attachments ?? []) { const f = files.get(`${src.id}|${a.id}`); if (f) files.set(`${x.id}|${a.id}`, f); }
          touch(p.toChatId, x); emit("message", x); return x; }
        case "react": { const x = find(p.chatId, p.messageId); if (!x) return;
          let rs = (x.reactions ?? []).map((r) => ({ ...r, senderIds: r.mine ? r.senderIds.filter((s) => s !== "You") : r.senderIds })).map((r) => (r.mine ? { ...r, mine: false } : r)).filter((r) => r.senderIds.length);
          if (p.emoji) { const e = rs.find((r) => r.emoji === p.emoji); if (e) { e.senderIds = [...e.senderIds, "You"]; e.mine = true; } else rs.push({ emoji: p.emoji, senderIds: ["You"], mine: true }); }
          x.reactions = rs; emit("message-update", { chatId: p.chatId, messageId: x.id, patch: { reactions: rs } }); return; }
        case "pin": { const x = find(p.chatId, p.messageId); if (!x) throw new Error("That message is not in the archive."); if (x.deleted) throw new Error("This message was deleted, so it can no longer be pinned.");
          const pinned = p.pinned !== false, ds = (accounts.find((a) => a.id === chats.find((c) => c.id === p.chatId)?.accountId)?.capabilities ?? providers.find((q) => q.name === chats.find((c) => c.id === p.chatId)?.provider)?.capabilities)?.pinDurations;
          const dur = pinned && ds?.length ? (ds.includes(p.durationSec) ? p.durationSec : 604800) : undefined, now = Date.now();
          const patch = pinned ? { pinned: true, pinnedAt: new Date(now).toISOString(), pinnedBy: "You", ...(dur ? { pinnedUntil: new Date(now + dur * 1000).toISOString() } : {}) } : { pinned: false };
          Object.assign(x, patch); if (!pinned) { delete x.pinnedAt; delete x.pinnedBy; delete x.pinnedUntil; }
          (globalThis as any).__pinCalls = [...((globalThis as any).__pinCalls ?? []), { chatId: p.chatId, messageId: p.messageId, pinned, durationSec: dur }];
          emit("message-update", { chatId: p.chatId, messageId: x.id, patch }); return; }
        case "pins": { const ids = isMerge(p.chatId) ? merges.get(p.chatId)?.members ?? [] : [p.chatId]; const mid = isMerge(p.chatId) ? p.chatId : undefined;
          return ids.flatMap((c) => (store[c] ?? []).filter((x) => x.pinned && !x.deleted)).sort((a, b) => ((a.pinnedAt ?? a.time) < (b.pinnedAt ?? b.time) ? 1 : -1)).map((x) => ({ ...x, ...(mid ? { mergeId: mid } : {}) })); }
        case "edit": { const x = find(p.chatId, p.messageId); if (x) { x.text = p.text; x.editedAt = new Date().toISOString(); emit("message-update", { chatId: p.chatId, messageId: x.id, patch: { text: x.text, editedAt: x.editedAt } }); } return; }
        case "delete": { const x = find(p.chatId, p.messageId); if (x) { x.deleted = true; x.text = ""; x.attachments = undefined; x.card = undefined; x.cards = undefined; x.poll = undefined; x.location = undefined; x.contacts = undefined; x.reactions = []; emit("message-update", { chatId: p.chatId, messageId: x.id, patch: { deleted: true, text: "", attachments: [], cards: [] } }); } return; }
        case "markRead": { if (flags[p.chatId]?.unreadMark) flags[p.chatId] = { ...flags[p.chatId], unreadMark: false }; for (const id of isMerge(p.chatId) ? merges.get(p.chatId)?.members ?? [] : [p.chatId]) { const c = chats.find((x) => x.id === id); if (c) c.unread = 0; } return; }
        case "setTyping": return;
        case "acceptRequest": { const c = chats.find((x) => x.id === p.chatId); if (c) { c.request = false; delete c.unreadApprox; } emit("chats-changed", { chatId: p.chatId }); return; }
        case "declineRequest": { const i = chats.findIndex((x) => x.id === p.chatId); if (i >= 0) chats.splice(i, 1); emit("chats-changed", { chatId: p.chatId }); return; }
        case "startChat": { const a = accounts.find((x) => x.id === p.accountId)!; const name = p.handle.replace(/^@|:.*$/g, "");
          if (a.provider === "instagram") { // Instagram creates the thread only with the first message: a provisional chat that the first send() resolves
            const h = String(p.handle).replace(/^@/, "").toLowerCase(); const ex = chats.find((c) => c.accountId === a.id && c.kind === "dm" && c.name.toLowerCase().includes(h)); if (ex) return ex;
            const pc = mk(`${a.id}:new:${h}`, a.provider, a.id, h.charAt(0).toUpperCase() + h.slice(1), "dm", { provisional: true }); if (!chats.find((x) => x.id === pc.id)) chats.push(pc); emit("chats-changed", { accountId: a.id }); return pc; }
          if (a.provider === "discord" && (globalThis as any).__mockCaptcha) { // e2e: Discord asks for a captcha when you message someone new; the stub modal answers with a fake token
            const pid = `captcha-${++seq}`;
            const tok = await new Promise<string>((ok) => { captchaWait.set(pid, ok); emit("login", { accountId: a.id, promptId: pid, kind: "captcha", service: "hcaptcha", sitekey: "mock-sitekey", rqdata: "mock-rqdata", title: "Discord wants to check that you are human", hint: "Discord asks for this when you message someone new.", link: { href: "https://discord.com/channels/@me", label: "Open Discord instead" } }); });
            (globalThis as any).__captchaToken = tok;
            if (!tok) throw new Error("Discord wants you to solve a captcha before this (it does that when you message someone new). Solve it once in the official Discord app or website, then try again."); }
          const c = mk(`${a.id}:${p.handle}`, a.provider, a.id, /^[+\d\s-]+$/.test(p.handle) ? p.handle : name.charAt(0).toUpperCase() + name.slice(1), "dm"); original.set(c.id, c.name); if (!chats.find((x) => x.id === c.id)) chats.push(c); emit("chats-changed", { accountId: a.id }); return c; }
        case "createGroup": { const a = accounts.find((x) => x.id === p.accountId)!; const c = mk(`${a.id}:g${++seq}`, a.provider, a.id, p.name, "group"); chats.push(c); emit("chats-changed", { accountId: a.id }); return c; }
        case "meshCreate": { const c = mk("mesh:" + ++seq, "mesh", "", p.name, "group"); chats.push(c); emit("chats-changed", {}); return { id: c.id, name: c.name, members: p.members }; }
        case "createSpace": case "joinSpace": { const a = accounts.find((x) => x.id === p.accountId)!; const nm = method === "createSpace" ? p.name : "Joined " + String(p.invite).replace(/^.*[/#]/, "").slice(0, 20);
          const sp: Space = { id: `${a.id}:sp${++seq}`, accountId: a.id, provider: a.provider, name: nm }; spaces.push(sp);
          chats.push(mk(`${a.id}:sp${seq}-general`, a.provider, a.id, "general", "channel", { spaceId: sp.id })); emit("spaces-changed", {}); return sp; }
        case "addAccount": {
          const n = accounts.filter((a) => a.provider === p.provider).length + 1; const id = `${p.provider}-${n}${Math.random() < 0 ? "" : "d"}`;
          const info = providers.find((x) => x.name === p.provider)!;
          accounts.push({ id, provider: p.provider, label: `${info.displayName} account`, state: "needs-login" });
          if (info.login === "qr") {
            later(() => emit("login", { accountId: id, promptId: "qr", kind: "qr", payload: `https://${p.provider}.link/demo-${Date.now()}`, hint: `Open ${info.displayName} on your phone → Linked devices → Link a device` }), 300);
            later(() => connect(id, p.provider, `${info.displayName} · +49 170 ${Math.floor(1000 + Math.random() * 8999)}`), 6000);
          } else if (p.provider === "discord" || p.provider === "instagram") later(() => emit("login", { accountId: id, promptId: "form", kind: "form", title: "Paste your token. It is only used to talk to Discord and is stored on this computer.",
            warning: { severity: "danger", text: "A user-account token breaks Discord's Terms of Service. The account can be suspended or terminated without warning. Use a throw-away account, or a bot token (allowed)." },
            fields: [{ name: "mode", label: "Mode (bot or user)", type: "text", placeholder: "bot" }, { name: "token", label: "Token", type: "password" },
              { name: "confirm", label: "I understand that user mode can get my account banned", type: "checkbox", required: true }] }), 300);
          else later(() => emit("login", { accountId: id, promptId: "form", kind: "form", title: "Sign in to Matrix", fields: [
            { name: "homeserver", label: "Homeserver", type: "text", placeholder: "https://matrix.org" }, { name: "user", label: "Username", type: "text" }, { name: "password", label: "Password", type: "password" }] }), 300);
          return accounts.at(-1); }
        case "submitLogin": { if (String(p.promptId).startsWith("captcha-")) { captchaWait.get(p.promptId)?.(p.values.token ?? ""); captchaWait.delete(p.promptId); return; }
          const a = accounts.find((x) => x.id === p.accountId)!; (globalThis as any).__lastLogin = p.values;
          if (a.provider === "discord" && p.values.confirm !== "true") throw new Error("Please tick the box to confirm.");
          later(() => connect(a.id, a.provider, `@${p.values.user || "me"}:${(p.values.homeserver || "matrix.org").replace(/^https?:\/\//, "")}`), 600); return; }
        case "removeAccount": { if (p.accountId === "mx-1" && (globalThis as any).__failLogout) return { warning: "Couldn't reach Matrix to remove this session. Remove it in Element: Settings > Sessions." }; const i = accounts.findIndex((x) => x.id === p.accountId); if (i >= 0) accounts.splice(i, 1);
          for (const mg of [...merges.values()]) { mg.members = mg.members.filter((c) => !c.startsWith(p.accountId + ":")); if (!mg.members.length) merges.delete(mg.id); else { if (!mg.members.includes(mg.primary)) mg.primary = mg.members[0]; if (mg.sendVia && !mg.members.includes(mg.sendVia)) delete mg.sendVia; later(() => emit("history-updated", { chatId: mg.id, mergeId: mg.id }), 50); } }
          for (const arr of [chats, spaces] as { accountId: string }[][]) for (let k = arr.length - 1; k >= 0; k--) if (arr[k].accountId === p.accountId) arr.splice(k, 1);
          emit("chats-changed", {}); return; }
        case "renameAccount": { const a = accounts.find((x) => x.id === p.accountId); if (a) a.label = p.label; return a; }
      }
      return undefined;
    },
    onEvent(l: L) { ls.add(l); return () => ls.delete(l); },
  };
  return self;
}
