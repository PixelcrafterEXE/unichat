// Avatar replication between paired devices (real Hubs over loopback only, fake providers).
import test from "node:test";
import assert from "node:assert/strict";
import { AVATAR_MAX_BYTES, NO_CAPABILITIES, avatarKey, makeAvatar, type Connector, type ProviderFactory } from "@unimsg/core";
import { node, pairUp, until, type Node } from "./testkit.js";

const ACC = "fake-aaaa", K1 = avatarKey("chat", `${ACC}:c1`), K2 = avatarKey("space", `${ACC}:s1`);
const T = Date.now() - 3_600_000; // realistic times: very old rows are pruned
const pic = (n: number, len = 64) => new Uint8Array(len).fill(n);
const seed = (s: any) => s.putAccount({ id: ACC, provider: "fake", label: "Work", status: "active" });
/** pump now (retrying while the background tick holds the run) until `ok` holds */
const pull = (n: Node, ok: () => boolean, what: string) => until(async () => { await n.svc.avatars!.pump(true); return ok(); }, what);
const quick = (...ns: Node[]) => ns.forEach((n) => { n.svc.avatars!.gapMs = 0; });

test("an avatar replicates to a device that never had a connection; unchanged ones are not resent", async () => {
  const A = await node("A", "sqlite", undefined, seed), B = await node("B", "memory");
  A.store.putAvatar(makeAvatar(K1, pic(1), "image/png", T + 1000)); A.store.putAvatar(makeAvatar(K2, pic(2), "image/jpeg", T + 1000));
  await pairUp(A, B); quick(A, B);
  await until(() => B.store.listAccounts().length === 1, "account known on B");
  await pull(B, () => !!B.store.getAvatar(K1) && !!B.store.getAvatar(K2), "avatars arrive");
  assert.deepEqual([...B.store.getAvatar(K1)!.data], [...pic(1)]); assert.equal(B.store.getAvatar(K2)!.mime, "image/jpeg"); assert.equal(B.store.getAvatar(K1)!.fetchedAt, T + 1000);
  // the Hub on B (no connector for this account) serves it, and an UI-visible event is emitted
  assert.equal((await B.call("avatar", { kind: "chat", id: `${ACC}:c1` })).dataBase64, Buffer.from(pic(1)).toString("base64"));
  const served = A.svc.avatars!.stats.served; assert.equal(served, 2);
  await B.svc.avatars!.pump(true); await B.svc.avatars!.pump(true);
  assert.equal(A.svc.avatars!.stats.served, served, "nothing is requested again when the hash is unchanged");
  // a newer picture wins (last writer), an older one never overwrites
  A.store.putAvatar(makeAvatar(K1, pic(9), "image/png", T + 5000));
  await pull(B, () => B.store.getAvatar(K1)!.data[0] === 9, "newer replaces");
  assert.equal(A.svc.avatars!.stats.served, served + 1, "only the changed one moved");
  B.store.putAvatar(makeAvatar(K2, pic(7), "image/png", T + 9000)); // B's own newer one
  await B.svc.avatars!.pump(true); assert.equal(B.store.getAvatar(K2)!.data[0], 7);
  await pull(A, () => A.store.getAvatar(K2)!.data[0] === 7, "and flows back to A");
  for (const n of [A, B]) await n.stop();
});

test("the avatars-changed event lists the keys that sync delivered", async () => {
  const A = await node("A", "memory", undefined, seed), B = await node("B", "memory"); quick(A, B);
  A.store.putAvatar(makeAvatar(K1, pic(3), "image/png", T + 10)); await pairUp(A, B);
  await until(() => B.store.listAccounts().length === 1, "account");
  const ev: any[] = []; B.hub.subscribe((e, d) => e === "avatars-changed" && ev.push(d));
  await pull(B, () => !!B.store.getAvatar(K1), "arrives");
  assert.ok(ev.some((d) => d.keys.includes(K1)), "event delivered");
  for (const n of [A, B]) await n.stop();
});

test("size caps: oversized or forged pictures are never accepted; unknown or hidden accounts are skipped", async () => {
  const A = await node("A", "memory", undefined, seed), B = await node("B", "memory"); quick(A, B);
  A.store.putAvatar(makeAvatar(K1, pic(1), "image/png", T + 10));
  A.store.putAvatar(makeAvatar(avatarKey("chat", `${ACC}:big`), pic(5, AVATAR_MAX_BYTES + 1), "image/png", T + 10)); // bypassed the Hub's cap
  A.store.putAvatar(makeAvatar(avatarKey("chat", "other-1:x"), pic(6), "image/png", T + 10)); // an account B does not have
  await pairUp(A, B); await until(() => B.store.listAccounts().length === 1, "account");
  await pull(B, () => !!B.store.getAvatar(K1), "small one arrives");
  assert.equal(B.store.getAvatar(avatarKey("chat", `${ACC}:big`)), undefined, "over the cap: not served, not stored");
  assert.equal(B.store.getAvatar(avatarKey("chat", "other-1:x")), undefined, "account unknown here");
  // a corrupted transfer (wrong bytes for the announced hash) is rejected
  const real = A.svc.avatars!.get.bind(A.svc.avatars!);
  A.svc.avatars!.get = (p: any) => { const r = real(p); return r && { ...r, d: Buffer.from(pic(0xee)).toString("base64") }; };
  A.store.putAvatar(makeAvatar(K2, pic(2), "image/png", T + 20));
  await B.svc.avatars!.pump(true); await B.svc.avatars!.pump(true);
  assert.equal(B.store.getAvatar(K2), undefined, "hash mismatch rejected"); assert.ok(B.svc.avatars!.stats.rejected > 0);
  A.svc.avatars!.get = real;
  // an account set to "none" is neither served nor accepted
  await B.call("syncSetAccountMode", { accountId: ACC, mode: "none" }); await B.svc.avatars!.pump(true);
  assert.equal(B.store.getAvatar(K2), undefined);
  for (const n of [A, B]) await n.stop();
});

test("a third device gets them through a peer; the hint travels with the picture", async () => {
  const A = await node("A", "memory", undefined, seed), B = await node("B", "memory"), C = await node("C", "sqlite"); quick(A, B, C);
  A.store.putAvatar(makeAvatar(K1, pic(1), "image/png", T + 10, "rev-1")); await pairUp(A, B);
  await until(() => B.store.listAccounts().length === 1, "B account");
  await pairUp(B, C); await until(() => C.store.listAccounts().length === 1, "C account");
  await pull(B, () => !!B.store.getAvatar(K1), "B"); await pull(C, () => !!C.store.getAvatar(K1), "C");
  assert.deepEqual([...C.store.getAvatar(K1)!.data], [...pic(1)]); assert.equal(C.store.getAvatar(K1)!.rev, "rev-1");
  for (const n of [A, B, C]) await n.stop();
});

test("deletions propagate as tombstones; a peer that still holds the account does not resurrect the picture; a newer fetch beats the tombstone", async () => {
  const A = await node("A", "sqlite", undefined, seed), B = await node("B", "memory"), C = await node("C", "memory"); quick(A, B, C);
  A.store.putAvatar(makeAvatar(K1, pic(1), "image/png", T + 10)); A.store.putAvatar(makeAvatar(K2, pic(2), "image/png", T + 10));
  await pairUp(A, B); await until(() => B.store.listAccounts().length === 1, "B account");
  await pairUp(B, C); await until(() => C.store.listAccounts().length === 1, "C account");
  await pull(B, () => !!B.store.getAvatar(K1) && !!B.store.getAvatar(K2), "B has both"); await pull(C, () => !!C.store.getAvatar(K1), "C has them");
  // A leaves the chat: its pictures are tombstoned and the deletion reaches B and C (they still hold the account)
  A.store.deleteAvatars({ id: `${ACC}:c1`, at: Date.now() });
  await pull(B, () => B.store.getAvatar(K1)?.gone === true, "tombstone reaches B"); await pull(C, () => C.store.getAvatar(K1)?.gone === true, "and C");
  assert.equal(B.store.getAvatar(K1)!.data.length, 0); assert.ok(B.store.getAvatar(K2)!.data.length, "other pictures untouched");
  // nobody brings it back, however often they exchange
  for (let i = 0; i < 2; i++) for (const n of [A, B, C]) await n.svc.avatars!.pump(true);
  assert.equal(A.store.getAvatar(K1)!.gone, true); assert.equal(C.store.getAvatar(K1)!.gone, true);
  // a stale copy that only B's peer still had (older than the tombstone) loses; a fresh fetch afterwards wins everywhere
  C.store.putAvatar(makeAvatar(K1, pic(5), "image/png", T + 20)); // older than the tombstone
  await B.svc.avatars!.pump(true); await C.svc.avatars!.pump(true);
  assert.equal(B.store.getAvatar(K1)!.gone, true, "older picture does not beat the tombstone"); assert.equal(C.store.getAvatar(K1)!.gone, true, "C's stale copy is replaced by the tombstone");
  A.store.putAvatar(makeAvatar(K1, pic(6), "image/png", Date.now() + 10));
  await pull(B, () => B.store.getAvatar(K1)!.data[0] === 6, "newer fetch beats the tombstone on B"); await pull(C, () => C.store.getAvatar(K1)!.data[0] === 6, "and on C");
  // account removal on a device: tombstones for all its pictures go out, and that device's own copies are gone
  C.store.deleteAccount(ACC); C.store.deleteAccountData(ACC);
  assert.equal(C.store.getAvatar(K2)!.gone, true); assert.equal(C.store.getAvatar(K2)!.data.length, 0);
  await pull(B, () => B.store.getAvatar(K2)?.gone === true, "B drops the account's pictures too"); await pull(A, () => A.store.getAvatar(K2)?.gone === true, "A as well");
  await C.svc.avatars!.pump(true); assert.equal(C.store.getAvatar(K2)!.gone, true, "C never pulls them back");
  for (const n of [A, B, C]) await n.stop();
});

test("'no picture' results sync for an hour, never replace a picture and never outlive their window", async () => {
  const A = await node("A", "memory", undefined, seed), B = await node("B", "memory"); quick(A, B);
  const none = (k: string, at: number) => ({ key: k, mime: "", data: new Uint8Array(), fetchedAt: at, sha: "", empty: true });
  const K3 = avatarKey("chat", `${ACC}:c3`), K4 = avatarKey("chat", `${ACC}:c4`);
  A.store.putAvatar(none(K1, Date.now() - 1000)); A.store.putAvatar(none(K2, Date.now() - 2 * 3600_000)); A.store.putAvatar(none(K3, Date.now() - 500));
  await pairUp(A, B); await until(() => B.store.listAccounts().length === 1, "account");
  B.store.putAvatar(makeAvatar(K3, pic(3), "image/png", T)); // B has a real (older) picture: a "none" must not replace it
  await pull(B, () => B.store.getAvatar(K1)?.empty === true, "fresh negative arrives");
  assert.equal(B.store.getAvatar(K2), undefined, "an expired negative is neither served nor accepted"); assert.equal(B.store.getAvatar(K3)!.empty, undefined); assert.equal(B.store.getAvatar(K3)!.data[0], 3);
  A.store.putAvatar(makeAvatar(K1, pic(4), "image/png", Date.now() + 5)); // the picture appears: it replaces the negative everywhere
  await pull(B, () => B.store.getAvatar(K1)!.data[0] === 4, "picture beats none");
  // and a negative on A never replaces B's picture the other way round
  B.store.putAvatar(makeAvatar(K4, pic(8), "image/png", T)); A.store.putAvatar(none(K4, Date.now()));
  await pull(B, () => true, "run"); await pull(A, () => A.store.getAvatar(K4)?.data?.[0] === 8, "B's picture replaces A's negative");
  for (const n of [A, B]) await n.stop();
});

test("merged chat: a device that only received the pictures resolves the merge through its members", async () => {
  const A = await node("A", "memory", undefined, seed), B = await node("B", "memory"); quick(A, B);
  const m1 = avatarKey("chat", `${ACC}:ann`), M = "merge:m1";
  A.store.putAvatar(makeAvatar(m1, pic(2), "image/png", T + 5)); await pairUp(A, B); await until(() => B.store.listAccounts().length === 1, "account");
  B.store.putMerge({ id: M, members: [`${ACC}:ann`, `${ACC}:anna`], primary: `${ACC}:anna`, createdAt: "2026-01-01T00:00:00Z" }); await B.hub.reloadFromStore();
  assert.equal(await B.call("avatar", { kind: "chat", id: M }), null, "nothing yet");
  const ev: any[] = []; B.hub.subscribe((e, d) => e === "avatars-changed" && ev.push(d));
  await pull(B, () => !!B.store.getAvatar(m1), "member picture arrives");
  assert.equal((await B.call("avatar", { kind: "chat", id: M })).dataBase64, Buffer.from(pic(2)).toString("base64"), "the merged chat shows its member's picture");
  assert.ok(ev.length);
  for (const n of [A, B]) await n.stop();
});

test("metered connection: nothing is pulled unless the media policy is 'all'; held back / allowed by policy", async () => {
  const A = await node("A", "memory", undefined, seed), B = await node("B", "memory"); quick(A, B);
  A.store.putAvatar(makeAvatar(K1, pic(1), "image/png", T + 10)); await pairUp(A, B); await until(() => B.store.listAccounts().length === 1, "account");
  B.svc.avatars!.everyMs = 0; B.svc.avatars!.startDelayMs = 0;
  await B.call("syncSetMetered", { metered: true }); await B.call("syncSetMediaPolicy", { mode: "wifi", maxFileMB: 1, maxTotalMB: 100 });
  for (let i = 0; i < 4; i++) { await B.svc.avatars!.pump(); await new Promise((r) => setTimeout(r, 120)); }
  assert.equal(B.store.getAvatar(K1), undefined, "held back on a metered connection");
  await B.call("syncSetMetered", { metered: false });
  await until(() => !!B.store.getAvatar(K1), "pulled by the background tick once unmetered", 10_000); // no forced pump: the periodic tick does it
  // several more arrive in the next runs
  for (let i = 0; i < 5; i++) A.store.putAvatar(makeAvatar(avatarKey("contact", `${ACC}:u${i}`), pic(10 + i), "image/png", T + 20 + i));
  await pull(B, () => B.store.listAvatars({ limit: 100 }).length === 6, "all arrive");
  await B.call("syncSetMetered", { metered: true }); await B.call("syncSetMediaPolicy", { mode: "all", maxFileMB: 1, maxTotalMB: 100 });
  A.store.putAvatar(makeAvatar(K2, pic(2), "image/png", T + 30));
  await until(() => !!B.store.getAvatar(K2), "'all' policy allows it even when metered", 10_000);
  for (const n of [A, B]) await n.stop();
});

/** A fake provider that has `spaces` communities and `chats` chats, each with a picture (the "laptop" with a live connector). */
const warmFactory = (spaces: number, chats: number): ProviderFactory => ({ name: "warm", displayName: "warm", login: "qr", capabilities: NO_CAPABILITIES, create: () => ({
  capabilities: { ...NO_CAPABILITIES, avatars: true }, async start() {}, async stop() {}, async logout() {}, async submitLogin() {}, async members() { return []; }, async history() { return []; },
  async spaces() { return Array.from({ length: spaces }, (_, i) => ({ id: `s${i}`, accountId: "x", provider: "warm", name: "S" + i })); },
  async chats() { return Array.from({ length: chats }, (_, i) => ({ id: `c${i}`, accountId: "x", provider: "warm", kind: "dm", name: "C" + i, lastMessageAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() })); },
  async avatar(t: { id: string }) { return { data: new Uint8Array(40).fill(t.id.charCodeAt(1) + t.id.length), mime: "image/png" }; },
  async downloadAttachment() { return { data: new Uint8Array(), mime: "x" }; }, async send() { throw new Error("n/a"); } }) as unknown as Connector });

test("warm-up on the laptop drains to a phone with no connector within seconds (hint + repeated pulls), without duplicate transfers", async () => {
  const A = await node("A", "memory", undefined, undefined, undefined, { factories: [warmFactory(5, 35)] }), B = await node("B", "memory");
  const acc = await A.call("addAccount", { provider: "warm" }); A.hub.avatarWarmGapMs = 0;
  await pairUp(A, B); await until(() => B.store.listAccounts().length === 1, "B knows the account (archive, no connector)");
  await until(async () => (await B.call("accounts"))[0]?.state === "signed-out", "the hub on B shows it signed out");
  const sa = A.svc.avatars!, sb = B.svc.avatars!;
  sa.hintEveryMs = 0; sb.perRun = 10; sb.drainMs = 60; sb.nudgeDelayMs = 20; // the default 5 min rhythm is never waited for
  const t0 = Date.now(); const r = await A.call("avatarWarm"); assert.equal(r.fetched, 40);
  await until(() => B.store.listAvatars({ limit: 100 }).filter((m) => m.state === "pic").length === 40, "all 40 pictures reach the phone", 15_000);
  assert.ok(Date.now() - t0 < 15_000, "no 5 minute wait");
  assert.ok(sb.stats.runs >= 4, "10 per run => at least 4 runs (the drain repeats until a run moves nothing)");
  assert.equal(sa.stats.served, 40, "every picture was transferred exactly once"); assert.equal(sb.stats.fetched, 40);
  assert.equal((await B.call("avatar", { kind: "space", id: `${acc.id}:s3` })).mime, "image/png", "served on the phone from the store");
  const served = sa.stats.served; await B.svc.avatars!.pump(true); await A.svc.avatars!.pump(true); assert.equal(sa.stats.served, served, "nothing is sent again");
  assert.ok(sa.stats.hintsSent > 0 && sb.stats.hintsGot > 0, "the holder told the phone it had news");
  // the phone's own application of the pictures does not echo hints back
  const sent = sb.stats.hintsSent; await new Promise((r) => setTimeout(r, 400)); assert.equal(sb.stats.hintsSent, sent);
  for (const n of [A, B]) await n.stop();
});

test("a metered phone ignores hints until it is allowed to pull", async () => {
  const A = await node("A", "memory", undefined, undefined, undefined, { factories: [warmFactory(3, 5)] }), B = await node("B", "memory");
  await A.call("addAccount", { provider: "warm" }); A.hub.avatarWarmGapMs = 0;
  await pairUp(A, B); await until(() => B.store.listAccounts().length === 1, "account");
  A.svc.avatars!.hintEveryMs = 0; B.svc.avatars!.nudgeDelayMs = 20;
  await B.call("syncSetMetered", { metered: true }); await B.call("syncSetMediaPolicy", { mode: "wifi", maxFileMB: 1, maxTotalMB: 100 });
  await A.call("avatarWarm"); await until(() => B.svc.avatars!.stats.hintsGot > 0, "hint arrives");
  await new Promise((r) => setTimeout(r, 1200)); assert.equal(B.store.listAvatars({ limit: 100 }).length, 0, "held back on a metered connection");
  await B.call("syncSetMetered", { metered: false });
  await until(() => B.store.listAvatars({ limit: 100 }).filter((m) => m.state === "pic").length === 8, "pulled once unmetered", 10_000);
  for (const n of [A, B]) await n.stop();
});
