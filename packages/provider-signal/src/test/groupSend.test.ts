// Groups v2 sending (fan-out): fake Sender, stub group resolver, generated keys, throwaway temp-dir store. No network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { IdentityKeyPair } from "@signalapp/libsignal-client";
import type { CoreEvent } from "@unimsg/core";
import type { Content } from "../protocol/codec.js";
import { SendError } from "../service/sender.js";
import { SignalClient } from "../service/client.js";
import { groupChatId, groupIdFromMasterKey } from "../service/groups.js";

const ME = "22222222-2222-4222-8222-222222222222";
const A = "11111111-1111-4111-8111-111111111111";
const B = "44444444-4444-4444-8444-444444444444";
const C = "55555555-5555-4555-8555-555555555555";

interface Call { aci: string; content: Content; ts: number; mode: string; opts?: { onlineOnly?: boolean } }

async function setup(opts: { members?: string[]; resolve?: "ok" | "missing"; failFor?: Record<string, Error>; fetchedAgo?: number } = {}) {
  const client = new SignalClient({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-signal-gsend-")) });
  await client.store.load();
  client.store.setAccount({ aci: ME, deviceId: 2, password: "pw", registrationId: 5, aciIdentity: Buffer.from(IdentityKeyPair.generate().serialize()).toString("base64"), readReceipts: true, linkedAt: 0 });
  const events: CoreEvent[] = [];
  const priv = client as unknown as Record<string, unknown> & { makeInbound(): void; emit: (e: CoreEvent) => void };
  priv.emit = (e) => events.push(e);
  const masterKey = randomBytes(32);
  const chatId = groupChatId(groupIdFromMasterKey(masterKey));
  const members = opts.members ?? [ME, A, B, C];
  let ensures = 0;
  priv.groupResolver = {
    needs: () => false, request: async () => {},
    ensure: async () => {
      ensures++;
      if (opts.resolve === "missing") return "missing";
      client.store.upsertChat({ id: chatId, kind: "group", groupMasterKey: Buffer.from(masterKey).toString("base64"), groupRevision: 7, groupMembers: members });
      client.store.data.chats[chatId]!.groupFetchedAt = Date.now();
      return "refreshed";
    },
  };
  priv.makeInbound();
  priv.chatConn = {};
  const calls: Call[] = [];
  priv.sender = { deliver: async (aci: string, content: Content, ts: number, mode: string, o?: Call["opts"]) => {
    const err = opts.failFor?.[aci]; if (err && mode === "message") throw err;
    calls.push({ aci, content, ts, mode, opts: o });
  } };
  return { client, chatId, masterKey, events, calls, ensures: () => ensures };
}
const toMembers = (calls: Call[]) => calls.filter((c) => c.mode === "message").map((c) => c.aci);
const gv2 = (h: { masterKey: Uint8Array }) => ({ masterKey: new Uint8Array(h.masterKey), revision: 7 });

test("group send: text fans out to every member except self, with groupV2, plus one transcript", async () => {
  const h = await setup();
  const m = await h.client.send(h.chatId, { text: "hello group" });
  assert.deepEqual(toMembers(h.calls).sort(), [A, B, C].sort());
  for (const c of h.calls.filter((x) => x.mode === "message")) {
    assert.equal(c.content.dataMessage!.body, "hello group");
    assert.deepEqual(c.content.dataMessage!.groupV2, gv2(h));
    assert.equal(c.ts, m.time ? Date.parse(m.time) : -1);
  }
  const sync = h.calls.filter((c) => c.mode === "sync");
  assert.equal(sync.length, 1); assert.equal(sync[0]!.aci, ME);
  const sent = sync[0]!.content.syncMessage!.sent!;
  assert.equal(sent.destinationServiceId, undefined); assert.equal(sent.timestamp, h.calls[0]!.ts);
  assert.deepEqual(sent.message!.groupV2, gv2(h));
  assert.equal(m.chatId, h.chatId); assert.equal(m.status, "sent"); assert.equal(m.fromMe, true);
  assert.equal(h.client.store.data.sentIndex[m.id], h.chatId);
  assert.equal(h.client.store.data.chats[h.chatId]!.kind, "group");
  assert.equal(h.events.length, 0);
});

test("group send: reply, reaction, edit and delete carry the group context", async () => {
  const h = await setup();
  const m = await h.client.send(h.chatId, { text: "orig", replyToMessageId: `${A}.1234` });
  assert.deepEqual([h.calls[0]!.content.dataMessage!.quote!.id, h.calls[0]!.content.dataMessage!.quote!.authorAci], [1234, A]);
  assert.deepEqual(h.calls[0]!.content.dataMessage!.groupV2, gv2(h));
  h.calls.length = 0;

  await h.client.react(h.chatId, `${A}.1234`, "\u{1F44D}");
  assert.equal(toMembers(h.calls).length, 3);
  let dm = h.calls[0]!.content.dataMessage!;
  assert.deepEqual([dm.reaction!.emoji, dm.reaction!.remove, dm.reaction!.targetSentTimestamp], ["\u{1F44D}", false, 1234]);
  assert.deepEqual(dm.groupV2, gv2(h));
  h.calls.length = 0;
  await h.client.react(h.chatId, `${A}.1234`, null);
  assert.equal(h.calls[0]!.content.dataMessage!.reaction!.remove, true);
  h.calls.length = 0;

  await h.client.edit(h.chatId, m.id, "edited");
  const em = h.calls[0]!.content.editMessage!;
  assert.deepEqual([em.dataMessage!.body, em.targetSentTimestamp], ["edited", Number(m.id.split(".")[1])]);
  assert.deepEqual(em.dataMessage!.groupV2, gv2(h));
  assert.deepEqual(h.calls.find((c) => c.mode === "sync")!.content.syncMessage!.sent!.editMessage!.dataMessage!.groupV2, gv2(h));
  h.calls.length = 0;

  await h.client.delete(h.chatId, m.id);
  dm = h.calls[0]!.content.dataMessage!;
  assert.equal(dm.delete!.targetSentTimestamp, Number(m.id.split(".")[1]));
  assert.deepEqual(dm.groupV2, gv2(h)); assert.equal(toMembers(h.calls).length, 3);
  await assert.rejects(h.client.edit(h.chatId, `${A}.5`, "x"), /own messages/);
});

test("group typing: groupId to members, online-only; read receipt goes to the author", async () => {
  const h = await setup();
  await h.client.send(h.chatId, { text: "prime" }); // caches state
  h.calls.length = 0;
  await h.client.setTyping(h.chatId, true);
  assert.deepEqual(toMembers(h.calls).sort(), [A, B, C].sort());
  for (const c of h.calls) {
    assert.deepEqual(c.content.typingMessage!.groupId, groupIdFromMasterKey(h.masterKey)); assert.equal(c.opts?.onlineOnly, true);
  }
  h.calls.length = 0;
  h.client.store.data.chats[h.chatId]!.unread = 3;
  await h.client.markRead(h.chatId, `${B}.99`);
  assert.equal(h.client.store.data.chats[h.chatId]!.unread, 0);
  const rc = h.calls.find((c) => c.mode === "message")!;
  assert.equal(rc.aci, B); assert.deepEqual(rc.content.receiptMessage!.timestamp, [99]);
});

test("group send: partial failure succeeds and warns with a count only", async () => {
  const h = await setup({ failFor: { [B]: new SendError("recipient is no longer registered with Signal") } });
  const m = await h.client.send(h.chatId, { text: "partial" });
  assert.equal(m.status, "sent");
  assert.deepEqual(toMembers(h.calls).sort(), [A, C].sort());
  assert.equal(h.calls.filter((c) => c.mode === "sync").length, 1);
  const w = h.events.filter((e) => e.type === "error");
  assert.equal(w.length, 1);
  const d = (w[0] as { data: { message: string; code: string; fatal?: boolean } }).data;
  assert.equal(d.message, "The message was not delivered to 1 person in this group.");
  assert.ok(!d.fatal);
  for (const id of [A, B, C, ME, h.chatId]) assert.ok(!d.message.includes(id));

  const h2 = await setup({ failFor: { [A]: new Error("x"), [C]: new Error("y") } });
  await h2.client.send(h2.chatId, { text: "partial" });
  assert.match((h2.events[0] as { data: { message: string } }).data.message, /not delivered to 2 people/);

  // nobody got it: error, no sync transcript, nothing recorded as sent
  const h3 = await setup({ failFor: { [A]: new Error("x"), [B]: new Error("y"), [C]: new Error("z") } });
  await assert.rejects(h3.client.send(h3.chatId, { text: "none" }), /could not be delivered to anyone/);
  assert.equal(h3.calls.length, 0); assert.deepEqual(Object.keys(h3.client.store.data.sentIndex), []);
});

test("group send: unresolved state and non-membership give clear errors and send nothing", async () => {
  const h = await setup({ resolve: "missing" });
  h.client.store.upsertChat({ id: h.chatId, kind: "group", groupMasterKey: Buffer.from(h.masterKey).toString("base64") });
  for (const op of [() => h.client.send(h.chatId, { text: "x" }), () => h.client.react(h.chatId, `${A}.1`, "x"), () => h.client.delete(h.chatId, `${ME}.1`)]) {
    await assert.rejects(op(), (e: Error) => /Couldn't load this group's details from Signal/.test(e.message) && !/state|revision|key|credential|zk/i.test(e.message));
  }
  assert.equal(h.calls.length, 0);
  await h.client.setTyping(h.chatId, true); assert.equal(h.calls.length, 0); // typing never throws

  const h2 = await setup({ members: [A, B] });
  await assert.rejects(h2.client.send(h2.chatId, { text: "x" }), /no longer a member/);
  assert.equal(h2.calls.length, 0);
});

test("group send: fresh cached state is used as is; polls are refused; self-only group still syncs", async () => {
  const h = await setup();
  await h.client.send(h.chatId, { text: "a" });
  assert.equal(h.ensures(), 1);
  await assert.rejects(h.client.send(h.chatId, { text: "", poll: { question: "q", options: ["a", "b"] } }), /not implemented/);
  await assert.rejects(h.client.vote(h.chatId, `${A}.1`, ["0"]), /not implemented/);
  const solo = await setup({ members: [ME] });
  await solo.client.send(solo.chatId, { text: "just me" });
  assert.deepEqual(solo.calls.map((c) => c.mode), ["sync"]);
});

test("group send: debug lines carry counts only", async () => {
  const lines: string[] = [];
  const orig = console.debug; const prev = process.env.UNIMSG_DEBUG;
  process.env.UNIMSG_DEBUG = "1"; console.debug = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const h = await setup({ failFor: { [B]: new Error("x") } });
    await h.client.send(h.chatId, { text: "secret body 99" });
    await h.client.setTyping(h.chatId, true);
    assert.deepEqual(lines, [
      "[signal] groups v2: send state=refreshed members=3 delivered=2 failed=1 sync=ok",
      "[signal] groups v2: typing members=3 delivered=2 failed=1",
    ]);
  } finally { console.debug = orig; if (prev === undefined) delete process.env.UNIMSG_DEBUG; else process.env.UNIMSG_DEBUG = prev; }
});
