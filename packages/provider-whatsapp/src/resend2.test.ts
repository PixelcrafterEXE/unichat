// More placeholder-resend queue behaviour (concurrency, failures, revive, removal while in flight) + decrypt-failure classification.
import test from "node:test";
import assert from "node:assert/strict";
import { ResendQueue, type Pending } from "./resend.js";
import { NoiseCounter, classifyConsole, classifyDecryptError, installConsoleFilter } from "./libnoise.js";

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
    pending: () => q.length,
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
const entry = (id: string, chatId = "c@g.us") => ({ chatId, id, fromMe: false });
const base = (clock: ReturnType<typeof fakeClock>, request: (e: Pending) => Promise<unknown>, extra: object = {}) =>
  ({ timers: clock.timers, canRun: () => true, onChange() {}, onGiveUp() {}, request, ...extra });

test("at most `concurrency` requests are in flight; a finishing one lets the next start", async () => {
  const clock = fakeClock(); const releases: (() => void)[] = []; const started: string[] = [];
  const q = new ResendQueue({}, base(clock, (e) => { started.push(e.id); return new Promise<void>((r) => releases.push(r)); }, { spacingMs: 0, concurrency: 2 }));
  for (const id of ["a", "b", "c", "d"]) q.add(entry(id));
  await clock.advance(10);
  assert.deepEqual(started, ["a", "b"]);
  releases[0]!(); await clock.advance(10);
  assert.deepEqual(started, ["a", "b", "c"]);
});

test("a rejected request does not wedge the queue and is retried on the normal backoff", async () => {
  const clock = fakeClock(); const times: number[] = []; const store: Record<string, Pending> = {};
  const q = new ResendQueue(store, base(clock, async () => { times.push(clock.now()); throw new Error("Connection Closed"); }));
  q.add(entry("a")); q.add(entry("b"));
  await clock.advance(31_000);
  assert.deepEqual(times, [0, 1500, 30_000, 31_500].slice(0, times.length));
  assert.ok(times.includes(30_000));
  assert.equal(store.a!.attempts, 2);
});

test("removing an entry while its request is in flight: no re-arm, no give-up", async () => {
  const clock = fakeClock(); let release!: () => void; const gave: string[] = []; let n = 0;
  const q = new ResendQueue({}, base(clock, () => { n++; return new Promise<void>((r) => { release = r; }); }, { onGiveUp: (e: Pending) => gave.push(e.id) }));
  q.add(entry("a")); await clock.advance(10);
  assert.equal(q.remove("a"), true);
  release(); await clock.advance(10 * 3600_000);
  assert.equal(n, 1); assert.deepEqual(gave, []); assert.equal(q.has("a"), false);
  assert.equal(q.remove("a"), false);
});

test("kick(revive) restarts a given-up entry from zero; plain kick leaves it given up", async () => {
  const clock = fakeClock(); const times: number[] = []; const store: Record<string, Pending> = {};
  const q = new ResendQueue(store, base(clock, async () => { times.push(clock.now()); }));
  q.add(entry("a")); await clock.advance(10 * 3600_000);
  assert.equal(store.a!.gaveUp, true); const n = times.length;
  q.kick(); await clock.advance(10_000);
  assert.equal(times.length, n);
  q.kick(true); await clock.advance(10_000);
  assert.equal(times.length, n + 1);
  assert.equal(store.a!.gaveUp, false); assert.equal(store.a!.attempts, 1);
});

test("kick during the final grace wait asks once more instead of giving up early", async () => {
  const clock = fakeClock(); const times: number[] = []; const gave: string[] = []; const store: Record<string, Pending> = {};
  const q = new ResendQueue(store, base(clock, async () => { times.push(clock.now()); }, { onGiveUp: (e: Pending) => gave.push(e.id) }));
  q.add(entry("a"));
  await clock.advance(3_930_000 + 10);               // 4 requests done, in the final wait
  assert.equal(store.a!.final, true); assert.equal(times.length, 4);
  q.kick(); await clock.advance(10_000);
  assert.deepEqual(gave, []); assert.equal(times.length, 5);
  await clock.advance(200_000);
  assert.deepEqual(gave, ["a"]);
});

test("list filters by chat and includes given-up entries; size counts only live ones", async () => {
  const clock = fakeClock(); const q = new ResendQueue({}, base(clock, async () => {}));
  q.add(entry("a", "x@g.us")); q.add(entry("b", "y@g.us")); q.add({ ...entry("c", "x@g.us"), rj: "r", pj: "p" });
  assert.deepEqual(q.list("x@g.us").map((e) => e.id).sort(), ["a", "c"]);
  assert.equal(q.list().length, 3);
  assert.equal(q.list("x@g.us").find((e) => e.id === "c")!.pj, "p");
});

test("skipped() ignores unknown ids and entries that never attempted", async () => {
  const clock = fakeClock(); const store: Record<string, Pending> = {};
  const q = new ResendQueue(store, base(clock, async () => {}, { canRun: () => false }));
  q.add(entry("a"));
  q.skipped("a"); q.skipped("nope");
  assert.equal(store.a!.attempts, 0); assert.equal(store.a!.skips, undefined);
});

test("while the socket is closed no timer keeps spinning", async () => {
  const clock = fakeClock(); const q = new ResendQueue({}, base(clock, async () => {}, { canRun: () => false }));
  q.add(entry("a")); await clock.advance(1000);
  assert.equal(clock.pending(), 0);
});

test("a restored entry with garbage `next` values (undefined, NaN, string) is due now", () => {
  const clock = fakeClock();
  const store = { a: { ...entry("a"), attempts: 1, next: undefined }, b: { ...entry("b"), attempts: 0, next: NaN }, c: { ...entry("c"), attempts: 0, next: "x" } } as unknown as Record<string, Pending>;
  new ResendQueue(store, base(clock, async () => {}, { canRun: () => false }));
  for (const e of Object.values(store)) assert.equal(e.next, 0);
});

// ---- decrypt failure classification ----
test("classifyDecryptError: every known libsignal/Baileys reason maps to a stable kind", () => {
  const m = "failed to decrypt message";
  const cases: [string | undefined, string][] = [
    ["Bad MAC", "decrypt-bad-mac"], ["bad mac", "decrypt-bad-mac"],
    ["Session error:Error: Bad MAC", "decrypt-bad-mac"],
    ["No matching sessions found for message", "decrypt-no-session"],
    ["No session found to decrypt message", "decrypt-no-session"],
    ["No session record", "decrypt-no-session"],
    ["No SenderKeyRecord found for decryption", "decrypt-no-sender-key"],
    ["Invalid PreKey ID", "decrypt-prekey"],
    ["Key used already or never filled", "decrypt-prekey"],
    ["Invalid public key", "decrypt-other"],
    ["", "decrypt-other"], [undefined, "decrypt-other"],
  ];
  for (const [e, want] of cases) assert.equal(classifyDecryptError(m, e), want, String(e));
  assert.equal(classifyDecryptError("failed to decrypt", "Bad MAC"), undefined); // only the exact static message
  assert.equal(classifyDecryptError("", "Bad MAC"), undefined);
});

test("classifyDecryptError: Bad MAC wins over a session mention in the same message", () => {
  assert.equal(classifyDecryptError("failed to decrypt message", "Bad MAC (No session record)"), "decrypt-bad-mac");
});

test("classifyConsole: only the first string argument counts, lifecycle dumps are all swallowed", () => {
  for (const s of ["Closing session:", "Opening session:", "Removing old closed session:", "Migrating session to:", "Session already closed", "Session already open", "Closing open session in favor of incoming prekey bundle"])
    assert.equal(classifyConsole([s, { dump: 1 }]), "signal-session-lifecycle", s);
  assert.equal(classifyConsole(["WARNING: Expected pubkey of length 33, please report the ST and client that generated the pubkey"]), "signal-pubkey");
  assert.equal(classifyConsole(["Session error:Error: Bad MAC"]), "signal-bad-mac");
  assert.equal(classifyConsole(["prefix Session error:Error: Bad MAC"]), undefined); // must start with it
  assert.equal(classifyConsole([]), undefined);
  assert.equal(classifyConsole([undefined, "Session error:"]), undefined);
  assert.equal(classifyConsole([123]), undefined);
});

test("console filter: counter summary is sorted, resets per interval, totals persist; non-installed targets untouched", () => {
  const out: unknown[][] = [];
  const target: Record<string, unknown> = { log: (...a: unknown[]) => out.push(a), info() {}, warn() {}, error() {} };
  const c = new NoiseCounter(); installConsoleFilter(c, target);
  const log = target.log as (...a: unknown[]) => void, warn = target.warn as (...a: unknown[]) => void;
  log("Closing session:", {}); warn("Failed to decrypt message with any known session..."); log("Closing session:", {}); log("hello", 1);
  assert.deepEqual(out, [["hello", 1]]);
  assert.equal(c.take(), "signal-no-session=1 signal-session-lifecycle=2");
  log("Closing session:"); assert.equal(c.take(), "signal-session-lifecycle=1");
  assert.equal(c.totalOf("signal-session-lifecycle"), 3);
  assert.equal(c.totalOf("never"), 0);
});
