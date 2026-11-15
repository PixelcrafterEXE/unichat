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
