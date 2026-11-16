// Send fan-out (#49): real libsignal sessions, fake Signal service (prekey endpoint + scripted 409/410/404/5xx), no network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Aci, ErrorCode, IdentityKeyPair, LibSignalErrorBase, MismatchedDevicesEntry } from "@signalapp/libsignal-client";
import type { CoreEvent } from "@unimsg/core";
import type { Content } from "../protocol/codec.js";
import { SignalClient } from "../service/client.js";
import { groupChatId, groupIdFromMasterKey } from "../service/groups.js";
import { newLastResortKyber, newSignedPreKey, identityOf } from "../service/keys.js";
import { Sender, SendError } from "../service/sender.js";
import { A, B, ME, b64, json, makeStore } from "./fixtures.js";
import type { SignalStore } from "../store/signalStore.js";

const mismatch = (aci: string, e: { missing?: number[]; extra?: number[]; stale?: number[] }) =>
  new LibSignalErrorBase("MismatchedDevices", "MismatchedDevices" as never, "test", {
    entries: [new MismatchedDevicesEntry({ account: Aci.fromUuid(aci), missingDevices: e.missing, extraDevices: e.extra, staleDevices: e.stale })],
  });

/** A recipient with several devices sharing ONE identity key, like a real account. `regIds` can be changed to simulate re-registration. */
async function makeAccount(aci: string, deviceIds: number[]) {
  const first = await makeStore(aci, deviceIds[0]!, randomBytes(32));
  const identity = first.requireAccount().aciIdentity;
  const stores = new Map<number, SignalStore>([[deviceIds[0]!, first]]);
  for (const d of deviceIds.slice(1)) { const s = await makeStore(aci, d); s.requireAccount().aciIdentity = identity; stores.set(d, s); }
  const regIds = new Map<number, number>([...stores].map(([d, s]) => [d, s.requireAccount().registrationId]));
  const bundleFor = async (d: number) => {
    const s = stores.get(d)!;
    const spk = await newSignedPreKey(s, "aci"); const kyber = await newLastResortKyber(s, "aci");
    return { deviceId: d, registrationId: regIds.get(d)!, signedPreKey: { keyId: spk.id(), publicKey: b64(spk.publicKey().serialize()), signature: b64(spk.signature()) },
      pqPreKey: { keyId: kyber.id(), publicKey: b64(kyber.publicKey().serialize()), signature: b64(kyber.signature()) } };
  };
  const identityKey = b64(identityOf(first, "aci").publicKey.serialize());
  return { stores, regIds, identityKey, bundleFor, live: new Set(deviceIds) };
}

async function setup(o: { devices?: number[]; known?: number[]; sendFailures?: Error[]; fetchStatus?: Record<string, number> } = {}) {
  const me = await makeStore(ME, 2, randomBytes(32));
  const peer = await makeAccount(A, o.devices ?? [1, 2]);
  const fetches: string[] = [];
  const sent: { contents: { deviceId: number; registrationId: number }[]; timestamp: number }[] = [];
  const failures = [...(o.sendFailures ?? [])];
  const auth = {
    fetch: async (r: { path: string }) => {
      fetches.push(r.path);
      const m = /^\/v2\/keys\/([^/]+)\/(.+)$/.exec(r.path);
      if (m && m[1] === A) {
        const forced = o.fetchStatus?.[m[2]!]; if (forced) return { status: forced, body: undefined };
        const want = m[2] === "*" ? [...peer.live] : [Number(m[2])];
        const devs = want.filter((d) => peer.live.has(d));
        if (devs.length === 0) return { status: 404, body: undefined };
        return json({ identityKey: peer.identityKey, devices: await Promise.all(devs.map((d) => peer.bundleFor(d))) });
      }
      return { status: 404, body: undefined };
    },
    sendMessage: async (r: { contents: { deviceId: number; registrationId: number }[]; timestamp: number }) => {
      const f = failures.shift(); if (f) throw f;
      sent.push(r);
    },
    sendSyncMessage: async () => {},
  };
  const sender = new Sender(me, () => auth as never);
  // prime a session for the devices we "already know"
  for (const d of o.known ?? []) {
    const r = await auth.fetch({ path: `/v2/keys/${A}/${d}` }); void r;
  }
  return { me, peer, sender, fetches, sent, auth };
}
const text = (b: string): Content => ({ dataMessage: { body: b, timestamp: 5 } });
const devs = (r: { contents: { deviceId: number }[] }) => r.contents.map((c) => c.deviceId).sort();

test("fresh recipient: all devices are fetched with one GET /v2/keys/<aci>/* and every device gets its own envelope with its registration id", async () => {
  const h = await setup({ devices: [1, 2, 3] });
  await h.sender.deliver(A, text("hi"), 5, "message");
  assert.deepEqual(h.fetches, [`/v2/keys/${A}/*`]);
  assert.deepEqual(devs(h.sent[0]!), [1, 2, 3]);
  for (const c of h.sent[0]!.contents) assert.equal(c.registrationId, h.peer.regIds.get(c.deviceId));
});

test("409 missing device: the new device is fetched and the retry carries ALL devices", async () => {
  const h = await setup({ devices: [1] });
  await h.sender.deliver(A, text("first"), 5, "message"); // learns device 1 only
  h.peer.stores.set(2, await makeStore(A, 2)); h.peer.stores.get(2)!.requireAccount().aciIdentity = h.peer.stores.get(1)!.requireAccount().aciIdentity;
  h.peer.regIds.set(2, 777); h.peer.live.add(2);
  const failures = [mismatch(A, { missing: [2] })];
  const orig = h.auth.sendMessage; h.auth.sendMessage = async (r) => { const f = failures.shift(); if (f) throw f; return orig(r); };
  await h.sender.deliver(A, text("second"), 6, "message");
  assert.deepEqual(devs(h.sent[1]!), [1, 2]);
  assert.equal(h.sent[1]!.contents.find((c) => c.deviceId === 2)!.registrationId, 777);
  assert.ok(h.fetches.includes(`/v2/keys/${A}/2`));
});

test("409 extra device: its session is dropped and it is left out", async () => {
  const h = await setup({ devices: [1, 2], sendFailures: [mismatch(A, { extra: [2] })] });
  h.peer.live.delete(2);
  await h.sender.deliver(A, text("x"), 5, "message");
  assert.deepEqual(devs(h.sent[0]!), [1]);
  assert.ok(!(`aci:${A}.2` in h.me.data.sessions));
});

test("410 stale device: session replaced from a fresh bundle, retry uses the NEW registration id", async () => {
  const h = await setup({ devices: [1, 2] });
  await h.sender.deliver(A, text("a"), 5, "message");
  h.peer.regIds.set(2, 4242); // device 2 re-registered
  const failures = [mismatch(A, { stale: [2] })];
  const orig = h.auth.sendMessage; h.auth.sendMessage = async (r) => { const f = failures.shift(); if (f) throw f; return orig(r); };
  await h.sender.deliver(A, text("b"), 6, "message");
  assert.equal(h.sent[1]!.contents.find((c) => c.deviceId === 2)!.registrationId, 4242);
  assert.deepEqual(devs(h.sent[1]!), [1, 2]);
});

test("a missing device whose prekey fetch is 404 (just unlinked) does not fail the send to the other devices", async () => {
  const h = await setup({ devices: [1] });
  await h.sender.deliver(A, text("a"), 5, "message");
  const failures = [mismatch(A, { missing: [9] })];
  const orig = h.auth.sendMessage; h.auth.sendMessage = async (r) => { const f = failures.shift(); if (f) throw f; return orig(r); };
  await h.sender.deliver(A, text("b"), 6, "message");
  assert.deepEqual(devs(h.sent[1]!), [1]);
});

test("a broken session of ONE device is reset from a fresh bundle instead of blocking the whole send", async () => {
  const h = await setup({ devices: [1, 2] });
  await h.sender.deliver(A, text("a"), 5, "message");
  h.me.data.sessions[`aci:${A}.2`] = Buffer.from("garbage").toString("base64");
  await h.sender.deliver(A, text("b"), 6, "message");
  assert.deepEqual(devs(h.sent[1]!), [1, 2]);
});

test("persistent mismatch keeps surfacing an error instead of reporting success", async () => {
  const h = await setup({ devices: [1], sendFailures: Array.from({ length: 10 }, () => mismatch(A, { missing: [1] })) });
  await assert.rejects(h.sender.deliver(A, text("x"), 5, "message"), SendError);
  assert.equal(h.sent.length, 0);
});

test("prekey fetch failing with 503 is a retryable SendError", async () => {
  const h = await setup({ fetchStatus: { "*": 503 } });
  await assert.rejects(h.sender.deliver(A, text("x"), 5, "message"), (e: SendError) => e.retryable === true);
});

// ---------- client level: group fan-out failure handling and sync retry ----------
async function clientSetup(o: { failures?: Record<string, Error[]>; syncFailures?: Error[] } = {}) {
  const client = new SignalClient({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-signal-fan-")) });
  await client.store.load();
  client.store.setAccount({ aci: ME, deviceId: 2, password: "pw", registrationId: 5, aciIdentity: Buffer.from(IdentityKeyPair.generate().serialize()).toString("base64"), readReceipts: true, linkedAt: 0 });
  const events: CoreEvent[] = [];
  const priv = client as unknown as Record<string, unknown> & { makeInbound(): void; emit: (e: CoreEvent) => void; sendRetryDelaysMs: number[] };
  priv.emit = (e) => events.push(e); priv.sendRetryDelaysMs = [0, 0];
  const masterKey = randomBytes(32);
  const chatId = groupChatId(groupIdFromMasterKey(masterKey));
  priv.groupResolver = { needs: () => false, request: async () => {}, ensure: async () => {
    client.store.upsertChat({ id: chatId, kind: "group", groupMasterKey: Buffer.from(masterKey).toString("base64"), groupRevision: 7, groupMembers: [ME, A, B] });
    client.store.data.chats[chatId]!.groupFetchedAt = Date.now(); return "refreshed";
  } };
  priv.makeInbound(); priv.chatConn = {};
  const calls: { aci: string; mode: string }[] = [];
  const failures = { ...(o.failures ?? {}) }; const syncF = [...(o.syncFailures ?? [])];
  priv.sender = { deps: {}, deliver: async (aci: string, _c: Content, _t: number, mode: string) => {
    const f = mode === "sync" ? syncF.shift() : failures[aci]?.shift();
    if (f) throw f;
    calls.push({ aci, mode });
  } };
  return { client, chatId, calls, events };
}

test("group: a transiently failing member is retried and the message is fully delivered without a warning", async () => {
  const h = await clientSetup({ failures: { [B]: [new SendError("rate limited", true), new SendError("rate limited", true)] } });
  await h.client.send(h.chatId, { text: "x" });
  assert.deepEqual(h.calls.filter((c) => c.mode === "message").map((c) => c.aci).sort(), [A, B].sort());
  assert.equal(h.events.length, 0);
});

test("group: a member that keeps failing is surfaced as an error event after the retries", async () => {
  const h = await clientSetup({ failures: { [B]: Array.from({ length: 10 }, () => new SendError("rate limited", true)) } });
  const m = await h.client.send(h.chatId, { text: "x" });
  assert.equal(m.status, "sent");
  const w = h.events.filter((e) => e.type === "error") as { data: { code: string; message: string } }[];
  assert.equal(w.length, 1); assert.equal(w[0]!.data.code, "group-partial-send"); assert.match(w[0]!.data.message, /not delivered to 1 person/);
});

test("1:1 send retries a transient failure; the sync transcript is retried too, and a final sync failure is reported", async () => {
  const h = await clientSetup({ failures: { [A]: [new SendError("rate limited", true)] }, syncFailures: [new SendError("rate limited", true)] });
  await h.client.send(A, { text: "x" });
  assert.deepEqual(h.calls.map((c) => c.mode), ["message", "sync"]);
  assert.equal(h.events.length, 0);
  const g = await clientSetup({ syncFailures: Array.from({ length: 10 }, () => new SendError("rate limited", true)) });
  await g.client.send(A, { text: "x" });
  assert.equal((g.events[0] as { data: { code: string } }).data.code, "sync-failed");
  const d = await clientSetup({ failures: { [A]: [new SendError("recipient is no longer registered with Signal")] } });
  await assert.rejects(d.client.send(A, { text: "x" }), /no longer registered/);
  assert.equal(d.calls.length, 0);
});
