#!/usr/bin/env node
// Bundles the UniChat backend (@unimsg/host + store + all providers + the Android bridge entry) into ONE file that
// nodejs-mobile can run:   apps/android/build/nodejs-project/main.js   (+ sql-wasm.wasm, package.json, bundle-id.txt)
//
//   node scripts/build-backend-bundle.mjs                 build, then copy into android/app/src/main/assets/nodejs-project
//   node scripts/build-backend-bundle.mjs --smoke         build, then run scripts/smoke-test.mjs against the bundle (plain Node)
//   flags: --no-android   do not copy into the Android project
//          --with-libsignal   bundle the real @signalapp/libsignal-client; the native add-on is loaded from libsignal_client_node.so (jniLibs, built by
//                             scripts/build-libsignal-android.sh). Automatic when android/app/libsignal/bin/<abi>/libsignal_client_node.so exist; --no-libsignal forces the stub.
//          --probe            build the on-device provider probe (src/provider-probe.ts) to build/nodejs-probe/ instead (never copied into the APK)
//          --signal-tests     build packages/provider-signal's node:test files to build/nodejs-signal-tests/ (run on the emulator, see README)
//          --dht-smoke        bundle src/dht-smoke-entry.ts to build/nodejs-dht-smoke/ (HyperDHT over a LOCAL testnet; the host's own prebuilds are copied next to it) and run it with $SMOKE_NODE (default: this node)
//          --sourcemap        write main.js.map
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, existsSync, realpathSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { lowerUnicodeProps } from "./unicode-props.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");               // apps/android
const repo = resolve(root, "../..");
const args = new Set(process.argv.slice(2));
const probeMode = args.has("--probe") ? "probe" : args.has("--signal-tests") ? "signal-tests" : args.has("--dht-smoke") ? "dht-smoke" : "";
const outDir = join(root, "build", probeMode === "probe" ? "nodejs-probe" : probeMode === "signal-tests" ? "nodejs-signal-tests" : probeMode === "dht-smoke" ? "nodejs-dht-smoke" : "nodejs-project");
const androidAssets = join(root, "android/app/src/main/assets/nodejs-project");
const req = createRequire(join(root, "package.json"));

// nodejs-mobile (v18.x) is the oldest runtime we target. The bundle must not use syntax newer than that.
const TARGET = "node18";

/** `node:sqlite` does not exist in nodejs-mobile's Node 18: point packages/store-sqlite at our DatabaseSync adapter. */
const sqliteAlias = { name: "unimsg-sqlite-alias", setup(b) {
  b.onResolve({ filter: /^node:sqlite$/ }, () => ({ path: join(root, "src/sqlite-shim.ts") }));
} };
/** Baileys (WhatsApp) loads its image library with a guarded `import("jimp")` from inside the pnpm store, where jimp is not a dependency: resolve it
 *  from packages/provider-whatsapp (which depends on it) so group / profile pictures and link-preview thumbnails work on the phone too. */
const jimpAlias = { name: "unimsg-jimp-alias", setup(b) {
  b.onResolve({ filter: /^jimp$/ }, () => { try { return { path: createRequire(join(repo, "packages/provider-whatsapp/package.json")).resolve("jimp") }; } catch { return undefined; } });
} };

/**
 * @signalapp/libsignal-client is a native N-API add-on whose npm package ships prebuilds for darwin/linux(glibc)/win32 only,
 * nothing for Android (bionic). Without an android build of the add-on the Signal provider cannot work, but it must not
 * stop the other providers from loading: replace the module by a stub that exports every name provider-signal imports and
 * throws a clear error when used. Names are collected from the source, so the stub follows the provider automatically.
 */
function libsignalNames() {
  const names = new Set(), dir = join(repo, "packages/provider-signal/src");
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name)) {
      const s = readFileSync(p, "utf8");
      for (const m of s.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@signalapp\/libsignal-client[^"']*["']/g))
        for (const n of m[1].split(",")) { const id = n.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ""); if (id && !/^type\s/.test(n.trim())) names.add(id); }
    } } };
  walk(dir); return [...names];
}
const libsignalLibs = join(root, "android/app/libsignal/bin");
const haveLibsignal = !args.has("--no-libsignal") && (args.has("--with-libsignal") || existsSync(join(libsignalLibs, "arm64-v8a/libsignal_client_node.so")) || existsSync(join(libsignalLibs, "x86_64/libsignal_client_node.so")));
/** The real add-on: the JS of @signalapp/libsignal-client is bundled; its `node-gyp-build` (which only knows prebuilds/<platform>-<arch> directories) is replaced by a loader for libsignal_client_node.so. */
const libsignalLoader = { name: "unimsg-libsignal-loader", setup(b) {
  if (!haveLibsignal) return;
  b.onResolve({ filter: /^@signalapp\/libsignal-client\// }, (a) => a.importer.endsWith("libsignal-modules.ts") ? b.resolve(a.path, { resolveDir: join(repo, "packages/provider-signal"), kind: a.kind }) : undefined);
  b.onResolve({ filter: /^node-gyp-build$/ }, (a) => /libsignal-client/.test(a.importer) ? { path: join(root, "src/libsignal-loader.cjs") } : undefined);
} };
const libsignalStub = { name: "unimsg-libsignal-stub", setup(b) {
  if (haveLibsignal) return;
  b.onResolve({ filter: /^@signalapp\/libsignal-client(\/.*)?$/ }, (a) => ({ path: a.path, namespace: "libsignal-stub" }));
  b.onLoad({ filter: /.*/, namespace: "libsignal-stub" }, () => {
    const names = libsignalNames();
    const body = `const fail = () => { throw new Error("Signal is not available in this Android build: @signalapp/libsignal-client has no Android (bionic) build of its native add-on. Build one with apps/android/scripts/build-libsignal-android.sh and rebuild the bundle with --with-libsignal (see apps/android/README.md, section libsignal)."); };\n`
      + `const stub = new Proxy(function () {}, { get: (_, k) => (k === "prototype" ? {} : stub), apply: fail, construct: fail });\n`
      + names.map((n) => `export const ${n} = stub;`).join("\n") + "\nexport default stub;\n";
    return { contents: body, loader: "js" };
  });
} };

/**
 * HyperDHT ("Reach my devices from anywhere", packages/sync/src/dht.ts) needs two native add-ons, udx-native and sodium-native. Their `binding.js` locates prebuilds relative to the package,
 * which cannot work in a bundle (and "android" is not a platform node-gyp-build style loaders know): replace it by src/dht-native-loader.cjs. The modules are only loaded lazily, when the
 * user turns the DHT on, and a load failure becomes "not available on this platform" (never a crash), so this is safe even in a build without the .so files.
 */
const dhtNative = { name: "unimsg-dht-native", setup(b) {
  b.onLoad({ filter: /[\\/](udx-native|sodium-native)[\\/]binding\.js$/ }, (a) => {
    const name = /[\\/](udx-native|sodium-native)[\\/]binding\.js$/.exec(a.path)[1];
    return { contents: `module.exports = require(${JSON.stringify(join(root, "src/dht-native-loader.cjs"))})(${JSON.stringify(name)});`, loader: "js", resolveDir: root };
  });
} };

/** probe only: bare imports of the probe that live in a provider package's node_modules (pnpm is strict) */
const probeResolve = { name: "unimsg-probe-resolve", setup(b) {
  const from = { "matrix-js-sdk": "packages/provider-matrix", "@whiskeysockets/baileys": "packages/provider-whatsapp" };
  b.onResolve({ filter: /^hyperdht(\/testnet)?$/ }, (a) => a.importer.endsWith("dht-smoke-entry.ts") ? b.resolve(a.path, { resolveDir: join(repo, "packages/sync"), kind: a.kind }) : undefined);
  b.onResolve({ filter: /^(matrix-js-sdk|@whiskeysockets\/baileys)$/ }, (a) => a.importer.endsWith("provider-probe.ts")
    ? b.resolve(a.path, { resolveDir: join(repo, from[a.path]), kind: a.kind }) : undefined);
} };

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [join(root, probeMode === "probe" ? "src/provider-probe.ts" : probeMode === "signal-tests" ? "src/signal-tests-entry.ts" : probeMode === "dht-smoke" ? "src/dht-smoke-entry.ts" : "src/backend-entry.ts")],
  outfile: join(outDir, "main.js"),
  bundle: true, platform: "node", format: "esm", target: TARGET,
  sourcemap: args.has("--sourcemap"), legalComments: "none", logLevel: "info", metafile: true,
  // native / optional add-ons that must be resolved on the device at run time rather than bundled
  external: ["better-sqlite3", "bufferutil", "utf-8-validate", "sharp", "jimp", "link-preview-js", "audio-decode", "jimp-*", "@ffmpeg/*"],
  banner: { js: `import { createRequire as __unimsgCreateRequire } from "node:module";\nconst require = __unimsgCreateRequire(import.meta.url);\nimport { fileURLToPath as __unimsgF2P } from "node:url";\nimport { dirname as __unimsgDir } from "node:path";\nconst __filename = __unimsgF2P(import.meta.url);\nconst __dirname = __unimsgDir(__filename);\n// Node 18 (nodejs-mobile) has no global WebCrypto; Baileys and others expect it (Node >= 20 has it)\nif (!globalThis.crypto) globalThis.crypto = require(\"node:crypto\").webcrypto;\n// nodejs-mobile has no ICU: new TextDecoder(enc, {fatal:true}) throws ERR_NO_ICU (matrix-sdk-crypto-wasm glue does this at load). Emulate fatal for UTF-8 by rejecting U+FFFD in the result.\ntry { new TextDecoder(\"utf-8\", { fatal: true }); } catch { const Orig = globalThis.TextDecoder; class TD extends Orig { constructor(l, o) { super(l, o && o.fatal ? { ...o, fatal: false } : o); this.__f = !!(o && o.fatal); } decode(i, o) { const r = super.decode(i, o); if (this.__f && r.includes(\"\\ufffd\")) { const e = new TypeError(\"The encoded data was not valid for encoding utf-8\"); e.code = \"ERR_ENCODING_INVALID_ENCODED_DATA\"; throw e; } return r; } } globalThis.TextDecoder = TD; require(\"node:util\").TextDecoder = TD; }` },
  plugins: [sqliteAlias, jimpAlias, libsignalLoader, libsignalStub, dhtNative, probeResolve],
  supported: { "dynamic-import": true },
  define: { __UNICHAT_VERSION__: JSON.stringify(process.env.UNICHAT_VERSION || "dev") }, // shown in About, compared by the updater (CI sets 0.1.<run number>)
  mainFields: ["module", "main"], conditions: ["node", "import"],
}).catch((e) => { console.error(e.message); process.exit(1); });

// nodejs-mobile's V8 has no ICU: lower \p{..} regex escapes to explicit ranges (see scripts/unicode-props.mjs)
{ const f = join(outDir, "main.js"), r = lowerUnicodeProps(readFileSync(f, "utf8")); writeFileSync(f, r.code); console.log(`unicode property escapes lowered: ${r.count}`); }

// packages/provider-whatsapp runs on a pnpm-PATCHED Baileys (patches/@whiskeysockets__baileys@*.patch): fail the build if the bundle contains the unpatched copy
if (!probeMode && !readFileSync(join(outDir, "main.js"), "utf8").includes('polltype: "vote"')) { console.error("the bundle contains an UNPATCHED @whiskeysockets/baileys (run pnpm install so patchedDependencies apply)"); process.exit(1); }

// sql.js needs its wasm next to main.js (sqlite-shim.ts looks there first)
cpSync(req.resolve("sql.js/dist/sql-wasm.wasm"), join(outDir, "sql-wasm.wasm"));
// matrix-sdk-crypto-wasm reads pkg/matrix_sdk_crypto_wasm_bg.wasm relative to the bundle at run time (found on the emulator: Matrix crypto init died with ENOENT without it)
{ const sdk = realpathSync(join(repo, "packages/provider-matrix/node_modules/matrix-js-sdk"));   // pnpm: the wasm package is a sibling of the SDK in the store
  const wasm = join(dirname(sdk), "@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm");
  mkdirSync(join(outDir, "pkg"), { recursive: true }); cpSync(wasm, join(outDir, "pkg/matrix_sdk_crypto_wasm_bg.wasm")); }
writeFileSync(join(outDir, "package.json"), JSON.stringify({ name: "unimsg-nodejs-project", private: true, type: "module", main: "main.js" }, null, 2) + "\n");
const h = createHash("sha256");
for (const f of ["main.js", "sql-wasm.wasm", "pkg/matrix_sdk_crypto_wasm_bg.wasm", "package.json"]) h.update(readFileSync(join(outDir, f)));
writeFileSync(join(outDir, "bundle-id.txt"), h.digest("hex").slice(0, 16) + "\n"); // Java re-extracts the project when this changes (not a dotfile: Android's asset packer drops those)

const kb = (n) => (n / 1024).toFixed(0) + " KiB";
console.log(`libsignal: ${haveLibsignal ? "REAL (bundled JS + libsignal_client_node.so)" : "STUB (no android add-on built)"}`);
console.log(`bundle: ${relative(repo, join(outDir, "main.js"))}  ${kb(statSync(join(outDir, "main.js")).size)}  target=${TARGET}  inputs=${Object.keys(result.metafile.inputs).length}`);
const externals = new Set();
for (const o of Object.values(result.metafile.outputs)) for (const i of o.imports) if (i.external && !i.path.startsWith("node:")) externals.add(i.path);
if (externals.size) console.log("left external (resolved at run time):", [...externals].join(", "));

if (!args.has("--no-android") && !probeMode && existsSync(join(root, "android/app/src/main"))) {
  rmSync(androidAssets, { recursive: true, force: true });
  cpSync(outDir, androidAssets, { recursive: true });
  console.log("copied to", relative(repo, androidAssets));
}

if (probeMode === "dht-smoke") {
  // the host platform's prebuilds of the two add-ons, where src/dht-native-loader.cjs looks (<bundle>/prebuilds/<platform>-<arch>/<name>.node)
  const plat = `${process.platform}-${process.arch}`;
  const fromSync = createRequire(join(repo, "packages/sync/package.json")), fromDht = createRequire(realpathSync(fromSync.resolve("hyperdht")));
  for (const n of ["udx-native", "sodium-native"]) {
    const dir = dirname(realpathSync(fromDht.resolve(n + "/package.json")));
    mkdirSync(join(outDir, "prebuilds", plat), { recursive: true }); cpSync(join(dir, "prebuilds", plat, n + ".node"), join(outDir, "prebuilds", plat, n + ".node"));
  }
  const node = process.env.SMOKE_NODE || process.execPath;
  const r = spawnSync(node, [join(outDir, "main.js")], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
if (args.has("--smoke")) {
  const r = spawnSync(process.execPath, [join(here, "smoke-test.mjs"), join(outDir, "main.js")], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
