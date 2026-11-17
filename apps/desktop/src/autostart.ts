// "Start UniChat when I log in". `app.setLoginItemSettings` covers macOS (login item) and Windows (Run key) but does nothing on
// Linux, which has no login-item API: there the entry is an XDG autostart desktop file we write ourselves.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ENTRY_NAME = "unichat.desktop";
/** Launched at login the app starts hidden to the tray, so logging in does not throw a window in the user's face. */
export const HIDDEN_FLAG = "--hidden";

export interface AutostartEnv {
  platform: string;
  /** ~/.config/autostart (Linux only). */
  dir: string;
  /** What to launch: the AppImage itself when running as one, never the unpacked binary inside it. */
  exec: string;
  args?: string[];
  setLoginItemSettings?(s: { openAtLogin: boolean; openAsHidden: boolean; path: string; args: string[] }): void;
}

/** Write or remove the XDG autostart entry. Returns the path it touched. */
export function setXdgAutostart(enabled: boolean, env: { dir: string; exec: string; args?: string[] }): string {
  const file = join(env.dir, ENTRY_NAME);
  if (!enabled) rmSync(file, { force: true });
  else { mkdirSync(env.dir, { recursive: true }); writeFileSync(file, desktopEntry(env.exec, env.args), { mode: 0o644 }); }
  return file;
}

/** The entry's text. Icon/Name match the packaged desktop file (electron-builder.yml, flatpak/org.unichat.desktop.desktop). */
export function desktopEntry(exec: string, args: string[] = [HIDDEN_FLAG]): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=UniChat",
    "Comment=Unified messenger",
    `Exec=${[exec, ...args].map(quoteArg).join(" ")}`,
    "Icon=org.unichat.desktop",
    "Terminal=false",
    "StartupWMClass=UniChat",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** Apply the setting. Never throws: autostart failing (sandboxed home, no write access) must not take the app down with it. */
export function applyAutostart(enabled: boolean, env: AutostartEnv): void {
  try {
    if (env.platform === "linux") setXdgAutostart(enabled, env);
    else env.setLoginItemSettings?.({ openAtLogin: enabled, openAsHidden: enabled, path: env.exec, args: env.args ?? [HIDDEN_FLAG] });
  } catch (e) {
    console.warn("[unimsg] autostart not changed:", (e as Error).message);
  }
}

/** Desktop-entry quoting: a quoted value escapes `"`, `$`, backtick and backslash with a backslash (XDG Desktop Entry spec). */
function quoteArg(arg: string): string {
  return `"${arg.replace(/(["$`\\])/g, "\\$1")}"`;
}
