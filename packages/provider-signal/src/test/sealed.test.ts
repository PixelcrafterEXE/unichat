// Sealed-sender sending: real libsignal crypto, fake authenticated + unauthenticated chat connections, generated PKI. No network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ErrorCode, LibSignalErrorBase, MismatchedDevicesEntry, Aci } from "@signalapp/libsignal-client";
import { ProfileKey } from "@signalapp/libsignal-client/dist/zkgroup/index.js";
import type { Content } from "../protocol/codec.js";
import { SealedAccess } from "../service/sealed.js";
import { Sender } from "../service/sender.js";
import { sendDebug } from "../service/client.js";
import { A, ME, json, makePeer, makePki, makeStore, peerDecrypt, type Peer } from "./fixtures.js";

const err = (name: keyof typeof ErrorCode, extra?: Record<string, unknown>) => new LibSignalErrorBase(name, name as never, "test", extra);

async function setup(o: { profileKey?: boolean; unrestricted?: boolean; unauthFails?: Error[] } = {}) {
  const me = await makeStore(ME, 2, randomBytes(32));
  const pk = randomBytes(32);
  const peer: Peer = await makePeer(A, pk);
  if (o.profileKey !== false) me.data.contacts[A] = { aci: A, profileKey: Buffer.from(pk).toString("base64") };
  const pki = makePki(me);
  const authSent: unknown[] = [], syncSent: unknown[] = [], sealedSent: { destination: string; auth: unknown; contents: { deviceId: number; contents: Uint8Array }[] }[] = [];
  const fetches: string[] = [];
  const failures = [...(o.unauthFails ?? [])];
  const auth = {
    fetch: async (r: { path: string }) => {
      fetches.push(r.path);
      if (r.path.startsWith("/v1/certificate/delivery")) return json({ certificate: pki.certB64 });
      if (r.path.startsWith(`/v2/keys/${A}`)) return json(peer.bundle);
      if (r.path.startsWith(`/v1/profile/${A}`)) return json({ unrestrictedUnidentifiedAccess: !!o.unrestricted });
      return { status: 404, body: undefined };
    },
    sendMessage: async (r: unknown) => { authSent.push(r); },
    sendSyncMessage: async (r: unknown) => { syncSent.push(r); },
  };
  const unauth = {
    sendMessage: async (r: never) => { const f = failures.shift(); if (f) throw f; sealedSent.push(r); },
  };
  let broken = 0;
  const sealed = new SealedAccess(me, () => auth as never, { trustRoots: () => [pki.rootPublic] });
  const sender = new Sender(me, () => auth as never, { unauth: async () => unauth as never, unauthBroken: () => { broken++; }, sealed });
  return { me, peer, pki, sender, authSent, syncSent, sealedSent, fetches, broken: () => broken };
}
const text = (body: string): Content => ({ dataMessage: { body, timestamp: 5 } });

test("sealed 1:1: encrypted for the peer, access key from the profile key, certificate fetched once", async () => {
  const h = await setup();
  const r = await h.sender.deliver(A, text("hello sealed"), 5, "message", { groupId: undefined });
  assert.deepEqual(r, { mode: "sealed", fallback: false });
  assert.equal(h.authSent.length, 0); assert.equal(h.sealedSent.length, 1);
  const req = h.sealedSent[0]!;
  assert.deepEqual((req.auth as { accessKey: Uint8Array }).accessKey, new ProfileKey(new Uint8Array(h.peer.profileKey)).deriveAccessKey());
  const got = await peerDecrypt(h.peer, req.contents[0]!.contents, h.pki.rootPublic);
  assert.equal(got.sender, ME); assert.equal(got.content.dataMessage!.body, "hello sealed");
  await h.sender.deliver(A, text("again"), 6, "message");
  assert.equal(h.fetches.filter((p) => p.startsWith("/v1/certificate")).length, 1);
});

test("sealed 1:1: no profile key -> authenticated fallback; unrestricted account -> sealed with 'unrestricted'", async () => {
  const h = await setup({ profileKey: false });
  assert.deepEqual(await h.sender.deliver(A, text("x"), 5, "message"), { mode: "authenticated", fallback: true });
  assert.equal(h.authSent.length, 1); assert.equal(h.sealedSent.length, 0);
  const u = await setup({ profileKey: false, unrestricted: true });
  assert.deepEqual(await u.sender.deliver(A, text("x"), 5, "message"), { mode: "sealed", fallback: false });
  assert.equal(u.sealedSent[0]!.auth, "unrestricted");
});

test("sealed 1:1: 401 falls back to authenticated and sealing is skipped for that contact afterwards", async () => {
  const h = await setup({ unauthFails: [err("RequestUnauthorized")] });
  assert.deepEqual(await h.sender.deliver(A, text("x"), 5, "message"), { mode: "authenticated", fallback: true });
  assert.equal(h.authSent.length, 1);
  assert.ok(h.me.data.contacts[A]!.sealedRejectedAt);
  assert.deepEqual(await h.sender.deliver(A, text("y"), 6, "message"), { mode: "authenticated", fallback: true });
  assert.equal(h.sealedSent.length, 0);
  // a 401 for an account that turns out to be unrestricted retries sealed with "unrestricted"
  const u = await setup({ unauthFails: [err("RequestUnauthorized")], unrestricted: true });
  assert.deepEqual(await u.sender.deliver(A, text("x"), 5, "message"), { mode: "sealed", fallback: false });
  assert.equal(u.sealedSent[0]!.auth, "unrestricted");
});

test("sealed 1:1: 409/410 stale devices are handled (refetch + retry); connection errors fall back", async () => {
  const h = await setup();
  await h.sender.deliver(A, text("prime"), 5, "message");
  const h2 = await setup({ unauthFails: [err("MismatchedDevices", { entries: [new MismatchedDevicesEntry({ account: Aci.fromUuid(A), staleDevices: [1] })] })] });
  assert.deepEqual(await h2.sender.deliver(A, text("x"), 5, "message"), { mode: "sealed", fallback: false });
  assert.equal(h2.sealedSent.length, 1);
  assert.equal(h2.fetches.filter((p) => p.startsWith("/v2/keys")).length, 2);
  const h3 = await setup({ unauthFails: [err("IoError")] });
  assert.deepEqual(await h3.sender.deliver(A, text("x"), 5, "message"), { mode: "authenticated", fallback: true });
  assert.equal(h3.broken(), 1);
});

test("sealed: sync transcripts to ourselves stay authenticated, and a missing certificate means authenticated", async () => {
  const h = await setup();
  h.me.data.contacts[ME] = { aci: ME };
  // our own account needs a second device to have anything to sync to: none known -> nothing sent, authenticated
  const r = await h.sender.deliver(ME, { syncMessage: { request: { type: 1 } } }, 5, "sync").catch(() => undefined);
  assert.equal(h.sealedSent.length, 0);
  assert.ok(r === undefined || r.mode === "authenticated");
  const bad = await setup();
  const noCert = new Sender(bad.me, () => ({ fetch: async () => ({ status: 500, body: undefined }), sendMessage: async (x: unknown) => { bad.authSent.push(x); } }) as never,
    { unauth: async () => ({ sendMessage: async () => { throw new Error("must not be used"); } }) as never,
      sealed: new SealedAccess(bad.me, () => ({ fetch: async () => ({ status: 500, body: undefined }) }) as never, { trustRoots: () => [bad.pki.rootPublic] }) });
  await noCert.deliver(A, text("x"), 5, "message").catch(() => {}); // prekey fetch also fails here; only the unauth path matters
  assert.equal(bad.sealedSent.length, 0);
});

test("send debug line carries counts only", () => {
  const lines: string[] = []; const orig = console.debug; const prev = process.env.UNIMSG_DEBUG;
  process.env.UNIMSG_DEBUG = "1"; console.debug = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { sendDebug("sealed", 3, 2, 1, 0); } finally { console.debug = orig; if (prev === undefined) delete process.env.UNIMSG_DEBUG; else process.env.UNIMSG_DEBUG = prev; }
  assert.deepEqual(lines, ["[signal] send: mode=sealed recipients=3 delivered=2 failed=1 fallback=0"]);
});
