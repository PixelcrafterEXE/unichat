// Emoji (SAS) verification of the connector: the generic `verification` contract driven by fake VerificationRequest / Verifier objects
// (no homeserver, no crypto): request -> ready -> start -> show SAS -> confirm / mismatch / cancel / timeout, user + own-device, set-up, recovery key.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { MatrixError } from "matrix-js-sdk";
import { VerificationPhase } from "matrix-js-sdk/lib/crypto-api/verification.js";
import factory from "./index.js";
import { Verifications, type VerifHost } from "./verification.js";
import type { CoreEvent, VerificationState } from "@unimsg/core";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const EMOJI: [string, string][] = [["🐶", "Dog"], ["🔑", "Key"], ["🚀", "Rocket"], ["🍄", "Mushroom"], ["🎸", "Guitar"], ["📌", "Pin"], ["🔒", "Lock"]];

class FakeSas { calls: string[] = []; sas = { emoji: EMOJI };
  confirm() { this.calls.push("confirm"); return Promise.resolve(); } mismatch() { this.calls.push("mismatch"); } cancel() { this.calls.push("cancel"); } }
class FakeVerifier extends EventEmitter {
  sas: FakeSas; outcome: Promise<void>; preShown: boolean;
  constructor(sas: FakeSas, outcome: Promise<void>, preShown = false) { super(); this.sas = sas; this.outcome = outcome; this.preShown = preShown; }
  getShowSasCallbacks() { return this.preShown ? this.sas : null; }
  verify() { return this.outcome; }
}
class FakeRequest extends EventEmitter {
  phase: VerificationPhase = VerificationPhase.Ready; verifier?: FakeVerifier; started: string[] = []; accepted = 0; cancelled: unknown[] = [];
  makeVerifier: () => FakeVerifier; otherUserId: string; otherDeviceId?: string; initiatedByMe: boolean; cancellationCode: string | null = null; cancellingUserId?: string;
  constructor(makeVerifier: () => FakeVerifier, otherUserId = "@me:hs", initiatedByMe = false) { super(); this.makeVerifier = makeVerifier; this.otherUserId = otherUserId; this.initiatedByMe = initiatedByMe; }
  get isSelfVerification() { return this.otherUserId === "@me:hs"; }
  startVerification(m: string) { this.started.push(m); this.verifier = this.makeVerifier(); this.phase = VerificationPhase.Started; return Promise.resolve(this.verifier); }
  accept() { this.accepted++; this.phase = VerificationPhase.Ready; this.emit("change"); return Promise.resolve(); }
  cancel(p?: unknown) { this.cancelled.push(p ?? null); return Promise.resolve(); }
  setPhase(p: VerificationPhase) { this.phase = p; this.emit("change"); }
}

function mk(opts: { crypto?: Record<string, unknown>; client?: Record<string, unknown>; timeoutMs?: number } = {}) {
  const events: VerificationState[] = []; const errors: string[] = [];
  const crypto = { isCrossSigningReady: async () => true, ...opts.crypto };
  const client = { getCrypto: () => crypto, getUser: (id: string) => (id === "@anna:hs" ? { displayName: "Anna" } : null), getDeviceId: () => "DEV1", getAccountData: () => undefined, getRoom: () => ({}), ...opts.client };
  let secretKeyDuring: Uint8Array | undefined;
  const host: VerifHost = {
    accountId: "acc", client: () => client as never, me: () => "@me:hs",
    emit: (e: CoreEvent) => { if (e.type === "verification") events.push(e.data); }, err: (c, e) => errors.push(c + ":" + (e instanceof Error ? e.message : String(e))),
    withSecretKey: async (k, fn) => { secretKeyDuring = k; try { return await fn(); } finally { secretKeyDuring = undefined; } },
    keyFromInput: async (i) => { if (i === "bad") throw new Error("nope"); return new Uint8Array([1, 2, 3]); }, timeoutMs: opts.timeoutMs,
  };
  const v = new Verifications(host);
  return { v, events, errors, crypto, client, last: () => events.at(-1)!, keyDuring: () => secretKeyDuring };
}
const own = (sas: FakeSas, outcome: Promise<void> = new Promise<void>(() => {}), pre = false) => new FakeRequest(() => new FakeVerifier(sas, outcome, pre), "@me:hs", true);

test("own device: request -> ready -> m.sas.v1 -> 7 emojis -> confirm -> waiting for the other -> verified", async () => {
  const sas = new FakeSas(); let done!: () => void;
  const req = own(sas, new Promise<void>((r) => (done = r))); req.phase = VerificationPhase.Requested;
  const t = mk({ crypto: { requestOwnUserVerification: async () => req } });
  const { id } = await t.v.start();
  assert.equal(t.last().phase, "waiting"); assert.equal(t.last().other.kind, "device"); assert.equal(t.last().incoming, false);
  req.setPhase(VerificationPhase.Ready); await tick();
  assert.deepEqual(req.started, ["m.sas.v1"]);
  assert.equal(t.last().phase, "waiting");               // verifier hooked, no emojis yet
  req.verifier!.emit("show_sas", sas); await tick();
  assert.equal(t.last().phase, "sas"); assert.deepEqual(t.last().emoji, EMOJI); assert.equal(t.last().emoji!.length, 7);
  await t.v.action(id, "confirm");
  assert.deepEqual(sas.calls, ["confirm"]); assert.equal(t.last().phase, "confirming"); assert.deepEqual(t.last().emoji, EMOJI);
  done(); await tick();
  assert.equal(t.last().phase, "done");
  assert.equal(t.events.filter((e) => e.phase === "done").length, 1);
  assert.ok(t.events.every((e) => e.accountId === "acc" && e.id === id));
});

test("verification: emojis already available when the verifier is hooked; repeated change events start only one verifier", async () => {
  const sas = new FakeSas(); const req = own(sas, new Promise<void>(() => {}), true); req.phase = VerificationPhase.Requested;
  const t = mk({ crypto: { requestOwnUserVerification: async () => req } });
  await t.v.start(); req.setPhase(VerificationPhase.Ready); req.emit("change"); req.emit("change"); await tick();
  assert.deepEqual(req.started, ["m.sas.v1"]); assert.equal(t.last().phase, "sas");
  assert.equal(new Set(t.events.map((e) => JSON.stringify(e))).size, t.events.length, "no duplicate events");
});

test("'They don't match' reports a mismatch to the other side and ends with a plain reason; a later verify() rejection adds nothing", async () => {
  const sas = new FakeSas(); let fail!: (e: Error) => void;
  const req = own(sas, new Promise<void>((_r, j) => (fail = j)), true);
  const t = mk({ crypto: { requestOwnUserVerification: async () => req } });
  const { id } = await t.v.start(); await tick();
  await t.v.action(id, "mismatch");
  assert.deepEqual(sas.calls, ["mismatch"]); assert.equal(t.last().phase, "cancelled"); assert.match(t.last().reason!, /did not match/);
  const n = t.events.length; fail(new Error("m.mismatched_sas")); await tick(); assert.equal(t.events.length, n);
  await assert.rejects(t.v.action(id, "confirm").then(() => { throw new Error("should not confirm"); }), /should not confirm|no longer/); // an ended verification cannot be confirmed
});

test("Cancel: tells the SDK, ends once; unknown ids are harmless to cancel but not to confirm", async () => {
  const sas = new FakeSas(); const req = own(sas); req.phase = VerificationPhase.Requested;
  const t = mk({ crypto: { requestOwnUserVerification: async () => req } });
  const { id } = await t.v.start();
  await t.v.action(id, "cancel");
  assert.equal(req.cancelled.length, 1); assert.equal(t.last().phase, "cancelled"); assert.match(t.last().reason!, /You cancelled/);
  await t.v.action(id, "cancel"); assert.equal(req.cancelled.length, 1);
  await t.v.action("nope", "cancel");
  await assert.rejects(t.v.action("nope", "confirm"), /no longer active/);
});

test("the other side cancels / the verifier fails: cancelled with their name (user) and a mapped reason", async () => {
  const sas = new FakeSas(); const req = new FakeRequest(() => new FakeVerifier(sas, new Promise<void>(() => {})), "@anna:hs", true); req.phase = VerificationPhase.Requested;
  const t = mk({ crypto: { requestVerificationDM: async () => req } });
  await t.v.start({ userId: "@anna:hs", chatId: "!dm:hs" });
  assert.equal(t.last().other.kind, "user"); assert.equal(t.last().other.name, "Anna");
  req.cancellationCode = "m.user"; req.cancellingUserId = "@anna:hs"; req.setPhase(VerificationPhase.Cancelled); await tick();
  assert.equal(t.last().phase, "cancelled"); assert.equal(t.last().reason, "Anna cancelled the verification.");
  const req2 = own(sas); req2.phase = VerificationPhase.Requested;
  const t2 = mk({ crypto: { requestOwnUserVerification: async () => req2 } });
  await t2.v.start(); req2.cancellationCode = "m.timeout"; req2.setPhase(VerificationPhase.Cancelled); await tick();
  assert.match(t2.last().reason!, /timed out/);
});

test("timeout: an unanswered request is cancelled with m.timeout", async () => {
  const req = own(new FakeSas()); req.phase = VerificationPhase.Requested;
  const t = mk({ timeoutMs: 40, crypto: { requestOwnUserVerification: async () => req } });
  await t.v.start(); assert.equal(t.last().phase, "waiting");
  await tick(90);
  assert.equal(t.last().phase, "cancelled"); assert.match(t.last().reason!, /timed out/);
  assert.deepEqual(req.cancelled, [{ reason: "Timed out", code: "m.timeout" }]);
});

test("incoming request: shown as 'incoming', Accept starts the emoji flow, Decline cancels; own and not-pending requests are ignored", async () => {
  const sas = new FakeSas(); const mkReq = (other: string, byMe: boolean) => { const r = new FakeRequest(() => new FakeVerifier(sas, new Promise<void>(() => {})), other, byMe); r.phase = VerificationPhase.Requested; return r; };
  const t = mk();
  t.v.received(mkReq("@me:hs", true) as never); const done = mkReq("@anna:hs", false); done.phase = VerificationPhase.Done; t.v.received(done as never);
  assert.equal(t.events.length, 0);
  const dev = mkReq("@me:hs", false); dev.otherDeviceId = "ABCD"; t.v.received(dev as never);
  assert.equal(t.last().phase, "incoming"); assert.equal(t.last().incoming, true); assert.equal(t.last().other.kind, "device");
  assert.equal(dev.accepted, 0);                                   // nothing happens until the user presses Accept
  await t.v.action(t.last().id, "accept"); await tick();
  assert.equal(dev.accepted, 1); assert.deepEqual(dev.started, ["m.sas.v1"]);
  dev.verifier!.emit("show_sas", sas); await tick(); assert.equal(t.last().phase, "sas");
  const anna = mkReq("@anna:hs", false); t.v.received(anna as never);
  assert.equal(t.last().other.kind, "user"); assert.equal(t.last().other.name, "Anna");
  await t.v.action(t.last().id, "decline");
  assert.equal(anna.cancelled.length, 1); assert.equal(t.last().phase, "cancelled"); assert.match(t.last().reason!, /declined/);
});

test("starting a user verification needs a direct chat; uses the given room or the m.direct room", async () => {
  const reqs: string[] = [];
  const crypto = { requestVerificationDM: async (u: string, r: string) => { reqs.push(u + "|" + r); const q = own(new FakeSas()); q.phase = VerificationPhase.Requested; return q; } };
  const t = mk({ crypto });
  await assert.rejects(t.v.start({ userId: "@anna:hs" }), /direct chat/);
  await t.v.start({ userId: "@anna:hs", chatId: "!room:hs" });
  const t2 = mk({ crypto, client: { getAccountData: () => ({ getContent: () => ({ "@anna:hs": ["!dm2:hs"] }) }) } });
  await t2.v.start({ userId: "@anna:hs" });
  assert.deepEqual(reqs, ["@anna:hs|!room:hs", "@anna:hs|!dm2:hs"]);
  const t3 = mk({ crypto: { isCrossSigningReady: async () => false } });
  await assert.rejects(t3.v.start(), /Set up verification/);
});

test("status: this device / a person (verified, not verified, unknown) + cross-signing and backup", async () => {
  const t = mk({ crypto: { getDeviceVerificationStatus: async () => ({ crossSigningVerified: true }), getKeyBackupInfo: async () => ({ version: "1" }),
    getUserVerificationStatus: async (u: string) => ({ isVerified: () => u === "@ok:hs", known: u !== "@new:hs" }) } });
  assert.deepEqual(await t.v.status(), { state: "verified", crossSigning: "ready", backup: "enabled" });
  assert.equal((await t.v.status({ userId: "@ok:hs" })).state, "verified");
  assert.equal((await t.v.status({ userId: "@bob:hs" })).state, "unverified");
  assert.equal((await t.v.status({ userId: "@new:hs" })).state, "unknown");
  const t2 = mk({ crypto: { isCrossSigningReady: async () => false, getDeviceVerificationStatus: async () => ({ crossSigningVerified: false }), getKeyBackupInfo: async () => null } });
  assert.deepEqual(await t2.v.status(), { state: "unverified", crossSigning: "missing", backup: "none" });
});

function setupCrypto(flows: { stages: string[] }[], accepted: { auth?: unknown }[] = []) {
  const calls: string[] = []; let withKey: Uint8Array | undefined;
  const key = { privateKey: new Uint8Array([9, 9]), encodedPrivateKey: "EsTc 1234 abcd" };
  return { calls, accepted, key, crypto: {
    isCrossSigningReady: async () => false, getSecretStorageStatus: async () => ({ defaultKeyId: null, ready: false }), getKeyBackupInfo: async () => null,
    createRecoveryKeyFromPassphrase: async () => key,
    bootstrapCrossSigning: async (o: { authUploadDeviceSigningKeys: (f: (a: unknown) => Promise<void>) => Promise<void> }) => {
      calls.push("cross");
      await o.authUploadDeviceSigningKeys(async (auth) => { accepted.push({ auth }); if (!auth) throw new MatrixError({ errcode: "M_UNAUTHORIZED", flows, session: "S1" }, 401); if ((auth as { password: string }).password !== "pw") throw new MatrixError({ errcode: "M_FORBIDDEN" }, 401); });
    },
    bootstrapSecretStorage: async (o: { createSecretStorageKey: () => Promise<unknown>; setupNewKeyBackup: boolean }) => { calls.push("storage:" + o.setupNewKeyBackup + ":" + ((await o.createSecretStorageKey()) === key)); void withKey; },
  } };
}

test("set up verification: password goes only into the UIA request; recovery key is returned once; nothing secret is emitted or logged", async () => {
  const s = setupCrypto([{ stages: ["m.login.password"] }]);
  const t = mk({ crypto: s.crypto });
  const r = await t.v.setup({ password: "pw" });
  assert.deepEqual(r, { recoveryKey: "EsTc 1234 abcd" });
  assert.deepEqual(s.calls, ["cross", "storage:true:true"]);
  assert.equal((s.accepted[1]!.auth as { session: string }).session, "S1");
  assert.deepEqual((s.accepted[1]!.auth as { identifier: unknown }).identifier, { type: "m.id.user", user: "@me:hs" });
  assert.ok(![...t.errors, JSON.stringify(t.events)].some((x) => x.includes("pw")));
});

test("set up verification: missing / wrong password and servers needing another auth type give plain messages", async () => {
  await assert.rejects(mk({ crypto: setupCrypto([{ stages: ["m.login.password"] }]).crypto }).v.setup({}), /Enter your account password/);
  await assert.rejects(mk({ crypto: setupCrypto([{ stages: ["m.login.password"] }]).crypto }).v.setup({ password: "wrong" }), /password was not accepted/);
  await assert.rejects(mk({ crypto: setupCrypto([{ stages: ["m.login.sso"] }]).crypto }).v.setup({ password: "pw" }), /sign-in step UniChat cannot do here \(m.login.sso\)/);
  const s = setupCrypto([]); (s.crypto as { getSecretStorageStatus: unknown }).getSecretStorageStatus = async () => ({ defaultKeyId: "K", ready: false });
  await assert.rejects(mk({ crypto: s.crypto }).v.setup({ password: "pw" }), /already has a recovery key/);
  const s2 = setupCrypto([]); (s2.crypto as { isCrossSigningReady: unknown }).isCrossSigningReady = async () => true; (s2.crypto as { getSecretStorageStatus: unknown }).getSecretStorageStatus = async () => ({ defaultKeyId: "K", ready: true });
  await assert.rejects(mk({ crypto: s2.crypto }).v.setup({}), /already set up/);
});

test("verify with recovery key: unlocks secret storage (key present only during the call), imports cross-signing; wrong key / no storage / bad input are plain errors", async () => {
  let during: Uint8Array | undefined; let t!: ReturnType<typeof mk>; let boots = 0; let wrong = false;
  const crypto = {
    getSecretStorageStatus: async () => ({ defaultKeyId: "K", ready: true, secretStorageKeyValidityMap: { "m.cross_signing.master": true } }),
    bootstrapCrossSigning: async (o: object) => { boots++; during = t.keyDuring(); assert.deepEqual(o, {}); if (wrong) throw new Error("bad MAC"); },
    loadSessionBackupPrivateKeyFromSecretStorage: async () => { throw new Error("no backup"); }, restoreKeyBackup: async () => ({}),
  };
  t = mk({ crypto });
  await t.v.recover("EsTc key");
  assert.equal(boots, 1); assert.deepEqual([...during!], [1, 2, 3]); assert.equal(t.keyDuring(), undefined);
  await assert.rejects(t.v.recover("bad"), /not a valid recovery key/);
  await assert.rejects(t.v.recover("  "), /Enter your recovery key/);
  wrong = true; await assert.rejects(t.v.recover("EsTc key"), /does not match this account/);
  const t2 = mk({ crypto: { getSecretStorageStatus: async () => ({ defaultKeyId: null, secretStorageKeyValidityMap: {} }) } });
  await assert.rejects(t2.v.recover("EsTc key"), /no recovery key set up/);
});

// ---- through the connector: capability, SDK event wiring, the generic calls
type Priv = { attach(c: unknown): void; emitFn: (e: CoreEvent) => void; session?: { userId: string }; client?: unknown };
test("connector: declares the verification capability, turns SDK requests into verification events and serves the generic calls", async () => {
  const conn = factory.create({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-mx-verif-")) }) as unknown as Priv & { capabilities: { verification?: boolean }; verificationAction(id: string, a: string): Promise<void>; verificationStatus(): Promise<{ state: string }> };
  const events: CoreEvent[] = []; conn.emitFn = (e) => events.push(e); conn.session = { userId: "@me:hs" };
  assert.equal(conn.capabilities.verification, true);
  const fake = new EventEmitter() as EventEmitter & Record<string, unknown>;
  fake.getUserId = () => "@me:hs"; fake.getUser = () => null; fake.getCrypto = () => undefined; conn.client = fake; conn.attach(fake);
  const sas = new FakeSas();
  const req = new FakeRequest(() => new FakeVerifier(sas, new Promise<void>(() => {})), "@me:hs", false); req.phase = VerificationPhase.Requested;
  fake.emit("crypto.verificationRequestReceived", req);
  const v = events.filter((e) => e.type === "verification").map((e) => (e as Extract<CoreEvent, { type: "verification" }>).data);
  assert.equal(v.length, 1); assert.equal(v[0]!.phase, "incoming"); assert.equal(v[0]!.accountId, "acc");
  await conn.verificationAction(v[0]!.id, "accept"); await tick();
  assert.equal(req.accepted, 1); assert.deepEqual(req.started, ["m.sas.v1"]);
  assert.equal((await conn.verificationStatus()).state, "unknown");           // no crypto yet
});

const mkConn = () => factory.create({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-mx-verif-")) }) as unknown as object;

// ---- sending link previews and custom emoji lookup through the connector (fake client, no network)
test("link preview on send: uses the homeserver preview, skipped in encrypted rooms, with linkPreview:false, on failure and timeout-free errors", async () => {
  const conn = mkConn();
  const asks: string[] = [];
  const c = { getUrlPreview: async (u: string) => { asks.push(u); if (u.includes("boom")) throw new Error("M_UNKNOWN"); return { "og:title": "Title", "og:description": "Desc" }; } };
  const lp = (text: string, enc: boolean, flag?: boolean) => (conn as unknown as { linkPreview(c: unknown, t: string, e: boolean, f?: boolean): Promise<Record<string, unknown>> }).linkPreview(c, text, enc, flag);
  const ok = await lp("see https://example.org/x", false);
  assert.equal((ok["com.beeper.linkpreviews"] as { "og:title": string }[])[0]!["og:title"], "Title");
  assert.deepEqual(await lp("see https://example.org/x", true), {});          // E2EE room: the server must not learn the URL
  assert.deepEqual(await lp("see https://example.org/x", false, false), {});  // user switched previews off
  assert.deepEqual(await lp("https://boom.test", false), {});                 // preview failure never blocks the message
  assert.deepEqual(await lp("no url here", false), {});
  assert.deepEqual(asks, ["https://example.org/x", "https://boom.test"]);
});

test("avatar(emoji) resolves a received custom emoji by shortcode", async () => {
  const conn = mkConn();
  const { htmlToText } = await import("./map.js");
  htmlToText('<img data-mx-emoticon src="mxc://hs/emo1" alt=":blobcat:">');
  const fetched: string[] = [];
  const p = conn as unknown as { client: unknown; fetchMxc(m: string, s: number): Promise<{ data: Uint8Array; mime: string }>; avatar(t: { kind: string; id: string }): Promise<unknown> };
  p.client = {}; p.fetchMxc = async (m) => { fetched.push(m); return { data: new Uint8Array([1]), mime: "image/png" }; };
  assert.ok(await p.avatar({ kind: "emoji", id: ":BlobCat:" }));
  assert.equal(await p.avatar({ kind: "emoji", id: "unknown" }), undefined);
  assert.deepEqual(fetched, ["mxc://hs/emo1"]);
});

// ---- device name "UniChat", live status events
test("login asks the homeserver to name the new device 'UniChat' (fake homeserver)", async () => {
  const bodies: Record<string, any>[] = [];
  const srv = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url!.endsWith("/versions")) return void res.end(JSON.stringify({ versions: ["v1.11"] }));
    if (req.url!.includes("/login") && req.method === "POST") { let b = ""; req.on("data", (d) => (b += d)); return void req.on("end", () => { bodies.push(JSON.parse(b)); res.statusCode = 403; res.end(JSON.stringify({ errcode: "M_FORBIDDEN", error: "no" })); }); }
    res.end("{}");
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const conn = factory.create({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-mx-name-")) });
  const prompts: any[] = [];
  try {
    await conn.start((e) => { if (e.type === "login") prompts.push(e.data); });
    await tick(100);
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    await assert.rejects(conn.submitLogin(prompts.at(-1).promptId, { homeserver: url, method: "password", username: "alice", password: "pw" }), /Invalid username or password/);
    assert.equal(bodies[0]!.initial_device_display_name, "UniChat");
    assert.equal(bodies[0]!.type, "m.login.password");
  } finally { await conn.stop(); srv.close(); }
});

test("existing sessions: a random/default device name is renamed to UniChat once; a name the user chose is kept", async () => {
  const conn = mkConn() as unknown as { ensureDeviceName(c: unknown): Promise<void> };
  const run = async (display_name: string | undefined, id = "CDQTOURDBP") => { const set: unknown[] = []; await conn.ensureDeviceName({ getDeviceId: () => id, getDevice: async () => ({ device_id: id, display_name }), setDeviceDetails: async (_i: string, b: unknown) => { set.push(b); } }); return set; };
  assert.deepEqual(await run("CDQTOURDBP"), [{ display_name: "UniChat" }]);
  assert.deepEqual(await run(undefined), [{ display_name: "UniChat" }]);
  assert.deepEqual(await run("QWERTZUIOP", "OTHER"), [{ display_name: "UniChat" }]);   // random 10-char default
  assert.deepEqual(await run("My laptop"), []);
  assert.deepEqual(await run("UniChat"), []);
  await conn.ensureDeviceName({ getDeviceId: () => "X", getDevice: async () => { throw new Error("offline"); }, setDeviceDetails: async () => {} }); // cosmetic: never throws
});

test("status events: 'verification-changed' after a verification succeeds, after set-up / recovery, and when my own trust status changes (not other users')", async () => {
  const sas = new FakeSas(); const req = own(sas, Promise.resolve(), true); req.phase = VerificationPhase.Requested;
  const changed: number[] = []; let n = 0;
  const t = mk({ crypto: { requestOwnUserVerification: async () => req } });
  const orig = (t.v as unknown as { h: VerifHost }).h.emit; (t.v as unknown as { h: VerifHost }).h.emit = (e) => { if (e.type === "verification-changed") changed.push(++n); orig(e); };
  await t.v.start(); req.setPhase(VerificationPhase.Ready); await tick();
  assert.equal(t.last().phase, "done"); assert.equal(changed.length, 1);
  const s2 = setupCrypto([{ stages: ["m.login.password"] }]);
  const t2 = mk({ crypto: s2.crypto }); let c2 = 0; (t2.v as unknown as { h: VerifHost }).h.emit = (e) => { if (e.type === "verification-changed") c2++; };
  await t2.v.setup({ password: "pw" }); assert.equal(c2, 1);
  // connector: SDK trust-status event of me -> event; of someone else -> nothing
  const conn = factory.create({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-mx-ev-")) }) as unknown as { attach(c: unknown): void; emitFn: (e: CoreEvent) => void; session?: { userId: string }; client?: unknown };
  const ev: CoreEvent[] = []; conn.emitFn = (e) => ev.push(e); conn.session = { userId: "@me:hs" };
  const fake = new EventEmitter() as EventEmitter & Record<string, unknown>; fake.getUserId = () => "@me:hs"; conn.client = fake; conn.attach(fake);
  fake.emit("userTrustStatusChanged", "@other:hs", {}); assert.equal(ev.filter((e) => e.type === "verification-changed").length, 0);
  fake.emit("userTrustStatusChanged", "@me:hs", {}); fake.emit("crypto.keyBackupStatus", true);
  assert.equal(ev.filter((e) => e.type === "verification-changed").length, 2);
});
