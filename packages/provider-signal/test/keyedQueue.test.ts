import test from "node:test";
import assert from "node:assert/strict";
import { KeyedQueue } from "../src/service/keyedQueue.js";

test("tasks with the same key never overlap and keep their order; other keys run in parallel; a failure does not block the lane", async () => {
  const q = new KeyedQueue(), log: string[] = []; let live = 0, maxLive = 0;
  const task = (name: string, ms: number, fail = false) => async () => { live++; maxLive = Math.max(maxLive, live); log.push("start " + name); await new Promise((r) => setTimeout(r, ms)); live--; log.push("end " + name); if (fail) throw new Error(name); return name; };
  const a1 = q.run("a", task("a1", 30)), a2 = q.run("a", task("a2", 1, true)), a3 = q.run("a", task("a3", 1));
  await a1; assert.equal(maxLive, 1, "same key: strictly one at a time");
  await assert.rejects(a2, /a2/); assert.equal(await a3, "a3", "a failed task does not block the next one");
  assert.deepEqual(log.filter((l) => l.startsWith("start")), ["start a1", "start a2", "start a3"]);
  const t0 = Date.now(); await Promise.all([q.run("x", task("x", 40)), q.run("y", task("y", 40))]); assert.ok(Date.now() - t0 < 75, "different keys run in parallel");
});
