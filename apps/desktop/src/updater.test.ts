import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appVersion, desktopAsset, linuxPackageType, replaceAppImage } from "./updater.js";

test("asset selection: AppImage self-updates, other packaged Linux installs are manual, dev runs and other OS none", () => {
  assert.deepEqual(desktopAsset({ APPIMAGE: "/home/u/UniChat.AppImage" }, "linux", true), { key: "desktop-linux-appimage", mode: "self" });
  assert.deepEqual(desktopAsset({}, "linux", true), { key: "desktop-linux-deb", mode: "manual" });
  assert.deepEqual(desktopAsset({}, "linux", true, "pacman\n"), { key: "desktop-linux-pacman", mode: "manual" });
  assert.deepEqual(desktopAsset({}, "linux", true, "deb"), { key: "desktop-linux-deb", mode: "manual" });
  assert.deepEqual(desktopAsset({ APPIMAGE: "/x" }, "linux", true, "pacman"), { key: "desktop-linux-appimage", mode: "self" });
  assert.equal(desktopAsset({ APPIMAGE: "/x" }, "linux", false), undefined);
  assert.equal(desktopAsset({}, "win32", true), undefined);
  assert.equal(desktopAsset({}, "darwin", true), undefined);
});

test("version: CI versions pass, local builds are dev", () => {
  assert.equal(appVersion("0.1.37"), "0.1.37"); assert.equal(appVersion("0.0.0-dev"), "dev"); assert.equal(appVersion("garbage"), "dev"); assert.equal(appVersion("0.1.17-dev.202611231530"), "0.1.17-dev.202611231530");
});

test("replaceAppImage keeps a backup, swaps atomically and keeps the executable bit", () => {
  const d = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "appimg-"));
  try {
    const cur = join(d, "UniChat.AppImage"), nw = join(d, "dl.AppImage");
    writeFileSync(cur, "old"); writeFileSync(nw, "new");
    const r = replaceAppImage(cur, nw);
    assert.equal(readFileSync(cur, "utf8"), "new"); assert.equal(readFileSync(r.backup, "utf8"), "old"); assert.ok(statSync(cur).mode & 0o100);
    assert.deepEqual(readdirSync(d).sort(), ["UniChat.AppImage", "UniChat.AppImage.bak", "dl.AppImage"], "no temp file left");
    writeFileSync(nw, "newer"); replaceAppImage(cur, nw); assert.equal(readFileSync(cur, "utf8"), "newer"); assert.equal(readFileSync(cur + ".bak", "utf8"), "new", "one backup generation");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("replaceAppImage: missing target and unwritable folder fail without changes", () => {
  const d = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "appimg-"));
  try {
    const nw = join(d, "dl"); writeFileSync(nw, "new");
    assert.throws(() => replaceAppImage(join(d, "nope.AppImage"), nw), /could not be found/);
    const ro = join(d, "ro"); mkdirSync(ro); const cur = join(ro, "U.AppImage"); writeFileSync(cur, "old"); chmodSync(ro, 0o500);
    if (process.getuid?.() !== 0) assert.throws(() => replaceAppImage(cur, nw), /cannot write/);
    chmodSync(ro, 0o700); assert.equal(readFileSync(cur, "utf8"), "old");
  } finally { try { chmodSync(join(d, "ro"), 0o700); } catch { /* */ } rmSync(d, { recursive: true, force: true }); }
});

test("package type: the file wins; without one the system's package database decides (issue #89)", () => {
  const files = (m: Record<string, string>) => (p: string) => m[p] ?? "";
  const have = (...paths: string[]) => (p: string) => paths.includes(p);
  const RES = "/opt/UniChat/resources";
  // electron-builder wrote one: trusted as it is
  assert.equal(linuxPackageType(RES, files({ [`${RES}/package-type`]: "deb\n" }), have("/var/lib/pacman/local")), "deb");
  // the pacman package carries none: an Arch install must NOT be told to fetch the .deb
  assert.equal(linuxPackageType(RES, files({}), have("/var/lib/pacman/local")), "pacman");
  assert.equal(linuxPackageType(RES, files({}), have("/var/lib/dpkg/status")), "deb");
  // both package managers installed: the distribution decides
  const both = have("/var/lib/pacman/local", "/var/lib/dpkg/status");
  assert.equal(linuxPackageType(RES, files({ "/etc/os-release": 'ID=cachyos\nID_LIKE=arch\n' }), both), "pacman");
  assert.equal(linuxPackageType(RES, files({ "/etc/os-release": 'ID=ubuntu\nID_LIKE="debian"\n' }), both), "deb");
  // nothing to go on: no claim, and desktopAsset keeps its old default
  assert.equal(linuxPackageType(RES, files({}), () => false), "");
  assert.deepEqual(desktopAsset({}, "linux", true, ""), { key: "desktop-linux-deb", mode: "manual" });
});
