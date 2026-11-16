#!/usr/bin/env node
// usage: node scripts/arch-pkgbuild.mjs <artifacts dir> <version>   -> writes <artifacts dir>/PKGBUILD for the release's pacman package
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [dir, version] = process.argv.slice(2);
if (!dir || !version) { console.error("usage: arch-pkgbuild.mjs <artifacts dir> <version>"); process.exit(2); }
const pkg = join(dir, `unichat-desktop-${version}.pkg.tar.zst`);
if (!existsSync(pkg)) { console.log("no pacman package in this release, PKGBUILD skipped"); process.exit(0); }
const sha = createHash("sha256").update(readFileSync(pkg)).digest("hex");
const tpl = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "packaging", "arch", "PKGBUILD.in"), "utf8");
writeFileSync(join(dir, "PKGBUILD"), tpl.replaceAll("@VERSION@", version).replaceAll("@SHA256@", sha));
console.log(`PKGBUILD for ${version} (sha256 ${sha.slice(0, 12)}...)`);
