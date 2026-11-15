// Edge cases of the PN<->LID session aliasing + a round trip through Baileys' real libsignal repository (in-memory keys, no network).
import test from "node:test";
import assert from "node:assert/strict";
import { Curve, generateRegistrationId, initAuthCreds } from "@whiskeysockets/baileys";
import { generateSignalPubKey } from "@whiskeysockets/baileys/lib/Utils/index.js";
import { makeLibSignalRepository } from "@whiskeysockets/baileys/lib/Signal/libsignal.js";
import { aliasSessions, canonicalSessionId, userMap } from "./sessionalias.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const mem = (init: Record<string, any> = {}) => {
  const d: Record<string, Record<string, any>> = { session: { ...init } };
  let cleared = 0;
  const store: any = {
    get: async (t: string, ids: string[]) => Object.fromEntries(ids.filter((i) => d[t]?.[i] !== undefined).map((i) => [i, d[t]![i]])),
    set: async (x: any) => { for (const [t, rec] of Object.entries<any>(x)) for (const [k, v] of Object.entries(rec)) { d[t] ??= {}; if (v === null) delete d[t]![k]; else d[t]![k] = v; } },
    clear: async () => { cleared++; for (const k of Object.keys(d)) d[k] = {}; },
  };
  return { d, store, cleared: () => cleared };
};
const M = userMap({ lidToPn: { "111@lid": "491@s.whatsapp.net" }, own: { pn: "4917@s.whatsapp.net", lid: "222@lid" } });

test("userMap ignores malformed pairs, strips device suffixes and domains, own account is mapped", () => {
  const m = userMap({ lidToPn: { "111:5@lid": "491:2@s.whatsapp.net", "x@s.whatsapp.net": "9@s.whatsapp.net", "7@lid": "8@lid", "5@lid": "5@c.us" }, own: { lid: "222:1@lid" } });
  assert.deepEqual([...m], [["111", "491"]]); // own without pn is skipped; wrong domains are skipped
  assert.equal(userMap({ lidToPn: {}, own: { pn: "1@s.whatsapp.net", lid: "2:3@lid" } }).get("2"), "1");
});
test("canonicalSessionId keeps the device, handles ids without a device, never rewrites a PN-form id", () => {
  assert.equal(canonicalSessionId("111.17", M), "491.17");
  assert.equal(canonicalSessionId("111", M), "111");           // no ".device": untouched
  assert.equal(canonicalSessionId("491.0", M), "491.0");       // already PN
  assert.equal(canonicalSessionId("1111.0", M), "1111.0");     // prefix of a mapped user is not a match
  assert.equal(canonicalSessionId("222.0", M), "4917.0");      // own account
  assert.equal(canonicalSessionId("111.0", new Map()), "111.0");
});
test("devices stay separate records", async () => {
  const m = mem(), s = aliasSessions(m.store, () => M);
  await s.set({ session: { "111.0": Buffer.from("a"), "111.1": Buffer.from("b") } } as any);
  assert.deepEqual(Object.keys(m.d.session!).sort(), ["491.0", "491.1"]);
  const got: any = await s.get("session", ["111.1", "491.0", "491.1"]);
  assert.equal(got["111.1"].toString(), "b"); assert.equal(got["491.0"].toString(), "a"); assert.equal(got["491.1"].toString(), "b");
});
test("own account: a session written under the own LID is shared with the own PN", async () => {
  const m = mem(), s = aliasSessions(m.store, () => M);
  await s.set({ session: { "222.2": Buffer.from("own") } } as any);
  assert.ok(m.d.session!["4917.2"]);
  assert.equal(((await s.get("session", ["222.2"])) as any)["222.2"].toString(), "own");
});
test("mapping learned later: records stored under the LID before the mapping existed are found and migrate on write", async () => {
  let map = new Map<string, string>();
  const m = mem(), s = aliasSessions(m.store, () => map);
  await s.set({ session: { "111.0": Buffer.from("v1"), "491.0": Buffer.from("pn") } } as any); // unmapped: both stored as-is
  assert.deepEqual(Object.keys(m.d.session!).sort(), ["111.0", "491.0"]);
  map = M;
  // canonical (PN) record wins over the legacy LID one
  assert.equal(((await s.get("session", ["111.0"])) as any)["111.0"].toString(), "pn");
  await s.set({ session: { "111.0": Buffer.from("v2") } } as any);
  assert.deepEqual(Object.keys(m.d.session!), ["491.0"]);
  assert.equal(m.d.session!["491.0"].toString(), "v2");
});
test("mapping changing between calls is read live (getMap is called per operation)", async () => {
  let calls = 0; const m = mem({ "491.0": Buffer.from("x") });
  const s = aliasSessions(m.store, () => { calls++; return M; });
  await s.get("session", ["111.0"]); await s.set({ session: { "111.0": Buffer.from("y") } } as any);
  assert.equal(calls, 2);
});
test("delete (null) under either form removes the shared record", async () => {
  const m = mem({ "491.0": Buffer.from("x") }), s = aliasSessions(m.store, () => M);
  await s.set({ session: { "111.0": null } } as any);
  assert.equal(m.d.session!["491.0"], undefined);
  assert.deepEqual(await s.get("session", ["111.0", "491.0"]), {});
});
test("delete of a legacy LID record that also has a PN twin removes both", async () => {
  const m = mem({ "111.0": Buffer.from("old"), "491.0": Buffer.from("new") }), s = aliasSessions(m.store, () => M);
  await s.set({ session: { "111.0": null } } as any);
  assert.deepEqual(Object.keys(m.d.session!), []);
});
test("delete and write in one batch for the same person: the write wins", async () => {
  const m = mem(), s = aliasSessions(m.store, () => M);
  await s.set({ session: { "111.0": null, "491.0": Buffer.from("keep") } } as any);
  assert.equal(m.d.session!["491.0"]?.toString(), "keep");
});
test("clear is forwarded; a store without clear stays without it; other key types are not touched", async () => {
  const m = mem({ "491.0": Buffer.from("x") }), s = aliasSessions(m.store, () => M);
  await s.set({ "pre-key": { "5": { a: 1 } } } as any);
  assert.deepEqual(m.d["pre-key"], { "5": { a: 1 } });
  assert.deepEqual(await s.get("pre-key", ["5"]), { "5": { a: 1 } });
  await (s as any).clear();
  assert.equal(m.cleared(), 1); assert.deepEqual(m.d.session, {});
  const bare = aliasSessions({ get: async () => ({}), set: async () => {} } as any, () => M);
  assert.equal((bare as any).clear, undefined);
});
test("concurrent sets of the PN and LID form of one session end in exactly one record", async () => {
  const m = mem(), s = aliasSessions(m.store, () => M);
  await Promise.all([
    s.set({ session: { "111.0": Buffer.from("lid") } } as any),
    s.set({ session: { "491.0": Buffer.from("pn") } } as any),
    s.set({ session: { "111.0": Buffer.from("lid2") } } as any),
  ]);
  assert.deepEqual(Object.keys(m.d.session!), ["491.0"]);
});
test("a get with both forms returns both ids, and duplicates do not break", async () => {
  const m = mem({ "491.0": Buffer.from("x") }), s = aliasSessions(m.store, () => M);
  const got = await s.get("session", ["111.0", "111.0", "491.0"]);
  assert.deepEqual(Object.keys(got).sort(), ["111.0", "491.0"]);
});

// ---- real libsignal round trip ----
function party() {
  const creds: any = initAuthCreds();
  const pre = Curve.generateKeyPair();
  const keys = mem();
  keys.d["pre-key"] = { "1": pre };
  return { creds, pre, keys, regId: creds.registrationId ?? generateRegistrationId() };
}
const bundle = (p: ReturnType<typeof party>) => ({
  registrationId: p.creds.registrationId, identityKey: generateSignalPubKey(p.creds.signedIdentityKey.public),
  signedPreKey: { keyId: p.creds.signedPreKey.keyId, publicKey: generateSignalPubKey(p.creds.signedPreKey.keyPair.public), signature: p.creds.signedPreKey.signature },
  preKey: { keyId: 1, publicKey: generateSignalPubKey(p.pre.public) },
});
const repo = (p: ReturnType<typeof party>, alias?: () => Map<string, string>) =>
  makeLibSignalRepository({ creds: p.creds, keys: (alias ? aliasSessions(p.keys.store, alias) : p.keys.store) as any });

test("libsignal: a session built under the PN address decrypts a reply that arrives from the LID address (and fails without aliasing)", async () => {
  const run = async (alias: boolean) => {
    const us = party(), them = party();
    const map = userMap({ lidToPn: { "777@lid": "4930@s.whatsapp.net" } });
    const ours = repo(us, alias ? () => map : undefined), theirs = repo(them);
    // we send to the PN address: an outgoing session is built from their bundle
    await ours.injectE2ESession({ jid: "4930@s.whatsapp.net", session: bundle(them) as any });
    const first = await ours.encryptMessage({ jid: "4930@s.whatsapp.net", data: Buffer.from("hello") });
    assert.equal(first.type, "pkmsg");
    // they decrypt (they see us under our own address) and reply
    assert.equal(Buffer.from(await theirs.decryptMessage({ jid: "100@s.whatsapp.net", type: "pkmsg", ciphertext: first.ciphertext })).toString(), "hello");
    const reply = await theirs.encryptMessage({ jid: "100@s.whatsapp.net", data: Buffer.from("hi back") });
    assert.equal(reply.type, "msg");
    // the reply arrives from their LID address (device 0)
    return ours.decryptMessage({ jid: "777@lid", type: reply.type, ciphertext: reply.ciphertext });
  };
  assert.equal(Buffer.from(await run(true)).toString(), "hi back");
  await assert.rejects(run(false), /No (matching )?session/i);
});
test("libsignal: the stored session lives under the PN id only, and a second exchange under the LID keeps working", async () => {
  const us = party(), them = party(), map = userMap({ lidToPn: { "777@lid": "4930@s.whatsapp.net" } });
  const ours = repo(us, () => map), theirs = repo(them);
  await ours.injectE2ESession({ jid: "4930:4@s.whatsapp.net", session: bundle(them) as any });
  assert.deepEqual(Object.keys(us.keys.d.session!), ["4930.4"]);
  const a = await ours.encryptMessage({ jid: "777:4@lid", data: Buffer.from("via lid") }); // encrypt through the LID address uses the same session
  assert.equal(Buffer.from(await theirs.decryptMessage({ jid: "100@s.whatsapp.net", type: a.type, ciphertext: a.ciphertext })).toString(), "via lid");
  for (let i = 0; i < 3; i++) {
    const r = await theirs.encryptMessage({ jid: "100@s.whatsapp.net", data: Buffer.from(`r${i}`) });
    assert.equal(Buffer.from(await ours.decryptMessage({ jid: i % 2 ? "4930:4@s.whatsapp.net" : "777:4@lid", type: r.type, ciphertext: r.ciphertext })).toString(), `r${i}`);
  }
  assert.deepEqual(Object.keys(us.keys.d.session!), ["4930.4"]);
});

test("deleting or rewriting the PN-form id also clears a legacy LID-form twin (no resurrection)", async () => {
  const m = mem({ "111.0": Buffer.from("legacy") }), s = aliasSessions(m.store, () => M);
  await s.set({ session: { "491.0": null } } as any);
  assert.deepEqual(await s.get("session", ["111.0", "491.0"]), {});
  const m2 = mem({ "111.0": Buffer.from("legacy") }), s2 = aliasSessions(m2.store, () => M);
  await s2.set({ session: { "491.0": Buffer.from("fresh") } } as any);
  assert.deepEqual(Object.keys(m2.d.session!), ["491.0"]);
});
