// Android embedded-Node assumptions that can be checked without a phone: the code that ships in the nodejs-mobile bundle (Node 18, no ICU, no node:sqlite)
// must not use newer Node/JS APIs. The full suite under a real Node 18 binary is `pnpm --filter @unimsg/sync test:node18`.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, scryptSync, generateKeyPairSync, diffieHellman, randomBytes } from "node:crypto";

// the node18 runner bundles the tests into a scratch dir, where import.meta.url no longer points into the repo: it passes the real packages dir
const root = process.env.UNIMSG_PACKAGES ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = (pkg: string) => { const out: string[] = []; const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === "node_modules" || n === "dist") continue; if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n) && !/testkit/.test(n)) out.push(p); } }; walk(join(root, pkg, "src")); return out; };
const BAD: [RegExp, string][] = [
  [/\bArray\.fromAsync\b/, "Array.fromAsync (Node 22)"], [/\bPromise\.withResolvers\b/, "Promise.withResolvers (Node 22)"], [/\.(toSorted|toReversed|toSpliced)\(/, "change-array-by-copy (Node 20)"],
  [/\b(Object|Map)\.groupBy\b/, "groupBy (Node 21)"], [/\bimport\.meta\.(dirname|filename)\b/, "import.meta.dirname/filename (Node 20.11)"], [/\bprocess\.getBuiltinModule\b/, "process.getBuiltinModule (Node 22)"],
  [/\.(union|intersection|difference|isSubsetOf)\(/, "Set methods (Node 22)"], [/\bstyleText\b/, "util.styleText (Node 20)"], [/\bfs\.glob|\bglobSync\b/, "fs.glob (Node 22)"], [/\bAbortSignal\.any\b/, "AbortSignal.any (Node 20.3)"],
  [/\.(isWellFormed|toWellFormed)\(/, "String well-formed (Node 20)"], [/\bArray\.prototype\.with\b|\.with\(\d/, "Array.with (Node 20)"], [/\bnew Float16Array|\bIterator\.from\b/, "iterator helpers (Node 22)"],
  [/\.(findLast|findLastIndex)\(/, ""],
];
test("android: sync, core and the stores avoid APIs newer than Node 18 (nodejs-mobile)", () => {
  const hits: string[] = [];
  for (const pkg of ["sync", "core", "store-sqlite", "host"]) for (const f of src(pkg)) {
    const text = readFileSync(f, "utf8").split("\n");
    text.forEach((line, i) => { if (/^\s*(\/\/|\*)/.test(line)) return; for (const [re, what] of BAD) if (what && re.test(line)) hits.push(`${f.slice(root.length + 1)}:${i + 1} ${what}`); });
  }
  assert.deepEqual(hits, []);
});
test("android: only the store package and the shim touch node:sqlite (the bundle aliases it to sql.js); sync uses no native add-on", () => {
  const bad: string[] = [];
  for (const pkg of ["sync", "core", "host"]) for (const f of src(pkg)) {
    const t = readFileSync(f, "utf8"); // (the ledger imports node:sqlite too: the bundle aliases it to the same sql.js shim)
    if (/from "node:sqlite"|require\("node:sqlite"\)/.test(t) && !f.endsWith("sync/src/ledger.ts")) bad.push(f);
    if (/\bbetter-sqlite3\b/.test(t)) bad.push(f);
  }
  assert.deepEqual(bad, [], "sync / core / host must go through the Store abstraction");
});
test("android: HyperDHT (native add-ons udx-native / sodium-native) is only ever loaded lazily from dht.ts, so the app starts when it is missing", () => {
  const users = src("sync").concat(src("core"), src("host")).filter((f) => !f.endsWith(".d.ts") && /["']hyperdht["']/.test(readFileSync(f, "utf8")));
  assert.deepEqual(users.map((f) => f.slice(root.length + 1)), ["sync/src/dht.ts"]);
  const t = readFileSync(join(root, "sync/src/dht.ts"), "utf8");
  assert.ok(!/^import .* from "hyperdht"/m.test(t) && /await import\("hyperdht"\)/.test(t), "dynamic import only (a static one would load the add-ons at start-up)");
  assert.match(t, /not available on this platform/);
});
test("android: every crypto primitive the sync channel needs exists with the Node 18 signatures (X25519, ChaCha20-Poly1305 with AAD, HKDF, scrypt, HMAC, AES-GCM)", () => {
  const a = generateKeyPairSync("x25519"), b = generateKeyPairSync("x25519");
  assert.ok(diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey }).equals(diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey })));
  const k = randomBytes(32), n = randomBytes(12), c = createCipheriv("chacha20-poly1305", k, n, { authTagLength: 16 }); c.setAAD(Buffer.from("aad"), { plaintextLength: 2 });
  const ct = Buffer.concat([c.update("hi"), c.final()]), tag = c.getAuthTag(), d = createDecipheriv("chacha20-poly1305", k, n, { authTagLength: 16 }); d.setAAD(Buffer.from("aad"), { plaintextLength: 2 }); d.setAuthTag(tag);
  assert.equal(Buffer.concat([d.update(ct), d.final()]).toString(), "hi");
  assert.equal(Buffer.from(hkdfSync("sha256", k, Buffer.alloc(0), "x", 32)).length, 32); assert.equal(scryptSync("p", "s", 32, { N: 1 << 14 }).length, 32); assert.equal(createHmac("sha256", k).update("x").digest().length, 32);
  const g = createCipheriv("aes-256-gcm", k, n); g.update("x"); g.final(); assert.equal(g.getAuthTag().length, 16);
});
test("android: nodejs-mobile has no ICU and a bare os.tmpdir(): sync code derives every path from its data dir, never from tmpdir or the environment", () => {
  const bad: string[] = [];
  for (const f of src("sync")) { const t = readFileSync(f, "utf8"); if (/\btmpdir\b|\bhomedir\(\)|process\.env\.HOME/.test(t)) bad.push(f.slice(root.length + 1)); }
  assert.deepEqual(bad, []);
  const fallbacks = readFileSync(join(root, "sync/src/service.ts"), "utf8").split("\n").filter((l) => /process\.env\.TMPDIR/.test(l)).length;
  assert.equal(fallbacks, 2, "only the two no-directory (tests) fallbacks read TMPDIR");
  assert.match(readFileSync(join(root, "host/src/index.ts"), "utf8"), /attachSync\(hub, syncStore!, \{ dir: dataDir/, "the host always passes the data dir to sync");
});
test("android: the Node 18 runner and the pinned runtime are wired (script exists, checksum pinned, sql.js shim present)", () => {
  assert.ok(statSync(join(root, "sync/scripts/node18.mjs")).isFile());
  assert.match(readFileSync(join(root, "../apps/android/scripts/nodejs-mobile.sha256"), "utf8"), /[0-9a-f]{64}/);
  assert.ok(statSync(join(root, "../apps/android/src/sqlite-shim.ts")).isFile());
});
test("android: the device-to-device move runs on Node 18 + the sql.js shim: only node:crypto/fs/path, state in the ledger kv, staging sealed with AES-GCM + AAD, frames fit", async () => {
  const t = readFileSync(join(root, "sync/src/move.ts"), "utf8");
  const imports = [...t.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["@unimsg/core", "node:crypto", "node:fs", "node:path"], "no os / sqlite / streams / fetch / worker APIs in the move path");
  assert.ok(!/node:sqlite|better-sqlite3|process\.env|tmpdir|fs\/promises|structuredClone|AbortSignal|\.at\(-?\d/.test(t), "nothing the nodejs-mobile build lacks");
  assert.match(t, /kv\.(get|set)|d\.kv/, "records go through the ledger kv (sql.js shim on the phone), never a new database");
  const hub = readFileSync(join(root, "core/src/hub.ts"), "utf8"), mi = hub.slice(hub.indexOf("private async moveInstall"), hub.indexOf("private reloadAliases"));
  assert.ok(mi.length > 500 && !/fs\/promises|readFile\(|writeFile\(|node:sqlite/.test(mi), "Hub.moveInstall uses sync fs calls only");
  // the primitives it needs, with the Node 18 signatures
  const k = randomBytes(32), iv = randomBytes(12), c = createCipheriv("aes-256-gcm", k, iv); c.setAAD(Buffer.from("tid:0")); const ct = Buffer.concat([c.update(Buffer.alloc(1000, 7)), c.final()]), tag = c.getAuthTag();
  const d = createDecipheriv("aes-256-gcm", k, iv); d.setAAD(Buffer.from("tid:0")); d.setAuthTag(tag); assert.equal(Buffer.concat([d.update(ct), d.final()]).length, 1000);
  const { MOVE_LIMITS } = await import("./move.js"), { MAX_FRAME } = await import("./channel.js");
  const frame = JSON.stringify({ t: "mv-chunk", mv: 1, tid: "0".repeat(32), f: 99, i: 99999, d: randomBytes(MOVE_LIMITS.chunk).toString("base64") });
  assert.ok(frame.length < MAX_FRAME - 64, "a chunk always fits one channel frame");
});
