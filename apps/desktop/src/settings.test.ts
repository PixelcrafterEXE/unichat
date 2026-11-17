import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsStore, DEFAULT_SETTINGS, mergeSettings, SETTINGS_FILE } from "./settings.js";

test("merge: defaults win over junk, later sources over earlier, unknown keys dropped", () => {
  assert.deepEqual(mergeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings("not an object", 7, null), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings({ keepRunningInBackground: "yes", startAtLogin: 1 }), DEFAULT_SETTINGS);
  assert.deepEqual(mergeSettings({ startAtLogin: true, somethingElse: true }), { keepRunningInBackground: true, startAtLogin: true });
  assert.deepEqual(mergeSettings({ keepRunningInBackground: false }, { keepRunningInBackground: true }), DEFAULT_SETTINGS);
  assert.deepEqual(Object.keys(mergeSettings({})), Object.keys(DEFAULT_SETTINGS));
});

test("store: defaults when there is no file, patches merge and persist, a broken file falls back", () => {
  const dir = mkdtempSync(join(tmpdir(), "unimsg-settings-"));
  try {
    const s = createSettingsStore(dir);
    assert.deepEqual(s.get(), DEFAULT_SETTINGS);
    assert.deepEqual(s.set({ keepRunningInBackground: false }), { keepRunningInBackground: false, startAtLogin: false });
    assert.deepEqual(s.set({ startAtLogin: true }), { keepRunningInBackground: false, startAtLogin: true });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8")), { keepRunningInBackground: false, startAtLogin: true });
    assert.deepEqual(createSettingsStore(dir).get(), { keepRunningInBackground: false, startAtLogin: true });

    writeFileSync(join(dir, SETTINGS_FILE), "{not json");
    assert.deepEqual(createSettingsStore(dir).get(), DEFAULT_SETTINGS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
