// Pinned messages (DataMessage.pinMessage / unpinMessage): outgoing wire shape (proto round trip), incoming marking. Fake Sender, throwaway store. No network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Aci, IdentityKeyPair } from "@signalapp/libsignal-client";
import type { CoreEvent } from "@unimsg/core";
import { ContentCodec, type Content } from "../protocol/codec.js";
import { SignalClient } from "../service/client.js";

const ME = "22222222-2222-4222-8222-222222222222";
const BOB = "44444444-4444-4444-8444-444444444444";

async function setup() {
  const client = new SignalClient({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-signal-pin-")) });
  await client.store.load();
  client.store.setAccount({ aci: ME, deviceId: 2, password: "pw", registrationId: 5, aciIdentity: Buffer.from(IdentityKeyPair.generate().serialize()).toString("base64"), readReceipts: true, linkedAt: 0 });
  const events: CoreEvent[] = [];
  const priv = client as unknown as Record<string, any>;
  priv.emit = (e: CoreEvent) => events.push(e);
  priv.makeInbound(); priv.chatConn = {};
  const calls: { aci: string; content: Content; ts: number; mode: string }[] = [];
  priv.sender = { deliver: async (aci: string, content: Content, ts: number, mode: string) => { calls.push({ aci, content, ts, mode }); } };
  return { client, events, calls, inbound: priv.inbound as { handle(env: unknown, ts: number): Promise<void> } };
}
const updates = (events: CoreEvent[]) => events.filter((e) => e.type === "message-update").map((e: any) => e.data);

test("pin() sends DataMessage.pinMessage (target author ACI + sent timestamp + duration), unpin() sends unpinMessage; both survive the proto round trip", async () => {
  const h = await setup();
  await h.client.pin(BOB, `${BOB}.1234`, true, { durationSec: 86400 });
  const msg = h.calls.find((c) => c.mode === "message")!;
  const rt = ContentCodec.decode(ContentCodec.encode(msg.content));
  assert.deepEqual(Buffer.from(rt.dataMessage!.pinMessage!.targetAuthorAciBinary!), Buffer.from(Aci.fromUuid(BOB).getRawUuidBytes()));
  assert.equal(Number(rt.dataMessage!.pinMessage!.targetSentTimestamp), 1234); assert.equal(rt.dataMessage!.pinMessage!.pinDurationSeconds, 86400);
  const u = updates(h.events).at(-1); assert.equal(u.messageId, `${BOB}.1234`); assert.equal(u.patch.pinned, true); assert.equal(u.patch.pinnedBy, ME);
  assert.equal(Date.parse(u.patch.pinnedUntil) - Date.parse(u.patch.pinnedAt), 86400_000);
  assert.ok(h.calls.some((c) => c.mode === "sync"), "own devices get a transcript");
  h.calls.length = 0;
  await h.client.pin(BOB, `${BOB}.1234`, true, { durationSec: 0 }); // until removed
  assert.equal(ContentCodec.decode(ContentCodec.encode(h.calls[0]!.content)).dataMessage!.pinMessage!.pinDurationForever, true);
  assert.equal(updates(h.events).at(-1).patch.pinnedUntil, undefined);
  h.calls.length = 0;
  await h.client.pin(BOB, `${BOB}.1234`, false);
  const un = ContentCodec.decode(ContentCodec.encode(h.calls[0]!.content)).dataMessage!;
  assert.equal(Number(un.unpinMessage!.targetSentTimestamp), 1234); assert.equal(un.pinMessage, undefined);
  assert.deepEqual(updates(h.events).at(-1).patch, { pinned: false });
});

test("incoming pin / unpin marks the target message (with expiry), the notice stays", async () => {
  const h = await setup();
  const target = Aci.fromUuid(ME).getRawUuidBytes();
  await h.inbound.handle({ senderAci: BOB, senderDevice: 1, sealed: false, content: { dataMessage: { timestamp: 5000, pinMessage: { targetAuthorAciBinary: target, targetSentTimestamp: 77, pinDurationSeconds: 604800 } } } }, 5000);
  let u = updates(h.events).at(-1); assert.equal(u.messageId, `${ME}.77`); assert.equal(u.patch.pinned, true); assert.equal(u.patch.pinnedBy, BOB);
  assert.equal(u.patch.pinnedUntil, new Date(5000 + 604800_000).toISOString());
  assert.ok(h.events.some((e) => e.type === "message" && /pinned a message/.test((e as any).data.text)));
  await h.inbound.handle({ senderAci: BOB, senderDevice: 1, sealed: false, content: { dataMessage: { timestamp: 6000, unpinMessage: { targetAuthorAciBinary: target, targetSentTimestamp: 77 } } } }, 6000);
  u = updates(h.events).at(-1); assert.deepEqual(u.patch, { pinned: false });
  await h.inbound.handle({ senderAci: BOB, senderDevice: 1, sealed: false, content: { dataMessage: { timestamp: 7000, pinMessage: { targetAuthorAciBinary: target, targetSentTimestamp: 78, pinDurationForever: true } } } }, 7000);
  assert.equal(updates(h.events).at(-1).patch.pinnedUntil, undefined);
});
