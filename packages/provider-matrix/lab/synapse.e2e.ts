// End-to-end suite: the REAL Matrix connector against a throwaway Synapse on 127.0.0.1. Run via `pnpm test:synapse` (lab/run.sh).
// Each test is a step; later steps depend on fixtures from earlier ones, so run the whole file.
import test from "node:test";
import assert from "node:assert/strict";
import { statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Actor, HS, DOMAIN, PASS, PNG, sleep, uid, until } from "./harness.js";
import type { Message } from "@unimsg/core";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";

const alice = new Actor("alice"), bob = new Actor("bob"), carol = new Actor("carol");
const S: Record<string, any> = {};
const text = (a: Actor, chatId: string, body: string, from = 0) => a.of("message", (m) => m.chatId === chatId && m.text === body, from)[0] as Message | undefined;
const hist = (a: Actor, chatId: string, limit = 50) => a.conn.history(chatId, { limit });

test("login: failure messages", async () => {
  const a = new Actor("loginfail", "lab-loginfail");
  await a.boot();
  const p = await until(() => a.prompt, "prompt");
  const tryLogin = async (v: Record<string, string>) => { try { await a.conn.submitLogin(p.promptId, v); return "OK"; } catch (e) { return (e as Error).message; } };
  assert.equal(await tryLogin({ homeserver: HS, username: "alice", password: "wrong" }), "Invalid username or password.");
  assert.equal(await tryLogin({ homeserver: HS, username: "nobody-here", password: "x" }), "Invalid username or password.");
  assert.match(await tryLogin({ homeserver: HS, username: "alice", password: "" }), /both username and password|SSO/);
  assert.match(await tryLogin({ homeserver: "", username: "alice", password: "x" }), /Homeserver is required/);
  assert.match(await tryLogin({ homeserver: "http://127.0.0.1:9", username: "alice", password: "x" }), /server unreachable/);
  assert.match(await tryLogin({ homeserver: HS, username: "", password: "" }), /does not offer SSO/);
  await a.stop(); a.cleanup();
});

test("login: password login for alice, bob, carol (localpart and full mxid)", async () => {
  await alice.login();
  await bob.login(PASS("bob"), uid("bob"));
  await carol.login();
  for (const a of [alice, bob, carol]) {
    assert.equal(a.state, "connected");
    const f = join(a.dir, "matrix-session.json");
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(f, "utf8")).userId, a.userId);
    assert.ok(!a.of("error").length, JSON.stringify(a.of("error")));
  }
  assert.equal(alice.of("login").length, 1);
});

test("fixtures: bob's encrypted group, alice<->bob encrypted DM, plain room, alice DM with carol", async () => {
  const grp = await bob.conn.createGroup!("Lab Group", [uid("alice"), uid("carol")]);
  assert.equal(grp.kind, "group"); assert.equal(grp.name, "Lab Group"); S.grp = grp.id;
  await alice.joinRaw(S.grp); await carol.joinRaw(S.grp);
  const dm = await alice.conn.startChat!(uid("bob"));
  assert.equal(dm.kind, "dm"); S.dm = dm.id;
  await bob.joinRaw(S.dm);
  // bob needs m.direct for his own DM view
  await bob.sdk.setAccountData("m.direct", { [uid("alice")]: [S.dm] });
  // startChat again returns the same room
  assert.equal((await alice.conn.startChat!(uid("bob"))).id, S.dm);
  const dmc = await carol.conn.startChat!(uid("alice")); S.dmc = dmc.id;
  await alice.joinRaw(S.dmc);
  await alice.sdk.setAccountData("m.direct", { [uid("bob")]: [S.dm], [uid("carol")]: [S.dmc] });
  // unencrypted room created with the raw SDK (the provider always creates encrypted rooms)
  const plain = await alice.sdk.createRoom({ name: "Plain Room", topic: "no e2ee here", invite: [uid("bob")], preset: "private_chat" });
  S.plain = plain.room_id; await bob.joinRaw(S.plain);
  assert.equal(alice.sdk.isRoomEncrypted(S.plain), false);
  assert.equal(alice.sdk.isRoomEncrypted(S.grp), true);
  assert.equal(alice.sdk.isRoomEncrypted(S.dm), true);
});

test("send/receive text: encrypted DM, encrypted group, plain room", async () => {
  for (const [room, label] of [[S.dm, "dm"], [S.grp, "grp"], [S.plain, "plain"]] as const) {
    const m0 = bob.mark();
    const sent = await alice.conn.send(room, { text: `hello ${label} from alice` });
    assert.equal(sent.fromMe, true); assert.equal(sent.status, "sent"); assert.equal(sent.text, `hello ${label} from alice`);
    const got = await until(() => text(bob, room, `hello ${label} from alice`, m0), `bob receives ${label}`);
    assert.equal(got.id, sent.id); assert.equal(got.senderId, uid("alice")); assert.equal(got.fromMe, false);
  }
  // reverse direction in the encrypted DM, and alice must not get an echo of her own message as a new message
  const a0 = alice.mark();
  const s = await bob.conn.send(S.dm, { text: "reply from bob" });
  await until(() => text(alice, S.dm, "reply from bob", a0), "alice receives bob");
  assert.ok(!alice.of("message", (m) => m.text.startsWith("hello"), a0).length, "no echo of own sends");
  S.bobMsg = s.id;
});

test("chats(): names, kinds, unread, preview, readOnly; spaces()", async () => {
  const chats = await alice.conn.chats();
  const byId = new Map(chats.map((c) => [c.id, c]));
  assert.equal(byId.get(S.dm)!.kind, "dm"); assert.equal(byId.get(S.dm)!.name, "bob");
  assert.equal(byId.get(S.dmc)!.kind, "dm");
  assert.equal(byId.get(S.grp)!.kind, "group"); assert.equal(byId.get(S.grp)!.name, "Lab Group");
  assert.equal(byId.get(S.plain)!.name, "Plain Room"); assert.equal(byId.get(S.plain)!.description, "no e2ee here");
  assert.equal(byId.get(S.plain)!.readOnly, false);
  assert.ok(byId.get(S.dm)!.lastMessageAt);
  assert.equal((await alice.conn.spaces()).length, 0);
});

test("unread counts + initial sync after provider restart (persisted session), markRead", async () => {
  const m0 = bob.mark();
  await bob.conn.send(S.plain, { text: "unread one" }); await bob.conn.send(S.plain, { text: "unread two" });
  await alice.conn.stop();
  const last = await bob.conn.send(S.plain, { text: "unread three" });
  await sleep(1600); // the connector classifies events by server time relative to its start (+-0.5 s): keep the backlog clearly older
  await alice.boot(); await alice.ready();
  assert.equal(alice.of("login").length, 0, "no login prompt with stored session");
  const chat = await until(async () => { const c = (await alice.conn.chats()).find((x) => x.id === S.plain); return c && (c.unread ?? 0) >= 3 ? c : undefined; }, "unread >= 3");
  assert.equal(chat.unread, 3);
  assert.equal(chat.preview, "unread three");
  assert.deepEqual(alice.of("message", (m) => m.chatId === S.plain).map((m) => m.text), [], "backlog from initial sync is not emitted as live messages");
  const c0 = alice.mark();
  await alice.conn.markRead!(S.plain, last.id);
  await until(async () => (await alice.conn.chats()).find((x) => x.id === S.plain)!.unread === 0, "unread cleared by markRead");
  await until(() => bob.of("receipt", (r) => r.chatId === S.plain && r.messageId === last.id && (r.by ?? r.byId) === uid("alice"), m0)[0], "bob sees alice's read receipt");
  await until(() => alice.of("chats-changed", () => true, c0).length > 0, "chats-changed");
});

test("history: paging backwards, order, beforeMessageId", async () => {
  for (let i = 1; i <= 25; i++) await bob.conn.send(S.plain, { text: `h${String(i).padStart(2, "0")}` });
  const p1 = await hist(alice, S.plain, 10);
  assert.deepEqual(p1.map((m) => m.text), Array.from({ length: 10 }, (_, i) => `h${i + 16}`));
  const p2 = await alice.conn.history(S.plain, { limit: 10, beforeMessageId: p1[0].id });
  assert.deepEqual(p2.map((m) => m.text), Array.from({ length: 10 }, (_, i) => `h${String(i + 6).padStart(2, "0")}`));
  const all: string[] = []; let before: string | undefined;
  for (let i = 0; i < 20; i++) { const p = await alice.conn.history(S.plain, { limit: 7, beforeMessageId: before }); if (!p.length) break; all.unshift(...p.map((m) => m.text)); before = p[0].id; }
  assert.equal(all.length, new Set(all).size, "no duplicates across pages");
  assert.ok(all.includes("h01") && all.includes("unread one"));
  assert.deepEqual(all.filter((t) => /^h\d\d$/.test(t)), Array.from({ length: 25 }, (_, i) => `h${String(i + 1).padStart(2, "0")}`));
  // encrypted room history is decrypted
  const gh = await hist(alice, S.grp);
  assert.ok(gh.some((m) => m.text === "hello grp from alice"));
  assert.ok(!gh.some((m) => m.text.includes("Encrypted")));
});

test("replies, edits, deletes", async () => {
  for (const room of [S.dm, S.plain]) {
    const m0 = bob.mark();
    const orig = await alice.conn.send(room, { text: "original" });
    const got = await until(() => text(bob, room, "original", m0), "bob got original");
    const rep = await bob.conn.send(room, { text: "a reply", replyToMessageId: got.id });
    assert.equal(rep.replyTo?.messageId, got.id);
    const rm = await until(() => text(alice, room, "a reply"), "alice got reply");
    assert.equal(rm.replyTo?.messageId, orig.id); assert.equal(rm.replyTo?.textPreview, "original");
    await alice.conn.edit!(room, orig.id, "edited text");
    await until(() => bob.of("message-update", (u) => u.messageId === orig.id && u.patch.text === "edited text", m0)[0], "bob sees edit");
    const h = (await hist(bob, room)).find((m) => m.id === orig.id)!;
    assert.equal(h.text, "edited text"); assert.ok(h.editedAt);
    await assert.rejects(bob.conn.edit!(room, orig.id, "hijack"), /own messages/);
    await alice.conn.delete!(room, orig.id);
    await until(() => bob.of("message-update", (u) => u.messageId === orig.id && u.patch.deleted, m0)[0], `bob sees deletion in ${room === S.dm ? "encrypted dm" : "plain"}`);
    const h2 = (await hist(bob, room)).find((m) => m.id === orig.id);
    assert.ok(!h2 || h2.deleted, "deleted message shows as deleted in history");
  }
});

test("reactions: add, change, remove", async () => {
  const m0 = bob.mark(), a0 = alice.mark();
  const msg = await alice.conn.send(S.dm, { text: "react to me" });
  await until(() => text(bob, S.dm, "react to me", m0), "bob got it");
  await bob.conn.react!(S.dm, msg.id, "👍");
  const u1 = await until(() => alice.of("message-update", (u) => u.messageId === msg.id && u.patch.reactions?.length, a0).pop(), "alice sees reaction");
  assert.deepEqual(u1.patch.reactions.map((r: any) => [r.emoji, r.senderIds]), [["👍", [uid("bob")]]]);
  await alice.conn.react!(S.dm, msg.id, "👍");
  await until(() => { const l = alice.of("message-update", (u) => u.messageId === msg.id && u.patch.reactions, a0).pop(); return l?.patch.reactions[0]?.mine && l.patch.reactions[0].senderIds.length === 2; }, "both reacted");
  assert.equal((await hist(alice, S.dm)).find((m) => m.id === msg.id)!.reactions![0].senderIds.length, 2);
  await bob.conn.react!(S.dm, msg.id, "❤️");
  await bob.conn.react!(S.dm, msg.id, null);
  await until(() => { const l = alice.of("message-update", (u) => u.messageId === msg.id && u.patch.reactions, a0).pop(); return l && l.patch.reactions.length === 1 && l.patch.reactions[0].senderIds.join() === uid("alice"); }, "bob's reactions removed");
  const r = (await hist(bob, S.dm)).find((m) => m.id === msg.id)!.reactions!;
  assert.deepEqual(r.map((x) => [x.emoji, x.senderIds]), [["👍", [uid("alice")]]]);
});

test("typing + receipts between providers", async () => {
  const b0 = bob.mark();
  await alice.conn.setTyping!(S.dm, true);
  await until(() => bob.of("typing", (t) => t.chatId === S.dm && t.senderId === uid("alice") && t.typing, b0)[0], "bob sees typing");
  await alice.conn.setTyping!(S.dm, false);
  await until(() => bob.of("typing", (t) => t.chatId === S.dm && !t.typing, b0)[0], "typing stops");
  // typing privacy off -> nothing sent
  await alice.conn.setPrivacy!("typing", "off");
  const b1 = bob.mark();
  await alice.conn.setTyping!(S.dm, true); await sleep(1500);
  assert.equal(bob.of("typing", (t) => t.typing, b1).length, 0);
  await alice.conn.setPrivacy!("typing", "on");
  // read receipts: public -> visible, private -> invisible to bob but unread cleared
  const m = await bob.conn.send(S.dm, { text: "please read" });
  await until(() => text(alice, S.dm, "please read"), "alice got it");
  const b2 = bob.mark();
  await alice.conn.setPrivacy!("readReceipts", "private");
  await alice.conn.markRead!(S.dm, m.id);
  await until(async () => (await alice.conn.chats()).find((c) => c.id === S.dm)!.unread === 0, "private receipt clears unread");
  await sleep(1000);
  assert.equal(bob.of("receipt", (r) => r.messageId === m.id && (r.by ?? r.byId) === uid("alice"), b2).length, 0, "private receipt not visible");
  await alice.conn.setPrivacy!("readReceipts", "public");
  const m2 = await bob.conn.send(S.dm, { text: "please read 2" });
  await until(() => text(alice, S.dm, "please read 2"), "alice got 2");
  await alice.conn.markRead!(S.dm, m2.id);
  await until(() => bob.of("receipt", (r) => r.messageId === m2.id && (r.by ?? r.byId) === uid("alice"), b2)[0], "public receipt visible");
});

const bytesEq = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const rnd = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);

test("attachments: image, file, voice (waveform + duration) round trip, plain and encrypted", async () => {
  const wave = Array.from({ length: 64 }, (_, i) => Math.round(50 + 50 * Math.sin(i / 5)));
  for (const room of [S.plain, S.dm, S.grp]) {
    const m0 = bob.mark(), a0 = alice.mark();
    const enc = alice.sdk.isRoomEncrypted(room);
    const file = rnd(5000);
    await alice.conn.send(room, { text: "see image", attachments: [{ kind: "image", mime: "image/png", name: "pic.png", data: PNG }] });
    await alice.conn.send(room, { text: "", attachments: [{ kind: "file", mime: "application/pdf", name: "doc.pdf", data: file }] });
    await alice.conn.send(room, { text: "", attachments: [{ kind: "voice", mime: "audio/ogg", name: "voice.ogg", data: rnd(3000), durationMs: 4200, waveform: wave }] });
    const img = await until(() => bob.of("message", (m) => m.chatId === room && m.attachments?.[0]?.kind === "image", m0)[0], `image in ${room}`);
    assert.equal(img.text, "see image"); assert.equal(img.attachments[0].mime, "image/png");
    const dl = await bob.conn.downloadAttachment(room, img.id, img.attachments[0].id);
    assert.ok(bytesEq(dl.data, PNG), `image bytes equal (encrypted=${enc})`); assert.equal(dl.mime, "image/png");
    const f = await until(() => bob.of("message", (m) => m.chatId === room && m.attachments?.[0]?.kind === "file", m0)[0], "file");
    assert.equal(f.attachments[0].name, "doc.pdf"); assert.equal(f.attachments[0].size, 5000);
    const fd = await bob.conn.downloadAttachment(room, f.id, f.attachments[0].id);
    assert.ok(bytesEq(fd.data, file)); assert.equal(fd.name, "doc.pdf");
    const v = await until(() => bob.of("message", (m) => m.chatId === room && m.attachments?.[0]?.kind === "voice", m0)[0], "voice");
    assert.equal(v.attachments[0].durationMs, 4200);
    assert.equal(v.attachments[0].waveform?.length, 64);
    assert.ok(Math.abs(v.attachments[0].waveform[10] - wave[10]) <= 1, `waveform preserved ${v.attachments[0].waveform[10]} vs ${wave[10]}`);
    assert.ok(bytesEq((await bob.conn.downloadAttachment(room, v.id, v.attachments[0].id)).data, rnd(3000)));
    // history path (not only live), and the sender's own copy
    const h = (await hist(bob, room)).find((m) => m.id === v.id)!;
    assert.equal(h.attachments![0].kind, "voice"); assert.equal(h.attachments![0].durationMs, 4200);
    const own = (await hist(alice, room)).find((m) => m.id === img.id)!;
    assert.ok(bytesEq((await alice.conn.downloadAttachment(room, own.id, own.attachments![0].id)).data, PNG));
    void a0;
  }
  // reverse: bob -> alice in the encrypted DM, and the raw event of an encrypted room carries no plaintext url
  const a1 = alice.mark();
  await bob.conn.send(S.dm, { text: "", attachments: [{ kind: "image", mime: "image/png", name: "b.png", data: PNG }] });
  const m = await until(() => alice.of("message", (x) => x.chatId === S.dm && x.attachments?.[0]?.kind === "image", a1)[0], "alice gets image");
  assert.ok(bytesEq((await alice.conn.downloadAttachment(S.dm, m.id, m.attachments[0].id)).data, PNG));
  const ev = await alice.sdk.fetchRoomEvent(S.dm, m.id); assert.equal(ev.type, "m.room.encrypted");
});

test("location", async () => {
  const b0 = bob.mark();
  await alice.conn.send(S.dm, { text: "", location: { lat: 52.52, lng: 13.405, name: "Berlin" } });
  const m = await until(() => bob.of("message", (x) => x.chatId === S.dm && x.location, b0)[0], "location");
  assert.ok(Math.abs(m.location.lat - 52.52) < 1e-6 && Math.abs(m.location.lng - 13.405) < 1e-6);
  const h = (await hist(bob, S.dm)).find((x) => x.id === m.id)!; assert.ok(h.location);
});

test("polls: start, vote from bob and alice, end (MSC3381 stable events)", async () => {
  const a0 = alice.mark(), b0 = bob.mark(), c0 = carol.mark();
  const p = await alice.conn.send(S.grp, { text: "", poll: { question: "Lunch?", options: ["Pizza", "Sushi", "Soup"], multiple: false } });
  assert.equal(p.poll!.question, "Lunch?");
  const raw = await alice.sdk.fetchRoomEvent(S.grp, p.id); assert.equal(raw.type, "m.room.encrypted");
  const bp = await until(() => bob.of("message", (m) => m.poll && m.chatId === S.grp, b0)[0], "bob gets poll");
  assert.deepEqual(bp.poll.options.map((o: any) => o.text), ["Pizza", "Sushi", "Soup"]);
  await until(() => carol.of("message", (m) => m.poll, c0)[0], "carol gets poll");
  const [oA, oB] = bp.poll.options.map((o: any) => o.id);
  await bob.conn.vote!(S.grp, p.id, [oB]);
  await until(() => alice.of("message-update", (u) => u.messageId === p.id && u.patch.poll?.options.find((o: any) => o.id === oB)?.voters.includes(uid("bob")), a0).pop(), "alice sees bob's vote");
  await assert.rejects(bob.conn.vote!(S.grp, p.id, [oA, oB]), /at most 1/);
  await alice.conn.vote!(S.grp, p.id, [oA]);
  const mine = await until(() => alice.of("message-update", (u) => u.messageId === p.id && u.patch.poll?.mine?.includes(oA), a0).pop(), "alice own vote");
  assert.deepEqual(mine.patch.poll.options.map((o: any) => o.voters.length), [1, 1, 0]);
  await alice.conn.vote!(S.grp, p.id, [oB]); // change vote
  await until(() => { const l = alice.of("message-update", (u) => u.messageId === p.id && u.patch.poll, a0).pop(); return l && l.patch.poll.options.map((o: any) => o.voters.length).join() === "0,2,0"; }, "changed vote");
  // history tally
  const hp = (await hist(carol, S.grp)).find((m) => m.id === p.id)!;
  assert.deepEqual(hp.poll!.options.map((o) => o.voters.length), [0, 2, 0]);
  // end (no Connector method: the ending is done by another client, here bob's SDK)
  await bob.sdk.sendEvent(S.grp, "m.poll.end", { "m.poll.end": {}, "m.text": "ended", "m.relates_to": { rel_type: "m.reference", event_id: p.id } });
  await until(() => alice.of("message-update", (u) => u.messageId === p.id && u.patch.poll?.closed, a0)[0], "alice sees poll closed");
  await assert.rejects(alice.conn.vote!(S.grp, p.id, [oA]), /ended/);
  assert.equal((await hist(alice, S.grp)).find((m) => m.id === p.id)!.poll!.closed, true);
  // unencrypted poll too
  const q = await alice.conn.send(S.plain, { text: "", poll: { question: "Plain?", options: ["a", "b"], multiple: true } });
  const bq = await until(() => bob.of("message", (m) => m.id === q.id)[0], "plain poll");
  await bob.conn.vote!(S.plain, q.id, bq.poll.options.map((o: any) => o.id));
  await until(() => alice.of("message-update", (u) => u.messageId === q.id && u.patch.poll?.options.every((o: any) => o.voters.includes(uid("bob"))))[0], "multi vote");
});

test("spaces: create, add rooms, invite+join, chats' spaceId, leave", async () => {
  const sp = await alice.conn.createSpace!("Lab Space", "a space");
  assert.equal(sp.name, "Lab Space"); S.space = sp.id;
  assert.ok((await alice.conn.spaces()).some((s) => s.id === sp.id));
  assert.ok(!(await alice.conn.chats()).some((c) => c.id === sp.id), "space is not a chat");
  const a0 = alice.mark();
  await alice.sdk.sendStateEvent(sp.id, "m.space.child", { via: [DOMAIN] }, S.plain);
  await alice.sdk.sendStateEvent(sp.id, "m.space.child", { via: [DOMAIN] }, S.grp);
  await until(async () => (await alice.conn.chats()).find((c) => c.id === S.plain)?.spaceId === sp.id, "plain room in space");
  const ch = (await alice.conn.chats()).find((c) => c.id === S.plain)!; assert.equal(ch.kind, "channel");
  assert.ok(alice.of("spaces-changed", () => true, a0).length > 0);
  await alice.sdk.invite(sp.id, uid("bob"));
  await assert.rejects(carol.conn.joinSpace!(sp.id), /Not allowed/);
  await assert.rejects(carol.conn.joinSpace!("!nonexistent:" + DOMAIN), /not found|Not allowed|Could not/i);
  await assert.rejects(bob.conn.joinSpace!(S.plain), /room, not a space/);
  assert.ok((await bob.conn.chats()).some((c) => c.id === S.plain), "a room the user was already in stays joined after a refused joinSpace");
  const j = await bob.conn.joinSpace!(`https://matrix.to/#/${encodeURIComponent(sp.id)}?via=${DOMAIN}`);
  assert.equal(j.id, sp.id); assert.equal(j.name, "Lab Space");
  assert.ok((await bob.conn.spaces()).some((s) => s.id === sp.id));
  assert.equal((await bob.conn.chats()).find((c) => c.id === S.plain)!.spaceId, sp.id);
  await bob.conn.leaveSpace!(sp.id);
  await until(async () => !(await bob.conn.spaces()).some((s) => s.id === sp.id), "bob left space");
  const bc = (await bob.conn.chats()).find((c) => c.id === S.plain)!; assert.ok(bc, "child room stays joined"); assert.equal(bc.spaceId, undefined);
  assert.equal(alice.sdk.getRoom(sp.id)?.getMyMembership(), "join");
  const sp2 = await alice.conn.createSpace!("Temp", undefined); await alice.conn.leaveSpace!(sp2.id);
  await until(async () => !(await alice.conn.spaces()).some((s) => s.id === sp2.id), "alice left temp space");
});

test("groups: createGroup, add/remove members, rename, picture, leave", async () => {
  const g = await alice.conn.createGroup!("Mgmt", [uid("bob")]); S.mgmt = g.id;
  assert.equal(g.name, "Mgmt"); assert.equal(g.kind, "group");
  await bob.joinRaw(g.id);
  await assert.rejects(alice.conn.createGroup!("x", ["notanid"]));
  await alice.conn.addMembers!(g.id, ["carol"]); // bare localpart expands to the own server
  await carol.joinRaw(g.id);
  await until(async () => (await alice.conn.members(g.id)).length === 3, "3 members");
  assert.deepEqual((await bob.conn.members(g.id)).map((m) => m.id).sort(), [uid("alice"), uid("bob"), uid("carol")]);
  const c0 = carol.mark();
  await alice.conn.renameChat!(g.id, "  Renamed  ");
  await until(async () => (await carol.conn.chats()).find((c) => c.id === g.id)?.name === "Renamed", "carol sees rename");
  await assert.rejects(alice.conn.renameChat!(g.id, "  "));
  const a0t = alice.mark();
  await alice.conn.setChatDescription!(g.id, "  The topic  ");
  await until(async () => (await bob.conn.chats()).find((c) => c.id === g.id)?.description === "The topic", "bob sees the new description");
  await until(() => alice.of("chats-changed", (d) => d.chatId === g.id, a0t)[0], "own chats-changed after topic change");
  assert.equal((await alice.conn.chats()).find((c) => c.id === g.id)!.description, "The topic");
  await alice.conn.setChatDescription!(g.id, "");
  await until(async () => !(await bob.conn.chats()).find((c) => c.id === g.id)?.description, "description cleared");
  await alice.conn.setChatPicture!(g.id, { data: PNG, mime: "image/png" });
  await until(async () => (await carol.conn.chats()).find((c) => c.id === g.id)?.avatarUrl?.startsWith("data:image/png"), "carol sees room picture");
  const av = await carol.conn.avatar!({ kind: "chat", id: g.id }); assert.ok(av && av.mime.startsWith("image/"));
  assert.ok((await alice.conn.chats()).find((c) => c.id === g.id)!.avatarUrl);
  await alice.conn.setChatPicture!(g.id, null);
  await until(async () => !(await carol.conn.chats()).find((c) => c.id === g.id)?.avatarUrl, "picture removed");
  // new members cannot read before-join history, but get new messages in the encrypted group
  const b0 = bob.mark();
  await carol.conn.send(g.id, { text: "carol says hi" });
  await until(() => text(bob, g.id, "carol says hi", b0), "bob gets carol's message in group");
  await alice.conn.removeMember!(g.id, uid("bob"));
  await until(async () => !(await bob.conn.chats()).some((c) => c.id === g.id), "bob no longer lists the room");
  await until(async () => (await alice.conn.members(g.id)).length === 2, "2 members");
  await alice.conn.send(g.id, { text: "after kick" });
  await carol.conn.leaveChat!(g.id);
  await until(async () => !(await carol.conn.chats()).some((c) => c.id === g.id), "carol left");
  void c0;
});

test("block (ignore list), unblock", async () => {
  await alice.conn.blockChat!(S.dmc, true);
  assert.ok(alice.sdk.getIgnoredUsers().includes(uid("carol")));
  assert.equal((await alice.conn.chats()).find((c) => c.id === S.dmc)!.blocked, true);
  const a0 = alice.mark();
  await carol.conn.send(S.dmc, { text: "can you hear me" });
  await sleep(2000);
  assert.ok(!text(alice, S.dmc, "can you hear me", a0), "server hides ignored user's messages");
  await assert.rejects(alice.conn.blockChat!(S.grp, true), /1:1/);
  await alice.conn.blockChat!(S.dmc, false);
  await until(async () => !(await alice.conn.chats()).find((c) => c.id === S.dmc)!.blocked, "unblocked");
  assert.ok(!alice.sdk.getIgnoredUsers().includes(uid("carol")));
  const a1 = alice.mark();
  await carol.conn.send(S.dmc, { text: "now you can" });
  await until(() => text(alice, S.dmc, "now you can", a1), "message after unblock");
});

test("profile: display name + avatar, avatars of contacts and DMs, privacy account data", async () => {
  const p0 = await alice.conn.getProfile!(); assert.equal(p0.handle, uid("alice"));
  const p1 = await alice.conn.updateProfile!({ displayName: " Alice Lab ", avatar: { data: PNG, mime: "image/png" } });
  assert.equal(p1.displayName, "Alice Lab"); assert.ok(p1.avatar && p1.avatar.mime.startsWith("image/"));
  await assert.rejects(alice.conn.updateProfile!({ displayName: " " }));
  await assert.rejects(alice.conn.updateProfile!({ about: "x" }), /about/);
  const av = await bob.conn.avatar!({ kind: "contact", id: uid("alice") }); assert.ok(av, "bob can fetch alice's avatar");
  const b0 = bob.mark();
  await alice.conn.send(S.dm, { text: "named now" });
  const m = await until(() => text(bob, S.dm, "named now", b0), "bob gets it");
  await until(async () => (await hist(bob, S.dm, 5)).find((x) => x.id === m.id)?.sender === "Alice Lab", "display name propagates");
  await until(async () => !!(await bob.conn.chats()).find((c) => c.id === S.dm)?.avatarUrl, "DM shows peer avatar");
  assert.ok(await bob.conn.avatar!({ kind: "chat", id: S.dm }));
  assert.equal(await bob.conn.avatar!({ kind: "contact", id: "garbage" }), undefined);
  const p2 = await alice.conn.updateProfile!({ avatar: null }); assert.equal(p2.avatar, undefined);
  // privacy persists in account data and survives a restart
  await alice.conn.setPrivacy!("readReceipts", "private"); await alice.conn.setPrivacy!("typing", "off");
  const ad = await alice.sdk.http.authedRequest("GET", `/user/${encodeURIComponent(uid("alice"))}/account_data/org.unimsg.privacy`);
  assert.deepEqual(ad, { read_receipts: "private", typing: false });
  await alice.restart();
  assert.deepEqual((await alice.conn.getPrivacy!()).slice(0, 2).map((s) => s.value), ["private", "off"]);
  await sleep(1000); // events in the first ~0.5 s after a start count as backlog
  await alice.conn.setPrivacy!("readReceipts", "public"); await alice.conn.setPrivacy!("typing", "on");
  await alice.conn.updateProfile!({ displayName: "alice" });
});

test("E2EE: unverified devices do not block, no key backup needed, crypto store survives restart", async () => {
  const crypto = alice.sdk.getCrypto();
  assert.equal(await crypto.getActiveSessionBackupVersion(), null);
  const dev = await crypto.getUserDeviceInfo([uid("bob")]);
  const bobDevs = [...dev.get(uid("bob"))!.values()]; assert.ok(bobDevs.length >= 1);
  assert.ok(bobDevs.every((d: any) => !d.verified), "devices are unverified and messages still flow");
  const deviceId = alice.sdk.getDeviceId();
  const b0 = bob.mark(); const pre = await bob.conn.send(S.dm, { text: "before alice restart" });
  await until(() => text(alice, S.dm, "before alice restart"), "alice decrypts");
  await alice.conn.stop();
  const post = await bob.conn.send(S.dm, { text: "while alice is down" });
  await sleep(1600);
  await alice.boot(); await alice.ready(); await sleep(1000); // events in the first ~0.5 s after start count as backlog
  assert.equal(alice.sdk.getDeviceId(), deviceId, "same device after restart");
  const a0 = alice.mark();
  const post2 = await bob.conn.send(S.dm, { text: "after alice restart" });
  const got = await until(() => text(alice, S.dm, "after alice restart", a0), "alice decrypts new message after restart").catch((e) => { throw new Error(e.message + " | alice saw: " + JSON.stringify(alice.of("message", () => true, a0).map((m) => m.text)) + " errors: " + JSON.stringify(alice.of("error"))); });
  assert.equal(got.id, post2.id); assert.ok(!got.text.includes("Encrypted"));
  const h = await hist(alice, S.dm, 10);
  for (const [id, t] of [[pre.id, "before alice restart"], [post.id, "while alice is down"], [post2.id, "after alice restart"]]) assert.equal(h.find((m) => m.id === id)?.text, t);
  // alice sends from the restored crypto store; bob can read it
  const s = await alice.conn.send(S.dm, { text: "alice after restart" });
  await until(() => text(bob, S.dm, "alice after restart", b0), "bob reads alice's post-restart message");
  assert.ok(existsSync(join(alice.dir, "matrix-crypto.bin")));
  assert.equal(statSync(join(alice.dir, "matrix-crypto.bin")).mode & 0o777, 0o600);
  void s;
});

test("invites: requests, accept (room, DM, space), decline, reply accepts", async () => {
  // room invite
  const a0 = alice.mark();
  const g = await bob.conn.createGroup!("Invite Room", [uid("alice")]);
  const req = await until(async () => (await alice.conn.chats()).find((c) => c.id === g.id), "alice sees the invitation");
  assert.equal(req.request, true); assert.equal(req.kind, "group"); assert.equal(req.name, "Invite Room");
  await until(() => alice.of("chats-changed", () => true, a0)[0], "chats-changed for the invite");
  assert.deepEqual(await alice.conn.history(g.id, { limit: 10 }), []);
  assert.deepEqual((await alice.conn.members(g.id)).map((m) => m.id), [uid("bob")]);
  const a1 = alice.mark();
  await alice.conn.acceptRequest!(g.id);
  const joined = (await alice.conn.chats()).find((c) => c.id === g.id)!;
  assert.equal(joined.request, undefined); assert.equal(alice.sdk.getRoom(g.id).getMyMembership(), "join");
  await bob.conn.send(g.id, { text: "welcome alice" });
  await until(() => text(alice, g.id, "welcome alice", a1), "alice decrypts after accepting");
  await assert.rejects(alice.conn.acceptRequest!(g.id), /no longer pending/);
  // DM invite: carol gets a direct request from bob
  const dm = await bob.conn.startChat!(uid("carol"));
  const dreq = await until(async () => (await carol.conn.chats()).find((c) => c.id === dm.id), "carol sees the DM invitation");
  assert.deepEqual([dreq.request, dreq.kind], [true, "dm"]);
  assert.match(dreq.name, /bob/i);
  const c1 = carol.mark();
  await carol.conn.acceptRequest!(dm.id);
  const dacc = (await carol.conn.chats()).find((c) => c.id === dm.id)!;
  assert.deepEqual([dacc.request, dacc.kind], [undefined, "dm"]);
  assert.ok(carol.sdk.getAccountData("m.direct").getContent()[uid("bob")].includes(dm.id), "m.direct updated like Element does");
  await bob.conn.send(dm.id, { text: "dm accepted" });
  await until(() => text(carol, dm.id, "dm accepted", c1), "carol decrypts the DM");
  // replying to a request accepts it
  const g2 = await bob.conn.createGroup!("Reply Accepts", [uid("carol")]);
  await until(async () => (await carol.conn.chats()).find((c) => c.id === g2.id)?.request, "second invitation");
  const b1 = bob.mark();
  await carol.conn.send(g2.id, { text: "joined by replying" });
  await until(() => text(bob, g2.id, "joined by replying", b1), "bob receives the reply");
  assert.equal((await carol.conn.chats()).find((c) => c.id === g2.id)!.request, undefined);
  // decline
  const g3 = await bob.conn.createGroup!("Declined", [uid("alice")]);
  await until(async () => (await alice.conn.chats()).find((c) => c.id === g3.id)?.request, "third invitation");
  await alice.conn.declineRequest!(g3.id);
  assert.ok(!(await alice.conn.chats()).some((c) => c.id === g3.id));
  await until(() => bob.sdk.getRoom(g3.id).getMember(uid("alice"))?.membership === "leave", "bob sees the rejection");
  // space invitation
  const sp = await bob.conn.createSpace!("Bob Space");
  await bob.sdk.invite(sp.id, uid("alice"));
  const sreq = await until(async () => (await alice.conn.chats()).find((c) => c.id === sp.id), "alice sees the space invitation");
  assert.equal(sreq.request, true); assert.equal(sreq.name, "Bob Space");
  assert.ok(!(await alice.conn.spaces()).some((x) => x.id === sp.id));
  await alice.conn.acceptRequest!(sp.id);
  assert.ok((await alice.conn.spaces()).some((x) => x.id === sp.id), "accepted space listed in spaces()");
  assert.ok(!(await alice.conn.chats()).some((c) => c.id === sp.id), "and no longer as a chat");
  await alice.conn.leaveSpace!(sp.id);
  // an invitation that was withdrawn
  const g4 = await bob.conn.createGroup!("Withdrawn", [uid("alice")]);
  await until(async () => (await alice.conn.chats()).find((c) => c.id === g4.id)?.request, "fourth invitation");
  await bob.sdk.kick(g4.id, uid("alice"));
  await until(async () => !(await alice.conn.chats()).some((c) => c.id === g4.id), "withdrawn invite disappears");
});

test("mentions, formatted bodies, link previews", async () => {
  const b0 = bob.mark();
  const m = await alice.conn.send(S.grp, { text: "hey @Bob and @carol, <ok> & done", mentions: [{ id: uid("bob"), name: "bob", start: 4, length: 4 }, { id: uid("carol"), name: "carol", start: 13, length: 6 }] });
  const got = await until(() => bob.of("message", (x) => x.id === m.id, b0)[0], "bob receives the mention");
  assert.equal(got.text, "hey @Bob and @carol, <ok> & done");
  const ev = bob.sdk.getRoom(S.grp).findEventById(m.id);
  assert.deepEqual(ev.getContent()["m.mentions"], { user_ids: [uid("bob"), uid("carol")] });
  assert.match(ev.getContent().formatted_body, /<a href="https:\/\/matrix\.to\/#\/%40bob%3Alab\.test">@Bob<\/a>/);
  assert.equal(ev.getContent().body, "hey @Bob and @carol, <ok> & done");
  assert.equal((await hist(carol, S.grp)).find((x) => x.id === m.id)!.text, "hey @Bob and @carol, <ok> & done");
  // plain text stays plain
  const p = await alice.conn.send(S.grp, { text: "no *markdown* here <b>" });
  const pev = alice.sdk.getRoom(S.grp).findEventById(p.id).getContent();
  assert.deepEqual(Object.keys(pev).sort(), ["body", "msgtype"]);
  // incoming rich bodies as Element would send them
  const html = '<mx-reply><blockquote><a href="https://matrix.to/#/!r">In reply to</a> old</blockquote></mx-reply><strong>bold</strong> <em>it</em> <code>c</code><ul><li>one</li><li>two</li></ul><blockquote>q</blockquote><a href="https://example.org/">link</a> <span data-mx-spoiler="">hidden</span> <a href="https://matrix.to/#/@alice:lab.test">alice</a>';
  const a0 = alice.mark();
  const rid = (await bob.sdk.sendMessage(S.grp, { msgtype: "m.text", body: "fallback body", format: "org.matrix.custom.html", formatted_body: html })).event_id;
  const rich = await until(() => alice.of("message", (x) => x.id === rid, a0)[0], "alice receives the html message");
  assert.equal(rich.text, "**bold** *it* `c`\n- one\n- two\n> q\nlink (https://example.org/) ||hidden|| @alice");
  assert.equal((await hist(alice, S.grp)).find((x) => x.id === rid)!.text, rich.text);
  // link preview supplied by the sender (never fetched by us)
  const lid = (await bob.sdk.sendMessage(S.grp, { msgtype: "m.text", body: "see https://example.org/page", "com.beeper.linkpreviews": [{ matched_url: "https://example.org/page", "og:title": "A page", "og:description": "About it" }] })).event_id;
  const lp = await until(() => alice.of("message", (x) => x.id === lid, a0)[0], "alice receives the preview message");
  assert.deepEqual(lp.card, { kind: "link", title: "A page", body: "About it", url: "https://example.org/page" });
  assert.equal(lp.text, "see https://example.org/page");
});

test("threads: m.thread <-> replyTo with thread hint", async () => {
  const a0 = alice.mark(), b0 = bob.mark();
  const root = (await bob.sdk.sendMessage(S.plain, { msgtype: "m.text", body: "thread root" })).event_id;
  await until(() => alice.of("message", (x) => x.id === root, a0)[0], "root");
  const tr = (await bob.sdk.sendMessage(S.plain, { msgtype: "m.text", body: "in the thread", "m.relates_to": { rel_type: "m.thread", event_id: root, "m.in_reply_to": { event_id: root }, is_falling_back: true } })).event_id;
  const got = await until(() => alice.of("message", (x) => x.id === tr, a0)[0], "thread reply arrives as a flat message");
  assert.equal(got.replyTo.messageId, root); assert.equal(got.replyTo.thread, true); assert.equal(got.replyTo.textPreview, "thread root");
  assert.equal(((await hist(alice, S.plain)).find((x) => x.id === tr)!.replyTo as any).thread, true);
  // alice answers the thread message: stays in the thread on the wire
  const ans = await alice.conn.send(S.plain, { text: "answer in thread", replyToMessageId: tr });
  const wire = await alice.sdk.fetchRoomEvent(S.plain, ans.id);
  assert.deepEqual(wire.content["m.relates_to"], { rel_type: "m.thread", event_id: root, is_falling_back: false, "m.in_reply_to": { event_id: tr } });
  const seen = await until(() => bob.of("message", (x) => x.id === ans.id, b0)[0], "bob sees it");
  assert.equal(seen.replyTo.messageId, tr); assert.equal(seen.replyTo.thread, true);
  // a reply to an ordinary message is an ordinary reply
  const o = await alice.conn.send(S.plain, { text: "ordinary reply", replyToMessageId: (await alice.conn.send(S.plain, { text: "ordinary base" })).id });
  assert.equal((await alice.sdk.fetchRoomEvent(S.plain, o.id)).content["m.relates_to"]["rel_type"], undefined);
});

test("key backup: restore with recovery key at login and from settings; secret storage key and passphrase; verification state", async () => {
  const crypto = alice.sdk.getCrypto();
  const adminToken = alice.sdk.getAccessToken();
  const backupCount = async () => (await (await fetch(`${HS}/_matrix/client/v3/room_keys/version`, { headers: { authorization: `Bearer ${adminToken}` } })).json() as any).count as number;
  // device 1 creates a backup, then history is created that only device 1 can read
  assert.equal(await crypto.getKeyBackupInfo(), null, "no backup yet");
  assert.equal((await alice.conn.getPrivacy!()).find((x) => x.id === "keyBackup")!.value, "none");
  await crypto.resetKeyBackup();
  const rec = encodeRecoveryKey(await crypto.getSessionBackupPrivateKey() as Uint8Array)!;
  assert.equal((await alice.conn.getPrivacy!()).find((x) => x.id === "keyBackup")!.value, "restored");
  const g = await bob.conn.createGroup!("Old Secrets", [uid("alice")]); S.old = g.id;
  await until(async () => (await alice.conn.chats()).find((c) => c.id === g.id)?.request, "invite");
  await alice.conn.acceptRequest!(g.id);
  await bob.conn.send(g.id, { text: "secret before device 2" });
  await until(async () => (await hist(alice, g.id)).some((m) => m.text === "secret before device 2"), "device 1 reads it");
  await alice.conn.send(g.id, { text: "alice's own secret" });
  await until(async () => (await backupCount()) >= 2, "megolm sessions uploaded to the backup", 60000);

  // device 2: logs in WITHOUT a key: history stays unreadable, settings entry offers the restore
  const d2 = new Actor("alice", "lab-alice-d2");
  await d2.login();
  await until(async () => (await d2.conn.chats()).some((c) => c.id === g.id), "d2 sees the room");
  assert.ok((await hist(d2, g.id)).every((m) => m.text !== "secret before device 2"));
  const st = (await d2.conn.getPrivacy!()).find((x) => x.id === "keyBackup")!;
  assert.equal(st.value, "available"); assert.ok(st.options.some((o) => o.value === "restore"));
  const p0 = d2.mark();
  await d2.conn.setPrivacy!("keyBackup", "restore");
  const prompt = (await until(() => d2.of("login", () => true, p0).pop(), "restore prompt")) as any;
  assert.equal(prompt.kind, "form"); assert.equal(prompt.fields[0].name, "recoverykey");
  const wrong = encodeRecoveryKey(Uint8Array.from({ length: 32 }, (_, i) => i))!;
  await assert.rejects(d2.conn.submitLogin(prompt.promptId, { recoverykey: wrong }), /does not match/);
  await assert.rejects(d2.conn.submitLogin(prompt.promptId, { recoverykey: "not a key" }), /does not match/);
  await d2.conn.submitLogin(prompt.promptId, { recoverykey: rec.replace(/(.{4})/g, "$1 ") }); // spaces are fine
  await until(async () => { const h = await hist(d2, g.id); return h.some((m) => m.text === "secret before device 2") && h.some((m) => m.text === "alice's own secret"); }, "device 2 reads old history after restore");
  assert.equal((await d2.conn.getPrivacy!()).find((x) => x.id === "keyBackup")!.value, "restored");
  await assert.rejects(d2.conn.setPrivacy!("keyBackup", "restored"), /cannot be changed/);
  assert.equal((await d2.conn.getPrivacy!()).find((x) => x.id === "deviceVerification")!.value, "unverified");
  await d2.stop(); d2.cleanup();

  // device 3: key typed on the login form; restore runs after the first sync; wrong key -> connected + error event
  const d3b = new Actor("alice", "lab-alice-d3b");
  await d3b.boot(); const pr = await until(() => d3b.prompt, "prompt");
  await d3b.conn.submitLogin(pr.promptId, { homeserver: HS, username: "alice", password: PASS("alice"), recoverykey: wrong });
  await d3b.ready();
  await until(() => d3b.of("error", (e) => e.code === "backup-restore-failed")[0], "error event for a wrong key");
  assert.equal(d3b.state, "connected");
  await d3b.stop(); d3b.cleanup();
  const d4 = new Actor("alice", "lab-alice-d4");
  await d4.boot(); const pr4 = await until(() => d4.prompt, "prompt");
  await d4.conn.submitLogin(pr4.promptId, { homeserver: HS, username: "alice", password: PASS("alice"), recoverykey: rec });
  await d4.ready();
  await until(async () => (await hist(d4, g.id)).some((m) => m.text === "secret before device 2"), "login-time recovery key restores old history", 60000);
  assert.ok(!d4.of("error", (e) => e.code === "backup-restore-failed").length);
  // the restored backup key survives a restart of that device
  await d4.restart();
  await until(async () => (await hist(d4, g.id)).some((m) => m.text === "secret before device 2"), "still readable after restart");
  assert.equal((await d4.conn.getPrivacy!()).find((x) => x.id === "keyBackup")!.value, "restored");
  await d4.stop(); d4.cleanup();

  // secret storage (Element's "security key" + passphrase): cross-signing + 4S + a new backup; device 1 becomes verified
  await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: async (make: any) => { await make({ type: "m.login.password", identifier: { type: "m.id.user", user: "alice" }, password: PASS("alice") }); } });
  let ssKey: string | undefined;
  await crypto.bootstrapSecretStorage({
    createSecretStorageKey: async () => { const k = await crypto.createRecoveryKeyFromPassphrase("lab pass phrase"); ssKey = k.encodedPrivateKey; (alice.conn as any).ssKey = k.privateKey; return k; },
    setupNewSecretStorage: true, setupNewKeyBackup: true,
  });
  (alice.conn as any).ssKey = undefined;
  assert.ok(ssKey);
  await until(async () => (await alice.conn.getPrivacy!()).find((x) => x.id === "deviceVerification")!.value === "verified", "device 1 verified by cross-signing");
  await until(async () => (await backupCount()) >= 2, "sessions re-uploaded to the new backup version", 60000);
  for (const [label, secret] of [["security key", ssKey!], ["passphrase", "lab pass phrase"]] as const) {
    const d = new Actor("alice", `lab-alice-ss-${label.replace(" ", "")}`);
    await d.boot(); const pp = await until(() => d.prompt, "prompt");
    await d.conn.submitLogin(pp.promptId, { homeserver: HS, username: "alice", password: PASS("alice"), recoverykey: secret });
    await d.ready();
    await until(async () => (await hist(d, g.id)).some((m) => m.text === "secret before device 2"), `restore with the secret storage ${label}`, 60000);
    assert.ok(!d.of("error", (e) => e.code === "backup-restore-failed").length, JSON.stringify(d.of("error")));
    await d.stop(); d.cleanup();
  }
});

test("reconnect after the homeserver restarts", async () => {
  const lab = join(import.meta.dirname, "synapse-lab.sh");
  const env = { ...process.env };
  const a0 = alice.mark();
  execFileSync(lab, ["restart"], { env, stdio: "pipe", timeout: 120000 });
  // the SDK notices the dead long-poll / refused connections and reconnects by itself
  await until(() => alice.of("account", (a) => a.state === "connected", a0).length > 0 && alice.state === "connected", "alice connected again", 90000);
  const states = alice.of("account", () => true, a0).map((a) => a.state);
  assert.ok(!states.includes("needs-login"), "a restart is not a logout: " + states.join());
  const b0 = bob.mark(); const a1 = alice.mark();
  await until(() => bob.state === "connected", "bob connected", 90000);
  await alice.conn.send(S.dm, { text: "after server restart" });
  await until(() => text(bob, S.dm, "after server restart", b0), "bob receives after restart", 30000);
  await bob.conn.send(S.dm, { text: "and back" });
  await until(() => text(alice, S.dm, "and back", a1), "alice receives after restart", 30000);
});

test("session revoked elsewhere -> needs-login + new login prompt, session wiped", async () => {
  const c2 = new Actor("carol", "lab-carol-2");
  await c2.login();
  const tok = JSON.parse(readFileSync(join(c2.dir, "matrix-session.json"), "utf8")).accessToken;
  const p0 = c2.mark();
  const r = await fetch(`${HS}/_matrix/client/v3/logout`, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: "{}" });
  assert.equal(r.status, 200);
  await until(() => c2.state === "needs-login", "needs-login after revoked token", 60000);
  const pr = await until(() => c2.of("login", () => true, p0).pop(), "new login prompt");
  assert.match(pr.error ?? "", /expired or revoked/);
  assert.ok(!existsSync(join(c2.dir, "matrix-session.json")));
  assert.ok(!existsSync(join(c2.dir, "matrix-crypto.bin")));
  await c2.stop(); c2.cleanup();
});

test("logout: local wipe + server-side device removal", async () => {
  const c3 = new Actor("carol", "lab-carol-3");
  await c3.login();
  const sess = JSON.parse(readFileSync(join(c3.dir, "matrix-session.json"), "utf8"));
  const who = await fetch(`${HS}/_matrix/client/v3/account/whoami`, { headers: { authorization: `Bearer ${sess.accessToken}` } });
  assert.equal(who.status, 200);
  await c3.conn.logout();
  assert.ok(!existsSync(join(c3.dir, "matrix-session.json"))); assert.ok(!existsSync(join(c3.dir, "matrix-crypto.bin")));
  assert.equal(c3.state, "needs-login");
  const after = await fetch(`${HS}/_matrix/client/v3/account/whoami`, { headers: { authorization: `Bearer ${sess.accessToken}` } });
  assert.equal(after.status, 401, "access token is dead on the server");
  // the device is gone from carol's device list
  const login = await (await fetch(`${HS}/_matrix/client/v3/login`, { method: "POST", body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: "carol" }, password: PASS("carol") }) })).json() as any;
  const devs = await (await fetch(`${HS}/_matrix/client/v3/devices`, { headers: { authorization: `Bearer ${login.access_token}` } })).json() as any;
  assert.ok(!devs.devices.some((d: any) => d.device_id === sess.deviceId), "logged-out device removed server-side");
  await fetch(`${HS}/_matrix/client/v3/logout`, { method: "POST", headers: { authorization: `Bearer ${login.access_token}` }, body: "{}" });
  // logging in again with the same account id in the same process (Hub: remove + re-add, or logout + login) works with a fresh device
  await c3.boot();
  const pr3 = await until(() => c3.prompt, "login prompt after logout");
  await c3.conn.submitLogin(pr3.promptId, { homeserver: HS, username: "carol", password: PASS("carol") });
  await c3.ready();
  assert.notEqual(JSON.parse(readFileSync(join(c3.dir, "matrix-session.json"), "utf8")).deviceId, sess.deviceId);
  const a9 = alice.mark();
  await c3.conn.send(S.dmc, { text: "carol again" });
  await until(() => text(alice, S.dmc, "carol again", a9), "alice decrypts a message from the re-logged-in carol");
  await c3.conn.logout();
  // logout against an unreachable server: local wipe still happens, error tells the user what to do
  const c4 = new Actor("carol", "lab-carol-4");
  await c4.login();
  const sess4 = JSON.parse(readFileSync(join(c4.dir, "matrix-session.json"), "utf8"));
  writeFileSync(join(c4.dir, "matrix-session.json"), JSON.stringify({ ...sess4, baseUrl: "http://127.0.0.1:9" })); // simulate unreachable
  (c4.conn as any).session = { ...sess4, baseUrl: "http://127.0.0.1:9" };
  c4.sdk.baseUrl = "http://127.0.0.1:9"; c4.sdk.http.opts.baseUrl = "http://127.0.0.1:9"; c4.sdk.http.opts.prefix; 
  await assert.rejects(c4.conn.logout(), /Remove it manually/);
  assert.ok(!existsSync(join(c4.dir, "matrix-session.json")), "wiped even though the server was unreachable");
  await fetch(`${HS}/_matrix/client/v3/logout/all`, { method: "POST", headers: { authorization: `Bearer ${sess4.accessToken}` }, body: "{}" }); // tidy the server side
});

test.after(async () => { for (const a of [alice, bob, carol]) { await a.stop(); a.cleanup(); } });
