// Removing a device is a group-wide, authenticated event: a tombstone (who removed it, when) travels in the members / keys frames, the removed device unlinks itself,
// and a group of two never ends up as a group of one (the other device is told to unlink first, now or when it is back online).
import test from "node:test";
import assert from "node:assert/strict";
import { node, pairUp, until, msg, type Node } from "./testkit.js";
import { mergeMembership, newGroup, newIdentity, revoke } from "./group.js";

const st = (n: Node) => n.call("syncStatus");
const dev = (n: Node, id: string): any => (n.svc.status().devices as any[]).find((d) => d.id === id);
const idOf = (n: Node) => n.svc.status().deviceId as string;
async function trio() {
  const A = await node("A", "memory", undefined, (s) => s.putMessages([msg("fake-x:c", "a1", "from A", "2026-01-01T00:00:00Z")]), undefined, { opts: { unlinkWaitMs: 1000 } });
  const B = await node("B", "memory", undefined, undefined, undefined, { opts: { unlinkWaitMs: 1000 } }), C = await node("C", "memory", undefined, undefined, undefined, { opts: { unlinkWaitMs: 1000 } });
  await pairUp(A, B); await pairUp(A, C);
  await until(() => !!B.store.getMessage("fake-x:c", "a1") && !!C.store.getMessage("fake-x:c", "a1"), "everyone has the archive");
  await until(() => [A, B, C].every((n) => n.svc.status().devices.length === 3), "3 devices known everywhere");
  return { A, B, C };
}

test("three devices: A removes C, B learns it, C is told who removed it, unlinks and keeps its archive", async () => {
  const { A, B, C } = await trio();
  const cid = idOf(C);
  await A.call("syncRevoke", { deviceId: cid });
  await until(async () => !(await st(C)).enabled, "C unlinked itself");
  const c = await st(C);
  assert.equal(c.removedNotice?.by, "A"); assert.equal(c.removedNotice?.reason, "removed");
  assert.ok(C.store.getMessage("fake-x:c", "a1"), "the archive stays");
  await until(() => !!dev(B, cid)?.revoked, "B learned the removal");
  const bc = dev(B, cid);
  assert.equal(bc.revokedBy, "A");
  await until(() => dev(A, cid)?.removalPending === false, "A knows C confirmed");
  assert.equal((await st(A)).enabled, true); assert.equal((await st(B)).enabled, true, "two remaining devices stay a group");
  assert.ok(dev(B, idOf(A))?.online);
  await C.call("syncDismissRemoved"); assert.equal((await st(C)).removedNotice, undefined);
  // a removed device cannot come back without a fresh pairing: it has a new identity and no group
  assert.notEqual(idOf(C), cid);
  await pairUp(A, C); assert.equal((await st(C)).enabled, true);
});

test("three devices: the removed device is offline, is told when it comes back (pending until then)", async () => {
  const { A, B, C } = await trio();
  const cid = idOf(C);
  await C.call("syncPause");
  await until(() => !dev(A, cid)?.online, "C offline");
  await A.call("syncRevoke", { deviceId: cid });
  assert.equal(dev(A, cid).removalPending, true);
  await until(() => dev(B, cid)?.removalPending === true, "B knows the removal is pending");
  assert.equal((await st(C)).enabled, true, "C does not know yet");
  await C.call("syncResume");
  await until(async () => !(await st(C)).enabled, "C was told when it came back", 15000);
  assert.equal((await st(C)).removedNotice?.by, "A");
  await until(() => dev(A, cid)?.removalPending === false && dev(B, cid)?.removalPending === false, "both members know C confirmed", 15000);
});

test("two devices: unlinking one tells the other first; both end unlinked", async () => {
  const A = await node("A", "memory", undefined, undefined, undefined, { opts: { unlinkWaitMs: 3000 } }), B = await node("B", "memory");
  await pairUp(A, B);
  const r = await A.call("syncLeave");
  assert.equal(r.pending, false);
  await until(async () => !(await st(B)).enabled && !(await st(A)).enabled, "both unlinked");
  const b = await st(B); assert.equal(b.removedNotice?.by, "A"); assert.equal(b.removedNotice?.reason, "unlinked");
  assert.equal((await st(A)).unlinking, undefined);
});

test("two devices: removing the other device unlinks both (removal pending when it is offline, delivered on reconnect)", async () => {
  const A = await node("A", "memory", undefined, undefined, undefined, { opts: { unlinkWaitMs: 600 } }), B = await node("B", "memory");
  await pairUp(A, B);
  await B.call("syncPause");
  await until(() => !A.svc.status().devices.find((d: any) => d.id === idOf(B))?.online, "B offline");
  const r = await A.call("syncRevoke", { deviceId: idOf(B) });
  assert.equal(r.pending, true);
  const a = await st(A);
  assert.equal(a.enabled, true, "A waits: the instruction is still to be delivered"); assert.equal(a.unlinking?.name, "B"); assert.equal(a.unlinking?.online, false);
  await assert.rejects(A.call("syncStartPairing", {}), /unlinking/);
  await B.call("syncResume");
  await until(async () => !(await st(B)).enabled && !(await st(A)).enabled, "delivered on reconnect: both unlinked", 20000);
  assert.equal((await st(B)).removedNotice?.by, "A"); assert.equal((await st(B)).removedNotice?.reason, "removed");
});

test("two devices: the user can give up waiting and unlink anyway", async () => {
  const A = await node("A", "memory", undefined, undefined, undefined, { opts: { unlinkWaitMs: 300 } }), B = await node("B", "memory");
  await pairUp(A, B); await B.call("syncPause");
  await until(() => !A.svc.status().devices.find((d: any) => d.id === idOf(B))?.online, "B offline");
  assert.equal((await A.call("syncLeave")).pending, true);
  await A.call("syncLeave", { force: true });
  const a = await st(A); assert.equal(a.enabled, false); assert.equal(a.unlinking, undefined);
});

test("three devices: two remove each other at once, the third does not stay alone in a group", async () => {
  const { A, B, C } = await trio();
  await Promise.all([A.call("syncRevoke", { deviceId: idOf(B) }), B.call("syncRevoke", { deviceId: idOf(A) })]);
  await until(async () => !(await st(A)).enabled && !(await st(B)).enabled && !(await st(C)).enabled, "everybody unlinked", 20000);
});

test("a device that leaves a group of three tells the others", async () => {
  const { A, B, C } = await trio();
  const cid = idOf(C);
  await C.call("syncLeave"); assert.equal((await st(C)).enabled, false);
  await until(() => [A, B].every((n) => dev(n, cid)?.revoked), "A and B know C left");
  assert.equal((await st(A)).enabled, true); assert.equal((await st(B)).enabled, true);
});

test("an old members list never resurrects a removed device", () => {
  const me = newIdentity("A"), other = newIdentity("B"), gone = newIdentity("C");
  const g = newGroup(me);
  for (const i of [other, gone]) g.devices[i.id] = { id: i.id, name: i.name, pub: i.pub, addedAt: new Date().toISOString() };
  const old = JSON.parse(JSON.stringify(g)); // what a lagging member still has
  revoke(g, gone.id, me.id);
  const r = mergeMembership(g, old.devices, old.keys, me.id);
  assert.deepEqual(r.revoked, []); assert.ok(g.devices[gone.id].revoked, "still removed"); assert.equal(g.devices[gone.id].revokedBy, me.id);
  // and the removal (with who did it) spreads to a member that missed it
  const lag = JSON.parse(JSON.stringify(old)), r2 = mergeMembership(lag, g.devices, g.keys, other.id);
  assert.deepEqual(r2.revoked, [gone.id]); assert.equal(lag.devices[gone.id].revokedBy, me.id);
});
