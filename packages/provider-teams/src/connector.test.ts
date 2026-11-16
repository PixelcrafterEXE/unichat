import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.js";
import { endpoint, maskPath, mediaAllowed } from "./api.js";
import { htmlToText, mapCard, textToHtml, emojiToReaction, reactionToEmoji } from "./map.js";
import { CLIENT_ID } from "./fake-server.js";
import { loadSession, saveSince } from "./secret.js";
import { ALICE, BOB, C, CH, CHAN, ME, T1, setup, waitFor } from "./helpers.js";

const live = (s: Awaited<ReturnType<typeof setup>>) => s.fake.live();

test("endpoint override is loopback-only; media allow-list; path masking", () => {
  process.env.UNIMSG_TEAMS_GRAPH = "https://evil.example.org/v1.0"; assert.equal(endpoint("UNIMSG_TEAMS_GRAPH", "https://graph.microsoft.com/v1.0"), "https://graph.microsoft.com/v1.0");
  process.env.UNIMSG_TEAMS_GRAPH = "http://127.0.0.1:9/v1.0/"; assert.equal(endpoint("UNIMSG_TEAMS_GRAPH", "d"), "http://127.0.0.1:9/v1.0");
  process.env.UNIMSG_TEAMS_GRAPH = "http://127.0.0.1.evil.org"; assert.equal(endpoint("UNIMSG_TEAMS_GRAPH", "d"), "d");
  delete process.env.UNIMSG_TEAMS_GRAPH;
  assert.ok(mediaAllowed("https://media.giphy.com/x.gif") && !mediaAllowed("https://evil.example.org/x.gif") && !mediaAllowed("http://giphy.com/x"));
  assert.equal(maskPath("/chats/19:abc@thread.v2/messages/123?$top=1"), "/chats/#/messages/#");
});

test("html to text: mentions, links, lists, entities, images, emoji, attachments", () => {
  const r = htmlToText('<p>Hi <at id="0">Alice Wonder</at>, see <a href="https://x.test/a">the doc</a> &amp; <a href="https://y.test">https://y.test</a></p><ul><li>one</li><li>two</li></ul><attachment id="a1"></attachment><img src="https://g.test/v1.0/chats/1/messages/2/hostedContents/hc1/$value" width="10" height="20"><img itemtype="http://schema.skype.com/Emoji" alt="\u{1F600}" src="x">');
  assert.equal(r.text, "Hi @Alice Wonder, see the doc (https://x.test/a) & https://y.test\n\n• one\n• two\n\u{1F600}".replace("\n\n•", "\n\n•"));
  assert.equal(r.images.length, 1); assert.equal(r.images[0].hostedId, "hc1");
  assert.equal(textToHtml("a<b>\nc&d"), "a&lt;b&gt;<br>c&amp;d");
  assert.equal(emojiToReaction("\u{1F44D}"), "like"); assert.equal(emojiToReaction("\u{1F389}"), "\u{1F389}"); assert.equal(reactionToEmoji("heart"), "❤️");
});

test("adaptive card maps to an 'other' card", () => {
  const c = mapCard({ contentType: "application/vnd.microsoft.card.adaptive", content: JSON.stringify({ type: "AdaptiveCard", body: [{ type: "TextBlock", text: "Build failed", weight: "Bolder" }, { type: "TextBlock", text: "main is red" }, { type: "FactSet", facts: [{ title: "Job", value: "ci" }] }], actions: [{ type: "Action.OpenUrl", title: "Open" }] }) });
  assert.deepEqual(c, { kind: "other", title: "Build failed", body: "main is red", rows: [{ label: "Job", value: "ci" }], buttons: ["Open"] });
});

test("capabilities are honest", () => {
  const c = factory.capabilities;
  assert.equal(c.typing, false); assert.equal(c.readReceipts, false); assert.equal(c.markRead, true); assert.equal(c.polls, false); assert.equal(c.spaces, true); assert.equal(c.mentions, true);
});

test("device code login: form -> link prompt with the user code -> connected; token sealed 0600", async () => {
  const s = await setup(factory, { noSession: true, fake: { pendingPolls: 2 } });
  try {
    await waitFor(() => s.of("login").length > 0);
    assert.equal(s.of("account")[0].state, "needs-login");
    const form = s.of("login")[0]; assert.equal(form.kind, "form");
    assert.ok(form.fields.find((f: any) => f.name === "client_id").required);
    await assert.rejects(s.conn.submitLogin(form.promptId, { client_id: "not-a-guid" }), /Application \(client\) ID/);
    await assert.rejects(s.conn.submitLogin(form.promptId, { client_id: CLIENT_ID, tenant: "../evil" }), /tenant/);
    await s.conn.submitLogin(form.promptId, { client_id: CLIENT_ID, tenant: "", channels: "true", files: "true" });
    const link = s.of("login").find((p: any) => p.kind === "link");
    assert.match(link.hint, /ABCD-EFGH/); assert.match(link.payload, /devicelogin/);
    await waitFor(s.connected);
    assert.ok(s.fake.authHits.some((h) => h.includes("devicecode")) && s.fake.authHits.filter((h) => h.endsWith("/token")).length >= 3, "polled through pending + slow_down");
    const sess = loadSession(s.dir)!; assert.equal(sess.tenant, "organizations"); assert.match(sess.scope, /ChannelMessage\.Read\.All/); assert.match(sess.scope, /Files\.ReadWrite/); assert.equal(sess.tenantId, "00000000-0000-4000-8000-0000000000aa");
    for (const f of readdirSync(s.dir)) { assert.equal(statSync(join(s.dir, f)).mode & 0o777, 0o600, f); assert.ok(!readFileSync(join(s.dir, f), "utf8").includes("fakeRT"), `plain refresh token in ${f}`); }
  } finally { await s.close(); }
});

test("device code: declined, bad client id and expiry re-prompt with a plain error", async () => {
  const s = await setup(factory, { noSession: true, prep: (f) => { f.invalidClient = true; } });
  try {
    await waitFor(() => s.of("login").length > 0); const id = s.of("login")[0].promptId;
    await assert.rejects(s.conn.submitLogin(id, { client_id: "22222222-2222-4222-8222-222222222222" }), /client id|public client/i);
    await s.conn.submitLogin(id, { client_id: CLIENT_ID });
    for (const d of s.fake.devices.values()) d.state = "declined";
    await waitFor(() => s.of("login").some((p: any) => p.kind === "form" && p.error));
    assert.match(s.of("login").at(-1).error, /declined/);
  } finally { await s.close(); }
});

test("chats: kinds, names, topic, unread, meeting category; spaces and channels", async () => {
  const s = await setup(factory, { prep: (f) => { f.say(C.group, ALICE, "from alice"); } });
  try {
    await waitFor(s.connected);
    const chats = await s.conn.chats(); const by = (id: string) => chats.find((c: any) => c.id === id);
    assert.equal(by(C.dm).kind, "dm"); assert.equal(by(C.dm).name, "Alice Wonder"); assert.equal(by(C.dm).unread, 1); assert.equal(by(C.dm).unreadApprox, true);
    assert.equal(by(C.group).kind, "group"); assert.equal(by(C.group).name, "Alice Wonder, Bob Builder"); assert.equal(by(C.group).preview, "from alice");
    assert.equal(by(C.meeting).name, "Weekly Standup"); assert.equal(by(C.meeting).category, "Meetings");
    assert.equal(by(CHAN.general).kind, "channel"); assert.equal(by(CHAN.general).spaceId, T1); assert.equal(by(CHAN.general).description, "Everything");
    assert.equal(by(CHAN.secret).category, "Private channels"); assert.equal(by(CHAN.shared).category, "Shared channels");
    const sp = await s.conn.spaces(); assert.deepEqual(sp.map((x: any) => [x.id, x.name]), [[T1, "Engineering"]]);
    assert.equal(s.of("account").at(-1).state, "connected");
  } finally { await s.close(); }
});

test("history: newest-first paging to oldest-to-newest, nextLink, historical flag, no duplicates", async () => {
  const s = await setup(factory, { fake: { pageSize: 7 }, prep: (f) => { for (let i = 1; i <= 30; i++) f.say(C.group, i % 2 ? ALICE : ME, `<p>msg ${i}</p>`); } });
  try {
    await waitFor(s.connected); await s.conn.chats();
    const p1 = await s.conn.history(C.group, { limit: 10 });
    assert.deepEqual(p1.map((m: any) => m.text), Array.from({ length: 10 }, (_, i) => `msg ${21 + i}`));
    assert.ok(p1.every((m: any) => m.historical === true));
    assert.equal(p1[0].fromMe, false); assert.equal(p1[1].fromMe, true);
    const p2 = await s.conn.history(C.group, { limit: 10, beforeMessageId: p1[0].id });
    assert.deepEqual(p2.map((m: any) => m.text), Array.from({ length: 10 }, (_, i) => `msg ${11 + i}`));
    const p3 = await s.conn.history(C.group, { limit: 50, beforeMessageId: p2[0].id });
    assert.equal(p3.length, 10);
    // a cursor miss falls back to the $filter query
    const p4 = await s.conn.history(C.group, { limit: 3, beforeMessageId: p1[5].id });
    assert.deepEqual(p4.map((m: any) => m.text), ["msg 23", "msg 24", "msg 25"]);
    assert.equal((await s.conn.history(C.group, { limit: 5, beforeMessageId: p3[0].id })).length, 0);
  } finally { await s.close(); }
});

test("message mapping: mentions, reactions, reply quote, system events, deleted, edited, importance, cards, attachments", async () => {
  const s = await setup(factory, { prep: (f) => {
    const a = f.say(C.group, ALICE, '<p>Hey <at id="0">Bob Builder</at>!</p>', { mentions: [{ id: 0, mentionText: "Bob Builder", mentioned: { user: { id: BOB, displayName: "Bob Builder" } } }], importance: "high" });
    a.reactions = [{ reactionType: "like", user: { user: { id: ME } } }, { reactionType: "like", user: { user: { id: BOB } } }, { reactionType: "\u{1F389}", user: { user: { id: BOB } } }];
    f.say(C.group, BOB, '<attachment id="q1"></attachment>yes', { attachments: [{ id: "q1", contentType: "messageReference", content: JSON.stringify({ messageId: a.id, messagePreview: "Hey Bob", messageSender: { user: { id: ALICE, displayName: "Alice Wonder" } } }) }] });
    f.system(C.group, { "@odata.type": "#microsoft.graph.membersAddedEventMessageDetail", initiator: { user: { displayName: "Alice Wonder" } }, members: [{ displayName: "Bob Builder" }] });
    f.system(C.group, { "@odata.type": "#microsoft.graph.callEndedEventMessageDetail", callDuration: "PT5M" });
    const d = f.say(C.group, ALICE, "gone"); d.deletedDateTime = new Date().toISOString();
    const e = f.say(C.group, ALICE, "fixed"); e.lastEditedDateTime = new Date().toISOString();
    f.say(C.group, ALICE, "", { attachments: [{ id: "c1", contentType: "application/vnd.microsoft.card.adaptive", content: JSON.stringify({ type: "AdaptiveCard", body: [{ type: "TextBlock", text: "Deploy", weight: "Bolder" }] }) }, { id: "f1", contentType: "reference", contentUrl: "https://contoso.sharepoint.com/doc.pdf", name: "doc.pdf" }] });
  } });
  try {
    await waitFor(s.connected); await s.conn.chats();
    const h = await s.conn.history(C.group, { limit: 20 });
    assert.equal(h[0].text, "[Important] Hey @Bob Builder!");
    assert.deepEqual(h[0].reactions, [{ emoji: "\u{1F44D}", senderIds: [ME, BOB], mine: true }, { emoji: "\u{1F389}", senderIds: [BOB] }]);
    assert.equal(h[1].replyTo.messageId, h[0].id); assert.equal(h[1].replyTo.sender, "Alice Wonder"); assert.equal(h[1].replyTo.textPreview, "Hey Bob"); assert.equal(h[1].text, "yes");
    assert.equal(h[2].system.kind, "info"); assert.equal(h[2].text, "Alice Wonder added Bob Builder"); assert.match(h[3].text, /^Call ended \(5m\)/);
    assert.equal(h[4].deleted, true); assert.equal(h[4].text, ""); assert.ok(h[5].editedAt);
    assert.equal(h[6].card.kind, "other"); assert.equal(h[6].card.title, "Deploy"); assert.equal(h[6].attachments[0].name, "doc.pdf"); assert.equal(h[6].attachments[0].kind, "file");
  } finally { await s.close(); }
});

test("live: new messages arrive through polling, not historical; edits, deletes, reactions come as updates; adaptive polling touches hot chats more", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.chats(); await s.conn.history(C.dm, { limit: 10 }); live(s);
    const m = s.fake.say(C.dm, ALICE, "<p>fresh</p>");
    await waitFor(() => s.of("message").some((x: any) => x.text === "fresh"));
    const got = s.of("message").find((x: any) => x.text === "fresh"); assert.ok(!got.historical); assert.equal(got.chatId, C.dm);
    await waitFor(() => s.of("chats-changed").some((x: any) => x.chatId === C.dm)); // emitted right after the message event: a slow runner can observe it a tick later
    m.body!.content = "<p>fresh2</p>"; m.lastEditedDateTime = s.fake.now(); s.fake.touch(m);
    await waitFor(() => s.of("message-update").some((x: any) => x.patch.text === "fresh2"));
    m.reactions = [{ reactionType: "heart", user: { user: { id: ALICE } } }]; s.fake.touch(m);
    await waitFor(() => s.of("message-update").some((x: any) => x.patch.reactions?.[0]?.emoji === "❤️"));
    m.deletedDateTime = s.fake.now(); s.fake.touch(m);
    await waitFor(() => s.of("message-update").some((x: any) => x.patch.deleted === true));
    assert.equal(s.of("message").filter((x: any) => x.text === "fresh").length, 1, "delivered once");
    // the hot chat's delta endpoint is polled much more often than the cold, untouched group chat's
    const n = (id: string) => s.fake.hits.filter((h) => h.includes(encodeURIComponent(id).length ? id : id) && h.endsWith("/delta")).length;
    assert.ok(n(C.dm) > n(C.group) + 2, `dm ${n(C.dm)} vs group ${n(C.group)}`);
  } finally { await s.close(); }
});

test("catch-up after restart: messages missed while offline arrive as historical", async () => {
  const dir = mkdtempSync(join(tmpdir(), "teams-"));
  const since = new Date(Date.now() - 2 * 3600_000).toISOString(); saveSince(dir, since);
  const s = await setup(factory, { dir, fake: {}, prep: (f) => { f.live(); } });
  try {
    await waitFor(s.connected); await s.conn.chats();
    // seeds were 1h in the past, newer than `since`; but the first list poll marks nothing hot unless newer than baseline (= since)
    await waitFor(() => s.of("message").some((x: any) => x.text === "Hello Me"), 8000, "catch-up");
    assert.equal(s.of("message").find((x: any) => x.text === "Hello Me").historical, true);
  } finally { await s.close(); }
});

test("channels: replies via expand, flat timeline, replyTo parent, send reply, edit/react on a reply", async () => {
  let parent: any, reply: any;
  const s = await setup(factory, { prep: (f) => { parent = f.say(CHAN.general, ALICE, "<p>Topic</p>"); reply = f.say(CHAN.general, BOB, "<p>Answer</p>", { replyToId: parent.id }); } });
  try {
    await waitFor(s.connected); await s.conn.chats();
    const h = await s.conn.history(CHAN.general, { limit: 10 });
    assert.deepEqual(h.map((m: any) => m.text), ["Topic", "Answer"]);
    const sent = await s.conn.send(CHAN.general, { text: "Thanks", replyToMessageId: reply.id });
    assert.ok(s.fake.hits.some((x) => x === `POST /teams/${T1}/channels/${CH.general}/messages/${parent.id}/replies`), "reply posted under the PARENT");
    await s.conn.edit(CHAN.general, sent.id, "Thanks!");
    assert.ok(s.fake.hits.some((x) => x.startsWith("PATCH") && x.endsWith(`/messages/${parent.id}/replies/${sent.id}`)));
    await s.conn.react(CHAN.general, reply.id, "\u{1F44D}");
    assert.ok(s.fake.hits.some((x) => x === `POST /teams/${T1}/channels/${CH.general}/messages/${parent.id}/replies/${reply.id}/setReaction`));
    await waitFor(() => s.of("message-update").some((x: any) => x.messageId === reply.id && x.patch.reactions?.length));
    const m2 = await s.conn.history(CHAN.general, { limit: 10 });
    assert.equal(m2.at(-1).text, "Thanks!");
  } finally { await s.close(); }
});

test("channels fall back without $expand=replies", async () => {
  const s = await setup(factory, { prep: (f) => { f.rejectExpand = true; f.say(CHAN.general, ALICE, "top"); } });
  try { await waitFor(s.connected); await s.conn.chats(); assert.deepEqual((await s.conn.history(CHAN.general, { limit: 5 })).map((m: any) => m.text), ["top"]); } finally { await s.close(); }
});

test("channels degrade gracefully when ChannelMessage.Read.All is missing: listed, empty, one notice, still sendable", async () => {
  const s = await setup(factory, { fake: { scope: "openid offline_access User.Read Chat.ReadWrite ChannelMessage.Send Team.ReadBasic.All" } });
  try {
    await waitFor(s.connected); const chats = await s.conn.chats();
    assert.ok(chats.some((c: any) => c.id === CHAN.general && !c.readOnly));
    assert.deepEqual(await s.conn.history(CHAN.general, { limit: 5 }), []);
    assert.equal(s.of("error").filter((e: any) => e.code === "channels-not-readable").length, 1);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!s.fake.hits.some((h) => h.includes(`/channels/`) && h.includes("/messages")), "no channel message reads attempted");
    const m = await s.conn.send(CHAN.general, { text: "hello channel" }); assert.equal(m.fromMe, true);
  } finally { await s.close(); }
});

test("channels: a 403 at runtime marks the channel unreadable once, without killing chat polling", async () => {
  const s = await setup(factory, { fake: { scope: "openid offline_access User.Read Chat.ReadWrite ChannelMessage.Read.All ChannelMessage.Send" }, prep: (f) => { f.forbid.push(/channels\/.*messages/); } });
  try {
    await waitFor(s.connected); await s.conn.chats();
    assert.deepEqual(await s.conn.history(CHAN.general, { limit: 5 }), []);
    assert.equal(s.of("error").filter((e: any) => e.code === "channels-not-readable").length, 1);
    live(s); s.fake.say(C.dm, ALICE, "still works");
    await waitFor(() => s.of("message").some((x: any) => x.text === "still works"));
  } finally { await s.close(); }
});

test("teams listing denied: spaces empty with a notice, chats still work", async () => {
  const s = await setup(factory, { prep: (f) => { f.forbid.push(/joinedTeams/); } });
  try { await waitFor(s.connected); const c = await s.conn.chats(); assert.ok(c.some((x: any) => x.id === C.dm) && !c.some((x: any) => x.kind === "channel")); assert.deepEqual(await s.conn.spaces(), []); assert.ok(s.of("error").some((e: any) => e.code === "teams-unavailable")); } finally { await s.close(); }
});

test("send: text is HTML-escaped with line breaks; mentions; reply quote in chats", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.chats();
    const m = await s.conn.send(C.group, { text: "a<b> & c\nHi @Bob Builder", mentions: [{ id: BOB, name: "@Bob Builder", start: 12, length: 12 }] });
    const body = s.fake.bodies.find((b) => b.path === `POST /chats/${C.group}/messages`)!.body;
    assert.equal(body.body.content, 'a&lt;b&gt; &amp; c<br>Hi <at id="0">Bob Builder</at>');
    assert.deepEqual(body.mentions[0].mentioned.user.id, BOB);
    assert.equal(m.text, "a<b> & c\nHi @Bob Builder"); assert.equal(m.fromMe, true); assert.equal(m.status, "sent");
    const alice = s.fake.say(C.group, ALICE, "<p>question?</p>");
    const r = await s.conn.send(C.group, { text: "answer", replyToMessageId: alice.id });
    assert.equal(r.replyTo.messageId, alice.id);
    const rb = s.fake.bodies.filter((b) => b.path === `POST /chats/${C.group}/messages`).at(-1)!.body;
    assert.equal(rb.attachments[0].contentType, "messageReference"); assert.match(rb.body.content, /^<attachment id="/);
    await assert.rejects(s.conn.send(C.group, { text: "  " }), /Nothing to send/);
    await assert.rejects(s.conn.send(C.group, { text: "x".repeat(30000) }), /too long/);
  } finally { await s.close(); }
});

test("send: images inline as hostedContents; files via OneDrive; limits; download round trip", async () => {
  const s = await setup(factory, { fake: { scope: "openid offline_access User.Read Chat.ReadWrite Files.ReadWrite Files.Read.All ChannelMessage.Send" } });
  try {
    await waitFor(s.connected); await s.conn.chats();
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const m = await s.conn.send(C.dm, { text: "pic", attachments: [{ kind: "image", mime: "image/png", name: "p.png", data: png }] });
    assert.equal(m.attachments![0].kind, "image"); assert.match(m.attachments![0].id, /^hc:/);
    const dl = await s.conn.downloadAttachment(C.dm, m.id, m.attachments![0].id);
    assert.deepEqual([...dl.data], [...png]); assert.equal(dl.mime, "image/png");
    const f = await s.conn.send(C.dm, { text: "", attachments: [{ kind: "file", mime: "application/pdf", name: "a b.pdf", data: new Uint8Array([1, 2, 3]) }] });
    assert.ok(s.fake.drive.has("Microsoft Teams Chat Files/a b.pdf"));
    assert.equal(f.attachments![0].name, "a b.pdf");
    // download of a reference attachment goes through /shares with the Graph token
    const url = "https://contoso.sharepoint.com/doc.pdf"; const msg = s.fake.say(C.dm, ALICE, "<p>file</p>", { attachments: [{ id: "r1", contentType: "reference", contentUrl: url, name: "doc.pdf" }] });
    s.fake.files.set("u!" + Buffer.from(url).toString("base64url"), new Uint8Array([9, 9]));
    const d = await s.conn.downloadAttachment(C.dm, msg.id, "ref:r1"); assert.deepEqual([...d.data], [9, 9]); assert.equal(d.name, "doc.pdf");
    // channel files go to the channel's folder
    await s.conn.send(CHAN.general, { text: "", attachments: [{ kind: "file", mime: "text/plain", name: "n.txt", data: new Uint8Array([1]) }] });
    assert.ok(s.fake.hits.some((h) => h.includes("/filesFolder")));
    await assert.rejects(s.conn.send(C.dm, { text: "", attachments: [{ kind: "file", mime: "x/y", data: { length: 101 * 1024 * 1024 } as any }] }), /too large/);
  } finally { await s.close(); }
});

test("send without Files permission explains how to fix it (images up to 4 MB still work)", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.chats();
    // the default fake scope has no Files.ReadWrite
    await assert.rejects(s.conn.send(C.dm, { text: "", attachments: [{ kind: "file", mime: "application/pdf", name: "a.pdf", data: new Uint8Array([1]) }] }), /Files permission/);
    await assert.rejects(s.conn.downloadAttachment(C.dm, (s.fake.msgs.get(C.dm)![0]).id, "ref:nope"), /not found|Files/);
  } finally { await s.close(); }
});

test("react / unreact / edit / delete (own) / events pushed immediately", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.chats();
    const m = await s.conn.send(C.dm, { text: "mine" });
    await s.conn.react(C.dm, m.id, "\u{1F44D}");
    assert.equal(s.fake.find(C.dm, m.id)!.reactions![0].reactionType, "like");
    assert.deepEqual(s.of("message-update").at(-1).patch.reactions, [{ emoji: "\u{1F44D}", senderIds: [ME], mine: true }]);
    await s.conn.react(C.dm, m.id, null);
    assert.equal(s.fake.find(C.dm, m.id)!.reactions!.length, 0);
    await s.conn.edit(C.dm, m.id, "mine edited");
    assert.equal(s.of("message-update").at(-1).patch.text, "mine edited"); assert.ok(s.of("message-update").at(-1).patch.editedAt);
    await s.conn.delete(C.dm, m.id);
    assert.ok(s.fake.hits.includes(`POST /users/${ME}/chats/${C.dm}/messages/${m.id}/softDelete`));
    assert.equal(s.of("message-update").at(-1).patch.deleted, true);
    const theirs = s.fake.say(C.dm, ALICE, "theirs");
    await assert.rejects(s.conn.delete(C.dm, theirs.id), /Could not delete/);
  } finally { await s.close(); }
});

test("markRead posts markChatReadForUser with the tenant id; no-op for channels", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.chats();
    await s.conn.markRead(C.dm, "x");
    const b = s.fake.bodies.find((x) => x.path.endsWith("markChatReadForUser"))!.body; assert.deepEqual(b.user, { id: ME, tenantId: "00000000-0000-4000-8000-0000000000aa" });
    assert.ok(!(await s.conn.chats()).find((c: any) => c.id === C.dm).unread);
    const before = s.fake.hits.length; await s.conn.markRead(CHAN.general, "x"); assert.equal(s.fake.hits.length, before);
  } finally { await s.close(); }
});

test("startChat (email), createGroup, rename, addMembers, removeMember, leaveChat; fixed chats refuse", async () => {
  const s = await setup(factory, { prep: (f) => { f.user("aaaaaaaa-0000-4000-8000-000000000004", "Carol C", "carol@example.test"); } });
  try {
    await waitFor(s.connected); await s.conn.chats();
    const dm = await s.conn.startChat("alice@example.test"); assert.equal(dm.id, C.dm, "existing 1:1 is reused"); assert.equal(dm.kind, "dm");
    const dm2 = await s.conn.startChat("carol@example.test"); assert.equal(dm2.kind, "dm"); assert.equal(dm2.name, "Carol C");
    await assert.rejects(s.conn.startChat("nobody@example.test"), /Nobody/);
    await assert.rejects(s.conn.startChat("a b"), /email/);
    await assert.rejects(s.conn.startChat("x') or ('1@a.b"), /email/);
    const g = await s.conn.createGroup("Project X", ["alice@example.test", "bob@example.test"]); assert.equal(g.name, "Project X"); assert.equal(g.kind, "group");
    await assert.rejects(s.conn.createGroup("x", ["alice@example.test"]), /at least two/);
    await s.conn.renameChat(g.id, "Project Y"); assert.equal((await s.conn.chats()).find((c: any) => c.id === g.id).name, "Project Y");
    await s.conn.addMembers(g.id, ["carol@example.test"]);
    assert.equal((await s.conn.members(g.id)).length, 4);
    await s.conn.removeMember(g.id, "aaaaaaaa-0000-4000-8000-000000000004"); assert.equal((await s.conn.members(g.id)).length, 3);
    await s.conn.leaveChat(g.id); assert.ok(!s.fake.chats.get(g.id)!.members.some((m) => m.userId === ME));
    await assert.rejects(s.conn.leaveChat(C.dm), /Only group chats/); await assert.rejects(s.conn.renameChat(C.meeting, "x"), /Only group chats/);
    await assert.rejects(s.conn.leaveChat(CHAN.general), /channels are managed/i);
  } finally { await s.close(); }
});

test("members: chat members from Graph; channel members degrade to people who wrote", async () => {
  const s = await setup(factory, { prep: (f) => { f.say(CHAN.general, ALICE, "hi"); } });
  try {
    await waitFor(s.connected); await s.conn.chats();
    const ms = await s.conn.members(C.group); assert.deepEqual(ms.map((m: any) => [m.id, m.name, m.handle]).sort(), [[ALICE, "Alice Wonder", "alice@example.test"], [BOB, "Bob Builder", "bob@example.test"], [ME, "Me Myself", "me@example.test"]].sort());
    await s.conn.history(CHAN.general, { limit: 5 });
    assert.deepEqual(await s.conn.members(CHAN.general), [{ id: ALICE, name: "Alice Wonder" }]);
  } finally { await s.close(); }
});

test("avatars: contact, dm chat, space; 404 and 403 give undefined and are cached", async () => {
  const s = await setup(factory, { prep: (f) => { f.users.get(ALICE)!.photo = new Uint8Array([1, 2, 3]); } });
  try {
    await waitFor(s.connected); await s.conn.chats();
    const a = await s.conn.avatar({ kind: "contact", id: ALICE }); assert.deepEqual([...a!.data], [1, 2, 3]); assert.equal(a!.mime, "image/jpeg");
    assert.deepEqual([...(await s.conn.avatar({ kind: "chat", id: C.dm }))!.data], [1, 2, 3]);
    assert.equal(await s.conn.avatar({ kind: "contact", id: BOB }), undefined);
    const n = s.fake.hits.length; assert.equal(await s.conn.avatar({ kind: "contact", id: BOB }), undefined); assert.equal(s.fake.hits.length, n, "negative cache");
    assert.equal(await s.conn.avatar({ kind: "chat", id: C.group }), undefined); assert.equal(await s.conn.avatar({ kind: "space", id: T1 }), undefined);
    assert.equal((await s.conn.getProfile()).displayName, "Me Myself");
  } finally { await s.close(); }
});

test("access token expiry: refreshed transparently, rotated refresh token stored sealed", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.chats();
    const before = loadSession(s.dir)!.refreshToken;
    s.fake.expireAccessTokens();   // 401 on next call -> one silent refresh -> retried
    const ch = await s.conn.chats(); assert.ok(ch.length > 0);
    assert.notEqual(loadSession(s.dir)!.refreshToken, before);
    assert.ok(s.fake.authHits.some((h) => h.endsWith("/token")));
    assert.ok(!s.of("login").length);
  } finally { await s.close(); }
});

test("revoked grant: needs-login with a fresh prompt, session wiped; re-login works", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.chats();
    s.fake.revokeAll();
    await assert.rejects(s.conn.history(C.dm, { limit: 5 }));
    await waitFor(() => s.of("account").some((a: any) => a.state === "needs-login"));
    assert.equal(loadSession(s.dir), undefined);
    const p = s.of("login").at(-1); assert.equal(p.kind, "form"); assert.match(p.error, /expired or was revoked/);
    await s.conn.submitLogin(p.promptId, { client_id: CLIENT_ID });
    await waitFor(() => s.of("account").filter((a: any) => a.state === "connected").length >= 2);
    assert.ok((await s.conn.chats()).length > 0);
  } finally { await s.close(); }
});

test("startup with a revoked refresh token goes to needs-login", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.stop(); s.fake.revokeAll(); s.ev.length = 0;
    await s.conn.start((e: any) => s.ev.push(e));
    await waitFor(() => s.of("account").some((a: any) => a.state === "needs-login")); assert.equal(s.of("login").at(-1).kind, "form");
  } finally { await s.close(); }
});

test("429 with Retry-After is honoured for interactive calls; errors are plain and carry no server text", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.chats();
    s.fake.throttleNext = 2; s.fake.throttleAfterS = "0";
    const t = Date.now(); assert.ok((await s.conn.history(C.dm, { limit: 5 })).length > 0);
    assert.equal(s.fake.throttleNext, 0, "retried after Retry-After"); assert.ok(Date.now() - t < 3000);
    s.fake.failNext = 1;
    const e = await s.conn.members(C.dm).then(() => "", (x: Error) => x.message);
    assert.ok(e === "" || !/SERVER-ERROR-DETAIL/.test(e));
    s.fake.throttleNext = 1; s.fake.throttleAfterS = "3600";
    const err = await s.conn.send(C.dm, { text: "x" }).then(() => "", (x: Error) => x.message);
    assert.match(err, /slow down|rate limited/);
    assert.ok(s.of("error").some((x: any) => x.code === "rate-limited"));
  } finally { await s.close(); }
});

test("poller backs off when Graph is failing and recovers: disconnected then connected", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.chats();
    s.fake.failNext = 100;
    await waitFor(() => s.of("account").some((a: any) => a.state === "disconnected"), 10000);
    s.fake.failNext = 0;
    await waitFor(() => s.of("account").at(-1).state === "connected", 15000);
  } finally { await s.close(); }
});

test("GIFs and stickers: external allow-listed images are attachments; non-allow-listed hosts refused on download", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.chats();
    const gif = s.fake.say(C.dm, ALICE, '<p><img src="https://media.giphy.com/media/x/giphy.gif" alt="gif"></p>');
    const bad = s.fake.say(C.dm, ALICE, '<p><img src="https://evil.example.org/x.png"></p>');
    const h = await s.conn.history(C.dm, { limit: 10 });
    const g = h.find((m: any) => m.id === gif.id)!; assert.equal(g.attachments[0].gif, true); assert.equal(g.attachments[0].mime, "image/gif");
    const b = h.find((m: any) => m.id === bad.id)!;
    await assert.rejects(s.conn.downloadAttachment(C.dm, bad.id, b.attachments![0].id), /will not fetch/i);
  } finally { await s.close(); }
});

test("stop is idempotent and quiet; logout wipes the sealed session", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.stop(); await s.conn.stop();
    await new Promise((r) => setTimeout(r, 120)); // a request already in flight when stop() was called may still land
    const n = s.fake.hits.length; await new Promise((r) => setTimeout(r, 250)); assert.equal(s.fake.hits.length, n, "no polling after stop");
    await s.conn.logout(); assert.deepEqual(readdirSync(s.dir), []);
  } finally { await s.close(); }
});

test("sealed with UNIMSG_TEAMS_KEY: another key cannot read it", async () => {
  process.env.UNIMSG_TEAMS_KEY = "k1";
  const s = await setup(factory);
  try {
    await waitFor(s.connected); assert.ok(loadSession(s.dir));
    process.env.UNIMSG_TEAMS_KEY = "k2"; assert.equal(loadSession(s.dir), undefined);
    assert.ok(!readdirSync(s.dir).includes("teams-session.key"));
  } finally { delete process.env.UNIMSG_TEAMS_KEY; await s.close(); }
});

void writeFileSync;
