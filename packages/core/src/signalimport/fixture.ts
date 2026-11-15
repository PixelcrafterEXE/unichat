// TEST FIXTURES: an ENCODER for Signal's legacy Android backup format (same bytes the real exporter writes: header, key derivation,
// AES-256-CTR frames with truncated HMACs, attachment blobs) and builders for synthetic databases in two schema generations, plus an
// encoder for the new Secure Backup container. Nothing here is used at runtime; no real Signal data is involved.
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { deriveBackupKey, deriveFrameKeys, KDF_ROUNDS, type SqlValue } from "./legacy.js";
import { PbWriter, lengthDelimited } from "./proto.js";

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

export class LegacyBackupWriter {
  private fd: number; private counter: number; private iv: Buffer; private cipherKey: Buffer; private macKey: Buffer; private buf: Buffer[] = []; private bytes = 0;
  constructor(path: string, passphrase: string, o: { rounds?: number; salt?: Buffer; iv?: Buffer } = {}) {
    this.fd = openSync(path, "w", 0o600);
    const salt = o.salt ?? randomBytes(32); this.iv = o.iv ?? randomBytes(16);
    const { cipherKey, macKey } = deriveFrameKeys(deriveBackupKey(passphrase, salt, o.rounds ?? KDF_ROUNDS)); this.cipherKey = cipherKey; this.macKey = macKey;
    this.counter = this.iv.readUInt32BE(0);
    const hdr = new PbWriter().msg(1, new PbWriter().bytes(1, this.iv).bytes(2, salt)).done();
    this.raw(Buffer.concat([u32(hdr.length), hdr]));
  }
  private raw(b: Buffer) { this.buf.push(b); this.bytes += b.length; if (this.bytes > 1 << 20) this.flush(); }
  private flush() { if (this.buf.length) { writeSync(this.fd, Buffer.concat(this.buf)); this.buf = []; this.bytes = 0; } }
  private nextIv() { this.iv.writeUInt32BE(this.counter >>> 0, 0); this.counter = (this.counter + 1) >>> 0; return Buffer.from(this.iv); }
  private frame(plain: Buffer) {
    const c = createCipheriv("aes-256-ctr", this.cipherKey, this.nextIv()), ct = Buffer.concat([c.update(plain), c.final()]);
    const mac = createHmac("sha256", this.macKey).update(ct).digest().subarray(0, 10);
    this.raw(Buffer.concat([u32(ct.length + 10), ct, mac]));
  }
  private blob(frame: Buffer, data: Buffer) {
    this.frame(frame);
    const iv = this.nextIv(), c = createCipheriv("aes-256-ctr", this.cipherKey, iv), ct = Buffer.concat([c.update(data), c.final()]);
    this.raw(Buffer.concat([ct, createHmac("sha256", this.macKey).update(iv).update(ct).digest().subarray(0, 10)]));
  }
  version(v: number) { this.frame(new PbWriter().msg(5, new PbWriter().varint(1, v)).done()); }
  statement(sql: string, params: SqlValue[] = []) {
    const st = new PbWriter().bytes(1, sql);
    for (const p of params) {
      const w = new PbWriter();
      if (p === null) w.varint(5, true); else if (typeof p === "string") w.bytes(1, p); else if (typeof p === "number" && Number.isInteger(p)) w.varint(2, BigInt.asUintN(64, BigInt(p)));
      else if (typeof p === "bigint") w.varint(2, BigInt.asUintN(64, p)); else if (typeof p === "number") w.double(3, p); else w.bytes(4, p);
      st.msg(2, w);
    }
    this.frame(new PbWriter().msg(2, st).done());
  }
  preference(file: string, key: string, value: string) { this.frame(new PbWriter().msg(3, new PbWriter().bytes(1, file).bytes(2, key).bytes(3, value)).done()); }
  keyValue(key: string, value: string) { this.frame(new PbWriter().msg(9, new PbWriter().bytes(1, key).bytes(7, value)).done()); }
  attachment(rowId: number, attachmentId: number, data: Buffer) { this.blob(new PbWriter().msg(4, new PbWriter().varint(1, rowId).varint(2, attachmentId).varint(3, data.length)).done(), data); }
  avatar(name: string, data: Buffer) { this.blob(new PbWriter().msg(7, new PbWriter().bytes(1, name).varint(2, data.length)).done(), data); }
  end() { this.frame(new PbWriter().varint(6, true).done()); }
  close() { this.flush(); closeSync(this.fd); }
}

export const ids = {
  ME: "0a0a0a0a-0000-4000-8000-000000000001", ANNA: "0a0a0a0a-0000-4000-8000-0000000000a1", BOB: "0a0a0a0a-0000-4000-8000-0000000000b2", CARL: "0a0a0a0a-0000-4000-8000-0000000000c3",
  GROUP_HEX: "ab".repeat(32), PASS: "12345 67890 12345 67890 12345 67890",
};
export const groupId = "g." + Buffer.from(ids.GROUP_HEX, "hex").toString("base64url");
export const T0 = 1_700_000_000_000; // 2023-11-14T22:13:20Z
export const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), VOICE = Buffer.from("OggS-synthetic-voice");

type Era = "mms" | "message";
const TABLES_MMS: Record<string, string> = {
  recipient: "CREATE TABLE recipient (_id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE DEFAULT NULL, phone TEXT UNIQUE DEFAULT NULL, group_id TEXT UNIQUE DEFAULT NULL, system_given_name TEXT DEFAULT NULL, system_family_name TEXT DEFAULT NULL, profile_given_name TEXT DEFAULT NULL, profile_family_name TEXT DEFAULT NULL, blocked INTEGER DEFAULT 0)",
  groups: "CREATE TABLE groups (_id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT, recipient_id INTEGER, title TEXT, members TEXT, active INTEGER DEFAULT 1)",
  thread: "CREATE TABLE thread (_id INTEGER PRIMARY KEY AUTOINCREMENT, date INTEGER DEFAULT 0, thread_recipient_id INTEGER, archived INTEGER DEFAULT 0, UNIQUE(thread_recipient_id))",
  sms: "CREATE TABLE sms (_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER, recipient_id INTEGER, date INTEGER, date_sent INTEGER, type INTEGER, body TEXT, read INTEGER DEFAULT 1, expires_in INTEGER DEFAULT 0, delivery_receipt_count INTEGER DEFAULT 0, read_receipt_count INTEGER DEFAULT 0, reactions BLOB DEFAULT NULL)",
  mms: "CREATE TABLE mms (_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER, recipient_id INTEGER, date INTEGER, date_received INTEGER, msg_box INTEGER, body TEXT, read INTEGER DEFAULT 1, part_count INTEGER, quote_id INTEGER DEFAULT 0, quote_author INTEGER DEFAULT 0, quote_body TEXT, view_once INTEGER DEFAULT 0, remote_deleted INTEGER DEFAULT 0, message_ranges BLOB, shared_contacts TEXT, link_previews TEXT, latest_revision_id INTEGER DEFAULT NULL, original_message_id INTEGER DEFAULT NULL, revision_number INTEGER DEFAULT 0, delivery_receipt_count INTEGER DEFAULT 0, read_receipt_count INTEGER DEFAULT 0, expires_in INTEGER DEFAULT 0, story_type INTEGER DEFAULT 0, parent_story_id INTEGER DEFAULT 0)",
  part: "CREATE TABLE part (_id INTEGER PRIMARY KEY AUTOINCREMENT, mid INTEGER, ct TEXT, file_name TEXT, data_size INTEGER, unique_id INTEGER NOT NULL, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0, voice_note INTEGER DEFAULT 0, video_gif INTEGER DEFAULT 0, sticker_pack_id TEXT DEFAULT NULL, quote INTEGER DEFAULT 0)",
  reaction: "CREATE TABLE reaction (_id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, is_mms INTEGER NOT NULL, author_id INTEGER NOT NULL, emoji TEXT NOT NULL, date_sent INTEGER, date_received INTEGER)",
  sms_fts: "CREATE VIRTUAL TABLE sms_fts USING fts5(body, thread_id)",
};
const TABLES_MSG: Record<string, string> = {
  recipient: "CREATE TABLE recipient (_id INTEGER PRIMARY KEY AUTOINCREMENT, type INTEGER DEFAULT 0, aci TEXT UNIQUE DEFAULT NULL, e164 TEXT UNIQUE DEFAULT NULL, group_id TEXT UNIQUE DEFAULT NULL, username TEXT, system_joined_name TEXT, profile_joined_name TEXT, nickname_joined_name TEXT)",
  groups: "CREATE TABLE groups (_id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT, recipient_id INTEGER, title TEXT, v2_master_key BLOB)",
  thread: "CREATE TABLE thread (_id INTEGER PRIMARY KEY AUTOINCREMENT, date INTEGER DEFAULT 0, recipient_id INTEGER, archived INTEGER DEFAULT 0)",
  message: "CREATE TABLE message (_id INTEGER PRIMARY KEY AUTOINCREMENT, date_sent INTEGER, date_received INTEGER, date_server INTEGER DEFAULT -1, thread_id INTEGER, from_recipient_id INTEGER, from_device_id INTEGER, to_recipient_id INTEGER, type INTEGER, body TEXT, read INTEGER DEFAULT 1, quote_id INTEGER DEFAULT 0, quote_author INTEGER DEFAULT 0, quote_body TEXT, view_once INTEGER DEFAULT 0, remote_deleted INTEGER DEFAULT 0, message_ranges BLOB, link_previews TEXT, latest_revision_id INTEGER DEFAULT NULL, original_message_id INTEGER DEFAULT NULL, revision_number INTEGER DEFAULT 0, delivery_receipt_count INTEGER DEFAULT 0, read_receipt_count INTEGER DEFAULT 0, expires_in INTEGER DEFAULT 0, story_type INTEGER DEFAULT 0, parent_story_id INTEGER DEFAULT 0)",
  attachment: "CREATE TABLE attachment (_id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER, content_type TEXT, file_name TEXT, data_size INTEGER, unique_id INTEGER NOT NULL, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0, voice_note INTEGER DEFAULT 0, video_gif INTEGER DEFAULT 0, sticker_pack_id TEXT DEFAULT NULL, quote INTEGER DEFAULT 0)",
  reaction: "CREATE TABLE reaction (_id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, author_id INTEGER NOT NULL, emoji TEXT NOT NULL, date_sent INTEGER, date_received INTEGER)",
};

/** Generic row helper: INSERT with an explicit column list and bound parameters, like the real exporter. */
function insert(w: LegacyBackupWriter, table: string, row: Record<string, SqlValue>, positional?: string[]) {
  const cols = Object.keys(row);
  if (positional) w.statement(`INSERT INTO ${table} VALUES (${positional.map(() => "?").join(",")})`, positional.map((c) => row[c] ?? null));
  else w.statement(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]!));
}
const rangesBlob = (start: number, uuid: string) => new PbWriter().msg(1, new PbWriter().varint(1, start).varint(2, 1).bytes(3, uuid)).done();

/** Everything the synthetic backup contains, for assertions. */
export interface Synthetic { era: Era; totalImported: number; attachments: number; positional?: boolean }

/**
 * A small but representative backup: DMs (resolved by ACI, by phone only), a group (replies, reactions, mentions, voice note, image, deleted,
 * view-once, edit), calls, a timer change, noise (joined, group update), a draft, a legacy v1 group, note-to-self.
 * Both schema generations hold the same conversation. `positional` writes INSERTs without column lists (CREATE statements give the order).
 */
export function writeSynthetic(path: string, era: Era, o: { passphrase?: string; rounds?: number; positional?: boolean; keyValue?: boolean; attachments?: boolean } = {}): Synthetic {
  const w = new LegacyBackupWriter(path, o.passphrase ?? ids.PASS, { rounds: o.rounds });
  w.version(era === "mms" ? 160 : 230);
  if (o.keyValue !== false) { w.keyValue("account.aci", ids.ME); w.keyValue("account.e164", "+4915100000001"); }
  const T = era === "mms" ? TABLES_MMS : TABLES_MSG;
  for (const sql of Object.values(T)) w.statement(sql);
  w.statement("CREATE INDEX thread_idx ON thread (date)");
  const msgTable = era === "mms" ? "mms" : "message";
  const pos = (t: string) => (o.positional ? (/\(([\s\S]*)\)$/.exec(T[t]!)![1]!).split(/,(?![^(]*\))/).map((c) => c.trim().split(/\s+/)[0]!.toLowerCase()).filter((c) => !["unique", "primary", "foreign"].includes(c)) : undefined);
  const col = (t: string, row: Record<string, SqlValue>) => { const p = pos(t); if (p) for (const c of p) if (!(c in row)) row[c] = null; return row; };
  // ---- recipients
  const names = era === "mms" ? (a: string, b: string) => ({ system_given_name: a, system_family_name: b }) : (a: string, b: string) => ({ system_joined_name: `${a} ${b}`.trim() });
  const id = era === "mms" ? "uuid" : "aci", ph = era === "mms" ? "phone" : "e164";
  const recs: Record<string, SqlValue>[] = [
    { _id: 1, [id]: ids.ME, [ph]: "+4915100000001" },
    { _id: 2, [id]: ids.ANNA, [ph]: "+4915111111111", ...names("Anna", "Alder") },
    { _id: 3, [id]: ids.BOB, [ph]: "+4915122222222", ...names("Bob", "") },
    { _id: 4, group_id: `__signal_group__v2__!${ids.GROUP_HEX}` },
    { _id: 5, [ph]: "+4915133333333", ...names("Carl", "NoAci") },
    { _id: 6, group_id: "__textsecure_group__!0102030405" },
  ];
  for (const r of recs) insert(w, "recipient", col("recipient", r), pos("recipient"));
  insert(w, "groups", col("groups", { group_id: `__signal_group__v2__!${ids.GROUP_HEX}`, recipient_id: 4, title: "Hikers" }), pos("groups"));
  const tcol = era === "mms" ? "thread_recipient_id" : "recipient_id";
  [[1, 2], [2, 4], [3, 3], [4, 5], [5, 6], [6, 1]].forEach(([t, r]) => insert(w, "thread", col("thread", { _id: t!, date: T0, [tcol]: r! }), pos("thread")));
  // ---- messages. sent time = T0 + k*1000
  let imported = 0, attCount = 0, partId = 0;
  const part = (mid: number, ct: string, name: string | null, data: Buffer, extra: Record<string, SqlValue> = {}) => {
    const pid = ++partId, uid = 1_000_000 + pid;
    insert(w, era === "mms" ? "part" : "attachment", col(era === "mms" ? "part" : "attachment", { _id: pid, [era === "mms" ? "mid" : "message_id"]: mid, [era === "mms" ? "ct" : "content_type"]: ct, file_name: name, data_size: data.length, unique_id: uid, width: ct.startsWith("image") ? 64 : 0, height: ct.startsWith("image") ? 48 : 0, ...extra }), pos(era === "mms" ? "part" : "attachment"));
    if (o.attachments !== false) w.attachment(pid, uid, data);
    attCount++;
  };
  let mid = 0;
  const msg = (row: Record<string, SqlValue>, count = true): number => {
    const id2 = ++mid;
    if (era === "mms") {
      // sms rows (text only) go to sms, rows needing mms features to mms
      const { isSms, ...r } = row as any;
      if (isSms) { const s: Record<string, SqlValue> = { _id: id2, thread_id: r.thread_id, recipient_id: r.rid, date: r.recv ?? r.sent, date_sent: r.sent, type: r.type, body: r.body, expires_in: r.expires_in ?? 0, delivery_receipt_count: r.dr ?? 0, read_receipt_count: r.rr ?? 0 }; insert(w, "sms", col("sms", s), pos("sms")); }
      else { const s = { ...r, _id: id2, date: r.sent, date_received: r.recv ?? r.sent, msg_box: r.type, recipient_id: r.rid }; for (const k of ["sent", "recv", "rid", "type", "dr", "rr"]) delete s[k]; insert(w, "mms", col("mms", s), pos("mms")); }
    } else {
      const { isSms: _x, ...r } = row as any; const s = { ...r, _id: id2, date_sent: r.sent, date_received: r.recv ?? r.sent, from_recipient_id: r.rid, type: r.type, delivery_receipt_count: r.dr ?? 0, read_receipt_count: r.rr ?? 0 };
      for (const k of ["sent", "recv", "rid", "dr", "rr", "expires_in_x"]) delete s[k]; insert(w, "message", col("message", s), pos("message"));
    }
    if (count) imported++; return id2;
  };
  const OUT = 23, IN = 20;
  // DM with Anna
  msg({ isSms: 1, thread_id: 1, rid: 2, sent: T0 + 1000, type: IN, body: "hi from Anna" });
  msg({ isSms: 1, thread_id: 1, rid: 2, sent: T0 + 2000, type: OUT, body: "hello Anna, it's me — \"quoted\" and 'single' ünïcode 😀", dr: 1, rr: 1 });
  msg({ isSms: 1, thread_id: 1, rid: 2, sent: T0 + 3000, type: 4, body: null }, false);                     // joined Signal: noise
  msg({ isSms: 1, thread_id: 1, rid: 2, sent: T0 + 4000, type: 3, body: null });                              // missed voice call
  msg({ isSms: 1, thread_id: 1, rid: 2, sent: T0 + 5000, type: IN | 0x10000, body: "R3JvdXBVcGRhdGU=" }, false); // group-update bit: noise
  msg({ isSms: 1, thread_id: 1, rid: 2, sent: T0 + 6000, type: OUT | 0x40000, body: null, expires_in: 3_600_000 }); // timer change
  msg({ isSms: 1, thread_id: 1, rid: 2, sent: T0 + 7000, type: 27, body: "unsent draft" }, false);              // draft
  // photo from Anna with caption + reply to our message + reaction by me
  const photo = msg({ thread_id: 1, rid: 2, sent: T0 + 8000, type: IN, body: "photo!", part_count: 1, quote_id: T0 + 2000, quote_author: 1, quote_body: "hello Anna" });
  part(photo, "image/png", "p.png", PNG); 
  insert(w, "reaction", col("reaction", era === "mms" ? { _id: 1, message_id: photo, is_mms: 1, author_id: 1, emoji: "👍", date_sent: T0 } : { _id: 1, message_id: photo, author_id: 1, emoji: "👍", date_sent: T0 }), pos("reaction"));
  // group
  const g1 = msg({ thread_id: 2, rid: 3, sent: T0 + 10_000, type: IN, body: "look at this", part_count: 2, quote_id: T0 + 1000, quote_author: 2, quote_body: "hi from Anna" });
  part(g1, "image/png", null, PNG); part(g1, "audio/ogg", null, VOICE, { voice_note: 1 });
  for (const [k, a, e] of [[1, 2, "❤️"], [2, 1, "❤️"], [3, 3, "😂"]] as const) insert(w, "reaction", col("reaction", era === "mms" ? { _id: 10 + k, message_id: g1, is_mms: 1, author_id: a, emoji: e, date_sent: T0 } : { _id: 10 + k, message_id: g1, author_id: a, emoji: e, date_sent: T0 }), pos("reaction"));
  msg({ thread_id: 2, rid: 1, sent: T0 + 11_000, type: OUT, body: "￼ thanks!", message_ranges: rangesBlob(0, ids.BOB), part_count: 0 });
  msg({ thread_id: 2, rid: 3, sent: T0 + 12_000, type: IN, body: "oops", remote_deleted: 1 });
  msg({ thread_id: 2, rid: 3, sent: T0 + 13_000, type: IN, body: null, view_once: 1, part_count: 1 }) ;
  // edit: original revision row (skipped, points to latest) then latest row
  const origId = mid + 1;
  msg({ thread_id: 2, rid: 3, sent: T0 + 14_000, type: IN, body: "typo", latest_revision_id: mid + 2 }, false);
  msg({ thread_id: 2, rid: 3, sent: T0 + 15_000, type: IN, body: "fixed", original_message_id: origId, revision_number: 1 });
  // Carl: phone only
  msg({ isSms: 1, thread_id: 4, rid: 5, sent: T0 + 16_000, type: IN, body: "hi, no ACI here" });
  // legacy group + note to self
  msg({ isSms: 1, thread_id: 5, rid: 5, sent: T0 + 17_000, type: IN, body: "old group" }, false);
  msg({ isSms: 1, thread_id: 6, rid: 1, sent: T0 + 18_000, type: OUT, body: "note to self" });
  if (era === "mms") w.statement("INSERT INTO sms_fts (body, thread_id) VALUES (?, ?)", ["fts row", 1]); // ignored table
  w.statement("DROP TABLE IF EXISTS signal_unknown"); // unknown statement shapes are ignored
  w.preference("org.thoughtcrime.securesms_preferences", "pref_theme", "dark");
  w.avatar("avatar-2", Buffer.from("avatar bytes"));
  w.end(); w.close();
  return { era, totalImported: imported, attachments: attCount, positional: o.positional };
}

/** Large generated backup (streamed to disk): one DM thread and one group with `n` plain messages. */
export function writeBig(path: string, n: number, o: { rounds?: number } = {}) {
  const w = new LegacyBackupWriter(path, ids.PASS, { rounds: o.rounds }); w.version(230); w.keyValue("account.aci", ids.ME);
  for (const sql of Object.values(TABLES_MSG)) w.statement(sql);
  insert(w, "recipient", { _id: 1, aci: ids.ME, e164: "+4915100000001" }); insert(w, "recipient", { _id: 2, aci: ids.ANNA, e164: "+4915111111111", system_joined_name: "Anna" });
  insert(w, "thread", { _id: 1, date: T0, recipient_id: 2 });
  for (let i = 1; i <= n; i++) insert(w, "message", { _id: i, date_sent: T0 + i * 1000, date_received: T0 + i * 1000, thread_id: 1, from_recipient_id: i % 2 ? 2 : 1, type: i % 2 ? 20 : 23, body: `message number ${i} ` + "x".repeat(60) });
  w.end(); w.close();
}

// ------------------------------------------------------------------------------------------------ Secure Backup (new format)
import type { Aci as AciT } from "@signalapp/libsignal-client";
export async function writeSecureBackup(path: string, aep: string, aci: string, frames: Buffer[], o: { padding?: number } = {}) {
  const base = "@signalapp/libsignal-client/dist/";
  const pre = (globalThis as any).__unimsgLibsignalModules as Record<string, any> | undefined; // set by the Android on-device test bundle
  const { MessageBackupKey } = pre?.["MessageBackup.js"] ?? await import(base + "MessageBackup.js"); const { Aci } = pre?.["Address.js"] ?? await import(base + "Address.js");
  const key = new MessageBackupKey({ accountEntropy: aep, aci: Aci.fromUuid(aci) as AciT });
  const info = new PbWriter().varint(1, 1).varint(2, T0).bytes(3, Buffer.alloc(32, 5)).done();
  const plain = Buffer.concat([lengthDelimited(info), ...frames.map((f) => lengthDelimited(f))]);
  const gz = Buffer.concat([gzipSync(plain), Buffer.alloc(o.padding ?? 0)]);
  const iv = randomBytes(16), c = createCipheriv("aes-256-cbc", Buffer.from(key.aesKey), iv), ct = Buffer.concat([c.update(gz), c.final()]);
  const mac = createHmac("sha256", Buffer.from(key.hmacKey)).update(iv).update(ct).digest();
  writeFileSync(path, Buffer.concat([iv, ct, mac]));
}
/** profile key of Anna in the Secure Backup fixture */
export const ANNA_PROFILE_KEY = Buffer.alloc(32, 7);
/** Frames for a small Secure Backup conversation (field numbers per Signal's Backup.proto). */
export function secureFrames(): Buffer[] {
  const b = (hex: string) => Buffer.from(hex.replace(/-/g, ""), "hex");
  const rec = (id: number, body: PbWriter, field: number) => new PbWriter().msg(2, new PbWriter().varint(1, id).msg(field, body)).done();
  const contact = (aci: string, e164: number, given: string, pk?: Buffer) => { const w = new PbWriter().bytes(1, b(aci)).varint(4, e164); if (pk) w.bytes(9, pk); return w.bytes(11, given); };
  const text = (t: string) => new PbWriter().msg(2, new PbWriter().bytes(1, t));
  const item = (chat: number, author: number, sent: number, dir: "in" | "out", std: PbWriter) =>
    new PbWriter().varint(1, chat).varint(2, author).varint(3, sent).msg(dir === "in" ? 8 : 9, dir === "in" ? new PbWriter().varint(1, sent + 1).varint(3, true) : new PbWriter()).msg(11, std);
  const reaction = (emoji: string, author: number) => new PbWriter().bytes(1, emoji).varint(2, author).varint(3, T0).varint(4, 1);
  return [
    new PbWriter().msg(1, new PbWriter().bytes(1, Buffer.alloc(32, 1))).done(),                                   // AccountData (profileKey)
    rec(1, new PbWriter(), 5), rec(2, contact(ids.ANNA, 4915111111111, "Anna", ANNA_PROFILE_KEY), 2), rec(3, contact(ids.BOB, 4915122222222, "Bob"), 2),
    new PbWriter().msg(3, new PbWriter().varint(1, 1).varint(2, 2)).done(), new PbWriter().msg(3, new PbWriter().varint(1, 2).varint(2, 3)).done(),
    new PbWriter().msg(4, item(1, 2, T0 + 1000, "in", text("hello from the new format"))).done(),
    new PbWriter().msg(4, item(1, 1, T0 + 2000, "out", text("reply from me").msg(1, new PbWriter().varint(1, T0 + 1000).varint(2, 2).msg(3, new PbWriter().bytes(1, "hello from the new format"))).msg(6, reaction("👍", 2)))).done(),
    new PbWriter().msg(4, item(2, 3, T0 + 3000, "in", text("bob here").msg(6, reaction("🎉", 1)))).done(),
  ];
}

// ------------------------------------------------------------------------------------------------ Secure Backup: on-device folder with media
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { localMediaName } from "./secure.js";
/** AttachmentCipherOutputStream layout: IV || AES-256-CBC(zero-padded plaintext) || HMAC-SHA256(IV||ciphertext), key = AES(32) || MAC(32). */
export function encryptLocalMedia(plain: Buffer, localKey: Buffer, padTo = 0): Buffer {
  const iv = randomBytes(16), c = createCipheriv("aes-256-cbc", localKey.subarray(0, 32), iv);
  const ct = Buffer.concat([c.update(Buffer.concat([plain, Buffer.alloc(Math.max(0, padTo - plain.length))])), c.final()]);
  return Buffer.concat([iv, ct, createHmac("sha256", localKey.subarray(32)).update(iv).update(ct).digest()]);
}
export interface SecureMedia { id: string; ct: string; name?: string; data: Buffer; flag?: number; /** how the file is stored */ mode?: "ok" | "absent" | "tampered" | "nokey" | "wronghash"; text?: string }
/**
 * Writes `<root>/<snapshot>/{main,metadata,files}` and `<root>/files/xx/<name>` exactly as Signal-Android's LocalArchiver lays them out.
 * Each media becomes one incoming message from Anna (chat 1) at T0 + 10_000 + index * 1000. Returns the path of `main`.
 */
export async function writeSecureFolderBackup(root: string, aep: string, aci: string, media: SecureMedia[], snapshot = "signal-backup-2026-11-01-10-00-00"): Promise<{ main: string; sentAt: (i: number) => number }> {
  const base = "@signalapp/libsignal-client/dist/";
  const { AccountEntropyPool } = await import(base + "AccountKeys.js"); const { Aci } = await import(base + "Address.js");
  const snap = join(root, snapshot); mkdirSync(snap, { recursive: true }); mkdirSync(join(root, "files"), { recursive: true });
  const sentAt = (i: number) => T0 + 10_000 + i * 1000;
  const frames = secureFrames(), names: string[] = [];
  media.forEach((m, i) => {
    const key = randomBytes(64), hash = createHash("sha256").update(m.data).digest(), name = localMediaName(hash, key);
    const loc = new PbWriter().bytes(10, m.mode === "wronghash" ? randomBytes(32) : hash).varint(3, m.data.length); if (m.mode !== "nokey") loc.bytes(9, key);
    const ptr = new PbWriter().bytes(4, m.ct); if (m.name) ptr.bytes(7, m.name); ptr.varint(8, 2).varint(9, 3).msg(13, loc);
    const att = new PbWriter().msg(1, ptr); if (m.flag) att.varint(2, m.flag);
    const std = new PbWriter(); if (m.text) std.msg(2, new PbWriter().bytes(1, m.text)); std.msg(3, att);
    frames.push(new PbWriter().msg(4, new PbWriter().varint(1, 1).varint(2, 2).varint(3, sentAt(i)).msg(8, new PbWriter().varint(1, sentAt(i) + 1).varint(3, true)).msg(11, std)).done());
    if (m.mode === "absent" || m.mode === "nokey") return;
    let file = encryptLocalMedia(m.data, key, Math.ceil((m.data.length + 1) / 64) * 64);
    if (m.mode === "tampered") { file = Buffer.from(file); file[20]! ^= 1; }
    mkdirSync(join(root, "files", name.slice(0, 2)), { recursive: true }); writeFileSync(join(root, "files", name.slice(0, 2), name), file); names.push(name);
  });
  const main = join(snap, "main"); await writeSecureBackup(main, aep, aci, frames);
  // metadata: Metadata{version=1, backupId{iv(12), encryptedId = AES-256-CTR(metadata key, backup id)}}
  const bk = AccountEntropyPool.deriveBackupKey(aep), iv = randomBytes(12);
  const c = createCipheriv("aes-256-ctr", Buffer.from(bk.deriveLocalBackupMetadataKey()), Buffer.concat([iv, Buffer.alloc(4)]));
  const encId = Buffer.concat([c.update(Buffer.from(bk.deriveBackupId(Aci.fromUuid(aci)))), c.final()]);
  writeFileSync(join(snap, "metadata"), new PbWriter().varint(1, 1).msg(2, new PbWriter().bytes(1, iv).bytes(2, encId)).done());
  // files: the index of names (FilesFrame{mediaName = 1}), varint-delimited
  writeFileSync(join(snap, "files"), Buffer.concat(names.map((n) => lengthDelimited(new PbWriter().bytes(1, n).done()))));
  return { main, sentAt };
}
