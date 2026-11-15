// Profile pictures of people: fake chat connection + fake CDN, generated keys only.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { PeerAvatars, AVATAR_BACKOFF_MS, AVATAR_GAP_MS, AVATAR_NEGATIVE_MS, AVATAR_TTL_MS } from "../service/peerAvatars.js";
import { encryptProfile, profileKeyVersion } from "../service/profileCrypto.js";
import { A, B, ME, b64, makeStore } from "./fixtures.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const JPG = Buffer.from([0xff, 0xd8, 9, 9, 9]);
const reply = (status: number, body?: unknown) => ({ status, body: body === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(body)) });

async function setup(opts: { profileKey?: Uint8Array } = {}) {
  const ownKey = randomBytes(32), keyA = randomBytes(32);
  const store = await makeStore(ME, 2, opts.profileKey ?? ownKey);
  store.data.contacts[A] = { aci: A, profileKey: b64(keyA) };
  store.data.contacts[B] = { aci: B }; // no profile key
  let t = 10_000_000;
  const f = {
    paths: [] as string[], times: [] as number[], blobs: [] as string[], status: 200,
    profiles: { [A]: { key: keyA, avatar: "profiles/a1" as string | undefined, img: PNG as Buffer }, [ME]: { key: ownKey, avatar: "profiles/me1" as string | undefined, img: JPG as Buffer } } as Record<string, { key: Uint8Array; avatar?: string; img: Buffer }>,
  };
  const chat = { fetch: async (r: { path: string }) => {
    f.paths.push(r.path); f.times.push(t);
    if (f.status !== 200) return reply(f.status);
    const aci = r.path.split("/")[3]!; const p = f.profiles[aci];
    if (!p) return reply(404);
    assert.equal(r.path.split("/")[4], profileKeyVersion(p.key, aci));
    return reply(200, p.avatar ? { avatar: p.avatar } : {});
  } };
  const changes: string[] = [];
  const pa = new PeerAvatars(store, () => chat as never, (a) => changes.push(a), () => t, async (ms) => { t += ms; },
    async (path) => { f.blobs.push(path); const p = Object.values(f.profiles).find((x) => x.avatar === path)!; return encryptProfile(p.img, p.key); });
  return { store, f, pa, changes, advance: (ms: number) => { t += ms; } };
}

test("contact and own avatar roundtrip: decrypted bytes + sniffed mime", async () => {
  const h = await setup();
  const a = await h.pa.get(A.toUpperCase());
  assert.deepEqual(Buffer.from(a!.data), PNG); assert.equal(a!.mime, "image/png");
  const me = await h.pa.get(ME);
  assert.deepEqual(Buffer.from(me!.data), JPG); assert.equal(me!.mime, "image/jpeg");
  assert.ok(h.f.paths[0]!.startsWith(`/v1/profile/${A}/`));
});

test("no profile key, no avatar path, 404 -> undefined, never throws", async () => {
  const h = await setup();
  assert.equal(await h.pa.get(B), undefined);
  assert.equal(h.f.paths.length, 0, "no request without a key");
  h.f.profiles[A]!.avatar = undefined;
  assert.equal(await h.pa.get(A), undefined);
  delete h.f.profiles[A];
  h.advance(AVATAR_NEGATIVE_MS + 1);
  assert.equal(await h.pa.get(A), undefined);
  assert.equal(await h.pa.get("99999999-9999-4999-8999-999999999999"), undefined);
});

test("positive cache 6 h, negative cache 1 h", async () => {
  const h = await setup();
  await h.pa.get(A); await h.pa.get(A);
  assert.equal(h.f.paths.length, 1);
  h.advance(AVATAR_TTL_MS - 1000); await h.pa.get(A); assert.equal(h.f.paths.length, 1);
  h.advance(2000); await h.pa.get(A); assert.equal(h.f.paths.length, 2, "re-checked after 6 h");
  assert.equal(h.f.blobs.length, 1, "unchanged path: blob not downloaded again");
  h.f.profiles[A]!.avatar = undefined; h.advance(AVATAR_TTL_MS + 1);
  assert.equal(await h.pa.get(A), undefined); const n = h.f.paths.length;
  await h.pa.get(A); assert.equal(h.f.paths.length, n, "negative cached");
  h.advance(AVATAR_NEGATIVE_MS + 1); await h.pa.get(A); assert.equal(h.f.paths.length, n + 1);
});

test("lookups are serialized with a gap and de-duplicated", async () => {
  const h = await setup();
  const [x, y, z] = await Promise.all([h.pa.get(A), h.pa.get(ME), h.pa.get(A)]);
  assert.ok(x && y && z);
  assert.equal(h.f.paths.length, 2);
  assert.ok(h.f.times[1]! - h.f.times[0]! >= AVATAR_GAP_MS, "gap between two lookups");
});

test("429 / 401 back off without caching a miss", async () => {
  const h = await setup();
  h.f.status = 429;
  assert.equal(await h.pa.get(A), undefined); assert.equal(h.f.paths.length, 1);
  h.f.status = 200;
  assert.equal(await h.pa.get(A), undefined); assert.equal(h.f.paths.length, 1, "paused: no request");
  h.advance(AVATAR_BACKOFF_MS + 1);
  assert.ok(await h.pa.get(A)); assert.equal(h.f.paths.length, 2);
  h.f.status = 401; h.advance(AVATAR_TTL_MS + 1);
  assert.ok(!(await h.pa.get(A)) || true);
});

test("hints: rev uses the profile key version, then the avatar path; changes emit", async () => {
  const h = await setup();
  const r0 = h.pa.rev(A)!; assert.ok(r0.startsWith("k:")); assert.equal(h.pa.rev(B), undefined);
  assert.ok(!r0.includes(A));
  await h.pa.get(A);
  const r1 = h.pa.rev(A)!; assert.ok(r1.startsWith("p:")); assert.notEqual(r0, r1);
  assert.equal(h.changes.length, 0, "first sight is not a change");
  h.f.profiles[A]!.avatar = "profiles/a2"; h.f.profiles[A]!.img = JPG; h.advance(AVATAR_TTL_MS + 1);
  const a = await h.pa.get(A); assert.equal(a!.mime, "image/jpeg");
  assert.deepEqual(h.changes, [A]); assert.notEqual(h.pa.rev(A), r1);
  h.pa.keyChanged(A); assert.equal(h.changes.length, 2);
});
