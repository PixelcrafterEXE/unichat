// Desktop self-update glue. The download, SHA-256 check and release lookup are the Hub's Updater (packages/core/src/updater.ts);
// this file decides WHICH asset this install uses and how a verified file replaces the running app.
//   AppImage: the new file replaces the running AppImage (atomic rename, the old one is kept as <name>.bak), then the app restarts.
//   .pacman:  (Arch, *.pkg.tar.zst) like .deb: `sudo pacman -U <file>`; detected by resources/package-type when the package has one,
//             otherwise by the package database this system has (see linuxPackageType).
//   .deb:     cannot be installed without root: the folder with the verified file is shown (manual install).
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, accessSync, constants } from "node:fs";
import { basename, dirname, join } from "node:path";

export type DesktopAsset = { key: "desktop-linux-appimage" | "desktop-linux-deb" | "desktop-linux-pacman"; mode: "self" | "manual" } | undefined;

/** Which release asset belongs to this install (undefined = unsupported platform or a dev run). */
export function desktopAsset(env: { APPIMAGE?: string }, platform: string, packaged: boolean, packageType?: string): DesktopAsset {
  if (platform !== "linux" || !packaged) return undefined;
  if (env.APPIMAGE) return { key: "desktop-linux-appimage", mode: "self" };
  if (packageType?.trim() === "pacman") return { key: "desktop-linux-pacman", mode: "manual" };
  return { key: "desktop-linux-deb", mode: "manual" };
}

/** `existsSync` by default; the tests hand in their own answers. */
export type Probe = (path: string) => boolean;
/**
 * Which kind of Linux package this install came from. electron-builder's `resources/package-type` is trusted when it is
 * there, but the pacman package does not carry one (an Arch install then asked for the .deb, issue #89), so the system's
 * own package database decides: whichever package manager exists here is the one that installed us.
 */
export function linuxPackageType(resourcesPath: string, read: (p: string) => string = readText, exists: Probe = existsSync): string {
  const named = read(join(resourcesPath, "package-type")).trim();
  if (named) return named;
  const pacman = exists("/var/lib/pacman/local"), dpkg = exists("/var/lib/dpkg/status");
  if (pacman && !dpkg) return "pacman";
  if (dpkg && !pacman) return "deb";
  const os = read("/etc/os-release"); // both (or neither) present: go by the distribution
  const field = (k: string) => new RegExp(`^${k}=\"?([^\"\\n]*)`, "m").exec(os)?.[1] ?? "";
  const ids = `${field("ID")} ${field("ID_LIKE")}`.toLowerCase();
  if (/\b(arch|manjaro|endeavouros|cachyos|garuda)\b/.test(ids)) return "pacman";
  if (/\b(debian|ubuntu|linuxmint|pop|raspbian)\b/.test(ids)) return "deb";
  return "";
}
const readText = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/** "0.0.0-dev" (local builds, see package.json) and anything unparseable is "dev"; CI builds carry 0.1.<run>. */
export function appVersion(packageVersion: string): string {
  return /^0\.0\.0/.test(packageVersion) || !/^\d+\.\d+\.\d+/.test(packageVersion) ? "dev" : packageVersion;
}

export interface ReplaceResult { backup: string }
/**
 * Replace `current` (the running AppImage) by `verified`. Same-directory temp file + rename, so a crash leaves either the old or the new
 * file, never a half-written one. The old file stays as `<current>.bak` (one generation). Throws a user-readable Error, nothing changed then.
 */
export function replaceAppImage(current: string, verified: string): ReplaceResult {
  const dir = dirname(current), tmp = join(dir, `.${basename(current)}.new`), backup = current + ".bak";
  if (!existsSync(current) || !statSync(current).isFile()) throw new Error("The running AppImage could not be found.");
  try { accessSync(dir, constants.W_OK); } catch { throw new Error(`UniChat cannot write to ${dir}, so it cannot replace itself there. Move the AppImage to a folder you own, or replace it by hand with ${verified}.`); }
  try {
    copyFileSync(verified, tmp); chmodSync(tmp, 0o755);
    rmSync(backup, { force: true });
    renameSync(current, backup);
    try { renameSync(tmp, current); } catch (e) { renameSync(backup, current); throw e; } // put the old one back
    return { backup };
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** electron-builder's fpm targets (deb, rpm, pacman) ship `resources/package-type` holding the target name; "" for AppImage/unpacked. */
export function readPackageType(resourcesPath: string): string { return linuxPackageType(resourcesPath); }
