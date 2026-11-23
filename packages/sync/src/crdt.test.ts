import test from "node:test";
import assert from "node:assert/strict";
import { joinMessage, joinReg, canon, recSig, rxDiff, rxFromReactions, rxJoin, rxToReactions, SEP, type MsgRec, type Rx } from "./crdt.js";
import { Clock } from "./hlc.js";
import type { Message } from "@unimsg/core";

const base: Message = { id: "1", chatId: "a:c", sender: "x", senderId: "x", text: "hi", time: "2026-01-01T00:00:00Z", fromMe: false };
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const stamp = (n: number) => `${String(1000 + n).padStart(13, "0")}-0000-${pick(["d1", "d2", "d3"])}`;
function randRec(): MsgRec {
  const m: Message = { ...base };
  if (rnd() < 0.5) { m.text = pick(["hi", "hello", "yo"]); m.editedAt = pick(["2026-01-01T01:00:00Z", "2026-01-01T02:00:00Z"]); }
  if (rnd() < 0.3) m.deleted = true;
  if (rnd() < 0.5) m.status = pick(["sent", "delivered", "read"] as const);
  if (rnd() < 0.6) m.reactions = rnd() < 0.3 ? [] : [{ emoji: pick(["👍", "❤️"]), senderIds: [pick(["u1", "u2"])] }];
  const r = stamp(Math.floor(rnd() * 5));
  const rec: MsgRec = { m, c: stamp(Math.floor(rnd() * 5)), r };
  if (rnd() < 0.6) { // explicit element sets with adds and tombstones
    const x: Rx = {};
    for (let i = 0; i < 4; i++) x[pick(["👍", "❤️"]) + SEP + pick(["u1", "u2", "u3"])] = { h: stamp(Math.floor(rnd() * 5)), on: rnd() < 0.6 };
    rec.x = x;
  }
  return rec;
}
const same = (a: MsgRec, b: MsgRec) => assert.equal(recSig(a), recSig(b));
test("message join is commutative, associative and idempotent (random)", () => {
  for (let i = 0; i < 500; i++) {
    const a = randRec(), b = randRec(), c = randRec();
    same(joinMessage(a, b), joinMessage(b, a));
    same(joinMessage(joinMessage(a, b), c), joinMessage(a, joinMessage(b, c)));
    same(joinMessage(a, a), joinMessage(joinMessage(a, a), a));
  }
});
test("random interleavings of delivery converge to one state", () => {
  const recs = Array.from({ length: 8 }, randRec);
  const fold = (order: MsgRec[]) => order.reduce((acc, x) => joinMessage(acc, x));
  const want = recSig(fold(recs));
  for (let i = 0; i < 100; i++) {
    const shuffled = [...recs].sort(() => rnd() - 0.5), dup = [...shuffled, ...shuffled.slice(0, 4)].sort(() => rnd() - 0.5);
    assert.equal(recSig(fold(dup)), want);
  }
});
test("edit beats the stale unedited copy, deletion is sticky and clears reactions, status only moves forward", () => {
  const z = "0000000000000-0000-d1";
  const stale: MsgRec = { m: { ...base }, c: "0000000009000-0000-d2", r: z };
  const edited: MsgRec = { m: { ...base, text: "fixed", editedAt: "2026-01-01T05:00:00Z", status: "sent" }, c: "0000000001000-0000-d1", r: z };
  const j = joinMessage(stale, edited); assert.equal(j.m.text, "fixed");
  const del = joinMessage(j, { m: { ...base, deleted: true, status: "read" }, c: z, r: z });
  assert.ok(del.m.deleted); assert.deepEqual(del.m.reactions, []); assert.equal(del.m.status, "read");
  const rx = joinMessage(del, { m: { ...base, reactions: [{ emoji: "👍", senderIds: ["u"] }] }, c: z, r: "0000000099999-0000-d3" });
  assert.deepEqual(rx.m.reactions, []);
});
test("reactions are an add/remove set: concurrent reactions of two devices both survive, a removal beats only the add it saw", () => {
  const z = "0000000000000-0000-d1";
  const none: MsgRec = { m: { ...base }, c: z, r: z };
  // device 1 adds 👍 by u1, device 2 concurrently adds ❤️ by u2: both stay (whole-set LWW lost one of them)
  const d1: MsgRec = { m: { ...base, reactions: [{ emoji: "👍", senderIds: ["u1"] }] }, c: z, r: "0000000002000-0000-d1", x: rxDiff({}, [{ emoji: "👍", senderIds: ["u1"] }], "0000000002000-0000-d1") };
  const d2: MsgRec = { m: { ...base, reactions: [{ emoji: "❤️", senderIds: ["u2"] }] }, c: z, r: "0000000002500-0000-d2", x: rxDiff({}, [{ emoji: "❤️", senderIds: ["u2"] }], "0000000002500-0000-d2") };
  const both = joinMessage(joinMessage(none, d1), d2);
  assert.deepEqual(both.m.reactions, [{ emoji: "❤️", senderIds: ["u2"] }, { emoji: "👍", senderIds: ["u1"] }]);
  assert.equal(recSig(both), recSig(joinMessage(d2, d1)));
  // u1 removes 👍 (tombstone, later stamp): the removal propagates and does not touch u2's reaction
  const x3 = rxDiff(both.x!, [{ emoji: "❤️", senderIds: ["u2"] }], "0000000003000-0000-d1");
  const rem: MsgRec = { m: { ...base, reactions: [{ emoji: "❤️", senderIds: ["u2"] }] }, c: z, r: "0000000003000-0000-d1", x: x3 };
  assert.deepEqual(joinMessage(both, rem).m.reactions, [{ emoji: "❤️", senderIds: ["u2"] }]);
  assert.deepEqual(joinMessage(rem, both).m.reactions, [{ emoji: "❤️", senderIds: ["u2"] }]);
  // ... but a CONCURRENT re-add (stamp later than the removal) wins: add-wins only by stamp, never by arrival order
  const readd: MsgRec = { m: { ...base }, c: z, r: "0000000004000-0000-d2", x: { ["👍" + SEP + "u1"]: { h: "0000000004000-0000-d2", on: true } } };
  assert.equal(joinMessage(joinMessage(both, rem), readd).m.reactions?.length, 2);
  assert.equal(rxToReactions(rxJoin(rxFromReactions([{ emoji: "a", senderIds: ["x"] }], z), {})).length, 1);
});
test("registers: higher stamp wins, device id is the tiebreak, tombstones are registers", () => {
  const a = { h: "0000000001000-0000-d1", v: "x" }, b = { h: "0000000001000-0000-d2", v: "y" };
  assert.equal(joinReg(a, b).v, "y"); assert.equal(joinReg(b, a).v, "y");
  const t = { h: "0000000002000-0000-d1", tomb: true }; assert.ok(joinReg(a, t).tomb);
  assert.equal(canon({ b: 1, a: [undefined] }), '{"a":[null],"b":1}');
});
test("hlc: monotone, observes remote, rejects far-future stamps", () => {
  let t = 5000; const c = new Clock("dev", () => t);
  const a = c.tick(), b = c.tick(); assert.ok(b > a);
  assert.ok(c.observe("0000000009000-0003-other")); assert.ok(c.tick() > "0000000009000-0003-other");
  assert.ok(!c.observe(`${String(t + 3 * 86400_000).padStart(13, "0")}-0000-x`)); assert.ok(!c.observe("garbage"));
});

test("pins are their own last-writer-wins register: the later pin/unpin wins, independent of text edits, commutative and idempotent", () => {
  const z = "0000000000000-0000-d1";
  const pinned: MsgRec = { m: { ...base, pinned: true, pinnedAt: "2026-02-01T00:00:00Z", pinnedBy: "u1", pinnedUntil: "2026-02-08T00:00:00Z" }, c: z, r: z, p: "0000000002000-0000-d1" };
  const unpinned: MsgRec = { m: { ...base }, c: z, r: z, p: "0000000003000-0000-d2" };
  const edited: MsgRec = { m: { ...base, text: "fixed", editedAt: "2026-01-02T00:00:00Z" }, c: "0000000001000-0000-d3", r: z };
  assert.equal(joinMessage(pinned, unpinned).m.pinned, undefined); assert.equal(joinMessage(unpinned, pinned).m.pinned, undefined); // the later unpin beats the earlier pin
  const repin: MsgRec = { ...pinned, p: "0000000004000-0000-d1" };
  const j = joinMessage(joinMessage(unpinned, repin), edited);
  assert.equal(j.m.pinned, true); assert.equal(j.m.pinnedBy, "u1"); assert.equal(j.m.pinnedUntil, "2026-02-08T00:00:00Z"); assert.equal(j.m.text, "fixed"); assert.equal(j.p, "0000000004000-0000-d1");
  assert.equal(recSig(joinMessage(j, j)), recSig(j)); assert.equal(recSig(joinMessage(edited, joinMessage(repin, unpinned))), recSig(j));
  assert.equal(joinMessage(repin, { m: { ...base, deleted: true }, c: z, r: z }).m.pinned, undefined); // a deleted message is not pinned
});

test("a network notice stays a notice: the system mark survives the join, and a copy that has it replaces one that lost it", () => {
  const sys: MsgRec = { m: { ...base, sender: "", senderId: "", text: "L started a thread: x", system: { kind: "info" } }, c: "0000000001000-0000-d1", r: "0000000001000-0000-d1" };
  assert.deepEqual(joinMessage(sys, sys).m.system, { kind: "info" }); // first arrival on another device
  const lost: MsgRec = { ...sys, m: { ...sys.m, system: undefined } };
  assert.deepEqual(joinMessage(lost, sys).m.system, { kind: "info" });
  assert.deepEqual(joinMessage(sys, lost).m.system, { kind: "info" });
  assert.notEqual(recSig(joinMessage(lost, sys)), recSig(lost)); // so a re-sent copy is applied, not skipped as "nothing changed"
});
