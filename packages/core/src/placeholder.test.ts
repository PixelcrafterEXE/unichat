import test from "node:test";
import assert from "node:assert/strict";
import { placeholderOf, stripPlaceholder } from "./placeholder.js";
import { fillMissing } from "./signalimport/service.js";
import { Hub } from "./hub.js";
import { MemoryStore } from "./store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "./model.js";

const msg = (o: Partial<Message>): Message => ({ id: "1", chatId: "a1:c", sender: "S", senderId: "s", text: "", time: "2026-01-01T10:00:00.000Z", fromMe: false, ...o });
const ATT = { id: "x", kind: "image" as const, mime: "image/jpeg" };

test("placeholderOf: whole-text stand-ins only, case-insensitive, with an optional name", () => {
  for (const t of ["[Photo]", " [photo] ", "[Video]", "[Voice message]", "[Sticker]", "[GIF]", "[Audio]"]) assert.ok(placeholderOf(t), t);
  assert.deepEqual(placeholderOf("[File: export-rtd-locations-au045-band-rehearsal-room-assets-2026-06-25.csv]"), { kind: "file", name: "export-rtd-locations-au045-band-rehearsal-room-assets-2026-06-25.csv" });
  assert.deepEqual(placeholderOf("[Photo]"), { kind: "image" });
  for (const t of ["look [Photo]", "[Photo] nice", "[Something else]", "Photo", ""]) assert.equal(placeholderOf(t), undefined, t);
});

test("stripPlaceholder keeps a caption and drops only the stand-in line", () => {
  assert.equal(stripPlaceholder("[Photo]"), ""); assert.equal(stripPlaceholder("look\n[Photo]"), "look"); assert.equal(stripPlaceholder("look [Photo]"), "look [Photo]"); assert.equal(stripPlaceholder("hi"), "hi");
});

test("fillMissing: the media arrives in a re-import, the old [Photo] text goes (idempotent)", () => {
  const old = msg({ text: "look\n[Photo]" }), inc = msg({ text: "look", attachments: [ATT] });
  const f = fillMissing(old, inc)!; assert.equal(f.text, "look"); assert.equal(f.attachments!.length, 1);
  const only = fillMissing(msg({ text: "[Photo]" }), msg({ text: "", attachments: [ATT] }))!; assert.equal(only.text, "");
  assert.equal(fillMissing(f, inc), undefined); // second run: nothing left to fill
  assert.equal(fillMissing(msg({ text: "[Photo]" }), msg({ text: "[Photo]" })), undefined); // media still missing: the stand-in stays
});

test("Hub.cleanPlaceholders clears placeholder-only text next to attachments, leaves missing media alone; runs once per account at startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ph-")), store = new MemoryStore();
  try {
        store.putMessages([
      msg({ id: "1", text: "[Photo]", attachments: [ATT] }), msg({ id: "2", text: "look\n[Photo]", attachments: [ATT] }), msg({ id: "3", text: "[Photo]" }),
      msg({ id: "4", text: "[File: a.csv]", attachments: [{ id: "y", kind: "file", mime: "text/csv", name: "a.csv" }] }), msg({ id: "5", text: "hello", attachments: [ATT] }),
    ]);
    const hub = new Hub(dir, [], store, {});
    const r = await hub.call("cleanPlaceholders", { accountId: "a1" }) as { cleaned: number };
    assert.equal(r.cleaned, 3);
    const t = (id: string) => store.getMessage("a1:c", id)!.text;
    assert.deepEqual(["1", "2", "3", "4", "5"].map(t), ["", "look", "[Photo]", "", "hello"]);
    assert.equal(((await hub.call("cleanPlaceholders", { accountId: "a1" })) as { cleaned: number }).cleaned, 0); // idempotent
    await hub.shutdown();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startup cleanup runs once per account and is remembered in the store's settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ph-")), store = new MemoryStore();
  try {
    store.putAccount({ id: "a1", provider: "signal", label: "x", status: "archived" } as any);
    store.putMessages([msg({ id: "1", text: "[Photo]", attachments: [ATT] })]);
    const hub = new Hub(dir, [], store, {}); await hub.init();
    for (let i = 0; i < 50 && !store.getSetting("placeholders-clean-v1:a1"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.getSetting("placeholders-clean-v1:a1"), "1"); assert.equal(store.getMessage("a1:c", "1")!.text, "");
    store.putMessages([msg({ id: "2", text: "[Photo]", attachments: [ATT] })]); // a later startup does not rescan (flag set)
    await hub.shutdown();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
