// Block (UniChat-local), disappearing timer set/receive/ride-along, view-once and sticker receive. Fakes only, no network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { IdentityKeyPair } from "@signalapp/libsignal-client";
import type { CoreEvent, Message } from "@unimsg/core";
import { DataMessageFlags, type Content } from "../protocol/codec.js";
import { SignalClient } from "../service/client.js";
import { Inbound } from "../service/inbound.js";

const ME = "22222222-2222-4222-8222-222222222222";
const A = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const client = new SignalClient({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-signal-bt-")) });
  await client.store.load();
  client.store.setAccount({ aci: ME, deviceId: 2, password: "pw", registrationId: 5, aciIdentity: Buffer.from(IdentityKeyPair.generate().serialize()).toString("base64"), readReceipts: true, linkedAt: 0 });
  const events: CoreEvent[] = [];
  const priv = client as unknown as Record<string, unknown> & { makeInbound(): void; emit: (e: CoreEvent) => void };
  priv.emit = (e) => events.push(e);
  priv.makeInbound(); priv.chatConn = {};
  const calls: { aci: string; content: Content; mode: string }[] = [];
  priv.sender = { deliver: async (aci: string, content: Content, _t: number, mode: string) => { calls.push({ aci, content, mode }); }, deps: {} };
  client.store.data.contacts[A] = { aci: A, name: "Alice" };
  client.store.upsertChat({ id: A, kind: "dm" });
  return { client, events, calls };
}

test("block: local flag drops incoming messages, refuses sending, shows Chat.blocked, survives phone syncs, unblock restores", async () => {
  const h = await setup();
  const out: Message[] = [];
  const inb = new Inbound("acc", h.client.store, (e) => { if (e.type === "message") out.push(e.data); });
  await h.client.blockChat(A, true);
  assert.equal(h.client.chats().find((c) => c.id === A)!.blocked, true);
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { dataMessage: { body: "spam", timestamp: 1 } } }, 1);
  assert.equal(out.length, 0);
  await assert.rejects(h.client.send(A, { text: "hi" }), /blocked/);
  assert.equal(h.calls.length, 0);
  // the phone's block list replacing `blocked` must not clear the local block
  (inb as unknown as { applyBlocked(b: object): void }).applyBlocked({ acis: [] });
  assert.equal(h.client.store.data.contacts[A]!.localBlocked, true);
  assert.equal(h.client.chats().find((c) => c.id === A)!.blocked, true);
  await h.client.blockChat(A, false);
  assert.equal(h.client.chats().find((c) => c.id === A)!.blocked, undefined);
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { dataMessage: { body: "hello", timestamp: 2 } } }, 2);
  assert.equal(out.length, 1);
  await assert.rejects(h.client.blockChat(ME, true), /yourself/);
  await assert.rejects(h.client.blockChat("g.abc", true), /groups/);
});

test("phone-side block (Storage Service flag) still shows as blocked", async () => {
  const h = await setup();
  h.client.store.data.contacts[A]!.blocked = true;
  assert.equal(h.client.chats().find((c) => c.id === A)!.blocked, true);
});

test("setDisappearing: timer-update DataMessage to the peer and as transcript; chat shows disappearing; later messages carry expireTimer + expiresIn", async () => {
  const h = await setup();
  await h.client.setDisappearing(A, 3600);
  const peer = h.calls.find((c) => c.mode === "message")!.content.dataMessage!;
  assert.equal(peer.flags! & DataMessageFlags.EXPIRATION_TIMER_UPDATE, DataMessageFlags.EXPIRATION_TIMER_UPDATE);
  assert.equal(peer.expireTimer, 3600);
  assert.equal(h.calls.find((c) => c.mode === "sync")!.content.syncMessage!.sent!.message!.expireTimer, 3600);
  assert.equal(h.client.chats().find((c) => c.id === A)!.disappearing, 3600);
  const m = await h.client.send(A, { text: "secret" });
  assert.equal(m.expiresIn, 3600);
  assert.equal(h.calls.filter((c) => c.mode === "message").at(-1)!.content.dataMessage!.expireTimer, 3600);
  await h.client.setDisappearing(A, 0);
  assert.equal(h.client.chats().find((c) => c.id === A)!.disappearing, undefined);
  const m2 = await h.client.send(A, { text: "normal" });
  assert.equal(m2.expiresIn, undefined);
  await assert.rejects(h.client.setDisappearing(A, -1), /between/);
  await assert.rejects(h.client.setDisappearing("g.abc", 60), /group/i);
});

test("receive: message expiresIn, view-once flag + placeholder (media not downloadable), sticker attachment", async () => {
  const h = await setup();
  const out: Message[] = [];
  const inb = new Inbound("acc", h.client.store, (e) => { if (e.type === "message") out.push(e.data); });
  const ptr = (n: string) => ({ cdnKey: n, cdnNumber: 3, key: randomBytes(64), size: 10, contentType: "image/webp", width: 512, height: 512 });
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { dataMessage: { body: "tick", timestamp: 1, expireTimer: 60 } } }, 1);
  assert.equal(out[0]!.expiresIn, 60);
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { dataMessage: { timestamp: 2, isViewOnce: true, attachments: [{ ...ptr("vo"), contentType: "image/jpeg" }] } } }, 2);
  assert.equal(out[1]!.viewOnce, true);
  assert.match(out[1]!.text, /View-once/);
  assert.equal(h.client.store.data.attachments[`${out[1]!.id}#0`], undefined);
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { dataMessage: { timestamp: 3, sticker: { packId: randomBytes(16), stickerId: 4, emoji: "x", data: ptr("st") } } } }, 3);
  const s = out[2]!;
  assert.equal(s.attachments![0]!.kind, "sticker");
  assert.equal(s.text, "Sticker x");
  assert.ok(h.client.store.data.attachments[s.attachments![0]!.id]);
});

test("receive attachments: voice note flag, GIF flag (mp4 loop), image/video/file kinds, downloadable refs", async () => {
  const h = await setup();
  const out: Message[] = [];
  const inb = new Inbound("acc", h.client.store, (e) => { if (e.type === "message") out.push(e.data); });
  const ptr = (mime: string, flags?: number, extra: object = {}) => ({ cdnKey: "k" + randomBytes(3).toString("hex"), cdnNumber: 3, key: randomBytes(64), size: 10, contentType: mime, ...(flags ? { flags } : {}), ...extra });
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { dataMessage: { timestamp: 1, attachments: [
    ptr("audio/aac", 1), ptr("video/mp4", 8, { width: 320, height: 240 }), ptr("image/jpeg", 0, { fileName: "p.jpg" }), ptr("video/mp4"), ptr("application/pdf", 0, { fileName: "a.pdf" })] } } }, 1);
  const at = out[0]!.attachments!;
  assert.deepEqual(at.map((a) => a.kind), ["voice", "video", "image", "video", "file"]);
  assert.deepEqual(at.map((a) => a.gif === true), [false, true, false, false, false]);
  for (const a of at) assert.ok(h.client.store.data.attachments[a.id], `ref for ${a.id}`);
});
