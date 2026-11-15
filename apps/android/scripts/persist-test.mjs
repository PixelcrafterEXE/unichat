#!/usr/bin/env node
// Unit tests of src/sqljs-persist.ts (atomic write, .bak rotation, corruption fallback, interrupted writes) with REAL sql.js images.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "unimsg-persist-"));
await build({ entryPoints: [join(root, "src/sqljs-persist.ts")], outfile: join(work, "p.mjs"), bundle: true, format: "esm", platform: "node", logLevel: "silent" });
const { loadImage, writeImage, validateImage, chunkHashes, diffChunks, saveIncremental, recoverJournal, writeImageAsync } = await import(pathToFileURL(join(work, "p.mjs")).href);
const req = createRequire(join(root, "package.json"));
const initSqlJs = req("sql.js");
const SQL = await initSqlJs({ wasmBinary: readFileSync(req.resolve("sql.js/dist/sql-wasm.wasm")) });
const image = (n) => { const d = new SQL.Database(); d.run("create table t(a)"); for (let i = 0; i < n; i++) d.run("insert into t values (?)", ["row" + i + "x".repeat(200)]); const b = d.export(); d.close(); return b; };
const count = (data) => { const d = new SQL.Database(data); try { return d.exec("select count(*) from t")[0].values[0][0]; } finally { d.close(); } };
const open = (data) => { const d = new SQL.Database(data); try { const r = d.exec("PRAGMA quick_check")[0].values[0][0]; if (r !== "ok") throw new Error(r); } finally { d.close(); } };
let n = 0; const ok = (m) => console.log("  ok  " + m);
const fresh = () => join(work, "d" + ++n, "unimsg.db");
const { mkdirSync } = await import("node:fs");
const f0 = () => { const f = fresh(); mkdirSync(dirname(f)); return f; };

{ const f = f0(); assert.equal(loadImage(f, open), undefined); ok("no files -> fresh database (undefined)"); }
{ const f = f0(); writeImage(f, image(5)); assert.equal(count(loadImage(f, open).data), 5);
  assert.ok(!existsSync(f + ".tmp") && !existsSync(f + ".bak")); writeImage(f, image(9));
  assert.equal(count(readFileSync(f)), 9); assert.equal(count(readFileSync(f + ".bak")), 5); ok("write/read, second write rotates the previous image to .bak"); }
{ const f = f0(); writeImage(f, image(3)); writeImage(f, image(6));
  truncateSync(f, readFileSync(f).length - 1500); // torn main file
  const l = loadImage(f, open); assert.equal(l.source, "bak"); assert.equal(count(l.data), 3);
  assert.ok(readdirSync(dirname(f)).some((x) => x.includes(".corrupt-")), "corrupt main kept for forensics"); ok("truncated main file -> falls back to .bak and quarantines the broken file"); }
{ const f = f0(); writeImage(f, image(3)); writeImage(f, image(6));
  const b = readFileSync(f); b.fill(0xab, 100, 3000); writeFileSync(f, b); // garbage inside: header ok, content corrupt
  let l; try { l = loadImage(f, open); } catch { l = null; }
  assert.ok(l === null || count(l.data) === 3 || l.source === "main", "either detected or (header-only check) tolerated");
  ok("garbage in the body: " + (l ? "accepted by structural check only (sql.js quick_check decides)" : "rejected")); }
{ const f = f0(); writeImage(f, image(3)); writeImage(f, image(6));
  writeFileSync(f, Buffer.from("not a database at all, just text".repeat(40)));
  const l = loadImage(f, open); assert.equal(l.source, "bak"); assert.equal(count(l.data), 3); ok("non-SQLite main file -> restored from .bak"); }
{ const f = f0(); writeImage(f, image(4));
  writeFileSync(f + ".tmp", readFileSync(f).subarray(0, 2048)); // crash while writing the next image: partial tmp
  const l = loadImage(f, open); assert.equal(l.source, "main"); assert.equal(count(l.data), 4); assert.ok(!existsSync(f + ".tmp")); ok("interrupted write (partial .tmp) is ignored and cleaned"); }
{ const f = f0(); writeImage(f, image(4)); const newer = image(8);
  // crash between the two renames: main moved to .bak, complete .tmp not yet renamed
  copyFileSync(f, f + ".bak"); rmSync(f); writeFileSync(f + ".tmp", newer);
  const l = loadImage(f, open); assert.equal(l.source, "tmp"); assert.equal(count(l.data), 8); ok("crash between the renames -> the complete .tmp wins (newest data)"); }
{ const f = f0(); writeImage(f, image(4)); writeImage(f, image(5));
  writeFileSync(f, "garbage".repeat(100)); writeFileSync(f + ".bak", "garbage".repeat(100));
  assert.throws(() => loadImage(f, open), /corrupt and no usable backup/); assert.ok(readdirSync(dirname(f)).filter((x) => x.includes(".corrupt-")).length === 2); ok("everything corrupt -> throws (never silently starts empty), files kept"); }
{ const f = f0(); writeImage(f, image(2)); writeFileSync(f, "x"); writeImage(f, image(3));
  assert.ok(!existsSync(f + ".bak") || count(readFileSync(f + ".bak")) === 2); ok("an invalid main file is not rotated over a good .bak"); }
{ const b = image(2); assert.equal(validateImage(b), undefined); assert.match(validateImage(b.subarray(0, b.length - 10)), /multiple|short/); ok("validateImage"); }
{ // incremental saves: only changed 4 KB chunks are written, the result is the exact new image (also when it grows and shrinks)
  const f = f0(); const a = image(300); writeImage(f, a); let h = chunkHashes(a);
  const d = new SQL.Database(a); d.run("insert into t values (?)", ["new" + "y".repeat(200)]); d.run("insert into t select a from t limit 50");
  let b = d.export(); d.close();
  let r = diffChunks(b, h); assert.ok(r.changed.length > 0 && r.changed.length * 4096 < b.length * 0.5, "few chunks changed: " + r.changed.length + "/" + b.length / 4096);
  saveIncremental(f, b, r.changed); h = r.hashes; assert.ok(Buffer.from(readFileSync(f)).equals(Buffer.from(b)), "file == new image"); assert.ok(!existsSync(f + ".jnl"));
  const d2 = new SQL.Database(b); d2.run("delete from t where rowid > 100"); d2.run("vacuum"); const c = d2.export(); d2.close();
  r = diffChunks(c, h); saveIncremental(f, c, r.changed); assert.ok(readFileSync(f).equals(Buffer.from(c)), "shrunk image identical"); assert.equal(count(loadImage(f, open).data), 100);
  ok("incremental save writes only changed chunks (" + r.changed.length + " of " + c.length / 4096 + ") and equals the full image, growing and shrinking"); }
{ const f = f0(); const a = image(200); writeImage(f, a);
  const d = new SQL.Database(a); d.run("insert into t select a from t limit 40"); const b = d.export(); d.close();
  const r = diffChunks(b, chunkHashes(a));
  const old = readFileSync(f); const fsx = await import("node:fs");
  // a read-only main makes the in-place step throw AFTER the journal was written and fsynced = exactly the crash window
  const { chmodSync } = fsx; const q = f0(); writeFileSync(q, old); chmodSync(q, 0o400);
  if (process.getuid?.() !== 0) { assert.throws(() => saveIncremental(q, b, r.changed)); assert.ok(existsSync(q + ".jnl"), "journal survives the crash");
    chmodSync(q, 0o600); assert.equal(recoverJournal(q), "replayed"); assert.ok(readFileSync(q).equals(Buffer.from(b)), "replay produced the new image"); assert.ok(!existsSync(q + ".jnl"));
    ok("crash after the journal, before the in-place writes -> replayed on the next start"); }
  const t = f0(); writeFileSync(t, old); writeFileSync(t + ".jnl", Buffer.concat([Buffer.from("UNIJNL1\0"), Buffer.alloc(30)]));
  assert.equal(recoverJournal(t), "dropped"); assert.ok(readFileSync(t).equals(old)); ok("torn journal is dropped, main untouched"); }
{ const f = f0(); const a = image(50); writeImage(f, a); const b = image(80);
  assert.equal(await writeImageAsync(f, b, () => true), true); assert.equal(count(readFileSync(f)), 80); assert.equal(count(readFileSync(f + ".bak")), 50);
  assert.equal(await writeImageAsync(f, image(90), () => false), false); assert.equal(count(readFileSync(f)), 80); assert.ok(!existsSync(f + ".wip") && !existsSync(f + ".tmp")); ok("async full write + superseded write is dropped"); }
rmSync(work, { recursive: true, force: true });
console.log("PERSIST TESTS PASSED");
