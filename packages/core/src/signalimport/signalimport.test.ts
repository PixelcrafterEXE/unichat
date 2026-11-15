import test from "node:test";
import assert from "node:assert/strict";
import { createHash, hkdfSync } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, truncateSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../hub.js";
import { MemoryStore } from "../store.js";
import { MediaCache } from "../media.js";
import { NO_CAPABILITIES, type Connector, type CoreEvent, type ProviderFactory } from "../provider.js";
import type { Message } from "../model.js";
import { deriveBackupKey, deriveFrameKeys, normalizePassphrase, readLegacyBackup, parseFrame } from "./legacy.js";
import { parseStatement, Schema, tokenize } from "./sql.js";
import { ids, groupId, writeSynthetic, writeBig, writeSecureBackup, secureFrames, LegacyBackupWriter, T0, PNG, VOICE } from "./fixture.js";

const FAST = 2000; // KDF rounds are fixed by the format; tests that do not target the KDF use the real count only once per file (≈0.2 s)
const made: string[] = [];
// temp dirs: honour TMPDIR (big synthetic backups; /tmp may be a small tmpfs) and always clean up
const mk = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = () => mk("sigimp-");
const collect = async (path: string, pass: string) => { const out: any[] = []; for await (const i of readLegacyBackup(path, pass, { wantBlob: () => true })) out.push(i); return out; };
const rejects = (f: () => Promise<unknown>, code: string, re?: RegExp) => assert.rejects(f, (e: any) => { assert.equal(e.code, code, e.message); if (re) assert.match(e.message, re); return true; });

// ---------------------------------------------------------------------------------------------------- key derivation
test("key derivation matches an independent step-by-step implementation of the Java algorithm", () => {
  const salt = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");
  // Java: digest.update(salt); hash = input; for i<N { digest.update(hash); hash = digest.digest(input) }  (digest() = update(input)+finish+reset)
  const input = Buffer.from("123456789012345678901234567890");
  const ref = (n: number) => { let hash = input; for (let i = 0; i < n; i++) { const d = createHash("sha512"); if (i === 0) d.update(salt); d.update(hash); d.update(input); hash = d.digest(); } return hash.subarray(0, 32); };
  assert.equal(deriveBackupKey("12345 67890 12345 67890 12345 67890", salt, 5).toString("hex"), ref(5).toString("hex"));
  assert.equal(deriveBackupKey("12345-67890-12345-67890-12345-67890", salt, 1).toString("hex"), ref(1).toString("hex"), "dashes and spaces are ignored");
  assert.notEqual(deriveBackupKey("12345 67890 12345 67890 12345 67891", salt, 5).toString("hex"), ref(5).toString("hex"));
  assert.equal(normalizePassphrase(" 1234 5-6 "), "123456");
});
test("HKDF-SHA256 usage matches RFC 5869 test case 1 (the primitive behind 'Backup Export')", () => {
  const ikm = Buffer.alloc(22, 0x0b), salt = Buffer.from("000102030405060708090a0b0c", "hex"), info = Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex");
  assert.equal(Buffer.from(hkdfSync("sha256", ikm, salt, info, 42)).toString("hex"), "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  const k = deriveFrameKeys(Buffer.alloc(32, 7)); assert.equal(k.cipherKey.length, 32); assert.equal(k.macKey.length, 32); assert.notDeepEqual(k.cipherKey, k.macKey);
});

// ---------------------------------------------------------------------------------------------------- frame layer
test("frames round-trip: statements with every parameter type, attachment blobs, preferences, end", async () => {
  const d = tmp(), f = join(d, "a.backup"), w = new LegacyBackupWriter(f, ids.PASS);
  w.version(7); w.statement("INSERT INTO t VALUES (?,?,?,?,?)", ["text ü 😀", -5, 2.5, Buffer.from([0, 1, 255]), null]); w.keyValue("account.aci", ids.ME);
  const big = Buffer.alloc(3 * 1024 * 1024 + 17, 9); w.attachment(4, 99, big); w.avatar("a", Buffer.from("x")); w.preference("f", "k", "v"); w.end(); w.close();
  const items = await collect(f, ids.PASS), kinds = items.map((i) => i.frame.kind);
  assert.deepEqual(kinds, ["version", "statement", "keyvalue", "attachment", "avatar", "preference", "end"]);
  const st = items[1].frame; assert.deepEqual(st.params.slice(0, 3), ["text ü 😀", -5, 2.5]); assert.deepEqual(st.params[3], Buffer.from([0, 1, 255])); assert.equal(st.params[4], null);
  assert.ok(items[3].blob.equals(big), "large attachment (several read chunks) decrypts byte-exact");
});
test("wrong passphrase, flipped bit, truncation, not-a-backup all give clear errors", async () => {
  const d = tmp(), f = join(d, "a.backup"); const w = new LegacyBackupWriter(f, ids.PASS); w.version(1); for (let i = 0; i < 50; i++) w.statement("INSERT INTO t VALUES (?)", ["row" + i]); w.attachment(1, 1, Buffer.alloc(5000, 3)); w.end(); w.close();
  await rejects(() => collect(f, "11111 11111 11111 11111 11111 11111"), "bad-passphrase", /Wrong passphrase/);
  await rejects(() => collect(f, "123"), "bad-passphrase", /30-digit/);
  const raw = readFileSync(f);
  const first = 4 + raw.readUInt32BE(0) + 6; // inside the first encrypted frame: indistinguishable from a wrong key
  for (const [at, code] of [[raw.length - 400, "corrupt"], [raw.length - 3, "corrupt"], [first, "bad-passphrase"]] as const) {
    const bad = Buffer.from(raw); bad[at]! ^= 1; const p = join(d, "bad.backup"); writeFileSync(p, bad);
    await rejects(() => collect(p, ids.PASS), code, /checksum|Wrong passphrase/);
  }
  const cut = join(d, "cut.backup"); writeFileSync(cut, raw.subarray(0, raw.length - 100)); await rejects(() => collect(cut, ids.PASS), "truncated");
  const junk = join(d, "junk.backup"); writeFileSync(junk, Buffer.alloc(500, 65)); await rejects(() => collect(junk, ids.PASS), "not-a-backup");
  const txt = join(d, "x.backup"); writeFileSync(txt, "hello world, definitely not a backup, but long enough to pass the size check....."); await rejects(() => collect(txt, ids.PASS), "not-a-backup");
});
test("unknown fields and frame kinds are tolerated", () => { assert.equal(parseFrame(Buffer.from([0x78, 0x01])).kind, "unknown"); }); // field 15, varint

// ---------------------------------------------------------------------------------------------------- SQL parsing
test("SQL: INSERT with parameters, literals, escapes, blobs, NULLs, multi-row, quoted identifiers", () => {
  const p = parseStatement(`INSERT INTO "sms" ("_id", \`body\`, [x]) VALUES (?, 'it''s "ok", (really);', NULL)`, [7]);
  assert.deepEqual(p, { kind: "insert", table: "sms", columns: ["_id", "body", "x"], rows: [[7, `it's "ok", (really);`, null]] });
  const q = parseStatement("insert or replace into t values (?1, ?2, X'00ff', -3, 4.5e1, 0x10, TRUE, 'a''''b'), (?, ?, 'z', 1, 2, 3, FALSE, '')", ["a", "b", "c", "d"]);
  assert.equal(q.kind, "insert"); if (q.kind === "insert") { assert.equal(q.columns, undefined); assert.deepEqual(q.rows[0], ["a", "b", Buffer.from([0, 255]), -3, 45, 16, 1, "a''b"]); assert.equal(q.rows[1]![2], "z"); assert.equal(q.rows[1]![0], "c"); }
  assert.equal(parseStatement("INSERT INTO t VALUES (?)", []).kind === "insert" && (parseStatement("INSERT INTO t VALUES (?)", []) as any).rows[0][0], null, "a missing parameter is NULL, never an error");
  assert.deepEqual((parseStatement("INSERT INTO t VALUES (9223372036854775807)", []) as any).rows[0][0], 9223372036854775807n);
});
test("SQL: statements that are not understood are ignored, never executed", () => {
  for (const s of ["DROP TABLE sms", "DELETE FROM sms", "INSERT INTO t VALUES (abs(1))", "INSERT INTO t SELECT * FROM x", "INSERT INTO t VALUES ('unterminated", "CREATE INDEX i ON t(a)", "PRAGMA user_version=5", "", "-- comment", "INSERT INTO t VALUES (1); DROP TABLE x"]) {
    const r = parseStatement(s, []); assert.ok(r.kind === "other" || r.kind === "insert", s); if (r.kind === "insert") assert.deepEqual(r.rows, [[1]]); // trailing statements after the first VALUES are not run
  }
  assert.equal(tokenize("x".repeat(9 * 1024 * 1024)), undefined, "oversized statements are refused");
});
test("SQL: CREATE TABLE column order (constraints, defaults, nested parentheses, quoted names) and positional rows", () => {
  const c = parseStatement("CREATE TABLE IF NOT EXISTS main.sms (_id INTEGER PRIMARY KEY AUTOINCREMENT, `a b` TEXT DEFAULT (lower('X,Y')), c, PRIMARY KEY (_id, c), UNIQUE(c), CONSTRAINT k CHECK (c > 0), d INTEGER REFERENCES t(id))", []);
  assert.deepEqual(c, { kind: "create", table: "sms", columns: ["_id", "a b", "c", "d"] });
  const s = new Schema(); s.note("sms", ["_id", "body"]);
  assert.deepEqual(s.row("sms", undefined, [1, "x"]), { _id: 1, body: "x" });
  assert.equal(s.row("other", undefined, [1]), undefined, "positional row of an unknown table is not interpreted");
  assert.equal(s.row("sms", ["a"], [1, 2]), undefined, "width mismatch is not interpreted");
});
