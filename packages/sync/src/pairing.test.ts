// Pairing without configuration: direction-agnostic dialing, well-known port, candidate discovery, LAN probe, role flip.
// Everything runs on loopback with FAKE networks: a connector that maps fake LAN addresses to the real loopback ports of the test devices, and a fake
// firewall (a host that drops every connection = a default-drop input policy). Nothing real is ever scanned.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { ChannelError } from "./channel.js";
import { tcpConnect, type Connector, type Iface } from "./addrs.js";
import { dialAny, isPrivateLan, listenPorts, probeHosts, SYNC_PORT, SYNC_PORT_SPAN, wellKnownPorts } from "./discover.js";
import { node, pairUp, until, type Node } from "./testkit.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deviceIdOf } from "./noise.js";
import { Ledger } from "./ledger.js";

const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
/** A fake LAN: addresses -> loopback ports. `drop` = firewall that silently drops (connect hangs until the caller's timeout); alive hosts answer RST on closed ports. */
class FakeLan {
  routes = new Map<string, number>(); alive = new Set<string>(); dropped = new Set<string>(); log: string[] = [];
  host(ip: string, o: { port?: number; to?: number; drop?: boolean } = {}) { this.alive.add(ip); if (o.drop) this.dropped.add(ip); else if (o.to) this.routes.set(`${ip}:${o.port ?? SYNC_PORT}`, o.to); return this; }
  connect: Connector = (host, port, timeout, signal) => new Promise((ok, fail) => {
    this.log.push(`${host}:${port}`);
    if (host === "127.0.0.1") return void tcpConnect(host, port, timeout, signal).then(ok, fail);
    const to = this.routes.get(`${host}:${port}`);
    if (to !== undefined && !this.dropped.has(host)) return void tcpConnect("127.0.0.1", to, timeout, signal).then(ok, fail);
    if (this.alive.has(host) && !this.dropped.has(host)) return fail(refused());
    const t = setTimeout(() => fail(new Error("connection timed out")), timeout); signal?.addEventListener("abort", () => { clearTimeout(t); fail(new Error("aborted")); }, { once: true });
  });
}
const eth = (address: string, netmask = "255.255.255.0"): Iface => ({ name: "eth0", address, family: 4, internal: false, netmask });
const dev = (name: string, lan: FakeLan, ip: string, extra: object = {}) => track(
  node(name, "memory", undefined, undefined, undefined, { opts: { net: { interfaces: () => [eth(ip)], connect: lan.connect, probeConnectMs: 40, connectMs: 300, overallMs: 5000, graceMs: 0, ...extra } } }));
const mine: Node[] = [];
const track = async (p: Promise<Node>) => { const n = await p; mine.push(n); return n; };
const stopMine = async () => { for (const n of mine.splice(0)) await n.stop().catch(() => {}); };
const nd = (...a: Parameters<typeof node>) => track(node(...a));
afterEach(stopMine);
const port = async (n: Node) => (await n.call("syncStatus")).port as number;
/** both people compare the digits and approve; `shower` listened, `entered` typed the code */
async function confirm(shower: Node, entered: Node, enteredRole: "joiner" | "host", sas: string) {
  await until(async () => { const s = await shower.call("syncStatus"); return enteredRole === "joiner" ? !!s.approval : s.joining?.state === "confirm"; }, "the shower shows the digits");
  const s = await shower.call("syncStatus");
  assert.equal((enteredRole === "joiner" ? s.approval : s.joining).sas, sas, "both screens show the same digits");
  if (enteredRole === "joiner") await Promise.all([entered.call("syncConfirmJoin", { keepListening: true }), shower.call("syncApproveJoin", { accept: true })]);
  else await Promise.all([shower.call("syncConfirmJoin", { keepListening: true }), entered.call("syncApproveJoin", { accept: true })]);
}

test("probe targets: only the user's own private subnets, never public / VPN / container / cellular, capped", () => {
  const ifs: Iface[] = [
    { name: "lo", address: "127.0.0.1", family: 4, internal: true, netmask: "255.0.0.0" },
    eth("192.168.1.20", "255.255.0.0"), // a /16 is capped to the /24 around us
    { name: "wlan1", address: "10.0.0.5", family: 4, internal: false, netmask: "255.255.255.192" }, // a /26 stays a /26
    { name: "wan0", address: "8.8.8.8", family: 4, internal: false, netmask: "255.255.255.0" },
    { name: "tailscale0", address: "100.64.0.7", family: 4, internal: false, netmask: "255.192.0.0" },
    { name: "docker0", address: "172.17.0.1", family: 4, internal: false, netmask: "255.255.0.0" },
    { name: "br-1234", address: "172.20.0.1", family: 4, internal: false, netmask: "255.255.0.0" },
    { name: "tun0", address: "10.8.0.2", family: 4, internal: false, netmask: "255.255.255.0" },
    { name: "rmnet_data0", address: "10.55.3.4", family: 4, internal: false, netmask: "255.255.255.0" },
    { name: "eth9", address: "169.254.3.3", family: 4, internal: false, netmask: "255.255.0.0" },
    { name: "eth8", address: "172.32.0.9", family: 4, internal: false, netmask: "255.255.255.0" }, // 172.32 is public
    { name: "v6", address: "fe80::1", family: 6, internal: false },
  ];
  const hosts = probeHosts(ifs);
  assert.ok(hosts.length > 0 && hosts.every(isPrivateLan), "every target is RFC 1918");
  assert.ok(hosts.every((h) => /^(192\.168\.1\.|10\.0\.0\.)/.test(h)), "only eth0 (/24) and wlan1 (/26): " + hosts.slice(0, 3));
  assert.equal(hosts.filter((h) => h.startsWith("192.168.1.")).length, 253, "a /24 minus ourselves and the network/broadcast address");
  assert.equal(hosts.filter((h) => h.startsWith("10.0.0.")).length, 61 - 0, "a /26 (62 usable) minus ourselves");
  assert.ok(!hosts.includes("192.168.1.20") && !hosts.includes("10.0.0.5"), "never ourselves");
  assert.ok(!hosts.some((h) => h.startsWith("192.168.2.")), "never leaves the /24");
  const many = ["10.1.1.1", "10.2.2.2", "10.3.3.3"].map((a, i) => ({ ...eth(a), name: "eth" + i }));
  assert.equal(probeHosts(many).length, 512, "total cap of 512 hosts");
  for (const bad of ["8.8.8.8", "100.64.0.1", "169.254.1.1", "172.32.0.1", "127.0.0.1", "192.169.0.1", "10.0.0", "abc"]) assert.equal(isPrivateLan(bad), false, bad);
  assert.deepEqual(probeHosts([{ name: "wan0", address: "8.8.8.8", family: 4, internal: false, netmask: "255.255.255.0" }]), [], "a machine with only public/cellular addresses probes nothing");
});

test("listening ports: the persisted well-known port first, then the range, random only last", () => {
  assert.deepEqual(wellKnownPorts(100, 3), [100, 101, 102]);
  assert.deepEqual(listenPorts(undefined, 100, 3), [100, 101, 102, 0]);
  assert.deepEqual(listenPorts(102, 100, 3), [102, 100, 101, 0]);
  assert.deepEqual(listenPorts(55555, 100, 3), [100, 101, 102, 0], "a stale port outside the range is forgotten");
  assert.equal(SYNC_PORT, 45045);
});

test("the service takes the well-known port and falls back inside the range when it is busy", async () => {
  const base = 47300 + Math.floor(Math.random() * 400) * 8;
  const blocker = createServer(); await new Promise<void>((ok) => blocker.listen(base, "127.0.0.1", ok));
  try {
    const A = await nd("A", "memory", undefined, undefined, undefined, { opts: { wellKnown: { base, span: 4 } } });
    const p = await A.call("syncStartPairing", {});
    assert.equal(p.port, base + 1, "45045 equivalent is taken: the next one in the range");
    await A.call("syncStopPairing"); const p2 = await A.call("syncStartPairing", {});
    assert.equal(p2.port, base + 1, "the port is kept across pairings");
    await A.stop();
    const B = await nd("B", "memory", undefined, undefined, undefined, { opts: { wellKnown: { base: base + 4, span: 2 } } });
    assert.equal((await B.call("syncStartPairing", {})).port, base + 4, "a free range: its first port");
  } finally { blocker.close(); }
});

test("dialAny: first authenticated handshake wins, every other attempt is cancelled and a late winner is disposed", async () => {
  const aborted: string[] = [], disposed: string[] = [];
  const r = await dialAny<string>({
    fixed: [{ host: "slow", ports: [1], src: "typed" }, { host: "hang", ports: [1], src: "link" }, { host: "fast", ports: [1], src: "hint" }],
    probe: [{ host: "p1", ports: [1, 2], src: "probe" }],
    attempt: (host, _p, signal) => new Promise((ok, fail) => {
      signal.addEventListener("abort", () => { aborted.push(host); fail(new Error("aborted")); }, { once: true });
      if (host === "fast") setTimeout(() => ok("fast"), 30);
      if (host === "slow") setTimeout(() => ok("slow"), 60); // finishes after "fast" won?  it was aborted first: must never be used
    }),
    dispose: (v) => disposed.push(v), overallMs: 3000,
  });
  assert.equal(r.value, "fast"); assert.equal(r.cand.host, "fast");
  assert.ok(aborted.includes("hang") && aborted.includes("slow") && aborted.includes("p1"), "losers got the abort signal: " + aborted);
  // a loser that ignores the signal and still completes is handed to dispose (so its socket gets closed)
  const d2: string[] = [];
  const r2 = await dialAny<string>({ fixed: [{ host: "a", ports: [1], src: "typed" }, { host: "b", ports: [1], src: "typed" }], attempt: (h) => new Promise((ok) => setTimeout(() => ok(h), h === "a" ? 10 : 50)), dispose: (v) => d2.push(v) });
  assert.equal(r2.value, "a"); await new Promise((ok) => setTimeout(ok, 120)); assert.deepEqual(d2, ["b"]);
});

test("dialAny: an explicitly named host that rejects the code ends it at once; ports of the range are walked on a host that refuses", async () => {
  const t0 = Date.now(), tried: string[] = [];
  await assert.rejects(dialAny({ fixed: [{ host: "h", ports: [1], src: "typed" }], probe: Array.from({ length: 50 }, (_, i) => ({ host: "p" + i, ports: [1], src: "probe" as const })),
    attempt: async (h, _p, signal) => { tried.push(h); if (h === "h") throw new ChannelError("auth", "no"); await new Promise((_, f) => signal.addEventListener("abort", () => f(new Error("aborted")))); }, concurrency: 8, overallMs: 5000 }),
  (e: any) => e.reason === "code");
  assert.ok(Date.now() - t0 < 500, "decisive rejection does not wait for the scan");
  const seen: number[] = [];
  const r = await dialAny<string>({ fixed: [], probe: [{ host: "x", ports: [10, 11, 12, 13], src: "probe" }], attempt: async (_h, p) => { seen.push(p); if (p < 12) throw refused(); if (p === 12) throw new ChannelError("auth", "not pairing"); return "ok" + p; } });
  assert.equal(r.value, "ok13"); assert.deepEqual(seen, [10, 11, 12, 13]);
  const timeouts: number[] = [];
  await assert.rejects(dialAny({ fixed: [], probe: [{ host: "dead", ports: [1, 2, 3], src: "probe" }], attempt: async (_h, p) => { timeouts.push(p); throw new Error("connection timed out"); }, graceMs: 0 }), (e: any) => e.reason === "unreachable");
  assert.deepEqual(timeouts, [1], "a host that drops packets is not tried on the other ports");
});

test("enter only the code: the LAN probe finds the device showing it (well-known port, no address typed)", async () => {
  const lan = new FakeLan(); const A = await dev("A", lan, "192.168.7.10"), B = await dev("B", lan, "192.168.7.44");
  const p = await A.call("syncStartPairing", {}); lan.host("192.168.7.10", { to: p.port }); lan.host("192.168.7.44");
  for (let i = 2; i < 40; i++) if (i !== 10) lan.host(`192.168.7.${i}`); // other devices on the network: up, nothing listening
  const j = await B.call("syncJoin", { code: p.code, deviceName: "B" });
  assert.equal(j.role, "joiner"); assert.equal(j.via, "192.168.7.10:45045");
  await confirm(A, B, "joiner", j.sas);
  await until(async () => (await B.call("syncStatus")).enabled, "B joined");
  assert.equal((await A.call("syncStatus")).devices.length, 2);
  assert.ok(lan.log.every((l) => /^192\.168\.7\.\d+:450(4[5-9]|5[0-2])$/.test(l)), "only our own subnet, only the well-known range: " + lan.log.find((l) => !/^192\.168\.7\./.test(l)));
});

test("the probe finds a peer on a NON-default port of the range (45045 is taken on that host)", async () => {
  const lan = new FakeLan(); const A = await dev("A", lan, "192.168.7.10"), B = await dev("B", lan, "192.168.7.44");
  const p = await A.call("syncStartPairing", {}); lan.host("192.168.7.10", { to: p.port, port: SYNC_PORT + 3 }); lan.host("192.168.7.44");
  const j = await B.call("syncJoin", { code: p.code });
  assert.equal(j.via, `192.168.7.10:${SYNC_PORT + 3}`);
  assert.ok(SYNC_PORT + 3 < SYNC_PORT + SYNC_PORT_SPAN);
  await B.call("syncCancelJoin");
});

test("only one side is reachable: the code shower is firewalled, the other device cannot connect and is told to flip; flipping works with just the code", async () => {
  const lan = new FakeLan(); const laptop = await dev("laptop", lan, "192.168.7.10"), phone = await dev("phone", lan, "192.168.7.44");
  lan.host("192.168.7.10", { drop: true }); // default-drop input policy: inbound TCP never answers
  const p = await laptop.call("syncStartPairing", {});
  const t0 = Date.now();
  await assert.rejects(phone.call("syncJoin", { code: p.code }), /reach/);
  assert.ok(Date.now() - t0 < 4000, "fails in seconds, not minutes");
  const st = await phone.call("syncStatus");
  assert.equal(st.joining.state, "failed"); assert.equal(st.joining.reason, "unreachable", "the UI offers 'show a code here instead'");
  // flip: the phone shows a code; the laptop (blocked inbound, outbound fine) types it and dials OUT
  lan.host("192.168.7.44", { to: await port(phone) }); // reachable only once it listens; the laptop's probe will find it
  const pp = await phone.call("syncStartPairing", { deviceName: "phone" });
  lan.host("192.168.7.44", { to: pp.port });
  const j = await laptop.call("syncJoin", { code: pp.code });
  assert.equal(j.role, "joiner"); assert.equal(j.via, "192.168.7.44:45045");
  await confirm(phone, laptop, "joiner", j.sas);
  await until(async () => (await laptop.call("syncStatus")).enabled && !(await laptop.call("syncStatus")).pairing, "laptop joined the phone's group and closed its own code");
  assert.equal((await phone.call("syncStatus")).devices.length, 2);
  assert.equal((await laptop.call("syncStatus")).groupId, (await phone.call("syncStatus")).groupId, "one group");
  // sync runs over the direction that works: laptop -> phone
  await until(async () => (await laptop.call("syncStatus")).devices.find((d: any) => !d.self)?.online, "laptop dials the phone for sync", 10_000);
});

test("the reachable side starts first: the firewalled device finds it by typing only the code; the other direction works too (no firewall at all)", async () => {
  const lan = new FakeLan(); const phone = await dev("phone", lan, "192.168.7.44"), laptop = await dev("laptop", lan, "192.168.7.10");
  lan.host("192.168.7.10", { drop: true });
  const pp = await phone.call("syncStartPairing", {}); lan.host("192.168.7.44", { to: pp.port });
  const j = await laptop.call("syncJoin", { code: pp.code }); // the laptop never showed a code and has no group
  await confirm(phone, laptop, "joiner", j.sas);
  await until(async () => (await laptop.call("syncStatus")).enabled, "joined");
  // and the plain direction: shower reachable, dialer anything
  const lan2 = new FakeLan(); const X = await dev("X", lan2, "10.1.2.3"), Y = await dev("Y", lan2, "10.1.2.4");
  const px = await X.call("syncStartPairing", {}); lan2.host("10.1.2.3", { to: px.port }); lan2.host("10.1.2.4", { drop: true });
  const jy = await Y.call("syncJoin", { code: px.code }); await confirm(X, Y, "joiner", jy.sas);
  await until(async () => (await Y.call("syncStatus")).enabled, "Y joined");
});

test("a device with a group dials the new device's code and hosts it (roles follow the group, not the connection)", async () => {
  const lan = new FakeLan(); const A = await dev("A", lan, "192.168.7.10"), C = await dev("C", lan, "192.168.7.20"), B = await dev("B", lan, "192.168.7.44");
  await pairUp(A, C); // real loopback, explicit: A now has a two-device group
  lan.host("192.168.7.10", { drop: true }); // A cannot be dialed, so B cannot be the one to dial it
  const pb = await B.call("syncStartPairing", { deviceName: "B" }); lan.host("192.168.7.44", { to: pb.port });
  const j = await A.call("syncJoin", { code: pb.code, keepListening: true });
  assert.equal(j.role, "host", "A holds the group: it admits B even though it dialed");
  await confirm(B, A, "host", j.sas);
  await until(async () => (await B.call("syncStatus")).devices.length === 3 && (await A.call("syncStatus")).devices.length === 3, "B is a member of A's group", 10_000);
  assert.equal((await B.call("syncStatus")).groupId, (await A.call("syncStatus")).groupId);
});

test("wrong code: rejected quickly, with no information about which host answered, and nothing is joined", async () => {
  const lan = new FakeLan(); const A = await dev("A", lan, "192.168.7.10"), B = await dev("B", lan, "192.168.7.44");
  const p = await A.call("syncStartPairing", {}); lan.host("192.168.7.10", { to: p.port }); lan.host("192.168.7.44");
  const t0 = Date.now();
  await assert.rejects(B.call("syncJoin", { code: "baba-baba-baba-baba" }), (e: Error) => /not accepted/.test(e.message) && !/192\.168|45045/.test(e.message));
  assert.ok(Date.now() - t0 < 3000, "wrong code: " + (Date.now() - t0) + " ms");
  assert.equal((await B.call("syncStatus")).joining.reason, "code");
  assert.equal((await B.call("syncStatus")).enabled, false);
  assert.ok(!(await A.call("syncStatus")).approval, "the shower is not even bothered");
  assert.equal((await A.call("syncStatus")).pairing.failures, 1, "counted as one failed attempt");
  // a typed address ends at the first rejection without scanning anything
  lan.log.length = 0; (A.svc as any).src.clear();
  await assert.rejects(B.call("syncJoin", { host: "192.168.7.10", code: "bebe-bebe-bebe-bebe" }), /not accepted/);
  assert.ok(lan.log.every((l) => l.startsWith("192.168.7.10:")), "typed address: no scan");
  // the right code still works afterwards (the lockout is per source and only after repeated failures)
  (A.svc as any).src.clear(); const j = await B.call("syncJoin", { code: p.code }); assert.equal(j.role, "joiner"); await B.call("syncCancelJoin");
});

test("no probe on a machine with only public or VPN addresses; never a non-private host even for hints", async () => {
  const lan = new FakeLan();
  const B = await nd("B", "memory", undefined, undefined, undefined, { opts: { net: { interfaces: () => [{ name: "wan0", address: "8.8.8.8", family: 4 as const, internal: false, netmask: "255.255.255.0" }, { name: "tailscale0", address: "100.64.0.3", family: 4 as const, internal: false, netmask: "255.192.0.0" }], connect: lan.connect, connectMs: 100, overallMs: 2000, graceMs: 0 } } });
  await assert.rejects(B.call("syncJoin", { code: "bako-lemi-zuta-nosu" }), /reach/);
  assert.deepEqual(lan.log, [], "nothing was dialed");
});

test("link (QR) with addresses and the pinned key; typed address keeps working", async () => {
  const A = await nd("A", "memory"), B = await nd("B", "memory");
  const p = await A.call("syncStartPairing", {});
  const j = await B.call("syncJoin", { link: p.link }); await confirm(A, B, "joiner", j.sas);
  await until(async () => (await B.call("syncStatus")).enabled, "B joined through the link");
  assert.equal((await B.call("syncStatus")).devices.length, 2);
  const C = await nd("C", "memory"); const p2 = await A.call("syncStartPairing", {}); (A.svc as any).src.clear();
  const j2 = await C.call("syncJoin", { host: "127.0.0.1", port: p2.port, code: p2.code }); await confirm(A, C, "joiner", j2.sas);
  await until(async () => (await C.call("syncStatus")).enabled, "C joined with host/port");
});

test("an identity whose id is not the hash of its key is replaced at startup (nothing could ever pair with it)", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "sync-brokenid-"));
  const key = new Uint8Array(randomBytes(32));
  // first start: a healthy identity, which is then corrupted in the ledger the way a half-written or migrated one would be
  const first = await nd("broken", "sqlite", dir, undefined, key);
  const good = (first.svc as any).me;
  await first.stop();
  const l = new Ledger(join(dir, "sync.db"), key);
  l.kvSet("identity", { ...good, id: "0".repeat(32) });
  l.close();

  const again = await nd("broken", "sqlite", dir, undefined, key);
  const me = (again.svc as any).me;
  assert.notEqual(me.id, "0".repeat(32), "the broken id is gone");
  assert.equal(me.id, deviceIdOf(Buffer.from(me.pub, "base64")), "and the new one matches its key");
  assert.equal(again.svc.status().deviceId, me.id);
  await again.stop();

  // in a group it must NOT be replaced behind the user's back: that would orphan the ledger
  const dir2 = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "sync-brokenid2-"));
  const key2 = new Uint8Array(randomBytes(32));
  const A = await nd("grpA", "sqlite", dir2, undefined, key2), B = await nd("grpB", "memory");
  await pairUp(A, B);
  const meA = (A.svc as any).me; await A.stop(); await B.stop();
  const l2 = new Ledger(join(dir2, "sync.db"), key2); l2.kvSet("identity", { ...meA, id: "1".repeat(32) }); l2.close();
  const A2 = await nd("grpA", "sqlite", dir2, undefined, key2);
  assert.equal((A2.svc as any).me.id, "1".repeat(32), "a device that is in a group keeps its identity; the problem is reported instead");
  await A2.stop();
});

/** mDNS stand-in: a table a test fills by hand, the way a real browser hears every announcement on the link -- its own included. */
class TableMdns {
  table: { instance: string; host: string; port: number; txt: Record<string, string>; addrs: string[]; seen: number }[] = [];
  async start() {} stop() {} query() {} refresh() {} unadvertise() {} advertise() {}
  services() { return this.table; }
  add(instance: string, port: number, addrs: string[]) { this.table.push({ instance, host: instance + ".local", port, txt: { v: "1", m: "pair", n: instance }, addrs, seen: Date.now() }); return this; }
}

test("a device that is showing a code does not dial its own mDNS announcement while joining", async () => {
  // Both devices show a code, so both announce over mDNS -- and a browser hears its own announcement. The joining one
  // used to dial ITSELF, be refused by its own listener (it holds a different code), and because an announced host counts
  // as decisive, that refusal aborted the pairing with "that code wasn't accepted" while the real handshake was running.
  // The other device's answer is slowed down here so the self-dial always loses the race it used to win.
  const browse = new TableMdns();
  const A = await nd("mdnsA", "memory");
  const pa = await A.call("syncStartPairing", { deviceName: "mdnsA" });
  const slowToA: Connector = (host, port, timeout, signal) =>
    (port === pa.port ? new Promise((r) => setTimeout(r, 500)) : Promise.resolve()).then(() => tcpConnect(host, port, timeout, signal));
  const B = await nd("mdnsB", "memory", undefined, undefined, undefined, { opts: { mdns: browse as any, net: { connect: slowToA } } });
  const pb = await B.call("syncStartPairing", { deviceName: "mdnsB" });
  const idOf = (n: typeof A) => "unichat-" + n.svc.status().deviceId.slice(0, 10);
  browse.add(idOf(B), pb.port, ["127.0.0.1"]).add(idOf(A), pa.port, ["127.0.0.1"]); // B's own announcement first, and it answers at once
  const j = await B.call("syncJoin", { code: pa.code, deviceName: "mdnsB" });
  await confirm(A, B, "joiner", j.sas);
  await until(async () => (await B.call("syncStatus")).enabled, "B joined A instead of being refused by itself");
});
