// node --test (via tsx): heartbeat logic with fake timers.   cd apps/ui && npx tsx --test src/heartbeat.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Heartbeat } from "./heartbeat";

function rig(opts: Partial<ConstructorParameters<typeof Heartbeat>[0]> = {}) {
  let t = 0; const q: { at: number; f: () => void; id: number }[] = []; let id = 0;
  const setT = ((f: () => void, ms: number) => { const h = { at: t + ms, f, id: ++id }; q.push(h); return h as any; }) as any;
  const clrT = ((h: any) => { const i = q.findIndex((x) => x.id === h?.id); if (i >= 0) q.splice(i, 1); }) as any;
  const events: string[] = []; const env = { silent: false, pings: 0, restarts: 0 };
  const hb = new Heartbeat({ ping: () => { env.pings++; return env.silent ? new Promise(() => {}) : Promise.resolve({ pong: true }); }, restart: async () => { env.restarts++; }, emit: (s) => events.push(s),
    setTimeout: setT, clearTimeout: clrT, now: () => t, ...opts });
  const advance = async (ms: number) => { const end = t + ms; for (;;) { q.sort((a, b) => a.at - b.at); const n = q[0]; if (!n || n.at > end) break; q.shift(); t = Math.max(t, n.at); n.f(); for (let i = 0; i < 20; i++) await Promise.resolve(); } t = end; };
  return { hb, env, events, advance };
}

test("healthy backend: pings every interval, never reports down", async () => {
  const r = rig(); r.hb.start(); await r.advance(35_000);
  assert.equal(r.env.pings, 3); assert.deepEqual(r.events, []); assert.equal(r.hb.state, "up");
});
test("silent backend: down after two misses, pending calls fail, new calls fail fast, up again when it answers", async () => {
  const r = rig(); r.hb.start();
  let rejected = ""; const never = r.hb.guard(() => new Promise(() => {})).catch((e) => { rejected = e.message; });
  r.env.silent = true; await r.advance(10_000 + 6_000 + 2_000 + 6_000 + 100);
  assert.deepEqual(r.events, ["down"]); await never; assert.match(rejected, /lost/);
  await assert.rejects(r.hb.guard(async () => 1), /Reconnecting/);
  r.env.silent = false; await r.advance(3_000);
  assert.deepEqual(r.events, ["down", "up"]); assert.equal(await r.hb.guard(async () => 7), 7);
});
test("one slow ping does not flip the state (downAfter = 2)", async () => {
  const r = rig(); r.hb.start(); r.env.silent = true; await r.advance(10_000 + 6_000 + 100); r.env.silent = false; await r.advance(10_000);
  assert.deepEqual(r.events, []); assert.equal(r.hb.misses, 0);
});
test("long silence asks the native side for a restart once per cooldown", async () => {
  const r = rig(); r.hb.start(); r.env.silent = true; await r.advance(120_000);
  assert.equal(r.env.restarts, 1, "once"); await r.advance(200_000);
  assert.ok(r.env.restarts >= 2 && r.env.restarts <= 3, "again only after the cooldown: " + r.env.restarts);
});
test("hidden page: no pings while up; kick() on resume pings at once", async () => {
  let vis = false; const r = rig({ visible: () => vis }); r.hb.start(); await r.advance(60_000); assert.equal(r.env.pings, 0);
  vis = true; r.hb.kick(); await r.advance(10); assert.equal(r.env.pings, 1);
});
test("kick() after a silent period detects the dead backend within one ping timeout + retry", async () => {
  const r = rig(); r.hb.start(); r.env.silent = true; r.hb.kick(); await r.advance(6_000 + 2_000 + 6_000 + 100); assert.deepEqual(r.events, ["down"]);
});
