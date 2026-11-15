import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { node, until, msg } from "@unimsg/sync/testkit";
import { startRelayServer } from "./relay.js";

const rid = (c = "a") => c.repeat(64);
type Q = WebSocket & { q: { d: Buffer; bin: boolean }[]; waiters: ((m: { d: Buffer; bin: boolean }) => void)[] };
// messages are queued from the very first byte (the relay's "paired" frame can arrive in the same chunk as the upgrade response)
const open = (port: number, id: string) => new Promise<Q>((ok, fail) => {
  const w = new WebSocket(`ws://127.0.0.1:${port}/relay/${id}`) as Q; w.q = []; w.waiters = [];
  w.on("message", (d, bin) => { const m = { d: d as Buffer, bin }; const f = w.waiters.shift(); if (f) f(m); else w.q.push(m); });
  w.once("open", () => ok(w)); w.once("error", fail); w.once("unexpected-response", (req, res) => { res.resume(); req.destroy(); fail(new Error("HTTP " + res.statusCode)); });
});
const next = (w: Q) => new Promise<{ d: Buffer; bin: boolean }>((ok) => { const m = w.q.shift(); if (m) ok(m); else w.waiters.push(ok); });

test("relay: pairs two sockets, forwards binary both ways, ignores text, refuses a third, bad paths and floods", async () => {
  const r = await startRelayServer(0, "127.0.0.1", { perIpPerMinute: 30, maxPerIp: 6 });
  try {
    const a = await open(r.port, rid()), b = await open(r.port, rid()), pa = next(a), pb = next(b);
    assert.equal((await pa).d.toString(), "paired"); assert.equal((await pb).d.toString(), "paired");
    const got = next(b); a.send(Buffer.from([1, 2, 3])); const m = await got; assert.ok(m.bin); assert.deepEqual([...m.d], [1, 2, 3]);
    a.send("text is never forwarded"); const got2 = next(a); b.send(Buffer.from("back")); assert.equal((await got2).d.toString(), "back");
    await assert.rejects(open(r.port, rid()), /409/);                 // room is full
    await assert.rejects(open(r.port, "xyz"), /./);                   // not a rendezvous id
    const closed = new Promise((ok) => b.once("close", ok)); a.close(); await closed; // one side leaving closes the other, the room disappears
    await until(() => r.relay.stats().openRooms === 0, "room removed");
    // per-address cap
    const many: Q[] = []; let refused = 0;
    for (let i = 0; i < 10; i++) { try { many.push(await open(r.port, String(i).padStart(64, "0"))); } catch { refused++; } }
    assert.ok(refused >= 3, "connections per address are capped"); many.forEach((w) => w.terminate());
  } finally { r.close(); }
});

test("relay between two Hubs: no direct address, only a relay URL; frames are opaque ciphertext", async () => {
  const seen: Buffer[] = []; const r = await startRelayServer(0, "127.0.0.1", { tap: (d) => seen.push(Buffer.from(d)) });
  const A = await node("A", "memory", undefined, (s) => { s.putAccount({ id: "fake-rl", provider: "fake", label: "R", status: "active" }); s.putMessages([msg("fake-rl:c", "m1", "SECRET-PLAINTEXT-MARKER-1", "2026-01-01T00:00:00Z")]); });
  const B = await node("B", "memory");
  try {
    const p = await A.call("syncStartPairing", {}); // pairing itself needs a direct connection (code + SAS), once
    await B.call("syncJoin", { host: "127.0.0.1", port: p.port, code: p.code });
    await until(async () => !!(await A.call("syncStatus")).approval, "approval");
    await Promise.all([B.call("syncConfirmJoin", {}), A.call("syncApproveJoin", {})]);
    // from now on: nobody listens, nobody knows an address
    for (const n of [A, B]) { await n.call("syncSetListen", { enabled: false }); for (const d of Object.values<any>((n.svc as any).group.devices)) d.addrs = []; for (const s of (n.svc as any).sessions.values()) s.ch.close(); }
    await until(async () => !(await A.call("syncStatus")).listening && !(await B.call("syncStatus")).listening, "listeners closed");
    const url = `ws://127.0.0.1:${r.port}/relay`;
    await A.call("syncSetRelays", { urls: [url] }); await B.call("syncSetRelays", { urls: [url] });
    await until(async () => (await A.call("syncStatus")).devices.some((d: any) => !d.self && d.online) && (await B.call("syncStatus")).devices.some((d: any) => !d.self && d.online), "online through the relay", 20_000);
    assert.match((await B.call("syncStatus")).devices.find((d: any) => !d.self).via ?? (await A.call("syncStatus")).devices.find((d: any) => !d.self).via, /relay/);
    A.store.putMessages([msg("fake-rl:c", "m2", "SECRET-PLAINTEXT-MARKER-2", "2026-01-02T00:00:00Z")]);
    await until(() => !!B.store.getMessage("fake-rl:c", "m2") && !!B.store.getMessage("fake-rl:c", "m1"), "data crossed the relay", 15_000);
    assert.ok(r.relay.stats().bytes > 500 && r.relay.stats().paired >= 1);
    const all = Buffer.concat(seen); assert.ok(!all.includes("SECRET-PLAINTEXT-MARKER") && !all.includes("fake-rl"), "the relay saw only ciphertext");
  } finally { await A.stop(); await B.stop(); r.close(); }
});

test("hostile relay: a flipped byte or a cut connection ends that session without corrupting either archive; a fair relay then resumes and converges", async () => {
  let mode: "fair" | "flip" | "cut" = "fair", n = 0;
  const r = await startRelayServer(0, "127.0.0.1", { mangle: (d) => {
    if (mode === "fair") return d;
    if (++n < 3) return d; // let the Noise handshake and the first frames through
    if (mode === "flip") { const x = Buffer.from(d); x[x.length - 1] ^= 1; mode = "fair"; return x; }
    mode = "fair"; return null;
  } });
  const A = await node("A", "memory", undefined, (s) => { s.putAccount({ id: "fake-hr", provider: "fake", label: "H", status: "active" }); s.putMessages([msg("fake-hr:c", "m1", "one", "2026-01-01T00:00:00Z")]); });
  const B = await node("B", "memory");
  try {
    const p = await A.call("syncStartPairing", {});
    await B.call("syncJoin", { host: "127.0.0.1", port: p.port, code: p.code });
    await until(async () => !!(await A.call("syncStatus")).approval, "approval");
    await Promise.all([B.call("syncConfirmJoin", {}), A.call("syncApproveJoin", {})]);
    for (const x of [A, B]) { await x.call("syncSetListen", { enabled: false }); for (const d of Object.values<any>((x.svc as any).group.devices)) d.addrs = []; for (const s of (x.svc as any).sessions.values()) s.ch.close(); }
    await until(async () => !(await A.call("syncStatus")).listening && !(await B.call("syncStatus")).listening, "listeners closed");
    const url = `ws://127.0.0.1:${r.port}/relay`; await A.call("syncSetRelays", { urls: [url] }); await B.call("syncSetRelays", { urls: [url] });
    await until(() => !!B.store.getMessage("fake-hr:c", "m1"), "initial data through the fair relay", 30_000);
    for (const attack of ["flip", "cut"] as const) {
      await until(async () => (await A.call("syncStatus")).devices.some((d: any) => !d.self && d.online), "online through the relay", 20_000);
      mode = attack; n = 0; const id = "h-" + attack;
      A.store.putMessages([msg("fake-hr:c", id, "payload " + attack, "2026-01-02T00:00:00Z")]);
      await until(() => mode === "fair", "the attack happened", 30_000);
      await until(() => !!B.store.getMessage("fake-hr:c", id), `data arrives after the ${attack} attack (reconnect + resume)`, 40_000);
      assert.equal(B.store.getMessage("fake-hr:c", id)!.text, "payload " + attack, "never a corrupted message");
    }
  } finally { await A.stop(); await B.stop(); r.close(); }
});
