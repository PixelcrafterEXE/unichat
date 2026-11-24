import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAutostart, desktopEntry, ENTRY_NAME, HIDDEN_FLAG, setXdgAutostart } from "./autostart.js";

test("desktop entry: starts hidden, quotes the exec, escapes specials", () => {
  const text = desktopEntry("/opt/UniChat.AppImage");
  assert.match(text, /^\[Desktop Entry\]\n/);
  assert.match(text, /\nExec="\/opt\/UniChat.AppImage" "--hidden"\n/);
  assert.match(text, /\nType=Application\n/);
  assert.match(text, /\nX-GNOME-Autostart-enabled=true\n/);
  assert.ok(text.endsWith("\n"));
  assert.match(desktopEntry("/home/a b/My $App`x\\y.AppImage"), /\nExec="\/home\/a b\/My \\\$App\\`x\\\\y.AppImage" "--hidden"\n/);
  assert.match(desktopEntry("/usr/bin/electron", ["/app", HIDDEN_FLAG]), /\nExec="\/usr\/bin\/electron" "\/app" "--hidden"\n/);
});

test("xdg autostart: written into a created dir, removed again, removing twice is fine", () => {
  const home = mkdtempSync(join(tmpdir(), "unimsg-autostart-"));
  try {
    const dir = join(home, ".config", "autostart"), file = join(dir, ENTRY_NAME);
    assert.equal(setXdgAutostart(true, { dir, exec: "/opt/UniChat.AppImage" }), file);
    assert.equal(readFileSync(file, "utf8"), desktopEntry("/opt/UniChat.AppImage"));
    assert.equal(statSync(file).mode & 0o777, 0o644);
    setXdgAutostart(false, { dir, exec: "/opt/UniChat.AppImage" });
    assert.equal(existsSync(file), false);
    setXdgAutostart(false, { dir, exec: "/opt/UniChat.AppImage" }); // no entry, no throw
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("apply: login item off Linux, desktop entry on Linux, failures stay non-fatal", () => {
  const home = mkdtempSync(join(tmpdir(), "unimsg-autostart-"));
  try {
    const dir = join(home, ".config", "autostart");
    const seen: unknown[] = [];
    const env = { dir, exec: "C:\\UniChat.exe", args: [HIDDEN_FLAG], setLoginItemSettings: (s: unknown) => seen.push(s) };
    applyAutostart(true, { ...env, platform: "win32" });
    applyAutostart(false, { ...env, platform: "darwin" });
    assert.deepEqual(seen, [
      { openAtLogin: true, openAsHidden: true, path: "C:\\UniChat.exe", args: [HIDDEN_FLAG] },
      { openAtLogin: false, openAsHidden: false, path: "C:\\UniChat.exe", args: [HIDDEN_FLAG] },
    ]);
    assert.equal(existsSync(join(dir, ENTRY_NAME)), false, "no desktop entry off Linux");

    applyAutostart(true, { ...env, platform: "linux" });
    assert.ok(existsSync(join(dir, ENTRY_NAME)));
    assert.equal(seen.length, 2, "Electron's login items are a no-op on Linux and are not used there");

    // An unwritable location must not throw out of applyAutostart: a folder below an ordinary file (fails at once
    // everywhere; "/proc/nope/autostart" made Node 24's recursive mkdir hang in CI and the test never ended).
    const file = join(home, "a-file"); writeFileSync(file, "x");
    applyAutostart(true, { platform: "linux", dir: join(file, "autostart"), exec: "/opt/UniChat.AppImage" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
