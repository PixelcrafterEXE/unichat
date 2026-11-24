// Threads (issue #80): "X started a thread" lines and starter messages link to the thread's chat; an archived thread opens too.
import test from "node:test";
import assert from "node:assert/strict";
import factory from "./index.js";
import { mapMessage, type DcMessage } from "./map.js";
import { C, ALICE, G1, setup } from "./helpers.js";

const ctx = { me: "1", user: () => undefined, emoji: () => "", channel: () => undefined, role: () => undefined } as any;
const at = (extra: Partial<DcMessage>): DcMessage => ({ id: "300000000000001", channel_id: C.general, author: { id: ALICE, username: "alice" } as any, timestamp: "2026-11-20T10:00:00Z", content: "", ...extra });

test("'started a thread' is a network notice that links to the thread", () => {
  const { msg } = mapMessage(at({ type: 18, content: "Kann jemand die Mail", message_reference: { channel_id: C.thread, guild_id: G1 } as any }), ctx);
  assert.deepEqual(msg.system, { kind: "info" }); assert.equal(msg.sender, "");
  assert.match(msg.text, /started a thread: Kann jemand die Mail/);
  assert.deepEqual(msg.thread, { id: C.thread, name: "Kann jemand die Mail" });
});

test("the message a thread started from links to it, with the reply count", () => {
  const { msg } = mapMessage(at({ type: 0, content: "who has the mail?", thread: { id: C.thread, type: 11, name: "Mail", message_count: 4 } }), ctx);
  assert.equal(msg.system, undefined); assert.equal(msg.text, "who has the mail?");
  assert.deepEqual(msg.thread, { id: C.thread, name: "Mail", count: 4 });
  assert.equal(mapMessage(at({ type: 0, content: "plain" }), ctx).msg.thread, undefined);
});

test("openThread: an active thread is the known chat; an archived one is fetched, listed from then on, and a non-thread is refused", async () => {
  const s = await setup(factory);
  try {
    await s.loaded();
    const t = await s.conn.openThread(C.thread); assert.equal(t.id, C.thread); assert.equal(t.name, "side-talk");
    assert.equal(t.parentId, C.general, "a thread names its channel, so the list folds it under that channel");
    assert.ok((await s.conn.chats()).filter((c: any) => c.id !== C.thread).every((c: any) => !c.parentId), "channels, DMs and forum posts (the forum is not a chat) have no parent");
    const OLD = "200000000000077";
    s.fake.channel({ id: OLD, type: 11, guild_id: G1, name: "old thread", parent_id: C.general, thread_metadata: { archived: true } });
    assert.ok(!(await s.conn.chats()).some((c: any) => c.id === OLD), "not in the list before (archived threads are not sent at start)");
    const o = await s.conn.openThread(OLD); assert.equal(o.id, OLD); assert.equal(o.name, "old thread"); assert.equal(o.parentId, C.general);
    assert.ok((await s.conn.chats()).some((c: any) => c.id === OLD), "listed after opening");
    await assert.rejects(s.conn.openThread(C.general), /not a thread/);
    await assert.rejects(s.conn.openThread("nope"), /Unknown thread/);
  } finally { await s.close(); }
});

test("threadOf: a 'started a thread' line saved without its link asks Discord which thread it was, opens it and fixes the saved copy", async () => {
  let line = "", plain = "";
  const s = await setup(factory, { prep: (f) => {
    line = f.say(C.general, ALICE, "side-talk", { type: 18, message_reference: { channel_id: C.thread, guild_id: G1 } as any }).id;
    plain = f.say(C.general, ALICE, "just text").id;
  } });
  try {
    await s.loaded();
    const t = await s.conn.threadOf(C.general, line);
    assert.equal(t.id, C.thread);
    assert.ok(s.ev.some((e: any) => e.type === "message-update" && e.data.messageId === line && e.data.patch.thread?.id === C.thread), "the saved line gets its link");
    await assert.rejects(s.conn.threadOf(C.general, plain), /did not start a thread/);
    await assert.rejects(s.conn.threadOf(C.general, "x"), /Unknown message/);
  } finally { await s.close(); }
});
