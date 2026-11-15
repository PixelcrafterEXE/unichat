import test from "node:test";
import assert from "node:assert/strict";
import { ResendQueue, type Pending } from "./resend.js";

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
function fakeClock() {
  let t = 0, id = 0;
  const q: { at: number; fn: () => void; id: number }[] = [];
  return {
    now: () => t,
    timers: {
      now: () => t,
      set: (fn: () => void, ms: number) => { const h = ++id; q.push({ at: t + ms, fn, id: h }); return h; },
      clear: (h: unknown) => { const i = q.findIndex((x) => x.id === h); if (i >= 0) q.splice(i, 1); },
    },
    async advance(ms: number) {
      await flush();
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const n = q[0];
        if (!n || n.at > end) break;
        q.shift(); t = n.at; n.fn(); await flush();
      }
      t = end; await flush();
    },
  };
}
const entry = (id: string) => ({ chatId: "c@g.us", id, fromMe: false });

test("requests are rate limited: one start per 1.5s", async () => {
  const clock = fakeClock(); const starts: [string, number][] = [];
  const q = new ResendQueue({}, { timers: clock.timers, canRun: () => true, onChange() {}, onGiveUp() {}, request: async (e) => { starts.push([e.id, clock.now()]); } });
  for (const id of ["a", "b", "c", "d", "e"]) q.add(entry(id));
  await clock.advance(7000);
  assert.deepEqual(starts.map((s) => s[1]), [0, 1500, 3000, 4500, 6000]);
  assert.equal(new Set(starts.map((s) => s[0])).size, 5); // deduplicated per id: each exactly once so far
});

test("duplicate adds are ignored", async () => {
  const clock = fakeClock(); let n = 0;
  const q = new ResendQueue({}, { timers: clock.timers, canRun: () => true, onChange() {}, onGiveUp() {}, request: async () => { n++; } });
  q.add(entry("a")); q.add(entry("a")); q.add(entry("a"));
  await clock.advance(1000);
  assert.equal(n, 1);
});

test("backoff 30s / 5min / 1h, then the placeholder is given up exactly once", async () => {
  const clock = fakeClock(); const times: number[] = []; const gave: string[] = [];
  const q = new ResendQueue({}, { timers: clock.timers, canRun: () => true, onChange() {}, onGiveUp: (e) => gave.push(e.id), request: async () => { times.push(clock.now()); } });
  q.add(entry("a"));
  await clock.advance(10 * 3600_000);
  assert.deepEqual(times, [0, 30_000, 330_000, 3_930_000]);
  assert.deepEqual(gave, ["a"]);
  assert.equal(q.size(), 0);           // given up entries are no longer pending
  assert.equal(q.has("a"), true);       // but remembered
});

test("a resolved placeholder is never requested again", async () => {
  const clock = fakeClock(); const times: number[] = [];
  const q = new ResendQueue({}, { timers: clock.timers, canRun: () => true, onChange() {}, onGiveUp() {}, request: async () => { times.push(clock.now()); } });
  q.add(entry("a"));
  await clock.advance(1000);
  assert.equal(q.remove("a"), true);
  await clock.advance(3600_000);
  assert.deepEqual(times, [0]);
});

test("nothing is sent while the socket is closed; the pending set survives a restart and resumes on kick()", async () => {
  const clock = fakeClock(); let open = false; const times: number[] = [];
  const store: Record<string, Pending> = {};
  const mk = (s: Record<string, Pending>) => new ResendQueue(s, { timers: clock.timers, canRun: () => open, onChange() {}, onGiveUp() {}, request: async () => { times.push(clock.now()); } });
  const q1 = mk(store);
  q1.add(entry("a")); q1.add(entry("b"));
  await clock.advance(60_000);
  assert.deepEqual(times, []);
  // "restart": the cache is serialized and reloaded
  const reloaded = JSON.parse(JSON.stringify(store)) as Record<string, Pending>;
  const q2 = mk(reloaded);
  assert.equal(q2.size(), 2);
  open = true;
  q2.kick();                       // reconnect
  await clock.advance(4000);
  assert.equal(times.length, 2);
  assert.equal(reloaded.a!.attempts, 1);
  // after another reconnect still-pending entries are due again immediately
  q2.kick();
  await clock.advance(4000);
  assert.equal(times.length, 4);
});

test("a request interrupted by a restart (in-flight marker serialized as null) is due again at once", async () => {
  const clock = fakeClock(); const times: number[] = [];
  const q1 = new ResendQueue({}, { timers: clock.timers, canRun: () => true, onChange() {}, onGiveUp() {}, request: () => new Promise(() => {}) }); // never answers
  const store: Record<string, Pending> = {};
  const q0 = new ResendQueue(store, { timers: clock.timers, canRun: () => true, onChange() {}, onGiveUp() {}, request: () => new Promise(() => {}) });
  q0.add(entry("a")); await clock.advance(10);
  assert.equal(store.a!.next, Infinity);
  const reloaded = JSON.parse(JSON.stringify(store)) as Record<string, Pending>;
  assert.equal(reloaded.a!.next, null);
  const q2 = new ResendQueue(reloaded, { timers: clock.timers, canRun: () => true, onChange() {}, onGiveUp() {}, request: async () => { times.push(clock.now()); } });
  assert.equal(typeof reloaded.a!.next, "number");
  q2.pump(); await clock.advance(10);
  assert.equal(times.length, 1);
  void q1;
});

test("a request Baileys swallowed ('already requested') gives the attempt back, at most twice", async () => {
  const clock = fakeClock(); const times: number[] = [];
  const store: Record<string, Pending> = {};
  const q: ResendQueue = new ResendQueue(store, { timers: clock.timers, canRun: () => true, onChange() {}, onGiveUp() {}, request: async (e) => { times.push(clock.now()); q.skipped(e.id); } });
  q.add(entry("a"));
  await clock.advance(200_000);
  // 1st request + 2 free retries, then 30s apart; attempts only advance after the free skips are used up
  assert.deepEqual(times.slice(0, 4), [0, 30_000, 60_000, 90_000]);
  assert.equal(store.a!.skips, 2);
  assert.ok(store.a!.attempts >= 1);
});
