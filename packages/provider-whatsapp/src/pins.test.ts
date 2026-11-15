// Pin in chat: the wire message Baileys builds for pin()/unpin(), and the receive path (other participant, other own device, stale replay). Offline: fake socket.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWAMessageContent, proto } from "@whiskeysockets/baileys";
import type { CoreEvent } from "@unimsg/core";
import factory from "./index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wa-pin-"));
  const c = factory.create({ accountId: "t", dataDir: dir }) as any;
  const events: CoreEvent[] = [], sent: any[] = [];
  c.emit = (e: CoreEvent) => events.push(e);
  c.opened = true;
  c.sock = { sendMessage: async (jid: string, content: any) => { sent.push({ jid, content }); return { key: { remoteJid: jid, id: "S" + sent.length, fromMe: true }, messageTimestamp: 9 }; } };
  return { c, events, sent, done: () => { c.store.discard(); rmSync(dir, { recursive: true, force: true }); } };
}
const ANN = "4915111@s.whatsapp.net";
const seed = (c: any) => c.intake({ key: { remoteJid: ANN, id: "m1", fromMe: false }, messageTimestamp: 100, message: { conversation: "pin me" } }, true);
const upd = (events: CoreEvent[]) => events.filter((e) => e.type === "message-update").map((e: any) => e.data);

test("capabilities advertise pinning with 24h / 7d / 30d", () => {
  assert.equal(factory.capabilities.pinMessages, true); assert.deepEqual(factory.capabilities.pinDurations, [86400, 604800, 2592000]);
});

test("pin() sends a pinInChatMessage with the chosen duration (proto round trip) and unpin() sends UNPIN_FOR_ALL", async () => {
  const t = setup(); seed(t.c);
  await t.c.pin(ANN, "m1", true, { durationSec: 86400 });
  assert.equal(t.sent[0].content.type, proto.Message.PinInChatMessage.Type.PIN_FOR_ALL); assert.equal(t.sent[0].content.time, 86400); assert.equal(t.sent[0].content.pin.id, "m1");
  const wire = await generateWAMessageContent(t.sent[0].content, {} as any);
  const back = proto.Message.decode(proto.Message.encode(wire).finish());
  assert.equal(back.pinInChatMessage!.type, 1); assert.equal(back.pinInChatMessage!.key!.id, "m1"); assert.equal(back.messageContextInfo!.messageAddOnDurationInSecs, 86400);
  assert.equal(upd(t.events).at(-1).patch.pinned, true);
  assert.ok(Date.parse(upd(t.events).at(-1).patch.pinnedUntil) - Date.now() > 86000_000 - 5000);
  await t.c.pin(ANN, "m1", true, { durationSec: 12345 }); assert.equal(t.sent[1].content.time, 604800); // not a WhatsApp choice: the 7 day default
  await t.c.pin(ANN, "m1", false);
  assert.equal(t.sent[2].content.type, proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL);
  assert.equal(proto.Message.decode(proto.Message.encode(await generateWAMessageContent(t.sent[2].content, {} as any)).finish()).messageContextInfo!.messageAddOnDurationInSecs, 0);
  assert.deepEqual(upd(t.events).at(-1).patch, { pinned: false });
  t.done();
});

test("incoming pin / unpin from the contact marks the target message; an older replay is ignored", () => {
  const t = setup(); seed(t.c);
  const wire = (type: number, ts: number, dur = 0, fromMe = false) => ({ key: { remoteJid: ANN, id: "P" + ts, fromMe }, messageTimestamp: ts, message: { pinInChatMessage: { key: { remoteJid: ANN, id: "m1", fromMe: false }, type, senderTimestampMs: ts * 1000 }, messageContextInfo: { messageAddOnDurationInSecs: dur } } });
  assert.equal(t.c.intake(wire(1, 200, 604800), true), undefined); // a control message: not shown as a chat message
  let u = upd(t.events).at(-1); assert.equal(u.messageId, "m1"); assert.equal(u.patch.pinned, true); assert.equal(u.patch.pinnedBy, ANN); assert.equal(u.patch.pinnedUntil, new Date((200 + 604800) * 1000).toISOString());
  assert.equal(t.c.store.find(ANN, "m1").m.pinned, true); // persisted in the provider store as well
  t.c.intake(wire(2, 150), false); assert.equal(t.c.store.find(ANN, "m1").m.pinned, true); // older unpin (history replay) loses
  t.c.intake(wire(2, 300, 0, true), true); // my other device unpins
  assert.equal(t.c.store.find(ANN, "m1").m.pinned, undefined); assert.deepEqual(upd(t.events).at(-1).patch, { pinned: false });
  t.done();
});

test("pin of a deleted or unknown message is refused", async () => {
  const t = setup(); seed(t.c);
  await assert.rejects(t.c.pin(ANN, "nope", true), /not found/);
  t.c.store.find(ANN, "m1").m.deleted = true;
  await assert.rejects(t.c.pin(ANN, "m1", true), /deleted/);
  t.done();
});
