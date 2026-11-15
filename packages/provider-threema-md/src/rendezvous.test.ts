import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { RendezvousChannel, wsTransport } from "./rendezvous.js";
import { FakeRendezvous } from "./fake/servers.js";
import { decode, encode } from "./proto.js";
import { DeviceGroupJoinRequestOrOffer, Envelope, GroupSync } from "./schemas.js";
import { joinUrl } from "./join.js";

test("rendezvous: RID and RRD authenticate, derive the same RPH, nominate and exchange encrypted frames both ways", async () => {
  const rz = new FakeRendezvous(); const base = await rz.start(); const ak = new Uint8Array(randomBytes(32)); const url = base + "ab".repeat(32);
  const [a, b] = await Promise.all([wsTransport(url), wsTransport(url)]);
  const rid = new RendezvousChannel("rid", ak, 1, a), rrd = new RendezvousChannel("rrd", ak, 1, b);
  try {
    const [r1, r2] = await Promise.all([rid.handshake(5000), rrd.handshake(5000)]);
    assert.deepEqual([...r1.rph], [...r2.rph]); assert.equal(r1.rph.length, 32);
    await rrd.nominate(); await rid.awaitNominate(5000);
    rid.send(new Uint8Array([1, 2, 3])); assert.deepEqual([...await rrd.recv(2000)], [1, 2, 3]);
    const big = new Uint8Array(randomBytes(300_000)); rrd.send(big); assert.deepEqual([...await rid.recv(2000)], [...big]);
  } finally { rid.close(); rrd.close(); await rz.close(); }
});

test("rendezvous: a wrong authentication key fails the handshake", async () => {
  const rz = new FakeRendezvous(); const base = await rz.start(); const url = base + "cd".repeat(32);
  const [a, b] = await Promise.all([wsTransport(url), wsTransport(url)]);
  const rid = new RendezvousChannel("rid", new Uint8Array(32).fill(1), 1, a), rrd = new RendezvousChannel("rrd", new Uint8Array(32).fill(2), 1, b);
  try { const r = await Promise.allSettled([rid.handshake(1500), rrd.handshake(1500)]); assert.ok(r.every((x) => x.status === "rejected")); } finally { rid.close(); rrd.close(); await rz.close(); }
});

test("join URL is threema://device-group/join#<base64url protobuf> with request_to_join and a relayed WebSocket path", () => {
  const u = joinUrl(new Uint8Array(32).fill(7), "wss://example.invalid/ab/" + "00".repeat(32));
  const m = /^threema:\/\/device-group\/join#([A-Za-z0-9_-]+)$/.exec(u)!; assert.ok(m);
  const d = decode(DeviceGroupJoinRequestOrOffer, new Uint8Array(Buffer.from(m[1], "base64url")));
  assert.ok(d.variant.requestToJoin); assert.equal(d.rendezvousInit.ak.length, 32); assert.equal(d.rendezvousInit.relayedWebSocket.pathId, 1); assert.match(d.rendezvousInit.relayedWebSocket.url, /^wss:\/\//);
});

test("protobuf codec: varints, fixed64, nested, repeated, maps, unknown fields skipped", () => {
  const e = encode(Envelope, { deviceId: 0xfedcba9876543210n, protocolVersion: 3, incomingMessage: { senderIdentity: "ABCDEFGH", messageId: 1n << 63n, createdAt: 1700000000000n, type: 1, body: new Uint8Array([1, 2, 3]) } });
  const d = decode(Envelope, e); assert.equal(d.deviceId, 0xfedcba9876543210n); assert.equal(d.incomingMessage.messageId, 1n << 63n); assert.equal(d.incomingMessage.createdAt, 1700000000000n); assert.deepEqual([...d.incomingMessage.body], [1, 2, 3]);
  // known wire bytes (protobuf encoding spec example): field 1 varint 150 = 08 96 01; our Envelope field 3 (protocol_version) = 150 -> 18 96 01
  assert.deepEqual([...encode(Envelope, { protocolVersion: 150 })], [0x18, 0x96, 0x01]);
  const gs = decode(GroupSync, encode(GroupSync, { update: { group: { name: "g" }, memberStateChanges: new Map([["ABCDEFGH", 2]]) } })); assert.equal(gs.update.memberStateChanges.get("ABCDEFGH"), 2);
  assert.equal(decode(Envelope, new Uint8Array([0x78, 0x01, 0x18, 0x05])).protocolVersion, 5); // unknown field 15 skipped
  assert.throws(() => decode(Envelope, new Uint8Array([0x0a, 0x05, 1])), /truncated/);
});
