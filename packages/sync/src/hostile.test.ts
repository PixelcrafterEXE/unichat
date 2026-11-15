// A hostile host on the LAN: what it learns from answering our probe, and what a stranger learns / can do by dialing us.
import test from "node:test";
import assert from "node:assert/strict";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { accept, dial, ChannelError } from "./channel.js";
import { generateKeyPair, deviceIdOf } from "./noise.js";
import { newPairingCode, pairingPsk } from "./code.js";
import { node, until } from "./testkit.js";

const listen = async (onConn: (s: Socket) => void): Promise<{ srv: Server; port: number }> => { const srv = createServer(onConn); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); return { srv, port: (srv.address() as any).port }; };
const connect = (port: number) => new Promise<Socket>((ok) => { const c = createConnection({ host: "127.0.0.1", port }, () => ok(c)); c.on("error", () => {}); });
const frame = (b: Buffer) => { const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
/** what does the stranger see after `send`: bytes received and how long until we hung up */
async function probe(port: number, send: (c: Socket) => void, waitMs = 3000): Promise<{ bytes: number; ms: number; closed: boolean }> {
  const c = await connect(port), t0 = Date.now(); let bytes = 0; c.on("data", (d) => { bytes += d.length; });
  const closed = new Promise<boolean>((r) => { c.on("close", () => r(true)); setTimeout(() => r(false), waitMs); });
  send(c); const was = await closed; c.destroy(); return { bytes, ms: Date.now() - t0, closed: was };
}

test("a stranger gets nothing but silence: every refusal sends no bytes and takes the same minimum time", async () => {
  const me = generateKeyPair(), psk = pairingPsk(newPairingCode()), FLOOR = 250;
  const { srv, port } = await listen((s) => { accept(s, { s: me, hello: { id: deviceIdOf(me.pub), name: "SECRET-NAME" }, failFloorMs: FLOOR, timeoutMs: 2000, checkRemote() {},
    pskFor: (mode) => (mode === "pair-open" ? { psk } : undefined) }).catch(() => {}); });
  try {
    const pro = (o: object) => frame(Buffer.from(JSON.stringify(o)));
    const msg1 = frame(Buffer.alloc(48, 7));
    const cases: Record<string, (c: Socket) => void> = {
      "nothing open (unknown key)": (c) => { c.write(Buffer.concat([pro({ v: 1, mode: "pair" }), msg1])); },
      "pairing open, wrong code": (c) => { c.write(Buffer.concat([pro({ v: 1, mode: "pair-open" }), msg1])); },
      "unknown mode": (c) => { c.write(Buffer.concat([pro({ v: 1, mode: "zzz" }), msg1])); },
      "wrong version": (c) => { c.write(Buffer.concat([pro({ v: 9, mode: "pair" }), msg1])); },
      "garbage prologue": (c) => { c.write(Buffer.concat([frame(Buffer.from("not json")), msg1])); },
      "json null prologue": (c) => { c.write(Buffer.concat([pro(null as any), msg1])); },
    };
    const res: Record<string, { bytes: number; ms: number; closed: boolean }> = {};
    for (const [k, f] of Object.entries(cases)) res[k] = await probe(port, f);
    for (const [k, r] of Object.entries(res)) { assert.ok(r.closed, k + ": closed"); assert.equal(r.bytes, 0, k + ": sent nothing"); assert.ok(r.ms >= FLOOR - 15 && r.ms < FLOOR * 1.25 + 400, `${k}: ${r.ms} ms`); }
    // a stranger that stops after the prologue cannot tell either: all of them wait for message 1
    const idle = await probe(port, (c) => c.write(pro({ v: 1, mode: "pair" })), 1200); assert.equal(idle.closed, false, "held open until the handshake timeout, like a real pairing"); assert.equal(idle.bytes, 0);
    const idle2 = await probe(port, (c) => c.write(pro({ v: 1, mode: "pair-open" })), 1200); assert.equal(idle2.closed, false);
  } finally { srv.close(); }
});

test("pre-authentication frames are capped at 1 KiB at the length header: a huge frame is never buffered", async () => {
  const me = generateKeyPair(); let err: any;
  const { srv, port } = await listen((s) => { accept(s, { s: me, hello: {}, failFloorMs: 0, checkRemote() {}, pskFor: () => undefined }).catch((e) => { err = e; }); });
  try {
    const big = Buffer.alloc(4); big.writeUInt32BE(400_000);
    const r = await probe(port, (c) => c.write(big)); assert.ok(r.closed); assert.equal(r.bytes, 0);
    assert.ok(err instanceof ChannelError && err.code === "protocol", String(err));
    const zero = Buffer.alloc(4); const r2 = await probe(port, (c) => c.write(zero)); assert.ok(r2.closed);
    // slow drip of one frame: still bounded by the handshake timeout (see service test for the per-source cap)
  } finally { srv.close(); }
});

test("a hostile host that answers our probe sees only {v, mode} and one 48-byte message; it cannot make us hang, flood or leak", async () => {
  const me = generateKeyPair(), psk = pairingPsk(newPairingCode());
  for (const reply of ["silence", "garbage", "huge", "valid-looking-random", "hangup"] as const) {
    const seen: Buffer[] = [];
    const { srv, port } = await listen((s) => {
      s.on("data", (d) => { seen.push(d); if (reply === "garbage") s.write(frame(Buffer.from("hello stranger"))); if (reply === "huge") { const h = Buffer.alloc(4); h.writeUInt32BE(300_000); s.write(h); } if (reply === "valid-looking-random") s.write(frame(Buffer.alloc(200, 1))); if (reply === "hangup") s.destroy(); });
      s.on("error", () => {});
    });
    try {
      const sock = await connect(port), t0 = Date.now();
      await assert.rejects(dial(sock, { mode: "pair", psk, s: me, hello: { id: "SECRET", name: "MY-NAME", grp: 3 }, timeoutMs: 700, checkRemote() { assert.fail("must not get that far"); } }), (e: any) => e instanceof ChannelError);
      assert.ok(Date.now() - t0 < 1500, reply + " took " + (Date.now() - t0)); assert.ok(sock.destroyed, "socket closed");
      const all = Buffer.concat(seen).toString("latin1");
      assert.ok(!all.includes("SECRET") && !all.includes("MY-NAME"), "our identity is never sent before the other side proved the code");
      const pro = Buffer.concat(seen).subarray(4, 4 + Buffer.concat(seen).readUInt32BE(0)).toString();
      assert.deepEqual(Object.keys(JSON.parse(pro)).sort(), ["mode", "v"], "prologue: only version and mode");
      assert.equal(Buffer.concat(seen).length, 4 + pro.length + 4 + 32 + 16, "then only the first Noise message (ephemeral key + empty payload tag)");
    } finally { srv.close(); }
  }
});

test("service: at most 3 half-open handshakes per source and 8 overall; a slow or silent peer is dropped; wrong code locks the source out", async () => {
  const A = await node("A", "memory", undefined, undefined, undefined, { opts: { failFloorMs: 0, maxPairingFailures: 2 } });
  try {
    const p = await A.call("syncStartPairing", {});
    const held: Socket[] = []; for (let i = 0; i < 3; i++) { const c = await connect(p.port); c.write(frame(Buffer.from(JSON.stringify({ v: 1, mode: "pair" })))); held.push(c); }
    await until(() => (A.svc as any).unauth === 3, "three half-open handshakes");
    const fourth = await connect(p.port); const gone = await new Promise<boolean>((r) => { fourth.on("close", () => r(true)); setTimeout(() => r(false), 1000); });
    assert.ok(gone, "the 4th concurrent unauthenticated connection from the same source is refused at once");
    assert.equal((A.svc as any).unauth, 3, "refused ones do not count");
    for (const c of held) c.destroy(); await until(() => (A.svc as any).unauth === 0, "slots are released"); await new Promise((r) => setTimeout(r, 100)); (A.svc as any).src.clear();
    // wrong codes: counted per source, then locked out; the pairing itself stays open
    const wrong = async () => probe(p.port, (c) => c.write(Buffer.concat([frame(Buffer.from(JSON.stringify({ v: 1, mode: "pair" }))), frame(Buffer.alloc(48, 3))])));
    for (let i = 0; i < 2; i++) { const r = await wrong(); assert.equal(r.bytes, 0); }
    assert.equal((await A.call("syncStatus")).pairing.failures, 2);
    const locked = await wrong(); assert.equal(locked.bytes, 0); assert.ok(locked.ms < 500);
    assert.equal((await A.call("syncStatus")).pairing.failures, 2, "locked-out source no longer reaches the handshake");
    assert.ok((await A.call("syncStatus")).pairing, "still open for others");
    // the global cap of simultaneous half-open handshakes (8) holds even when the per-source limit is not reached
    (A.svc as any).src.clear(); (A.svc as any).unauth = 8;
    const cap = await connect(p.port); assert.ok(await new Promise<boolean>((r) => { cap.on("close", () => r(true)); setTimeout(() => r(false), 800); }), "global cap");
    (A.svc as any).unauth = 0;
  } finally { await A.stop(); }
});
