#!/usr/bin/env node
// Writes latest.json, the release manifest the apps' updater reads (packages/core/src/updater.ts parseManifest), next to the release artifacts.
//   node scripts/release-manifest.mjs <artifacts dir> <version, e.g. 0.1.37> [notes]
// asset keys: android (*.apk), desktop-linux-appimage (*.AppImage), desktop-linux-deb (*.deb), desktop-linux-pacman (*.pkg.tar.zst), desktop-linux-flatpak (*.flatpak). A platform whose build failed is simply absent.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, version, notesArg = ""] = process.argv.slice(2);
if (!dir || !/^\d+\.\d+\.\d+$/.test(version ?? "")) { console.error("usage: release-manifest.mjs <artifacts dir> <version x.y.z> [notes]"); process.exit(2); }
const KEYS = [["android", /\.apk$/], ["desktop-linux-appimage", /\.AppImage$/], ["desktop-linux-deb", /\.deb$/], ["desktop-linux-pacman", /\.pkg\.tar\.zst$/], ["desktop-linux-flatpak", /\.flatpak$/]];
const files = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).sort();
const assets = {};
for (const [key, re] of KEYS) {
  const hits = files.filter((n) => re.test(n));
  if (hits.length !== 1) { if (hits.length > 1) console.warn(`::warning::${key}: ${hits.length} candidates (${hits.join(", ")}); skipped`); else console.warn(`::warning::${key}: no file; the apps on that platform get no update from this release`); continue; }
  const b = readFileSync(join(dir, hits[0]));
  assets[key] = { name: hits[0], size: b.length, sha256: createHash("sha256").update(b).digest("hex") };
}
const notes = notesArg.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 8).join("\n").slice(0, 600);
const manifest = { version, publishedAt: new Date().toISOString(), notes, assets };
writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
