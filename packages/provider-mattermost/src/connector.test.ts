// Offline tests: the connector against an in-process fake Mattermost server (http + ws on 127.0.0.1). No real server is contacted.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import factory from "./index.js";
import { normaliseServer } from "./api.js";
import { emojiFromName, emojiToName, shortcodesToUnicode } from "./emoji.js";
import { PNG } from "./fake-server.js";
import { setup, waitFor } from "./helpers.js";

const sess = (dir: string) => join(dir, "mattermost-session.json");

test("normaliseServer", () => {
  assert.equal(normaliseServer("communicating.tuhh.de"), "https://communicating.tuhh.de");
  assert.equal(normaliseServer(" https://x.org/chat/ "), "https://x.org/chat");
  assert.equal(normaliseServer("http://127.0.0.1:81"), "http://127.0.0.1:81");
  assert.throws(() => normaliseServer("http://example.org"), /clear text/);
  assert.throws(() => normaliseServer("https://u:p@example.org"), /user name/);
  assert.throws(() => normaliseServer(""));
});

test("emoji mapping", () => {
  assert.equal(emojiFromName("+1"), "👍"); assert.equal(emojiFromName("thumbsup"), "👍"); assert.equal(emojiFromName("heart"), "❤️");
  assert.equal(emojiFromName("+1::skin-tone-2"), "👍"); assert.equal(emojiFromName("call_me_hand"), "🤙"); assert.equal(emojiToName("🤙"), "call_me_hand"); assert.equal(emojiFromName("partyparrot"), ":partyparrot:");
  assert.equal(emojiToName("👍"), "+1"); assert.equal(emojiToName("❤"), "heart"); assert.equal(emojiToName("❤️"), "heart");
  assert.equal(emojiToName(":partyparrot:"), "partyparrot"); assert.equal(emojiToName("🦖🦖"), undefined);
});

test("login: password, session persisted 0600, token only in Authorization", async () => {
  const s = await setup(factory, { noSession: true });
  try {
    await waitFor(() => s.of("login").length > 0, 3000, "login prompt");
    assert.ok(s.ev.some((e) => e.type === "account" && e.data.state === "needs-login"));
    const p = s.of("login")[0];
    assert.equal(p.kind, "form"); assert.deepEqual(p.fields.map((f: any) => f.name), ["server", "login_id", "password", "token"]);
    assert.match(p.title, /MMAUTHTOKEN/); assert.match(p.title, /Personal Access Token/);
    await assert.rejects(s.conn.submitLogin(p.promptId, { server: s.fake.url, login_id: "me", password: "nope" }), /Wrong login name or password/);
    assert.ok(!existsSync(sess(s.dir)));
    await s.conn.submitLogin(p.promptId, { server: s.fake.url, login_id: "me", password: "pw" });
    await waitFor(s.connected, 5000, "connected");
    assert.equal(statSync(sess(s.dir)).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(sess(s.dir), "utf8"));
    assert.equal(saved.token, "sess-tok"); assert.equal(saved.server, s.fake.url);
    assert.deepEqual(s.fake.reqs(/^POST \/users\/login/).pop()!.body, { login_id: "me", password: "pw" });
    assert.equal(s.fake.reqs(/GET \/users\/me$/)[0].auth, "Bearer sess-tok");
    await waitFor(() => s.fake.wsSent.some((m) => m.action === "authentication_challenge"), 5000, "websocket authentication"); // "connected" means the REST API works; the websocket opens right after
    assert.equal(s.fake.wsOrigin[0], s.fake.url);
    await s.conn.logout();
    assert.ok(!existsSync(sess(s.dir))); assert.ok(s.fake.reqs(/POST \/users\/logout/).length === 1);
  } finally { await s.close(); }
});

test("login: MFA required prompt then success; wrong code re-prompts", async () => {
  const s = await setup(factory, { noSession: true, fake: { mfa: true } });
  try {
    await waitFor(() => s.of("login").length > 0);
    const p = s.of("login")[0];
    await s.conn.submitLogin(p.promptId, { server: s.fake.url, login_id: "me", password: "pw" });
    const mfa = s.of("login")[1];
    assert.deepEqual(mfa.fields.map((f: any) => f.name), ["mfa"]);
    await s.conn.submitLogin(mfa.promptId, { mfa: "000000" });
    const again = s.of("login")[2]; assert.match(again.error, /not accepted/);
    await s.conn.submitLogin(again.promptId, { mfa: "123456" });
    await waitFor(s.connected);
    assert.equal(s.fake.reqs(/POST \/users\/login/).pop()!.body.token, "123456");
  } finally { await s.close(); }
});

test("login: personal access token / MMAUTHTOKEN; bad token; SSO-only server", async () => {
  const s = await setup(factory, { noSession: true, fake: { ssoOnly: true } });
  try {
    await waitFor(() => s.of("login").length > 0);
    const id = s.of("login")[0].promptId;
    await assert.rejects(s.conn.submitLogin(id, { server: s.fake.url, token: "pat-bad-xyz" }), (e: Error) => /rejected this token/.test(e.message) && /single sign-on/.test(e.message) && !e.message.includes("pat-bad-xyz"));
    await assert.rejects(s.conn.submitLogin(id, { server: s.fake.url, login_id: "me", password: "pw" }), /does not allow password login[\s\S]*MMAUTHTOKEN/);
    assert.ok(!existsSync(sess(s.dir)));
    await s.conn.submitLogin(id, { server: s.fake.url, token: "MMAUTHTOKEN=pat-good" });
    await waitFor(s.connected);
    assert.equal(JSON.parse(readFileSync(sess(s.dir), "utf8")).token, "pat-good");
  } finally { await s.close(); }
});

test("session restore without prompt; 401 later -> needs-login + new prompt", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected);
    assert.equal(s.of("login").length, 0);
    assert.equal(s.fake.wsAuth[0], "Bearer pat-good");
    s.fake.validTokens.delete("pat-good");
    await assert.rejects(s.conn.history("c_town", { limit: 5 }), /session is no longer valid/);
    await waitFor(() => s.of("login").length > 0);
    assert.ok(s.ev.some((e) => e.type === "account" && e.data.state === "needs-login"));
    assert.match(s.of("login")[0].error, /expired/);
    assert.ok(!existsSync(sess(s.dir)));
  } finally { await s.close(); }
});

test("mapping: spaces, channels, DM/GM, unread, muted, names, previews", async () => {
  const s = await setup(factory, { prep: (f) => { f.addPost("c_town", "u_bob", "hello town"); f.addPost("c_dm", "u_bob", "", { metadata: { files: [{ id: "x", name: "a.png", mime_type: "image/png" }] } }); } });
  try {
    await waitFor(s.connected);
    assert.deepEqual((await s.conn.spaces()).map((x: any) => [x.id, x.name]), [["t1", "Team One"], ["t2", "Team Two"]]);
    const chats = await s.conn.chats(); const by = (id: string) => chats.find((c: any) => c.id === id)!;
    assert.equal(chats.length, 5);
    assert.deepEqual([by("c_town").kind, by("c_town").spaceId, by("c_town").name, by("c_town").unread, by("c_town").description], ["channel", "t1", "Town Square", 3, "Everything"]);
    assert.equal(by("c_town").preview, "hello town"); assert.ok(by("c_town").lastMessageAt);
    assert.equal(by("c_priv").muted, true); assert.equal(by("c_priv").description, "hdr"); assert.equal(by("c_priv").unread, 0);
    assert.equal(by("c_t2").spaceId, "t2");
    assert.deepEqual([by("c_dm").kind, by("c_dm").spaceId, by("c_dm").name, by("c_dm").preview], ["dm", undefined, "Bob Builder", "[attachment]"]);
    assert.deepEqual([by("c_gm").kind, by("c_gm").spaceId, by("c_gm").name], ["group", undefined, "bob, carol, me"]);
    const mem = await s.conn.members("c_town");
    assert.deepEqual(mem.map((m: any) => [m.id, m.name, m.handle]), [["u_me", "Mia Me", "@me"], ["u_bob", "Bob Builder", "@bob"], ["u_carol", "carol", "@carol"]]);
    assert.ok(s.fake.reqs(/POST \/users\/ids/).length <= 2); // batched, not per user
    assert.equal(s.fake.reqs(/GET \/users\/u_/).length, 0);
  } finally { await s.close(); }
});

test("name format 'username' from the user preference overrides server default", async () => {
  const s = await setup(factory, { prep: (f) => { f.nameFormatPref = "username"; } });
  try { await waitFor(s.connected); assert.equal((await s.conn.chats()).find((c: any) => c.id === "c_dm")!.name, "bob"); } finally { await s.close(); }
});

test("history: paging backwards, threads flat with replyTo, attachments, reactions, link card, system posts", async () => {
  const s = await setup(factory, { prep: (f) => {
    const root = f.addPost("c_town", "u_bob", "root text");
    f.addPost("c_town", "u_carol", "second", { metadata: { files: [{ id: "f9", name: "doc.pdf", size: 12, mime_type: "application/pdf" }, { id: "f8", name: "p.png", mime_type: "image/png", width: 4, height: 3 }], reactions: [{ user_id: "u_me", post_id: "x", emoji_name: "+1" }, { user_id: "u_bob", post_id: "x", emoji_name: "thumbsup" }, { user_id: "u_bob", post_id: "x", emoji_name: "partyparrot" }] } });
    f.addPost("c_town", "u_bob", "joined", { type: "system_join_channel" });
    f.addPost("c_town", "u_bob", "", { type: "system_typing_ignored_empty" });
    f.addPost("c_town", "u_carol", "answer", { root_id: root.id });
    f.addPost("c_town", "u_me", "see https://x.org", { edit_at: 5, metadata: { embeds: [{ type: "opengraph", url: "https://x.org", data: { title: "X Org", description: "desc" } }] } });
  } });
  try {
    await waitFor(s.connected);
    const page1 = await s.conn.history("c_town", { limit: 3 });
    assert.ok(s.fake.reqs(/channels\/c_town\/posts/).some((l) => l.query.get("per_page") === "3" && !l.query.has("before")));
    assert.deepEqual(page1.map((m: any) => m.text), ["answer", "see https://x.org"]);
    const me = page1[1]; assert.equal(me.fromMe, true); assert.equal(me.status, "sent"); assert.equal(me.card.kind, "link"); assert.equal(me.card.title, "X Org"); assert.ok(me.editedAt);
    assert.deepEqual(page1[0].replyTo, { messageId: page1[0].replyTo.messageId, sender: "Bob Builder", textPreview: "root text" });
    assert.equal(page1[0].sender, "carol");
    const oldestId = (await s.conn.history("c_town", { limit: 3 }))[0].id;
    const page2 = await s.conn.history("c_town", { limit: 10, beforeMessageId: oldestId });
    assert.ok(s.fake.reqs(/channels\/c_town\/posts/).pop()!.query.get("before") === oldestId);
    assert.deepEqual(page2.map((m: any) => m.text), ["root text", "second", "Bob Builder joined"]);
    const second = page2[1];
    assert.deepEqual(second.attachments.map((a: any) => [a.id, a.kind, a.name, a.size, a.width]), [["f9", "file", "doc.pdf", 12, undefined], ["f8", "image", "p.png", undefined, 4]]);
    assert.deepEqual(second.reactions, [{ emoji: "👍", senderIds: ["u_me", "u_bob"], mine: true }, { emoji: ":partyparrot:", senderIds: ["u_bob"] }]);
    assert.deepEqual(page2[2].system, { kind: "info" }); assert.match(page2[2].text, /Bob Builder joined/);
    assert.equal(s.fake.reqs(/POST \/users\/ids/).length <= 3, true);
  } finally { await s.close(); }
});

test("send / reply to a reply uses root / attachment / edit / delete / react; no duplicate echo", async () => {
  const s = await setup(factory, { prep: (f) => { const r = f.addPost("c_town", "u_bob", "root"); f.addPost("c_town", "u_carol", "reply", { root_id: r.id }); } });
  try {
    await waitFor(s.connected);
    const hist = await s.conn.history("c_town", { limit: 10 });
    const replyId = hist[1].id, rootId = hist[0].id;
    const sent = await s.conn.send("c_town", { text: "**hi** @bob", replyToMessageId: replyId });
    const post = s.fake.reqs(/^POST \/posts$/)[0];
    assert.equal(post.body.message, "**hi** @bob"); assert.equal(post.body.root_id, rootId); assert.equal(sent.replyTo.messageId, rootId);
    assert.equal(sent.fromMe, true); assert.equal(sent.status, "sent"); assert.equal(sent.text, "**hi** @bob");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(s.of("message").length, 0, "own echo must not be emitted");
    // attachment
    const att = await s.conn.send("c_town", { text: "", attachments: [{ kind: "file", mime: "text/plain", name: "n.txt", data: new Uint8Array([65, 66]) }] });
    const up = s.fake.reqs(/^POST \/files/)[0]; assert.equal(up.query.get("channel_id"), "c_town"); assert.match(up.raw, /filename="n.txt"/);
    assert.deepEqual(att.attachments!.map((a: any) => [a.name, a.mime]), [["n.txt", "text/plain"]]);
    await assert.rejects(s.conn.send("c_town", { text: "", attachments: [{ kind: "file", mime: "x/y", name: "big", data: new Uint8Array(2000) }] }), /too large/);
    const dl = await s.conn.downloadAttachment("c_town", att.id, att.attachments![0].id);
    assert.equal(Buffer.from(dl.data).toString(), "FILEDATA"); assert.equal(dl.name, "n.txt");
    // edit/delete/react generate requests; ws events come back as message-update
    await s.conn.edit("c_town", sent.id, "edited");
    assert.deepEqual(s.fake.reqs(/PATCH|\/patch/).pop()!.body, { message: "edited" });
    await waitFor(() => s.of("message-update").some((u: any) => u.patch.text === "edited" && u.patch.editedAt));
    await s.conn.react("c_town", sent.id, "👍");
    assert.deepEqual(s.fake.reqs(/^POST \/reactions/)[0].body, { user_id: "u_me", post_id: sent.id, emoji_name: "+1", create_at: 0 });
    await waitFor(() => s.of("message-update").some((u: any) => u.patch.reactions?.[0]?.mine === true));
    await s.conn.react("c_town", sent.id, null);
    assert.equal(s.fake.reqs(/^DELETE \/users\/u_me\/posts\/.*\/reactions\/%2B1/).length, 1);
    await waitFor(() => s.of("message-update").some((u: any) => u.patch.reactions && u.patch.reactions.length === 0));
    await assert.rejects(s.conn.react("c_town", sent.id, "🦖🦖"), /no Mattermost equivalent/);
    await s.conn.delete("c_town", sent.id);
    assert.equal(s.fake.reqs(/^DELETE \/posts\//).length, 1);
    await waitFor(() => s.of("message-update").some((u: any) => u.patch.deleted));
  } finally { await s.close(); }
});

test("ws events: other's post, own post from other device, typing, viewed, channel/user events", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected);
    const p = s.fake.addPost("c_town", "u_bob", "live one"); s.fake.pushPosted(p);
    await waitFor(() => s.of("message").length === 1);
    const m = s.of("message")[0]; assert.deepEqual([m.id, m.chatId, m.sender, m.fromMe, m.text], [p.id, "c_town", "Bob Builder", false, "live one"]);
    s.fake.pushPosted(p); await new Promise((r) => setTimeout(r, 100)); assert.equal(s.of("message").length, 1, "dedupe by post id");
    assert.equal((await s.conn.chats()).find((c: any) => c.id === "c_town")!.unread, 4);
    const own = s.fake.addPost("c_town", "u_me", "from phone"); s.fake.pushPosted(own);
    await waitFor(() => s.of("message").length === 2); assert.equal(s.of("message")[1].fromMe, true);
    s.fake.push("typing", { parent_id: "", user_id: "u_bob" }, { channel_id: "c_town" });
    await waitFor(() => s.of("typing").some((t: any) => t.typing === true && t.senderId === "u_bob" && t.chatId === "c_town"));
    s.fake.push("typing", { parent_id: "", user_id: "u_me" }, { channel_id: "c_town" });
    s.fake.push("channel_viewed", { channel_id: "c_town" });
    await waitFor(() => s.of("chats-changed").some((c: any) => c.chatId === "c_town"));
    assert.equal((await s.conn.chats()).find((c: any) => c.id === "c_town")!.unread, 0);
    assert.equal(s.of("typing").filter((t: any) => t.senderId === "u_me").length, 0);
    // new DM appears
    s.fake.channels.c_new = { id: "c_new", type: "D", name: "u_carol__u_me", display_name: "", team_id: "", total_msg_count: 0 }; s.fake.members.c_new = { channel_id: "c_new", msg_count: 0 };
    s.fake.push("direct_added", { teammate_id: "u_carol" }, { channel_id: "c_new" });
    await waitFor(() => s.of("chats-changed").some((c: any) => c.chatId === "c_new"));
    assert.equal((await s.conn.chats()).find((c: any) => c.id === "c_new")!.name, "carol");
    s.fake.push("user_removed", { channel_id: "c_new", user_id: "u_me" }, { user_id: "u_me" });
    
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!(await s.conn.chats()).some((c: any) => c.id === "c_new"));
    s.fake.push("channel_updated", { channel: JSON.stringify({ ...s.fake.channels.c_priv, display_name: "Renamed" }) });
     await new Promise((r) => setTimeout(r, 100));
    assert.equal((await s.conn.chats()).find((c: any) => c.id === "c_priv")!.name, "Renamed");
    s.fake.push("status_change", { user_id: "u_bob", status: "away" }); // ignored silently
    assert.equal(s.of("error").length, 0);
  } finally { await s.close(); }
});

test("reconnect with backoff + since catch-up of posts missed while offline", async () => {
  const s = await setup(factory, { prep: (f) => f.addPost("c_town", "u_bob", "before") });
  try {
    await waitFor(s.connected);
    const n0 = s.ev.filter((e) => e.type === "account" && e.data.state === "connected").length;
    s.fake.srv.closeAllConnections(); // keep server up; drop the socket and make new posts while "offline"
    const missed = s.fake.addPost("c_town", "u_bob", "missed while offline");
    const edit = s.fake.postById[s.fake.posts.c_town[0].id]; edit.message = "before (edited)"; edit.edit_at = edit.update_at = ++s.fake.now + 10;
    s.fake.dropSockets();
    await waitFor(() => s.ev.some((e) => e.type === "account" && e.data.state === "disconnected"), 3000, "disconnected");
    await waitFor(() => s.ev.filter((e) => e.type === "account" && e.data.state === "connected").length > n0, 10000, "reconnected");
    await waitFor(() => s.of("message").some((m: any) => m.id === missed.id), 5000, "caught-up message");
    assert.ok(s.fake.reqs(/channels\/c_town\/posts/).some((l) => l.query.has("since")));
    assert.ok(s.of("message-update").some((u: any) => u.patch.text === "before (edited)"));
    assert.equal(s.of("message").filter((m: any) => m.id === missed.id).length, 1);
  } finally { await s.close(); }
});

test("429: waits for X-RateLimit-Reset then retries", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected);
    s.fake.addPost("c_town", "u_bob", "x");
    s.fake.rateLimitNext = 1;
    const t = Date.now();
    const h = await s.conn.history("c_town", { limit: 5 });
    assert.equal(h.length, 1); assert.ok(Date.now() - t >= 900, "waited ~1s");
  } finally { await s.close(); }
});

test("avatars: custom pictures only", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected);
    assert.deepEqual([...(await s.conn.avatar({ kind: "contact", id: "u_bob" }))!.data], [...PNG]);
    assert.equal((await s.conn.avatar({ kind: "contact", id: "u_bob" }))!.mime, "image/png");
    assert.equal(await s.conn.avatar({ kind: "contact", id: "u_carol" }), undefined);
    assert.ok(await s.conn.avatar({ kind: "chat", id: "c_dm" }));
    assert.equal(await s.conn.avatar({ kind: "chat", id: "c_town" }), undefined);
    assert.ok(await s.conn.avatar({ kind: "space", id: "t1" }));
    assert.equal(await s.conn.avatar({ kind: "space", id: "t2" }), undefined);
    assert.equal(s.fake.reqs(/users\/u_carol\/image/).length, 0);
  } finally { await s.close(); }
});

test("startChat / createGroup / members / rename / leave / markRead / typing / profile", async () => {
  const s = await setup(factory, { prep: (f) => f.addPost("c_town", "u_bob", "x") });
  try {
    await waitFor(s.connected);
    const dm = await s.conn.startChat("@carol");
    assert.deepEqual(s.fake.reqs(/^POST \/channels\/direct/)[0].body, ["u_me", "u_carol"]); assert.equal(dm.kind, "dm"); assert.equal(dm.name, "carol");
    await s.conn.startChat("bob@uni.test"); assert.ok(s.fake.reqs(/GET \/users\/email\/bob%40uni.test/).length === 1);
    await assert.rejects(s.conn.startChat("@nobody"), /No such Mattermost user/);
    const gm = await s.conn.createGroup("ignored", ["@bob", "@carol"]);
    assert.deepEqual(s.fake.reqs(/^POST \/channels\/group/)[0].body, ["u_bob", "u_carol"]); assert.equal(gm.kind, "group");
    await assert.rejects(s.conn.createGroup("g", ["@bob"]), /at least two/);
    await s.conn.addMembers("c_town", ["@carol"]); assert.deepEqual(s.fake.reqs(/^POST \/channels\/c_town\/members/)[0].body, { user_id: "u_carol" });
    await s.conn.removeMember("c_town", "u_bob"); assert.equal(s.fake.reqs(/^DELETE \/channels\/c_town\/members\/u_bob/).length, 1);
    await s.conn.renameChat("c_town", " Lobby "); assert.deepEqual(s.fake.reqs(/PUT \/channels\/c_town\/patch/)[0].body, { display_name: "Lobby" });
    await s.conn.markRead("c_town", "whatever"); assert.deepEqual(s.fake.reqs(/members\/me\/view/)[0].body, { channel_id: "c_town" });
    assert.equal((await s.conn.chats()).find((c: any) => c.id === "c_town")!.unread, 0);
    await s.conn.setTyping("c_town", true);
    await waitFor(() => s.fake.wsSent.some((m) => m.action === "user_typing" && m.data.channel_id === "c_town"));
    await s.conn.leaveChat("c_priv"); assert.equal(s.fake.reqs(/^DELETE \/channels\/c_priv\/members\/u_me/).length, 1);
    await s.conn.leaveChat("c_dm"); assert.deepEqual(s.fake.reqs(/PUT \/users\/u_me\/preferences/)[0].body[0], { user_id: "u_me", category: "direct_channel_show", name: "u_bob", value: "false" });
    const p = await s.conn.getProfile(); assert.deepEqual([p.displayName, p.handle], ["Meee", "@me"]); assert.ok(p.avatar);
    await s.conn.updateProfile({ displayName: "New", about: "Dr." });
    assert.deepEqual(s.fake.reqs(/PUT \/users\/me\/patch/)[0].body, { nickname: "New", position: "Dr." });
    const p2 = await s.conn.updateProfile({ avatar: null }); assert.equal(p2.avatar, undefined);
    assert.equal(s.conn.capabilities.readReceipts, false); assert.equal(s.conn.capabilities.block, false);
  } finally { await s.close(); }
});

test("permission errors are clear (403)", async () => {
  const s = await setup(factory, { fake: { patEnabled: false } });
  try {
    await waitFor(s.connected);
    await assert.rejects(s.conn.addMembers("c_town", ["@carol"]), /do not have permission to add members/);
  } finally { await s.close(); }
});

test("standard shortcodes in text become unicode, custom ones and code spans stay", () => {
  assert.equal(shortcodesToUnicode("hi :call_me_hand: and :coding_cat: `:smile:` 10:30:45"), "hi 🤙 and :coding_cat: `:smile:` 10:30:45");
});

test("presence: statuses of DM peers are polled (online/away/dnd -> online, offline -> lastSeen), changes only, off switch", async () => {
  const s = await setup(factory, { prep: (f) => { f.statuses.u_bob = "away"; } });
  try {
    await waitFor(() => s.of("presence").length >= 1, 8000, "presence");
    assert.equal(s.conn.capabilities.presence, true);
    assert.deepEqual(s.of("presence")[0], { accountId: "acc", chatId: "c_dm", contactId: "u_bob", online: true });
    s.fake.statuses.u_bob = "offline"; await (s.conn as any).pollStatus();
    const p = s.of("presence"); assert.equal(p.at(-1).online, false); assert.equal(p.at(-1).lastSeen, new Date(1_700_000_000_000).toISOString());
    const n = p.length; await (s.conn as any).pollStatus(); assert.equal(s.of("presence").length, n, "unchanged: no repeat");
    s.conn.setPresenceEnabled(false); s.fake.statuses.u_bob = "online"; await (s.conn as any).pollStatus(); assert.equal(s.of("presence").length, n, "switch off: nothing");
  } finally { await s.close(); }
});

test("applyMentions / parseTeamInvite / teamSlug helpers", async () => {
  const { applyMentions, parseTeamInvite, teamSlug } = await import("./map.js");
  const names: Record<string, string> = { u_bob: "bob", u_c: "carol.x", u_bad: "bo b" };
  const un = (id: string) => names[id];
  const t = "hi @Bob Builder and @Carol, 😀 @Bob Builder";
  const a = t.indexOf("@Bob"), b = t.indexOf("@Carol"), c = t.lastIndexOf("@Bob");
  assert.equal(applyMentions(t, [{ id: "u_c", start: b, length: 6 }, { id: "u_bob", start: a, length: 12 }, { id: "u_bob", start: c, length: 12 }], un), "hi @bob and @carol.x, 😀 @bob");
  assert.equal(applyMentions("x @Z", [{ id: "unknown", start: 2, length: 2 }], un), "x @Z");            // unknown id: text stays
  assert.equal(applyMentions("x @Z", [{ id: "u_bad", start: 2, length: 2 }], un), "x @Z");              // unsafe username: text stays
  assert.equal(applyMentions("x @Z", [{ id: "u_bob", start: 2, length: 99 }], un), "x @Z");             // out of range
  assert.equal(applyMentions("@A@B", [{ id: "u_bob", start: 0, length: 3 }, { id: "u_c", start: 2, length: 2 }], un), "@bobB"); // overlapping second span dropped
  assert.equal(applyMentions("plain", undefined, un), "plain");
  assert.deepEqual(parseTeamInvite("https://mm.example/signup_user_complete/?id=abcdef1234567890"), { kind: "invite", id: "abcdef1234567890" });
  assert.deepEqual(parseTeamInvite("https://mm.example/Team-One/channels/town-square"), { kind: "name", name: "team-one" });
  assert.deepEqual(parseTeamInvite(" three "), { kind: "name", name: "three" });
  assert.equal(parseTeamInvite("https://mm.example/login"), undefined);
  assert.equal(parseTeamInvite("not a team!"), undefined);
  assert.equal(parseTeamInvite(""), undefined);
  assert.equal(teamSlug("Café Zürich 2!", () => "r"), "cafe-zurich-2");
  assert.equal(teamSlug("日本語", () => "r1"), "team-r1");
});

test("send with @mentions becomes plain @username; capabilities declare mentions + team management", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected);
    assert.ok(s.conn.capabilities.mentions && s.conn.capabilities.createSpace && s.conn.capabilities.joinSpace && s.conn.capabilities.leaveSpace);
    const mem = await s.conn.members("c_town");
    const bob = mem.find((m: any) => m.id === "u_bob")!;
    const text = `hello @${bob.name}, ping`;
    await s.conn.send("c_town", { text, mentions: [{ id: "u_bob", name: bob.name, start: 6, length: bob.name.length + 1 }] });
    assert.equal(s.fake.reqs(/^POST \/posts$/)[0].body.message, "hello @bob, ping");
  } finally { await s.close(); }
});

test("teams: create (slug, description, name clash retry), join by name / URL / invite link, closed team needs invite, leave", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected);
    const created = await s.conn.createSpace("Café Crew", " About us ");
    assert.deepEqual(s.fake.reqs(/^POST \/teams$/)[0].body, { name: "cafe-crew", display_name: "Café Crew", type: "I", description: "About us" });
    assert.equal(created.name, "Café Crew");
    assert.ok((await s.conn.spaces()).some((x: any) => x.id === created.id));
    await assert.rejects(s.conn.createSpace("  "), /needs a name/);
    const clash = await s.conn.createSpace("Three");                        // "three" is taken -> retried with a suffix
    assert.match(s.fake.reqs(/^POST \/teams$/).at(-1)!.body.name, /^three-[a-z0-9]+$/); assert.equal(clash.name, "Three");
    s.fake.canCreateTeams = false;
    await assert.rejects(s.conn.createSpace("Nope"), /permission to create teams/);
    // join an open team by URL: its channels appear
    const j = await s.conn.joinSpace("https://mm.example/three/channels/lobby");
    assert.deepEqual([j.id, j.name], ["t3", "Team Three"]);
    assert.ok((await s.conn.chats()).some((c: any) => c.id === "c_t3" && c.spaceId === "t3"));
    assert.ok(s.of("spaces-changed").length >= 3);
    await assert.rejects(s.conn.joinSpace("closed"), /invite link/);
    await assert.rejects(s.conn.joinSpace("nosuchteam"), /No team with that name/);
    await assert.rejects(s.conn.joinSpace("???"), /team name/);
    const j2 = await s.conn.joinSpace("https://mm.example/signup_user_complete/?id=inv4inv4inv4");
    assert.equal(j2.id, "t4");
    await assert.rejects(s.conn.joinSpace("https://mm.example/signup_user_complete/?id=badbadbadbad"), /not valid/);
    // leave
    await s.conn.leaveSpace("t3");
    assert.equal(s.fake.reqs(/^DELETE \/teams\/t3\/members\/u_me/).length, 1);
    assert.ok(!(await s.conn.spaces()).some((x: any) => x.id === "t3"));
    assert.ok(!(await s.conn.chats()).some((c: any) => c.id === "c_t3"));
    await assert.rejects(s.conn.leaveSpace("t3"), /not in that team/);
  } finally { await s.close(); }
});

test("live: other people's edits, deletes and reactions (and removals) arrive as message-update", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected);
    const p = s.fake.addPost("c_gm", "u_bob", "group hi"); s.fake.pushPosted(p);
    await waitFor(() => s.of("message").some((m: any) => m.chatId === "c_gm"));
    s.fake.push("reaction_added", { reaction: JSON.stringify({ user_id: "u_bob", post_id: p.id, emoji_name: "tada" }) }, { channel_id: "c_gm" });
    await waitFor(() => s.of("message-update").some((u: any) => u.messageId === p.id && u.patch.reactions?.[0]?.emoji === "🎉"));
    s.fake.push("reaction_removed", { reaction: JSON.stringify({ user_id: "u_bob", post_id: p.id, emoji_name: "tada" }) }, { channel_id: "c_gm" });
    await waitFor(() => s.of("message-update").some((u: any) => u.messageId === p.id && u.patch.reactions?.length === 0));
    p.message = "group edited"; p.edit_at = p.update_at = p.create_at + 5; s.fake.push("post_edited", { post: JSON.stringify(p) }, { channel_id: "c_gm" });
    await waitFor(() => s.of("message-update").some((u: any) => u.messageId === p.id && u.patch.text === "group edited"));
    p.delete_at = p.create_at + 9; s.fake.push("post_deleted", { post: JSON.stringify(p) }, { channel_id: "c_gm" });
    await waitFor(() => s.of("message-update").some((u: any) => u.messageId === p.id && u.patch.deleted === true));
    // sending to a group message and a DM goes to that channel with no thread
    await s.conn.send("c_gm", { text: "to the group" }); await s.conn.send("c_dm", { text: "to bob" });
    assert.deepEqual(s.fake.reqs(/^POST \/posts$/).map((r) => [r.body.channel_id, r.body.root_id ?? ""]), [["c_gm", ""], ["c_dm", ""]]);
  } finally { await s.close(); }
});

test("DM with an incoming image: history carries the attachment and it downloads with its mime and name", async () => {
  const s = await setup(factory, { prep: (f) => { f.files.fimg = { info: { id: "fimg", name: "pic.png", extension: "png", size: 8, mime_type: "image/png", width: 4, height: 3 }, data: PNG }; f.addPost("c_dm", "u_bob", "look", { file_ids: ["fimg"], metadata: { files: [f.files.fimg.info] } }); } });
  try {
    await waitFor(s.connected);
    const [m] = await s.conn.history("c_dm", { limit: 5 });
    const a = m.attachments[0]; assert.deepEqual([a.kind, a.mime, a.name, a.width, a.height], ["image", "image/png", "pic.png", 4, 3]);
    const dl = await s.conn.downloadAttachment("c_dm", m.id, a.id);
    assert.deepEqual([dl.mime, dl.name, Buffer.from(dl.data).equals(PNG)], ["image/png", "pic.png", true]);
  } finally { await s.close(); }
});
