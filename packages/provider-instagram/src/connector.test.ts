// Offline tests: the connector against an in-process fake Instagram (http + MQTT/ws on 127.0.0.1). No real service is contacted.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import factory, { CAPABILITIES } from "./index.js";
import { cdnAllowed, encryptPassword, endpoint } from "./api.js";
import { mapItem, mapReactions, iso } from "./map.js";
import { ThriftWriter, buildConnectPayload, inflate, parsePackets, connectPacket } from "./mqtt.js";
import { imageSize } from "./imgsize.js";
import { PNG } from "./fake-server.js";
import { LOGIN, setup, waitFor } from "./helpers.js";

const f = (dir: string, n: string) => join(dir, n);
const withThreads = (fk: any) => {
  fk.addThread("t1", ["2001"]); fk.text("t1", "2001", "hello from alice");
  fk.addThread("tg", ["2001", "2002"], { group: true, title: "Weekend" }); fk.text("tg", "2002", "group msg");
  fk.addThread("tr", ["2003"], { pending: true }); fk.text("tr", "2003", "may I follow you?");
};

test("capabilities declare only what is implemented", async () => {
  const s = await setup(factory, { prep: withThreads });
  try {
    const c: any = s.conn;
    assert.equal(c.capabilities.edits, false); assert.equal(c.edit, undefined);
    assert.equal(c.capabilities.manageMembers, true); assert.equal(typeof c.addMembers, "function"); assert.equal(typeof c.removeMember, "function"); // see features.test.ts
    assert.equal(c.capabilities.e2ee, false); assert.equal(c.capabilities.spaces, false);
    for (const [cap, m] of [["reactions", "react"], ["deletes", "delete"], ["typing", "setTyping"], ["markRead", "markRead"], ["startChat", "startChat"], ["createGroup", "createGroup"], ["leaveChat", "leaveChat"], ["renameChat", "renameChat"], ["avatars", "avatar"]] as const)
      assert.ok((CAPABILITIES as any)[cap] && typeof c[m] === "function", cap);
    assert.equal(factory.login, "form"); assert.equal(factory.displayName, "Instagram");
  } finally { await s.close(); }
});

test("endpoint override is loopback only, CDN allowlist", () => {
  process.env.UNIMSG_IG_BASE = "https://evil.example.org"; assert.equal(endpoint("UNIMSG_IG_BASE", "https://i.instagram.com"), "https://i.instagram.com");
  process.env.UNIMSG_IG_BASE = "http://127.0.0.1:9/"; assert.equal(endpoint("UNIMSG_IG_BASE", "x"), "http://127.0.0.1:9");
  assert.ok(cdnAllowed("https://scontent-x.cdninstagram.com/a.jpg")); assert.ok(cdnAllowed("https://x.fbcdn.net/a")); assert.ok(!cdnAllowed("https://evil.example.org/a")); assert.ok(!cdnAllowed("http://scontent.cdninstagram.com/a")); assert.ok(!cdnAllowed("https://cdninstagram.com.evil.org/a"));
});

test("login: warning + confirmation, bad password, success; session 0600 without password; device kept on logout", async () => {
  const s = await setup(factory, { noSession: true });
  try {
    await waitFor(() => s.of("login").length > 0, 3000, "login prompt");
    assert.ok(s.ev.some((e) => e.type === "account" && e.data.state === "needs-login"));
    const p = s.of("login")[0];
    assert.equal(p.kind, "form"); assert.deepEqual(p.fields.map((x: any) => x.name), ["username", "password", "confirm"]);
    for (const w of [/Unofficial/, /banned/, /password/]) assert.match(p.warning.text, w);
    assert.equal(p.warning.severity, "danger"); const chk = p.fields.find((x: any) => x.name === "confirm"); assert.equal(chk.type, "checkbox"); assert.equal(chk.required, true);
    await assert.rejects(s.conn.submitLogin(p.promptId, { ...LOGIN, confirm: "" }), /tick the box/i);
    await assert.rejects(s.conn.submitLogin(p.promptId, { ...LOGIN, confirm: "false" }), /tick the box/i);
    await assert.rejects(s.conn.submitLogin(p.promptId, { ...LOGIN, password: "nope" }), /Wrong username or password/);
    await assert.rejects(s.conn.submitLogin(p.promptId, { ...LOGIN, username: "ghost" }), /no such account/);
    assert.ok(!existsSync(f(s.dir, "instagram-session.json")));
    await s.conn.submitLogin(p.promptId, LOGIN);
    await waitFor(s.connected, 5000, "connected");
    assert.equal(statSync(f(s.dir, "instagram-session.json")).mode & 0o777, 0o600);
    assert.equal(statSync(f(s.dir, "instagram-device.json")).mode & 0o777, 0o600);
    const saved = readFileSync(f(s.dir, "instagram-session.json"), "utf8");
    assert.ok(!saved.includes("fakepw")); assert.equal(JSON.parse(saved).userId, "1000"); assert.match(JSON.parse(saved).authorization, /^Bearer IGT:2:/);
    const login = s.fake.reqs(/POST \/api\/v1\/accounts\/login/).pop()!;
    assert.match(login.body.enc_password, /^#PWD_INSTAGRAM:4:\d+:/); assert.ok(!JSON.stringify(login.body).includes("fakepw"));
    assert.equal(login.headers.authorization, undefined);
    const dev = JSON.parse(readFileSync(f(s.dir, "instagram-device.json"), "utf8"));
    assert.equal(login.headers["x-ig-device-id"], dev.deviceId);
    await s.conn.logout();
    assert.ok(!existsSync(f(s.dir, "instagram-session.json"))); assert.ok(existsSync(f(s.dir, "instagram-device.json")));
    assert.equal(s.fake.reqs(/POST \/api\/v1\/accounts\/logout/).length, 1);
  } finally { await s.close(); }
});

test("login: two-factor step", async () => {
  const s = await setup(factory, { noSession: true, fake: { twoFactor: true } });
  try {
    await waitFor(() => s.of("login").length > 0);
    await s.conn.submitLogin(s.of("login")[0].promptId, LOGIN);
    await waitFor(() => s.of("login").length === 2); const p = s.of("login")[1];
    assert.match(p.title, /two-factor/i);
    await assert.rejects(s.conn.submitLogin(p.promptId, { code: "000000" }), /code was not accepted/i);
    await s.conn.submitLogin(p.promptId, { code: "123456" });
    await waitFor(s.connected);
  } finally { await s.close(); }
});

test("login: checkpoint challenge with e-mail code", async () => {
  const s = await setup(factory, { noSession: true, fake: { challenge: true } });
  try {
    await waitFor(() => s.of("login").length > 0);
    await s.conn.submitLogin(s.of("login")[0].promptId, LOGIN);
    await waitFor(() => s.of("login").length === 2); const p = s.of("login")[1];
    assert.match(p.title, /checkpoint/i);
    await assert.rejects(s.conn.submitLogin(p.promptId, { code: "111111" }));
    await s.conn.submitLogin(p.promptId, { code: "654321" });
    await waitFor(s.connected);
  } finally { await s.close(); }
});

test("chats: dm, group, message request flagged, names, unread, avatar via avatar()", async () => {
  const s = await setup(factory, { prep: (fk) => { withThreads(fk); fk.threads.get("t1").muted = true; } });
  try {
    await waitFor(s.connected);
    const chats = await s.conn.chats();
    const by = Object.fromEntries(chats.map((c: any) => [c.id, c]));
    assert.equal(by.t1.kind, "dm"); assert.equal(by.t1.name, "Alice Anderson"); assert.equal(by.t1.muted, true); assert.equal(by.t1.unread, 1); assert.equal(by.t1.preview, "hello from alice");
    assert.equal(by.tg.kind, "group"); assert.equal(by.tg.name, "Weekend");
    assert.equal(by.tr.request, true); assert.equal(by.tr.description, undefined); assert.equal(by.t1.request, undefined);
    assert.equal(by.t1.unreadApprox, true, "Instagram has no unread counts: 1 means something new");
    assert.equal(by.t1.accountId, "acc"); assert.equal(by.t1.provider, "instagram");
    const av = await s.conn.avatar({ kind: "chat", id: "t1" }); assert.equal(av.mime, "image/png"); assert.ok(av.data.length > 10);
    assert.ok(await s.conn.avatar({ kind: "contact", id: "2002" }));
    assert.equal(await s.conn.avatar({ kind: "chat", id: "tg" }), undefined);
    assert.equal(s.fake.reqLog.filter((r) => r.path.startsWith("/pic/")).every((r) => !r.headers.authorization), true, "no credentials to the CDN");
    const mem = await s.conn.members("tg"); assert.deepEqual(mem.map((m: any) => m.id).sort(), ["1000", "2001", "2002"]);
  } finally { await s.close(); }
});

test("startup: existing messages are historical; restart delivers only what is new", async () => {
  const s = await setup(factory, { prep: withThreads });
  try {
    await waitFor(s.connected); await waitFor(() => s.of("message").length === 3);
    assert.ok(s.of("message").every((m: any) => m.historical === true));
    assert.ok(s.of("chats-changed").length >= 1);
    assert.deepEqual(s.of("receipt"), []);
    await s.conn.stop();
    s.fake.text("t1", "2001", "while offline");
    const ev2: any[] = []; const c2 = factory.create({ accountId: "acc", dataDir: s.dir }); await c2.start((e) => ev2.push(e));
    await waitFor(() => ev2.some((e) => e.type === "account" && e.data.state === "connected"));
    const msgs = ev2.filter((e) => e.type === "message").map((e) => e.data);
    assert.deepEqual(msgs.map((m: any) => m.text), ["while offline"]); assert.equal(msgs[0].historical, undefined);
    await c2.stop();
  } finally { await s.close(); }
});

test("history paging backwards with beforeMessageId", async () => {
  const s = await setup(factory, { prep: (fk) => { fk.addThread("t1", ["2001"]); for (let i = 1; i <= 45; i++) fk.text("t1", i % 2 ? "2001" : "1000", "m" + i); } });
  try {
    await waitFor(s.connected);
    const p1 = await s.conn.history("t1", { limit: 20 });
    assert.deepEqual(p1.map((m: any) => m.text), Array.from({ length: 20 }, (_, i) => "m" + (26 + i)));
    const p2 = await s.conn.history("t1", { limit: 20, beforeMessageId: p1[0].id });
    assert.deepEqual(p2.map((m: any) => m.text), Array.from({ length: 20 }, (_, i) => "m" + (6 + i)));
    const p3 = await s.conn.history("t1", { limit: 20, beforeMessageId: p2[0].id });
    assert.deepEqual(p3.map((m: any) => m.text), ["m1", "m2", "m3", "m4", "m5"]);
    assert.equal(p1.at(-1)!.fromMe, false); assert.equal(p1.at(-2)!.fromMe, true); assert.equal(p1.at(-2)!.sender, "Me");
    // a message id we have no cursor for (fresh connector) still pages correctly
    const c2 = factory.create({ accountId: "acc", dataDir: s.dir }); await c2.start(() => {});
    const q = await c2.history("t1", { limit: 3, beforeMessageId: p2[0].id }); assert.deepEqual(q.map((m: any) => m.text), ["m3", "m4", "m5"]); await c2.stop();
  } finally { await s.close(); }
});

test("mapItem: every supported item type becomes readable text / attachments / cards", () => {
  const users = new Map([["2001", { pk: "2001", username: "alice", full_name: "Alice" }]]);
  const m = (item: any, me = "1000") => mapItem({ item_id: "i1", user_id: "2001", timestamp: "1700000000000000", ...item }, "c", me, users as any);
  const img = { image_versions2: { candidates: [{ url: "https://x.cdninstagram.com/s.jpg", width: 100, height: 100 }, { url: "https://x.cdninstagram.com/b.jpg", width: 900, height: 900 }] } };
  assert.equal(iso("1700000000000000"), "2023-11-14T22:13:20.000Z");
  assert.equal(m({ item_type: "text", text: "hi" }).message.text, "hi");
  assert.equal(m({ item_type: "like" }).message.text, "❤️");
  const link = m({ item_type: "link", link: { text: "see https://e.org", link_context: { link_url: "https://e.org", link_title: "E", link_summary: "sum" } } }).message;
  assert.deepEqual(link.card, { kind: "link", title: "E", body: "sum", url: "https://e.org" });
  const photo = m({ item_type: "media", media: { original_width: 900, original_height: 600, ...img } });
  assert.equal(photo.message.attachments![0].kind, "image"); assert.equal(photo.media.get("i1:0")!.url, "https://x.cdninstagram.com/b.jpg"); assert.equal(photo.message.attachments![0].width, 900);
  const vid = m({ item_type: "media", media: { video_versions: [{ url: "https://x.cdninstagram.com/v.mp4" }], video_duration: 3.5 } }).message.attachments![0];
  assert.equal(vid.kind, "video"); assert.equal(vid.durationMs, 3500);
  const voice = m({ item_type: "voice_media", voice_media: { media: { audio: { audio_src: "https://x.cdninstagram.com/a.m4a", duration: 4200, waveform_data: Array.from({ length: 200 }, (_, i) => (i % 10) / 10) } } } }).message.attachments![0];
  assert.equal(voice.kind, "voice"); assert.equal(voice.durationMs, 4200); assert.equal(voice.waveform!.length, 64); assert.ok(Math.max(...voice.waveform!) <= 100);
  const gif = m({ item_type: "animated_media", animated_media: { images: { fixed_height: { url: "https://x.cdninstagram.com/g.gif", mp4: "https://x.cdninstagram.com/g.mp4", width: "200", height: "100" } } } }).message.attachments![0];
  assert.equal(gif.kind, "video"); assert.equal(gif.gif, true);
  assert.equal(m({ item_type: "animated_media", animated_media: { is_sticker: true, images: { fixed_height: { url: "https://x.cdninstagram.com/s.webp" } } } }).message.attachments![0].kind, "sticker");
  const post = m({ item_type: "media_share", media_share: { code: "ABC", user: { username: "bob" }, caption: { text: "nice" }, ...img } }).message;
  assert.equal(post.card!.kind, "other"); assert.match(post.card!.image!.attachmentId, /:c0$/); assert.equal(post.attachments, undefined, "the preview is a card image, not an attachment"); assert.equal(post.card!.url, "https://www.instagram.com/p/ABC/"); assert.match(post.text, /post by @bob/);
  const reel = m({ item_type: "clip", clip: { clip: { code: "RR", user: { username: "bob" }, product_type: "clips" } } }).message;
  assert.equal(reel.card!.url, "https://www.instagram.com/reel/RR/"); assert.match(reel.text, /reel/);
  assert.equal(m({ item_type: "reel_share", reel_share: { type: "reply", text: "cool!" } }).message.text, "Replied to your story: cool!");
  assert.equal(m({ item_type: "reel_share", reel_share: { type: "reply", text: "cool!" }, is_sent_by_viewer: true, user_id: "1000" }).message.text, "Replied to their story: cool!");
  assert.equal(m({ item_type: "reel_share", reel_share: { type: "mention" } }).message.text, "Mentioned you in their story");
  assert.match(m({ item_type: "reel_share", reel_share: { type: "reaction", text: "😍" } }).message.text, /Reacted to your story: 😍/);
  assert.match(m({ item_type: "story_share", story_share: { media: { user: { username: "bob" } } } }).message.text, /story by @bob/);
  assert.match(m({ item_type: "story_share", story_share: { message: "Unavailable" } }).message.text, /Unavailable/);
  assert.equal(m({ item_type: "location", location: { lat: 1, lng: 2, name: "Spot" } }).message.location!.lat, 1);
  assert.equal(m({ item_type: "action_log", action_log: { description: "Alice left" } }).message.system!.kind, "info");
  assert.match(m({ item_type: "raven_media", visual_media: {} }).message.text, /Disappearing/); assert.equal(m({ item_type: "raven_media" }).message.attachments, undefined);
  assert.match(m({ item_type: "profile", profile: { username: "carol", full_name: "Carol" } }).message.card!.url!, /carol/);
  assert.match(m({ item_type: "xma_media_share", xma_media_share: [{ title_text: "T", target_url: "https://e.org" }] }).message.card!.url!, /e\.org/);
  assert.match(m({ item_type: "totally_new_thing" }).message.text, /Unsupported Instagram message \(totally_new_thing\)/);
  const reply = m({ item_type: "text", text: "yes", replied_to_message: { item_id: "i0", user_id: "1000", text: "question?" } }).message.replyTo!;
  assert.deepEqual(reply, { messageId: "i0", sender: "Me", textPreview: "question?" });
  const r = mapReactions({ item_id: "x", reactions: { likes: [{ sender_id: "1000" }], emojis: [{ emoji: "😂", sender_id: "2001" }, { emoji: "😂", sender_id: "1000" }] } }, "1000")!;
  assert.deepEqual(r, [{ emoji: "😂", senderIds: ["2001", "1000"], mine: true }, { emoji: "❤️", senderIds: ["1000"], mine: true }]);
});

test("send: text, reply, photo, voice, video; paced one request at a time", async () => {
  const s = await setup(factory, { prep: withThreads });
  try {
    await waitFor(s.connected);
    const m = await s.conn.send("t1", { text: "hi there" });
    assert.equal(m.fromMe, true); assert.equal(m.status, "sent"); assert.equal(m.chatId, "t1"); assert.equal(m.text, "hi there");
    const req = s.fake.reqs(/POST \/api\/v1\/direct_v2\/threads\/broadcast\/text/).pop()!;
    assert.equal(req.body.text, "hi there"); assert.equal(req.body.thread_ids, '["t1"]'); assert.ok(req.body.client_context);
    const target = s.fake.threads.get("t1").items.find((i: any) => i.text === "hello from alice");
    const r = await s.conn.send("t1", { text: "answer", replyToMessageId: target.item_id });
    assert.equal(r.replyTo.messageId, target.item_id);
    assert.equal(s.fake.reqs(/broadcast\/text/).pop()!.body.replied_to_item_id, target.item_id);
    assert.equal(s.fake.reqs(/broadcast\/text/).pop()!.body.replied_to_client_context, target.client_context);
    const ph = await s.conn.send("t1", { text: "", attachments: [{ kind: "image", mime: "image/png", data: PNG }] });
    assert.equal(ph.attachments[0].kind, "image");
    assert.equal(s.fake.uploads[0].params.media_type, 1); assert.equal(s.fake.uploads[0].params.upload_media_width, 1); assert.equal(s.fake.uploads[0].len, PNG.length);
    const vn = await s.conn.send("t1", { text: "", attachments: [{ kind: "voice", mime: "audio/mp4", data: new Uint8Array([1, 2, 3]), durationMs: 1500, waveform: [10, 90] }] });
    assert.equal(vn.attachments[0].kind, "voice"); assert.equal(s.fake.uploads[1].params.is_direct_voice, "1");
    assert.deepEqual(JSON.parse(s.fake.reqs(/share_voice/).pop()!.body.waveform), [0.1, 0.9]);
    await s.conn.send("t1", { text: "", attachments: [{ kind: "video", mime: "video/mp4", data: new Uint8Array([1]) }] });
    assert.match(s.fake.uploads[2].path, /rupload_igvideo/);
    await assert.rejects(s.conn.send("t1", { text: "", attachments: [{ kind: "file", mime: "application/pdf", data: new Uint8Array([1]) }] }), /photos, videos and voice/);
    // text + photo: the photo is returned as an event, text is the result
    const both = await s.conn.send("t1", { text: "caption", attachments: [{ kind: "image", mime: "image/png", data: PNG }] });
    assert.equal(both.text, "caption"); assert.equal(s.of("message").filter((x: any) => x.attachments?.length && x.fromMe).length, 1);
    // downloading media we sent falls back to the thread
    const dl = await s.conn.downloadAttachment("t1", ph.id, ph.attachments[0].id); assert.equal(dl.data.length, PNG.length);
    // authorization header is used on API calls, not on media download
    assert.ok(s.fake.reqs(/GET \/media\//).every((x) => !x.headers.authorization));
  } finally { await s.close(); }
});

test("react (set/replace/remove), unsend, markRead", async () => {
  const s = await setup(factory, { prep: withThreads });
  try {
    await waitFor(s.connected); await waitFor(() => s.fake.rtConnects === 1);
    const id = s.fake.threads.get("t1").items[0].item_id;
    await s.conn.react("t1", id, "😂");
    const rq = s.fake.reqs(/broadcast\/reaction/).pop()!.body; assert.equal(rq.emoji, "😂"); assert.equal(rq.reaction_status, "created"); assert.equal(rq.item_id, id);
    await waitFor(() => s.of("message-update").some((u: any) => u.patch.reactions));
    assert.deepEqual(s.of("message-update").find((u: any) => u.patch.reactions).patch.reactions, [{ emoji: "😂", senderIds: ["1000"], mine: true }]);
    await s.conn.react("t1", id, null);
    assert.equal(s.fake.reqs(/broadcast\/reaction/).pop()!.body.reaction_status, "deleted"); assert.equal(s.fake.reqs(/broadcast\/reaction/).pop()!.body.emoji, "😂");
    const mine = await s.conn.send("t1", { text: "oops" });
    await s.conn.delete("t1", mine.id);
    assert.ok(!s.fake.threads.get("t1").items.some((i: any) => i.item_id === mine.id));
    assert.ok(s.of("message-update").some((u: any) => u.messageId === mine.id && u.patch.deleted));
    await assert.rejects(s.conn.delete("t1", id), /refused/);
    await s.conn.markRead("t1", id);
    const seen = s.fake.reqs(/items\/.*\/seen/).pop()!; assert.equal(seen.body.item_id, id);
  } finally { await s.close(); }
});

test("message request: replying accepts it first; startChat / createGroup / rename / leave", async () => {
  const s = await setup(factory, { prep: withThreads });
  try {
    await waitFor(s.connected); await s.conn.chats();
    await s.conn.send("tr", { text: "sure" });
    const order = s.fake.reqLog.map((r) => r.path).filter((p) => /approve|broadcast\/text/.test(p));
    assert.match(order[0], /approve/); assert.match(order[1], /text/);
    assert.equal(s.fake.threads.get("tr").pending, false);
    const c = await s.conn.startChat("@alice"); assert.equal(c.id, "t1"); assert.equal(c.kind, "dm");
    // no thread with bob yet: provisional chat; the first send creates the real thread and answers with ITS id
    const pc = await s.conn.startChat("bob"); assert.equal(pc.provisional, true); assert.equal(pc.id, "new:2002"); assert.equal(pc.name, "Bob Builder");
    const first = await s.conn.send(pc.id, { text: "hello bob" });
    assert.notEqual(first.chatId, pc.id); assert.ok(s.fake.threads.has(first.chatId)); assert.equal(s.fake.threads.get(first.chatId).items[0].text, "hello bob");
    assert.ok(s.fake.reqs(/broadcast\/text/).pop()!.body.recipient_users, "addressed by recipient, no thread id yet");
    const again = await s.conn.startChat("bob"); assert.equal(again.id, first.chatId); assert.equal(again.provisional, undefined);
    // requests: decline removes the thread
    await s.conn.chats(); assert.ok(typeof s.conn.acceptRequest === "function" && s.conn.capabilities.requests);
    s.fake.addThread("tr2", ["2003"], { pending: true }); s.fake.text("tr2", "2003", "hey");
    await s.conn.chats(); await s.conn.declineRequest("tr2"); assert.ok(!s.fake.threads.has("tr2"));
    s.fake.addThread("tr3", ["2003"], { pending: true }); s.fake.text("tr3", "2003", "hi"); await s.conn.chats(); await s.conn.acceptRequest("tr3"); assert.equal(s.fake.threads.get("tr3").pending, false);
    await assert.rejects(s.conn.startChat("nobodyhere"), /No Instagram account/);
    await assert.rejects(s.conn.startChat("bad handle!"), /username/);
    const g = await s.conn.createGroup("Trip", ["alice", "@bob"]); assert.equal(g.kind, "group"); assert.equal(g.name, "Trip");
    await s.conn.renameChat(g.id, "Trip 2"); assert.equal(s.fake.threads.get(g.id).thread_title, "Trip 2");
    await s.conn.leaveChat(g.id); assert.ok(!s.fake.threads.has(g.id));
  } finally { await s.close(); }
});

test("realtime: message, reaction patch, unsend, read receipt, typing; setTyping publishes", async () => {
  const s = await setup(factory, { prep: withThreads });
  try {
    await waitFor(s.connected); await waitFor(() => s.fake.rtConnects === 1, 5000, "mqtt");
    assert.deepEqual(s.fake.rtAuthSeen, [true]);
    await waitFor(() => s.fake.rtPublished.some((p) => p.topic === "134"));
    assert.equal(s.fake.rtPublished.find((p) => p.topic === "134")!.json.seq_id, 42);
    const before = s.fake.reqs(/GET \/api\/v1\/direct_v2\/inbox/).length;
    const it = s.fake.text("t1", "2001", "live!", true);
    await waitFor(() => s.of("message").some((m: any) => m.text === "live!"));
    const live = s.of("message").find((m: any) => m.text === "live!"); assert.equal(live.id, it.item_id); assert.equal(live.historical, undefined); assert.equal(live.sender, "Alice Anderson");
    s.fake.pushOps([{ op: "remove", path: `/direct_v2/threads/t1/items/${it.item_id}`, value: "" }]);
    await waitFor(() => s.of("message-update").some((u: any) => u.messageId === it.item_id && u.patch.deleted));
    s.fake.pushOps([{ op: "replace", path: "/direct_v2/threads/t1/participants/2001/has_seen", value: JSON.stringify({ timestamp: "1", item_id: "mine-1" }) }]);
    await waitFor(() => s.of("receipt").some((r: any) => r.messageId === "mine-1"));
    assert.deepEqual(s.of("receipt").find((r: any) => r.messageId === "mine-1"), { chatId: "t1", messageId: "mine-1", status: "read", by: "2001" });
    s.fake.pushPubsub([{ op: "add", path: "/direct_v2/threads/t1/activity_indicator_id/abc", value: JSON.stringify({ sender_id: "2001", activity_status: 1, ttl: 2000 }) }]);
    await waitFor(() => s.of("typing").some((t: any) => t.typing));
    assert.deepEqual(s.of("typing")[0], { chatId: "t1", senderId: "2001", typing: true });
    await waitFor(() => s.of("typing").some((t: any) => !t.typing), 6000, "typing stop");
    await s.conn.setTyping("t1", true);
    await waitFor(() => s.fake.rtPublished.some((p) => p.topic === "132" && p.json.activity_status === "1"));
    assert.equal(s.fake.reqs(/GET \/api\/v1\/direct_v2\/inbox/).length, before, "realtime does not trigger polling");
  } finally { await s.close(); }
});

test("realtime reconnects after a drop; a refused realtime does not break polling", async () => {
  const s = await setup(factory, { prep: withThreads });
  try {
    await waitFor(s.connected); await waitFor(() => s.fake.rtConnects === 1);
    s.fake.dropSockets(); await waitFor(() => s.fake.rtConnects === 2, 8000, "reconnect");
    s.fake.text("t1", "2001", "after reconnect", true);
    await waitFor(() => s.of("message").some((m: any) => m.text === "after reconnect"));
  } finally { await s.close(); }
  const p = await setup(factory, { prep: withThreads, env: { UNIMSG_IG_POLL_MS: "150" } });
  try {
    p.fake.rtRefused = true; await waitFor(p.connected);
    p.fake.text("t1", "2001", "found by polling");
    await waitFor(() => p.of("message").some((m: any) => m.text === "found by polling"), 6000, "poll");
    assert.equal(p.of("message").filter((m: any) => m.text === "found by polling").length, 1, "no duplicate");
  } finally { await p.close(); }
});

test("polling alone sees new messages and read receipts; realtime disabled by env", async () => {
  const s = await setup(factory, { prep: withThreads, env: { UNIMSG_IG_POLL_MS: "150", UNIMSG_IG_NO_REALTIME: "1" } });
  try {
    await waitFor(s.connected);
    s.fake.text("tg", "2002", "poll me");
    await waitFor(() => s.of("message").some((m: any) => m.text === "poll me"));
    s.fake.threads.get("t1").last_seen_at = { "2001": { timestamp: "1", item_id: "x9" } };
    await waitFor(() => s.of("receipt").some((r: any) => r.messageId === "x9"));
    assert.equal(s.fake.rtConnects, 0);
  } finally { await s.close(); }
});

test("session revoked -> needs-login with a new prompt, saved session wiped; rate limit pauses politely", async () => {
  const s = await setup(factory, { prep: withThreads, env: { UNIMSG_IG_POLL_MS: "150", UNIMSG_IG_NO_REALTIME: "1" } });
  try {
    await waitFor(s.connected);
    s.fake.rateLimitNext = 1; s.fake.retryAfter = 3600;
    await assert.rejects(s.conn.history("t1", { limit: 5 }), /rate limiting/);
    const n = s.fake.reqLog.length;
    await assert.rejects(s.conn.history("t1", { limit: 5 }), /slow down/);
    assert.equal(s.fake.reqLog.length, n, "no request while cooling down");
    assert.ok(s.of("error").some((e: any) => e.code === "rate-limited"));
    await s.conn.stop();
    const ev: any[] = [];
    s.fake.rateLimitNext = 0; s.fake.tokens.clear();
    const c2 = factory.create({ accountId: "acc", dataDir: s.dir }); await c2.start((e) => ev.push(e));
    await waitFor(() => ev.some((e) => e.type === "account" && e.data.state === "needs-login"));
    assert.ok(ev.some((e) => e.type === "login" && /expired or was revoked/.test(e.data.error))); assert.ok(!existsSync(f(s.dir, "instagram-session.json"))); assert.ok(existsSync(f(s.dir, "instagram-device.json")));
    await c2.stop();
  } finally { await s.close(); }
});

test("device identity persists across restarts and is sent consistently", async () => {
  const s = await setup(factory, { prep: withThreads });
  try {
    await waitFor(s.connected); await s.conn.stop();
    const c2 = factory.create({ accountId: "acc", dataDir: s.dir }); await c2.start(() => {}); await c2.chats(); await c2.stop();
    const ids = new Set(s.fake.reqLog.filter((r) => r.path.startsWith("/api/v1/")).map((r) => r.headers["x-ig-device-id"]));
    assert.equal(ids.size, 1);
    const ua = new Set(s.fake.reqLog.filter((r) => r.path.startsWith("/api/v1/")).map((r) => r.headers["user-agent"])); assert.equal(ua.size, 1);
  } finally { await s.close(); }
});

test("units: thrift/MQTT packets and image sizes", () => {
  const w = new ThriftWriter(); w.str(1, "ab"); w.begin(4); w.i64(1, 5); w.bool(6, true); w.end();
  assert.deepEqual([...w.done()], [0x18, 2, 0x61, 0x62, 0x3c, 0x16, 0x0a, 0x51, 0x00, 0x00]);
  const p = buildConnectPayload({ userId: "1000", deviceId: "dev-1", userAgent: "UA", authorization: "Bearer SECRET" });
  assert.ok(inflate(p).includes(Buffer.from("Bearer SECRET"))); assert.ok(!p.includes(Buffer.from("Bearer SECRET")), "deflated");
  const pk = parsePackets(Buffer.concat([connectPacket(p), Buffer.from([0xc0])])); assert.equal(pk.packets.length, 1); assert.equal(pk.packets[0].type, 1); assert.equal(pk.rest.length, 1);
  assert.deepEqual(imageSize(PNG), { width: 1, height: 1 });
  const jpg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffc0001108000a000fff", "hex"); assert.deepEqual(imageSize(jpg), { width: 15, height: 10 });
});

test("requests are paced: a minimum gap between consecutive HTTP calls", async () => {
  const s = await setup(factory, { prep: withThreads, env: { UNIMSG_IG_PACE_MS: "120" } });
  try {
    await waitFor(s.connected, 10000); await Promise.all([s.conn.history("t1", { limit: 3 }), s.conn.history("tg", { limit: 3 }), s.conn.members("t1")]);
    const times = s.fake.reqLog.filter((r) => r.path.startsWith("/api/v1/")).map((r) => r.t);
    assert.ok(times.length >= 4);
    for (let k = 1; k < times.length; k++) assert.ok(times[k] - times[k - 1] >= 100, `gap ${times[k] - times[k - 1]}ms`);
  } finally { await s.close(); }
});

test("seen covers all MY items up to the seen one (new range only), with the time they saw it; others' items are not receipts", async () => {
  const s = await setup(factory, { prep: withThreads, env: { UNIMSG_IG_POLL_MS: "150", UNIMSG_IG_NO_REALTIME: "1" } });
  try {
    await waitFor(s.connected);
    const p = s.conn as any; const T = 1_800_000_000_000; // ms; Instagram times are µs
    p.noteItem("t1", "m1", (T + 1000) * 1000, true); p.noteItem("t1", "m2", (T + 2000) * 1000, true); p.noteItem("t1", "m3", (T + 3000) * 1000, true);
    p.noteItem("t1", "theirs", (T + 1500) * 1000, false);
    p.seenBy("t1", "2001", "m2", String((T + 2500) * 1000));
    assert.deepEqual(s.of("receipt").filter((r: any) => r.by === "2001").map((r: any) => [r.messageId, r.at]), [["m1", new Date(T + 2500).toISOString()], ["m2", new Date(T + 2500).toISOString()]]);
    p.seenBy("t1", "2001", "m3", String((T + 4000) * 1000));
    assert.deepEqual(s.of("receipt").filter((r: any) => r.by === "2001").map((r: any) => r.messageId), ["m1", "m2", "m3"]);
    assert.equal(s.conn.capabilities.receiptDetails, true);
  } finally { await s.close(); }
});
