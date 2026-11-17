#!/usr/bin/env node
// Downloads the nodejs-mobile Android prebuilt and unpacks it to android/app/libnode/{include,bin/<abi>/libnode.so}.
//   node scripts/fetch-nodejs-mobile.mjs [--version 18.20.4] [--sha256 <hex> | --sha256-file <file>] [--pin] [--zip <local.zip>]
// Asset: https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v<ver>/nodejs-mobile-v<ver>-android.zip (name confirmed from the release API).
// VERIFICATION IS MANDATORY. The expected sha256 comes from, in order: --sha256, --sha256-file (a `sha256sum` style file, or a bare hex),
// or the committed pin file scripts/nodejs-mobile.sha256 ("<hex>  nodejs-mobile-v<ver>-android.zip" lines). Upstream publishes no checksums,
// so with none of these the script REFUSES to unpack. Every run prints the computed hash AND the expected one, so both can be compared with an
// independent source (how to do that: apps/android/README.md, "nodejs-mobile download").
// `--pin` appends the computed hash to the pin file (trust-on-first-use: do it once, on a trusted network, then commit the file).
// `--zip <file>` hashes (and unpacks) a copy downloaded elsewhere, e.g. on another machine, instead of downloading it here.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
const a = process.argv.slice(2), opt = (n, d) => (a.includes(n) ? a[a.indexOf(n) + 1] : d);
const here = dirname(fileURLToPath(import.meta.url));
const ver = opt("--version", "18.20.4");
const asset = `nodejs-mobile-v${ver}-android.zip`;
const url = `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${ver}/${asset}`;
const pinFile = join(here, "nodejs-mobile.sha256");
const dest = resolve(here, "../android/app/libnode");

function expected() {
  const cli = opt("--sha256");
  if (cli) return { hex: cli.toLowerCase(), from: "--sha256" };
  const read = (f, from) => {
    const lines = readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const l of lines) { const [h, n] = l.split(/\s+/); if (/^[0-9a-f]{64}$/i.test(h) && (!n || n.replace(/^\*/, "") === asset)) return { hex: h.toLowerCase(), from }; }
  };
  const sf = opt("--sha256-file"); if (sf) return read(sf, sf);
  if (existsSync(pinFile)) return read(pinFile, "scripts/nodejs-mobile.sha256");
}
const want = expected();
if (!want && !a.includes("--pin")) {
  console.error(`No expected sha256 for ${asset}. Provide --sha256 <hex>, --sha256-file <file>, or run once with --pin (trust on first use: it prints and records the hash, which you then verify as described in apps/android/README.md).`);
  process.exit(2);
}
const tmp = mkdtempSync(join(tmpdir(), "nodejs-mobile-"));
let zip = opt("--zip");
if (!zip) {
  zip = join(tmp, "n.zip");
  console.log("downloading", url);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) { console.error(`download failed: HTTP ${res.status}`); process.exit(1); }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
}
const h = createHash("sha256"); await pipeline(createReadStream(zip), h);
const sum = h.digest("hex");
// Both hashes are printed in full, every run: the pin is trust-on-first-use, so a human must be able to compare it with an
// independent source (README "nodejs-mobile download") without opening the pin file.
console.log(`sha256 computed ${sum}  ${asset}`);
if (want) {
  console.log(`sha256 expected ${want.hex}  (from ${want.from})`);
  if (want.hex !== sum) { console.error("sha256 MISMATCH; refusing to unpack"); rmSync(tmp, { recursive: true, force: true }); process.exit(1); }
  console.log("sha256 verified: the download matches the pin. The pin's own origin: see apps/android/README.md, \"nodejs-mobile download\".");
} else {
  appendFileSync(pinFile, `${sum}  ${asset}\n`);
  console.log("pinned in", pinFile, "(trust on first use; commit it)");
}
const r = spawnSync("unzip", ["-q", zip, "-d", join(tmp, "x")], { stdio: "inherit" });
if (r.status !== 0) { console.error("unzip failed (is `unzip` installed?)"); process.exit(1); }
// archive layout differs between releases: find the directories that hold bin/<abi>/libnode.so and include/node/node.h
const find = (name) => spawnSync("find", [join(tmp, "x"), "-type", "d", "-name", name], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
const bin = find("bin").find((d) => existsSync(join(d, "arm64-v8a/libnode.so"))), inc = find("include").find((d) => existsSync(join(d, "node/node.h")));
if (!bin || !inc) { console.error("unexpected archive layout: bin/<abi>/libnode.so or include/node/node.h not found under", join(tmp, "x")); process.exit(1); }
rmSync(dest, { recursive: true, force: true }); mkdirSync(dest, { recursive: true });
cpSync(bin, join(dest, "bin"), { recursive: true });
cpSync(inc, join(dest, "include"), { recursive: true });
rmSync(tmp, { recursive: true, force: true });
console.log("unpacked to", dest);
