// Threads: a root post and its replies open as a chat of their own ("thread~<root id>"); the channel keeps showing replies inline.
import test from "node:test";
import assert from "node:assert/strict";
import factory from "./index.js";
import { setup, waitFor } from "./helpers.js";

test("threads: links on root and replies, open as a chat, history, send, live replies and edits reach both views", async () => {
  let rootId = "";
  const s = await setup(factory, { prep: (f) => {
    const r = f.addPost("c_town", "u_bob", "Kann jemand die Mail weiterleiten?", { reply_count: 2 }); rootId = r.id;
    f.addPost("c_town", "u_carol", "first answer", { root_id: r.id });
    f.addPost("c_town", "u_bob", "plain");
    f.addPost("c_town", "u_carol", "second answer", { root_id: r.id });
  } });
  try {
    await waitFor(s.connected);
    const tid = `thread~${rootId}`;
    const hist = await s.conn.history("c_town", { limit: 10 });
    assert.deepEqual(hist.map((m: any) => [m.text, m.thread?.id ?? null, m.thread?.count ?? null]), [
      ["Kann jemand die Mail weiterleiten?", tid, 2], ["first answer", tid, null], ["plain", null, null], ["second answer", tid, null],
    ]);

    // opening by a reply's id finds the root's thread; it is then listed with the chats
    await assert.rejects(s.conn.openThread!("thread~../x"), /Unknown thread/);
    const chat = await s.conn.openThread!(`thread~${hist[1].id}`);
    assert.equal(chat.id, tid); assert.equal(chat.name, "Kann jemand die Mail weiterleiten?"); assert.equal(chat.spaceId, "t1"); assert.equal(chat.description, "Thread in ~Town Square");
    assert.ok((await s.conn.chats()).some((c: any) => c.id === tid));

    const th = await s.conn.history(tid, { limit: 50 });
    assert.deepEqual(th.map((m: any) => m.text), ["Kann jemand die Mail weiterleiten?", "first answer", "second answer"]);
    assert.ok(th.every((m: any) => m.chatId === tid && !m.replyTo && !m.thread));
    assert.deepEqual((await s.conn.history(tid, { limit: 1, beforeMessageId: th[2].id })).map((m: any) => m.text), ["first answer"]);
    assert.equal((await s.conn.members(tid)).length, 3);

    // sending in the thread replies to the root; the channel gets its copy and the root's count goes up
    const sent = await s.conn.send(tid, { text: "danke" });
    const body = s.fake.reqs(/^POST \/posts$/).pop()!.body;
    assert.equal(body.channel_id, "c_town"); assert.equal(body.root_id, rootId);
    assert.equal(sent.chatId, tid); assert.ok(!sent.replyTo);
    await waitFor(() => s.of("message").some((m: any) => m.chatId === "c_town" && m.text === "danke"), 2000, "channel copy");
    assert.ok(s.ev.some((e: any) => e.type === "message-update" && e.data.chatId === "c_town" && e.data.messageId === rootId && e.data.patch.thread?.count === 3));

    // a live reply from someone else shows in the channel and the thread
    const live = s.fake.addPost("c_town", "u_bob", "live reply", { root_id: rootId }); s.fake.pushPosted(live);
    await waitFor(() => s.of("message").filter((m: any) => m.text === "live reply").length === 2, 2000, "live reply twice");
    assert.deepEqual(s.of("message").filter((m: any) => m.text === "live reply").map((m: any) => m.chatId).sort(), ["c_town", tid]);

    // an edit reaches both views
    await s.conn.edit(tid, th[1].id, "first answer (edited)");
    await waitFor(() => s.ev.filter((e: any) => e.type === "message-update" && e.data.messageId === th[1].id && e.data.patch.text).length === 2, 2000, "edit twice");

    // posting in an unrelated channel thread that is not open stays in the channel only
    const other = s.fake.addPost("c_town", "u_bob", "elsewhere", { root_id: hist[2].id }); s.fake.pushPosted(other);
    await waitFor(() => s.of("message").some((m: any) => m.text === "elsewhere"));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.of("message").filter((m: any) => m.text === "elsewhere").length, 1);
  } finally { await s.close(); }
});
