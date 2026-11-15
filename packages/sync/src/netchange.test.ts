// Network changes: the listener must follow the device (Wi-Fi switch, Doze resume), addresses are re-announced, the dial back-off is reset. Loopback only, fake interface lists.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { node, pairUp, until } from "./testkit.js";
import { setInterfaceOverride } from "./addrs.js";

after(() => setInterfaceOverride(undefined));
const wlan = (address: string) => ({ name: "wlan0", address, family: 4, internal: false });

test("wildcard (Android) listener: one port for every address, follows interface changes, refuses connections that are not on a private address", async () => {
  const a = await node("wild", "memory", undefined, undefined, undefined, { opts: { bindHost: undefined, wildcardLan: true, wellKnown: { base: 47400 + Math.floor(Math.random() * 400), span: 4 }, mdns: false } });
  await a.call("syncStartPairing", { deviceName: "wild", keepListening: true });
  await a.call("syncNetworkChanged", { interfaces: [wlan("192.168.145.20")] });
  const s1 = await a.call("syncStatus"); assert.equal(s1.listening, true); assert.ok(s1.binds.some((b: string) => b.startsWith("0.0.0.0:")));
  const port = s1.port;
  const r1 = await a.call("syncNetworkChanged", { interfaces: [wlan("134.28.178.99"), { name: "rmnet0", address: "10.20.30.40", family: 4, internal: false }] }); // university network
  assert.equal((await a.call("syncStatus")).port, port, "same well-known port after the change");
  assert.deepEqual(r1.addrs, ["10.20.30.40"], "only private addresses are advertised");
  assert.equal(r1.listening, true);
  const r2 = await a.call("syncNetworkChanged", { interfaces: [wlan("192.168.7.9")] }); assert.deepEqual(r2.addrs, ["192.168.7.9"]);
  // a connection that arrives on 127.0.0.1 is not on the "local network": dropped before any handshake
  const closed = await new Promise<boolean>((ok) => { const c = connect(port, "127.0.0.1"); c.on("close", () => ok(true)); c.on("error", () => {}); setTimeout(() => ok(false), 3000); });
  assert.equal(closed, true);
  setInterfaceOverride(undefined);
});

test("a listener that was closed behind our back is bound again (same port) without any other trigger", async () => {
  const a = await node("rebind", "memory"); await a.call("syncStartPairing", { deviceName: "rebind", keepListening: true });
  const port = (await a.call("syncStatus")).port; assert.ok(port);
  const srv = (a.svc as any).servers.get("127.0.0.1"); srv.close();
  const reach = () => new Promise<boolean>((ok) => { const c = connect(port, "127.0.0.1", () => { c.destroy(); ok(true); }); c.on("error", () => ok(false)); });
  await until(reach, "port reachable again");
});

test("a peer that moved to another network tells us over the live session; the back-off is cleared", async () => {
  const a = await node("addrA", "memory"), b = await node("addrB", "memory"); await pairUp(a, b);
  const aId = a.svc.status().deviceId, bId = b.svc.status().deviceId;
  (b.svc as any).backoff.set(aId, { n: 5, until: Date.now() + 3_600_000 });
  const sess = (a.svc as any).sessions.get(bId); assert.ok(sess);
  await (a.svc as any).sendMsg(sess, { t: "addrs", port: 45045, addrs: [{ kind: "tcp", host: "10.9.8.7", port: 45045 }] });
  await until(() => !!(b.svc as any).group.devices[aId].addrs?.some((x: any) => x.host === "10.9.8.7"), "new address learned");
  assert.equal((b.svc as any).backoff.has(aId), false);
});

import { applyAnnounced, cleanAddrs, type Dev } from "./group.js";
import { netFingerprint } from "./addrs.js";

test("stale addresses: what a device announces replaces what we learned of its old network; manual ones stay; an empty announcement changes nothing", () => {
  const old = { kind: "tcp" as const, host: "192.168.145.85", port: 45045, src: "learned" as const, good: new Date(Date.now() - 3_600_000).toISOString() };
  const d: Dev = { id: "x", name: "x", pub: "", addedAt: "", addrs: [old, { kind: "tcp", host: "10.0.0.9", port: 45045, src: "manual" }, { kind: "tcp", host: "172.16.0.4", port: 45046, src: "mdns" }, { kind: "dht", src: "learned" }] };
  assert.equal(applyAnnounced(d, []), false); assert.equal(d.addrs!.length, 4);
  const now = cleanAddrs([{ kind: "tcp", host: "134.28.178.99", port: 45045, src: "learned", net: "abcdef012345" }]);
  assert.equal(applyAnnounced(d, now), true);
  assert.deepEqual(d.addrs!.filter((a) => a.kind === "tcp").map((a) => a.host).sort(), ["10.0.0.9", "134.28.178.99"], "old home IP and old mdns address are gone, the manual one stays");
  assert.ok(d.addrs!.some((a) => a.kind === "dht"));
  assert.equal(d.addrs!.find((a) => a.host === "134.28.178.99")!.net, "abcdef012345");
  // an address that worked a few seconds ago is not dropped on the strength of one announcement
  const e: Dev = { id: "y", name: "y", pub: "", addedAt: "", addrs: [{ kind: "tcp", host: "192.168.1.5", port: 45045, src: "learned", good: new Date().toISOString() }] };
  applyAnnounced(e, cleanAddrs([{ kind: "tcp", host: "10.1.1.1", port: 45045, src: "learned" }])); assert.equal(e.addrs!.length, 2);
});

test("network fingerprint: changes with the Wi-Fi, ignores VPN / docker interfaces and the order", () => {
  const home = [{ name: "wlan0", address: "192.168.145.85", family: 4 as const, internal: false, netmask: "255.255.255.0" }];
  const uni = [{ name: "wlan0", address: "10.20.30.40", family: 4 as const, internal: false, netmask: "255.255.0.0" }];
  assert.notEqual(netFingerprint(home), netFingerprint(uni));
  assert.equal(netFingerprint(home), netFingerprint([...home, { name: "docker0", address: "172.17.0.1", family: 4, internal: false, netmask: "255.255.0.0" }, { name: "tailscale0", address: "100.64.0.2", family: 4, internal: false }]));
  assert.equal(netFingerprint(home), netFingerprint([{ ...home[0], address: "192.168.145.99" }]), "same subnet, other host address: same network");
});
