// @mentions (send + receive), disappearing-message timer (receive only), profile-key learning and incoming link-preview images.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Aci, IdentityKeyPair } from "@signalapp/libsignal-client";
import type { CoreEvent, Message } from "@unimsg/core";
import { DataMessageFlags, type Content, type DataMessage } from "../protocol/codec.js";
import { buildContactStream, parseContactStream } from "../service/contacts.js";
import { SignalClient, applyMentions } from "../service/client.js";
import { groupChatId, groupIdFromMasterKey } from "../service/groups.js";
import { Inbound } from "../service/inbound.js";
import { readFileSync } from "node:fs";
import { SignalStore } from "../store/signalStore.js";

const ME = "22222222-2222-4222-8222-222222222222";
const A = "11111111-1111-4111-8111-111111111111";
const B = "44444444-4444-4444-8444-444444444444";

test("capabilities: mentions, group management and description are declared", () => {
  // index.ts pulls in @unimsg/core (TypeScript source) at runtime, so inspect the source instead of importing it
  const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  for (const k of ["mentions", "createGroup", "manageMembers", "renameChat", "chatPicture", "leaveChat", "chatDescription"]) assert.match(src, new RegExp(`\\b${k}: true`), k);
  for (const m of ["createGroup", "addMembers", "removeMember", "renameChat", "setChatPicture", "leaveChat", "setChatDescription"]) assert.match(src, new RegExp(`\\n  ${m}\\(`), m);
});

test("applyMentions: @Name spans become one U+FFFC each; offsets are UTF-16; bad/overlapping/non-ACI mentions are dropped", () => {
  const text = "hi \u{1F600} @Alice and @Bob!";
  const a = text.indexOf("@Alice"), b = text.indexOf("@Bob");
  const r = applyMentions(text, [{ id: B, start: b, length: 4 }, { id: A.toUpperCase(), start: a, length: 6 }]);
  assert.equal(r.body, "hi \u{1F600} ￼ and ￼!");
  assert.deepEqual(r.ranges, [{ start: 6, length: 1, mentionAci: A }, { start: 12, length: 1, mentionAci: B }]);
  assert.equal(r.body[r.ranges[0]!.start!], "￼");
  assert.deepEqual(applyMentions("x @A", [{ id: "not-a-uuid", start: 2, length: 2 }]), { body: "x @A", ranges: [] });
  assert.deepEqual(applyMentions("x @A", [{ id: A, start: 2, length: 99 }]).ranges, []);
  assert.equal(applyMentions("@Alice@Bob", [{ id: A, start: 0, length: 6 }, { id: B, start: 3, length: 4 }]).ranges.length, 1); // overlap
  assert.deepEqual(applyMentions("plain", undefined), { body: "plain", ranges: [] });
});

async function setup() {
  const client = new SignalClient({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-signal-mn-")) });
  await client.store.load();
  client.store.setAccount({ aci: ME, deviceId: 2, password: "pw", registrationId: 5, aciIdentity: Buffer.from(IdentityKeyPair.generate().serialize()).toString("base64"), readReceipts: true, linkedAt: 0 });
  const events: CoreEvent[] = [];
  const priv = client as unknown as Record<string, unknown> & { makeInbound(): void; emit: (e: CoreEvent) => void };
  priv.emit = (e) => events.push(e);
  const masterKey = randomBytes(32);
  const chatId = groupChatId(groupIdFromMasterKey(masterKey));
  priv.groupResolver = { needs: () => false, request: async () => {}, ensure: async () => {
    client.store.upsertChat({ id: chatId, kind: "group", groupMasterKey: Buffer.from(masterKey).toString("base64"), groupRevision: 3, groupMembers: [ME, A, B] });
    client.store.data.chats[chatId]!.groupFetchedAt = Date.now(); return "refreshed";
  } };
  priv.makeInbound(); priv.chatConn = {};
  const calls: { aci: string; content: Content; mode: string }[] = [];
  priv.sender = { deliver: async (aci: string, content: Content, _t: number, mode: string) => { calls.push({ aci, content, mode }); } };
  client.store.data.contacts[A] = { aci: A, name: "Alice Smith" };
  client.store.data.contacts[B] = { aci: B, name: "Bob" };
  return { client, chatId, masterKey, events, calls };
}

test("send with mentions: body carries U+FFFC + bodyRanges to members and the transcript; returned text keeps @Name", async () => {
  const h = await setup();
  const text = "hey @Alice Smith, ping @Bob";
  const m = await h.client.send(h.chatId, { text, mentions: [{ id: A, name: "Alice Smith", start: 4, length: 12 }, { id: B, name: "Bob", start: 23, length: 4 }] });
  assert.equal(m.text, text);
  for (const c of h.calls) {
    const dm = c.mode === "message" ? c.content.dataMessage! : c.content.syncMessage!.sent!.message!;
    assert.equal(dm.body, "hey ￼, ping ￼");
    assert.deepEqual(dm.bodyRanges, [{ start: 4, length: 1, mentionAci: A }, { start: 12, length: 1, mentionAci: B }]);
  }
});

test("receive mentions: U+FFFC placeholders render as @Name (string and binary ACI, own mention as You), also in edits", async () => {
  const h = await setup();
  const out: Message[] = [];
  const updates: CoreEvent[] = [];
  const inb = new Inbound("acc", h.client.store, (e) => { if (e.type === "message") out.push(e.data); else updates.push(e); });
  const gv2 = { masterKey: new Uint8Array(h.masterKey), revision: 3 };
  const dm: DataMessage = { body: "hi ￼ and ￼ and ￼", timestamp: 10, groupV2: gv2, bodyRanges: [
    { start: 3, length: 1, mentionAci: A }, { start: 9, length: 1, mentionAciBinary: Aci.fromUuid(B).getRawUuidBytes() }, { start: 15, length: 1, mentionAci: ME }, { start: 0, length: 2, style: 1 }] };
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: true, content: { dataMessage: dm } }, 10);
  assert.equal(out[0]!.text, "hi @Alice Smith and @Bob and @You");
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: true, content: { editMessage: { targetSentTimestamp: 10, dataMessage: { body: "￼!", timestamp: 11, groupV2: gv2, bodyRanges: [{ start: 0, length: 1, mentionAci: B }] } } } }, 11);
  const upd = updates.find((e) => e.type === "message-update") as Extract<CoreEvent, { type: "message-update" }>;
  assert.equal(upd.data.patch.text, "@Bob!");
});

test("disappearing timer is recorded from messages, timer updates, contact sync and group state; nothing is deleted", async () => {
  const h = await setup();
  const events: CoreEvent[] = [];
  const inb = new Inbound("acc", h.client.store, (e) => events.push(e));
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { dataMessage: { body: "hello", timestamp: 1, expireTimer: 3600 } } }, 1);
  assert.equal(h.client.disappearing(A), 3600);
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { dataMessage: { timestamp: 2, flags: DataMessageFlags.EXPIRATION_TIMER_UPDATE, expireTimer: 0 } } }, 2);
  assert.equal(h.client.disappearing(A), 0);
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { dataMessage: { timestamp: 3, flags: DataMessageFlags.EXPIRATION_TIMER_UPDATE, expireTimer: 604800 } } }, 3);
  assert.equal(h.client.disappearing(A), 604800);
  // a reaction (no timer field) must not reset it
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { dataMessage: { timestamp: 4, reaction: { emoji: "x", targetAuthorAci: ME, targetSentTimestamp: 1 } } } }, 4);
  assert.equal(h.client.disappearing(A), 604800);
  assert.equal(events.filter((e) => e.type === "message-update" && e.data.patch.deleted).length, 0);
  const parsed = parseContactStream(buildContactStream([{ aci: B, name: "Bob", expireTimer: 86400 }]));
  assert.equal(parsed[0]!.expireTimer, 86400);
  assert.equal(h.client.disappearing("nobody"), undefined);
});

test("profile keys are learned from incoming messages (not from ourselves); a new key resets the sealed-sender rejection", async () => {
  const h = await setup();
  const inb = new Inbound("acc", h.client.store, () => {});
  const key = randomBytes(32);
  h.client.store.data.contacts[A]!.sealedRejectedAt = 5;
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: true, content: { dataMessage: { body: "hi", timestamp: 1, profileKey: key } } }, 1);
  assert.equal(h.client.store.data.contacts[A]!.profileKey, key.toString("base64"));
  assert.equal(h.client.store.data.contacts[A]!.sealedRejectedAt, undefined);
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: true, content: { dataMessage: { body: "bad", timestamp: 2, profileKey: randomBytes(5) } } }, 2);
  assert.equal(h.client.store.data.contacts[A]!.profileKey, key.toString("base64"));
  await inb.handle({ senderAci: ME, senderDevice: 3, sealed: true, content: { syncMessage: { sent: { destinationServiceId: B, timestamp: 3, message: { body: "mine", timestamp: 3, profileKey: randomBytes(32) } } } } }, 3);
  assert.equal(h.client.store.data.contacts[ME], undefined);
  assert.equal(h.client.store.data.contacts[B]?.profileKey, undefined);
});

test("incoming link preview: card with title/description and a downloadable image pointer", async () => {
  const h = await setup();
  const out: Message[] = [];
  const inb = new Inbound("acc", h.client.store, (e) => { if (e.type === "message") out.push(e.data); });
  await inb.handle({ senderAci: A, senderDevice: 1, sealed: true, content: { dataMessage: { body: "https://x.test", timestamp: 9, preview: [{ url: "https://x.test", title: "X", description: "d", image: {
    cdnKey: "k", cdnNumber: 3, key: randomBytes(64), size: 10, contentType: "image/png", width: 30, height: 20 } }] } } }, 9);
  const m = out[0]!;
  assert.deepEqual([m.card?.kind, m.card?.title, m.card?.image?.attachmentId, m.card?.image?.width], ["link", "X", `${m.id}#preview`, 30]);
  assert.ok(h.client.store.data.attachments[`${m.id}#preview`]);
});
