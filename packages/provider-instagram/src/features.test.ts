// Offline tests for Instagram features beyond plain messaging: link previews, mentions, members, block, privacy. Fake Instagram only.
import test from "node:test";
import assert from "node:assert/strict";
import factory, { CAPABILITIES } from "./index.js";
import { setup, waitFor } from "./helpers.js";

const prep = (fk: any) => {
  fk.addThread("t1", ["2001"]); fk.text("t1", "2001", "hello from alice");
  fk.addThread("tg", ["2001", "2002"], { group: true, title: "Weekend" }); fk.text("tg", "2002", "group msg");
};
const form = (r: any) => r.body;

test("capabilities: what Instagram's app can do that UniChat now does; edit and polls stay off", async () => {
  const s = await setup(factory, { prep });
  try {
    const c: any = s.conn;
    assert.ok(CAPABILITIES.mentions && CAPABILITIES.manageMembers && CAPABILITIES.block && CAPABILITIES.privacy);
    for (const m of ["addMembers", "removeMember", "blockChat", "getPrivacy", "setPrivacy"]) assert.equal(typeof c[m], "function", m);
    assert.ok(!CAPABILITIES.edits && !CAPABILITIES.polls && c.edit === undefined && c.vote === undefined, "no verified edit or poll API: not offered");
  } finally { await s.close(); }
});

test("link previews: a URL goes through the link endpoint (Instagram builds the card); replies and plain text use the text endpoint", async () => {
  const s = await setup(factory, { prep });
  try {
    await s.conn.chats(); const F = s.fake;
    const m = await s.conn.send("t1", { text: "look https://example.org/a?x=1 and https://example.org/b" });
    const r = F.reqs(/broadcast\/link\/$/).pop()!;
    assert.equal(r.body.link_text, "look https://example.org/a?x=1 and https://example.org/b");
    assert.deepEqual(JSON.parse(r.body.link_urls), ["https://example.org/a?x=1", "https://example.org/b"]); assert.equal(r.body.text, undefined);
    assert.equal(m.text, "look https://example.org/a?x=1 and https://example.org/b");
    const h = await s.conn.history("t1", { limit: 3 });
    const got = h.find((x: any) => x.id === m.id); assert.equal(got.card?.kind, "link"); assert.match(got.card.title, /Preview of/);
    const n = F.reqs(/broadcast\/text\/$/).length;
    await s.conn.send("t1", { text: "no link here" }); assert.equal(F.reqs(/broadcast\/text\/$/).length, n + 1);
    await s.conn.send("t1", { text: "reply https://example.org", replyToMessageId: m.id }); assert.equal(F.reqs(/broadcast\/text\/$/).pop()!.body.replied_to_item_id, m.id);
  } finally { await s.close(); }
});

test("mentions: @Name becomes @username plus mentioned_user_ids; unknown people and bad spans are ignored", async () => {
  const s = await setup(factory, { prep });
  try {
    await s.conn.chats(); await s.conn.members("tg"); const F = s.fake;
    const text = "hi @Alice Anderson and @Bob Builder!";
    await s.conn.send("tg", { text, mentions: [{ id: "2001", name: "Alice Anderson", start: 3, length: 15 }, { id: "2002", name: "Bob Builder", start: 23, length: 12 }, { id: "9999", name: "Ghost", start: 0, length: 2 }, { id: "2001", name: "x", start: 1, length: 2 }] });
    const b = F.reqs(/broadcast\/text\/$/).pop()!.body;
    assert.equal(b.text, "hi @alice and @bob!"); assert.deepEqual(JSON.parse(b.mentioned_user_ids), ["2001", "2002"]);
    await s.conn.send("tg", { text: "plain" }); assert.equal(F.reqs(/broadcast\/text\/$/).pop()!.body.mentioned_user_ids, undefined);
  } finally { await s.close(); }
});

test("members: add by username, remove, only in groups; admin refusal surfaces", async () => {
  const s = await setup(factory, { prep });
  try {
    await s.conn.chats(); const F = s.fake;
    await s.conn.addMembers("tg", ["@carol"]);
    assert.deepEqual(JSON.parse(F.reqs(/add_user\/$/).pop()!.body.user_ids), ["2003"]); assert.equal(F.threads.get("tg").users.length, 3);
    await s.conn.addMembers("tg", ["alice"]); assert.equal(F.reqs(/add_user\/$/).length, 1, "already a member: no request");
    await waitFor(() => s.of("chats-changed").length > 0);
    assert.ok((await s.conn.members("tg")).some((c: any) => c.id === "2003"));
    await s.conn.removeMember("tg", "2003"); assert.deepEqual(JSON.parse(F.reqs(/remove_users\/$/).pop()!.body.user_ids), ["2003"]); assert.equal(F.threads.get("tg").users.length, 2);
    F.notAdmin = true; await assert.rejects(s.conn.removeMember("tg", "2002"));
    await assert.rejects(s.conn.addMembers("t1", ["carol"]), /Only group/); await assert.rejects(s.conn.addMembers("nope", ["carol"]), /Unknown chat/);
    await assert.rejects(s.conn.removeMember("tg", "x; drop"), /Unknown member/);
    await assert.rejects(s.conn.addMembers("tg", ["no such user!"]), /username/);
  } finally { await s.close(); }
});

test("block / unblock the person of a 1:1 chat; groups refused", async () => {
  const s = await setup(factory, { prep });
  try {
    await s.conn.chats(); const F = s.fake;
    await s.conn.blockChat("t1", true); assert.ok(F.blocked.has("2001")); assert.ok(F.reqs(/friendships\/block\/2001\/$/).length === 1);
    await s.conn.blockChat("t1", false); assert.ok(!F.blocked.has("2001"));
    await assert.rejects(s.conn.blockChat("tg", true), /Only a one-to-one/); await assert.rejects(s.conn.blockChat("new:2003", true), /Only a one-to-one/);
  } finally { await s.close(); }
});

test("privacy: private account on/off, unknown settings refused", async () => {
  const s = await setup(factory, { prep });
  try {
    await s.conn.chats(); const F = s.fake;
    let l = await s.conn.getPrivacy(); assert.deepEqual(l.map((x: any) => [x.id, x.value]), [["private_account", "public"]]);
    l = await s.conn.setPrivacy("private_account", "private"); assert.equal(F.isPrivate, true); assert.equal(l[0].value, "private");
    l = await s.conn.setPrivacy("private_account", "public"); assert.equal(F.isPrivate, false); assert.equal(l[0].value, "public");
    await assert.rejects(s.conn.setPrivacy("private_account", "friends"), /Unknown/); await assert.rejects(s.conn.setPrivacy("read_receipts", "off"), /Unknown/);
  } finally { await s.close(); }
});
