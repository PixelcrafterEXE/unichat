// Receipts / read sync (#50) and edits (#51): Inbound driven with decrypted Content, fake sender for the client-level cases. No network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IdentityKeyPair } from "@signalapp/libsignal-client";
import type { CoreEvent } from "@unimsg/core";
import type { Content } from "../protocol/codec.js";
import { Aci } from "@signalapp/libsignal-client";
import { SignalClient } from "../service/client.js";
import { Inbound, messageId } from "../service/inbound.js";
import { groupChatId, groupIdFromMasterKey } from "../service/groups.js";
import { A, B, ME, b64, makeStore } from "./fixtures.js";

const T0 = 1_700_000_000_000;
type Ev = CoreEvent;

async function inboundSetup() {
  const store = await makeStore(ME, 2);
  const events: Ev[] = [];
  const inb = new Inbound("acc", store, (e) => events.push(e));
  const from = (senderAci: string, content: Content, at = T0 + 5000) => inb.handle({ senderAci, senderDevice: 1, sealed: false, content }, at);
  const receipts = () => events.filter((e) => e.type === "receipt").map((e) => (e as { data: Record<string, unknown> }).data);
  const updates = () => events.filter((e) => e.type === "message-update").map((e) => (e as unknown as { data: { chatId: string; messageId: string; patch: Record<string, unknown> } }).data);
  const messages = () => events.filter((e) => e.type === "message").map((e) => (e as { data: { id: string; text: string; editedAt?: string; chatId: string } }).data);
  return { store, inb, events, from, receipts, updates, messages };
}

// ---------- #50 receipts ----------
test("receipt with an absent type is a DELIVERY receipt, READ and VIEWED count as read, per recipient with their time", async () => {
  const h = await inboundSetup();
  h.store.indexSent(messageId(ME, T0), A);
  await h.from(A, { receiptMessage: { timestamp: [T0] } }, T0 + 1000);
  await h.from(A, { receiptMessage: { type: 1, timestamp: [T0] } }, T0 + 2000);
  await h.from(A, { receiptMessage: { type: 2, timestamp: [T0] } }, T0 + 3000);
  assert.deepEqual(h.receipts().map((r) => [r.status, r.by, r.at]), [
    ["delivered", A, new Date(T0 + 1000).toISOString()], ["read", A, new Date(T0 + 2000).toISOString()], ["read", A, new Date(T0 + 3000).toISOString()]]);
  await h.from(ME, { receiptMessage: { type: 1, timestamp: [T0] } }); // our own other device never counts as the recipient
  assert.equal(h.receipts().length, 3);
});

test("a receipt that arrives BEFORE the sync transcript of a message sent from another device is replayed after the message", async () => {
  const h = await inboundSetup();
  await h.from(A, { receiptMessage: { type: 0, timestamp: [T0] } }, T0 + 100);
  await h.from(A, { receiptMessage: { type: 1, timestamp: [T0] } }, T0 + 200);
  assert.equal(h.receipts().length, 0);
  await h.from(ME, { syncMessage: { sent: { destinationServiceId: A, timestamp: T0, message: { body: "from phone", timestamp: T0 } } } });
  const order = h.events.map((e) => e.type).filter((t) => t !== "chats-changed");
  assert.deepEqual(order, ["message", "receipt", "receipt"]);
  assert.deepEqual(h.receipts().map((r) => r.status), ["delivered", "read"]);
  assert.equal(h.receipts()[0]!.messageId, messageId(ME, T0));
  assert.equal(h.receipts()[0]!.chatId, A);
});

test("server delivery receipts use the same path (also early) and several devices of the recipient only ever raise the state", async () => {
  const h = await inboundSetup();
  h.inb.serverDeliveryReceipt(A, T0, T0 + 50);
  assert.equal(h.receipts().length, 0);
  h.store.indexSent(messageId(ME, T0), A);
  h.inb.serverDeliveryReceipt(A, T0, T0 + 60);
  assert.equal(h.receipts().length, 1);
  await h.from(A, { receiptMessage: { type: 1, timestamp: [T0, T0 + 1] } });
  assert.equal(h.receipts().filter((r) => r.messageId === messageId(ME, T0)).length, 2);
});

// ---------- #50 client: send race, markRead, read sync ----------
async function clientSetup() {
  const client = new SignalClient({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-signal-st-")) });
  await client.store.load();
  client.store.setAccount({ aci: ME, deviceId: 2, password: "pw", registrationId: 5, aciIdentity: b64(IdentityKeyPair.generate().serialize()), readReceipts: true, linkedAt: 0 });
  const events: CoreEvent[] = [];
  const priv = client as unknown as Record<string, unknown> & { makeInbound(): void; emit: (e: CoreEvent) => void; inbound: Inbound };
  priv.emit = (e) => events.push(e);
  priv.makeInbound(); priv.chatConn = {};
  priv.inbound.releaseDelayMs = 10;
  const calls: { aci: string; content: Content; mode: string }[] = [];
  let onSync: (() => Promise<void>) | undefined;
  priv.sender = { deps: {}, deliver: async (aci: string, content: Content, _t: number, mode: string) => {
    if (mode === "sync" && onSync) await onSync();
    calls.push({ aci, content, mode });
  } };
  return { client, inb: priv.inbound, events, calls, setOnSync: (f: () => Promise<void>) => { onSync = f; } };
}

test("a delivery/read receipt that overtakes send() is not lost: it is delivered after the message was returned", async () => {
  const h = await clientSetup();
  h.setOnSync(async () => { // while the transcript is going out, the recipient's receipts already arrive
    const ts = Number(Object.keys(h.client.store.data.sentIndex)[0]!.split(".")[1]);
    await h.inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { receiptMessage: { type: 0, timestamp: [ts] } } }, ts + 10);
    await h.inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { receiptMessage: { type: 1, timestamp: [ts] } } }, ts + 20);
  });
  const m = await h.client.send(A, { text: "fast" });
  assert.equal(h.events.filter((e) => e.type === "receipt").length, 0, "nothing emitted before the caller has the message");
  await new Promise((r) => setTimeout(r, 60));
  const rs = h.events.filter((e) => e.type === "receipt").map((e) => (e as { data: { messageId: string; status: string } }).data);
  assert.deepEqual(rs.map((r) => [r.messageId, r.status]), [[m.id, "delivered"], [m.id, "read"]]);
});

test("a failed send is not indexed and its receipts are dropped", async () => {
  const h = await clientSetup();
  (h.client as never as { sender: { deliver: () => Promise<void> } }).sender.deliver = async () => { throw new Error("nope"); };
  await assert.rejects(h.client.send(A, { text: "x" }), /nope/);
  assert.deepEqual(Object.keys(h.client.store.data.sentIndex), []);
});

test("markRead acknowledges EVERY older unread message of the chat, one READ receipt per author, and syncs the read to our other devices", async () => {
  const h = await clientSetup();
  const masterKey = new Uint8Array(32).fill(7);
  const gid = groupChatId(groupIdFromMasterKey(masterKey));
  const gm = { groupV2: { masterKey, revision: 1 } };
  for (const [from, ts, extra] of [[A, T0 + 1, {}], [A, T0 + 2, {}], [A, T0 + 4, {}], [B, T0 + 3, gm], [A, T0 + 5, gm]] as const) {
    await h.inb.handle({ senderAci: from, senderDevice: 1, sealed: false, content: { dataMessage: { body: "m", timestamp: ts, ...extra } } }, ts);
  }
  assert.equal(h.client.store.data.chats[A]!.unread, 3);
  await h.client.markRead(A, messageId(A, T0 + 2)); // up to the 2nd: the 4th stays unread
  const rc = h.calls.filter((c) => c.mode === "message");
  assert.equal(rc.length, 1); assert.equal(rc[0]!.aci, A); assert.deepEqual(rc[0]!.content.receiptMessage!.timestamp, [T0 + 1, T0 + 2]); assert.equal(rc[0]!.content.receiptMessage!.type, 1);
  assert.deepEqual(h.calls.find((c) => c.mode === "sync")!.content.syncMessage!.read!.map((r) => r.timestamp), [T0 + 1, T0 + 2]);
  assert.deepEqual(h.client.store.data.unreadIds![A], [messageId(A, T0 + 4)]);
  h.calls.length = 0;
  await h.client.markRead(gid, messageId(A, T0 + 5)); // group: B's older message is acknowledged to B
  const byAci = Object.fromEntries(h.calls.filter((c) => c.mode === "message").map((c) => [c.aci, c.content.receiptMessage!.timestamp]));
  assert.deepEqual(byAci, { [A]: [T0 + 5], [B]: [T0 + 3] });
});

test("markRead with read receipts off sends only the sync; an own message as the bound still acknowledges older incoming ones", async () => {
  const h = await clientSetup();
  h.client.store.account!.readReceipts = false;
  await h.inb.handle({ senderAci: A, senderDevice: 1, sealed: false, content: { dataMessage: { body: "m", timestamp: T0 + 1 } } }, T0 + 1);
  await h.client.markRead(A, messageId(ME, T0 + 9));
  assert.deepEqual(h.calls.map((c) => c.mode), ["sync"]);
  assert.equal(h.calls[0]!.content.syncMessage!.read![0]!.timestamp, T0 + 1);
});

test("SyncMessage.Read from another device clears those messages from the unread count", async () => {
  const h = await inboundSetup();
  for (const ts of [T0 + 1, T0 + 2, T0 + 3]) await h.from(A, { dataMessage: { body: "m", timestamp: ts } });
  assert.equal(h.store.data.chats[A]!.unread, 3);
  h.events.length = 0;
  await h.from(ME, { syncMessage: { read: [{ senderAci: A, timestamp: T0 + 1 }, { senderAci: A, timestamp: T0 + 2 }, { senderAci: A, timestamp: T0 + 99 }] } });
  assert.equal(h.store.data.chats[A]!.unread, 1);
  assert.deepEqual(h.events.map((e) => e.type), ["chats-changed"]);
  await h.from(ME, { syncMessage: { read: [{ senderAci: A, timestamp: T0 + 1 }] } }); // repeated: no double decrement
  assert.equal(h.store.data.chats[A]!.unread, 1);
  await h.from(A, { syncMessage: { read: [{ senderAci: A, timestamp: T0 + 3 }] } }); // sync only trusted from ourselves
  assert.equal(h.store.data.chats[A]!.unread, 1);
});

// ---------- #51 edits ----------
test("incoming edit from a contact: update on the original id with the new text and editedAt", async () => {
  const h = await inboundSetup();
  await h.from(A, { dataMessage: { body: "hello", timestamp: T0 } });
  await h.from(A, { editMessage: { targetSentTimestamp: T0, dataMessage: { body: "hello world", timestamp: T0 + 60_000 } } });
  assert.deepEqual(h.updates().map((u) => [u.chatId, u.messageId, u.patch.text, u.patch.editedAt]), [[A, messageId(A, T0), "hello world", new Date(T0 + 60_000).toISOString()]]);
});

test("successive edits: a 2nd edit that targets the latest revision (or the original) hits the original message", async () => {
  const h = await inboundSetup();
  await h.from(A, { dataMessage: { body: "v1", timestamp: T0 } });
  await h.from(A, { editMessage: { targetSentTimestamp: T0, dataMessage: { body: "v2", timestamp: T0 + 1000 } } });
  await h.from(A, { editMessage: { targetSentTimestamp: T0 + 1000, dataMessage: { body: "v3", timestamp: T0 + 2000 } } }); // targets revision 2
  await h.from(A, { editMessage: { targetSentTimestamp: T0, dataMessage: { body: "v4", timestamp: T0 + 3000 } } }); // targets the original
  assert.deepEqual(h.updates().map((u) => [u.messageId, u.patch.text]), Array.from({ length: 3 }, (_, i) => [messageId(A, T0), `v${i + 2}`]));
  assert.equal(h.updates()[2]!.patch.editedAt, new Date(T0 + 3000).toISOString());
});

test("edits from our own other device (sync transcript) patch our message in the right chat; groups use the group chat", async () => {
  const h = await inboundSetup();
  await h.from(ME, { syncMessage: { sent: { destinationServiceId: A, timestamp: T0 + 500, editMessage: { targetSentTimestamp: T0, dataMessage: { body: "fixed", timestamp: T0 + 500 } } } } });
  assert.deepEqual(h.updates().map((u) => [u.chatId, u.messageId, u.patch.text]), [[A, messageId(ME, T0), "fixed"]]);
  const masterKey = new Uint8Array(32).fill(9);
  await h.from(ME, { syncMessage: { sent: { timestamp: T0 + 900, editMessage: { targetSentTimestamp: T0 + 100, dataMessage: { body: "g", timestamp: T0 + 900, groupV2: { masterKey, revision: 1 } } } } } });
  assert.equal(h.updates()[1]!.chatId, groupChatId(groupIdFromMasterKey(masterKey)));
  await h.from(ME, { syncMessage: { sent: { timestamp: T0 + 950, editMessage: { targetSentTimestamp: T0, dataMessage: { body: "no destination", timestamp: T0 + 950 } } } } });
  assert.equal(h.updates().length, 2, "an edit that cannot be routed is ignored (no phantom chat)");
  assert.ok(!("" in h.store.data.chats));
});

test("edit of an attachment caption and of mentions: the new text replaces the old one", async () => {
  const h = await inboundSetup();
  const mention = Aci.fromUuid(B).getRawUuidBytes();
  await h.from(A, { editMessage: { targetSentTimestamp: T0, dataMessage: { body: "￼ look", timestamp: T0 + 10, bodyRanges: [{ start: 0, length: 1, mentionAciBinary: mention }], attachments: [{ contentType: "image/png", size: 3 }] } } } as Content);
  const u = h.updates()[0]!;
  assert.match(String(u.patch.text), / look$/); assert.ok(!String(u.patch.text).includes("￼"));
  await h.from(A, { editMessage: { targetSentTimestamp: T0, dataMessage: { body: "", timestamp: T0 + 20 } } }); // caption removed
  assert.equal(h.updates()[1]!.patch.text, "");
});

test("an edit that overtook its original is applied to the original when it arrives (and was also emitted at once)", async () => {
  const h = await inboundSetup();
  await h.from(A, { editMessage: { targetSentTimestamp: T0, dataMessage: { body: "edited", timestamp: T0 + 1000 } } });
  assert.equal(h.updates().length, 1);
  await h.from(A, { dataMessage: { body: "original", timestamp: T0 } });
  const m = h.messages().find((x) => x.id === messageId(A, T0))!;
  assert.equal(m.text, "edited"); assert.equal(m.editedAt, new Date(T0 + 1000).toISOString());
});
