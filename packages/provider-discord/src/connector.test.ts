// Offline tests: the connector against an in-process fake Discord (http + gateway ws on 127.0.0.1). No real service is contacted.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import factory, { CAPABILITIES, CAPABILITIES_USER } from "./index.js";
import { cdnAllowed, endpoint, gatewayAllowed } from "./api.js";
import { channelPermissions, mapMedia, renderContent, waveformOf } from "./map.js";
import { PNG, PERM, bits } from "./fake-server.js";
import { ALICE, BOB, C, G1, ME, setup, waitFor } from "./helpers.js";

const FILE = (dir: string, n: string) => join(dir, n);
const strip = (c: any) => ({ id: c.id, name: c.name, kind: c.kind, readOnly: c.readOnly, spaceId: c.spaceId, description: c.description, category: c.category, canManage: c.canManage });

test("capabilities declare only what is implemented", async () => {
  const s = await setup(factory);
  try {
    const c: any = s.conn;
    // capabilities are per account (login mode): the connector's live getter, not the provider-level object
    assert.equal(c.capabilities.createGroup, false); assert.equal(c.capabilities.manageMembers, false); assert.equal(c.capabilities.renameChat, false); assert.equal(c.capabilities.pollVote, false);
    assert.equal(CAPABILITIES_USER.createGroup, true); assert.equal(CAPABILITIES_USER.manageMembers, true); assert.equal(CAPABILITIES_USER.renameChat, true); assert.equal(CAPABILITIES_USER.pollVote, true);
    for (const m of ["createGroup", "addMembers", "removeMember", "renameChat"]) assert.equal(typeof c[m], "function", m + " exists (refuses in bot mode)");
    assert.ok(CAPABILITIES.voiceNotes && CAPABILITIES.mentions && !CAPABILITIES.chatPicture && CAPABILITIES.chatDescription);
    assert.equal(CAPABILITIES.block, false); assert.equal(CAPABILITIES.createSpace, false); assert.equal(CAPABILITIES.joinSpace, false); // user-mode only, see features.test.ts
    assert.equal(CAPABILITIES.e2ee, false); assert.equal(CAPABILITIES.readReceipts, false); assert.ok(!CAPABILITIES.sync && !c.sync);
    for (const [cap, m] of [["reactions", "react"], ["edits", "edit"], ["deletes", "delete"], ["typing", "setTyping"], ["markRead", "markRead"], ["startChat", "startChat"], ["leaveChat", "leaveChat"], ["avatars", "avatar"], ["polls", "vote"], ["leaveSpace", "leaveSpace"]] as const)
      assert.ok((CAPABILITIES as any)[cap] && typeof c[m] === "function", cap);
    assert.ok(CAPABILITIES.customEmoji && CAPABILITIES.spaces && CAPABILITIES.backfill);
    assert.equal(factory.login, "form");
  } finally { await s.close(); }
});

test("endpoint override is loopback only; CDN and gateway allow-lists", () => {
  process.env.UNIMSG_DISCORD_BASE = "https://evil.example.org"; assert.equal(endpoint("UNIMSG_DISCORD_BASE", "https://discord.com"), "https://discord.com");
  process.env.UNIMSG_DISCORD_BASE = "http://127.0.0.1:9/"; assert.equal(endpoint("UNIMSG_DISCORD_BASE", "x"), "http://127.0.0.1:9");
  process.env.UNIMSG_DISCORD_BASE = "http://127.0.0.1.evil.org"; assert.equal(endpoint("UNIMSG_DISCORD_BASE", "d"), "d");
  assert.ok(cdnAllowed("https://cdn.discordapp.com/a.png")); assert.ok(cdnAllowed("https://media.discordapp.net/a")); assert.ok(cdnAllowed("https://media.tenor.com/x.mp4")); assert.ok(cdnAllowed("https://i.giphy.com/x.gif"));
  assert.ok(!cdnAllowed("https://evil.example.org/a")); assert.ok(!cdnAllowed("http://cdn.discordapp.com/a")); assert.ok(!cdnAllowed("https://cdn.discordapp.com.evil.org/a")); assert.ok(!cdnAllowed("file:///etc/passwd"));
  assert.ok(gatewayAllowed("wss://gateway-us-east1-b.discord.gg")); assert.ok(!gatewayAllowed("wss://evil.example.org")); assert.ok(gatewayAllowed("ws://127.0.0.1:5"));
});

test("login: warning text, mode + YES gate, bad token, success; token sealed 0600; logout wipes", async () => {
  const s = await setup(factory, { noSession: true });
  try {
    await waitFor(() => s.of("login").length > 0, 3000, "login prompt");
    assert.ok(s.ev.some((e) => e.type === "account" && e.data.state === "needs-login"));
    const p = s.of("login")[0];
    assert.equal(p.kind, "form"); assert.deepEqual(p.fields.map((x: any) => x.name), ["mode", "token", "confirm"]);
    assert.equal(p.fields.find((x: any) => x.name === "token").type, "password");
    for (const w of [/Terms of Service/, /terminated/, /bot token/i, /only sees servers it was invited to/, /never asks for your password/]) assert.match(p.warning.text, w);
    assert.ok(p.warning.text.length < 300, "short warning");
    assert.equal(p.warning.severity, "danger");
    const chk = p.fields.find((x: any) => x.name === "confirm"); assert.equal(chk.type, "checkbox"); assert.equal(chk.required, true);
    await assert.rejects(s.conn.submitLogin(p.promptId, { mode: "x", token: "bot-good", confirm: "" }), /bot.*user/);
    await assert.rejects(s.conn.submitLogin(p.promptId, { mode: "bot", token: "" }), /Paste the token/);
    await assert.rejects(s.conn.submitLogin(p.promptId, { mode: "user", token: "user-good", confirm: "" }), /tick the confirmation box/i);
    await assert.rejects(s.conn.submitLogin(p.promptId, { mode: "user", token: "user-good", confirm: "false" }), /tick the confirmation box/i);
    assert.equal(s.fake.log.length, 0, "nothing is sent to Discord before the warning is acknowledged");
    await assert.rejects(s.conn.submitLogin(p.promptId, { mode: "bot", token: "bot-nope" }), /rejected this bot token/);
    await assert.rejects(s.conn.submitLogin(p.promptId, { mode: "user", token: "user-nope", confirm: "true" }), /rejected this user token/);
    assert.ok(!existsSync(FILE(s.dir, "discord-session.json")));
    await s.conn.submitLogin(p.promptId, { mode: "bot", token: "Bot bot-good" });
    await waitFor(s.connected, 5000, "connected");
    const f = FILE(s.dir, "discord-session.json");
    assert.equal(statSync(f).mode & 0o777, 0o600); assert.equal(statSync(FILE(s.dir, "discord-session.key")).mode & 0o777, 0o600);
    const saved = readFileSync(f, "utf8"); assert.ok(!saved.includes("bot-good")); assert.ok(!saved.includes("unibot")); assert.match(saved, /sealed/);
    assert.ok(!existsSync(FILE(s.dir, "discord-identity.json")), "bot mode has no browser-like identity");
    assert.equal(s.fake.reqs(/GET \/users\/@me$/).pop()!.headers.authorization, "Bot bot-good");
    await s.conn.logout();
    assert.ok(!existsSync(f)); assert.ok(!existsSync(FILE(s.dir, "discord-session.key")));
    await waitFor(() => s.fake.sessions.size === 0, 3000, "gateway closed");
  } finally { await s.close(); }
});

test("restart with a saved session needs no login; a tampered/foreign-key session file is ignored", async () => {
  const s = await setup(factory);
  try {
    await s.loaded();
    assert.equal(s.of("login").length, 0);
    await s.conn.stop();
    process.env.UNIMSG_DISCORD_KEY = "another-key";
    const ev2: any[] = []; const c2 = factory.create({ accountId: "acc", dataDir: s.dir });
    await c2.start((e) => ev2.push(e));
    assert.ok(ev2.some((e) => e.type === "login"), "cannot unseal with another key -> asks to log in");
    await c2.stop(); delete process.env.UNIMSG_DISCORD_KEY;
  } finally { delete process.env.UNIMSG_DISCORD_KEY; await s.close(); }
});

test("bot mode: spaces, permission-aware chats, categories, threads, DMs; intents; Authorization", async () => {
  const s = await setup(factory);
  try {
    await s.loaded();
    const sp = await s.conn.spaces(); assert.deepEqual(sp.map((x: any) => [x.id, x.name]), [[G1, "Test Guild"]]);
    const chats = (await s.conn.chats()).map(strip); const by = (id: string) => chats.find((c: any) => c.id === id);
    assert.ok(by(C.general) && by(C.announce) && by(C.thread) && by(C.post));
    assert.ok(!by(C.dm) && !by(C.gdm), "a bot sees no DMs of the owner");
    assert.ok(!by(C.secret), "channel without VIEW_CHANNEL is hidden"); assert.ok(!by(C.voice) && !by(C.cat) && !by(C.forum), "voice/category/forum container are not chats");
    assert.equal(by(C.general).kind, "channel"); assert.equal(by(C.general).spaceId, G1); assert.equal(by(C.general).readOnly, undefined);
    assert.equal(by(C.general).description, "Talk here"); assert.equal(by(C.general).category, "Text Channels", "category is a field now, no description prefix"); assert.equal(by(C.general).canManage, false);
    assert.equal(by(C.announce).readOnly, true); assert.match(by(C.announce).description, /announcements/);
    assert.match(by(C.thread).description, /Thread in #general/); assert.match(by(C.post).description, /Thread in #ideas/);
    const id = s.fake.identifies[0]; assert.equal(id.mode, "bot"); assert.ok(id.intents! & (1 << 15), "message content intent"); assert.ok(id.intents! & (1 << 9));
    assert.equal(id.intents! & (1 << 1), 0, "privileged GUILD_MEMBERS is not requested"); assert.equal(id.intents! & (1 << 8), 0, "GUILD_PRESENCES is not requested");
    assert.ok(s.fake.reqs(/GET \/guilds\/\d+\/members\/\d+/).length === 1);
    assert.equal(s.fake.reqs(/GET \/users\/@me\/guilds|GET \/gateway/).length, 0, "no unnecessary endpoints");
    for (const r of s.fake.log) assert.match(r.headers.authorization ?? "", /^Bot bot-good$/);
  } finally { await s.close(); }
});

test("permission maths: owner, admin, role/member overwrites, timeout", () => {
  const g: any = { id: "1", owner_id: "owner", roles: [{ id: "1", permissions: bits(PERM.VIEW, PERM.SEND) }, { id: "r", permissions: "0" }, { id: "adm", permissions: bits(PERM.ADMIN) }] };
  const ch: any = (ow: any[]) => ({ id: "c", type: 0, permission_overwrites: ow });
  const V = 1n << 10n, S = 1n << 11n;
  assert.ok(channelPermissions(g, ch([{ id: "1", type: 0, allow: "0", deny: String(V) }]), undefined, "owner", undefined) & V);
  assert.ok(channelPermissions(g, ch([{ id: "1", type: 0, allow: "0", deny: String(V) }]), undefined, "x", { roles: ["adm"] }) & V);
  assert.equal(channelPermissions(g, ch([{ id: "1", type: 0, allow: "0", deny: String(V) }]), undefined, "x", { roles: [] }) & V, 0n);
  assert.ok(channelPermissions(g, ch([{ id: "1", type: 0, allow: "0", deny: String(V) }, { id: "r", type: 0, allow: String(V), deny: "0" }]), undefined, "x", { roles: ["r"] }) & V, "role allow beats @everyone deny");
  assert.equal(channelPermissions(g, ch([{ id: "r", type: 0, allow: "0", deny: String(S) }, { id: "x", type: 1, allow: "0", deny: "0" }]), undefined, "x", { roles: ["r"] }) & S, 0n);
  assert.ok(channelPermissions(g, ch([{ id: "r", type: 0, allow: "0", deny: String(S) }, { id: "x", type: 1, allow: String(S), deny: "0" }]), undefined, "x", { roles: ["r"] }) & S, "member allow beats role deny");
  const to = channelPermissions(g, ch([]), undefined, "x", { roles: [], communication_disabled_until: new Date(Date.now() + 60000).toISOString() });
  assert.equal(to & S, 0n); assert.ok(to & V);
});

test("history paging oldest->newest, rich mapping: mentions, emoji, replies, attachments, gif, sticker, embed card, poll, system, reactions", async () => {
  const tenor = "https://tenor.com/view/x-1";
  let m1: any;
  const s = await setup(factory, { prep: (f) => {
    for (let i = 1; i <= 5; i++) f.say(C.general, ALICE, `plain ${i}`);
    m1 = f.say(C.general, BOB, "base message");
    f.say(C.general, ALICE, `hi <@${ME}> and <@${BOB}> <@&300000000000001> in <#${C.thread}> <:party:555000000000001> <a:dance:555000000000002> **bold** <t:1700000000:f>`, { mentions: [f.users.get(ME)!, f.users.get(BOB)!] });
    f.say(C.general, ALICE, "a reply", { type: 19, message_reference: { message_id: m1.id }, referenced_message: m1 });
    f.say(C.general, BOB, "with files", { attachments: [
      { id: "900000000000001", filename: "cat.png", content_type: "image/png", size: 68, width: 1, height: 1, url: `${f.url}/cdn/attachments/1/cat.png` },
      { id: "900000000000002", filename: "voice-message.ogg", content_type: "audio/ogg", size: 9, flags: 8192, duration_secs: 2.5, waveform: Buffer.from([0, 128, 255, 64]).toString("base64"), url: `${f.url}/cdn/attachments/2/v.ogg` },
      { id: "900000000000003", filename: "doc.pdf", size: 9, url: `${f.url}/cdn/attachments/3/doc.pdf` },
    ] });
    f.say(C.general, ALICE, tenor, { embeds: [{ type: "gifv", url: tenor, provider: { name: "Tenor" }, video: { url: `${f.url}/cdn/tenor/x.mp4`, width: 220, height: 124 }, thumbnail: { url: `${f.url}/cdn/tenor/x.png` } }] });
    f.say(C.general, BOB, "", { sticker_items: [{ id: "777", name: "wave", format_type: 1 }, { id: "778", name: "lottie", format_type: 3 }] });
    f.say(C.general, ALICE, "look https://example.org/a", { embeds: [
      { type: "rich", title: "Example title", description: "Example body", url: "https://example.org/a", author: { name: "Writer" }, footer: { text: "foot" }, fields: [{ name: "F1", value: "V1" }], image: { url: `${f.url}/cdn/img/e.png` } },
      { type: "rich", title: "Second", description: "more" },
    ] });
    f.say(C.general, BOB, "", { poll: { question: { text: "Lunch?" }, answers: [{ answer_id: 1, poll_media: { text: "Pizza" } }, { answer_id: 2, poll_media: { text: "Soup", emoji: { name: "🍲" } } }], allow_multiselect: true, results: { is_finalized: false, answer_counts: [{ id: 1, count: 3, me_voted: true }, { id: 2, count: 1 }] } } });
    f.say(C.general, ALICE, "", { type: 7 });
    f.say(C.general, ALICE, "", { type: 6 });
    f.say(C.general, BOB, "", { type: 3, call: { ended_timestamp: null } });
    f.say(C.general, ALICE, "reacted", { reactions: [{ count: 3, me: true, emoji: { id: null, name: "👍" } }, { count: 1, me: false, emoji: { id: "555000000000001", name: "party" } }] });
    f.say(C.general, ALICE, "", { message_reference: { type: 1, message_id: "1" }, message_snapshots: [{ message: { id: "1", channel_id: "1", content: "original <:party:555000000000001>", attachments: [], embeds: [], timestamp: new Date().toISOString() } }] });
  } });
  try {
    await s.loaded();
    const page1 = await s.conn.history(C.general, { limit: 5 });
    assert.equal(page1.length, 5);
    const all = await s.conn.history(C.general, { limit: 100 });
    assert.ok(all.every((m: any, i: number) => i === 0 || BigInt(m.id) > BigInt(all[i - 1].id)), "oldest -> newest");
    const older = await s.conn.history(C.general, { limit: 3, beforeMessageId: page1[0].id });
    assert.ok(older.length === 3 && BigInt(older.at(-1).id) < BigInt(page1[0].id), "paging backwards with before");
    assert.ok(older.every((m: any) => !page1.some((p: any) => p.id === m.id)));
    const t = (re: RegExp) => all.find((m: any) => re.test(m.text));
    const men = t(/^hi /);
    assert.equal(men.text, "hi @Me Myself and @bob @Moderators in #side-talk :party: :dance: **bold** 2023-11-14 22:13 UTC");
    assert.equal(men.sender, "Alice Wonder", "global name when no member object is present");
    const rep = t(/^a reply/); assert.equal(rep.replyTo.messageId, m1.id); assert.equal(rep.replyTo.sender, "bob"); assert.equal(rep.replyTo.textPreview, "base message");
    const files = t(/^with files/);
    assert.deepEqual(files.attachments.map((a: any) => [a.kind, a.mime, a.name]), [["image", "image/png", "cat.png"], ["voice", "audio/ogg", "voice-message.ogg"], ["file", "application/pdf", "doc.pdf"]]);
    assert.equal(files.attachments[1].durationMs, 2500); assert.deepEqual(files.attachments[1].waveform, [0, 50, 100, 25]);
    const gif = all.find((m: any) => m.attachments?.[0]?.gif); assert.equal(gif.text, "", "bare gif link is replaced by the gif"); assert.deepEqual([gif.attachments[0].kind, gif.attachments[0].gif, gif.attachments[0].mime], ["video", true, "video/mp4"]);
    const st = all.find((m: any) => m.attachments?.[0]?.kind === "sticker"); assert.equal(st.attachments.length, 1); assert.equal(st.text, "[sticker: lottie]", "the unrenderable Lottie sticker is named in the text");
    assert.ok(st.attachments[0].id.startsWith("s"));
    const emb = t(/^look/); assert.equal(emb.card, undefined); assert.equal(emb.cards.length, 2, "one card per embed");
    const c0 = emb.cards[0]; assert.equal(c0.kind, "other"); assert.deepEqual([c0.title, c0.subtitle, c0.body, c0.url, c0.footer], ["Example title", "Writer", "Example body", "https://example.org/a", "foot"]);
    assert.deepEqual(c0.rows, [{ label: "F1", value: "V1" }]); assert.equal(c0.image.attachmentId, "e0i"); assert.equal(c0.image.layout, undefined);
    assert.equal(emb.cards[1].title, "Second"); assert.equal(emb.cards[1].image, undefined); assert.ok(!emb.attachments, "embed images are card images, not attachments");
    const img = await s.conn.downloadAttachment(C.general, emb.id, "e0i"); assert.ok(img.data.length > 0, "card image loads through downloadAttachment");
    const poll = all.find((m: any) => m.poll); assert.equal(poll.poll.question, "Lunch?"); assert.equal(poll.poll.multiple, true); assert.deepEqual(poll.poll.mine, ["1"]);
    assert.deepEqual(poll.poll.options.map((o: any) => [o.text, o.voters.length]), [["Pizza", 1], ["🍲 Soup", 0]]); assert.ok(poll.poll.options[0].voters.includes(ME));
    assert.deepEqual(poll.poll.options.map((o: any) => o.count), [3, 1], "exact counts, no fake voters");
    const sys = all.filter((m: any) => m.system); assert.deepEqual(sys.map((m: any) => m.text), ["Alice Wonder joined the server", "Alice Wonder pinned a message", "bob started a call"]);
    assert.ok(sys.every((m: any) => m.system.kind === "info" && !m.fromMe));
    const rx = t(/^reacted/); assert.deepEqual(rx.reactions.map((r: any) => [r.emoji, r.senderIds.length, !!r.mine]), [["👍", 1, true], [":party:", 0, false]]); assert.ok(rx.reactions[0].senderIds.includes(ME));
    assert.deepEqual(rx.reactions.map((r: any) => r.count), [3, 1]); assert.ok(!JSON.stringify(rx.reactions).includes("anon"));
    const fw = all.at(-1); assert.equal(fw.forwarded, true); assert.equal(fw.text, "original :party:");
  } finally { await s.close(); }
});

test("downloadAttachment from the CDN without credentials; avatar() for users, guilds, emoji", async () => {
  const s = await setup(factory, { prep: (f) => {
    f.say(C.general, BOB, "pic", { attachments: [{ id: "900000000000009", filename: "cat.png", content_type: "image/png", size: 68, url: `${f.url}/cdn/attachments/9/cat.png` }] });
    f.say(C.general, ALICE, "https://tenor.com/x", { embeds: [{ type: "gifv", url: "https://tenor.com/x", video: { url: `${f.url}/cdn/tenor/x.mp4` } }] });
  } });
  try {
    await s.loaded();
    const h = await s.conn.history(C.general, { limit: 10 });
    const pic = h.find((m: any) => m.text === "pic");
    const d = await s.conn.downloadAttachment(C.general, pic.id, pic.attachments[0].id);
    assert.deepEqual(Buffer.from(d.data), PNG); assert.equal(d.mime, "image/png"); assert.equal(d.name, "cat.png");
    const gif = h.find((m: any) => m.text === "" && m.attachments?.[0]?.gif); const g = await s.conn.downloadAttachment(C.general, gif.id, gif.attachments[0].id); assert.equal(g.mime, "video/mp4");
    for (const r of s.fake.reqs(/GET \/cdn\//)) assert.equal(r.headers.authorization, undefined, "never send the token to a media host");
    const ava = await s.conn.avatar({ kind: "contact", id: ALICE }); assert.deepEqual(Buffer.from(ava!.data), PNG);
    assert.equal(await s.conn.avatar({ kind: "contact", id: BOB }), undefined, "no custom picture -> UI draws its own");
    assert.ok(await s.conn.avatar({ kind: "space", id: G1 })); await s.conn.startChat(ALICE); assert.ok(await s.conn.avatar({ kind: "chat", id: C.dm }));
    assert.equal(await s.conn.avatar({ kind: "chat", id: C.general }), undefined);
    assert.ok(s.fake.reqs(/GET \/cdn\/avatars\/1000000000000001\/abcdef\.png/).length === 2);
    assert.ok(s.fake.reqs(/GET \/cdn\/icons\/100000000000001\/ic0n\.png/).length === 1);
    // custom emoji by name (known from the guild), animated -> gif; unknown / malformed -> undefined
    assert.ok(await s.conn.avatar({ kind: "emoji", id: "party" })); assert.ok(await s.conn.avatar({ kind: "emoji", id: "dance" }));
    assert.equal(s.fake.reqs(/GET \/cdn\/emojis\/555000000000001\.png/).length, 1); assert.equal(s.fake.reqs(/GET \/cdn\/emojis\/555000000000002\.gif/).length, 1);
    assert.equal(await s.conn.avatar({ kind: "emoji", id: "nosuch" }), undefined); assert.equal(await s.conn.avatar({ kind: "emoji", id: "../../x" }), undefined);
    // a hostile attachment URL is refused (SSRF / token exfiltration guard)
    s.fake.messages.get(C.general)!.at(-2)!.attachments = [{ id: "900000000000009", filename: "x", url: "https://evil.example.org/x" } as any];
    s.fake.messages.get(C.general)!.at(-2)!.id = pic.id;
    await assert.rejects(s.conn.downloadAttachment(C.general, "123456789012345", "900000000000009"));
  } finally { await s.close(); }
});

test("live events: message, edit, delete, reactions, typing, embed-only update, unread, previews, echo of own send", async () => {
  const s = await setup(factory);
  try {
    await s.loaded();
    const F = s.fake;
    const m = F.say(C.general, ALICE, "live **hello** <@" + ME + ">", { mentions: [F.users.get(ME)!], member: { roles: [], nick: "Ally" } as any });
    F.dispatch("MESSAGE_CREATE", m);
    await waitFor(() => s.of("message").length === 1);
    const got = s.of("message")[0]; assert.deepEqual([got.id, got.chatId, got.text, got.sender, got.fromMe, got.historical], [m.id, C.general, "live **hello** @Me Myself", "Ally", false, undefined]);
    let chat = (await s.conn.chats()).find((c: any) => c.id === C.general); assert.equal(chat.unread, 1); assert.equal(chat.preview, "live **hello** @Me Myself");
    // edit: only the text, plus editedAt
    F.dispatch("MESSAGE_UPDATE", { ...m, content: "edited text", edited_timestamp: new Date().toISOString() });
    await waitFor(() => s.of("message-update").length === 1);
    assert.equal(s.of("message-update")[0].patch.text, "edited text"); assert.ok(s.of("message-update")[0].patch.editedAt);
    // embed unfurl: a partial update without content/author must not touch the text
    F.dispatch("MESSAGE_UPDATE", { id: m.id, channel_id: C.general, embeds: [{ type: "rich", title: "Unfurled", url: "https://example.org" }] });
    await waitFor(() => s.of("message-update").length === 2);
    const pu = s.of("message-update")[1].patch; assert.equal(pu.text, undefined); assert.equal(pu.cards[0].title, "Unfurled");
    // reactions
    F.dispatch("MESSAGE_REACTION_ADD", { user_id: BOB, channel_id: C.general, message_id: m.id, emoji: { id: null, name: "🎉" } });
    await waitFor(() => s.of("message-update").length === 3);
    assert.deepEqual(s.of("message-update")[2].patch.reactions, [{ emoji: "🎉", senderIds: [BOB] }]);
    F.dispatch("MESSAGE_REACTION_ADD", { user_id: ME, channel_id: C.general, message_id: m.id, emoji: { id: "555000000000001", name: "party" } });
    await waitFor(() => s.of("message-update").length === 4);
    assert.deepEqual(s.of("message-update")[3].patch.reactions.map((r: any) => [r.emoji, r.senderIds.length, !!r.mine]), [["🎉", 1, false], [":party:", 1, true]]);
    F.dispatch("MESSAGE_REACTION_REMOVE", { user_id: BOB, channel_id: C.general, message_id: m.id, emoji: { id: null, name: "🎉" } });
    await waitFor(() => s.of("message-update").length === 5);
    assert.deepEqual(s.of("message-update")[4].patch.reactions.map((r: any) => r.emoji), [":party:"]);
    // typing
    F.dispatch("TYPING_START", { channel_id: C.general, user_id: ALICE, timestamp: 1 });
    await waitFor(() => s.of("typing").length === 1); assert.deepEqual(s.of("typing")[0], { chatId: C.general, senderId: ALICE, typing: true });
    F.dispatch("TYPING_START", { channel_id: C.general, user_id: ME, timestamp: 1 }); await new Promise((r) => setTimeout(r, 80)); assert.equal(s.of("typing").length, 1, "own typing ignored");
    const m2 = F.say(C.general, ALICE, "second"); F.dispatch("MESSAGE_CREATE", m2);
    await waitFor(() => s.of("message").length === 2); assert.ok(s.of("typing").some((x: any) => x.typing === false), "typing stops when the author posts");
    chat = (await s.conn.chats()).find((c: any) => c.id === C.general); assert.equal(chat.unread, 2);
    // message in a hidden channel is not surfaced
    const hid = F.say(C.secret, ALICE, "SHOULD-NOT-SHOW"); F.dispatch("MESSAGE_CREATE", hid); await new Promise((r) => setTimeout(r, 80));
    assert.ok(!s.of("message").some((x: any) => x.text === "SHOULD-NOT-SHOW"));
    // delete
    F.dispatch("MESSAGE_DELETE", { id: m.id, channel_id: C.general });
    await waitFor(() => s.of("message-update").some((u: any) => u.patch.deleted));
    // a message in a DM we did not know yet -> channel is fetched, chats-changed, message delivered
    const nd = F.channel({ id: "200000000000099", type: 1, recipients: [F.users.get(BOB)!] });
    const dm = F.say(nd.id, BOB, "new dm"); const before = s.of("chats-changed").length; F.dispatch("MESSAGE_CREATE", dm);
    await waitFor(() => s.of("message").some((x: any) => x.text === "new dm")); await waitFor(() => s.of("chats-changed").length > before);
    assert.ok((await s.conn.chats()).some((c: any) => c.id === nd.id && c.kind === "dm" && c.name === "bob"));
    // markRead in bot mode is local only
    await s.conn.markRead(C.general, m2.id);
    assert.equal(F.acks.length, 0); assert.equal((await s.conn.chats()).find((c: any) => c.id === C.general).unread, undefined);
  } finally { await s.close(); }
});

test("channel/guild/role/thread events refresh chats and spaces; permission changes take effect", async () => {
  const s = await setup(factory);
  try {
    await s.loaded();
    const F = s.fake;
    const n0 = s.of("chats-changed").length;
    F.dispatch("CHANNEL_CREATE", { id: "200000000000050", type: 0, guild_id: G1, name: "fresh" });
    await waitFor(() => s.of("chats-changed").length > n0);
    assert.ok((await s.conn.chats()).some((c: any) => c.name === "fresh"));
    F.dispatch("CHANNEL_UPDATE", { id: "200000000000050", type: 0, guild_id: G1, name: "renamed", permission_overwrites: [{ id: G1, type: 0, allow: "0", deny: bits(PERM.VIEW) }] });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!(await s.conn.chats()).some((c: any) => c.name === "renamed"), "channel hidden by a permission overwrite");
    F.dispatch("THREAD_CREATE", { id: "200000000000060", type: 11, guild_id: G1, name: "newthread", parent_id: C.general });
    await new Promise((r) => setTimeout(r, 200)); assert.ok((await s.conn.chats()).some((c: any) => c.name === "newthread"));
    F.dispatch("THREAD_UPDATE", { id: "200000000000060", type: 11, guild_id: G1, name: "newthread", parent_id: C.general, thread_metadata: { archived: true, locked: true } });
    await new Promise((r) => setTimeout(r, 200)); assert.equal((await s.conn.chats()).find((c: any) => c.id === "200000000000060").readOnly, true, "locked thread is read-only");
    F.dispatch("GUILD_ROLE_UPDATE", { guild_id: G1, role: { id: G1, name: "@everyone", permissions: bits(PERM.VIEW, PERM.HISTORY) } });
    await new Promise((r) => setTimeout(r, 200)); assert.equal((await s.conn.chats()).find((c: any) => c.id === C.general).readOnly, true, "SEND_MESSAGES revoked -> read-only");
    F.dispatch("GUILD_MEMBER_UPDATE", { guild_id: G1, user: F.users.get(ME), roles: [], nick: null, communication_disabled_until: null });
    F.dispatch("CHANNEL_DELETE", { id: C.general, guild_id: G1, type: 0 });
    await new Promise((r) => setTimeout(r, 200)); assert.ok(!(await s.conn.chats()).some((c: any) => c.id === C.general));
    F.dispatch("GUILD_UPDATE", { id: G1, name: "Renamed Guild" });
    await new Promise((r) => setTimeout(r, 200)); assert.equal((await s.conn.spaces())[0].name, "Renamed Guild");
    F.dispatch("GUILD_DELETE", { id: G1, unavailable: true }); await new Promise((r) => setTimeout(r, 100)); assert.equal((await s.conn.spaces()).length, 1, "outage keeps the server");
    F.dispatch("GUILD_DELETE", { id: G1 }); await new Promise((r) => setTimeout(r, 200));
    assert.equal((await s.conn.spaces()).length, 0); assert.ok(!(await s.conn.chats()).some((c: any) => c.spaceId === G1));
  } finally { await s.close(); }
});

test("sending: text, reply, attachments (multipart), poll, custom emoji + @username conversion, edit, delete, reactions, typing", async () => {
  const s = await setup(factory);
  try {
    await s.loaded();
    const F = s.fake;
    const m = await s.conn.send(C.general, { text: "hello :party: @alice and @nobody and :notanemoji: @everyone" });
    assert.deepEqual([m.fromMe, m.status, m.chatId], [true, "sent", C.general]);
    let body = F.reqs(/POST \/channels\/\d+\/messages$/).pop()!.body;
    assert.equal(body.content, `hello <:party:555000000000001> <@${ALICE}> and @nobody and :notanemoji: @everyone`);
    assert.deepEqual(body.allowed_mentions, { parse: ["users"], replied_user: true }, "@everyone / roles never ping");
    await new Promise((r) => setTimeout(r, 150)); assert.ok(!s.of("message").some((x: any) => x.id === m.id), "own echo is not re-emitted");
    assert.equal((await s.conn.chats()).find((c: any) => c.id === C.general).preview, "hello :party: @Alice Wonder and @nobody and :notanemoji: @everyone");
    const hist = await s.conn.history(C.general, { limit: 5 }); assert.equal(hist.at(-1).id, m.id);
    const r = await s.conn.send(C.general, { text: "re", replyToMessageId: m.id });
    assert.deepEqual(F.reqs(/POST \/channels\/\d+\/messages$/).pop()!.body.message_reference, { message_id: m.id, fail_if_not_exists: false });
    assert.equal(r.replyTo!.messageId, m.id);
    const a = await s.conn.send(C.general, { text: "files", attachments: [{ kind: "image", mime: "image/png", name: "a.png", data: new Uint8Array(PNG) }, { kind: "file", mime: "text/plain", name: "b.txt", data: new TextEncoder().encode("hi") }] });
    body = F.reqs(/POST \/channels\/\d+\/messages$/).pop()!.body;
    assert.deepEqual(body.__files.map((f: any) => f.name), ["files[0]:a.png", "files[1]:b.txt"]); assert.deepEqual(body.attachments, [{ id: 0, filename: "a.png" }, { id: 1, filename: "b.txt" }]);
    assert.deepEqual(a.attachments!.map((x: any) => x.name), ["a.png", "b.txt"]);
    const p = await s.conn.send(C.general, { text: "", poll: { question: "Q?", options: ["x", "y"], multiple: true } });
    body = F.reqs(/POST \/channels\/\d+\/messages$/).pop()!.body; assert.equal(body.poll.question.text, "Q?"); assert.equal(body.poll.allow_multiselect, true); assert.equal(p.poll!.options.length, 2);
    await assert.rejects(s.conn.send(C.general, { text: "", poll: { question: "Q?", options: ["only"] } }), /2 to 10/);
    await assert.rejects(s.conn.send(C.general, { text: "" }), /Nothing to send/);
    // edit / delete own; not others'
    await s.conn.edit(C.general, m.id, "changed"); assert.equal(F.reqs(/PATCH /).pop()!.body.content, "changed");
    await waitFor(() => s.of("message-update").some((u: any) => u.patch.text === "changed"));
    const other = F.say(C.general, ALICE, "alice's"); await assert.rejects(s.conn.edit(C.general, other.id, "x"), /permission/);
    await assert.rejects(s.conn.delete(C.general, other.id), /permission/);
    await s.conn.delete(C.general, r.id); await waitFor(() => s.of("message-update").some((u: any) => u.messageId === r.id && u.patch.deleted));
    // blocked channel: friendly text
    F.blockedChannels.add(C.announce); await assert.rejects(s.conn.send(C.announce, { text: "x" }), /permission to send messages/);
    // reactions: unicode, custom, remove
    await s.conn.react(C.general, other.id, "👍"); await s.conn.react(C.general, other.id, ":party:");
    assert.deepEqual(F.reqs(/PUT .*reactions/).map((x) => decodeURIComponent(x.path.split("/reactions/")[1].split("/@me")[0])), ["👍", "party:555000000000001"]);
    await waitFor(() => s.of("message-update").filter((u: any) => u.messageId === other.id && u.patch.reactions).length >= 2);
    const last = s.of("message-update").filter((u: any) => u.messageId === other.id && u.patch.reactions).at(-1).patch.reactions; assert.deepEqual(last.map((x: any) => [x.emoji, !!x.mine]), [["👍", true], [":party:", true]]);
    await assert.rejects(s.conn.react(C.general, other.id, ":unknown:"), /not known/);
    await s.conn.react(C.general, other.id, null); assert.equal(F.reqs(/DELETE .*reactions/).length, 2);
    // typing is throttled
    await s.conn.setTyping(C.general, true); await s.conn.setTyping(C.general, true); await s.conn.setTyping(C.general, false);
    assert.equal(F.reqs(/POST \/channels\/\d+\/typing/).length, 1);
    // bots cannot vote; the capability is still declared for sending polls
    await assert.rejects(s.conn.vote(C.general, p.id, ["1"]), /bots/);
  } finally { await s.close(); }
});

test("startChat (id, known username, bot member search), leaveChat, leaveSpace, members()", async () => {
  const s = await setup(factory, { prep: (f) => { f.membersIntent = true; } });
  try {
    await s.loaded();
    const F = s.fake;
    const known = await s.conn.startChat("alice"); assert.equal(known.id, C.dm, "existing DM is reused; username matched from seen users");
    const byId = await s.conn.startChat(`<@${BOB}>`); assert.equal(byId.kind, "dm"); assert.equal(byId.name, "bob");
    assert.deepEqual(F.reqs(/POST \/users\/@me\/channels/).map((r) => r.body), [{ recipient_id: ALICE }, { recipient_id: BOB }]);
    await assert.rejects(s.conn.startChat("  "), /user id/);
    await assert.rejects(s.conn.startChat("zzz-nobody"), /numeric user id/);
    // members: DM, guild (REST page, filtered by VIEW_CHANNEL), secret channel
    assert.deepEqual((await s.conn.members(C.dm)).map((c: any) => c.id).sort(), [ALICE, ME].sort());
    const gm = await s.conn.members(C.general); assert.deepEqual(gm.map((c: any) => c.name).sort(), ["Ally", "Me Myself", "bob"].sort()); assert.ok(gm[0].handle!.startsWith("@"));
    assert.deepEqual((await s.conn.members(C.announce)).length, 3);
    await s.conn.leaveChat(C.dm); assert.ok(!(await s.conn.chats()).some((c: any) => c.id === C.dm));
    await assert.rejects(s.conn.leaveChat(C.general), /Leave the whole server/);
    await s.conn.leaveChat(C.thread);
    await s.conn.leaveSpace(G1); assert.equal((await s.conn.spaces()).length, 0);
  } finally { await s.close(); }
});

test("members(): bot without the Server Members intent falls back to people seen talking", async () => {
  const s = await setup(factory, { prep: (f) => { f.say(C.general, BOB, "i am here"); } });
  try {
    await s.loaded(); await s.conn.history(C.general, { limit: 5 });
    const gm = await s.conn.members(C.general);
    assert.deepEqual(gm.map((c: any) => c.id).sort(), [BOB, ME].sort());
  } finally { await s.close(); }
});

test("gateway: heartbeat with ack, RESUME after a drop, fresh IDENTIFY + historical catch-up when the session is gone", async () => {
  const s = await setup(factory);
  try {
    await s.loaded();
    const F = s.fake;
    assert.equal(F.identifies.length, 1);
    F.dropGateway(); // server closes with a resumable code
    await waitFor(() => F.resumes.length === 1, 8000, "resume"); await waitFor(() => F.sessions.size === 1);
    assert.equal(F.identifies.length, 1, "RESUME instead of a new IDENTIFY");
    assert.ok(s.ev.some((e) => e.type === "account" && e.data.state === "disconnected")); assert.equal(s.ev.filter((e) => e.type === "account").at(-1)!.data.state, "connected");
    // session lost + messages missed while away
    F.canResume = false;
    F.killGatewayHard(); await waitFor(() => F.sessions.size === 0);
    const missed = F.say(C.general, ALICE, "while you were away");
    await waitFor(() => F.identifies.length === 2, 15000, "fresh identify");
    await waitFor(() => s.of("message").some((x: any) => x.id === missed.id), 8000, "catch-up");
    const got = s.of("message").find((x: any) => x.id === missed.id); assert.equal(got.historical, true, "catch-up messages are historical (no notification)");
    assert.ok(F.resumes.length >= 2, "tried to resume first, got INVALID_SESSION");
    await waitFor(() => s.ev.filter((e) => e.type === "account").at(-1)!.data.state === "connected");
  } finally { await s.close(); }
});

test("gateway: no heartbeat ack -> reconnect; INVALID_SESSION -> re-identify", async () => {
  const s = await setup(factory, { fake: { heartbeatMs: 80, ackHeartbeats: false } });
  try {
    await waitFor(() => s.fake.identifies.length >= 1, 5000);
    await waitFor(() => s.fake.resumes.length >= 1 || s.fake.identifies.length >= 2, 15000, "zombie connection detected");
  } finally { await s.close(); }
  const t = await setup(factory, { prep: (f) => { f.invalidSessionNext = true; } });
  try { await waitFor(() => t.fake.identifies.length >= 2, 15000, "second identify after INVALID_SESSION"); await t.loaded(); } finally { await t.close(); }
});

test("gateway: zlib-stream and plain transports both work", async () => {
  for (const z of ["1", "0"]) {
    const s = await setup(factory, { env: { UNIMSG_DISCORD_ZLIB: z }, prep: (f) => { f.say(C.general, ALICE, "x".repeat(300)); } });
    try {
      await s.loaded(); const F = s.fake;
      const m = F.say(C.general, ALICE, "über ✓ " + "y".repeat(500)); F.dispatch("MESSAGE_CREATE", m);
      await waitFor(() => s.of("message").some((x: any) => x.id === m.id)); assert.equal(s.of("message").find((x: any) => x.id === m.id).text, "über ✓ " + "y".repeat(500));
    } finally { await s.close(); }
  }
});

test("gateway: disallowed Message Content intent -> falls back and tells the user; bad token -> needs-login and wipe", async () => {
  const s = await setup(factory, { fake: { contentIntent: false } });
  try {
    await waitFor(() => s.of("error").some((e: any) => e.code === "intents"), 15000, "intent notice"); await s.loaded();
    assert.equal(s.fake.identifies.length, 2); assert.ok(s.fake.identifies[0].intents! & (1 << 15)); assert.equal(s.fake.identifies[1].intents! & (1 << 15), 0);
    assert.match(s.of("error").find((e: any) => e.code === "intents").message, /Message Content intent/);
  } finally { await s.close(); }
  const t = await setup(factory, { prep: (f) => { f.token("bot-revoked", "bot", ME); }, token: "bot-revoked" });
  try {
    await t.loaded();
    t.fake.tokens.delete("bot-revoked"); t.fake.killGatewayHard();
    await waitFor(() => t.ev.some((e) => e.type === "account" && e.data.state === "needs-login"), 20000, "needs-login");
    await waitFor(() => t.of("login").length >= 1); assert.ok(!existsSync(FILE(t.dir, "discord-session.json")));
    assert.match(t.of("login").at(-1).error, /no longer accepts/);
  } finally { await t.close(); }
});

test("rest: 429 is waited out and retried; requests are serialised; 500 gives a friendly error", async () => {
  const s = await setup(factory);
  try {
    await s.loaded(); const F = s.fake;
    F.rateLimitNext = 1; const t0 = Date.now();
    const h = await s.conn.history(C.general, { limit: 5 }); assert.ok(Array.isArray(h)); assert.ok(Date.now() - t0 >= 50, "waited for retry_after");
    F.maxInflight = 0; await Promise.all([s.conn.history(C.general, { limit: 1 }), s.conn.history(C.dm, { limit: 1 }), s.conn.history(C.thread, { limit: 1 }), s.conn.avatar({ kind: "space", id: G1 })]);
    assert.equal(F.maxInflight, 1, "never parallel bursts");
    F.failNext = 1; await assert.rejects(s.conn.history(C.general, { limit: 1 }), (e: Error) => /Discord had an internal error \(HTTP 500\)/.test(e.message) && !/SECRET/.test(e.message));
    F.captchaNext = 1; await assert.rejects(s.conn.history(C.general, { limit: 1 }), (e: Error) => /asks for a captcha/.test(e.message) && !/fake|hcaptcha/.test(e.message)); // issue #69: a 400 with captcha_key is explained, not a bare "HTTP 400"
    F.blockedChannels.add(C.general);
    await assert.rejects(s.conn.history("abc", { limit: 1 }), /Unknown chat/);
  } finally { await s.close(); }
});

// ------------------------------------------------------------------------------------------------ user-token mode
const userWorld = (f: any) => {
  const o = f.say(C.dm, ALICE, "old dm"); f.say(C.dm, ALICE, "new dm"); f.unreadOverride.set(C.dm, o.id);
  f.say(C.general, BOB, "g1"); f.mentionOverride.set(C.general, 4);
  f.say(C.gdm, BOB, "group hello");
  f.say(C.general, BOB, "", { poll: { question: { text: "P?" }, answers: [{ answer_id: 1, poll_media: { text: "a" } }, { answer_id: 2, poll_media: { text: "b" } }], results: { answer_counts: [] } } });
};

test("user mode: identity, no per-server requests, DMs + group DMs, unread from read state, ack, MESSAGE_ACK, stable client identity", async () => {
  const s = await setup(factory, { mode: "user", prep: userWorld });
  try {
    await s.loaded();
    const F = s.fake;
    const id = F.identifies[0]; assert.equal(id.mode, "user"); assert.equal(id.intents, undefined, "user accounts do not send intents"); assert.ok(id.capabilities && id.hasProps);
    const chats = await s.conn.chats(); const by = (i: string) => chats.find((c: any) => c.id === i);
    assert.deepEqual([by(C.dm).kind, by(C.dm).name, by(C.dm).spaceId], ["dm", "Alice Wonder", undefined]);
    assert.deepEqual([by(C.gdm).kind, by(C.gdm).name], ["group", "Alice Wonder, bob"]);
    assert.ok(!by(C.secret), "permissions are applied from the member data in READY");
    assert.equal(by(C.dm).unread, 1); assert.equal(by(C.general).unread, 4); assert.equal(by(C.gdm).unread, undefined);
    assert.equal(F.reqs(/GET \/guilds\//).length, 0, "no per-server requests in user mode");
    assert.equal(F.reqs(/messages\?limit=1/).length, 0, "no preview prefetch in user mode");
    assert.equal(F.log.filter((r) => r.path !== "/users/@me").length, 0, "nothing but the login probe touched REST yet");
    for (const r of F.log) assert.equal(r.headers.authorization, "user-good", "user tokens are sent raw, never with a Bot prefix");
    const ident = JSON.parse(readFileSync(FILE(s.dir, "discord-identity.json"), "utf8")); assert.equal(statSync(FILE(s.dir, "discord-identity.json")).mode & 0o777, 0o600);
    const h = await s.conn.history(C.dm, { limit: 5 }); assert.equal(h.length, 2);
    const req = F.reqs(/GET \/channels\/\d+\/messages/).pop()!;
    assert.equal(req.headers["user-agent"], ident.userAgent); assert.equal(req.headers["x-super-properties"], ident.superProps); assert.match(req.headers["accept-language"], /^en-US/);
    // ack
    await s.conn.markRead(C.dm, h.at(-1).id); assert.deepEqual(F.acks, [`${C.dm}/${h.at(-1).id}`]); assert.equal(F.reqs(/ack$/).pop()!.body.token, null);
    await waitFor(() => (s.of("chats-changed").length > 0)); await s.conn.markRead(C.dm, h.at(-1).id); assert.equal(F.acks.length, 1, "nothing to ack -> no request");
    // read on another device
    F.dispatch("MESSAGE_CREATE", F.say(C.dm, ALICE, "ping")); await waitFor(() => s.of("message").length === 1);
    assert.equal((await s.conn.chats()).find((c: any) => c.id === C.dm).unread, 1);
    const n = s.of("chats-changed").length; F.dispatch("MESSAGE_ACK", { channel_id: C.dm, message_id: F.channels.get(C.dm)!.last_message_id, mention_count: 0 });
    await waitFor(() => s.of("chats-changed").length > n); assert.equal((await s.conn.chats()).find((c: any) => c.id === C.dm).unread, undefined);
    // identity survives a restart
    await s.conn.stop();
    const c2 = factory.create({ accountId: "acc", dataDir: s.dir }); const ev2: any[] = []; await c2.start((e) => ev2.push(e));
    await waitFor(() => ev2.some((e) => e.type === "account" && e.data.state === "connected"));
    await new Promise((r) => setTimeout(r, 200)); await c2.history(C.dm, { limit: 1 });
    assert.equal(F.reqs(/GET \/channels\/\d+\/messages/).pop()!.headers["user-agent"], ident.userAgent);
    await c2.stop();
  } finally { await s.close(); }
});

test("user mode: login requires YES and stores identity only after success; no member list / search / previews; vote works", async () => {
  const s = await setup(factory, { mode: "user", noSession: true, prep: userWorld });
  try {
    await waitFor(() => s.of("login").length > 0); const p = s.of("login")[0];
    await assert.rejects(s.conn.submitLogin(p.promptId, { mode: "user", token: "user-good", confirm: "NO" }), /tick the confirmation box/i);
    await assert.rejects(s.conn.submitLogin(p.promptId, { mode: "user", token: "user-bad", confirm: "YES" }), /rejected this user token/);
    assert.ok(!existsSync(FILE(s.dir, "discord-identity.json")) && !existsSync(FILE(s.dir, "discord-session.json")));
    await s.conn.submitLogin(p.promptId, { mode: "user", token: ' "user-good" ', confirm: "true" });
    await waitFor(s.connected); await s.loaded();
    assert.ok(existsSync(FILE(s.dir, "discord-identity.json")));
    const F = s.fake;
    const gm = await s.conn.members(C.general); assert.ok(gm.some((c: any) => c.id === ME));
    assert.equal(F.reqs(/GET \/guilds\//).length, 0);
    await assert.rejects(s.conn.startChat("stranger"), /numeric user id/);
    const dm = await s.conn.startChat(BOB); assert.equal(dm.kind, "dm");
    assert.equal(F.reqs(/members\/search/).length, 0, "user mode never searches members");
    const poll = (await s.conn.history(C.general, { limit: 5 })).find((m: any) => m.poll);
    await s.conn.vote(C.general, poll.id, ["2"]);
    await waitFor(() => s.of("message-update").some((u: any) => u.patch.poll));
    const up = s.of("message-update").find((u: any) => u.patch.poll).patch.poll; assert.deepEqual(up.mine, ["2"]); assert.equal(up.options[1].voters.length, 1); assert.equal(up.options[1].count, undefined, "count omitted when the voter list is complete");
  } finally { await s.close(); }
});

test("user mode: human-like pacing (>= pace, jittered, never parallel); 429 backs off and slows down; Cloudflare-style block is respected", async () => {
  const s = await setup(factory, { mode: "user", prep: userWorld, env: { UNIMSG_DISCORD_PACE_MS: "80" } });
  try {
    await s.loaded(); const F = s.fake;
    F.stamps.length = 0; F.maxInflight = 0;
    await Promise.all([s.conn.history(C.dm, { limit: 1 }), s.conn.history(C.general, { limit: 1 }), s.conn.history(C.gdm, { limit: 1 }), s.conn.history(C.thread, { limit: 1 })]);
    assert.equal(F.maxInflight, 1);
    const gaps = F.stamps.slice(1).map((t, i) => t - F.stamps[i]); assert.equal(gaps.length, 3);
    for (const g of gaps) assert.ok(g >= 75, `gap ${g}ms >= pace`);
    assert.ok(new Set(gaps).size > 1 || gaps.some((g) => g > 85), "jitter present");
    // 429 with Retry-After: waited out, retried once
    F.rateLimitNext = 1; await s.conn.history(C.dm, { limit: 1 });
    assert.ok(s.of("error").some((e: any) => e.code === "rate"), "the user is told that UniChat is slowing down");
    // after a 429 the pace is tripled for a while
    F.stamps.length = 0; await s.conn.history(C.dm, { limit: 1 }); await s.conn.history(C.dm, { limit: 1 });
    assert.ok(F.stamps[1] - F.stamps[0] >= 3 * 80 - 10, "slowed down after 429");
    // a block page (non-JSON 429): no retry storm, the call fails fast and later calls fail fast too
    F.rateLimitBody = "html"; F.rateLimitNext = 1; const before = F.log.length;
    await assert.rejects(s.conn.history(C.dm, { limit: 1 }), /rate limiting us/);
    await assert.rejects(s.conn.history(C.dm, { limit: 1 }), /pausing requests/);
    assert.equal(F.log.length - before, 1, "exactly one request reached the server while blocked");
  } finally { await s.close(); }
});

test("bot mode: 429 retries up to 3 times", async () => {
  const s = await setup(factory);
  try { await s.loaded(); s.fake.rateLimitNext = 3; const h = await s.conn.history(C.general, { limit: 1 }); assert.ok(Array.isArray(h)); } finally { await s.close(); }
});

test("structured mentions become real <@id> (users only); voice notes are Discord voice messages", async () => {
  const s = await setup(factory);
  try {
    await s.loaded(); const F = s.fake;
    const text = "hi @Alice Wonder and @bob, cc @everyone";
    await s.conn.send(C.general, { text, mentions: [{ id: ALICE, name: "Alice Wonder", start: 3, length: 13 }, { id: BOB, name: "bob", start: 21, length: 4 }, { id: "300000000000001", name: "x", start: 0, length: 2 }, { id: "nope", name: "bad", start: 3, length: 2 }] });
    const body = F.reqs(/POST \/channels\/\d+\/messages$/).pop()!.body;
    assert.equal(body.content, `hi <@${ALICE}> and <@${BOB}>, cc @everyone`);
    assert.deepEqual(body.allowed_mentions.parse, ["users"], "never roles or @everyone");
    // voice note: ogg + duration + waveform bytes + flag, no text
    const m = await s.conn.send(C.general, { text: "", attachments: [{ kind: "voice", mime: "audio/ogg", name: "v.webm", data: new Uint8Array([1, 2, 3]), durationMs: 2500, waveform: [0, 50, 100] }] });
    const vb = F.reqs(/POST \/channels\/\d+\/messages$/).pop()!.body;
    assert.equal(vb.flags, 1 << 13); assert.equal(vb.content, "");
    assert.equal(vb.attachments[0].duration_secs, 2.5); assert.equal(vb.attachments[0].filename, "voice-message.ogg");
    assert.deepEqual([...Buffer.from(vb.attachments[0].waveform, "base64")], [0, 127, 255]);
    assert.equal(vb.__files[0].type, "audio/ogg");
    assert.equal(m.attachments![0].kind, "voice", "the echo maps back to a voice note");
    // voice mixed with text is NOT a voice message (Discord forbids it): plain audio file
    await s.conn.send(C.general, { text: "listen", attachments: [{ kind: "voice", mime: "audio/ogg", data: new Uint8Array([1]), durationMs: 1000 }] });
    assert.equal(F.reqs(/POST \/channels\/\d+\/messages$/).pop()!.body.flags, undefined);
  } finally { await s.close(); }
});

test("group DMs (user mode): create, rename, add, remove; bots and server channels are refused; capabilities per mode", async () => {
  const bot = await setup(factory);
  try {
    await bot.loaded();
    assert.equal(bot.conn.capabilities.createGroup, false);
    await assert.rejects(bot.conn.createGroup("g", [ALICE]), /bots cannot/i);
    await assert.rejects(bot.conn.renameChat(C.general, "x"), /bots cannot/i);
  } finally { await bot.close(); }
  const s = await setup(factory, { mode: "user", prep: userWorld });
  try {
    await s.loaded(); const F = s.fake;
    assert.equal(s.conn.capabilities.createGroup, true); assert.equal(s.conn.capabilities.pollVote, true);
    const g = await s.conn.createGroup("Climbers", [ALICE, BOB]);
    assert.equal(g.kind, "group"); assert.equal(g.name, "Climbers");
    assert.deepEqual(F.reqs(/POST \/users\/@me\/channels/).pop()!.body.recipients, [ALICE, BOB]);
    await s.conn.renameChat(C.gdm, "New name"); assert.equal(F.reqs(/PATCH \/channels/).pop()!.body.name, "New name");
    await s.conn.removeMember(C.gdm, BOB); assert.equal(F.reqs(/DELETE \/channels\/\d+\/recipients\/\d+/).length, 1);
    await s.conn.addMembers(C.gdm, [BOB]); assert.equal(F.reqs(/PUT \/channels\/\d+\/recipients\/\d+/).length, 1);
    await assert.rejects(s.conn.renameChat(C.general, "x"), /Only group DMs/);
    await assert.rejects(s.conn.addMembers(C.dm, [BOB]), /Only group DMs/);
  } finally { await s.close(); }
});

test("presence (user mode): PRESENCE_UPDATE -> online only for DM contacts; statuses mapped; off switch; bot has none", async () => {
  const s = await setup(factory, { mode: "user", prep: userWorld });
  try {
    const F = s.fake, c: any = s.conn;
    assert.equal(c.capabilities.presence, true);
    await waitFor(() => (c.channels?.size ?? 0) > 0, 3000, "channels");
    F.dispatch("PRESENCE_UPDATE", { user: { id: ALICE }, status: "idle", guild_id: G1 });
    await waitFor(() => s.of("presence").length === 1);
    assert.deepEqual(s.of("presence")[0], { accountId: c.accountId, chatId: C.dm, contactId: ALICE, online: true });
    F.dispatch("PRESENCE_UPDATE", { user: { id: ALICE }, status: "offline" });
    await waitFor(() => s.of("presence").length === 2); assert.equal(s.of("presence")[1].online, false);
    F.dispatch("PRESENCE_UPDATE", { user: { id: BOB }, status: "online" }); await new Promise((r) => setTimeout(r, 80));
    assert.equal(s.of("presence").length, 2, "someone without a DM with us is ignored");
    c.setPresenceEnabled(false); F.dispatch("PRESENCE_UPDATE", { user: { id: ALICE }, status: "online" }); await new Promise((r) => setTimeout(r, 80));
    assert.equal(s.of("presence").length, 2, "privacy switch off: nothing is reported");
  } finally { await s.close(); }
  const b = await setup(factory);
  try { assert.ok(!(b.conn as any).capabilities.presence, "a bot gets no presence"); } finally { await b.close(); }
});
