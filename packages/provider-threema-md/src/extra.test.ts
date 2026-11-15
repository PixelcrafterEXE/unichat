import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import factory from "./index.js";
import { openIncoming, u64le } from "./csp.js";
import { Ty, groupSetupBody, hexId, textBody } from "./e2e.js";
import { newPeer } from "./fake/servers.js";
import { decode, encode } from "./proto.js";
import { secretbox, secretboxOpen } from "./nacl.js";
import { Envelope, SharedDeviceData } from "./schemas.js";
import { saveSession } from "./store.js";
import { linked, tmp, wait, waitFor, world, type World } from "./helpers.js";

const cat = (...p: Uint8Array[]) => Buffer.concat(p);
const td = new TextEncoder();
const envelopes = (w: World) => w.be.reflectedLog.map((r) => decode(Envelope, secretboxOpen(r.env.subarray(24), r.env.subarray(0, 24), w.phone.keys.dgrk)!));

test("group messages (reflected): chat id, sender, quotes; group chats are listed with members", async () => {
  const w = await world(); w.phone.addContact("ALICE001", { first: "Alice" }); w.phone.addContact("BOBBOB02", { first: "Bob" });
  w.phone.groups.push({ creator: "ALICE001", id: 5n, name: "Crew", members: ["BOBBOB02", "PHONE001"], lastAt: 10 });
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const body = cat(td.encode("ALICE001"), u64le(5n), td.encode("group hello"));
    await w.phone.incoming("BOBBOB02", 31n, Ty.GROUP_TEXT, new Uint8Array(body));
    await waitFor(() => L.of("message").length === 1);
    const m = L.of("message")[0]; assert.equal(m.chatId, "ALICE001/" + hexId(5n)); assert.equal(m.senderId, "BOBBOB02"); assert.equal(m.sender, "Bob"); assert.equal(m.text, "group hello");
    assert.ok((await L.conn.chats()).some((c: any) => c.id === m.chatId && c.kind === "group"));
  } finally { await L.stop(); await w.close(); }
});

test("leader: group-setup + group-name from the creator create the group (contacts + groups synced inside transactions), then group messages work", async () => {
  const w = await world(); const alice = w.phone.addContact("ALICE001", { first: "Alice" });
  const bob = newPeer("BOBBOB02"); w.be.registerIdentity("BOBBOB02", bob.pk); w.http.dir.set("BOBBOB02", { pk: bob.pk, featureMask: 0x7ffn });
  const L = await linked(factory, w, { phoneOnline: false });
  try {
    await waitFor(() => w.be.received.some((r) => r.type === 0x03), 3000, "unblock");
    const creator = (b: Uint8Array) => cat(u64le(77n), b);
    w.be.send(alice.peer, "PHONE001", w.phone.me.pk, Ty.GROUP_SETUP, new Uint8Array(creator(td.encode("BOBBOB02PHONE001"))));
    await waitFor(() => envelopes(w).some((e) => e.groupSync?.create), 5000, "group create");
    w.be.send(alice.peer, "PHONE001", w.phone.me.pk, Ty.GROUP_NAME, new Uint8Array(creator(td.encode("Hikers"))));
    await waitFor(() => envelopes(w).some((e) => e.groupSync?.update?.group?.name === "Hikers"), 5000, "group name");
    const cs = envelopes(w).find((e) => e.contactSync?.create?.contact?.identity === "BOBBOB02")!; assert.equal(cs.contactSync.create.contact.acquaintanceLevel, 1, "group-only contact");
    assert.ok((await L.conn.chats()).some((c: any) => c.kind === "group" && c.name === "Hikers"));
    w.be.send(bob, "PHONE001", w.phone.me.pk, Ty.GROUP_TEXT, new Uint8Array(cat(td.encode("ALICE001"), u64le(77n), td.encode("hi group"))));
    await waitFor(() => L.of("message").some((m: any) => m.text === "hi group"), 5000, "group msg");
    assert.equal(w.be.outbox.length, 0, "no automatic delivery receipts in groups");
  } finally { await L.stop(); await w.close(); }
});

test("a contact's profile picture message updates the avatar (downloaded + decrypted from the mirror)", async () => {
  const w = await world(); w.phone.addContact("ALICE001", { first: "Alice" });
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const key = new Uint8Array(randomBytes(32)), n = new Uint8Array(24); n[23] = 1; const img = new Uint8Array([0x89, 0x50, 4, 5, 6]);
    const id = w.http.addBlob(secretbox(img, n, key)); const body = cat(Buffer.from(id, "hex"), Buffer.from([5, 0, 0, 0]), key);
    await w.phone.incoming("ALICE001", 90n, Ty.CONTACT_PIC_SET, new Uint8Array(body));
    await wait(300); const av = await L.conn.avatar({ kind: "contact", id: "ALICE001" }); assert.deepEqual([...av.data], [...img]); assert.equal(av.mime, "image/png");
  } finally { await L.stop(); await w.close(); }
});

test("send: location, poll creation and vote, multi-attachment", async () => {
  const w = await world(); const alice = w.phone.addContact("ALICE001", { first: "Alice" });
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const loc = await L.conn.send("ALICE001", { text: "", location: { lat: 1.5, lng: 2.5, name: "Cafe", address: "Street 1" } }); assert.equal(loc.location.name, "Cafe");
    assert.equal(new TextDecoder().decode(openIncoming(w.be.outbox[0], alice.peer.sk, w.phone.me.pk)!.body), "1.5,2.5\nCafe\nStreet 1");
    const p = await L.conn.send("ALICE001", { text: "", poll: { question: "Q?", options: ["a", "b"], multiple: false } }); assert.equal(p.poll.options.length, 2);
    const setup = openIncoming(w.be.outbox[1], alice.peer.sk, w.phone.me.pk)!; assert.equal(setup.type, Ty.POLL_SETUP); assert.equal(JSON.parse(new TextDecoder().decode(setup.body.subarray(8))).d, "Q?");
    await L.conn.vote("ALICE001", p.id, ["1"]); const v = openIncoming(w.be.outbox[2], alice.peer.sk, w.phone.me.pk)!; assert.equal(v.type, Ty.POLL_VOTE);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(v.body.subarray(16))), [[0, 0], [1, 1]]);
    assert.deepEqual(L.of("message-update").at(-1).patch.poll.mine, ["1"]);
    const a = (n: string) => ({ kind: "image" as const, mime: "image/png", name: n, data: new Uint8Array([1, 2, 3]) });
    const first = await L.conn.send("ALICE001", { text: "two", attachments: [a("1.png"), a("2.png")] }); assert.equal(first.attachments.length, 1);
    await waitFor(() => w.be.outbox.length === 5); assert.equal(L.of("message").length, 1, "the second attachment is announced as its own message");
  } finally { await L.stop(); await w.close(); }
});

test("a phone that announces a newer minimum D2D version keeps UniChat disconnected (no writes)", async () => {
  const w = await world(); w.phone.addContact("ALICE001");
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const g = [...w.be.groups.values()][0]; const n = new Uint8Array(randomBytes(24));
    g.sharedData = cat(n, secretbox(encode(SharedDeviceData, { padding: new Uint8Array(3), version: 9 }), n, w.phone.keys.dgsddk));
    w.be.closeAll(1011);
    await waitFor(() => L.of("error").some((e: any) => e.code === "protocol-too-new"), 5000, "protocol too new"); await waitFor(() => L.stateOf() === "disconnected", 3000);
  } finally { await L.stop(); await w.close(); }
});

test("an unfinished earlier linking (session without registered slot) is not reused: needs-login with a hint to check the phone", async () => {
  const w = await world(); const dir = tmp();
  saveSession(dir, { identity: "PHONE001", ck: "00".repeat(32), dgk: "11".repeat(32), serverGroup: "ab", deviceId: "1", cspDeviceId: "2", cspCookie: "00".repeat(16), registered: false, linkedAt: "x" });
  const ev: any[] = []; const conn = factory.create({ accountId: "acc", dataDir: dir }); await conn.start((e: any) => ev.push(e));
  try { const a = ev.find((e) => e.type === "account"); assert.equal(a.data.state, "needs-login"); assert.match(a.data.detail, /Linked Devices/); assert.ok(ev.some((e) => e.type === "login")); assert.equal(w.be.connections, 0); void writeFileSync; void join; }
  finally { await conn.stop(); await w.close(); }
});

test("transactions are retried when another device holds the lock", async () => {
  const w = await world(); w.phone.addContact("ALICE001");
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const g = [...w.be.groups.values()][0]; g.tx = { dev: w.phone.deviceId, scope: new Uint8Array(40) };
    const p = L.conn.updateProfile({ displayName: "New Nick" }); await wait(500); g.tx = undefined; (w.be as any).broadcastTxEnd?.(g, w.phone.deviceId, new Uint8Array(0));
    const prof = await p; assert.equal(prof.displayName, "New Nick"); assert.ok(envelopes(w).some((e) => e.userProfileSync?.update?.userProfile?.nickname === "New Nick"));
  } finally { await L.stop(); await w.close(); }
});
