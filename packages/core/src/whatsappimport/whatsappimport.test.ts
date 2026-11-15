// Unit tests of the WhatsApp crypt15/crypt14 container and the msgstore reader (SYNTHETIC fixtures only: see fixture.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { decryptToFile, deriveBackupEncryptionKey, encryptCrypt15, encryptCrypt14, crypt14KeyFile, keyFromCrypt14KeyFile, parseHeader, normalizeKey, looksLikeKey, readHeader } from "./crypt.js";
import { WaReader, optionId, callText } from "./reader.js";
import { buildSyntheticDb, writeSyntheticBackup, T0, PNG, VOICE, jid, sha64 } from "./fixture.js";

const made: string[] = [];
const tmp = (p = "waimp-") => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const rejects = (f: () => Promise<unknown>, code: string, re?: RegExp) => assert.rejects(f, (e: any) => { assert.equal(e.code, code, e.message); if (re) assert.match(e.message, re); return true; });

test("crypt15 key derivation: HMAC-SHA256 chain as documented by wa-crypt-tools (independent step-by-step check)", () => {
  const root = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");
  const privateKey = createHmac("sha256", Buffer.alloc(32)).update(root).digest();
  const expected = createHmac("sha256", privateKey).update(Buffer.from("backup encryption")).update(Buffer.from([0x01])).digest();
  assert.equal(deriveBackupEncryptionKey(root).toString("hex"), expected.toString("hex"));
  assert.notEqual(deriveBackupEncryptionKey(root).toString("hex"), root.toString("hex"));
  assert.throws(() => deriveBackupEncryptionKey(Buffer.alloc(31)), /64 hex/);
  assert.equal(normalizeKey(" ABCD-ef01\n2345 "), "abcdef012345"); assert.ok(looksLikeKey("a".repeat(32) + " " + "B".repeat(32))); assert.ok(!looksLikeKey("a".repeat(63)));
});

test("header: IV, feature flag, version and phone suffix; garbage is refused", async () => {
  const d = tmp(), f = join(d, "x.crypt15"), root = randomBytes(32);
  writeFileSync(f, encryptCrypt15(Buffer.from("SQLite format 3\0" + "x".repeat(200)), root, { jidSuffix: "42", appVersion: "2.25.1.2" }));
  const { header } = await readHeader(f);
  assert.equal(header.crypt, 15); assert.equal(header.iv.length, 16); assert.equal(header.features, true); assert.equal(header.jidSuffix, "42"); assert.equal(header.appVersion, "2.25.1.2"); assert.equal(header.backupVersion, 1);
  const nof = parseHeader(encryptCrypt15(Buffer.from("SQLite format 3\0" + "y".repeat(100)), root, { features: false })); assert.equal(nof.features, false); assert.equal(nof.crypt, 15);
  const g = join(d, "g"); writeFileSync(g, randomBytes(500));
  await rejects(() => readHeader(g), "not-a-backup", /not a WhatsApp/); writeFileSync(g, Buffer.from("tiny")); await rejects(() => readHeader(g), "truncated");
});

test("decrypt: byte-exact round trip over several read chunks, multifile (no md5) variant, raw-sqlite payload", async () => {
  const d = tmp(), sql = Buffer.concat([Buffer.from("SQLite format 3\0"), randomBytes(5 * 1024 * 1024 + 123)]), root = randomBytes(32);
  for (const [name, o, z] of [["single", {}, deflateSync(sql)], ["multi", { multifile: true }, deflateSync(sql)], ["raw", {}, sql]] as const) {
    const f = join(d, name + ".crypt15"), out = join(d, name + ".db"); writeFileSync(f, encryptCrypt15(sql, root, { ...o, zlib: z }));
    const r = await decryptToFile(f, out, deriveBackupEncryptionKey(root));
    assert.ok(readFileSync(out).equals(sql), name); assert.equal(r.multifile, name === "multi"); assert.equal(r.plainBytes, sql.length);
  }
});

test("decrypt: wrong key, bit flips, truncation and a bad zlib stream give clear errors and leave no plaintext behind", async () => {
  const d = tmp(), sql = Buffer.concat([Buffer.from("SQLite format 3\0"), randomBytes(200_000)]), root = randomBytes(32), f = join(d, "a.crypt15"), out = join(d, "a.db");
  const good = encryptCrypt15(sql, root); writeFileSync(f, good); const key = deriveBackupEncryptionKey(root);
  await rejects(() => decryptToFile(f, out, deriveBackupEncryptionKey(randomBytes(32))), "bad-passphrase", /Wrong key/); assert.ok(!existsSync(out));
  const flip = (at: number, code: string, re?: RegExp) => { const b = Buffer.from(good); b[at]! ^= 1; const p = join(d, "bad"); writeFileSync(p, b); return rejects(() => decryptToFile(p, out, key), code, re).then(() => assert.ok(!existsSync(out))); };
  await flip(good.length - 20, "corrupt", /authentication/);         // tag bit: the md5 trailer no longer matches -> treated as multifile; the tag check refuses it
  await flip(good.length - 5, "corrupt");                             // md5 trailer
  await flip(good.length - 100, "corrupt");                           // ciphertext bit (the zlib stream or the tag check fails)
  writeFileSync(join(d, "cut"), good.subarray(0, good.length - 5000)); await rejects(() => decryptToFile(join(d, "cut"), out, key), "corrupt"); assert.ok(!existsSync(out));
  writeFileSync(join(d, "tiny"), good.subarray(0, 40)); await rejects(() => decryptToFile(join(d, "tiny"), out, key), "truncated");
  const notSql = join(d, "ns"); writeFileSync(notSql, encryptCrypt15(Buffer.alloc(0), root, { zlib: deflateSync(Buffer.from("this is not a database ".repeat(20))) })); await rejects(() => decryptToFile(notSql, out, key), "corrupt", /not a SQLite/); assert.ok(!existsSync(out));
});

test("decrypt: cancel stops the job and removes the partial output", async () => {
  const d = tmp(), sql = Buffer.concat([Buffer.from("SQLite format 3\0"), randomBytes(30 * 1024 * 1024)]), root = randomBytes(32), f = join(d, "a.crypt15"), out = join(d, "a.db");
  writeFileSync(f, encryptCrypt15(sql, root)); const ac = new AbortController();
  await rejects(() => decryptToFile(f, out, deriveBackupEncryptionKey(root), { signal: ac.signal, onProgress: (x) => { if (x > 1e6) ac.abort(); } }), "cancelled"); assert.ok(!existsSync(out));
});

test("crypt14: the 158-byte key file opens a crypt14 container; broken key files are refused", async () => {
  const d = tmp(), aes = randomBytes(32), sql = Buffer.concat([Buffer.from("SQLite format 3\0"), randomBytes(1000)]), f = join(d, "m.crypt14"), out = join(d, "m.db");
  writeFileSync(f, encryptCrypt14(deflateSync(sql), aes)); const kf = crypt14KeyFile(aes); assert.equal(kf.length, 158);
  const { header } = await readHeader(f); assert.equal(header.crypt, 14);
  await decryptToFile(f, out, keyFromCrypt14KeyFile(kf)); assert.ok(readFileSync(out).equals(sql));
  const bad = Buffer.from(kf); bad[90]! ^= 1; assert.throws(() => keyFromCrypt14KeyFile(bad), /damaged/); assert.throws(() => keyFromCrypt14KeyFile(Buffer.alloc(20)), /crypt14 key file/);
  await rejects(() => decryptToFile(f, out, keyFromCrypt14KeyFile(crypt14KeyFile(randomBytes(32)))), "bad-passphrase");
});

// ------------------------------------------------------------------------------------------------ reader
async function readAll(o: { attachments?: boolean; media?: boolean; schema?: (s: string[]) => string[] } = {}) {
  const d = tmp(), db = join(d, "m.db"), root = join(d, "WhatsApp"); await buildSyntheticDb(db, root, { schema: o.schema });
  const r = await WaReader.open(db), msgs: any[] = [], blobs: Record<string, Buffer> = {};
  const stats = await r.run({ attachments: o.attachments !== false, mediaRoot: o.media === false ? undefined : root, ownId: jid.ME, onMessage: (m) => { msgs.push(m); }, onBlob: (a, owner, data) => { blobs[owner.message.id] = data; } });
  r.close(); return { stats, msgs, blobs, by: (id: string) => msgs.find((m) => m.message.id === id)!.message, chat: (id: string) => msgs.filter((m) => m.chat.id === id).map((m) => m.message) };
}

test("reader: texts, replies, reactions, deletes, locations, contacts, polls, edits, forwards, disappearing, view-once", async () => {
  const { stats, by, chat } = await readAll();
  assert.equal(stats.messages, 21);
  const anna = chat(jid.ANNA); assert.deepEqual(anna.map((m) => m.id), ["AAA1", "BBB2", "IMG3", "DEL4", "LOC5", "VC6", "LID1"], "the LID chat is folded into the phone-number chat via jid_map");
  assert.equal(by("AAA1").senderId, jid.ANNA); assert.equal(by("AAA1").sender, "+4915111111111"); assert.equal(by("AAA1").time, new Date(T0 + 1000).toISOString());
  assert.equal(by("BBB2").fromMe, true); assert.equal(by("BBB2").senderId, jid.ME); assert.equal(by("BBB2").status, "read"); assert.match(by("BBB2").text, /ünïcode 😀/);
  assert.deepEqual(by("IMG3").replyTo, { messageId: "BBB2", sender: "Me", textPreview: "hello Anna" });
  assert.deepEqual(by("IMG3").reactions, [{ emoji: "👍", senderIds: [jid.ME], mine: true }]);
  assert.deepEqual({ d: by("DEL4").deleted, t: by("DEL4").text }, { d: true, t: "" });
  assert.deepEqual(by("LOC5").location, { lat: 48.137, lng: 11.575, name: "Marienplatz", address: "Munich" });
  assert.deepEqual(by("VC6").contacts, [{ name: "Dora Doe", phones: ["+49 151 44444444"], handle: "+4915144444444" }]);
  const g = chat(jid.GROUP); assert.equal(g.length, 8);
  assert.equal(by("GRP1").senderId, jid.BOB); assert.equal(by("GRP1").forwarded, true);
  assert.deepEqual(by("GRP1").reactions!.map((r: any) => [r.emoji, [...r.senderIds].sort(), !!r.mine]), [["❤️", [jid.BOB, jid.ME].sort(), true]]);
  const poll = by("POLL4").poll; assert.equal(poll.question, "Where to?"); assert.equal(poll.multiple, false);
  assert.deepEqual(poll.options.map((o: any) => [o.text, [...o.voters].sort(), o.id]), [["Lake", [], optionId("Lake")], ["Peak", [jid.BOB, jid.ME].sort(), optionId("Peak")]], "Bob's later vote replaces his first one; ids match the live provider (sha256 of the text)");
  assert.deepEqual(poll.mine, [optionId("Peak")]);
  assert.equal(by("EDITED5").text, "fixed"); assert.equal(by("EDITED5").editedAt, new Date(T0 + 99_000).toISOString());
  assert.deepEqual([by("VO6").viewOnce, by("VO6").text, by("VO6").attachments], [true, "[View-once media - open it in WhatsApp on your phone]", undefined]);
  assert.equal(by("GRP8").expiresIn, 604800);
  assert.deepEqual(chat(jid.CARL).filter((m) => !m.system).map((m) => m.text), ["hi, only a number"]);
  assert.equal(stats.skipped["system-59"], 1); assert.equal(stats.skipped["type-999"], 1); assert.equal(stats.skipped["chat-unsupported"], 1);
  const cs = Object.fromEntries(stats.chats.map((c) => [c.id, c])); assert.equal(cs[jid.GROUP]!.name, "Hikers"); assert.equal(cs[jid.GROUP]!.kind, "group"); assert.equal(cs[jid.ANNA]!.disappearing, 3600); assert.equal(stats.chats.length, 3);
});

test("reader: calls (type 8/10/90 + call_log) become system notes with direction and duration", async () => {
  const { by, stats } = await readAll();
  const row = (id: string) => [by(id).text, by(id).system, by(id).fromMe];
  assert.deepEqual(row("CALL8"), ["Missed voice call", { kind: "info" }, false], "no call_log row: incoming and no duration -> missed");
  assert.equal(by("CALL10").text, "Missed video call");
  assert.equal(by("CALL90").text, "Outgoing video call · 4:12"); assert.equal(by("CALL90").fromMe, true);
  assert.equal(by("CALL91").text, "Unanswered voice call");
  assert.equal(by("CALL92").text, "Incoming voice call · 1:02:05");
  assert.equal(stats.skipped.call, undefined);
  assert.equal(callText({ video: false, outgoing: false, seconds: 59.6 }), "Incoming voice call · 1:00");
});

test("reader: media is matched by the relative path, size and sha256 are verified, missing and mismatching files are counted", async () => {
  const { stats, by, blobs } = await readAll();
  assert.deepEqual(by("IMG3").attachments, [{ id: "a0", kind: "image", mime: "image/jpeg", width: 10, height: 20, size: PNG.length }]); assert.ok(blobs.IMG3!.equals(PNG));
  assert.equal(by("VN2").attachments[0].kind, "voice"); assert.equal(by("VN2").attachments[0].durationMs, 7000); assert.ok(blobs.VN2!.equals(VOICE));
  assert.deepEqual([by("IMGMISS").attachments, by("IMGMISS").text], [undefined, "[Photo]"]);
  assert.deepEqual([by("BADHASH7").attachments, by("BADHASH7").text], [undefined, "[Photo]"]);
  assert.deepEqual(stats.attachments, { listed: 4, bytes: PNG.length + VOICE.length + 1234 + 26, present: 3, stored: 2, missing: 1, mismatch: 1, tooLarge: 0 });
  assert.ok(stats.warnings.some((w) => /differ from what WhatsApp recorded/.test(w)));
  const none = await readAll({ media: false }); assert.equal(none.stats.attachments.stored, 0); assert.equal(none.stats.attachments.missing, 4); assert.equal(none.by("IMG3").text, "photo!");
  const off = await readAll({ attachments: false }); assert.equal(off.stats.attachments.stored, 0); assert.equal(off.stats.attachments.present, 3);
});

test("reader: a path that tries to leave the media folder is never read", async () => {
  const d = tmp(), db = join(d, "m.db"), root = join(d, "WhatsApp"); await buildSyntheticDb(db, root);
  writeFileSync(join(d, "secret.txt"), "outside");
  const { DatabaseSync } = await import("node:sqlite"); const x = new DatabaseSync(db); x.exec("UPDATE message_media SET file_path='../../secret.txt' WHERE message_row_id=3"); x.exec("UPDATE message_media SET file_path='/etc/hostname' WHERE message_row_id=11"); x.close();
  const r = await WaReader.open(db), seen: string[] = [];
  const stats = await r.run({ attachments: true, mediaRoot: root, ownId: jid.ME, onMessage() {}, onBlob: (a, o) => { seen.push(o.message.id); } }); r.close();
  assert.deepEqual(seen, []); assert.equal(stats.attachments.present, 1, "only the in-folder file with a hash mismatch was even found");
});

test("reader: unsupported schemas are reported cleanly (old `messages` table, missing core columns, not msgstore)", async () => {
  const d = tmp(); const { DatabaseSync } = await import("node:sqlite");
  const mk = (name: string, sql: string[]) => { const p = join(d, name); const x = new DatabaseSync(p); for (const s of sql) x.exec(s); x.close(); return p; };
  await rejects(() => WaReader.open(mk("old.db", ["CREATE TABLE messages (_id INTEGER, key_remote_jid TEXT)", "CREATE TABLE chat_list (_id INTEGER)"])), "unsupported-version", /pre-2022/);
  await rejects(() => WaReader.open(mk("nokey.db", ["CREATE TABLE message (_id INTEGER, chat_row_id INTEGER, timestamp INTEGER, message_type INTEGER, from_me INTEGER)", "CREATE TABLE chat (_id INTEGER, jid_row_id INTEGER)", "CREATE TABLE jid (_id INTEGER, raw_string TEXT)"])), "unsupported-version", /no column `key_id`/);
  await rejects(() => WaReader.open(mk("other.db", ["CREATE TABLE t (x)"])), "unsupported-version", /Unsupported schema/);
  writeFileSync(join(d, "junk.db"), randomBytes(5000)); await rejects(() => WaReader.open(join(d, "junk.db")), "corrupt");
});

test("reader: optional tables and columns may be missing (older WhatsApp 2.22/23 layouts): the core still imports", async () => {
  const drop = (names: string[]) => (s: string[]) => s.filter((x) => !names.some((n) => x.startsWith(`CREATE TABLE ${n} `)));
  const r = await readAll({ schema: drop(["message_add_on", "message_add_on_reaction", "message_poll", "message_poll_option", "message_add_on_poll_vote", "message_add_on_poll_vote_selected_option", "message_edit_info", "message_ephemeral", "message_forwarded", "message_view_once_media", "jid_map", "message_vcard"]) }).catch((e) => e);
  // buildSyntheticDb inserts into the dropped tables, so build a reduced database directly instead
  assert.ok(r instanceof Error);
  const d = tmp(), p = join(d, "m.db"); const { DatabaseSync } = await import("node:sqlite"); const x = new DatabaseSync(p);
  x.exec("CREATE TABLE jid (_id INTEGER PRIMARY KEY, raw_string TEXT); CREATE TABLE chat (_id INTEGER PRIMARY KEY, jid_row_id INTEGER); CREATE TABLE message (_id INTEGER PRIMARY KEY, chat_row_id INTEGER, from_me INTEGER, key_id TEXT, timestamp INTEGER, message_type INTEGER, text_data TEXT)");
  x.exec(`INSERT INTO jid VALUES (1, '${jid.ANNA}'); INSERT INTO chat VALUES (1, 1); INSERT INTO message VALUES (1,1,0,'K1',${T0},0,'minimal'), (2,1,1,'K2',${T0 + 1},0,'mine')`); x.close();
  const rd = await WaReader.open(p), got: string[] = []; const st = await rd.run({ attachments: false, ownId: jid.ME, onMessage: (m) => { got.push(m.message.text); }, onBlob() {} }); rd.close();
  assert.deepEqual(got, ["minimal", "mine"]); assert.equal(st.messages, 2);
});

test("end to end: writeSyntheticBackup (crypt15) -> decrypt -> read; sha256 helper agrees with the recorded file_hash", async () => {
  const d = tmp(), s = await writeSyntheticBackup(d, { jidSuffix: "01" }), out = join(d, "out.db");
  await decryptToFile(s.file, out, deriveBackupEncryptionKey(Buffer.from(s.keyHex, "hex")));
  const r = await WaReader.open(out); assert.equal(r.total(), 24); r.close();
  assert.equal(sha64(PNG), s.expect.imageHash);
});
