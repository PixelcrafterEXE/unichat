import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appVersion, desktopAsset, replaceAppImage } from "./updater.js";

test("asset selection: AppImage self-updates, other packaged Linux installs are manual, dev runs and other OS none", () => {
  assert.deepEqual(desktopAsset({ APPIMAGE: "/home/u/UniChat.AppImage" }, "linux", true), { key: "desktop-linux-appimage", mode: "self" });
  assert.deepEqual(desktopAsset({}, "linux", true), { key: "desktop-linux-deb", mode: "manual" });
  assert.equal(desktopAsset({ APPIMAGE: "/x" }, "linux", false), undefined);
  assert.equal(desktopAsset({}, "win32", true), undefined);
  assert.equal(desktopAsset({}, "darwin", true), undefined);
});

test("version: CI versions pass, local builds are dev", () => {
  assert.equal(appVersion("0.1.37"), "0.1.37"); assert.equal(appVersion("0.0.0-dev"), "dev"); assert.equal(appVersion("garbage"), "dev");
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
