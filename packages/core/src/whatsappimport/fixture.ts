// SYNTHETIC test fixtures for the WhatsApp import: a crypt15/crypt14 file written by our own implementation of the documented container
// (crypt.ts encryptCrypt15) around a small msgstore.db that follows the community-documented schema. Nothing here comes from a real backup.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { crypt14KeyFile, encryptCrypt14, encryptCrypt15 } from "./crypt.js";

export const T0 = 1_700_000_000_000;
export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452" + "00".repeat(40), "hex"), VOICE = Buffer.from("OggS-synthetic-voice");
export const jid = { ME: "4915100000001@s.whatsapp.net", ANNA: "4915111111111@s.whatsapp.net", BOB: "4915122222222@s.whatsapp.net", CARL: "4915133333333@s.whatsapp.net", ANNA_LID: "111222333@lid", GROUP: "120363000000000001@g.us", STATUS: "status@broadcast" };
export const sha64 = (b: Uint8Array) => createHash("sha256").update(b).digest("base64");

const SCHEMA = [
  "CREATE TABLE jid (_id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, server TEXT NOT NULL, agent INTEGER, device INTEGER, type INTEGER, raw_string TEXT)",
  "CREATE TABLE jid_map (_id INTEGER PRIMARY KEY AUTOINCREMENT, lid_row_id INTEGER NOT NULL, jid_row_id INTEGER NOT NULL, sort_id INTEGER)",
  "CREATE TABLE chat (_id INTEGER PRIMARY KEY AUTOINCREMENT, jid_row_id INTEGER UNIQUE, hidden INTEGER, subject TEXT, created_timestamp INTEGER, archived INTEGER, ephemeral_expiration INTEGER)",
  "CREATE TABLE message (_id INTEGER PRIMARY KEY AUTOINCREMENT, chat_row_id INTEGER NOT NULL, from_me INTEGER NOT NULL, key_id TEXT NOT NULL, sender_jid_row_id INTEGER, status INTEGER, broadcast INTEGER, timestamp INTEGER, received_timestamp INTEGER, message_type INTEGER, text_data TEXT, starred INTEGER, sort_id INTEGER)",
  "CREATE TABLE message_media (message_row_id INTEGER PRIMARY KEY, chat_row_id INTEGER, file_path TEXT, file_size INTEGER, mime_type TEXT, media_name TEXT, media_caption TEXT, file_hash TEXT, media_duration INTEGER, width INTEGER, height INTEGER, gif_attribution INTEGER, direct_path TEXT)",
  "CREATE TABLE message_location (message_row_id INTEGER PRIMARY KEY, chat_row_id INTEGER, latitude REAL, longitude REAL, place_name TEXT, place_address TEXT, url TEXT, live_location_share_duration INTEGER)",
  "CREATE TABLE message_vcard (_id INTEGER PRIMARY KEY AUTOINCREMENT, message_row_id INTEGER, vcard TEXT)",
  "CREATE TABLE message_quoted (message_row_id INTEGER PRIMARY KEY, chat_row_id INTEGER, parent_message_chat_row_id INTEGER, from_me INTEGER, sender_jid_row_id INTEGER, key_id TEXT, timestamp INTEGER, message_type INTEGER, text_data TEXT)",
  "CREATE TABLE message_edit_info (message_row_id INTEGER PRIMARY KEY, original_key_id TEXT, edited_timestamp INTEGER, sender_timestamp INTEGER)",
  "CREATE TABLE message_revoked (message_row_id INTEGER PRIMARY KEY, revoked_key_id TEXT, admin_jid_row_id INTEGER, revoke_timestamp INTEGER)",
  "CREATE TABLE message_ephemeral (message_row_id INTEGER PRIMARY KEY, duration INTEGER, expire_timestamp INTEGER, keep_in_chat INTEGER)",
  "CREATE TABLE message_forwarded (message_row_id INTEGER PRIMARY KEY, forward_score INTEGER)",
  "CREATE TABLE message_system (message_row_id INTEGER PRIMARY KEY, action_type INTEGER)",
  "CREATE TABLE call_log (_id INTEGER PRIMARY KEY AUTOINCREMENT, message_row_id INTEGER, call_id TEXT, jid_row_id INTEGER, from_me INTEGER, video_call INTEGER, duration INTEGER, call_result INTEGER, timestamp INTEGER)",
  "CREATE TABLE message_view_once_media (message_row_id INTEGER PRIMARY KEY, state INTEGER)",
  "CREATE TABLE message_add_on (_id INTEGER PRIMARY KEY AUTOINCREMENT, message_row_id INTEGER, sender_jid_row_id INTEGER, from_me INTEGER, timestamp INTEGER, status INTEGER, message_add_on_type INTEGER)",
  "CREATE TABLE message_add_on_reaction (message_add_on_row_id INTEGER PRIMARY KEY, reaction TEXT, sender_timestamp INTEGER)",
  "CREATE TABLE message_poll (message_row_id INTEGER PRIMARY KEY, selectable_options_count INTEGER)",
  "CREATE TABLE message_poll_option (_id INTEGER PRIMARY KEY AUTOINCREMENT, message_row_id INTEGER, option_name TEXT, vote_total INTEGER)",
  "CREATE TABLE message_add_on_poll_vote (message_add_on_row_id INTEGER PRIMARY KEY, sender_timestamp INTEGER)",
  "CREATE TABLE message_add_on_poll_vote_selected_option (_id INTEGER PRIMARY KEY AUTOINCREMENT, message_add_on_row_id INTEGER, message_poll_option_id INTEGER)",
];

export interface SyntheticInfo { dir: string; root: string; file: string; keyHex: string; mediaRoot: string; expect: { messages: number; chats: number; imageHash: string } }
type Db = { exec(s: string): void; prepare(s: string): { run(...a: any[]): { lastInsertRowid: number | bigint } } };

/** Build the synthetic msgstore.db into `dbPath` and the media files under `mediaRoot`. `extra` lets a test change the schema first. */
export async function buildSyntheticDb(dbPath: string, mediaRoot: string, o: { bigN?: number; schema?: (s: string[]) => string[] } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath) as unknown as Db;
  for (const s of (o.schema ? o.schema(SCHEMA) : SCHEMA)) db.exec(s);
  const ins = (t: string, row: Record<string, unknown>) => { const k = Object.keys(row); return Number(db.prepare(`INSERT INTO ${t} (${k.join(",")}) VALUES (${k.map(() => "?").join(",")})`).run(...k.map((c) => row[c] as any)).lastInsertRowid); };
  const J: Record<string, number> = {};
  for (const [k, raw] of Object.entries(jid)) { const [user, server] = raw.split("@"); J[k] = ins("jid", { user, server, raw_string: raw }); }
  ins("jid_map", { lid_row_id: J.ANNA_LID, jid_row_id: J.ANNA, sort_id: 0 });
  const C: Record<string, number> = {};
  C.ANNA = ins("chat", { jid_row_id: J.ANNA, subject: null, ephemeral_expiration: 3600 }); C.GROUP = ins("chat", { jid_row_id: J.GROUP, subject: "Hikers" });
  C.LID = ins("chat", { jid_row_id: J.ANNA_LID }); C.STATUS = ins("chat", { jid_row_id: J.STATUS }); C.CARL = ins("chat", { jid_row_id: J.CARL });
  mkdirSync(join(mediaRoot, "Media/WhatsApp Images"), { recursive: true }); mkdirSync(join(mediaRoot, "Media/WhatsApp Voice Notes/202345"), { recursive: true });
  writeFileSync(join(mediaRoot, "Media/WhatsApp Images/IMG-20231114-WA0001.jpg"), PNG);
  writeFileSync(join(mediaRoot, "Media/WhatsApp Voice Notes/202345/PTT-20231114-WA0002.opus"), VOICE);
  writeFileSync(join(mediaRoot, "Media/WhatsApp Images/IMG-BAD.jpg"), Buffer.from("not what WhatsApp recorded"));
  let n = 0;
  const msg = (chat: string, key: string, o2: Record<string, unknown> = {}) => ins("message", { chat_row_id: C[chat], from_me: 0, key_id: key, status: 0, timestamp: T0 + 1000 * ++n, message_type: 0, sort_id: n, ...o2 });
  const m1 = msg("ANNA", "AAA1", { sender_jid_row_id: 0, text_data: "hi from Anna" });
  const m2 = msg("ANNA", "BBB2", { from_me: 1, status: 13, text_data: "hello Anna, it's me — \"quoted\" ünïcode 😀" });
  const m3 = msg("ANNA", "IMG3", { message_type: 1, text_data: "photo!" });
  ins("message_media", { message_row_id: m3, file_path: "Media/WhatsApp Images/IMG-20231114-WA0001.jpg", file_size: PNG.length, mime_type: "image/jpeg", file_hash: sha64(PNG), width: 10, height: 20 });
  ins("message_quoted", { message_row_id: m3, key_id: "BBB2", from_me: 1, text_data: "hello Anna", sender_jid_row_id: 0 });
  const ao1 = ins("message_add_on", { message_row_id: m3, from_me: 1, sender_jid_row_id: 0, message_add_on_type: 56 }); ins("message_add_on_reaction", { message_add_on_row_id: ao1, reaction: "👍" });
  msg("ANNA", "DEL4", { message_type: 15 });
  const m5 = msg("ANNA", "LOC5", { message_type: 5 }); ins("message_location", { message_row_id: m5, latitude: 48.137, longitude: 11.575, place_name: "Marienplatz", place_address: "Munich" });
  const m6 = msg("ANNA", "VC6", { message_type: 4 }); ins("message_vcard", { message_row_id: m6, vcard: "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Dora Doe\r\nTEL;type=CELL;waid=4915144444444:+49 151 44444444\r\nEND:VCARD" });
  const m7 = msg("ANNA", "SYS7", { message_type: 7 }); ins("message_system", { message_row_id: m7, action_type: 59 });
  msg("CARL", "CALL8", { message_type: 8 });
  msg("ANNA", "UNK9", { message_type: 999 });
  const g1 = msg("GROUP", "GRP1", { sender_jid_row_id: J.BOB, text_data: "look at this" });
  ins("message_forwarded", { message_row_id: g1, forward_score: 1 });
  const ra = ins("message_add_on", { message_row_id: g1, from_me: 0, sender_jid_row_id: J.BOB, message_add_on_type: 56 }); ins("message_add_on_reaction", { message_add_on_row_id: ra, reaction: "❤️" });
  const rb = ins("message_add_on", { message_row_id: g1, from_me: 1, sender_jid_row_id: 0, message_add_on_type: 56 }); ins("message_add_on_reaction", { message_add_on_row_id: rb, reaction: "❤️" });
  const g2 = msg("GROUP", "VN2", { sender_jid_row_id: J.BOB, message_type: 2 });
  ins("message_media", { message_row_id: g2, file_path: "Media/WhatsApp Voice Notes/202345/PTT-20231114-WA0002.opus", file_size: VOICE.length, mime_type: "audio/ogg; codecs=opus", media_duration: 7 });
  const g3 = msg("GROUP", "IMGMISS", { sender_jid_row_id: J.BOB, message_type: 1 });
  ins("message_media", { message_row_id: g3, file_path: "Media/WhatsApp Images/IMG-GONE.jpg", file_size: 1234, mime_type: "image/jpeg" });
  const g4 = msg("GROUP", "POLL4", { from_me: 1, message_type: 66, text_data: "Where to?" });
  ins("message_poll", { message_row_id: g4, selectable_options_count: 1 });
  const oa = ins("message_poll_option", { message_row_id: g4, option_name: "Lake" }), ob = ins("message_poll_option", { message_row_id: g4, option_name: "Peak" });
  const v1 = ins("message_add_on", { message_row_id: g4, from_me: 0, sender_jid_row_id: J.BOB, message_add_on_type: 67 }); ins("message_add_on_poll_vote", { message_add_on_row_id: v1 }); ins("message_add_on_poll_vote_selected_option", { message_add_on_row_id: v1, message_poll_option_id: oa });
  const v2 = ins("message_add_on", { message_row_id: g4, from_me: 1, sender_jid_row_id: 0, message_add_on_type: 67 }); ins("message_add_on_poll_vote", { message_add_on_row_id: v2 }); ins("message_add_on_poll_vote_selected_option", { message_add_on_row_id: v2, message_poll_option_id: ob });
  const v3 = ins("message_add_on", { message_row_id: g4, from_me: 0, sender_jid_row_id: J.BOB, message_add_on_type: 67 }); ins("message_add_on_poll_vote", { message_add_on_row_id: v3 }); ins("message_add_on_poll_vote_selected_option", { message_add_on_row_id: v3, message_poll_option_id: ob }); // Bob changes his mind
  const g5 = msg("GROUP", "EDITED5", { sender_jid_row_id: J.BOB, text_data: "fixed" }); ins("message_edit_info", { message_row_id: g5, original_key_id: "EDITED5", edited_timestamp: T0 + 99_000 });
  const g6 = msg("GROUP", "VO6", { sender_jid_row_id: J.BOB, message_type: 42 }); ins("message_view_once_media", { message_row_id: g6, state: 0 });
  const g7 = msg("GROUP", "BADHASH7", { sender_jid_row_id: J.BOB, message_type: 1 });
  ins("message_media", { message_row_id: g7, file_path: "Media/WhatsApp Images/IMG-BAD.jpg", file_size: 26, mime_type: "image/jpeg", file_hash: sha64(Buffer.from("something else")) });
  const g8 = msg("GROUP", "GRP8", { sender_jid_row_id: J.BOB, text_data: "disappears" }); ins("message_ephemeral", { message_row_id: g8, duration: 604800 });
  msg("LID", "LID1", { text_data: "via lid" });
  msg("STATUS", "ST1", { text_data: "a status" });
  msg("CARL", "CARL1", { text_data: "hi, only a number" });
  const c10 = msg("CARL", "CALL10", { message_type: 10 }); ins("call_log", { message_row_id: c10, from_me: 0, video_call: 1, duration: 0, call_result: 5 });
  const c90 = msg("CARL", "CALL90", { from_me: 1, message_type: 90 }); ins("call_log", { message_row_id: c90, from_me: 1, video_call: 1, duration: 252, call_result: 2 });
  const c91 = msg("CARL", "CALL91", { from_me: 1, message_type: 90 }); ins("call_log", { message_row_id: c91, from_me: 1, video_call: 0, duration: 0, call_result: 4 });
  const c92 = msg("CARL", "CALL92", { message_type: 90 }); ins("call_log", { message_row_id: c92, from_me: 0, video_call: 0, duration: 3725, call_result: 2 });
  let expected = 0; // imported: AAA1 BBB2 IMG3 DEL4 LOC5 VC6 | GRP1 VN2 IMGMISS POLL4 EDITED5 VO6 BADHASH7 GRP8 | LID1 CARL1
  expected = 21; // incl. the five calls (CALL8 CALL10 CALL90 CALL91 CALL92)
  if (o.bigN) { db.exec("BEGIN"); const st = db.prepare("INSERT INTO message (chat_row_id, from_me, key_id, timestamp, message_type, text_data, status) VALUES (?,?,?,?,0,?,0)"); for (let i = 0; i < o.bigN; i++) st.run(C.CARL, i % 3 === 0 ? 1 : 0, `BIG${i}`, T0 + 10_000_000 + i * 1000, `bulk message ${i}`); db.exec("COMMIT"); expected += o.bigN; }
  (db as any).close();
  return { expected, imageHash: sha64(PNG) };
}

export async function writeSyntheticBackup(dir: string, o: { kind?: 15 | 14 | "multifile" | "raw-wrong"; bigN?: number; keyHex?: string; jidSuffix?: string; schema?: (s: string[]) => string[]; noMedia?: boolean } = {}): Promise<SyntheticInfo> {
  const root = join(dir, "WhatsApp"), dbDir = join(root, "Databases"); mkdirSync(dbDir, { recursive: true });
  const plain = join(dir, "plain.db"), r = await buildSyntheticDb(plain, root, { bigN: o.bigN, schema: o.schema });
  if (o.noMedia) rmSync(join(root, "Media"), { recursive: true, force: true });
  const sqlite = readFileSync(plain); rmSync(plain, { force: true });
  const z = deflateSync(sqlite), rootKey = o.keyHex ? Buffer.from(o.keyHex, "hex") : randomBytes(32), keyHex = rootKey.toString("hex");
  let file: string;
  if (o.kind === 14) { const aes = randomBytes(32); file = join(dbDir, "msgstore.db.crypt14"); writeFileSync(file, encryptCrypt14(z, aes, { jidSuffix: o.jidSuffix })); writeFileSync(join(dir, "key"), crypt14KeyFile(aes)); }
  else { file = join(dbDir, "msgstore.db.crypt15"); writeFileSync(file, encryptCrypt15(sqlite, rootKey, { zlib: z, jidSuffix: o.jidSuffix ?? "01", multifile: o.kind === "multifile" })); }
  return { dir, root, file, keyHex, mediaRoot: root, expect: { messages: r.expected, chats: 0, imageHash: r.imageHash } };
}
export const dirOf = dirname;
