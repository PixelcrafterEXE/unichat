import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import factory, { CAPABILITIES } from "./index.js";
import { endpoint } from "./config.js";
import { openIncoming } from "./csp.js";
import { Ty, hexId, quoteText, textBody } from "./e2e.js";
import { newPeer } from "./fake/servers.js";
import { decode } from "./proto.js";
import { secretbox, secretboxOpen } from "./nacl.js";
import { Envelope } from "./schemas.js";
import { linked, tmp, wait, waitFor, world, type World } from "./helpers.js";

const b8 = (i: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(i); return b; };
const envelopes = (w: World) => w.be.reflectedLog.map((r) => decode(Envelope, secretboxOpen(r.env.subarray(24), r.env.subarray(0, 24), w.phone.keys.dgrk)!));

test("provider info + truthful capabilities", () => {
  assert.equal(factory.name, "threema-md"); assert.equal(factory.displayName, "Threema"); assert.equal(factory.login, "qr");
  assert.equal(CAPABILITIES.createGroup, true); assert.equal(CAPABILITIES.backfill, false); assert.equal(CAPABILITIES.e2ee, true);
});

test("endpoint override is loopback only", () => {
  process.env.UNIMSG_THREEMA_MD_MEDIATOR = "wss://evil.example.org/"; assert.equal(endpoint("UNIMSG_THREEMA_MD_MEDIATOR", "wss://real/"), "wss://real/");
  process.env.UNIMSG_THREEMA_MD_MEDIATOR = "ws://127.0.0.1:9"; assert.equal(endpoint("UNIMSG_THREEMA_MD_MEDIATOR", "wss://real/"), "ws://127.0.0.1:9/");
});

test("login: consent required, QR, same emoji, join, session sealed 0600, slot registered, import", async () => {
  const w = await world(); w.phone.addContact("ALICE001", { first: "Alice", last: "W", avatar: new Uint8Array([0xff, 0xd8, 1, 2, 3]), lastAt: 5000 });
  w.phone.addContact("BOBBOB02", { nick: "bobby", acq: 1 }); w.phone.groups.push({ creator: "ALICE001", id: 77n, name: "Team", members: ["BOBBOB02", "PHONE001"], lastAt: 6000 });
  const dir = tmp(); const ev: any[] = []; const conn: any = factory.create({ accountId: "acc", dataDir: dir });
  await conn.start((e: any) => ev.push(e));
  try {
    await waitFor(() => ev.some((e) => e.type === "login"));
    const p = ev.find((e) => e.type === "login").data;
    assert.equal(p.kind, "form"); assert.equal(p.warning.severity, "danger");
    for (const re of [/Unofficial/, /terms/, /device group/, /Safe backup/]) assert.match(p.warning.text, re);
    const cb = p.fields.find((f: any) => f.type === "checkbox"); assert.ok(cb.required); assert.ok(cb.help?.length);
    await assert.rejects(conn.submitLogin(p.promptId, { confirm: "false" }), /tick the box/);
    await conn.submitLogin(p.promptId, { confirm: "true" });
    await waitFor(() => ev.some((e) => e.type === "login" && e.data.kind === "qr"));
    const qr = ev.find((e) => e.type === "login" && e.data.kind === "qr").data; assert.match(qr.payload, /^threema:\/\/device-group\/join#[A-Za-z0-9_-]+$/);
    await w.phone.scan(qr.payload);
    await waitFor(() => ev.some((e) => e.type === "account" && e.data.state === "connected"), 8000, "connected");
    const emojiPrompt = ev.find((e) => e.type === "login" && e.data.kind === "form" && e.data.fields.length === 0).data;
    assert.equal(w.phone.emoji.length, 3); for (const em of w.phone.emoji) assert.ok(emojiPrompt.title.includes(em), "same emoji on both devices");
    assert.ok(w.phone.registeredSeen);
    const g = [...w.be.groups.values()][0]; assert.equal(g.devs.size, 1);
    for (const f of ["threema-md-session.json", "threema-md-state.json", "threema-md.key"]) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
    const all = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    for (const s of [Buffer.from(w.phone.me.sk).toString("hex"), Buffer.from(w.phone.dgk).toString("hex"), "PHONE001", "ALICE001", "Alice"]) assert.ok(!all.includes(s), "sealed at rest");
    const chats = await conn.chats(); assert.deepEqual(chats.map((c: any) => c.name).sort(), ["Alice W", "Team"], "group-only contacts (acquaintance level group) are not chats");
    assert.equal(chats.find((c: any) => c.name === "Team").kind, "group"); assert.equal(chats.find((c: any) => c.name === "Team").canManage, false);
    const av = await conn.avatar({ kind: "chat", id: "ALICE001" }); assert.deepEqual([...av.data], [0xff, 0xd8, 1, 2, 3]); assert.equal(av.mime, "image/jpeg");
    assert.deepEqual((await conn.members("ALICE001/" + hexId(77n))).map((m: any) => m.id).sort(), ["ALICE001", "BOBBOB02", "PHONE001"]);
    assert.equal((await conn.getProfile()).displayName, "Phone Owner"); assert.equal((await conn.getProfile()).handle, "PHONE001");
    assert.deepEqual(await conn.history("ALICE001", { limit: 10 }), []);
    // the CSP login carried our stable device identity and the documented extensions
    assert.equal(w.be.extensions.length, 1); assert.ok(Buffer.from(w.be.extensions[0]).includes(Buffer.from("UniChat")));
  } finally { await conn.stop(); await w.close(); }
});

test("login: the user does not confirm on the phone -> back to the consent prompt, no session left", async () => {
  const w = await world(); w.phone.confirm = false;
  const dir = tmp(); const ev: any[] = []; const conn: any = factory.create({ accountId: "acc", dataDir: dir });
  await conn.start((e: any) => ev.push(e));
  try {
    await waitFor(() => ev.some((e) => e.type === "login")); await conn.submitLogin(ev.find((e) => e.type === "login").data.promptId, { confirm: "true" });
    await waitFor(() => ev.some((e) => e.type === "login" && e.data.kind === "qr"));
    await w.phone.scan(ev.find((e) => e.type === "login" && e.data.kind === "qr").data.payload).catch(() => {});
    await waitFor(() => ev.filter((e) => e.type === "login" && e.data.kind === "form" && e.data.fields.some((f: any) => f.type === "checkbox")).length >= 2, 8000, "re-prompt");
    assert.ok(!existsSync(join(dir, "threema-md-session.json")));
  } finally { await conn.stop(); await w.close(); }
});

test("receive: text/quote/location/file/poll/receipt/reaction/edit/delete/typing; foreign edits are ignored", async () => {
  const w = await world(); w.phone.addContact("ALICE001", { first: "Alice" }); w.phone.addContact("BOBBOB02", { first: "Bob" });
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const A = "ALICE001"; const id = (n: number) => BigInt(1000 + n);
    await w.phone.incoming(A, id(1), Ty.TEXT, textBody("hello 😀")); await w.phone.incoming(A, id(2), Ty.TEXT, textBody(quoteText(id(1), "re: hello")));
    await w.phone.incoming(A, id(3), Ty.LOCATION, new TextEncoder().encode("47.5,8.5,10\nSpot\nMain St 1"));
    const key = new Uint8Array(randomBytes(32)), n = new Uint8Array(24); n[23] = 1;
    const blobId = w.http.addBlob(secretbox(new Uint8Array([9, 8, 7, 6]), n, key));
    await w.phone.incoming(A, id(4), Ty.FILE, new TextEncoder().encode(JSON.stringify({ j: 1, k: Buffer.from(key).toString("hex"), b: blobId, m: "image/png", n: "a.png", s: 4, d: "cap", x: { w: 2, h: 3 } })));
    const poll = Buffer.concat([b8(1n), Buffer.from(JSON.stringify({ d: "Lunch?", s: 0, a: 0, t: 1, c: [{ i: 0, n: "Pizza", o: 0 }, { i: 1, n: "Sushi", o: 1 }] }))]);
    await w.phone.incoming(A, id(5), Ty.POLL_SETUP, new Uint8Array(poll));
    await w.phone.incoming(A, id(6), Ty.POLL_VOTE, new Uint8Array(Buffer.concat([Buffer.from("ALICE001"), b8(1n), Buffer.from("[[0,0],[1,1]]")])));
    await waitFor(() => L.of("message").length >= 5 && L.of("message-update").length >= 1, 5000, "messages");
    const msgs = L.of("message"); const byId = (i: bigint) => msgs.find((m: any) => m.id === hexId(i));
    assert.equal(byId(id(1)).text, "hello 😀"); assert.equal(byId(id(1)).sender, "Alice"); assert.equal(byId(id(1)).chatId, A); assert.ok(!byId(id(1)).fromMe); assert.ok(!byId(id(1)).historical);
    assert.equal(byId(id(2)).text, "re: hello"); assert.equal(byId(id(2)).replyTo.messageId, hexId(id(1)));
    assert.deepEqual(byId(id(3)).location, { lat: 47.5, lng: 8.5, name: "Spot", address: "Main St 1" });
    const f = byId(id(4)); assert.equal(f.text, "cap"); assert.equal(f.attachments[0].kind, "image"); assert.equal(f.attachments[0].width, 2);
    const dl = await L.conn.downloadAttachment(A, f.id, f.attachments[0].id); assert.deepEqual([...dl.data], [9, 8, 7, 6]); assert.equal(dl.mime, "image/png");
    await waitFor(() => w.http.doneCalls.includes(blobId), 3000, "blob marked done"); assert.ok(!w.http.authHeaderSeen);
    assert.equal(w.http.lastQuery.get("scope"), "public"); assert.ok(w.http.lastQuery.get("deviceId")); assert.equal(w.http.lastQuery.get("deviceGroupId")?.length, 64);
    assert.equal(byId(id(5)).poll.question, "Lunch?");
    assert.deepEqual(L.of("message-update").find((u: any) => u.patch.poll)?.patch.poll.options[1].voters, ["ALICE001"]);
    await w.phone.incoming(A, id(10), Ty.DELIVERY, new Uint8Array(Buffer.concat([Buffer.from([2]), b8(77n)])));
    await w.phone.incoming(A, id(11), Ty.DELIVERY, new Uint8Array(Buffer.concat([Buffer.from([3]), b8(id(1))])));
    await w.phone.incoming(A, id(12), Ty.EDIT, Uint8Array.from([0x09, ...b8(id(1)), 0x12, 3, 0x6e, 0x65, 0x77]));
    await w.phone.incoming(A, id(13), Ty.TYPING, new Uint8Array([1]));
    await w.phone.incoming(A, id(14), Ty.DELETE, Uint8Array.from([0x09, ...b8(id(2))]));
    await waitFor(() => L.of("receipt").length >= 1 && L.of("typing").length >= 1 && L.of("message-update").some((u: any) => u.patch.deleted), 5000, "control");
    assert.equal(L.of("receipt")[0].status, "read"); assert.equal(L.of("receipt")[0].by, A); assert.equal(L.of("receipt")[0].messageId, hexId(77n));
    const up = L.of("message-update"); assert.ok(up.some((u: any) => u.messageId === hexId(id(1)) && u.patch.text === "new" && u.patch.editedAt));
    assert.ok(up.some((u: any) => u.patch.reactions?.[0]?.emoji === "👍" && u.patch.reactions[0].senderIds[0] === A));
    assert.equal(L.of("typing")[0].typing, true);
    await w.phone.incoming("BOBBOB02", id(15), Ty.DELETE, Uint8Array.from([0x09, ...b8(id(1))])); await wait(200);
    assert.equal(L.of("message-update").filter((u: any) => u.messageId === hexId(id(1)) && u.patch.deleted).length, 0, "only the original sender may delete");
  } finally { await L.stop(); await w.close(); }
});

test("network drop: backlog arrives once, flagged historical, nothing duplicated, reconnect with backoff", async () => {
  const w = await world(); w.phone.addContact("ALICE001", { first: "Alice" });
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    await w.phone.incoming("ALICE001", 5001n, Ty.TEXT, textBody("live one")); await waitFor(() => L.of("message").length === 1);
    w.be.closeAll(1011);
    await waitFor(() => L.stateOf() === "connecting", 3000, "reconnecting");
    await waitFor(() => L.stateOf() === "connected", 8000, "reconnected");
    await w.phone.connect(w.medUrl).catch(() => {});
    await w.phone.incoming("ALICE001", 5002n, Ty.TEXT, textBody("after drop"));
    await waitFor(() => L.of("message").some((m: any) => m.text === "after drop"), 8000, "resume"); await wait(300);
    assert.equal(L.of("message").filter((m: any) => m.text === "after drop").length, 1); assert.equal(L.of("message").filter((m: any) => m.text === "live one").length, 1);
  } finally { await L.stop(); await w.close(); }
});

test("ledger resume: a reflected message that was not acknowledged is redelivered after reconnect but shown once", async () => {
  const w = await world(); w.phone.addContact("ALICE001", { first: "Alice" });
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const g = [...w.be.groups.values()][0]; const me = [...g.devs.values()].find((d) => d.id !== w.phone.deviceId)!;
    await w.phone.incoming("ALICE001", 6001n, Ty.TEXT, textBody("one")); await waitFor(() => L.of("message").length === 1);
    // simulate "processed but ack lost": put the same reflected envelope back into our queue and drop the connection
    const last = w.be.reflectedLog.at(-1)!; me.queue.push({ id: 900, ts: 1n, flags: 0, env: last.env }); w.be.closeAll(1011);
    await waitFor(() => L.stateOf() === "connected" && w.be.connections >= 3, 8000, "reconnect"); await wait(300);
    assert.equal(L.of("message").filter((m: any) => m.text === "one").length, 1, "replayed envelope is dropped by the nonce store");
  } finally { await L.stop(); await w.close(); }
});

test("send: reflect first, then chat server, sent update; group send reaches all members; reply/edit/react/delete", async () => {
  const w = await world(); const alice = w.phone.addContact("ALICE001", { first: "Alice" }), bob = w.phone.addContact("BOBBOB02", { first: "Bob" });
  w.phone.groups.push({ creator: "PHONE001", id: 9n, name: "Crew", members: ["ALICE001", "BOBBOB02"] });
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const m = await L.conn.send("ALICE001", { text: "hi alice" }); assert.equal(m.status, "sent"); assert.equal(m.fromMe, true);
    assert.equal(w.be.outbox.length, 1); const wire = w.be.outbox[0]; assert.equal(wire.receiver, "ALICE001"); assert.equal(wire.sender, "PHONE001");
    const o = openIncoming(wire, alice.peer.sk, w.phone.me.pk)!; assert.equal(o.type, Ty.TEXT); assert.equal(new TextDecoder().decode(o.body), "hi alice");
    assert.equal(o.metadata?.messageId, wire.messageId); assert.equal(wire.flags & 1, 1);
    await waitFor(() => w.phone.got.length >= 2, 3000); assert.ok(w.phone.got[0].envelope.outgoingMessage); assert.equal(w.phone.got[0].envelope.outgoingMessage.type, Ty.TEXT);
    assert.ok(w.phone.got[1].envelope.outgoingMessageUpdate.updates[0].sent);
    assert.deepEqual([...w.phone.got[0].envelope.outgoingMessage.nonces[0]], [...wire.nonce]);
    await L.conn.send("ALICE001", { text: "second", replyToMessageId: hexId(5n) });
    assert.equal(new TextDecoder().decode(openIncoming(w.be.outbox[1], alice.peer.sk, w.phone.me.pk)!.body), quoteText(5n, "second"));
    const gm = await L.conn.send("PHONE001/" + hexId(9n), { text: "to all" }); assert.ok(gm.id);
    const gw = w.be.outbox.slice(2); assert.deepEqual(gw.map((x) => x.receiver).sort(), ["ALICE001", "BOBBOB02"]); assert.equal(new Set(gw.map((x) => x.messageId)).size, 1);
    const go = openIncoming(gw.find((x) => x.receiver === "BOBBOB02")!, bob.peer.sk, w.phone.me.pk)!; assert.equal(go.type, Ty.GROUP_TEXT);
    assert.equal(new TextDecoder().decode(go.body.subarray(0, 8)), "PHONE001"); assert.equal(new TextDecoder().decode(go.body.subarray(16)), "to all");
    await L.conn.setTyping("ALICE001", true); await waitFor(() => w.be.outbox.length === 5); assert.equal(w.be.outbox[4].flags, 0x06);
    await assert.rejects(L.conn.send("ALICE001", { text: "x".repeat(6001) }), /too long/);
    await L.conn.edit("ALICE001", m.id, "hi alice!"); await L.conn.react("ALICE001", m.id, "🎉"); await L.conn.delete("ALICE001", m.id);
    const types = w.be.outbox.slice(5).map((x) => openIncoming(x, alice.peer.sk, w.phone.me.pk)!.type); assert.deepEqual(types, [Ty.EDIT, Ty.REACTION, Ty.DELETE]);
    await assert.rejects(L.conn.edit("ALICE001", "00".repeat(8), "x"), /own messages/);
  } finally { await L.stop(); await w.close(); }
});

test("send: attachment is encrypted + uploaded to the blob mirror (persist only for groups), file JSON as documented", async () => {
  const w = await world(); const alice = w.phone.addContact("ALICE001", { first: "Alice" });
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const data = new Uint8Array(randomBytes(500)); const m = await L.conn.send("ALICE001", { text: "see", attachments: [{ kind: "file", mime: "application/pdf", name: "x.pdf", data }] });
    assert.equal(m.attachments[0].kind, "file"); assert.equal(w.http.blobs.size, 1); assert.equal([...w.http.blobs.values()][0].persist, false);
    const o = openIncoming(w.be.outbox[0], alice.peer.sk, w.phone.me.pk)!; assert.equal(o.type, Ty.FILE);
    const j = JSON.parse(new TextDecoder().decode(o.body)); assert.equal(j.j, 0); assert.equal(j.m, "application/pdf"); assert.equal(j.s, 500); assert.equal(j.d, "see");
    const n = new Uint8Array(24); n[23] = 1; const blob = w.http.blobs.get(j.b)!;
    assert.deepEqual([...secretboxOpen(blob.data, n, new Uint8Array(Buffer.from(j.k, "hex")))!], [...data]);
    const back = await L.conn.downloadAttachment("ALICE001", m.id, "file"); assert.deepEqual([...back.data], [...data]);
  } finally { await L.stop(); await w.close(); }
});

test("leader: with the phone offline UniChat leads: decrypts, reflects, acks, answers with a delivery receipt, creates unknown contacts", async () => {
  const w = await world(); const alice = w.phone.addContact("ALICE001", { first: "Alice" });
  const L = await linked(factory, w, { phoneOnline: false });
  try {
    await waitFor(() => [...w.be.groups.values()][0].leader !== undefined, 3000, "leader");
    const carol = newPeer("CAROL003"); w.be.registerIdentity("CAROL003", carol.pk); w.http.dir.set("CAROL003", { pk: carol.pk, featureMask: 0x7ffn });
    await waitFor(() => w.be.received.some((r) => r.type === 0x03), 3000, "unblock");
    const wire = w.be.send(alice.peer, "PHONE001", w.phone.me.pk, Ty.TEXT, textBody("direct hello"), { nickname: "Ally" });
    await waitFor(() => L.of("message").some((m: any) => m.text === "direct hello"), 5000, "direct message");
    await waitFor(() => w.be.acksSeen >= 1, 3000, "ack");
    assert.equal(w.be.queue.get("PHONE001")!.length, 0, "acknowledged");
    const inc = envelopes(w).find((e) => e.incomingMessage)!; assert.equal(inc.incomingMessage.senderIdentity, "ALICE001"); assert.equal(inc.incomingMessage.messageId, wire.messageId); assert.deepEqual([...inc.incomingMessage.nonce], [...wire.nonce]);
    await waitFor(() => w.be.outbox.length === 1, 3000, "receipt"); const rc = openIncoming(w.be.outbox[0], alice.peer.sk, w.phone.me.pk)!;
    assert.equal(rc.type, Ty.DELIVERY); assert.equal(rc.body[0], 1);
    const n0 = L.of("message").length; w.be.replay(wire); await wait(300); assert.equal(L.of("message").length, n0, "replayed nonce is not shown twice");
    w.be.send(carol, "PHONE001", w.phone.me.pk, Ty.TEXT, textBody("hi from a stranger"));
    await waitFor(() => L.of("message").some((m: any) => m.text === "hi from a stranger"), 5000, "stranger"); assert.equal(w.http.dirCalls, 1);
    assert.ok(envelopes(w).some((e) => e.contactSync?.create?.contact?.identity === "CAROL003" && e.contactSync.create.contact.acquaintanceLevel === 0));
  } finally { await L.stop(); await w.close(); }
});

test("blocked senders are acknowledged and dropped silently", async () => {
  const w = await world(); const alice = w.phone.addContact("ALICE001", { first: "Alice" }); w.phone.blocked.push("ALICE001");
  const L = await linked(factory, w, { phoneOnline: false });
  try {
    await waitFor(() => w.be.received.some((r) => r.type === 0x03), 3000, "unblock");
    w.be.send(alice.peer, "PHONE001", w.phone.me.pk, Ty.TEXT, textBody("spam")); await waitFor(() => w.be.acksSeen >= 1, 3000, "ack"); await wait(100);
    assert.equal(L.of("message").length, 0); assert.equal(w.be.outbox.length, 0);
  } finally { await L.stop(); await w.close(); }
});

test("revoked by the phone (close 4113) -> needs-login, local secrets wiped", async () => {
  const w = await world(); w.phone.addContact("ALICE001");
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const g = [...w.be.groups.values()][0]; const me = [...g.devs.values()].find((d) => d.id !== w.phone.deviceId)!;
    w.be.dropFromServer(g, me.id, 4113);
    await waitFor(() => L.stateOf() === "needs-login", 5000, "needs-login"); await waitFor(() => !existsSync(join(L.dir, "threema-md-session.json")), 3000);
    assert.ok(L.of("login").length >= 2); assert.equal(L.of("login").at(-1).kind, "form");
  } finally { await L.stop(); await w.close(); }
});

test("slot already removed on the server (state mismatch 4115) also means needs-login", async () => {
  const w = await world(); w.phone.addContact("ALICE001");
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const g = [...w.be.groups.values()][0]; const me = [...g.devs.values()].find((d) => d.id !== w.phone.deviceId)!;
    const ws = me.conn!.ws; g.devs.delete(me.id); ws.close(1011);
    await waitFor(() => L.stateOf() === "needs-login", 8000, "needs-login");
  } finally { await L.stop(); await w.close(); }
});

test("device slot limit: join fails cleanly and nothing is stored", async () => {
  const w = await world({ slots: 1 }); w.phone.addContact("ALICE001");
  const dir = tmp(); const ev: any[] = []; const conn: any = factory.create({ accountId: "acc", dataDir: dir });
  await w.phone.connect(w.medUrl);
  await conn.start((e: any) => ev.push(e));
  try {
    await waitFor(() => ev.some((e) => e.type === "login")); await conn.submitLogin(ev.find((e) => e.type === "login").data.promptId, { confirm: "true" });
    await waitFor(() => ev.some((e) => e.type === "login" && e.data.kind === "qr")); await w.phone.scan(ev.find((e) => e.type === "login" && e.data.kind === "qr").data.payload).catch(() => {});
    await waitFor(() => ev.filter((e) => e.type === "login" && e.data.kind === "form" && e.data.fields.some((f: any) => f.type === "checkbox")).length >= 2, 8000, "failed join re-prompt");
    assert.ok(!existsSync(join(dir, "threema-md-session.json")));
  } finally { await conn.stop(); await w.close(); }
});

test("close 4111/4112 (no automatic reconnect) -> disconnected, no retry storm", async () => {
  const w = await world(); w.phone.addContact("ALICE001");
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    w.be.closeAll(4112); await waitFor(() => L.stateOf() === "disconnected", 5000, "disconnected"); const c = w.be.connections; await wait(400); assert.equal(w.be.connections, c);
  } finally { await L.stop(); await w.close(); }
});

test("logout drops this device slot and wipes local state; a failing remote drop is reported after the wipe", async () => {
  const w = await world(); w.phone.addContact("ALICE001");
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const g = [...w.be.groups.values()][0]; assert.equal(g.devs.size, 2);
    await L.conn.logout(); assert.equal(g.devs.size, 1); assert.ok(g.devs.has(w.phone.deviceId));
    assert.deepEqual(readdirSync(L.dir), []); assert.equal(L.stateOf(), "signed-out");
  } finally { await L.stop(); await w.close(); }
  const w2 = await world(); const L2 = await linked(factory, w2, { phoneOnline: true });
  try { await w2.be.close(); await assert.rejects(L2.conn.logout(), /Linked Devices/); assert.deepEqual(readdirSync(L2.dir), []); } finally { await w2.rz.close(); await w2.http.close(); }
});

test("startChat resolves a Threema ID through the directory (rate limit respected), then sends", async () => {
  const w = await world(); w.phone.addContact("ALICE001");
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const dan = newPeer("DAN00004"); w.http.dir.set("DAN00004", { pk: dan.pk, featureMask: 0x7ffn });
    await assert.rejects(L.conn.startChat("nope"), /8 characters/); await assert.rejects(L.conn.startChat("ZZZZZZZZ"), /No Threema user/);
    w.http.rateLimitNext = 1; await assert.rejects(L.conn.startChat("DAN00004"), /rate limiting/);
    const c = await L.conn.startChat("dan00004"); assert.equal(c.id, "DAN00004"); assert.equal(c.kind, "dm");
    await L.conn.send("DAN00004", { text: "yo" }); assert.equal(w.be.outbox.at(-1)!.receiver, "DAN00004");
  } finally { await L.stop(); await w.close(); }
});

test("markRead sends a read receipt, block syncs settings and blocks sending", async () => {
  const w = await world(); const alice = w.phone.addContact("ALICE001");
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    await w.phone.incoming("ALICE001", 7001n, Ty.TEXT, textBody("a")); await w.phone.incoming("ALICE001", 7002n, Ty.TEXT, textBody("b")); await waitFor(() => L.of("message").length === 2);
    await L.conn.markRead("ALICE001", hexId(7002n)); const o = openIncoming(w.be.outbox[0], alice.peer.sk, w.phone.me.pk)!;
    assert.equal(o.type, Ty.DELIVERY); assert.equal(o.body[0], 2); assert.equal((o.body.length - 1) / 8, 2);
    await L.conn.blockChat("ALICE001", true); await waitFor(() => w.phone.got.some((r) => r.envelope.settingsSync), 3000); assert.equal((await L.conn.chats())[0].blocked, true);
    await assert.rejects(L.conn.send("ALICE001", { text: "x" }), /blocked/);
  } finally { await L.stop(); await w.close(); }
});

test("forward-security messages are reported once, never crash", async () => {
  const w = await world(); w.phone.addContact("ALICE001");
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    await w.phone.incoming("ALICE001", 8001n, Ty.FS, new Uint8Array([1, 2, 3])); await w.phone.incoming("ALICE001", 8002n, Ty.FS, new Uint8Array([1, 2, 3]));
    await waitFor(() => L.of("error").length >= 1); await wait(100); assert.equal(L.of("error").filter((e: any) => e.code === "forward-security").length, 1);
  } finally { await L.stop(); await w.close(); }
});
