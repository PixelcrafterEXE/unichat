// Threads: a root post and its replies open as a chat of their own ("thread~<root id>"); the chat itself holds root posts only (collapsed threads), and its threads are listed under it.
import test from "node:test";
import assert from "node:assert/strict";
import factory from "./index.js";
import { setup, waitFor } from "./helpers.js";

test("threads: a chat holds root posts only; each thread is listed under it and holds its replies; live replies, sends and edits reach the thread only", async () => {
  let rootId = "", firstId = "";
  const s = await setup(factory, { prep: (f) => {
    const r = f.addPost("c_town", "u_bob", "Kann jemand die Mail weiterleiten?"); rootId = r.id;
    firstId = f.addPost("c_town", "u_carol", "first answer", { root_id: r.id }).id;
    f.addPost("c_town", "u_bob", "plain");
    f.addPost("c_town", "u_carol", "second answer", { root_id: r.id });
  } });
  try {
    await waitFor(s.connected);
    const tid = `thread~${rootId}`;
    assert.ok(!(await s.conn.chats()).some((c: any) => c.id === tid), "not known before the chat is read");
    const hist = await s.conn.history("c_town", { limit: 10 });
    assert.ok(s.fake.reqs(/channels\/c_town\/posts/).some((l) => l.query.get("collapsedThreads") === "true"), "asks for collapsed threads");
    assert.deepEqual(hist.map((m: any) => [m.text, m.thread?.id ?? null, m.thread?.count ?? null]), [["Kann jemand die Mail weiterleiten?", tid, 2], ["plain", null, null]], "replies are not in the chat");
    // reading the chat found its thread: listed under it (parentId) without opening it
    assert.ok(s.ev.some((e: any) => e.type === "chats-changed"));
    const listed = (await s.conn.chats()).find((c: any) => c.id === tid);
    assert.ok(listed); assert.equal(listed.parentId, "c_town"); assert.equal(listed.name, "Kann jemand die Mail weiterleiten?");

    // opening by a reply's id finds the root's thread
    await assert.rejects(s.conn.openThread!("thread~../x"), /Unknown thread/);
    const chat = await s.conn.openThread!(`thread~${firstId}`);
    assert.equal(chat.id, tid); assert.equal(chat.spaceId, "t1"); assert.equal(chat.description, "Thread in ~Town Square"); assert.equal(chat.parentId, "c_town");

    const th = await s.conn.history(tid, { limit: 50 });
    assert.deepEqual(th.map((m: any) => m.text), ["Kann jemand die Mail weiterleiten?", "first answer", "second answer"]);
    assert.ok(th.every((m: any) => m.chatId === tid && !m.replyTo && !m.thread));
    assert.deepEqual((await s.conn.history(tid, { limit: 1, beforeMessageId: th[2].id })).map((m: any) => m.text), ["first answer"]);
    assert.equal((await s.conn.members(tid)).length, 3);

    // sending in the thread replies to the root; no copy in the chat, the root's count goes up there
    const sent = await s.conn.send(tid, { text: "danke" });
    const body = s.fake.reqs(/^POST \/posts$/).pop()!.body;
    assert.equal(body.channel_id, "c_town"); assert.equal(body.root_id, rootId);
    assert.equal(sent.chatId, tid); assert.ok(!sent.replyTo);
    await waitFor(() => s.ev.some((e: any) => e.type === "message-update" && e.data.chatId === "c_town" && e.data.messageId === rootId && e.data.patch.thread?.count === 3), 2000, "root count");
    assert.ok(!s.of("message").some((m: any) => m.text === "danke"), "no copy of the reply in the chat");

    // a live reply from someone else shows in the thread only
    const live = s.fake.addPost("c_town", "u_bob", "live reply", { root_id: rootId }); s.fake.pushPosted(live);
    await waitFor(() => s.of("message").some((m: any) => m.text === "live reply"), 2000, "live reply");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(s.of("message").filter((m: any) => m.text === "live reply").map((m: any) => m.chatId), [tid]);

    // an edit of a reply reaches the thread only
    await s.conn.edit(tid, th[1].id, "first answer (edited)");
    await waitFor(() => s.ev.some((e: any) => e.type === "message-update" && e.data.messageId === th[1].id && e.data.patch.text), 2000, "edit");
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(s.ev.filter((e: any) => e.type === "message-update" && e.data.messageId === th[1].id && e.data.patch.text).map((e: any) => e.data.chatId), [tid]);

    // the first reply to another post starts a thread: it is listed under the chat at once and holds the reply
    const n = s.ev.filter((e: any) => e.type === "chats-changed").length;
    const other = s.fake.addPost("c_town", "u_bob", "elsewhere", { root_id: hist[1].id }); s.fake.pushPosted(other);
    await waitFor(() => s.of("message").some((m: any) => m.text === "elsewhere"));
    assert.deepEqual(s.of("message").filter((m: any) => m.text === "elsewhere").map((m: any) => m.chatId), [`thread~${hist[1].id}`]);
    assert.ok(s.ev.filter((e: any) => e.type === "chats-changed").length > n);
    assert.equal((await s.conn.chats()).find((c: any) => c.id === `thread~${hist[1].id}`)?.parentId, "c_town");
  } finally { await s.close(); }
});
