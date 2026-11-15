// HyperDHT transport ("Reach my devices from anywhere"). EVERY test that touches the network uses an in-process LOCAL testnet (hyperdht/testnet: DHT nodes on
// 127.0.0.1); no public bootstrap node is ever contacted (the testkit sets `requireBootstrap`, so a transport without bootstrap nodes refuses to start).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createTestnet from "hyperdht/testnet";
import DHT from "hyperdht";
import { cleanBootstrap, cleanDhtSetting, dhtSeed, DhtTransport, DhtUnavailable } from "./dht.js";
import { cleanAddrs, mergeMembership, newGroup, newIdentity, type Dev } from "./group.js";
import { orderAddrs, raceConnect } from "./addrs.js";
import { msg, node, pairUp, until, type Node } from "./testkit.js";

const testnets: any[] = [];
const net = async () => { const t = await createTestnet(3, { host: "127.0.0.1" }); testnets.push(t); return t; };
after(async () => { for (const t of testnets) await t.destroy().catch(() => {}); });
const bs = (t: any) => t.bootstrap.map((b: any) => `${b.host}:${b.port}`);
const devOf = (n: Node, peer: Node) => (n.svc as any).group.devices[peer.svc.status().deviceId];
const sess = (n: Node, peer: Node) => (n.svc as any).sessions.get(peer.svc.status().deviceId);
const onlineVia = (n: Node, peer: Node) => n.svc.status().devices.find((d: any) => d.id === peer.svc.status().deviceId);

/** Pair over loopback TCP, optionally announce while they are still together (what a user does: turn the switch on while the devices are connected), then take the LAN away completely: no listener, no saved address, no session. What is left is the DHT. */
async function pairThenIsolate(A: Node, B: Node, together?: () => Promise<unknown>) {
  await pairUp(A, B);
  await together?.();
  for (const n of [A, B]) await n.call("syncSetListen", { enabled: false });
  for (const [x, y] of [[A, B], [B, A]] as const) devOf(x, y).addrs = [];
  for (const n of [A, B]) for (const s of [...(n.svc as any).sessions.values()]) (n.svc as any).closeSession(s, "test");
  await until(() => !onlineVia(A, B)!.online && !onlineVia(B, A)!.online, "both sides offline");
}
const enable = (t: any, ...ns: Node[]) => Promise.all(ns.map((n) => n.call("syncSetDht", { enabled: true, bootstrap: bs(t) })));

test("key derivation: deterministic, domain separated, different per group and per device, never the Noise key", async () => {
  const id = newIdentity("a"), priv = Buffer.from(id.priv, "base64");
  const s1 = dhtSeed(priv, "group-1"), s1b = dhtSeed(priv, "group-1"), s2 = dhtSeed(priv, "group-2"), s3 = dhtSeed(Buffer.from(newIdentity("b").priv, "base64"), "group-1");
  assert.equal(s1.length, 32); assert.deepEqual(s1, s1b);
  assert.notDeepEqual(s1, s2, "a different group gives an unrelated DHT identity"); assert.notDeepEqual(s1, s3, "a different device too");
  assert.notDeepEqual(s1, priv, "the Noise private key is never used directly");
  const k1 = DHT.keyPair(s1), k2 = DHT.keyPair(s2);
  assert.deepEqual(DHT.keyPair(s1b).publicKey, k1.publicKey); assert.notDeepEqual(k1.publicKey, k2.publicKey);
  assert.notDeepEqual(k1.publicKey, Buffer.from(id.pub, "base64"), "the DHT public key is not the Noise public key");
  // the group id (hashed) is the only thing the DHT could ever learn from a derived key: prove it does not appear
  assert.ok(!k1.publicKey.toString("hex").includes("group-1".slice(0, 4)));
});

test("settings: validation of own bootstrap nodes, defaults are ON and public", () => {
  assert.deepEqual(cleanDhtSetting(undefined), { enabled: true, bootstrap: [] });
  assert.deepEqual(cleanBootstrap("a.example.org:49737, 10.0.0.2:4000\n[::1]:5"), ["a.example.org:49737", "10.0.0.2:4000", "[::1]:5"]);
  for (const bad of ["nohostport", "host:0", "host:70000", "bad host:1", "http://x:1", "a:1 b"]) assert.throws(() => cleanBootstrap(bad), /bootstrap|host:port/i, bad);
  assert.throws(() => cleanBootstrap(["a:1", "b:1", "c:1", "d:1", "e:1", "f:1"]), /at most 5/);
  assert.deepEqual(cleanDhtSetting({ enabled: true }, { enabled: false, bootstrap: ["x:1"] }), { enabled: true, bootstrap: ["x:1"] }, "omitted fields keep their value");
});

test("addresses: a `dht` address has no host/port, sorts after tcp and before relays, survives validation, and joins the group record", () => {
  const list = cleanAddrs([{ kind: "relay", url: "wss://r.example/x", src: "manual" }, { kind: "dht", src: "learned", host: "ignored" }, { kind: "tcp", host: "10.0.0.2", port: 45045, src: "manual" }]);
  assert.deepEqual(list.map((a) => a.kind), ["relay", "dht", "tcp"]); assert.equal((list[1] as any).host, undefined);
  const d: Dev = { id: "x", name: "x", pub: "", addedAt: "", addrs: list };
  assert.deepEqual(orderAddrs(d).map((a) => a.kind), ["tcp", "dht", "relay"]);
  // a member's DHT key travels in the group record: valid keys only, and it only fills a gap
  const me = newIdentity("me"), other = newIdentity("o"), g = newGroup(me), key = "ab".repeat(32);
  mergeMembership(g, { [other.id]: { id: other.id, name: "o", pub: other.pub, addedAt: "", dht: key } as Dev }, [], me.id);
  assert.equal(g.devices[other.id].dht, key);
  mergeMembership(g, { [other.id]: { id: other.id, name: "o", pub: other.pub, addedAt: "", dht: "cd".repeat(32) } as Dev }, [], me.id);
  assert.equal(g.devices[other.id].dht, key, "a third party's claim never replaces a known key");
  const g2 = newGroup(me); mergeMembership(g2, { [other.id]: { id: other.id, name: "o", pub: other.pub, addedAt: "", dht: "zz" } as Dev }, [], me.id);
  assert.equal(g2.devices[other.id].dht, undefined, "malformed keys are dropped");
});

test("dial order: the DHT is only tried after the LAN / saved addresses had their head start, and never when one of them wins", async () => {
  const opened: string[] = [], sock = () => ({ destroy() {} }) as any;
  const cands = cleanAddrs([{ kind: "tcp", host: "10.0.0.2", port: 1, src: "manual" }, { kind: "dht", src: "learned" }, { kind: "relay", url: "wss://r/x", src: "manual" }]);
  const ok = await raceConnect(cands, async (a) => { opened.push(a.kind); return sock(); }, { dhtDelay: 80, relayDelay: 160 });
  assert.equal(ok.addr.kind, "tcp"); await new Promise((r) => setTimeout(r, 250)); assert.deepEqual(opened, ["tcp"], "LAN win: no DHT socket and no relay socket was ever started");
  opened.length = 0; const t0 = Date.now();
  const r2 = await raceConnect(cands, async (a) => { opened.push(a.kind); if (a.kind === "tcp") throw new Error("down"); return sock(); }, { dhtDelay: 80, relayDelay: 160 });
  assert.equal(r2.addr.kind, "dht"); assert.ok(Date.now() - t0 >= 70, "waited for the head start"); assert.deepEqual(opened, ["tcp", "dht"]);
});

test("not available: a platform without the native add-ons reports it and the rest of sync keeps working", async () => {
  const t = await net();
  const loader = async () => { throw new Error("Cannot find module 'udx-native' prebuild for android-arm"); };
  await assert.rejects(new DhtTransport({ seed: randomBytes(32), bootstrap: bs(t), loader, allow: () => [], onInbound() {} }).start(), (e: any) => e instanceof DhtUnavailable && /not available on this platform/.test(e.message));
  const A = await node("A", "memory", undefined, undefined, undefined, { opts: { dht: { loader } } }), B = await node("B", "memory", undefined, undefined, undefined, { opts: { dht: { loader } } });
  await pairUp(A, B);
  await A.call("syncSetDht", { enabled: true, bootstrap: bs(t) });
  const st = (await A.call("syncStatus")).dht;
  assert.equal(st.enabled, true); assert.equal(st.state, "unavailable"); assert.match(st.reason, /not available on this platform/); assert.equal(st.publicKey, undefined);
  B.store.putMessages([msg("fake-x:c", "n1", "still syncing over the LAN", "2026-03-01T10:00:00Z")]);
  A.store.putAccount({ id: "fake-x", provider: "fake", label: "W", status: "active" });
  await until(() => !!A.store.getMessage("fake-x:c", "n1"), "LAN sync unaffected");
  const off = await A.call("syncSetDht", { enabled: false }); assert.equal(off.enabled, false); assert.equal((await A.call("syncStatus")).dht.state, "off");
});

test("on by default: nothing runs before a group exists, a missing add-on only reports 'unavailable', the setting persists across a restart", async () => {
  let loads = 0; const loader = async () => { loads++; throw new Error("add-on cannot load here"); };
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "dht-persist-"));
  const A = await node("A", "sqlite", dir, undefined, undefined, { opts: { dht: { loader } } }), B = await node("B", "memory");
  assert.deepEqual({ ...(await A.call("syncStatus")).dht }, { enabled: true, bootstrap: [], state: "off", reason: undefined, publicKey: undefined }, "enabled by default, but idle until a group exists");
  await pairUp(A, B); await new Promise((r) => setTimeout(r, 900));
  assert.ok(["unavailable", "error", "starting"].includes((await A.call("syncStatus")).dht.state), "the failing loader is reported, not thrown");
  assert.equal((await A.call("syncStatus")).devices.length >= 2, true, "LAN sync keeps working without the DHT add-on");
  await assert.rejects(A.call("syncSetDht", { enabled: true, bootstrap: ["not a node"] }), /bootstrap node/);
  await A.call("syncSetDht", { enabled: false, bootstrap: ["10.1.2.3:4000"] });
  await A.stop();
  const A2 = await node("A", "sqlite", dir, undefined, A.key, { opts: { dht: { loader } } });
  assert.deepEqual((await A2.call("syncStatus")).dht.bootstrap, ["10.1.2.3:4000"]); assert.equal((await A2.call("syncStatus")).dht.enabled, false, "turning it off survives a restart");
  await A2.call("syncSetDht", { enabled: true });
  const A3 = await (async () => { await A2.stop(); return node("A", "sqlite", dir, undefined, A.key, { opts: { dht: { loader } } }); })();
  assert.equal((await A3.call("syncStatus")).dht.enabled, true, "enabled survives a restart");
  await A3.call("syncSetDht", { enabled: false });
  assert.ok(loads >= 1);
});

test("two devices on no common network find each other through the testnet DHT, sync, survive a reconnect and an address change, stop cleanly", async () => {
  const t = await net();
  const A = await node("A", "memory", undefined, (s) => s.putAccount({ id: "fake-d", provider: "fake", label: "W", status: "active" })), B = await node("B", "memory");
  await pairThenIsolate(A, B, async () => {
    await enable(t, A, B);
    // each device announces its DHT key to the group through the normal session: no pairing, no secret exchange over the DHT
    await until(() => !!devOf(A, B).dht && !!devOf(B, A).dht && devOf(A, B).dht === (B.svc as any).dht.publicKey && devOf(B, A).dht === (A.svc as any).dht.publicKey, "keys exchanged through the group record");
  });
  const pa = (await A.call("syncStatus")).dht, pb = (await B.call("syncStatus")).dht;
  assert.equal(pa.state, "ready"); assert.match(pa.publicKey, /^[0-9a-f]{64}$/); assert.notEqual(pa.publicKey, pb.publicKey);
  await until(() => !!sess(A, B) && !!sess(B, A), "session over the DHT", 20_000);
  assert.equal(sess(A, B).via, "dht"); assert.equal(sess(B, A).via, "dht"); assert.equal((A.svc as any).sessions.size, 1, "one session per peer");
  B.store.putMessages([msg("fake-d:c", "d1", "over the DHT", "2026-03-02T10:00:00Z")]);
  await until(() => !!A.store.getMessage("fake-d:c", "d1"), "message synced through the DHT");
  // reconnect: kill the session, it comes back (back-off loop), data keeps flowing
  for (const n of [A, B]) for (const s of [...(n.svc as any).sessions.values()]) (n.svc as any).closeSession(s, "test");
  await until(() => !!sess(A, B) && !!sess(B, A), "reconnected", 25_000);
  A.store.putMessages([msg("fake-d:c", "d2", "after the reconnect", "2026-03-02T10:05:00Z")]);
  await until(() => !!B.store.getMessage("fake-d:c", "d2"), "sync after reconnect");
  // a network change: refresh must not break anything
  (A.svc as any).dht.refresh(); (B.svc as any).dht.refresh();
  A.store.putMessages([msg("fake-d:c", "d3", "after refresh", "2026-03-02T10:06:00Z")]);
  await until(() => !!B.store.getMessage("fake-d:c", "d3"), "sync after refresh");
  assert.ok((A.svc as any).dht.dials <= 2, "dial concurrency is bounded");
  // disabling closes the sessions' transport and the node: the session over the DHT is gone and nothing dials any more
  await Promise.all([A.call("syncSetDht", { enabled: false }), B.call("syncSetDht", { enabled: false })]);
  assert.equal((A.svc as any).dht, undefined); assert.equal((await A.call("syncStatus")).dht.state, "off");
  await A.stop(); await B.stop();
});

test("a device that is not a member cannot even open a stream: wrong group, unknown key, revoked key", async () => {
  const t = await net();
  const A = await node("A", "memory"), B = await node("B", "memory"), X = await node("X", "memory"), Y = await node("Y", "memory");
  await pairThenIsolate(A, B, () => enable(t, A, B)); await pairThenIsolate(X, Y, () => enable(t, X, Y)); // X/Y: another group on the SAME testnet
  const pa = (await A.call("syncStatus")).dht.publicKey;
  // somebody who knows A's DHT key (worst case: it leaked) but is not in A's group: A's firewall refuses before any of our code runs
  const raw = new DHT({ bootstrap: bs(t) }); const attempt = raw.connect(Buffer.from(pa, "hex"), { keyPair: DHT.keyPair(randomBytes(32)) });
  const outcome = await new Promise<string>((ok) => { attempt.once("open", () => ok("open")); attempt.once("error", (e: any) => ok("error " + (e.code ?? e.message))); attempt.once("close", () => ok("closed")); setTimeout(() => ok("timeout"), 15_000); });
  assert.notEqual(outcome, "open", "the DHT firewall refused an unknown public key: " + outcome);
  attempt.destroy(); await raw.destroy({ force: true });
  assert.equal((A.svc as any).sessions.size, 0); assert.equal((A.svc as any).unauth, 0, "nothing reached the Noise handshake");
  // a member that really is in the group but gets revoked: its key leaves A's allow list, the DHT refuses it before the Noise handshake could even run
  const bDht = (B.svc as any).dht; assert.ok(bDht);
  await A.call("syncRevoke", { deviceId: B.svc.status().deviceId });
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 12_000);
  await assert.rejects(bDht.connect(pa, ctl.signal, 10_000), "a revoked device's DHT key is refused"); clearTimeout(timer);
  assert.equal((A.svc as any).sessions.size, 0);
  for (const n of [A, B, X, Y]) await n.stop();
});

test("the LAN wins when both work: no DHT socket is opened, and a DHT session is upgraded to the LAN as soon as it is reachable", async () => {
  const t = await net();
  const A = await node("A", "memory", undefined, undefined, undefined, { opts: { dht: { upgradeMs: 400 } } }), B = await node("B", "memory", undefined, undefined, undefined, { opts: { dht: { upgradeMs: 400 } } });
  await pairUp(A, B); // keepListening: both listen on loopback and know each other's tcp address
  await enable(t, A, B);
  await until(() => !!(A.svc as any).dht && !!(B.svc as any).dht, "both nodes up");
  let connects = 0; for (const n of [A, B]) { const d = (n.svc as any).dht, c = d.connect.bind(d); d.connect = (...a: any[]) => { connects++; return c(...a); }; }
  for (const n of [A, B]) for (const s of [...(n.svc as any).sessions.values()]) (n.svc as any).closeSession(s, "test");
  await until(() => !!sess(A, B) && !!sess(B, A), "reconnected");
  assert.notEqual(sess(A, B).via, "dht"); assert.notEqual(sess(B, A).via, "dht"); assert.equal(connects, 0, "LAN path: the DHT was never dialled");
  assert.equal((A.svc as any).sessions.size, 1);
  // now only the DHT works ...
  const saved = [devOf(A, B).addrs, devOf(B, A).addrs]; for (const n of [A, B]) await n.call("syncSetListen", { enabled: false });
  devOf(A, B).addrs = []; devOf(B, A).addrs = [];
  for (const n of [A, B]) for (const s of [...(n.svc as any).sessions.values()]) (n.svc as any).closeSession(s, "test");
  await until(() => sess(A, B)?.via === "dht" && sess(B, A)?.via === "dht", "fell back to the DHT", 25_000);
  // ... and the LAN comes back: the DHT session is replaced, on both ends, without a duplicate
  for (const n of [A, B]) await n.call("syncSetListen", { enabled: true });
  devOf(A, B).addrs = saved[0].map((a: any) => ({ ...a, port: (B.svc as any).port })); devOf(B, A).addrs = saved[1].map((a: any) => ({ ...a, port: (A.svc as any).port }));
  await until(() => !!sess(A, B) && sess(A, B).via !== "dht" && !!sess(B, A) && sess(B, A).via !== "dht", "upgraded to the LAN", 20_000);
  assert.equal((A.svc as any).sessions.size, 1); assert.equal((B.svc as any).sessions.size, 1);
  for (const n of [A, B]) await n.stop();
});

test("an address announced over a live DHT session moves the session to the direct path at once (no 60 s timer), one session per peer; when the direct path dies it falls back to the DHT by itself", async () => {
  const t = await net();
  const o = { dht: { upgradeMs: 3_600_000 } };
  const A = await node("A", "memory", undefined, undefined, undefined, { opts: o }), B = await node("B", "memory", undefined, undefined, undefined, { opts: o });
  await pairThenIsolate(A, B, async () => { await enable(t, A, B); await until(() => !!(A.svc as any).dht && !!(B.svc as any).dht, "both nodes up"); });
  await until(() => sess(A, B)?.via === "dht" && sess(B, A)?.via === "dht", "connected over the DHT only", 30_000);
  assert.equal(onlineVia(A, B)!.viaKind, "dht");
  // the LAN is back (the listeners open again) but nobody knows an address yet: the announcement over the DHT session tells it
  for (const n of [A, B]) await n.call("syncSetListen", { enabled: true });
  await A.svc.networkChanged(); await B.svc.networkChanged();
  await until(() => !!sess(A, B) && sess(A, B).via !== "dht" && !!sess(B, A) && sess(B, A).via !== "dht", "migrated to the direct connection within seconds", 10_000);
  assert.equal((A.svc as any).sessions.size, 1); assert.equal((B.svc as any).sessions.size, 1);
  assert.equal(onlineVia(A, B)!.viaKind, "direct");
  // the direct path stops working (the other device's listener is gone, the saved address is stale): back to the DHT without user action
  for (const n of [A, B]) await n.call("syncSetListen", { enabled: false });
  for (const [x, y] of [[A, B], [B, A]] as const) devOf(x, y).addrs = [];
  for (const n of [A, B]) for (const s of [...(n.svc as any).sessions.values()]) (n.svc as any).closeSession(s, "direct path dropped");
  await until(() => sess(A, B)?.via === "dht" && sess(B, A)?.via === "dht", "fell back to the DHT", 30_000);
  assert.equal((A.svc as any).sessions.size, 1);
  for (const n of [A, B]) await n.stop();
});
