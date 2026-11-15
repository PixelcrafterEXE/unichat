// Where profile keys come from: inbound messages (DM + group), storage records, Secure Backup import (importContacts); plus name sanitizing.
// Generated keys and fake stores only.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IdentityKeyPair } from "@signalapp/libsignal-client";
import type { CoreEvent } from "@unimsg/core";
import { SignalClient } from "../service/client.js";
import { Inbound } from "../service/inbound.js";
import { StorageSync } from "../service/storageSync.js";
import { cleanName, decryptProfileName, encryptProfile, PADDED_LENGTHS, encryptProfileItemWithPadding } from "../service/profileCrypto.js";
import { A, B, C, ME, b64, makeStore } from "./fixtures.js";

const dm = (extra: object = {}) => ({ senderAci: A, senderDevice: 1, sealed: false, content: { dataMessage: { body: "hi", timestamp: 1, ...extra } } });

test("an inbound DM carries the sender's profile key: stored (32 bytes only), hook fired once, a changed key replaces it", async () => {
  const store = await makeStore(ME, 2); const inb = new Inbound("acc", store, () => {}); const seen: string[] = [];
  inb.hooks.onProfileKey = (a) => seen.push(a);
  const k1 = randomBytes(32), k2 = randomBytes(32);
  await inb.handle(dm({ profileKey: randomBytes(31) }) as never, 1); assert.equal(store.data.contacts[A]?.profileKey, undefined, "wrong length ignored");
  await inb.handle(dm({ profileKey: k1 }) as never, 1); assert.equal(store.data.contacts[A]?.profileKey, b64(k1));
  await inb.handle(dm({ profileKey: k1, timestamp: 2 }) as never, 2); assert.deepEqual(seen, [A], "unchanged key: no second hook");
  await inb.handle(dm({ profileKey: k2, timestamp: 3 }) as never, 3); assert.equal(store.data.contacts[A]?.profileKey, b64(k2)); assert.deepEqual(seen, [A, A]);
});

test("a group message teaches the sender's key; a blocked sender teaches nothing; our own key is never stored as a contact", async () => {
  const store = await makeStore(ME, 2); const inb = new Inbound("acc", store, () => {});
  const k = randomBytes(32);
  await inb.handle({ senderAci: B, senderDevice: 1, sealed: true, content: { dataMessage: { body: "g", timestamp: 5, groupV2: { masterKey: randomBytes(32), revision: 0 }, profileKey: k } } } as never, 5);
  assert.equal(store.data.contacts[B]?.profileKey, b64(k));
  store.data.contacts[C] = { aci: C, localBlocked: true };
  await inb.handle({ senderAci: C, senderDevice: 1, sealed: false, content: { dataMessage: { body: "x", timestamp: 6, profileKey: randomBytes(32) } } } as never, 6);
  assert.equal(store.data.contacts[C]?.profileKey, undefined);
  await inb.handle({ senderAci: ME, senderDevice: 3, sealed: false, content: { dataMessage: { body: "x", timestamp: 7, profileKey: randomBytes(32) } } } as never, 7);
  assert.equal(store.data.contacts[ME], undefined);
});

test("storage contact records map the profile key, with or without any name, and keyed contacts survive", async () => {
  const store = await makeStore(ME, 2); const seen: string[] = [];
  const ss = new StorageSync(store, {} as never, { onChanged() {}, onProfileKey: (a: string) => seen.push(a) } as never) as unknown as { applyContact(r: object, c: object): string | undefined };
  const k = randomBytes(32);
  assert.equal(ss.applyContact({ aci: A, profileKey: k }, { changed: false, newGroups: [], me: ME }), A);
  assert.equal(store.data.contacts[A]?.profileKey, b64(k)); assert.deepEqual(seen, [A]);
  ss.applyContact({ aci: A, profileKey: randomBytes(5) }, { changed: false, newGroups: [], me: ME }); assert.equal(store.data.contacts[A]?.profileKey, b64(k), "invalid key does not erase");
});

async function client() {
  const c = new SignalClient({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-signal-pk-")) });
  await c.store.load();
  c.store.setAccount({ aci: ME, deviceId: 2, password: "pw", registrationId: 5, aciIdentity: Buffer.from(IdentityKeyPair.generate().serialize()).toString("base64"), readReceipts: true, linkedAt: 0 });
  const events: CoreEvent[] = []; const p = c as unknown as { emit: (e: CoreEvent) => void; makeInbound(): void }; p.emit = (e) => events.push(e); p.makeInbound();
  return { c, events };
}

test("importBackupContacts: adds keys (and missing names), never overwrites, skips blocked/invalid/own, idempotent, announces avatars", async () => {
  const { c, events } = await client(); const kA = b64(randomBytes(32)), kB = b64(randomBytes(32)), old = b64(randomBytes(32));
  c.store.data.contacts[B] = { aci: B, profileKey: old, name: "Saved" };
  c.store.data.contacts[C] = { aci: C, localBlocked: true };
  const list = [
    { aci: A.toUpperCase(), profileKey: kA, name: "Anna", e164: "+4915111111111" }, { aci: B, profileKey: kB, name: "Other" },
    { aci: C, profileKey: kA }, { aci: ME, profileKey: kA }, { aci: "nope", profileKey: kA }, { aci: A.replace(/1/g, "7"), profileKey: "AAAA" },
  ];
  assert.equal(c.importBackupContacts(list), 1);
  assert.equal(c.store.data.contacts[A]?.profileKey, kA); assert.equal(c.store.data.contacts[A]?.name, "Anna"); assert.equal(c.store.data.contacts[A]?.number, "+4915111111111");
  assert.equal(c.store.data.contacts[B]?.profileKey, old, "existing key kept"); assert.equal(c.store.data.contacts[B]?.name, "Saved");
  assert.equal(c.store.data.contacts[C]?.profileKey, undefined); assert.equal(c.store.data.contacts[ME], undefined);
  assert.ok(events.some((e) => e.type === "avatar-changed" && e.data.id === A && e.data.kind === "contact"));
  const n = events.length; assert.equal(c.importBackupContacts(list), 0); assert.equal(events.length, n, "second run changes nothing");
});

test("names: only valid UTF-8 without control characters is accepted (wrong key / garbled records never show as a name)", () => {
  assert.equal(cleanName("  Zoë Müller "), "Zoë Müller"); assert.equal(cleanName("日本 😀"), "日本 😀");
  for (const bad of ["a\u0000b", "x\u0007", "ab�c", "\u0085", "a b", "\ud800"]) assert.equal(cleanName(bad), undefined, JSON.stringify(bad));
  assert.equal(cleanName(Buffer.from([0xff, 0xfe, 0x41])), undefined); assert.equal(cleanName(Buffer.from("ok")), "ok"); assert.equal(cleanName("   "), undefined);
  const key = randomBytes(32);
  const enc = (b: Buffer) => b64(encryptProfileItemWithPadding(b, key, PADDED_LENGTHS.name));
  assert.deepEqual(decryptProfileName(enc(Buffer.concat([Buffer.from("Ann\0"), Buffer.from([0xff, 0xc3])])), key), { given: "Ann", family: undefined });
  assert.deepEqual(decryptProfileName(enc(Buffer.from([0xff, 0x00, 0x41])), key), { given: "", family: "A" });
  assert.throws(() => decryptProfileName(enc(Buffer.from("Ann")), randomBytes(32)), /could not decrypt/, "GCM tag must verify");
  void encryptProfile;
});

test("storage-record names with control characters are dropped, display falls back to the number", async () => {
  const store = await makeStore(ME, 2); const inb = new Inbound("acc", store, () => {});
  const ss = new StorageSync(store, {} as never, { onChanged() {} } as never) as unknown as { applyContact(r: object, c: object): string | undefined };
  ss.applyContact({ aci: A, e164: "+491700000001", givenName: "\u0001\u0002�", familyName: "x\u0000", systemGivenName: "Real" }, { changed: false, newGroups: [], me: ME });
  assert.equal(inb.displayName(A), "Real"); assert.equal(store.data.contacts[A]?.profileName, undefined);
  ss.applyContact({ aci: B, e164: "+491700000002", givenName: "��" }, { changed: false, newGroups: [], me: ME });
  assert.equal(inb.displayName(B), "+491700000002");
});
