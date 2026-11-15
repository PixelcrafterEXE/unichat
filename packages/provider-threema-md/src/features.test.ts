// Offline tests: group management by the creator, mentions, privacy settings. Fake phone / mediator / chat server / directory only.
import test from "node:test";
import assert from "node:assert/strict";
import factory, { CAPABILITIES } from "./index.js";
import { openIncoming } from "./csp.js";
import { Ty, hexId, textBody } from "./e2e.js";
import { newPeer } from "./fake/servers.js";
import { decode } from "./proto.js";
import { secretboxOpen } from "./nacl.js";
import { Envelope } from "./schemas.js";
import { linked, wait, waitFor, world, type World } from "./helpers.js";

const envelopes = (w: World) => w.be.reflectedLog.map((r) => decode(Envelope, secretboxOpen(r.env.subarray(24), r.env.subarray(0, 24), w.phone.keys.dgrk)!));
const ascii = (b: Uint8Array) => new TextDecoder().decode(b);
const idsOf = (b: Uint8Array) => { const o: string[] = []; for (let i = 0; i + 8 <= b.length; i += 8) o.push(ascii(b.subarray(i, i + 8))); return o; };

test("capabilities: group management by the creator, mentions and privacy are declared; pictures and descriptions are not", () => {
  for (const k of ["createGroup", "manageMembers", "leaveChat", "renameChat", "mentions", "privacy"] as const) assert.equal(CAPABILITIES[k], true, k);
  for (const k of ["chatPicture", "chatDescription", "contactCards", "events"] as const) assert.ok(!CAPABILITIES[k], k);
});

test("createGroup: directory lookup, reflected group create, setup + name to every member (creator container), group is listed and manageable", async () => {
  const w = await world(); const alice = w.phone.addContact("ALICE001", { first: "Alice" });
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const bob = newPeer("BOBBOB02"); w.http.dir.set("BOBBOB02", { pk: bob.pk, featureMask: 0x7ffn });
    await assert.rejects(L.conn.createGroup("Crew", []), /at least one/); await assert.rejects(L.conn.createGroup("  ", ["ALICE001"]), /name/);
    await assert.rejects(L.conn.createGroup("Crew", ["nope"]), /not a Threema ID/); await assert.rejects(L.conn.createGroup("Crew", ["ZZZZZZZZ"]), /does not exist/);
    const c = await L.conn.createGroup("Crew", ["alice001", "BOBBOB02", "ALICE001"]);
    assert.equal(c.kind, "group"); assert.match(c.id, /^PHONE001\/[0-9a-f]{16}$/); assert.equal(c.canManage, true); assert.equal(c.name, "Crew");
    await waitFor(() => w.be.outbox.length === 4, 3000, "4 control messages");
    const bobOut = w.be.outbox.filter((x) => x.receiver === "BOBBOB02").map((x) => openIncoming(x, bob.sk, w.phone.me.pk)!);
    assert.deepEqual(bobOut.map((o) => o.type), [Ty.GROUP_SETUP, Ty.GROUP_NAME]);
    assert.deepEqual(idsOf(bobOut[0].body.subarray(8)), ["ALICE001", "BOBBOB02"], "members list, creator not in it"); assert.equal(ascii(bobOut[1].body.subarray(8)), "Crew");
    assert.deepEqual([...bobOut[0].body.subarray(0, 8)], [...bobOut[1].body.subarray(0, 8)], "same group id");
    const aliceTypes = w.be.outbox.filter((x) => x.receiver === "ALICE001").map((x) => openIncoming(x, alice.peer.sk, w.phone.me.pk)!.type); assert.deepEqual(aliceTypes, [Ty.GROUP_SETUP, Ty.GROUP_NAME]);
    const env = envelopes(w).find((e) => e.groupSync?.create)!.groupSync.create.group;
    assert.equal(env.name, "Crew"); assert.equal(env.groupIdentity.creatorIdentity, "PHONE001"); assert.deepEqual(env.memberIdentities.identities, ["ALICE001", "BOBBOB02"]); assert.equal(env.userState, 0);
    assert.ok(envelopes(w).some((e) => e.contactSync?.create?.contact?.identity === "BOBBOB02"), "new member synced as a group contact");
    assert.ok((await L.conn.chats()).some((x: any) => x.id === c.id && x.canManage === true));
    const m = await L.conn.send(c.id, { text: "welcome" }); assert.ok(m.id);
    assert.deepEqual((await L.conn.members(c.id)).map((x: any) => x.id).sort(), ["ALICE001", "BOBBOB02", "PHONE001"]);
  } finally { await L.stop(); await w.close(); }
});

test("rename, add and remove members (creator only): reflected updates, setup to old + new members, empty setup to the removed one", async () => {
  const w = await world(); const alice = w.phone.addContact("ALICE001", { first: "Alice" }), bob = w.phone.addContact("BOBBOB02", { first: "Bob" });
  w.phone.groups.push({ creator: "PHONE001", id: 9n, name: "Crew", members: ["ALICE001"] }); w.phone.groups.push({ creator: "ALICE001", id: 10n, name: "Theirs", members: ["PHONE001", "BOBBOB02"] });
  const L = await linked(factory, w, { phoneOnline: true }); const G = "PHONE001/" + hexId(9n);
  try {
    await L.conn.renameChat(G, " Crew 2 "); await waitFor(() => w.be.outbox.length === 1);
    const n = openIncoming(w.be.outbox[0], alice.peer.sk, w.phone.me.pk)!; assert.equal(n.type, Ty.GROUP_NAME); assert.equal(ascii(n.body.subarray(8)), "Crew 2");
    assert.equal(envelopes(w).find((e) => e.groupSync?.update?.group?.name === "Crew 2")!.groupSync.update.group.groupIdentity.creatorIdentity, "PHONE001");
    await L.conn.addMembers(G, ["BOBBOB02", "ALICE001"]); await waitFor(() => w.be.outbox.length === 1 + 2 + 1);
    const out = w.be.outbox.slice(1).map((x) => ({ to: x.receiver, o: openIncoming(x, (x.receiver === "ALICE001" ? alice : bob).peer.sk, w.phone.me.pk)! }));
    assert.deepEqual(out.map((x) => [x.to, x.o.type]), [["ALICE001", Ty.GROUP_SETUP], ["BOBBOB02", Ty.GROUP_SETUP], ["BOBBOB02", Ty.GROUP_NAME]]);
    assert.deepEqual(idsOf(out[0].o.body.subarray(8)), ["ALICE001", "BOBBOB02"]);
    const upd = envelopes(w).filter((e) => e.groupSync?.update).at(-1)!.groupSync.update; assert.deepEqual(upd.group.memberIdentities.identities, ["ALICE001", "BOBBOB02"]);
    await L.conn.addMembers(G, ["BOBBOB02"]); await wait(150); assert.equal(w.be.outbox.length, 4, "already a member: nothing sent");
    await L.conn.removeMember(G, "BOBBOB02"); await waitFor(() => w.be.outbox.length === 6);
    const rm = w.be.outbox.slice(4).map((x) => ({ to: x.receiver, o: openIncoming(x, (x.receiver === "ALICE001" ? alice : bob).peer.sk, w.phone.me.pk)! }));
    assert.deepEqual(rm.map((x) => [x.to, idsOf(x.o.body.subarray(8))]), [["ALICE001", ["ALICE001"]], ["BOBBOB02", []]]);
    assert.deepEqual([...(await L.conn.members(G))].map((x: any) => x.id).sort(), ["ALICE001", "PHONE001"]);
    await assert.rejects(L.conn.removeMember(G, "PHONE001"), /Leave/); await assert.rejects(L.conn.removeMember(G, "BOBBOB02"), /not in the group/);
    await assert.rejects(L.conn.removeMember(G, "ALICE001"), /at least one other/);
    const T = "ALICE001/" + hexId(10n);
    await assert.rejects(L.conn.renameChat(T, "x"), /created this group/); await assert.rejects(L.conn.addMembers(T, ["ALICE001"]), /created this group/); await assert.rejects(L.conn.removeMember(T, "BOBBOB02"), /created this group/);
    assert.equal((await L.conn.chats()).find((c: any) => c.id === T).canManage, false); assert.equal((await L.conn.chats()).find((c: any) => c.id === G).canManage, true);
    await assert.rejects(L.conn.renameChat("ALICE001", "x"), /Only group chats/);
  } finally { await L.stop(); await w.close(); }
});

test("leave: a member sends group-leave to creator and members; the creator leaving dissolves the group; the chat turns read-only", async () => {
  const w = await world(); const alice = w.phone.addContact("ALICE001", { first: "Alice" }), bob = w.phone.addContact("BOBBOB02", { first: "Bob" });
  w.phone.groups.push({ creator: "ALICE001", id: 10n, name: "Theirs", members: ["PHONE001", "BOBBOB02"] }); w.phone.groups.push({ creator: "PHONE001", id: 9n, name: "Mine", members: ["ALICE001", "BOBBOB02"] });
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    const T = "ALICE001/" + hexId(10n); await L.conn.leaveChat(T); await waitFor(() => w.be.outbox.length === 2);
    const lv = w.be.outbox.map((x) => ({ to: x.receiver, o: openIncoming(x, (x.receiver === "ALICE001" ? alice : bob).peer.sk, w.phone.me.pk)! }));
    assert.deepEqual(lv.map((x) => [x.to, x.o.type]).sort(), [["ALICE001", Ty.GROUP_LEAVE], ["BOBBOB02", Ty.GROUP_LEAVE]]);
    assert.equal(ascii(lv[0].o.body.subarray(0, 8)), "ALICE001", "member container names the creator");
    assert.equal(envelopes(w).filter((e) => e.groupSync?.update).at(-1)!.groupSync.update.group.userState, 2);
    assert.equal((await L.conn.chats()).find((c: any) => c.id === T).readOnly, true);
    await assert.rejects(L.conn.send(T, { text: "x" }), /no longer a member/); await assert.rejects(L.conn.leaveChat(T), /no longer a member/);
    const M = "PHONE001/" + hexId(9n); await L.conn.leaveChat(M); await waitFor(() => w.be.outbox.length === 4);
    const ds = w.be.outbox.slice(2).map((x) => openIncoming(x, (x.receiver === "ALICE001" ? alice : bob).peer.sk, w.phone.me.pk)!);
    assert.deepEqual(ds.map((o) => [o.type, idsOf(o.body.subarray(8))]), [[Ty.GROUP_SETUP, []], [Ty.GROUP_SETUP, []]], "empty member list = dissolved");
    assert.equal((await L.conn.chats()).find((c: any) => c.id === M).readOnly, true);
  } finally { await L.stop(); await w.close(); }
});

test("mentions: @Name spans become @[ID] in groups only; received @[ID] shows the name", async () => {
  const w = await world(); const bob = w.phone.addContact("BOBBOB02", { first: "Bob", last: "Builder" }); w.phone.addContact("ALICE001", { first: "Alice" });
  w.phone.groups.push({ creator: "PHONE001", id: 9n, name: "Crew", members: ["ALICE001", "BOBBOB02"] });
  const L = await linked(factory, w, { phoneOnline: true }); const G = "PHONE001/" + hexId(9n);
  try {
    const text = "hi @Bob Builder, see you";
    await L.conn.send(G, { text, mentions: [{ id: "BOBBOB02", name: "Bob Builder", start: 3, length: 12 }, { id: "bad", name: "x", start: 0, length: 2 }, { id: "ALICE001", name: "y", start: 5, length: 2 }] });
    const o = openIncoming(w.be.outbox.find((x) => x.receiver === "BOBBOB02")!, bob.peer.sk, w.phone.me.pk)!; assert.equal(ascii(o.body.subarray(16)), "hi @[BOBBOB02], see you");
    await L.conn.send("BOBBOB02", { text: "hey @Bob", mentions: [{ id: "BOBBOB02", name: "Bob", start: 4, length: 4 }] });
    assert.equal(ascii(openIncoming(w.be.outbox.at(-1)!, bob.peer.sk, w.phone.me.pk)!.body), "hey @Bob", "1:1 chats have no mentions");
    await w.phone.incoming("BOBBOB02", 8001n, Ty.TEXT, textBody("ping @[ALICE001] and @[@@@@@@@@]"));
    await waitFor(() => L.of("message").some((m: any) => /ping/.test(m.text)));
    assert.equal(L.of("message").find((m: any) => /ping/.test(m.text)).text, "ping @Alice and @All");
  } finally { await L.stop(); await w.close(); }
});

test("privacy: read receipts and typing indicator are synced settings; changing them reflects a settings update and changes behaviour", async () => {
  const w = await world(); const alice = w.phone.addContact("ALICE001", { first: "Alice" });
  const L = await linked(factory, w, { phoneOnline: true });
  try {
    let l = await L.conn.getPrivacy(); assert.deepEqual(l.map((x: any) => [x.id, x.value]), [["read_receipts", "send"], ["typing", "send"]]);
    l = await L.conn.setPrivacy("read_receipts", "off"); assert.equal(l[0].value, "off");
    const up = envelopes(w).filter((e) => e.settingsSync?.update).at(-1)!.settingsSync.update.settings; assert.equal(up.readReceiptPolicy, 1); assert.equal(up.typingIndicatorPolicy, undefined);
    await w.phone.incoming("ALICE001", 7001n, Ty.TEXT, textBody("a")); await waitFor(() => L.of("message").length === 1);
    await L.conn.markRead("ALICE001", hexId(7001n)); await wait(150); assert.equal(w.be.outbox.length, 0, "no read receipt is sent any more");
    l = await L.conn.setPrivacy("typing", "off"); assert.equal(l[1].value, "off"); assert.equal(envelopes(w).filter((e) => e.settingsSync?.update).at(-1)!.settingsSync.update.settings.typingIndicatorPolicy, 1);
    await L.conn.setTyping("ALICE001", true); await wait(150); assert.equal(w.be.outbox.length, 0);
    await L.conn.setPrivacy("read_receipts", "send"); await L.conn.setPrivacy("typing", "send");
    await L.conn.setTyping("ALICE001", true); await waitFor(() => w.be.outbox.length === 1); assert.equal(openIncoming(w.be.outbox[0], alice.peer.sk, w.phone.me.pk)!.type, Ty.TYPING);
    await assert.rejects(L.conn.setPrivacy("nope", "off"), /Unknown/); await assert.rejects(L.conn.setPrivacy("typing", "maybe"), /Unknown/);
  } finally { await L.stop(); await w.close(); }
});

test("creator answers a group-sync-request from a member while leading (phone offline)", async () => {
  const w = await world(); const alice = w.phone.addContact("ALICE001", { first: "Alice" });
  w.phone.groups.push({ creator: "PHONE001", id: 9n, name: "Crew", members: ["ALICE001"] });
  const L = await linked(factory, w, { phoneOnline: false });
  try {
    await waitFor(() => [...w.be.groups.values()][0].leader !== undefined, 3000, "leader"); await waitFor(() => w.be.received.some((r) => r.type === 0x03), 3000, "unblock");
    const idb = Buffer.alloc(8); idb.writeBigUInt64LE(9n);
    w.be.send(alice.peer, "PHONE001", w.phone.me.pk, Ty.GROUP_SYNC_REQ, idb);
    await waitFor(() => w.be.outbox.filter((x) => x.receiver === "ALICE001").length >= 2, 5000, "setup + name");
    const got = w.be.outbox.filter((x) => x.receiver === "ALICE001").map((x) => openIncoming(x, alice.peer.sk, w.phone.me.pk)!.type); assert.ok(got.includes(Ty.GROUP_SETUP) && got.includes(Ty.GROUP_NAME));
  } finally { await L.stop(); await w.close(); }
});
