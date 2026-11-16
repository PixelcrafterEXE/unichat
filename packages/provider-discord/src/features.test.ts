// Offline tests for the management features: channel topic, group icon, profile, block, privacy, create/join server, scheduled events. Fake Discord only.
import test from "node:test";
import assert from "node:assert/strict";
import factory from "./index.js";
import { C, ME, ALICE, G1, setup, waitFor } from "./helpers.js";

const MINE = "100000000000009", MC = "200000000000099";
/** A second server that ME owns (full permissions) with one text channel. */
const prep = (f: any) => {
  f.guild(MINE, "My Server", ME); f.member(MINE, ME); f.channel({ id: MC, type: 0, guild_id: MINE, name: "lobby", topic: "old" });
  f.invites.set("abc123", "100000000000777"); f.user("1000000000000077", "carol");
  const g = f.guild("100000000000777", "Invited Guild", "1000000000000077"); f.member(g.id, "1000000000000077");
};
const png = { data: new Uint8Array([137, 80, 78, 71]), mime: "image/png" };

test("capabilities per mode for the management features", async () => {
  const b = await setup(factory), u = await setup(factory, { mode: "user" });
  try {
    await b.loaded(); await u.loaded();
    const bc = b.conn.capabilities, uc = u.conn.capabilities;
    assert.ok(bc.chatDescription && bc.events && bc.eventEdit && bc.profile.displayName && bc.profile.avatar && !bc.profile.about);
    assert.ok(!bc.block && !bc.privacy && !bc.chatPicture && !bc.createSpace && !bc.joinSpace);
    assert.ok(uc.chatPicture && uc.block && uc.privacy && uc.createSpace && uc.joinSpace && uc.profile.about && uc.chatDescription);
    for (const m of ["setChatDescription", "setChatPicture", "blockChat", "getPrivacy", "setPrivacy", "createSpace", "joinSpace", "getProfile", "updateProfile", "editEvent"]) assert.equal(typeof u.conn[m], "function", m);
  } finally { await b.close(); await u.close(); }
});

test("channel topic: needs Manage Channels (canManage), refuses DMs, threads and group DMs, clears with empty text", async () => {
  const s = await setup(factory, { prep });
  try {
    await s.loaded(); const F = s.fake;
    const chats = await s.conn.chats(); const by = (i: string) => chats.find((c: any) => c.id === i);
    assert.equal(by(MC)?.canManage, true, "owner of a server may manage its channels");
    assert.equal(by(C.general)?.canManage, false, "ordinary member may not");
    await s.conn.setChatDescription(MC, "  Welcome!  ");
    assert.equal(F.reqs(/PATCH \/channels\/\d+$/).pop()!.body.topic, "Welcome!"); assert.equal(F.channels.get(MC)!.topic, "Welcome!");
    await s.conn.setChatDescription(MC, ""); assert.equal(F.reqs(/PATCH \/channels\/\d+$/).pop()!.body.topic, null);
    F.blockedChannels.add("manage:" + C.general);
    await assert.rejects(s.conn.setChatDescription(C.general, "x"), /permission/);
    await assert.rejects(s.conn.setChatDescription(C.thread, "x"), /Threads/);
    await assert.rejects(s.conn.setChatDescription("999", "x"), /Unknown chat/);
  } finally { await s.close(); }
});

test("user mode: group icon, rename of a managed server channel; bots are refused", async () => {
  const bot = await setup(factory);
  try { await bot.loaded(); await assert.rejects(bot.conn.setChatPicture(C.gdm, png), /bots cannot/i); } finally { await bot.close(); }
  const s = await setup(factory, { mode: "user", prep });
  try {
    await s.loaded(); const F = s.fake;
    await s.conn.setChatPicture(C.gdm, png);
    assert.equal(F.reqs(/PATCH \/channels\/\d+$/).pop()!.body.icon, "data:image/png;base64," + Buffer.from(png.data).toString("base64"));
    await s.conn.setChatPicture(C.gdm, null); assert.equal(F.reqs(/PATCH \/channels\/\d+$/).pop()!.body.icon, null);
    await assert.rejects(s.conn.setChatPicture(C.gdm, { data: png.data, mime: "application/pdf" }), /PNG/);
    await assert.rejects(s.conn.setChatPicture(C.general, png), /Only group DMs/);
    await assert.rejects(s.conn.setChatDescription(C.dm, "x"), /no description/);
    await assert.rejects(s.conn.setChatDescription(C.gdm, "x"), /no description/);
    await s.conn.renameChat(MC, "front-desk"); assert.equal(F.channels.get(MC)!.name, "front-desk");
  } finally { await s.close(); }
});

test("own profile: bot (name + avatar), user (name + about + avatar), limits and refusals", async () => {
  const bot = await setup(factory);
  try {
    await bot.loaded(); const F = bot.fake;
    const p = await bot.conn.getProfile(); assert.equal(p.displayName, "Me Myself"); assert.equal(p.handle, "@meuser"); assert.equal(F.reqs(/\/profile/).length, 0, "bots never ask for a bio");
    await bot.conn.updateProfile({ displayName: "NewBot" });
    assert.deepEqual(F.reqs(/PATCH \/users\/@me$/).pop()!.body, { username: "NewBot" });
    await bot.conn.updateProfile({ avatar: png }); assert.match(F.reqs(/PATCH \/users\/@me$/).pop()!.body.avatar, /^data:image\/png;base64,/);
    await assert.rejects(bot.conn.updateProfile({ about: "hi" }), /no 'about me'/);
    await assert.rejects(bot.conn.updateProfile({ displayName: "x".repeat(33) }), /32/);
    await assert.rejects(bot.conn.updateProfile({ displayName: " " }), /Enter a name/);
  } finally { await bot.close(); }
  const s = await setup(factory, { mode: "user" });
  try {
    await s.loaded(); const F = s.fake;
    const out = await s.conn.updateProfile({ displayName: "Mia", about: "Climber" });
    assert.deepEqual(F.reqs(/PATCH \/users\/@me$/).pop()!.body, { global_name: "Mia" });
    assert.deepEqual(F.reqs(/PATCH \/users\/@me\/profile$/).pop()!.body, { bio: "Climber" });
    assert.equal(out.displayName, "Mia"); assert.equal(out.about, "Climber");
    await s.conn.updateProfile({ avatar: null }); assert.equal(F.reqs(/PATCH \/users\/@me$/).pop()!.body.avatar, null);
  } finally { await s.close(); }
});

test("block / unblock a person from a DM (user mode only)", async () => {
  const bot = await setup(factory);
  try { await bot.loaded(); await assert.rejects(bot.conn.blockChat(C.dm, true), /bots cannot/i); } finally { await bot.close(); }
  const s = await setup(factory, { mode: "user" });
  try {
    await s.loaded(); const F = s.fake;
    await s.conn.blockChat(C.dm, true);
    assert.deepEqual([F.reqs(/relationships/).pop()!.method, F.reqs(/relationships/).pop()!.path, F.reqs(/relationships/).pop()!.body], ["PUT", `/users/@me/relationships/${ALICE}`, { type: 2 }]);
    assert.equal(F.relationships.get(ALICE), 2);
    await s.conn.blockChat(C.dm, false); assert.equal(F.relationships.has(ALICE), false);
    await assert.rejects(s.conn.blockChat(C.gdm, true), /Only a direct message/);
    await assert.rejects(s.conn.blockChat(C.general, true), /Only a direct message/);
  } finally { await s.close(); }
});

test("privacy settings: read, change each one, reject unknown values; bots refused", async () => {
  const bot = await setup(factory);
  try { await bot.loaded(); await assert.rejects(bot.conn.getPrivacy(), /user accounts/); } finally { await bot.close(); }
  const s = await setup(factory, { mode: "user" });
  try {
    await s.loaded(); const F = s.fake;
    let l = await s.conn.getPrivacy();
    assert.deepEqual(l.map((x: any) => [x.id, x.value]), [["dm_new_servers", "allow"], ["friend_requests", "everyone"], ["explicit_filter", "1"]]);
    l = await s.conn.setPrivacy("dm_new_servers", "deny"); assert.equal(F.settings.default_guilds_restricted, true); assert.equal(l[0].value, "deny");
    l = await s.conn.setPrivacy("friend_requests", "both"); assert.deepEqual(F.settings.friend_source_flags, { all: false, mutual_friends: true, mutual_guilds: true }); assert.equal(l[1].value, "both");
    l = await s.conn.setPrivacy("friend_requests", "nobody"); assert.equal(l[1].value, "nobody");
    l = await s.conn.setPrivacy("explicit_filter", "2"); assert.equal(F.settings.explicit_content_filter, 2); assert.equal(l[2].value, "2");
    await assert.rejects(s.conn.setPrivacy("nope", "x"), /Unknown privacy/); await assert.rejects(s.conn.setPrivacy("explicit_filter", "9"), /Unknown privacy/);
  } finally { await s.close(); }
});

test("create a server and join one by invite link or code (user mode); bad invites and bots refused", async () => {
  const bot = await setup(factory, { prep });
  try { await bot.loaded(); await assert.rejects(bot.conn.createSpace("x1"), /bots cannot/i); await assert.rejects(bot.conn.joinSpace("abc123"), /bot cannot join/i); } finally { await bot.close(); }
  const s = await setup(factory, { mode: "user", prep });
  try {
    await s.loaded(); const F = s.fake;
    await assert.rejects(s.conn.createSpace("x"), /2 to 100/);
    const sp = await s.conn.createSpace("  Climbing  "); assert.equal(sp.name, "Climbing"); assert.equal(F.reqs(/POST \/guilds$/).pop()!.body.name, "Climbing");
    assert.ok((await s.conn.spaces()).some((x: any) => x.id === sp.id));
    for (const inv of ["https://discord.gg/abc123", "discord.com/invite/abc123?event=1", "abc123"]) {
      const j = await s.conn.joinSpace(inv); assert.equal(j.name, "Invited Guild");
    }
    assert.equal(F.reqs(/POST \/invites\/abc123$/).length, 3);
    await assert.rejects(s.conn.joinSpace("https://example.org/x"), /not a Discord invite/);
    await assert.rejects(s.conn.joinSpace("nosuchcode"), /no longer exists/);
    assert.ok(s.of("spaces-changed").length >= 2);
  } finally { await s.close(); }
});

test("events: create a scheduled event in a server channel (card + link), edit, cancel; DMs and missing rights refused", async () => {
  const s = await setup(factory, { prep });
  try {
    await s.loaded(); const F = s.fake;
    assert.ok(s.conn.capabilities.events && s.conn.capabilities.eventEdit);
    const m = await s.conn.send(MC, { text: "Join us", event: { name: "Boulder night", description: "bring chalk", start: "2030-01-02T18:00:00Z", place: "Gym" } });
    const b = F.reqs(/POST \/guilds\/\d+\/scheduled-events$/).pop()!.body;
    assert.deepEqual([b.name, b.entity_type, b.privacy_level, b.scheduled_start_time, b.scheduled_end_time, b.entity_metadata], ["Boulder night", 3, 2, "2030-01-02T18:00:00.000Z", "2030-01-02T19:00:00.000Z", { location: "Gym" }]);
    const ev = [...F.events.values()][0];
    assert.equal(m.card.kind, "event"); assert.equal(m.card.place, "Gym"); assert.equal(m.card.editable, true);
    assert.equal(m.card.url, `https://discord.com/events/${MINE}/${ev.id}`); assert.match(m.text, new RegExp("Join us\\nhttps://discord.com/events/"));
    await s.conn.editEvent(MC, m.id, { name: "Late boulder night", place: "Hall", end: "2030-01-02T21:00:00Z" });
    assert.deepEqual([ev.name, ev.entity_metadata, ev.scheduled_end_time], ["Late boulder night", { location: "Hall" }, "2030-01-02T21:00:00.000Z"]);
    await waitFor(() => s.of("message-update").some((u: any) => u.patch.card?.title === "Late boulder night"));
    await s.conn.editEvent(MC, m.id, { canceled: true }); assert.equal(ev.status, 4);
    await waitFor(() => s.of("message-update").some((u: any) => u.patch.card?.canceled));
    const plain = await s.conn.send(MC, { text: "no event" });
    await assert.rejects(s.conn.editEvent(MC, plain.id, { name: "x" }), /does not hold/);
    await assert.rejects(s.conn.send(C.dm, { text: "", event: { name: "x", start: "2030-01-02T18:00:00Z" } }), /belong to a server/);
    await assert.rejects(s.conn.send(MC, { text: "", event: { name: "x", start: "garbage" } }), /not valid|end must/);
    await assert.rejects(s.conn.send(MC, { text: "", event: { name: "x", start: "2030-01-02T18:00:00Z", end: "2030-01-02T17:00:00Z" } }), /end must be after/);
    F.blockedChannels.add("events:" + MINE);
    await assert.rejects(s.conn.send(MC, { text: "", event: { name: "x", start: "2030-01-02T18:00:00Z" } }), /permission/);
  } finally { await s.close(); }
});

test("link previews: Discord unfurls links itself, the embed arrives as an update and becomes a link card", async () => {
  const s = await setup(factory);
  try {
    await s.loaded(); const F = s.fake;
    const m = await s.conn.send(C.general, { text: "see https://example.org/page" });
    assert.equal(F.reqs(/POST \/channels\/\d+\/messages$/).pop()!.body.content, "see https://example.org/page", "the link is sent as it is: no client-side preview needed");
    const raw = F.messages.get(C.general)!.find((x: any) => x.id === m.id)!;
    raw.embeds = [{ type: "link", url: "https://example.org/page", title: "Example page", description: "An example" }];
    F.dispatch("MESSAGE_UPDATE", { id: m.id, channel_id: C.general, embeds: raw.embeds });
    await waitFor(() => s.of("message-update").some((u: any) => u.patch.cards?.[0]?.title === "Example page"));
    assert.equal(s.of("message-update").find((u: any) => u.patch.cards)!.patch.cards[0].kind, "link");
  } finally { await s.close(); }
});

test("mutualSpaces: the servers you share with a person (user accounts only, from the profile's mutual servers)", async () => {
  const g2 = "100000000000555", g3 = "100000000000556";
  const prep2 = (f: any) => { f.guild(g2, "Only Bob", ME); f.member(g2, ME); f.member(g2, "1000000000000002"); f.guild(g3, "Alice and me", ALICE); f.member(g3, ALICE); f.member(g3, ME); };
  const u = await setup(factory, { mode: "user", prep: prep2 }), b = await setup(factory, { prep: prep2 });
  try {
    await u.loaded(); await b.loaded();
    assert.deepEqual((await u.conn.mutualSpaces(ALICE)).sort(), [G1, g3].sort());
    assert.deepEqual((await u.conn.mutualSpaces("1000000000000002")).sort(), [G1, g2].sort());
    assert.equal(u.fake.reqs(/GET \/users\/\d+\/profile/).length, 2, "one profile request per person; the bot made none");
    assert.deepEqual(await b.conn.mutualSpaces(ALICE), [], "a bot cannot see profiles: nothing, no request");
    assert.deepEqual(await u.conn.mutualSpaces("not-an-id"), []);
  } finally { await u.close(); await b.close(); }
});
void G1;
