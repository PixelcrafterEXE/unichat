// Profile names of people who are not in the address book: fetched with the learned profile key, decrypted, remembered, and
// preferred over a bare phone number. Generated keys and a fake chat connection only.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { PeerProfiles } from "../service/peerProfiles.js";
import { encryptProfileItemWithPadding, PADDED_LENGTHS } from "../service/profileCrypto.js";
import { Inbound } from "../service/inbound.js";
import { A, B, ME, b64, makeStore } from "./fixtures.js";

const encName = (key: Uint8Array, given: string, family?: string) =>
  b64(encryptProfileItemWithPadding(Buffer.from(family ? `${given}\0${family}` : given, "utf8"), key, PADDED_LENGTHS.name));
const reply = (status: number, body?: unknown) => ({ status, body: body === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(body)) });

test("a person without a saved name gets their profile name; a number alone no longer wins", async () => {
  const store = await makeStore(ME, 2);
  const keyA = randomBytes(32), keyB = randomBytes(32);
  store.data.contacts[A] = { aci: A, number: "+491700000001", profileKey: b64(keyA) };
  store.data.contacts[B] = { aci: B, number: "+491700000002", profileKey: b64(keyB), name: "Saved Name" };
  const seen: string[] = []; let changed = 0;
  const chat = { fetch: async (r: { path: string }) => { seen.push(r.path); return reply(200, { name: encName(keyA, "Anna", "Becker") }); } };
  const pp = new PeerProfiles(store, () => chat as never, () => { changed++; }, () => 1_000_000, async () => {});
  pp.scanAll();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, 1, "only the person without a saved name is looked up");
  assert.ok(seen[0]!.startsWith(`/v1/profile/${A}/`));
  assert.equal(store.data.names[A], "Anna Becker");
  assert.ok(changed >= 1, "the UI is told names changed");
  const inbound = new Inbound("acc", store, () => {});
  assert.equal(inbound.displayName(A), "Anna Becker", "profile name beats the phone number");
  assert.equal(inbound.displayName(B), "Saved Name", "an address-book name still wins");
  store.data.names[A] = ""; delete store.data.names[A];
  assert.equal(inbound.displayName(A), "+491700000001", "number only when nothing better is known");
});

test("404, stale keys and rate limits are handled without losing the queue", async () => {
  const store = await makeStore(ME, 2);
  store.data.contacts[A] = { aci: A, profileKey: b64(randomBytes(32)) };
  let calls = 0; let t = 5_000_000;
  const chat = { fetch: async () => { calls++; return calls === 1 ? reply(429) : reply(404); } };
  const pp = new PeerProfiles(store, () => chat as never, () => {}, () => t, async () => {});
  pp.scanAll(); await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1, "a 429 pauses the queue");
  assert.equal(store.data.contacts[A]!.profileNameCheckedAt, undefined, "and does not mark the person as checked");
  t += 11 * 60_000; pp.scanAll(); await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 2);
  assert.equal(store.data.contacts[A]!.profileNameCheckedAt, t, "404 marks them checked (asked again after a week)");
  assert.equal(pp.needs(A), false);
});
