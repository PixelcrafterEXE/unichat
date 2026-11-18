// Nearby pairing (no code): unauthenticated key exchange + commit/reveal numeric comparison. Loopback / in-memory only.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Server } from "node:net";
import { randomBytes } from "node:crypto";
import { accept, dial, type Secure } from "./channel.js";
import { generateKeyPair, deviceIdOf } from "./noise.js";
import { sasOf } from "./code.js";
import { NEARBY_PSK, nearbyHost, nearbyJoin } from "./nearby.js";
import { node, until, type Node } from "./testkit.js";

// ---- pure protocol on in-memory channels ----
function leg(): [Secure, Secure] {
  const t = randomBytes(32), qa: any[] = [], qb: any[] = [], wa: any[] = [], wb: any[] = [];
  const mk = (inbox: any[], waiters: any[], out: any[], outW: any[]): Secure => ({
    transcript: t, remoteStatic: Buffer.alloc(32), hello: {}, socket: undefined as any, close() {},
    async send(m: object) { const w = outW.shift(); if (w) w(m); else out.push(m); },
    recv() { return new Promise((ok) => { const m = inbox.shift(); if (m) ok(m); else waiters.push(ok); }); },
  });
  return [mk(qa, wa, qb, wb), mk(qb, wb, qa, wa)];
}
const digits = (s: Secure) => sasOf(s.transcript);

test("nearby: honest devices get the same digits, different sessions get different digits", async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const [h, j] = leg(); await Promise.all([nearbyHost(h), nearbyJoin(j)]);
    assert.equal(digits(h), digits(j)); assert.match(digits(h), /^\d{3} \d{3}$/); seen.add(digits(h));
  }
  assert.ok(seen.size > 15);
});

test("nearby: a man in the middle (two legs, both nonces honest on each leg) ends up with different digits", async () => {
  let same = 0; const N = 400;
  for (let i = 0; i < N; i++) {
    const [hLeg, mAsJoiner] = leg(), [mAsHost, jLeg] = leg(); // host <-> M <-> joiner; each leg has its own transcript
    await Promise.all([nearbyHost(hLeg), nearbyJoin(mAsJoiner), nearbyHost(mAsHost), nearbyJoin(jLeg)]);
    if (digits(hLeg) === digits(jLeg)) same++;
  }
  assert.ok(same <= 2, `collisions ${same}/${N} (expected ~${N / 1e6})`); // 10^-6 each: practically never
});

test("nearby: revealing a different nonce than committed aborts (no grinding after the fact)", async () => {
  const [h, j] = leg();
  const cheat = (async () => { // a host that commits, sees the joiner nonce, then tries another nonce
    await h.send({ t: "nb-commit", c: randomBytes(32).toString("base64") });
    await h.recv(); await h.send({ t: "nb-reveal", n: randomBytes(16).toString("base64") });
  })();
  await assert.rejects(nearbyJoin(j), /did not follow/); await cheat;
  const [h2, j2] = leg(); // junk messages
  void h2.send({ t: "x" }); await assert.rejects(nearbyJoin(j2), /bad nearby/);
  const [h3, j3] = leg(); void j3.send({ t: "nb-nonce", n: "AAAA" }); await assert.rejects(nearbyHost(h3), /bad nearby/);
});

// ---- services over loopback ----
const mine: Node[] = []; const servers: Server[] = [];
const nd = async (name: string, opts: object = {}) => { const n = await node(name, "memory", undefined, undefined, undefined, { opts }); mine.push(n); return n; };
afterEach(async () => { for (const n of mine.splice(0)) await n.stop().catch(() => {}); for (const s of servers.splice(0)) s.close(); });
const st = (n: Node) => n.call("syncStatus");
const joinNearby = (j: Node, port: number) => j.call("syncJoinNearby", { host: "127.0.0.1", port, deviceName: j.name });

test("nearby join: both people must confirm the same digits; then the joiner is a member of the host's group", async () => {
  const H = await nd("Host"), J = await nd("Joiner");
  const p = await H.call("syncStartPairing", {});
  const r = await joinNearby(J, p.port); assert.equal(r.role, "joiner");
  await until(async () => !!(await st(H)).approval, "host prompt");
  const ap = (await st(H)).approval; assert.equal(ap.nearby, true); assert.equal(ap.deviceName, "Joiner"); assert.equal(ap.sas, r.sas);
  assert.equal((await st(J)).joining.nearby, true);
  await Promise.all([J.call("syncConfirmJoin", { keepListening: true }), H.call("syncApproveJoin", { accept: true })]);
  await until(async () => (await st(J)).enabled && (await st(H)).devices.length === 2, "paired");
  assert.equal((await st(J)).groupId, (await st(H)).groupId);
});

for (const who of ["joiner", "host"] as const) test(`nearby join: a wrong confirm on the ${who} aborts and nothing is stored`, async () => {
  const H = await nd("Host", { maxPairingFailures: 9 }), J = await nd("Joiner");
  const p = await H.call("syncStartPairing", {}), before = (await st(H)).devices.length;
  await joinNearby(J, p.port); await until(async () => !!(await st(H)).approval, "prompt");
  if (who === "joiner") await Promise.allSettled([J.call("syncCancelJoin"), H.call("syncApproveJoin", { accept: true })]);
  else await Promise.allSettled([J.call("syncConfirmJoin", {}), H.call("syncApproveJoin", { accept: false })]);
  await until(async () => !(await st(H)).approval && !["confirm", "waiting"].includes((await st(J)).joining?.state), "dialogs closed");
  await new Promise((r) => setTimeout(r, 200));
  const sj = await st(J), sh = await st(H);
  assert.equal(sj.enabled, false, "the joiner got no group"); assert.equal(sh.devices.length, before, "the host added nobody");
  assert.equal((J.svc as any).ledger.kvGet("pairHints"), undefined, "no address remembered"); assert.equal((J.svc as any).ledger.kvGet("group"), undefined);
});

test("nearby is only offered while 'Add a device' is open, and a code-less peer cannot use the code path", async () => {
  const H = await nd("Host"), J = await nd("Joiner");
  const p = await H.call("syncStartPairing", {}); await H.call("syncStopPairing"); await until(async () => !(await st(H)).pairing, "closed");
  await assert.rejects(joinNearby(J, p.port), /not showing a pairing code|reach|nearby/);
  const p2 = await H.call("syncStartPairing", {});
  await assert.rejects(J.call("syncJoin", { host: "127.0.0.1", port: p2.port, code: "baba-baba-baba-baba" }), /not accepted/); // the public psk is not the code
});

test("nearby rate limits: prompt budget per session, and aborted attempts lock the source out", async () => {
  const H = await nd("Host", { maxNearbyPrompts: 2, maxPairingFailures: 99 }), J = await nd("Joiner");
  const p = await H.call("syncStartPairing", {});
  for (let i = 0; i < 2; i++) { await joinNearby(J, p.port); await until(async () => !!(await st(H)).approval, "prompt " + i); await Promise.allSettled([J.call("syncCancelJoin"), H.call("syncApproveJoin", { accept: true })]); await until(async () => !(await st(H)).approval && !(await st(J)).joining, "closed"); }
  await assert.rejects(joinNearby(J, p.port), /not showing a pairing code|reach|nearby/, "third attempt in the same session is refused");
  // lock-out: connections that start the nearby handshake and vanish
  const H2 = await nd("Host2", { maxPairingFailures: 2 }); const p2 = await H2.call("syncStartPairing", {});
  const kp = generateKeyPair();
  for (let i = 0; i < 3; i++) await new Promise<void>((ok) => { const s = connect(p2.port, "127.0.0.1"); dial(s, { mode: "nearby", psk: NEARBY_PSK, s: kp, hello: { id: deviceIdOf(kp.pub), name: "x" }, checkRemote() {} }).then((ch) => { ch.close(); }, () => {}).finally(() => setTimeout(ok, 50)); });
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(joinNearby(J, p2.port), /not showing a pairing code|reach|nearby/, "source is locked out");
});

test("nearby MITM over real sockets: an attacker relaying between the two devices produces different digits on the two screens", async () => {
  const H = await nd("Host"), J = await nd("Joiner");
  const p = await H.call("syncStartPairing", {});
  const m = generateKeyPair(), hello = (name: string) => ({ id: deviceIdOf(m.pub), name, port: 0, v: 1, grp: 0 });
  const mitm = createServer((sock) => {
    void (async () => {
      const jch = await accept(sock, { s: m, hello: hello("Host"), pskFor: () => ({ psk: NEARBY_PSK }), checkRemote() {} });
      const hs = connect(p.port, "127.0.0.1");
      const hch = await dial(hs, { mode: "nearby", psk: NEARBY_PSK, s: m, hello: hello("Joiner"), checkRemote() {} });
      await Promise.all([nearbyHost(jch), nearbyJoin(hch)]); // best effort: both legs run the protocol honestly
      // relay everything else (sas confirmations) as a dumb pipe
      const pipe = async (a: Secure, b: Secure) => { try { for (;;) await b.send(await a.recv(20_000)); } catch { /* closed */ } };
      void pipe(jch, hch); void pipe(hch, jch);
    })().catch(() => sock.destroy());
  });
  servers.push(mitm); await new Promise<void>((ok) => mitm.listen(0, "127.0.0.1", ok));
  const mport = (mitm.address() as { port: number }).port;
  const r = await joinNearby(J, mport);
  await until(async () => !!(await st(H)).approval, "host prompt");
  const hostDigits = (await st(H)).approval.sas;
  assert.notEqual(r.sas, hostDigits, "the two people see different numbers: they will not confirm");
  await Promise.allSettled([J.call("syncCancelJoin"), H.call("syncApproveJoin", { accept: false })]);
  assert.equal((await st(J)).enabled, false);
});
