#!/usr/bin/env node
// Runs the sync test suites under a Node 18 binary (nodejs-mobile, what the Android app embeds): crypto primitives, Noise handshake + channel,
// CRDTs, addresses, and the integration tests with real Hubs, using the same sql.js engine shim the Android bundle uses (node:sqlite does not exist on Node 18).
//   SMOKE_NODE=/path/to/node-v18.x/bin/node node scripts/node18.mjs [filter]       (default: any node18 found next to the project's scratch dir)
// The tests are bundled with esbuild (target node18) into ~/unichat-build/node18-sync, nothing is written elsewhere.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)), pkg = resolve(here, ".."), repo = resolve(pkg, "../..");
const { build } = createRequire(join(repo, "apps/android/package.json"))("esbuild"); // esbuild lives with the Android build tooling
const node = process.env.SMOKE_NODE;
if (!node || !existsSync(node)) { console.error("Set SMOKE_NODE to a Node 18 binary (see apps/android/README.md, smoke test)."); process.exit(2); }
const ver = spawnSync(node, ["-p", "process.version"]).stdout.toString().trim(); if (!/^v18\./.test(ver)) console.warn("warning: SMOKE_NODE is", ver, "not v18");
const out = join(process.env.UNIMSG_SCRATCH || join(homedir(), "unichat-build"), "node18-sync"); rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
cpSync(createRequire(join(repo, "apps/android/package.json")).resolve("sql.js/dist/sql-wasm.wasm"), join(out, "sql-wasm.wasm")); // the shim looks for it next to the bundle
const shim = join(repo, "apps/android/src/sqlite-shim.ts");
const alias = { name: "sqlite-alias", setup(b) { b.onResolve({ filter: /^node:sqlite$/ }, () => ({ path: shim })); } };
const filter = process.argv[2];
const tests = readdirSync(join(pkg, "src")).filter((f) => f.endsWith(".test.ts") && f !== "dht.test.ts" && (!filter || f.includes(filter))); // dht.test.ts needs the native add-ons through the Android loader: covered by `node apps/android/scripts/build-backend-bundle.mjs --dht-smoke` under the same Node 18
for (const t of tests) {
  await build({ stdin: { contents: `import { prepareSqlite } from ${JSON.stringify(shim)};\nawait prepareSqlite();\nawait import(${JSON.stringify(join(pkg, "src", t))});\n`, resolveDir: pkg, loader: "ts" }, outfile: join(out, t.replace(/\.ts$/, ".mjs")),
    bundle: true, platform: "node", format: "esm", target: "node18", logLevel: "error", plugins: [alias], external: ["better-sqlite3", "bufferutil", "utf-8-validate"], mainFields: ["module", "main"], conditions: ["node", "import"],
    banner: { js: `import { createRequire as __cr } from "node:module"; import { fileURLToPath as __f2p } from "node:url"; import { dirname as __dn } from "node:path"; const require = __cr(import.meta.url); const __filename = __f2p(import.meta.url); const __dirname = __dn(__filename);` } });
}
const env = { ...process.env, UNIMSG_SQLITE: "sqljs", UNIMSG_PACKAGES: join(repo, "packages"), UNIMSG_SQLJS_FLUSH_MS: "100", TMPDIR: out };
console.log(`running ${tests.length} suites with ${node} (${ver}), sqlite engine: sql.js`);
const r = spawnSync(node, ["--test", ...tests.map((t) => join(out, t.replace(/\.ts$/, ".mjs")))], { stdio: "inherit", env, cwd: out });
process.exit(r.status ?? 1);
