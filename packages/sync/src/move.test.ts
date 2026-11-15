// Device-to-device move over the sync channel: real Hubs (fake provider) paired over loopback (127.0.0.1 only, nothing is scanned or contacted).
// After EVERY scenario the exactly-one-owner invariant is checked: at most one device runs the account, and when the move is settled exactly one.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { NO_CAPABILITIES, type Connector, type ProviderFactory } from "@unimsg/core";
import { node, pairUp, until, type Node } from "./testkit.js";
import { MOVE_LIMITS, Stage, type MoveOptions } from "./move.js";

const ACC = "signal-aaaa";
const SECRET = "SIGNAL-SESSION-SECRET-" + randomBytes(8).toString("hex");
interface Ctl { started: number; stopped: number; loggedOut: number; failStart: boolean; failIds: Set<string>; by: Record<string, { s: number; t: number }> }
const mkProvider = (ctl: Ctl, name = "signal"): ProviderFactory => ({ name, displayName: name, login: "qr", capabilities: NO_CAPABILITIES,
  create: ({ accountId }: any) => ({ capabilities: NO_CAPABILITIES,
    async start() { if (ctl.failStart || ctl.failIds.has(accountId)) throw new Error("the service refused this session"); ctl.started++; (ctl.by[accountId] ??= { s: 0, t: 0 }).s++; }, async stop() { ctl.stopped++; (ctl.by[accountId] ??= { s: 0, t: 0 }).t++; }, async logout() { ctl.loggedOut++; }, async submitLogin() {},
    async spaces() { return []; }, async chats() { return []; }, async history() { return []; }, async members() { return []; },
    async downloadAttachment() { return { data: new Uint8Array(), mime: "x" }; }, async send() { throw new Error("n/a"); } }) as unknown as Connector,
  async importSession(dir: string) { writeFileSync(join(dir, ".resealed"), "1"); } });
const live = (c: Ctl) => c.started > c.stopped;
type Dev = Node & { ctl: Ctl; live(): boolean; move(): any[]; sessionFile: string };
const made: string[] = []; process.on("exit", () => { for (const d of made) try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } });
const tmp = (n: string) => { const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "mv-" + n + "-")); made.push(d); return d; };
/** `owner`: this device holds the login (account + session files) from the start. */
async function dev(name: string, owner: boolean, move: MoveOptions = {}, files: Record<string, Buffer | string> = { "auth/creds.json": JSON.stringify({ identityKey: SECRET }) }): Promise<Dev> {
  const ctl: Ctl = { started: 0, stopped: 0, loggedOut: 0, failStart: false, failIds: new Set(), by: {} }, dir = tmp(name);
  if (owner) for (const [rel, data] of Object.entries(files)) { const f = join(dir, "accounts", ACC, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, data); }
  const n = await node(name, "memory", dir, owner ? (s) => s.putAccount({ id: ACC, provider: "signal", label: "+49 Alice", status: "active" }) : undefined, undefined,
    { factories: [mkProvider(ctl)], opts: { move: { approvalMs: 4000, stepMs: 4000, commitMs: 700, settleMs: 40, ...move } } });
  return Object.assign(n, { ctl, live: () => live(ctl), move: () => n.svc.status().moves as any[], sessionFile: join(dir, "accounts", ACC, "auth", "creds.json") });
}
const idOf = (n: Node) => n.svc.status().deviceId as string;
const walk = (d: string, out: string[] = []): string[] => { if (!existsSync(d)) return out; for (const x of readdirSync(d)) { const p = join(d, x); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };
const leaks = (d: string, needle = SECRET) => walk(d).filter((f) => readFileSync(f).includes(needle));
const hasFiles = (n: Dev) => existsSync(n.sessionFile);
const owners = (...n: Dev[]) => n.filter((x) => x.live()).length;
/** the settled invariant */
const settledOne = async (what: string, ...n: Dev[]) => { await until(() => owners(...n) === 1, what + ": exactly one live owner"); await new Promise((r) => setTimeout(r, 150)); assert.equal(owners(...n), 1, what + ": still exactly one"); };
const stageResidue = (n: Dev) => walk(n.dir).filter((f) => /[\\/]move-[0-9a-f]{32}[\\/]/.test(f));
async function pair2(A: Dev, B: Dev) { await pairUp(A, B); }
const startMove = (from: Dev, to: Dev, confirmed = true) => from.call("syncMoveStart", { accountId: ACC, deviceId: idOf(to), confirmed });
const incoming = (n: Dev) => n.move().find((m) => m.role === "in" && m.state === "asking");
const byTid = (n: Dev, tid: string) => n.move().find((m) => m.tid === tid);
const ok = async (from: Dev, to: Dev, accept = true) => {
  const { transferId } = await startMove(from, to);
  await until(() => !!incoming(to), "the target is asked");
  await to.call("syncMoveRespond", { transferId, accept }); return transferId;
};
const quiet = () => { const seen: string[] = [], orig = { log: console.log, error: console.error, warn: console.warn, info: console.info }; for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); orig[k](...a); }; return { seen, restore: () => Object.assign(console, orig) }; };

test("happy path: confirm on both devices, the target owns the account, the source wipes WITHOUT a remote logout, no secret on a third device or in any sync database or log", async () => {
  const cap = quiet();
  try {
    const A = await dev("A", true), B = await dev("B", false), C = await dev("C", false);
    await pair2(A, B); await pair2(A, C);
    await until(() => A.svc.status().devices.every((d: any) => d.online) && B.svc.status().devices.every((d: any) => d.online), "mesh online");
    assert.ok(A.live() && hasFiles(A) && owners(A, B) === 1);
    assert.ok(A.svc.status().accounts.find((a: any) => a.id === ACC)?.canMove, "a signed-in account can be moved");
    await assert.rejects(startMove(A, B, false), /Confirm/, "the source must confirm explicitly");
    const { transferId } = await startMove(A, B);
    await until(() => !!incoming(B), "B is asked");
    const ask = incoming(B); assert.equal(ask.tid, transferId); assert.equal(ask.from, "A"); assert.equal(ask.to, "B"); assert.equal(ask.label, "+49 Alice"); assert.equal(ask.phase, "confirm");
    assert.equal(byTid(A, transferId).phase, "waiting", "the source waits for the other person");
    assert.ok(!hasFiles(B) && !B.live(), "nothing is installed before the target confirms");
    await B.call("syncMoveRespond", { transferId, accept: true });
    await until(() => byTid(A, transferId)?.phase === "done" && byTid(B, transferId)?.phase === "done", "both devices finish");
    assert.equal(readFileSync(B.sessionFile, "utf8"), JSON.stringify({ identityKey: SECRET }));
    assert.ok(existsSync(join(B.dir, "accounts", ACC, ".resealed")), "importSession ran on the target");
    assert.ok(B.live() && !A.live() && !hasFiles(A) && !existsSync(join(A.dir, "accounts", ACC)), "target owns, source wiped");
    assert.equal(A.ctl.loggedOut, 0, "no remote logout"); assert.equal(B.ctl.loggedOut, 0);
    assert.equal(A.store.listAccounts().find((a) => a.id === ACC)?.status, "archived", "the source keeps the archive");
    assert.equal(B.store.listAccounts().find((a) => a.id === ACC)?.status, "active");
    assert.deepEqual(stageResidue(B), [], "staging removed");
    await settledOne("happy", A, B);
    await new Promise((r) => setTimeout(r, 900)); // let the ledger replicate everything it is going to replicate
    assert.deepEqual(leaks(C.dir).map((f) => f.slice(C.dir.length)), [], "the third device never saw the secret (point to point only)");
    assert.deepEqual(leaks(A.dir).filter((f) => /sync\.db|\.sealed|move-/.test(f)), [], "not in A's sync database");
    assert.deepEqual(leaks(B.dir).filter((f) => !f.includes(join("accounts", ACC))), [], "on B only the account's own session file holds it");
    assert.ok(!cap.seen.some((l) => l.includes(SECRET) || l.includes(Buffer.from(SECRET).toString("base64").slice(0, 24))), "never logged");
    assert.ok(!JSON.stringify(A.svc.status()).includes(SECRET) && !JSON.stringify(B.svc.status()).includes(SECRET), "never in a status the UI can read");
  } finally { cap.restore(); }
});

test("denied on the target, cancelled by either side: the source stays the only owner, nothing is installed", async () => {
  const A = await dev("A", true, { hook: async (e) => { if (e.dir === "send" && e.t === "mv-chunk") await new Promise((r) => setTimeout(r, 60)); } }), B = await dev("B", false);
  await pair2(A, B);
  // (1) the target says no
  let tid = await ok(A, B, false);
  await until(() => byTid(A, tid)?.phase === "failed", "source learns about the no");
  assert.match(byTid(A, tid).error, /said no/); assert.ok(A.live() && hasFiles(A) && !B.live() && !hasFiles(B)); await settledOne("denied", A, B);
  // (2) the source cancels while the target is still deciding
  const r = await startMove(A, B); await until(() => !!incoming(B), "asked");
  await A.call("syncMoveCancel", { transferId: r.transferId });
  await until(() => byTid(B, r.transferId)?.phase === "failed", "the confirm on the target disappears"); assert.ok(!incoming(B));
  await assert.rejects(B.call("syncMoveRespond", { transferId: r.transferId, accept: true }), /nothing to confirm/i);
  assert.ok(A.live() && !B.live() && !hasFiles(B)); await settledOne("source cancel", A, B);
});

test("cancel by either side in the middle of the transfer rolls the target back", async () => {
  const big = { "auth/creds.json": JSON.stringify({ k: SECRET }), "store/blob.bin": randomBytes(2 * 1024 * 1024) };
  for (const who of ["target", "source"] as const) {
    const A = await dev("A" + who, true, { hook: async (e) => { if (e.dir === "send" && e.t === "mv-chunk") await new Promise((r) => setTimeout(r, 40)); } }, big), B = await dev("B" + who, false);
    await pair2(A, B);
    const tid = await ok(A, B);
    await until(() => byTid(B, tid)?.done > 0 && byTid(B, tid)?.state === "staging", "transfer running");
    await (who === "target" ? B : A).call("syncMoveCancel", { transferId: tid });
    await until(() => byTid(A, tid)?.phase === "failed" && byTid(B, tid)?.phase === "failed", "both sides ended");
    assert.ok(A.live() && hasFiles(A) && !B.live() && !hasFiles(B), who + " cancel: source untouched, nothing active on the target");
    assert.deepEqual(stageResidue(B), [], "staging rolled back"); assert.deepEqual(leaks(B.dir), [], "no secret left on the target");
    await settledOne(who + " cancel", A, B);
  }
});

test("disconnect at each step (prepare, transfer, commit sent, answer lost): exactly one owner each time, and the lost answer is resolved on reconnect", async () => {
  const scenarios: { name: string; on: "A" | "B"; at: { dir: "send" | "recv"; t: string; nth?: number }; winner: "A" | "B" }[] = [
    { name: "prepare", on: "B", at: { dir: "recv", t: "mv-prepare" }, winner: "A" },
    { name: "transfer", on: "B", at: { dir: "recv", t: "mv-chunk", nth: 2 }, winner: "A" },
    { name: "commit", on: "A", at: { dir: "send", t: "mv-commit" }, winner: "A" },
    { name: "answer (done) lost", on: "B", at: { dir: "send", t: "mv-done" }, winner: "B" },
    { name: "ack path: target answered, connection dies on the source's wipe", on: "A", at: { dir: "send", t: "mv-ack" }, winner: "B" },
  ];
  for (const sc of scenarios) {
    const holder = {} as { A?: Dev; B?: Dev }; let n = 0, fired = false;
    const hook: MoveOptions["hook"] = (e) => { if (fired || e.dir !== sc.at.dir || e.t !== sc.at.t) return; if (++n < (sc.at.nth ?? 1)) return; fired = true; (holder[sc.on]!.svc as any).sessions.forEach((s: any) => s.ch.close()); };
    const files = { "auth/creds.json": JSON.stringify({ k: SECRET }), "store/blob.bin": randomBytes(1024 * 1024) };
    const A = (holder.A = await dev("A", true, sc.on === "A" ? { hook } : {}, files)), B = (holder.B = await dev("B", false, sc.on === "B" ? { hook } : {}));
    await pair2(A, B);
    const { transferId } = await startMove(A, B);
    await until(() => !!incoming(B) || fired, sc.name + ": asked"); if (!fired || sc.at.t !== "mv-prepare") await B.call("syncMoveRespond", { transferId, accept: true }).catch(() => {});
    assert.ok(fired || (await until(() => fired, "the cut happens", 8000), true));
    assert.ok(owners(A, B) <= 2);
    // reconnect and settle
    await until(() => !!(A.svc.status().devices.find((d: any) => d.id === idOf(B))?.online && B.svc.status().devices.find((d: any) => d.id === idOf(A))?.online), sc.name + ": reconnected", 15000);
    await until(() => ["done", "failed"].includes(byTid(A, transferId)?.state), sc.name + ": the source reaches a final state", 15000);
    await until(() => !["asking", "staging", "staged", "committing"].includes(byTid(B, transferId)?.state), sc.name + ": the target reaches a final state", 15000);
    await settledOne(sc.name, A, B);
    if (sc.winner === "A") assert.ok(A.live() && hasFiles(A) && !B.live() && !hasFiles(B) && byTid(A, transferId).state === "failed", sc.name + ": source stays the owner (" + byTid(A, transferId).state + ")");
    else assert.ok(B.live() && hasFiles(B) && !A.live() && !hasFiles(A) && byTid(A, transferId).state === "done", sc.name + ": target owns, source wiped");
    assert.equal(A.ctl.loggedOut + B.ctl.loggedOut, 0); assert.deepEqual(stageResidue(B), [], sc.name + ": no staging left");
    // the same transfer id can never be used again, whatever the outcome
    const sess = (A.svc as any).sessions.get(idOf(B));
    await sess.ch.send({ t: "mv-prepare", mv: 1, tid: transferId, acct: ACC, provider: "signal", label: "x", files: 1, bytes: 1, fromName: "A" });
    await new Promise((r) => setTimeout(r, 200)); assert.ok(!incoming(B), sc.name + ": a replayed id is refused"); await settledOne(sc.name + " after replay", A, B);
  }
});

test("lost ACK: the target committed, the source sees nothing for a while (both briefly live), then learns the result by asking and wipes exactly once", async () => {
  let drop = true;
  const A = await dev("A", true, { commitMs: 1500 }), B = await dev("B", false, { hook: (e) => (e.dir === "send" && e.t === "mv-done" && drop ? "drop" : undefined) });
  await pair2(A, B);
  const tid = await ok(A, B);
  await until(() => byTid(B, tid)?.state === "owned", "the target is the durable owner");
  assert.equal(byTid(A, tid).state, "committing", "the source does not know yet"); assert.ok(hasFiles(A) && A.live() && B.live(), "both are live for a moment; the source did NOT wipe on its own");
  drop = false; // the network is back: the source asks (timer) and gets the binding answer
  await until(() => byTid(A, tid)?.state === "done", "resolved by the query", 8000);
  await settledOne("lost ack", A, B); assert.ok(!hasFiles(A) && hasFiles(B)); assert.equal(A.ctl.stopped, 1, "stopped exactly once");
  await new Promise((r) => setTimeout(r, 800)); assert.equal(A.ctl.stopped, 1, "never wiped twice");
});

test("a tampered chunk (bad checksum) stops the move: the target installs nothing, the source stays the owner", async () => {
  const A = await dev("A", true, { tamper: (m) => { if (m.f === 0 && m.i === 0) { const b = Buffer.from(m.d); b[0] ^= 1; return b; } return undefined; } }), B = await dev("B", false);
  await pair2(A, B);
  const tid = await ok(A, B);
  await until(() => byTid(A, tid)?.phase === "failed" && byTid(B, tid)?.phase === "failed", "both end");
  assert.match(byTid(B, tid).error, /damaged|checksum/i); assert.ok(A.live() && hasFiles(A) && !B.live() && !hasFiles(B)); assert.deepEqual(stageResidue(B), []);
  await settledOne("tamper", A, B);
});

test("the target cannot start the account: the move is rolled back, the source keeps the account and is told why", async () => {
  const A = await dev("A", true), B = await dev("B", false); await pair2(A, B);
  await until(() => B.store.listAccounts().some((a) => a.id === ACC), "B knows the account as an archive from the sync");
  B.ctl.failStart = true;
  const tid = await ok(A, B);
  await until(() => byTid(A, tid)?.phase === "failed" && byTid(B, tid)?.phase === "failed", "both end");
  assert.match(byTid(A, tid).error, /refused/); assert.ok(A.live() && hasFiles(A) && A.ctl.stopped === 0, "the source never stopped");
  assert.ok(!B.live() && !hasFiles(B), "target rolled back: no files"); assert.equal(B.store.listAccounts().find((a) => a.id === ACC)?.status, "archived", "target is back to its read-only archive");
  assert.deepEqual(leaks(B.dir), []); await settledOne("start failed", A, B);
  // and it works afterwards with a fresh transfer id
  B.ctl.failStart = false; const t2 = await ok(A, B); await until(() => byTid(A, t2)?.phase === "done", "second attempt"); assert.notEqual(t2, tid); await settledOne("retry", A, B); assert.ok(B.live());
});

test("moving back: B hands the account back to A (a new transfer id), and the old one stays refused", async () => {
  const A = await dev("A", true), B = await dev("B", false); await pair2(A, B);
  const t1 = await ok(A, B); await until(() => byTid(A, t1)?.phase === "done", "A -> B"); await settledOne("A->B", A, B); assert.ok(B.live());
  await until(() => !!A.svc.status().devices.find((d: any) => d.id === idOf(B))?.online, "online");
  assert.ok(!!B.svc.status().accounts.find((a: any) => a.id === ACC)?.canMove);
  const t2 = await ok(B, A); assert.notEqual(t1, t2);
  await until(() => byTid(B, t2)?.phase === "done" && byTid(A, t2)?.phase === "done", "B -> A");
  await settledOne("B->A", A, B); assert.ok(A.live() && hasFiles(A) && !B.live() && !hasFiles(B)); assert.equal(readFileSync(A.sessionFile, "utf8"), JSON.stringify({ identityKey: SECRET }));
  assert.equal(B.ctl.loggedOut + A.ctl.loggedOut, 0);
});

test("a 20 MB session (many files, one big one) arrives bit for bit", async () => {
  const files: Record<string, Buffer | string> = { "auth/creds.json": JSON.stringify({ k: SECRET }), "store/big.db": randomBytes(13 * 1024 * 1024), "store/empty.bin": Buffer.alloc(0) };
  for (let i = 0; i < 20; i++) files[`keys/k${i}.bin`] = randomBytes(400 * 1024);
  const A = await dev("A", true, {}, files), B = await dev("B", false); await pair2(A, B);
  const want = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, createHash("sha256").update(v).digest("hex")]));
  const tid = await ok(A, B); await until(() => byTid(A, tid)?.phase === "done", "done", 60000);
  for (const [k, h] of Object.entries(want)) assert.equal(createHash("sha256").update(readFileSync(join(B.dir, "accounts", ACC, k))).digest("hex"), h, k);
  assert.ok(byTid(B, tid).total >= 20 * 1024 * 1024); await settledOne("large", A, B);
});

test("guards: only paired devices, one move at a time, rate limit, offline target, unsupported provider, account live on the target", async () => {
  const A = await dev("A", true), B = await dev("B", false, { maxPrepares: 3 }), S = await dev("S", false); await pair2(A, B);
  // a stranger (not in the group) cannot make a frame count, even by calling the handler
  assert.equal((B.svc as any).moves.onFrame("not-a-device", { t: "mv-prepare", mv: 1, tid: "0".repeat(32), acct: ACC, provider: "signal", label: "x", files: 1, bytes: 1 }), true);
  assert.ok(!B.move().length, "nothing recorded for an unpaired sender");
  await assert.rejects(A.call("syncMoveStart", { accountId: ACC, deviceId: idOf(S), confirmed: true }), /not one of your paired/);
  await assert.rejects(A.call("syncMoveStart", { accountId: "nope", deviceId: idOf(B), confirmed: true }), /Unknown account|nothing to move/);
  // second move while one is waiting
  const r = await startMove(A, B); await assert.rejects(startMove(A, B), /still running/); await until(() => !!incoming(B), "asked");
  await B.call("syncMoveRespond", { transferId: r.transferId, accept: false }); await until(() => byTid(A, r.transferId)?.phase === "failed", "first ended");
  // rate limit: more than maxPrepares in the window are refused without a dialog
  const sess = (A.svc as any).sessions.get(idOf(B));
  for (let i = 0; i < 4; i++) await sess.ch.send({ t: "mv-prepare", mv: 1, tid: randomBytes(16).toString("hex"), acct: ACC, provider: "signal", label: "x", files: 1, bytes: 1, fromName: "A" });
  await new Promise((x) => setTimeout(x, 300));
  const asking = B.move().filter((m) => m.state === "asking"); assert.ok(asking.length <= 1, "at most one dialog, the rest refused (busy / rate)");
  assert.ok(B.move().length <= 3, "the fourth prepare was dropped by the rate limit");
  // unsupported provider
  const sess2 = (A.svc as any).sessions.get(idOf(B)); const before = B.move().length;
  await sess2.ch.send({ t: "mv-prepare", mv: 1, tid: randomBytes(16).toString("hex"), acct: "x-1", provider: "whatsapp", label: "x", files: 1, bytes: 1, fromName: "A" });
  await new Promise((x) => setTimeout(x, 200)); assert.equal(B.move().length, before, "unsupported provider: no dialog");
  await settledOne("guards", A, B);
});

test("the offline target is not offered; a move cannot start towards a device that dropped", async () => {
  const A = await dev("A", true), B = await dev("B", false); await pair2(A, B);
  const bid = idOf(B); await B.stop();
  await until(() => !A.svc.status().devices.find((d: any) => d.id === bid)?.online, "B offline");
  await assert.rejects(A.call("syncMoveStart", { accountId: ACC, deviceId: bid, confirmed: true }), /not online/); assert.ok(A.live() && hasFiles(A));
});

test("staging is sealed on disk and gone after clear; the limits are enforced", () => {
  const d = tmp("stage"), s = new Stage(d, randomBytes(32), "a".repeat(32)); const data = Buffer.from("TOP-SECRET-" + "x".repeat(100));
  s.put(0, data); assert.deepEqual(leaks(d, "TOP-SECRET"), [], "sealed at rest"); assert.ok(s.get(0).equals(data)); s.clear(); assert.deepEqual(walk(d), []);
  const m = new Stage(undefined, randomBytes(32), "b".repeat(32)); m.put(3, data); assert.ok(m.get(3).equals(data)); assert.ok(MOVE_LIMITS.bytes >= 20 * 1024 * 1024);
});

test("an account that is already signed in on the target is refused before the target is asked", async () => {
  const A = await dev("A", true), B = await dev("B", true); await pair2(A, B);
  const { transferId } = await startMove(A, B);
  await until(() => byTid(A, transferId)?.phase === "failed", "refused");
  assert.match(byTid(A, transferId).error, /already signed in/); assert.ok(!incoming(B)); assert.ok(A.live() && hasFiles(A));
  assert.equal(owners(A, B), 2, "(both were signed in before: the move changed nothing)");
});


// ---------------------------------------------------------------- history copies (mirrors), relayed copies, several accounts at once
const liveOf = (n: Dev, id: string) => (n.ctl.by[id]?.s ?? 0) > (n.ctl.by[id]?.t ?? 0);
const chat = (id: string) => id + ":c1";
async function devM(name: string, ids: string[] | null, move: MoveOptions = {}, files: Record<string, Buffer> = {}): Promise<Dev> {
  const ctl: Ctl = { started: 0, stopped: 0, loggedOut: 0, failStart: false, failIds: new Set(), by: {} }, dir = tmp(name);
  for (const id of ids ?? []) { const f = join(dir, "accounts", id, "auth", "creds.json"); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, JSON.stringify({ k: SECRET + id })); for (const [rel, d] of Object.entries(files)) { mkdirSync(join(dir, "accounts", id, rel, ".."), { recursive: true }); writeFileSync(join(dir, "accounts", id, rel), d); } }
  const n = await node(name, "memory", dir, ids ? (s) => { for (const id of ids) { s.putAccount({ id, provider: "signal", label: "Acct " + id.slice(-2), status: "active" }); s.putMessages([{ id: "m1", chatId: chat(id), sender: "Bob", senderId: "bob", text: "hello " + id, time: "2026-01-01T00:00:00Z", fromMe: false }]); } } : undefined, undefined,
    { factories: [mkProvider(ctl)], opts: { move: { approvalMs: 4000, stepMs: 4000, commitMs: 700, settleMs: 40, ...move } } });
  return Object.assign(n, { ctl, live: () => live(ctl), move: () => n.svc.status().moves as any[], sessionFile: "" });
}
const IDS = ["signal-a1", "signal-a2", "signal-a3"];
const startMany = (from: Dev, to: Dev, ids: string[]) => from.call("syncMoveStart", { accountIds: ids, deviceId: idOf(to), confirmed: true });
const batchAsk = (n: Dev) => n.move().find((m) => m.role === "in" && m.state === "asking");
const states = (n: Dev, role: "in" | "out") => Object.fromEntries(n.move().filter((m) => m.role === role).map((m) => [m.acct, m.state]));

test("target holds only a HISTORY COPY of the account (archive-only, messages mirrored): the move succeeds, messages stay, exactly one owner", async () => {
  const A = await devM("A", ["signal-m1"]), B = await devM("B", null); await pair2(A, B);
  await until(() => !!B.store.getMessage(chat("signal-m1"), "m1") && B.store.listAccounts().some((a) => a.id === "signal-m1"), "B has the mirror");
  assert.equal(B.store.listAccounts()[0].status, "archived"); assert.ok(!liveOf(B, "signal-m1"));
  const r = await A.call("syncMoveStart", { accountId: "signal-m1", deviceId: idOf(B), confirmed: true });
  await until(() => !!batchAsk(B), "asked"); await B.call("syncMoveRespond", { transferId: r.transferId, accept: true });
  await until(() => byTid(A, r.transferId)?.phase === "done", "done");
  assert.ok(liveOf(B, "signal-m1") && !liveOf(A, "signal-m1")); assert.equal(B.store.listAccounts().find((a) => a.id === "signal-m1")?.status, "active");
  assert.equal(B.store.getMessage(chat("signal-m1"), "m1")?.text, "hello signal-m1", "the history copy is kept");
  assert.equal(A.store.listAccounts().find((a) => a.id === "signal-m1")?.status, "archived"); assert.equal(A.store.getMessage(chat("signal-m1"), "m1")?.text, "hello signal-m1");
});

test("target uses the account THROUGH the source (relay): the relay is detached, the real login replaces it, one owner (the reported laptop -> phone case)", async () => {
  const A = await devM("A", ["signal-r1"]), B = await devM("B", null); await pair2(A, B);
  await until(() => B.store.listAccounts().some((a) => a.id === "signal-r1"), "mirror");
  await A.call("syncSetProxyShare", { accountId: "signal-r1", enabled: true });
  await until(() => B.svc.status().proxy.offers.some((o: any) => o.accountId === "signal-r1"), "offer");
  await B.call("syncUseProxy", { deviceId: idOf(A), accountId: "signal-r1" });
  await until(() => !!B.svc.status().accounts.find((a: any) => a.id === "signal-r1")?.proxyVia, "relayed");
  const r = await A.call("syncMoveStart", { accountId: "signal-r1", deviceId: idOf(B), confirmed: true });
  await until(() => !!batchAsk(B), "not refused as 'already signed in'"); await B.call("syncMoveRespond", { transferId: r.transferId, accept: true });
  await until(() => byTid(A, r.transferId)?.phase === "done", "done");
  const acc = B.svc.status().accounts.find((a: any) => a.id === "signal-r1");
  assert.ok(!acc?.proxyVia, "relay detached"); assert.ok(acc?.canMove, "now a real login");
  assert.ok(liveOf(B, "signal-r1") && !liveOf(A, "signal-r1")); assert.equal(B.store.getMessage(chat("signal-r1"), "m1")?.text, "hello signal-r1");
  assert.equal(B.svc.status().proxy.using.length, 0);
});

test("several accounts: one confirm on the target lists them all, they move one after the other, one failure does not stop the others, one owner per account", async () => {
  const A = await devM("A", IDS), B = await devM("B", null); await pair2(A, B);
  B.ctl.failIds.add("signal-a2");
  await startMany(A, B, IDS);
  await until(() => !!batchAsk(B), "asked once");
  const ask = batchAsk(B); assert.deepEqual(ask.batch.items.map((i: any) => i.acct), IDS); assert.equal(ask.batch.n, 3);
  await B.call("syncMoveRespond", { transferId: ask.tid, accept: true });
  await until(() => ["done", "failed"].every(() => Object.values(states(A, "out")).every((x) => x === "done" || x === "failed")) && Object.keys(states(A, "out")).length === 3, "all settled", 20000);
  assert.deepEqual(states(A, "out"), { "signal-a1": "done", "signal-a2": "failed", "signal-a3": "done" });
  assert.match(A.move().find((m) => m.acct === "signal-a2").error, /refused/);
  assert.equal(B.move().filter((m) => m.state === "asking").length, 0, "no second prompt");
  for (const id of IDS) assert.equal(Number(liveOf(A, id)) + Number(liveOf(B, id)), 1, id + ": exactly one owner");
  assert.ok(liveOf(A, "signal-a2") && liveOf(B, "signal-a1") && liveOf(B, "signal-a3"));
});

test("several accounts: the target says no to all / unticks one; cancel stops the rest and rolls back only the one in flight", async () => {
  let A = await devM("A1", IDS), B = await devM("B1", null); await pair2(A, B);
  await startMany(A, B, IDS); await until(() => !!batchAsk(B), "asked"); await B.call("syncMoveRespond", { transferId: batchAsk(B).tid, accept: false });
  await until(() => Object.values(states(A, "out")).every((x) => x === "failed") && Object.keys(states(A, "out")).length === 3, "all refused");
  for (const id of IDS) assert.ok(liveOf(A, id) && !liveOf(B, id));
  A = await devM("A2", IDS); B = await devM("B2", null); await pair2(A, B);
  await startMany(A, B, IDS); await until(() => !!batchAsk(B), "asked");
  await B.call("syncMoveRespond", { transferId: batchAsk(B).tid, accept: true, accountIds: ["signal-a1", "signal-a3"] });
  await until(() => Object.keys(states(A, "out")).length === 3 && Object.values(states(A, "out")).every((x) => x === "done" || x === "failed"), "settled", 20000);
  assert.deepEqual(states(A, "out"), { "signal-a1": "done", "signal-a2": "failed", "signal-a3": "done" }); assert.ok(liveOf(A, "signal-a2") && !liveOf(B, "signal-a2"));
  // cancel while the second one is in flight
  const big = { "store/blob.bin": randomBytes(1024 * 1024) };
  A = await devM("A3", IDS, { hook: async (e) => { if (e.dir === "send" && e.t === "mv-chunk") await new Promise((r) => setTimeout(r, 40)); } }, big); B = await devM("B3", null); await pair2(A, B);
  await startMany(A, B, IDS); await until(() => !!batchAsk(B), "asked"); await B.call("syncMoveRespond", { transferId: batchAsk(B).tid, accept: true });
  await until(() => states(A, "out")["signal-a1"] === "done", "first done", 20000);
  await until(() => states(A, "out")["signal-a2"] === "sending", "second in flight", 20000);
  await A.call("syncMoveCancel", { transferId: A.move().find((m) => m.acct === "signal-a2").tid });
  await until(() => states(A, "out")["signal-a2"] === "failed" && states(A, "out")["signal-a3"] === "failed", "second rolled back, third never started", 10000);
  assert.ok(liveOf(B, "signal-a1") && !liveOf(A, "signal-a1")); assert.ok(liveOf(A, "signal-a2") && !liveOf(B, "signal-a2")); assert.ok(liveOf(A, "signal-a3") && !liveOf(B, "signal-a3"));
  assert.ok(!existsSync(join(B.dir, "accounts", "signal-a2")) && !existsSync(join(B.dir, "accounts", "signal-a3")), "nothing of the cancelled ones on the target");
});

// ---------------------------------------------------------------- chat history with the move
const mediaOf = (n: Dev) => (n.hub as any).media as { put(a: string, k: string, v: any): void; get(a: string, k: string): { data: Uint8Array; mime: string } | undefined; has(a: string, k: string): boolean };
/** the account's archive on `n`: messages in 2 chats, a few with a cached attachment; a chat cache, an alias and a flag */
function seedHistory(n: Dev, id: string, msgs = 300, files = 4) {
  const all = Array.from({ length: msgs }, (_, i) => ({ id: "h" + i, chatId: `${id}:c${i % 2}`, sender: "Bob", senderId: "bob", text: `history ${id} #${i}`, time: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), fromMe: false, ...(i < files ? { attachments: [{ id: "att" + i, kind: "image", name: "p.png", mime: "image/png", size: 1 }] } : {}) }));
  n.store.putMessages(all as any);
  for (let i = 0; i < files; i++) mediaOf(n).put(id, `${id}:c${i % 2}|h${i}|att${i}`, { data: randomBytes(50_000 + i * 7), mime: "image/png", name: "p.png" });
  n.store.putChatCache(id, { chats: [{ id: "c0", accountId: id, title: "Chat zero" } as any], spaces: [] }); n.store.setAlias(`${id}:c0`, "Zero alias"); n.store.setChatFlags(`${id}:c1`, { pinned: true });
}
const countMsgs = (n: Dev, id: string) => [0, 1].reduce((t, c) => t + n.store.listMessages(`${id}:c${c}`, { limit: 100000 }).filter((m) => m.id !== "m1").length, 0);
const mediaSum = (n: Dev, id: string, files = 4) => Array.from({ length: files }, (_, i) => { const b = mediaOf(n).get(id, `${id}:c${i % 2}|h${i}|att${i}`); return b ? createHash("sha256").update(b.data).digest("hex") : "-"; }).join();
async function histPair(opts: { a?: MoveOptions; b?: MoveOptions; ids?: string[]; msgs?: number } = {}) {
  const ids = opts.ids ?? ["signal-h1"], A = await devM("A", ids, opts.a), B = await devM("B", null, opts.b); await pair2(A, B);
  for (const id of ids) { await A.call("syncSetAccountMode", { accountId: id, mode: "none" }); } // so the ordinary sync does not carry the archive: only the move does
  for (const id of ids) { A.store.deleteAccountData?.(id); A.store.putAccount({ id, provider: "signal", label: "Acct " + id.slice(-2), status: "active" }); seedHistory(A, id, opts.msgs); }
  return { A, B, ids };
}
const finish = async (A: Dev, B: Dev, tid: string, answer: any = {}) => { await until(() => !!batchAsk(B) || byTid(A, tid)?.phase === "failed", "asked"); if (batchAsk(B)) await B.call("syncMoveRespond", { transferId: tid, accept: true, ...answer }); };

test("history: the target gets the complete archive (message counts, chat list, names, flags) and the cached files byte for byte; the source keeps its copy", async () => {
  const { A, B, ids } = await histPair({ msgs: 800 }); const id = ids[0];
  assert.equal(countMsgs(A, id), 800); assert.ok(!B.store.getMessage(`${id}:c0`, "h0"), "nothing arrived by ordinary sync");
  const est = await A.call("syncMoveEstimate", { accountIds: [id], includeMedia: true });
  assert.equal(est.messages, 800); assert.equal(est.files, 4); assert.ok(est.bytes > 200_000, "the size includes the files");
  const r = await A.call("syncMoveStart", { accountId: id, deviceId: idOf(B), confirmed: true });
  await finish(A, B, r.transferId); await until(() => byTid(A, r.transferId)?.phase === "done", "done", 20000);
  assert.equal(countMsgs(B, id), 800, "counts equal"); assert.equal(B.store.getMessage(`${id}:c1`, "h799")?.text, `history ${id} #799`);
  assert.equal(mediaSum(B, id), mediaSum(A, id), "media bytes equal"); assert.ok(mediaSum(B, id).split(",").every((x) => x !== "-"));
  assert.equal((B.store.getChatCache(id)?.chats[0] as any).title, "Chat zero"); assert.equal(B.store.listAliases()[`${id}:c0`], "Zero alias"); assert.equal(B.store.listChatFlags()[`${id}:c1`]?.pinned, true);
  assert.equal(byTid(A, r.transferId).histDone.m, 800);
  assert.equal(countMsgs(A, id), 800, "the source keeps its archive by default"); assert.ok(mediaOf(A).has(id, `${id}:c0|h0|att0`));
  assert.ok(liveOf(B, id) && !liveOf(A, id)); await settledOnly(A, B, id);
});
const settledOnly = async (A: Dev, B: Dev, id: string) => { await new Promise((r) => setTimeout(r, 200)); assert.equal(Number(liveOf(A, id)) + Number(liveOf(B, id)), 1, "exactly one owner"); };

test("history: without media only the messages go; 'remove the history from this device afterwards' deletes it here only after the target holds it, and it does not come back", async () => {
  const { A, B, ids } = await histPair({ msgs: 200 }); const id = ids[0];
  const r = await A.call("syncMoveStart", { accountId: id, deviceId: idOf(B), confirmed: true, includeMedia: false, removeHistoryAfter: true });
  await finish(A, B, r.transferId); await until(() => byTid(A, r.transferId)?.phase === "done", "done", 20000);
  assert.equal(countMsgs(B, id), 200); assert.ok(!mediaOf(B).has(id, `${id}:c0|h0|att0`), "no files when not asked for");
  assert.equal(countMsgs(A, id), 0, "removed here"); assert.ok(!mediaOf(A).has(id, `${id}:c0|h0|att0`));
  await new Promise((x) => setTimeout(x, 1000)); assert.equal(countMsgs(A, id), 0, "and sync does not bring it back"); assert.equal(countMsgs(B, id), 200, "the target keeps it");
  await settledOnly(A, B, id);
});

test("history: a failure in the middle keeps the login on the source (nothing committed, nothing wiped); then 'move without history' works", async () => {
  let n = 0, fired = false; const holder = {} as { A?: Dev };
  const hook: MoveOptions["hook"] = (e) => { if (!fired && e.dir === "send" && e.t === "mv-hrows" && ++n === 2) { fired = true; (holder.A!.svc as any).sessions.forEach((s: any) => s.ch.close()); } };
  const { A, B, ids } = await histPair({ a: { hook }, msgs: 3000 }); holder.A = A; const id = ids[0];
  const r = await A.call("syncMoveStart", { accountId: id, deviceId: idOf(B), confirmed: true });
  await finish(A, B, r.transferId).catch(() => {}); await until(() => byTid(A, r.transferId)?.phase === "failed", "failed", 15000);
  assert.ok(byTid(A, r.transferId).histFailed, "marked as a history failure so the UI can offer 'move without history'");
  assert.ok(liveOf(A, id) && !liveOf(B, id) && existsSync(join(A.dir, "accounts", id)) && !existsSync(join(B.dir, "accounts", id))); await settledOnly(A, B, id);
  await until(() => !!A.svc.status().devices.find((d: any) => d.id === idOf(B))?.online && !!B.svc.status().devices.find((d: any) => d.id === idOf(A))?.online, "reconnected", 15000);
  const r2 = await A.call("syncMoveStart", { accountId: id, deviceId: idOf(B), confirmed: true, includeHistory: false });
  await finish(A, B, r2.transferId); await until(() => byTid(A, r2.transferId)?.phase === "done", "done without history", 15000);
  assert.ok(liveOf(B, id) && !liveOf(A, id)); assert.equal(countMsgs(A, id), 3000, "the source still has the archive");
});

test("history: the target's confirmation of the history is lost -> the source does not commit or wipe; one owner", async () => {
  const { A, B, ids } = await histPair({ a: { stepMs: 800 }, b: { hook: (e) => (e.dir === "send" && e.t === "mv-hdone" ? "drop" : undefined) }, msgs: 50 }); const id = ids[0];
  const r = await A.call("syncMoveStart", { accountId: id, deviceId: idOf(B), confirmed: true });
  await finish(A, B, r.transferId); await until(() => byTid(A, r.transferId)?.phase === "failed", "failed", 15000);
  assert.ok(byTid(A, r.transferId).histFailed); assert.ok(liveOf(A, id) && !liveOf(B, id) && !existsSync(join(B.dir, "accounts", id)));
  await until(() => !["asking", "staging", "staged", "committing"].includes(byTid(B, r.transferId)?.state), "target settled", 15000);
  await settledOnly(A, B, id);
});

test("history: several accounts, each with its own archive and progress; one owner per account", async () => {
  const { A, B, ids } = await histPair({ ids: ["signal-h1", "signal-h2"], msgs: 120 });
  const r = await A.call("syncMoveStart", { accountIds: ids, deviceId: idOf(B), confirmed: true });
  await finish(A, B, r.transferId); await until(() => r.transferIds.every((t: string) => byTid(A, t)?.phase === "done"), "all done", 30000);
  for (const id of ids) { assert.equal(countMsgs(B, id), 120, id); assert.equal(mediaSum(B, id), mediaSum(A, id)); await settledOnly(A, B, id); }
});

test("history only: 'send this device's history of <account> to <device>' asks the receiver, merges the archive, and moves no login", async () => {
  const { A, B, ids } = await histPair({ msgs: 100 }); const id = ids[0];
  const r = await A.call("syncSendHistory", { accountId: id, deviceId: idOf(B) });
  await finish(A, B, r.transferId); await until(() => byTid(A, r.transferId)?.phase === "done", "done", 15000);
  assert.equal(countMsgs(B, id), 100); assert.equal(mediaSum(B, id), mediaSum(A, id));
  assert.ok(liveOf(A, id) && !liveOf(B, id) && !existsSync(join(B.dir, "accounts", id)), "the login stays where it was");
  // the receiver can say no
  const r2 = await A.call("syncSendHistory", { accountId: id, deviceId: idOf(B) }); await until(() => !!batchAsk(B), "asked"); await B.call("syncMoveRespond", { transferId: r2.transferId, accept: false });
  await until(() => byTid(A, r2.transferId)?.phase === "failed", "refused");
});

test("origin: a history copy / relayed copy cannot be shared onward, but an account that was MOVED here is the user's own and can be", async () => {
  const A = await devM("A", ["signal-o1"]), B = await devM("B", null); await pair2(A, B);
  await until(() => B.store.listAccounts().some((a) => a.id === "signal-o1"), "mirror");
  let acc = () => B.svc.status().accounts.find((a: any) => a.id === "signal-o1");
  assert.equal(acc()?.sharedFrom, "another device"); assert.equal(acc()?.canShareProxy, false);
  await assert.rejects(B.call("syncSetAccountMode", { accountId: "signal-o1", mode: "credentials" }), /comes from/);
  await assert.rejects(B.call("syncSetProxyShare", { accountId: "signal-o1", enabled: true }), /comes from/);
  const r = await A.call("syncMoveStart", { accountId: "signal-o1", deviceId: idOf(B), confirmed: true, includeHistory: false });
  await until(() => !!batchAsk(B), "asked"); await B.call("syncMoveRespond", { transferId: r.transferId, accept: true }); await until(() => byTid(A, r.transferId)?.phase === "done", "done");
  assert.equal(acc()?.sharedFrom, undefined, "moved here: it is ours"); assert.equal(acc()?.canShareProxy, true);
  await B.call("syncSetProxyShare", { accountId: "signal-o1", enabled: true });
});

test("status answers at once while the first start-up work is still running (the phone's Sync page must not hang on 'Loading…')", async () => {
  const A = await devM("A", ["signal-l1"]); (A.svc as any).isReady = false;
  const st: any = await Promise.race([A.call("syncStatus"), new Promise((r) => setTimeout(() => r("HUNG"), 1500))]);
  assert.notEqual(st, "HUNG"); assert.equal(st.loading, true); assert.deepEqual(st.devices, []);
  (A.svc as any).isReady = true; assert.equal((await A.call("syncStatus")).loading, undefined);
});
