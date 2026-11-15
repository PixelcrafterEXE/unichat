// Offline tests: no network, no Signal servers. Uses libsignal's real crypto with two in-memory stores
// (Alice = a peer, Bob = our linked account) to exercise prekeys -> X3DH/PQXDH -> decrypt -> inbound mapping.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Aci, IdentityKeyPair, KEMPublicKey, PreKeyBundle, ProtocolAddress, processPreKeyBundle, signalEncrypt,
} from "@signalapp/libsignal-client";
import type { CoreEvent } from "@unimsg/core";
import { ContentCodec, EnvelopeCodec, EnvelopeType, ProvisionMessageCodec } from "../protocol/codec.js";
import { padContent, unpadContent } from "../protocol/padding.js";
import { SignalStore } from "../store/signalStore.js";
import { open, seal } from "../store/secureFile.js";
import { decryptEnvelope } from "../service/decrypt.js";
import { groupChatId, groupIdFromMasterKey } from "../service/groups.js";
import { Inbound, messageId, parseMessageId } from "../service/inbound.js";
import { buildLinkUrl } from "../service/linking.js";
import { newLastResortKyber, newOneTimeKyberKeys, newOneTimePreKeys, newSignedPreKey } from "../service/keys.js";
import { encryptDeviceName } from "../protocol/deviceName.js";
import { X509Certificate, randomBytes } from "node:crypto";
import { attachmentUrl, decryptAttachmentBlob, encryptAttachmentBlob } from "../service/attachments.js";
import { SignalClient } from "../service/client.js";
import { SIGNAL_TLS_ROOT_PEM } from "../service/constants.js";
import { buildContactStream, parseContactStream } from "../service/contacts.js";
import { EnvelopeError } from "../service/decrypt.js";
import {
  PADDED_LENGTHS, buildPutProfileBody, decryptProfile, decryptProfileName, decryptProfileText, encryptProfile,
  encryptProfileItemWithPadding, profileKeyCommitment, profileKeyVersion,
} from "../service/profileCrypto.js";
import { buildAvatarMultipart, sniffImageMime, splitName } from "../service/ownProfile.js";
import { describeDuration, renderMentions, timerNotice } from "../service/richContent.js";
import { ErrorCode, LibSignalErrorBase } from "@signalapp/libsignal-client";
import { LookupError, parseHandle } from "../service/lookup.js";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

async function makeStore(aci: string, deviceId: number): Promise<SignalStore> {
  const s = new SignalStore(mkdtempSync(join(tmpdir(), "unimsg-signal-")));
  await s.load();
  const id = IdentityKeyPair.generate();
  s.setAccount({ aci, deviceId, password: "x", registrationId: 1234 + deviceId, aciIdentity: b64(id.serialize()), readReceipts: true, linkedAt: 0 });
  return s;
}

test("padding roundtrip", () => {
  for (const n of [0, 1, 158, 159, 160, 500]) {
    const p = padContent(new Uint8Array(n).fill(7));
    assert.equal(p.length % 160, 0);
    assert.deepEqual(unpadContent(p), new Uint8Array(n).fill(7));
  }
  assert.throws(() => unpadContent(new Uint8Array([1, 2, 3])));
});

test("protobuf codecs", () => {
  const bytes = ContentCodec.encode({ dataMessage: { body: "hi", timestamp: 1700000000123, quote: { id: 5, authorAci: ALICE } } });
  const c = ContentCodec.decode(bytes);
  assert.equal(c.dataMessage?.body, "hi");
  assert.equal(c.dataMessage?.timestamp, 1700000000123);
  assert.equal(c.dataMessage?.quote?.authorAci, ALICE);
  const e = EnvelopeCodec.decode(EnvelopeCodec.encode({ type: EnvelopeType.PREKEY_MESSAGE, sourceServiceId: ALICE, sourceDeviceId: 2, content: new Uint8Array([1, 2]) }));
  assert.equal(e.type, 3); assert.equal(e.sourceDeviceId, 2);
  const p = ProvisionMessageCodec.decode(ProvisionMessageCodec.encode({ aci: ALICE, provisioningCode: "abc" }));
  assert.equal(p.provisioningCode, "abc");
});

test("message ids and link url", () => {
  assert.deepEqual(parseMessageId(messageId(ALICE, 42)), { author: ALICE, timestamp: 42 });
  assert.throws(() => parseMessageId("garbage"));
  const u = new URL(buildLinkUrl("addr-1", new Uint8Array(33).fill(5)));
  assert.equal(u.protocol, "sgnl:"); assert.equal(u.searchParams.get("uuid"), "addr-1");
  assert.equal(u.searchParams.get("pub_key"), b64(new Uint8Array(33).fill(5)));
});

test("sealed store: encrypt/decrypt, 0600, tamper detection", async () => {
  const k = new Uint8Array(32).fill(9);
  assert.deepEqual(new Uint8Array(open(k, seal(k, Buffer.from("secret")))), new Uint8Array(Buffer.from("secret")));
  const bad = seal(k, Buffer.from("secret")); bad[bad.length - 1] ^= 1;
  assert.throws(() => open(k, bad));
  const dir = mkdtempSync(join(tmpdir(), "unimsg-signal-"));
  const s = new SignalStore(dir); await s.load();
  s.data.names["x"] = "plain-marker"; await s.flush();
  const file = join(dir, "signal-store.bin");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "signal-store.key")).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file).includes("plain-marker"));
  const s2 = new SignalStore(dir); await s2.load();
  assert.equal(s2.data.names["x"], "plain-marker");
  await s2.wipe();
});

test("group id derivation is deterministic", () => {
  const mk = new Uint8Array(32).fill(3);
  const a = groupChatId(groupIdFromMasterKey(mk));
  assert.equal(a, groupChatId(groupIdFromMasterKey(mk)));
  assert.match(a, /^g\./);
});

test("device name encryption produces a DeviceName proto", () => {
  const id = IdentityKeyPair.generate();
  const out = Buffer.from(encryptDeviceName("UniChat", id.publicKey), "base64");
  assert.ok(out.length > 33 + 16);
});

test("end to end: prekey message from a peer is decrypted and mapped to a Message event", async () => {
  const bob = await makeStore(BOB, 1);
  const alice = await makeStore(ALICE, 1);
  // Bob publishes keys
  const spk = await newSignedPreKey(bob, "aci");
  const kyber = await newLastResortKyber(bob, "aci");
  const [otpk] = await newOneTimePreKeys(bob, "aci", 2);
  await newOneTimeKyberKeys(bob, "aci", 1);
  const bobIdentity = IdentityKeyPair.deserialize(new Uint8Array(Buffer.from(bob.requireAccount().aciIdentity, "base64")));
  const bundle = PreKeyBundle.new(bob.requireAccount().registrationId, 1, otpk!.id(), otpk!.publicKey(), spk.id(), spk.publicKey(),
    spk.signature(), bobIdentity.publicKey, kyber.id(), KEMPublicKey.deserialize(kyber.publicKey().serialize()), kyber.signature());
  const aSt = alice.stores("aci");
  const aliceAddr = ProtocolAddress.new(Aci.fromUuid(ALICE), 1);
  const bobAddr = ProtocolAddress.new(Aci.fromUuid(BOB), 1);
  await processPreKeyBundle(bundle, bobAddr, aliceAddr, aSt.sessions, aSt.identities);
  const ts = 1700000000000;
  const plain = padContent(ContentCodec.encode({ dataMessage: { body: "hello bob", timestamp: ts } }));
  const ct = await signalEncrypt(plain, bobAddr, aliceAddr, aSt.sessions, aSt.identities);
  const env = { type: EnvelopeType.PREKEY_MESSAGE, sourceServiceId: ALICE, sourceDeviceId: 1, destinationServiceId: BOB, clientTimestamp: ts, content: ct.serialize() };
  const d = await decryptEnvelope(bob, env);
  assert.ok(d); assert.equal(d.senderAci, ALICE);
  const events: CoreEvent[] = [];
  await new Inbound("acc", bob, (e) => events.push(e)).handle(d, ts);
  const msg = events.find((e) => e.type === "message");
  assert.ok(msg && msg.type === "message");
  assert.equal(msg.data.text, "hello bob"); assert.equal(msg.data.chatId, ALICE); assert.equal(msg.data.id, `${ALICE}.${ts}`); assert.equal(msg.data.fromMe, false);
  // one-time prekey consumed
  await assert.rejects(bob.stores("aci").preKeys.getPreKey(otpk!.id()));
  // sync transcript from a non-self sender is ignored; from self it becomes a fromMe message
  const ev2: CoreEvent[] = [];
  const inb = new Inbound("acc", bob, (e) => ev2.push(e));
  await inb.handle({ senderAci: ALICE, senderDevice: 1, sealed: false, content: { syncMessage: { sent: { destinationServiceId: ALICE, timestamp: 5, message: { body: "spoof", timestamp: 5 } } } } }, 5);
  assert.equal(ev2.filter((e) => e.type === "message").length, 0);
  await inb.handle({ senderAci: BOB, senderDevice: 2, sealed: false, content: { syncMessage: { sent: { destinationServiceId: ALICE, timestamp: 6, message: { body: "from my phone", timestamp: 6 } } } } }, 6);
  const mine = ev2.find((e) => e.type === "message");
  assert.ok(mine && mine.type === "message" && mine.data.fromMe && mine.data.chatId === ALICE);
  // receipt routes through sentIndex
  await inb.handle({ senderAci: ALICE, senderDevice: 1, sealed: false, content: { receiptMessage: { type: 1, timestamp: [6] } } }, 7);
  const r = ev2.find((e) => e.type === "receipt");
  assert.ok(r && r.type === "receipt" && r.data.status === "read" && r.data.messageId === `${BOB}.6`);
  // per-recipient: who + when (envelope time); my own account never counts; server delivery receipts carry the server time
  const T = Date.UTC(2026, 0, 2, 3, 4, 5);
  await inb.handle({ senderAci: ALICE, senderDevice: 1, sealed: false, content: { receiptMessage: { type: 0, timestamp: [6] } } }, T);
  await inb.handle({ senderAci: BOB, senderDevice: 2, sealed: false, content: { receiptMessage: { type: 1, timestamp: [6] } } }, T);
  inb.serverDeliveryReceipt(ALICE, 6, T + 1000);
  const per = ev2.filter((e) => e.type === "receipt").map((e) => (e as any).data).filter((d) => d.at);
  assert.deepEqual(per.map((d) => [d.status, d.by, d.at]), [["delivered", ALICE, "2026-01-02T03:04:05.000Z"], ["delivered", ALICE, "2026-01-02T03:04:06.000Z"]]);
  assert.equal(ev2.filter((e) => e.type === "receipt" && (e as any).data.by === BOB).length, 0);
  // reactions carry `mine`
  inb.applyReaction(ALICE, `${BOB}.6`, BOB, "👍", false);
  const up = ev2.filter((e) => e.type === "message-update").pop();
  assert.ok(up && up.type === "message-update");
  assert.deepEqual(up.data.patch.reactions, [{ emoji: "👍", senderIds: [BOB], mine: true }]);
});

test("attachment crypto round trip, tamper detection, URLs, pinned root", () => {
  const plain = randomBytes(1000);
  const padded = Buffer.concat([plain, Buffer.alloc(24)]); // senders pad attachments; size says how much is real
  const { blob, key, digest } = encryptAttachmentBlob(padded);
  assert.deepEqual(decryptAttachmentBlob(blob, key, { digest, size: 1000 }), plain);
  const bad = Buffer.from(blob); bad[20] ^= 1;
  assert.throws(() => decryptAttachmentBlob(bad, key, {}), /digest|MAC/);
  assert.throws(() => decryptAttachmentBlob(bad, key, { digest }), /digest/);
  assert.throws(() => decryptAttachmentBlob(blob, key, { digest: Buffer.alloc(32) }), /digest/);
  assert.equal(attachmentUrl({ cdnNumber: 3, cdnKey: "a/b" }).href, "https://cdn3.signal.org/attachments/a%2Fb");
  assert.equal(attachmentUrl({ cdnId: 77 }).href, "https://cdn.signal.org/attachments/77");
  const cert = new X509Certificate(SIGNAL_TLS_ROOT_PEM);
  assert.equal(cert.fingerprint256, "DD:B0:F9:2B:B9:5C:8D:6F:D2:02:EA:6E:8C:C5:CC:D1:82:B5:44:F8:CD:69:6F:47:D5:80:65:9D:DC:9D:F6:5A");
});

test("contact sync blob: encrypted ContactDetails stream round trip", () => {
  const stream = buildContactStream([
    { aci: ALICE, number: "+15550001", name: "Alice A" },
    { aci: BOB, number: "+15550002" },
    { aci: "33333333-3333-4333-8333-333333333333", name: "x".repeat(300) }, // 2-byte varint length
  ]);
  const { blob, key, digest } = encryptAttachmentBlob(stream);
  const got = parseContactStream(decryptAttachmentBlob(blob, key, { digest, size: stream.length }));
  assert.equal(got.length, 3);
  assert.deepEqual(got[0], { aci: ALICE, number: "+15550001", name: "Alice A" });
  assert.equal(got[1]!.name, undefined);
  assert.equal(got[2]!.name!.length, 300);
  assert.throws(() => parseContactStream(stream.subarray(0, stream.length - 5)));
});

test("parseHandle", () => {
  assert.deepEqual(parseHandle(ALICE.toUpperCase()), { kind: "aci", aci: ALICE });
  assert.deepEqual(parseHandle("+49 (151) 234-5678"), { kind: "e164", e164: "+491512345678" });
  assert.deepEqual(parseHandle("@nick_1.42"), { kind: "username", username: "nick_1.42" });
  assert.throws(() => parseHandle("0151234"), LookupError);
  assert.throws(() => parseHandle("hello"), LookupError);
});

test("chats(): Note to Self always present; contacts become named DM chats; blocked senders dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unimsg-signal-"));
  const client = new SignalClient({ accountId: "acc", dataDir: dir });
  assert.deepEqual(client.chats(), []); // before start
  await client.store.load();
  client.store.setAccount({ aci: BOB, deviceId: 2, password: "x", registrationId: 1, aciIdentity: b64(IdentityKeyPair.generate().serialize()), readReceipts: true, linkedAt: 0 });
  const events: CoreEvent[] = [];
  const priv = client as unknown as { makeInbound(): void; emit: (e: CoreEvent) => void; inbound: Inbound };
  priv.emit = (e) => events.push(e);
  priv.makeInbound();
  const first = client.chats();
  assert.equal(first.length, 1);
  assert.deepEqual([first[0]!.id, first[0]!.kind, first[0]!.name], [BOB, "dm", "Note to Self"]);
  // contact sync result: stored contacts show up as chats, named by name then number
  client.store.data.contacts[ALICE] = { aci: ALICE, number: "+15550001", name: "Alice A" };
  client.store.upsertChat({ id: ALICE, kind: "dm" });
  const c2 = "33333333-3333-4333-8333-333333333333";
  client.store.data.contacts[c2] = { aci: c2, number: "+15550003" };
  client.store.upsertChat({ id: c2, kind: "dm" });
  const names = Object.fromEntries(client.chats().map((c) => [c.id, c.name]));
  assert.deepEqual(names, { [BOB]: "Note to Self", [ALICE]: "Alice A", [c2]: "+15550003" });
  // blocked contact: incoming dropped
  client.store.data.contacts[ALICE]!.blocked = true;
  priv.inbound.hooks = {};
  await priv.inbound.handle({ senderAci: ALICE, senderDevice: 1, sealed: false, content: { dataMessage: { body: "hi", timestamp: 9 } } }, 9);
  assert.equal(events.filter((e) => e.type === "message").length, 0);
  // note-to-self transcript from another device lands in the self chat
  await priv.inbound.handle({ senderAci: BOB, senderDevice: 1, sealed: false, content: { syncMessage: { sent: { destinationServiceId: BOB, timestamp: 10, message: { body: "note", timestamp: 10 } } } } }, 10);
  const m = events.find((e) => e.type === "message");
  assert.ok(m && m.type === "message" && m.data.chatId === BOB && m.data.fromMe);
  // contacts blob hook fires only for own sync messages
  let fired = 0; priv.inbound.hooks.onContactsBlob = () => { fired++; };
  const blobMsg = { syncMessage: { contacts: { blob: { cdnKey: "k", cdnNumber: 2, key: new Uint8Array(64) }, complete: true } } };
  await priv.inbound.handle({ senderAci: ALICE, senderDevice: 1, sealed: false, content: blobMsg }, 11);
  assert.equal(fired, 0);
  await priv.inbound.handle({ senderAci: BOB, senderDevice: 1, sealed: false, content: blobMsg }, 12);
  assert.equal(fired, 1);
  await client.store.wipe();
});

test("regression: envelopes carrying only *Binary service ids decrypt (was 'malformed envelope'); bad envelopes raise content-free codes", async () => {
  const bob = await makeStore(BOB, 1);
  const alice = await makeStore(ALICE, 1);
  const spk = await newSignedPreKey(bob, "aci");
  const kyber = await newLastResortKyber(bob, "aci");
  const [otpk] = await newOneTimePreKeys(bob, "aci", 1);
  const bobId = IdentityKeyPair.deserialize(new Uint8Array(Buffer.from(bob.requireAccount().aciIdentity, "base64")));
  const bundle = PreKeyBundle.new(bob.requireAccount().registrationId, 1, otpk!.id(), otpk!.publicKey(), spk.id(), spk.publicKey(),
    spk.signature(), bobId.publicKey, kyber.id(), KEMPublicKey.deserialize(kyber.publicKey().serialize()), kyber.signature());
  const aSt = alice.stores("aci");
  const aliceAddr = ProtocolAddress.new(Aci.fromUuid(ALICE), 1);
  const bobAddr = ProtocolAddress.new(Aci.fromUuid(BOB), 1);
  await processPreKeyBundle(bundle, bobAddr, aliceAddr, aSt.sessions, aSt.identities);
  const ct = await signalEncrypt(padContent(ContentCodec.encode({ dataMessage: { body: "via binary ids", timestamp: 77 } })), bobAddr, aliceAddr, aSt.sessions, aSt.identities);
  // wire form as a modern server sends it: binary ids only, legacy string fields absent; round-trip through the codec
  const wire = EnvelopeCodec.encode({
    type: EnvelopeType.PREKEY_MESSAGE, sourceServiceIdBinary: Aci.fromUuid(ALICE).getRawUuidBytes(), sourceDeviceId: 1,
    destinationServiceIdBinary: Aci.fromUuid(BOB).getRawUuidBytes(), clientTimestamp: 77, content: ct.serialize(), urgent: true,
  });
  const env = EnvelopeCodec.decode(wire);
  assert.equal(env.sourceServiceId, undefined);
  const d = await decryptEnvelope(bob, env);
  assert.ok(d && d.senderAci === ALICE && d.content.dataMessage?.body === "via binary ids");
  // unusable envelopes: typed, content-free errors; never a chat message
  await assert.rejects(decryptEnvelope(bob, { type: EnvelopeType.DOUBLE_RATCHET, content: new Uint8Array([1]) }), (e) => e instanceof EnvelopeError && e.code === "envelope-no-source");
  await assert.rejects(decryptEnvelope(bob, { type: EnvelopeType.UNIDENTIFIED_SENDER }), (e) => e instanceof EnvelopeError && e.code === "envelope-no-content");
  assert.equal(await decryptEnvelope(bob, { type: EnvelopeType.SERVER_DELIVERY_RECEIPT }), null);
  assert.equal(await decryptEnvelope(bob, {}), null);
  // sync transcript to Note to Self addressed only via destinationServiceIdBinary lands in the self chat
  const events: CoreEvent[] = [];
  const inb = new Inbound("acc", bob, (e) => events.push(e));
  await inb.handle({ senderAci: BOB, senderDevice: 1, sealed: false, content: { syncMessage: { sent: {
    destinationServiceIdBinary: Aci.fromUuid(BOB).getRawUuidBytes(), timestamp: 5, message: { body: "note", timestamp: 5 } } } } }, 5);
  const m = events.find((e) => e.type === "message");
  assert.ok(m && m.type === "message" && m.data.chatId === BOB && m.data.text === "note");
  assert.ok(events.every((e) => e.type !== "message" || e.data.text === "note")); // nothing else became a message
});

test("polls: wire round trip, create/vote/replace/stale/terminate, mine, creator-only close", async () => {
  const enc = ContentCodec.encode({ dataMessage: { timestamp: 5, pollCreate: { question: "Lunch?", allowMultiple: false, options: ["Pizza", "Sushi"] } } });
  const dec = ContentCodec.decode(enc).dataMessage!;
  assert.deepEqual([dec.pollCreate?.question, dec.pollCreate?.allowMultiple, dec.pollCreate?.options], ["Lunch?", false, ["Pizza", "Sushi"]]);
  const vote = ContentCodec.decode(ContentCodec.encode({ dataMessage: { timestamp: 6, pollVote: {
    targetAuthorAciBinary: Aci.fromUuid(ALICE).getRawUuidBytes(), targetSentTimestamp: 5, optionIndexes: [1], voteCount: 2 } } })).dataMessage!.pollVote!;
  assert.deepEqual([vote.targetSentTimestamp, vote.optionIndexes, vote.voteCount], [5, [1], 2]);

  const bob = await makeStore(BOB, 1);
  const events: CoreEvent[] = [];
  const inb = new Inbound("acc", bob, (e) => events.push(e));
  const mk = (senderAci: string, dataMessage: object) => ({ senderAci, senderDevice: 1, sealed: false, content: { dataMessage } });
  await inb.handle(mk(ALICE, { timestamp: 5, pollCreate: { question: "Lunch?", allowMultiple: false, options: ["Pizza", "Sushi"] } }), 5);
  const created = events.find((e) => e.type === "message");
  assert.ok(created && created.type === "message" && created.data.poll);
  assert.deepEqual(created.data.poll.options.map((o) => [o.id, o.text, o.voters]), [["0", "Pizza", []], ["1", "Sushi", []]]);
  assert.equal(created.data.poll.multiple, false);
  const pid = `${ALICE}.5`;
  const last = () => (events.filter((e) => e.type === "message-update").pop() as Extract<CoreEvent, { type: "message-update" }>).data.patch.poll!;
  const target = Aci.fromUuid(ALICE).getRawUuidBytes();
  await inb.handle(mk(BOB, { timestamp: 6, pollVote: { targetAuthorAciBinary: target, targetSentTimestamp: 5, optionIndexes: [0], voteCount: 1 } }), 6);
  assert.deepEqual(last().mine, ["0"]);
  await inb.handle(mk(ALICE, { timestamp: 7, pollVote: { targetAuthorAciBinary: target, targetSentTimestamp: 5, optionIndexes: [1], voteCount: 1 } }), 7);
  assert.deepEqual(last().options.map((o) => o.voters), [[BOB], [ALICE]]);
  // my vote is replaced by a newer count; a stale count is ignored
  await inb.handle(mk(BOB, { timestamp: 8, pollVote: { targetAuthorAciBinary: target, targetSentTimestamp: 5, optionIndexes: [1], voteCount: 2 } }), 8);
  assert.deepEqual(last().options.map((o) => [...o.voters].sort()), [[], [ALICE, BOB]]);
  const n = events.length;
  await inb.handle(mk(BOB, { timestamp: 9, pollVote: { targetAuthorAciBinary: target, targetSentTimestamp: 5, optionIndexes: [0], voteCount: 2 } }), 9);
  assert.equal(events.length, n);
  // single-choice poll keeps only one pick; unknown indexes are dropped; retract with []
  await inb.handle(mk(ALICE, { timestamp: 10, pollVote: { targetAuthorAciBinary: target, targetSentTimestamp: 5, optionIndexes: [0, 1, 9], voteCount: 2 } }), 10);
  assert.deepEqual(last().options.map((o) => o.voters), [[ALICE], [BOB]]);
  await inb.handle(mk(BOB, { timestamp: 11, pollVote: { targetAuthorAciBinary: target, targetSentTimestamp: 5, optionIndexes: [], voteCount: 3 } }), 11);
  assert.deepEqual(last().mine, []);
  // only the creator can close
  await inb.handle(mk(BOB, { timestamp: 12, pollTerminate: { targetSentTimestamp: 5 } }), 12);
  assert.equal(last().closed, undefined);
  await inb.handle(mk(ALICE, { timestamp: 13, pollTerminate: { targetSentTimestamp: 5 } }), 13);
  assert.equal(last().closed, true);
  await inb.handle(mk(ALICE, { timestamp: 14, pollVote: { targetAuthorAciBinary: target, targetSentTimestamp: 5, optionIndexes: [1], voteCount: 9 } }), 14);
  assert.deepEqual(last().options.map((o) => o.voters), [[ALICE], []]); // closed: no change
  assert.ok(bob.data.polls[pid]);
});

test("profile field crypto: round trips, padding buckets, tamper/wrong key, PUT body", () => {
  const key = randomBytes(32);
  const enc = (t: string, l: readonly number[]) => encryptProfileItemWithPadding(Buffer.from(t), key, l);
  // padding buckets: 12 IV + padded + 16 tag
  assert.equal(enc("Ann", PADDED_LENGTHS.name).length, 12 + 53 + 16);
  assert.equal(enc("x".repeat(54), PADDED_LENGTHS.name).length, 12 + 257 + 16);
  assert.equal(enc("hi", PADDED_LENGTHS.about).length, 12 + 128 + 16);
  assert.equal(enc("a".repeat(255), PADDED_LENGTHS.about).length, 12 + 512 + 16);
  assert.equal(enc("\u{1F600}", PADDED_LENGTHS.aboutEmoji).length, 12 + 32 + 16);
  assert.throws(() => enc("x".repeat(258), PADDED_LENGTHS.name), /Oversized/);
  // names: given \0 family
  const n = encryptProfileItemWithPadding(Buffer.from("Zo\u00eb\0Van Der Berg"), key, PADDED_LENGTHS.name).toString("base64");
  assert.deepEqual(decryptProfileName(n, key), { given: "Zo\u00eb", family: "Van Der Berg" });
  const n2 = encryptProfileItemWithPadding(Buffer.from("Solo"), key, PADDED_LENGTHS.name).toString("base64");
  assert.deepEqual(decryptProfileName(n2, key), { given: "Solo", family: undefined });
  assert.equal(decryptProfileText(enc("Busy \u{1F680}", PADDED_LENGTHS.about).toString("base64"), key), "Busy \u{1F680}");
  // raw encryptProfile (avatar): unpadded, tamper + wrong key detected
  const img = randomBytes(500);
  const e = encryptProfile(img, key);
  assert.equal(e.length, 12 + 500 + 16);
  assert.deepEqual(decryptProfile(e, key), img);
  const bad = Buffer.from(e); bad[20] ^= 1;
  assert.throws(() => decryptProfile(bad, key), /could not decrypt/);
  assert.throws(() => decryptProfile(e, randomBytes(32)), /could not decrypt/);
  // version / commitment are deterministic per (key, aci)
  assert.equal(profileKeyVersion(key, ALICE), profileKeyVersion(key, ALICE));
  assert.notEqual(profileKeyVersion(key, ALICE), profileKeyVersion(key, BOB));
  assert.notEqual(profileKeyCommitment(key, ALICE), profileKeyCommitment(key, BOB));
  // PUT body: decryptable fields, carried-over opaque values, badge ids
  const body = buildPutProfileBody(key, ALICE, { given: "Ann", family: "Lee", about: "hello", aboutEmoji: "\u{1F44B}", hasAvatar: true, sameAvatar: false,
    carry: { phoneNumberSharing: "c2hhcmU=", paymentAddress: undefined, badges: [{ id: "b1", visible: true }, { id: "b2", visible: false }] } });
  assert.deepEqual(decryptProfileName(body.name, key), { given: "Ann", family: "Lee" });
  assert.equal(decryptProfileText(body.about!, key), "hello");
  assert.equal(decryptProfileText(body.aboutEmoji!, key), "\u{1F44B}");
  assert.equal(body.version, profileKeyVersion(key, ALICE));
  assert.equal(body.commitment, profileKeyCommitment(key, ALICE));
  assert.equal(body.phoneNumberSharing, "c2hhcmU="); assert.equal(body.paymentAddress, null);
  assert.deepEqual(body.badgeIds, ["b1"]);
  assert.equal(buildPutProfileBody(key, ALICE, { given: "A", hasAvatar: false, sameAvatar: false, carry: {} }).about, null);
});

test("avatar multipart form, name splitting, mime sniffing", () => {
  const form = { acl: "private", algorithm: "AWS4-HMAC-SHA256", credential: "cred", date: "20260101T000000Z", key: "profiles/abc", policy: "pol", signature: "sig" };
  const { body, contentType } = buildAvatarMultipart(form, Buffer.from("ENCRYPTED"), "deadbeef");
  assert.equal(contentType, "multipart/form-data; boundary=----------------deadbeef");
  const t = body.toString("latin1");
  for (const f of ["key", "x-amz-credential", "acl", "x-amz-algorithm", "x-amz-date", "policy", "x-amz-signature", "Content-Type"]) assert.ok(t.includes(`name="${f}"`));
  assert.ok(t.indexOf('name="key"') < t.indexOf('name="file"'));
  assert.ok(t.endsWith("ENCRYPTED\r\n------------------deadbeef--\r\n".replace("------------------", "--" + "----------------")));
  assert.deepEqual(splitName("  Ann   Marie Lee "), { given: "Ann", family: "Marie Lee" });
  assert.deepEqual(splitName("Cher"), { given: "Cher" });
  assert.equal(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff])), "image/jpeg");
  assert.equal(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e])), "image/png");
});

test("privacy settings: read receipts persisted + typing indicators appear after the phone's configuration sync", async () => {
  const client = new SignalClient({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-signal-")) });
  await client.store.load();
  client.store.setAccount({ aci: BOB, deviceId: 2, password: "x", registrationId: 1, aciIdentity: b64(IdentityKeyPair.generate().serialize()), readReceipts: true, linkedAt: 0 });
  const events: CoreEvent[] = [];
  const priv = client as unknown as { makeInbound(): void; emit: (e: CoreEvent) => void; inbound: Inbound };
  priv.emit = (e) => events.push(e);
  priv.makeInbound();
  assert.deepEqual(client.getPrivacy().map((p) => [p.id, p.value]), [["readReceipts", "on"], ["linkPreviews", "on"]]);
  const after = await client.setPrivacy("readReceipts", "off"); // not connected: local change holds, sync failure is reported as an event
  assert.deepEqual(after.map((p) => [p.id, p.value]), [["readReceipts", "off"], ["linkPreviews", "on"]]);
  assert.ok(events.some((e) => e.type === "error" && e.data.code === "privacy-sync-failed"));
  await assert.rejects(client.setPrivacy("typingIndicators", "off")); // unknown until the phone told us
  await assert.rejects(client.setPrivacy("nope", "on"));
  await priv.inbound.handle({ senderAci: BOB, senderDevice: 1, sealed: false, content: { syncMessage: { configuration: { readReceipts: true, typingIndicators: false } } } }, 1);
  assert.deepEqual(client.getPrivacy().map((p) => [p.id, p.value]), [["readReceipts", "on"], ["linkPreviews", "on"], ["typingIndicators", "off"]]);
  // typing indicators off: incoming typing events are dropped
  events.length = 0;
  await priv.inbound.handle({ senderAci: ALICE, senderDevice: 1, sealed: false, content: { typingMessage: { action: 0 } } }, 2);
  assert.equal(events.filter((e) => e.type === "typing").length, 0);
  await client.store.wipe();
});

test("rich content: mentions, durations, stickers, view-once, previews, story, gift, payment, calls, timers, pins, safety number, unsupported", async () => {
  assert.equal(renderMentions("hi \uFFFC and \uFFFC!", [
    { start: 3, length: 1, mentionAci: ALICE }, { start: 9, length: 1, mentionAciBinary: Aci.fromUuid(BOB).getRawUuidBytes() }, { start: 0, length: 2, style: 1 },
  ], (a) => (a === ALICE ? "Alice" : "Bob")), "hi @Alice and @Bob!");
  assert.equal(renderMentions("plain", undefined, () => "x"), "plain");
  assert.deepEqual([1, 5, 60, 3600, 86400, 604800, 2419200].map(describeDuration), ["1 second", "5 seconds", "1 minute", "1 hour", "1 day", "1 week", "4 weeks"]);
  assert.equal(timerNotice(0), "Disappearing messages: turned off");
  assert.equal(timerNotice(604800), "Disappearing messages: 1 week");

  const bob = await makeStore(BOB, 1);
  const events: CoreEvent[] = [];
  const inb = new Inbound("acc", bob, (e) => events.push(e));
  const msgs = () => events.filter((e): e is Extract<CoreEvent, { type: "message" }> => e.type === "message").map((e) => e.data);
  const send = (dataMessage: object, ts: number) => inb.handle({ senderAci: ALICE, senderDevice: 1, sealed: false, content: { dataMessage: { timestamp: ts, ...dataMessage } } }, ts);
  const ptr = { cdnKey: "k", cdnNumber: 2, key: new Uint8Array(64), contentType: "image/webp", size: 10 };
  const origDebug = console.debug; const debugLines: string[] = []; console.debug = (l: string) => { debugLines.push(l); };
  try {
    await send({ body: "see \uFFFC", bodyRanges: [{ start: 4, length: 1, mentionAci: BOB }] }, 1);
    assert.equal(msgs().at(-1)!.text, "see @You");
    await send({ sticker: { data: ptr, emoji: "\u{1F600}", stickerId: 1 } }, 2);
    let m = msgs().at(-1)!;
    assert.equal(m.text, "Sticker \u{1F600}"); assert.equal(m.attachments![0]!.kind, "sticker"); assert.ok(bob.data.attachments[m.attachments![0]!.id]);
    await send({ isViewOnce: true, attachments: [ptr] }, 3);
    m = msgs().at(-1)!;
    assert.match(m.text, /View-once/); assert.equal(m.attachments!.length, 1); assert.equal(bob.data.attachments[m.attachments![0]!.id], undefined);
    await send({ body: "look https://x.test", preview: [{ url: "https://x.test", title: "X", description: "desc" }] }, 4);
    m = msgs().at(-1)!;
    assert.equal(m.text, "look https://x.test"); assert.deepEqual(m.card, { kind: "link", title: "X", body: "desc", url: "https://x.test" });
    await send({ body: "nice!", storyContext: { authorAci: BOB, sentTimestamp: 1 } }, 5);
    m = msgs().at(-1)!; assert.equal(m.text, "nice!"); assert.equal(m.card?.title, "Reply to a story");
    await send({ reaction: { emoji: "\u2764", targetSentTimestamp: 1 }, storyContext: { authorAci: BOB, sentTimestamp: 1 } }, 6);
    m = msgs().at(-1)!; assert.match(m.text, /Reacted \u2764 to You.s story/); assert.equal(m.card?.title, "Story reaction");
    await send({ giftBadge: { receiptCredentialPresentation: new Uint8Array([1]) } }, 7);
    m = msgs().at(-1)!; assert.deepEqual([m.text, m.card?.kind], ["Gift badge", "payment"]);
    await send({ payment: { notification: { note: "pizza", mobileCoin: { receipt: new Uint8Array([1]) } } } }, 8);
    m = msgs().at(-1)!; assert.deepEqual([m.text, m.card?.kind, m.card?.body], ["Payment: pizza", "payment", "pizza"]);
    await send({ groupV2: { masterKey: new Uint8Array(32).fill(4) }, groupCallUpdate: { eraId: "e" } }, 9);
    m = msgs().at(-1)!; assert.deepEqual([m.text, m.card?.kind], ["Group call started", "call"]);
    await send({ flags: 2, expireTimer: 604800 }, 10);
    m = msgs().at(-1)!; assert.deepEqual([m.text, m.system?.kind], ["Disappearing messages: 1 week", "info"]);
    await send({ flags: 2 }, 11);
    assert.equal(msgs().at(-1)!.text, "Disappearing messages: turned off");
    await send({ flags: 4, profileKey: new Uint8Array(32) }, 12); // profile-key update: silent
    const n = msgs().length;
    await send({ pinMessage: { targetAuthorAciBinary: Aci.fromUuid(BOB).getRawUuidBytes(), targetSentTimestamp: 1, pinDurationForever: true } }, 13);
    assert.match(msgs().at(-1)!.text, /pinned a message/); assert.equal(msgs().length, n + 1);
    // calls: legacy offer, and the phone's call log
    await inb.handle({ senderAci: ALICE, senderDevice: 1, sealed: false, content: { callMessage: { offer: { id: 1, type: 1 } } } }, 14);
    m = msgs().at(-1)!; assert.deepEqual([m.text, m.card?.kind], ["Incoming video call", "call"]);
    await inb.handle({ senderAci: ALICE, senderDevice: 1, sealed: false, content: { callMessage: { hangup: { id: 1 } } } }, 15);
    assert.equal(msgs().at(-1)!.text, "Incoming video call"); // hangup alone produces nothing
    const ev = (e: object) => inb.handle({ senderAci: BOB, senderDevice: 2, sealed: false, content: { syncMessage: { callEvent: { conversationId: Aci.fromUuid(ALICE).getRawUuidBytes(), callId: 5, timestamp: 20, ...e } } } }, 20);
    await ev({ type: 1, direction: 1, event: 2 });
    m = msgs().at(-1)!; assert.deepEqual([m.text, m.card?.kind, m.chatId, m.fromMe], ["Missed voice call", "call", ALICE, false]);
    await ev({ type: 2, direction: 2, event: 1, timestamp: 21 });
    m = msgs().at(-1)!; assert.deepEqual([m.text, m.fromMe], ["Outgoing video call", true]);
    const before = msgs().length;
    await ev({ type: 1, direction: 1, event: 3 }); // DELETE: no entry
    assert.equal(msgs().length, before);
    // safety number
    inb.safetyNumberChanged(`${ALICE}.1`);
    m = msgs().at(-1)!; assert.deepEqual([m.system?.kind, m.chatId], ["info", ALICE]); assert.match(m.text, /safety number .* has changed/);
    inb.safetyNumberChanged(`${BOB}.2`); assert.equal(msgs().at(-1), m); // own identity: ignored
    // unknown content: placeholder + card + counts-only log
    await send({ futureThing: 1 }, 30);
    m = msgs().at(-1)!; assert.deepEqual([m.text, m.card], ["[unsupported message: futureThing]", { kind: "other", title: "futureThing" }]);
    await inb.handle({ senderAci: ALICE, senderDevice: 1, sealed: false, content: { content: "pollSomething" } as never }, 31);
    assert.equal(msgs().at(-1)!.text, "[unsupported message: pollSomething]");
    assert.deepEqual(debugLines, ["[signal] unsupported content field=futureThing count=1", "[signal] unsupported content field=pollSomething count=1"]);
  } finally { console.debug = origDebug; }
});

test("logout verifies a failed device removal instead of guessing; wipes locally in every case", async () => {
  const libErr = (name: keyof typeof ErrorCode) => new LibSignalErrorBase(name, name, "test");
  const run = async (opts: { removeErr?: unknown; connect: "linked" | Error; noChat?: boolean }) => {
    const client = new SignalClient({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-signal-")) });
    await client.store.load();
    client.store.setAccount({ aci: BOB, deviceId: 2, password: "pw", registrationId: 1, aciIdentity: b64(IdentityKeyPair.generate().serialize()), readReceipts: true, linkedAt: 0 });
    let removed = 0, connects = 0, disconnected = 0;
    const priv = client as unknown as { net: unknown; chatConn?: unknown; verifyDelayMs: number };
    priv.verifyDelayMs = 0;
    priv.net = { connectAuthenticatedChat: async () => {
      connects++;
      if (opts.connect !== "linked") throw opts.connect;
      return { disconnect: async () => { disconnected++; } };
    } };
    if (!opts.noChat) priv.chatConn = { removeDevice: async () => { removed++; if (opts.removeErr) throw opts.removeErr; }, disconnect: async () => {} };
    let thrown: unknown;
    try { await client.logout(); } catch (e) { thrown = e; }
    return { thrown, removed, connects, disconnected, wiped: client.store.data.account === null };
  };
  // removal succeeds: no verification needed
  let r = await run({ connect: new Error("unused") });
  assert.deepEqual([r.thrown, r.removed, r.connects, r.wiped], [undefined, 1, 0, true]);
  // removal throws (connection closed), then credentials are rejected -> device is gone -> no warning
  for (const gone of ["DeviceDelinked", "RequestUnauthorized"] as const) {
    r = await run({ removeErr: libErr("IoError"), connect: libErr(gone) });
    assert.deepEqual([r.thrown, r.connects, r.wiped], [undefined, 1, true]);
  }
  // removal throws, credentials still work -> still linked -> warn (and the verification connection is closed again)
  r = await run({ removeErr: libErr("ChatServiceInactive"), connect: "linked" });
  assert.match(String((r.thrown as Error).message), /Remove it manually/); assert.deepEqual([r.disconnected, r.wiped], [1, true]);
  // removal throws, network error on verification -> unknown -> warn
  r = await run({ removeErr: libErr("IoError"), connect: libErr("IoError") });
  assert.match(String((r.thrown as Error).message), /Remove it manually/); assert.equal(r.wiped, true);
  r = await run({ removeErr: new Error("socket hang up"), connect: new Error("ENOTFOUND") });
  assert.ok(r.thrown);
  // never connected (no chat connection) but already unlinked on the phone -> verified gone
  r = await run({ noChat: true, connect: libErr("DeviceDelinked") });
  assert.deepEqual([r.thrown, r.removed, r.wiped], [undefined, 0, true]);
  // removal itself reports DeviceDelinked -> already gone, no verification connect
  r = await run({ removeErr: libErr("DeviceDelinked"), connect: "linked" });
  assert.deepEqual([r.thrown, r.connects], [undefined, 0]);
});

test("GIF flag marks attachments as gif (video/mp4 or image/gif) only", async () => {
  const bob = await makeStore(BOB, 1);
  const events: CoreEvent[] = [];
  const inb = new Inbound("acc", bob, (e) => events.push(e));
  const key = new Uint8Array(64);
  const att = (contentType: string, flags?: number) => ({ cdnKey: "k", cdnNumber: 2, key, contentType, flags });
  await inb.handle({ senderAci: ALICE, senderDevice: 1, sealed: false, content: { dataMessage: { timestamp: 1, attachments: [
    att("video/mp4", 8), att("image/gif", 8), att("video/mp4"), att("image/png", 8), att("audio/aac", 1),
  ] } } }, 1);
  const m = events.find((e) => e.type === "message");
  assert.ok(m && m.type === "message");
  const a = m.data.attachments!;
  assert.deepEqual(a.map((x) => [x.kind, x.gif === true]), [["video", true], ["image", true], ["video", false], ["image", false], ["voice", false]]);
});
