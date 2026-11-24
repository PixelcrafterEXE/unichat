// Notices that lost their system mark in device sync are recognised and marked again, once (#102).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hub } from "./hub.js";
import { MemoryStore } from "./store.js";
import { looksLikeNotice } from "./notices.js";
import type { Message } from "./model.js";

const msg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, chatId: "signal-1:ann", sender: "L", senderId: "ann", text, time: "2026-11-22T15:18:08.003Z", fromMe: false, accountId: "signal-1", ...extra });

test("looksLikeNotice: Signal's own notice lines only, never someone's message", () => {
  assert.ok(looksLikeNotice("signal", msg("safety.ann.1795360688003", "Your safety number with L has changed.")));
  assert.ok(looksLikeNotice("signal", msg("x1", "Your safety number with Lena Maier has changed.")));
  assert.ok(looksLikeNotice("signal", msg("x2", "Disappearing messages: 1 week")));
  assert.ok(looksLikeNotice("signal", msg("x3", "You pinned a message")));
  assert.ok(!looksLikeNotice("signal", msg("x4", "did your safety number change?")));
  assert.ok(!looksLikeNotice("signal", msg("x5", "Your safety number with L has changed.", { replyTo: { messageId: "x" } })), "a quote: someone wrote it");
  assert.ok(!looksLikeNotice("signal", msg("x6", "You pinned a message", { attachments: [{ id: "a", kind: "image", mime: "image/png" }] })));
  assert.ok(!looksLikeNotice("whatsapp", msg("x7", "Your safety number with L has changed.")), "other networks: never guessed");
  assert.ok(looksLikeNotice("discord", msg("1194699613043708056", "Lion started a thread: Kann jemand die Mail bezüglich")));
  assert.ok(!looksLikeNotice("discord", msg("1194699613043708057", "who started a thread about this?")), "a question is no notice");
  assert.ok(!looksLikeNotice("signal", msg("x8", "Your safety number with L has changed.", { system: { kind: "info" } })), "already marked");
});

test("the hub marks such lines again once per account, and leaves other messages alone", async () => {
  const s = new MemoryStore();
  s.putAccount({ id: "signal-1", provider: "signal", label: "Signal", status: "archived" });
  s.putMessages([msg("safety.ann.1", "Your safety number with L has changed."), msg("m2", "hi there"), msg("m3", "Disappearing messages: 1 day")]);
  const h = new Hub(mkdtempSync(join(tmpdir(), "notices-")), [], s); await h.init();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(s.getMessage("signal-1:ann", "safety.ann.1")?.system, { kind: "info" });
  assert.deepEqual(s.getMessage("signal-1:ann", "m3")?.system, { kind: "info" });
  assert.equal(s.getMessage("signal-1:ann", "m2")?.system, undefined);
  assert.equal(s.getSetting("notice-marks-v2:signal-1"), "1", "done once");
  s.putMessages([msg("safety.ann.2", "Your safety number with L has changed.")]); // later lines come from the connector, marked
  await h.shutdown?.();
});
