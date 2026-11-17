// The desktop shell's own settings (tray/close behaviour, autostart). They do not belong in the Hub's encrypted database:
// they are per-install shell behaviour and have to be readable before (and even if) the backend comes up. Same idea as the
// host's `key-source` note: one small JSON file in the data directory.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DesktopSettings {
  /** Closing the window only hides it: accounts stay connected, notifications keep arriving and other devices can still sync with this one. */
  keepRunningInBackground: boolean;
  /** Start UniChat when the user logs in (hidden to the tray). */
  startAtLogin: boolean;
}

export const SETTINGS_FILE = "desktop-settings.json";
export const DEFAULT_SETTINGS: DesktopSettings = { keepRunningInBackground: true, startAtLogin: false };

/** Defaults plus the known boolean keys of each source (later ones win). A hand-edited or older file can never produce a non-boolean setting. */
export function mergeSettings(...sources: unknown[]): DesktopSettings {
  const out = { ...DEFAULT_SETTINGS };
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof DesktopSettings)[]) {
      const v = (src as Record<string, unknown>)[k];
      if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}

export function createSettingsStore(dir: string) {
  const file = join(dir, SETTINGS_FILE);
  let current = mergeSettings(read(file));
  return {
    get: (): DesktopSettings => current,
    /** Merge a patch (from the renderer) and persist it. Returns the settings as they are now, so the caller can act on them. */
    set(patch: unknown): DesktopSettings {
      current = mergeSettings(current, patch);
      // A read-only or full data directory must not break the running app; the setting then only lasts this session.
      try { writeFileSync(file, JSON.stringify(current, null, 2) + "\n"); } catch (e) { console.warn("[unimsg] desktop settings not saved:", (e as Error).message); }
      return current;
    },
  };
}
export type SettingsStore = ReturnType<typeof createSettingsStore>;

function read(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}
