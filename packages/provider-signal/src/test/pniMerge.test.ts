// PNI / ACI duplicate chats: the association is learned only from storage records or a VERIFIED PniSignatureMessage; the connector then
// marks the PNI chat `sameAs` the ACI chat (the Hub folds the pair into one row). Generated keys only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IdentityKeyPair } from "@signalapp/libsignal-client";
import { Inbound } from "../service/inbound.js";
import { StorageSync } from "../service/storageSync.js";
import { A, B, ME, makeStore } from "./fixtures.js";

const PNI = "99999999-9999-4999-8999-999999999999";
const pniBytes = (u: string) => Buffer.from(u.replace(/-/g, ""), "hex");
const setup = async () => { const store = await makeStore(ME, 2); const inb = new Inbound("acc", store, () => {}); return { store, inb }; };
const dmFrom = (aci: string, extra: object = {}) => ({ senderAci: aci, senderDevice: 1, sealed: false, content: { dataMessage: { body: "hi", timestamp: 5 }, ...extra } });

test("two chats (PNI + ACI), association learned later from a storage record: PNI chat gets sameAs, ACI chat does not", async () => {
  const { store, inb } = await setup();
  store.upsertChat({ id: PNI, kind: "dm" }); await inb.handle(dmFrom(A) as never, 5);
  assert.equal(inb.chatRecordToChat(PNI).sameAs, undefined, "nothing known yet: two separate chats");
  const ss = new StorageSync(store, {} as never, { onChanged() {}, onPni: (p: string, a: string) => { inb.learnPni(p, a); } } as never) as unknown as { applyContact(r: object, c: object): string | undefined };
  ss.applyContact({ aci: A, pni: PNI, e164: "+491700000001" }, { changed: false, newGroups: [], me: ME });
  assert.equal(inb.chatRecordToChat(PNI).sameAs, A); assert.equal(inb.chatRecordToChat(A).sameAs, undefined);
  assert.equal(inb.learnPni(PNI, A), false, "idempotent");
});

test("only the PNI chat exists when the mapping arrives: the ACI chat is created so the pair can merge", async () => {
  const { store, inb } = await setup(); store.upsertChat({ id: PNI, kind: "dm" });
  assert.equal(inb.learnPni(PNI, A), true); assert.ok(store.data.chats[A]); assert.equal(inb.chatRecordToChat(PNI).sameAs, A);
});

test("a matching phone number alone never merges: a different ACI with the same e164 is not the PNI's person", async () => {
  const { store, inb } = await setup();
  store.upsertChat({ id: PNI, kind: "dm" }); store.upsertChat({ id: B, kind: "dm" });
  store.data.contacts[PNI] = { aci: PNI, number: "+491700000009" }; store.data.contacts[B] = { aci: B, number: "+491700000009" };
  assert.equal(inb.chatRecordToChat(PNI).sameAs, undefined); assert.equal(inb.chatRecordToChat(B).sameAs, undefined);
});

test("PniSignatureMessage: accepted only when the PNI identity key signed the sender's ACI identity key", async () => {
  const { store, inb } = await setup();
  const pniKp = IdentityKeyPair.generate(), aciKp = IdentityKeyPair.generate(), other = IdentityKeyPair.generate();
  store.data.identities[`${PNI}.1`] = Buffer.from(pniKp.publicKey.serialize()).toString("base64");
  store.data.identities[`${A}.1`] = Buffer.from(aciKp.publicKey.serialize()).toString("base64");
  store.upsertChat({ id: PNI, kind: "dm" }); store.upsertChat({ id: A, kind: "dm" });
  const bad = Buffer.from(pniKp.signAlternateIdentity(other.publicKey));
  await inb.handle(dmFrom(A, { pniSignatureMessage: { pni: pniBytes(PNI), signature: bad } }) as never, 5);
  assert.equal(store.data.pnis?.[PNI], undefined, "signature over another key: rejected");
  await inb.handle(dmFrom(A, { pniSignatureMessage: { pni: pniBytes(PNI), signature: Buffer.alloc(64, 1) } }) as never, 6);
  assert.equal(store.data.pnis?.[PNI], undefined, "garbage signature: rejected");
  const good = Buffer.from(pniKp.signAlternateIdentity(aciKp.publicKey));
  await inb.handle(dmFrom(A, { pniSignatureMessage: { pni: pniBytes(PNI), signature: good } }) as never, 7);
  assert.equal(store.data.pnis?.[PNI], A); assert.equal(inb.chatRecordToChat(PNI).sameAs, A);
  assert.equal(inb.learnPni(ME, A), false, "never our own ids"); assert.equal(inb.learnPni("junk", A), false);
});

// ---- number-based and sent-transcript links (issue #52) ----
const PN = "+491700000042";
const sentTo = (dest: string, e164?: string) => ({ senderAci: ME, senderDevice: 1, sealed: false, content: { syncMessage: { sent: { destinationServiceId: dest, ...(e164 ? { destinationE164: e164 } : {}), timestamp: 1.8e12, message: { body: "hello by number", timestamp: 1.8e12 } } } } });

test("sent transcript to a PNI address creates the PNI chat and remembers its number; a later sealed-sender message with that number in the certificate merges", async () => {
  const { store, inb } = await setup();
  await inb.handle(sentTo(`PNI:${PNI}`, PN) as never, 5);
  assert.ok(store.data.chats[PNI], "chat keyed by the bare PNI"); assert.equal(store.data.pniNumbers?.[PNI], PN);
  await inb.handle({ ...dmFrom(B), senderE164: "+491700000099", sealed: true } as never, 6);
  assert.equal(inb.chatRecordToChat(PNI).sameAs, undefined, "another number: no link");
  await inb.handle({ ...dmFrom(A), senderE164: PN, sealed: true } as never, 7);
  assert.equal(store.data.pnis?.[PNI], A); assert.equal(inb.chatRecordToChat(PNI).sameAs, A); assert.equal(inb.chatRecordToChat(A).sameAs, undefined);
});

test("a sender certificate number alone (no phone-made PNI chat for that number) links nothing; ACI destinations never note a PNI number", async () => {
  const { store, inb } = await setup();
  store.upsertChat({ id: PNI, kind: "dm" });
  await inb.handle({ ...dmFrom(A), senderE164: PN, sealed: true } as never, 5);
  assert.equal(store.data.pnis?.[PNI], undefined);
  await inb.handle(sentTo(B, PN) as never, 6);
  assert.equal(store.data.pniNumbers, undefined);
});

test("storage record without ACI (PNI + number) then a record naming the ACI with that number: linked, both orders", async () => {
  const { store, inb } = await setup();
  const mk = () => new StorageSync(store, {} as never, { onChanged() {}, onPni: (p: string, a: string) => { inb.learnPni(p, a, "storage-record"); }, onPniNumber: (p: string, n: string) => inb.notePniNumber(p, n, "storage-record"), onNumber: (a: string, n: string) => inb.linkByNumber(a, n, "storage-record") } as never) as unknown as { applyContact(r: object, c: object): string | undefined };
  const ctx = { changed: false, newGroups: [], me: ME };
  store.upsertChat({ id: PNI, kind: "dm" });
  mk().applyContact({ pni: `PNI:${PNI.toUpperCase()}`, e164: PN }, ctx);
  assert.equal(store.data.pniNumbers?.[PNI], PN);
  mk().applyContact({ aci: A, e164: PN }, ctx);
  assert.equal(inb.chatRecordToChat(PNI).sameAs, A);
  const o = await setup(); o.store.data.contacts[B] = { aci: B, number: PN };
  await o.inb.handle(sentTo(`PNI:${PNI}`, PN) as never, 5);
  assert.equal(o.store.data.pnis?.[PNI], B); assert.ok(o.store.data.chats[B]);
});

test("late link with both chats already holding messages: both chats stay and the pair is declared (contact sync number)", async () => {
  const { store, inb } = await setup();
  await inb.handle(sentTo(`PNI:${PNI}`, PN) as never, 5);
  await inb.handle(dmFrom(A) as never, 6);
  assert.equal(inb.chatRecordToChat(PNI).sameAs, undefined);
  inb.linkByNumber(A, PN, "contact-sync");
  assert.equal(inb.chatRecordToChat(PNI).sameAs, A);
  assert.ok(store.data.chats[PNI] && store.data.chats[A]);
});
