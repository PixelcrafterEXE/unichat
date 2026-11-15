import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { advertisable, bindsFor, lanBindAddresses, markAddr, orderAddrs, raceConnect, rendezvousId, tcpConnect, type Iface } from "./addrs.js";
import { BigAssembler, sendBig, BigTooLarge } from "./bulk.js";
import { cleanAddrs, noteAddr, type Dev } from "./group.js";
import { sasOf } from "./code.js";
import { PartFile, Blobs } from "./blobs.js";
import { Ledger } from "./ledger.js";

const ifs: Iface[] = [{ name: "lo", address: "127.0.0.1", family: 4, internal: true }, { name: "eth0", address: "192.168.1.5", family: 4, internal: false }, { name: "wlan", address: "10.0.0.7", family: 4, internal: false },
  { name: "tailscale0", address: "100.101.102.103", family: 4, internal: false }, { name: "ppp0", address: "203.0.113.9", family: 4, internal: false }, { name: "docker0", address: "172.17.0.1", family: 4, internal: false }];
test("listener scopes: loopback / LAN (private ranges only) / one specific address; no wildcard", () => {
  assert.deepEqual(bindsFor({ enabled: true, scope: "loopback" }, ifs).hosts, ["127.0.0.1"]);
  assert.deepEqual(lanBindAddresses(ifs).sort(), ["10.0.0.7", "172.17.0.1", "192.168.1.5"], "public and VPN addresses are not part of 'LAN'");
  assert.deepEqual(bindsFor({ enabled: true, scope: "address", address: "100.101.102.103" }, ifs).hosts, ["100.101.102.103"]);
  assert.match(bindsFor({ enabled: true, scope: "address", address: "0.0.0.0" }, ifs).error!, /every interface/);
  assert.match(bindsFor({ enabled: true, scope: "address", address: "10.9.9.9" }, ifs).error!, /no network interface/);
  assert.match(bindsFor({ enabled: true, scope: "address", address: "" }, ifs).error!, /Enter/);
  assert.deepEqual(advertisable(["127.0.0.1", "192.168.1.5", "0.0.0.0"]), ["192.168.1.5"]);
});
test("addresses: validated, deduplicated, best first, last good remembered", () => {
  assert.equal(cleanAddrs([{ kind: "tcp", host: "nas.example.org", port: 43210, src: "manual" }, { kind: "tcp", host: "a b", port: 1 }, { kind: "tcp", host: "x", port: 70000 }, { kind: "relay", url: "wss://r.example/relay/" }, { kind: "relay", url: "http://nope" }, "junk"]).length, 2);
  const d: Dev = { id: "d", name: "d", pub: "", addedAt: "" };
  noteAddr(d, { kind: "tcp", host: "192.168.1.9", port: 1, src: "learned" }); noteAddr(d, { kind: "tcp", host: "fd00::9", port: 1, src: "learned" }); noteAddr(d, { kind: "tcp", host: "ddns.example", port: 1, src: "manual" }); noteAddr(d, { kind: "tcp", host: "192.168.1.9", port: 1, src: "mdns" });
  assert.equal(d.addrs!.length, 3, "deduplicated"); assert.equal(orderAddrs(d)[0].host, "ddns.example", "manual entries first");
  markAddr(d, d.addrs![1], true); assert.equal(orderAddrs(d)[0].host, "fd00::9", "the last good address goes first");
  markAddr(d, d.addrs![1], false); markAddr(d, d.addrs![1], false); assert.ok((d.addrs![1].fails ?? 0) >= 2);
});
test("happy eyeballs: a dead address does not delay a live one; everything dead rejects; the relay waits for the direct addresses", async () => {
  const srv = createServer((s) => s.end()); await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok)); const port = (srv.address() as any).port;
  const dead = createServer(); await new Promise<void>((ok) => dead.listen(0, "127.0.0.1", ok)); const deadPort = (dead.address() as any).port; dead.close(); await new Promise((r) => setTimeout(r, 20));
  const open = (a: any, sig: AbortSignal) => (a.kind === "tcp" ? tcpConnect(a.host, a.port, 2000, sig) : new Promise<any>((_, no) => setTimeout(() => no(new Error("relay down")), 10)));
  const t = Date.now(), r = await raceConnect([{ kind: "tcp", host: "127.0.0.1", port: deadPort, src: "learned" }, { kind: "tcp", host: "127.0.0.1", port, src: "learned" }], open, { stagger: 50 });
  assert.equal(r.addr.port, port); assert.ok(Date.now() - t < 1500); assert.equal(r.failed.length, 1); r.sock.destroy();
  await assert.rejects(raceConnect([{ kind: "tcp", host: "127.0.0.1", port: deadPort, src: "learned" }, { kind: "relay", url: "ws://x", src: "manual" }], open, { stagger: 10, relayDelay: 20 }));
  const t2 = Date.now(), r2 = await raceConnect([{ kind: "relay", url: "ws://x", src: "manual" }, { kind: "tcp", host: "127.0.0.1", port, src: "learned" }], open, { stagger: 10, relayDelay: 300 });
  assert.equal(r2.addr.kind, "tcp", "direct beats a relay that was listed first"); assert.ok(Date.now() - t2 < 250); r2.sock.destroy(); srv.close();
});
test("relay rendezvous id: same for both devices, depends on the key, unguessable without it", () => {
  const k = randomBytes(32).toString("base64"), k2 = randomBytes(32).toString("base64");
  assert.equal(rendezvousId(k, "a", "b"), rendezvousId(k, "b", "a")); assert.notEqual(rendezvousId(k, "a", "b"), rendezvousId(k2, "a", "b")); assert.notEqual(rendezvousId(k, "a", "b"), rendezvousId(k, "a", "c")); assert.match(rendezvousId(k, "a", "b"), /^[0-9a-f]{64}$/);
});
test("SAS: 6 digits, equal for equal transcripts, different otherwise", () => {
  const a = randomBytes(32), b = randomBytes(32); assert.match(sasOf(a), /^\d{3} \d{3}$/); assert.equal(sasOf(a), sasOf(Buffer.from(a))); assert.notEqual(sasOf(a), sasOf(b));
});
test("bulk: large messages in pieces, reassembled; caps enforced; out-of-order and oversize rejected", async () => {
  const sent: any[] = []; const big = { v: "x".repeat(700_000), n: [1, 2, 3] };
  await sendBig({ send: async (m) => { sent.push(m); } }, "id1", "k", big); assert.ok(sent.length > 4); assert.ok(sent.every((m) => JSON.stringify(m).length < 200_000));
  const asm = new BigAssembler(); let out: any; for (const m of sent) out = asm.push(m) ?? out; assert.deepEqual(out.payload, big);
  await assert.rejects(sendBig({ send: async () => {} }, "x", "k", "y".repeat(2000), 1000), BigTooLarge);
  assert.throws(() => new BigAssembler().push({ ...sent[1] }), /order/); assert.throws(() => new BigAssembler(1000).push({ id: "a", kind: "k", i: 0, n: 3, d: "z".repeat(1500) }), /too large|bad/);
  const a2 = new BigAssembler(); for (let i = 0; i < 8; i++) a2.push({ id: "t" + i, kind: "k", i: 0, n: 2, d: "x" }); assert.throws(() => a2.push({ id: "t9", kind: "k", i: 0, n: 2, d: "x" }), /too many/);
});
test("blobs: a partial download is sealed on disk and resumes at the byte where it stopped; a wrong hash is discarded; 'none' accounts are never served or fetched", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "blob-")); const L = new Ledger(":memory:"); const data = randomBytes(450_000), key = randomBytes(32);
  const store = new Map<string, any>(); const media = { get: (a: string, k: string) => store.get(a + k), put: (a: string, k: string, v: any) => { store.set(a + k, v); }, has: (a: string, k: string) => store.has(a + k) };
  const hash = (await import("node:crypto")).createHash("sha256").update(data).digest("hex"), calls: number[] = []; let failAt = 200_000, none = false;
  const mk = (ask: any) => new Blobs({ ledger: L, media, dir, sealKey: key, modeNone: () => none, ask, peers: () => ["p"], progress: () => {} });
  const ask1 = async (_p: string, m: string, p: any) => { if (m === "blob.q") return { hash, size: data.length, mime: "x/y", name: "f" }; if (p.off >= failAt) throw new Error("link dropped"); calls.push(p.off); return { d: data.subarray(p.off, p.off + p.len).toString("base64") }; };
  const ref = { chat: "acc:c", msg: "m", att: "a" };
  assert.equal(await mk(ask1).fetch(ref), undefined, "interrupted");
  const part = new PartFile(join(dir, "blobs", hash + ".part"), key); const have = part.size(); assert.ok(have >= 192 * 1024 && have < data.length, "part file holds what arrived (sealed)");
  assert.ok(!readPart(join(dir, "blobs", hash + ".part")).includes(data.subarray(0, 64).toString("hex")), "not plaintext on disk");
  failAt = Infinity; calls.length = 0; const got = await mk(ask1).fetch(ref); assert.ok(got && Buffer.from(got.data).equals(data)); assert.equal(calls[0], have, "resumed at the stored offset");
  // wrong hash
  const ask2 = async (_p: string, m: string, p: any) => (m === "blob.q" ? { hash: "0".repeat(64), size: 10, mime: "x" } : { d: Buffer.alloc(10).toString("base64") });
  assert.equal(await mk(ask2).fetch({ chat: "acc:c", msg: "m2", att: "a" }), undefined);
  none = true; assert.equal(await mk(ask1).fetch({ chat: "acc:c", msg: "m3", att: "a" }), undefined); assert.equal(mk(ask1).query({ chat: "acc:c", msg: "m", att: "a" }), null);
  rmSync(dir, { recursive: true, force: true });
});
import { readFileSync } from "node:fs";
const readPart = (f: string) => readFileSync(f).toString("hex");
