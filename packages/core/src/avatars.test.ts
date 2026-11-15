import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "./hub.js";
import { MemoryStore } from "./store.js";
import { AVATAR_MAX_BYTES, AVATAR_NEGATIVE_MS, AVATAR_TTL_MS, avatarKey, makeAvatar } from "./avatarstore.js";
import { avatarTomb, avatarWins } from "./store.js";
import { NO_CAPABILITIES, type Connector, type CoreEvent, type ProviderFactory } from "./provider.js";

class Fake {
  capabilities = NO_CAPABILITIES; emit: (e: CoreEvent) => void = () => {};
  calls = 0; pic: Uint8Array | undefined = new Uint8Array([1, 2, 3]); fail = false;
  async start(emit: (e: CoreEvent) => void) { this.emit = emit; } async stop() {} async logout() {} async submitLogin() {}
  chatList: any[] = []; spaceList: any[] = []; async spaces() { return this.spaceList; } async chats() { return this.chatList; }
  async getProfile() { return { displayName: "Me", avatar: this.pic && { data: this.pic, mime: "image/png" } }; }
  async updateProfile(p: { avatar?: { data: Uint8Array; mime: string } | null }) { if (p.avatar !== undefined) this.pic = p.avatar?.data; return this.getProfile(); } async history() { return []; } async members() { return []; }
  async downloadAttachment() { return { data: new Uint8Array(), mime: "x" }; } async send(): Promise<never> { throw new Error("n/a"); }
  async avatar(_t?: unknown) { this.calls++; if (this.fail) throw new Error("rate limited"); return this.pic && { data: this.pic, mime: "image/png" }; }
}
function setup(store = new MemoryStore()) {
  const dir = mkdtempSync(join(tmpdir(), "avatar-test-")), conns: Fake[] = [];
  const factory: ProviderFactory = { name: "fake", displayName: "Fake", login: "qr", capabilities: NO_CAPABILITIES, create: () => { const c = new Fake(); conns.push(c); return c as unknown as Connector; } };
  const hub = new Hub(dir, [factory], store);
  return { hub, store, conns, dir, call: (m: string, p?: unknown) => hub.call(m, p) as Promise<any>, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const b64 = (a: number[]) => Buffer.from(a).toString("base64");

test("a fetched avatar is stored durably and served after sign-out / restart without a connector", async () => {
  const t = setup(); const acc = await t.call("addAccount", { provider: "fake" });
  const id = `${acc.id}:ann`;
  assert.equal((await t.call("avatar", { kind: "chat", id })).dataBase64, b64([1, 2, 3]));
  assert.equal(t.store.getAvatar(avatarKey("chat", id))?.mime, "image/png");
  await t.call("signOut", { accountId: acc.id });
  assert.equal((await t.call("avatar", { kind: "chat", id })).dataBase64, b64([1, 2, 3]), "served while signed out");
  const hub2 = new Hub(t.dir, [], t.store); await hub2.init(); // fresh process, no factory at all
  assert.equal(((await hub2.call("avatar", { kind: "chat", id })) as any).dataBase64, b64([1, 2, 3]));
  t.done();
});

test("a picture that only arrived in the store (e.g. via sync) is served with no live connector, and avatars-changed drops a stale miss", async () => {
  const t = setup(); const acc = await t.call("addAccount", { provider: "fake" });
  const id = `${acc.id}:bob`; t.conns[0].pic = undefined;
  assert.equal(await t.call("avatar", { kind: "chat", id }), null); // live: provider has none
  t.store.putAvatar(makeAvatar(avatarKey("chat", id), new Uint8Array([9, 9]), "image/jpeg")); // a peer delivered one
  const seen: unknown[] = []; t.hub.subscribe((e, d) => e === "avatars-changed" && seen.push(d));
  (t.hub as any).emit("avatars-changed", { keys: [avatarKey("chat", id)] });
  assert.equal((await t.call("avatar", { kind: "chat", id })).dataBase64, b64([9, 9]));
  t.done();
});

test("TTL: a young stored picture is not re-fetched, an old one is refreshed; a failed refresh keeps the old one", async () => {
  const t = setup(); const acc = await t.call("addAccount", { provider: "fake" });
  const id = `${acc.id}:ann`, key = avatarKey("chat", id), c = t.conns[0];
  t.store.putAvatar(makeAvatar(key, new Uint8Array([5]), "image/png", Date.now() - 1000));
  assert.equal((await t.call("avatar", { kind: "chat", id })).dataBase64, b64([5])); assert.equal(c.calls, 0, "fresh: no network");
  t.store.putAvatar(makeAvatar(key, new Uint8Array([5]), "image/png", Date.now() - AVATAR_TTL_MS - 1000)); (t.hub as any).avatarCache.clear();
  c.fail = true;
  assert.equal((await t.call("avatar", { kind: "chat", id })).dataBase64, b64([5]), "refresh failed: old kept"); assert.equal(c.calls, 1);
  assert.equal(t.store.getAvatar(key)?.data[0], 5);
  c.fail = false; c.pic = undefined; (t.hub as any).avatarCache.clear();
  assert.equal((await t.call("avatar", { kind: "chat", id })).dataBase64, b64([5]), "provider returned nothing: old kept");
  c.pic = new Uint8Array([7, 7]); (t.hub as any).avatarCache.clear();
  const changed: any[] = []; t.hub.subscribe((e, d) => e === "avatars-changed" && changed.push(d));
  assert.equal((await t.call("avatar", { kind: "chat", id })).dataBase64, b64([7, 7]), "refreshed");
  assert.equal(t.store.getAvatar(key)?.data[0], 7); assert.deepEqual(changed, [{ keys: [key] }]);
  t.done();
});

test("negative results are remembered briefly; oversized pictures are shown but not stored", async () => {
  const t = setup(); const acc = await t.call("addAccount", { provider: "fake" });
  const c = t.conns[0], id = `${acc.id}:nobody`, key = avatarKey("chat", id);
  c.pic = undefined;
  assert.equal(await t.call("avatar", { kind: "chat", id }), null); assert.equal(t.store.getAvatar(key)?.empty, true);
  (t.hub as any).avatarCache.clear(); assert.equal(await t.call("avatar", { kind: "chat", id }), null); assert.equal(c.calls, 1, "stored miss: no new request");
  t.store.putAvatar({ ...t.store.getAvatar(key)!, fetchedAt: Date.now() - AVATAR_NEGATIVE_MS - 1 }); (t.hub as any).avatarCache.clear();
  c.pic = new Uint8Array([4]); assert.equal((await t.call("avatar", { kind: "chat", id })).dataBase64, b64([4])); assert.equal(c.calls, 2, "miss expired");
  const big = `${acc.id}:big`; c.pic = new Uint8Array(AVATAR_MAX_BYTES + 1).fill(1);
  assert.ok((await t.call("avatar", { kind: "chat", id: big })).dataBase64.length > 0); assert.equal(t.store.getAvatar(avatarKey("chat", big)), undefined);
  t.done();
});

test("deleting an account's data leaves tombstones (so sync can carry the deletion); a later fetch beats the tombstone", async () => {
  const t = setup(); const acc = await t.call("addAccount", { provider: "fake" });
  const id = `${acc.id}:ann`; await t.call("avatar", { kind: "chat", id }); await t.call("avatar", { kind: "chat", id, full: true });
  assert.ok(t.store.getAvatar(avatarKey("chat", id, true)));
  await t.call("signOut", { accountId: acc.id });
  assert.equal((await t.call("avatar", { kind: "chat", id })).dataBase64, b64([1, 2, 3]));
  const before = Date.now(); t.store.deleteAccountData(acc.id);
  for (const full of [false, true]) { const a = t.store.getAvatar(avatarKey("chat", id, full))!; assert.equal(a.gone, true); assert.equal(a.data.length, 0); assert.ok(a.fetchedAt >= before); }
  (t.hub as any).avatarCache.clear(); assert.equal(await t.call("avatar", { kind: "chat", id }), null, "a tombstone serves nothing");
  assert.deepEqual(t.store.listAvatars({ limit: 10 }).map((m) => m.state), ["gone", "gone"]);
  t.done();
});

test("leaving a chat tombstones its pictures (thumbnail and full, even ones never fetched); re-fetching on a live account replaces the tombstone", async () => {
  const t = setup(); const acc = await t.call("addAccount", { provider: "fake" });
  const id = `${acc.id}:ann`; await t.call("avatar", { kind: "chat", id });
  t.store.deleteAvatars({ id, at: Date.now() - 50 });
  assert.equal(t.store.getAvatar(avatarKey("chat", id))!.gone, true); assert.equal(t.store.getAvatar(avatarKey("chat", id, true))!.gone, true);
  (t.hub as any).avatarCache.clear();
  assert.equal((await t.call("avatar", { kind: "chat", id })).dataBase64, b64([1, 2, 3])); assert.equal(t.store.getAvatar(avatarKey("chat", id))!.gone, undefined);
  t.done();
});

test("provider hint (avatarRev): a changed hint refreshes a young stored picture, the hint is persisted, a matching one is trusted", async () => {
  const t = setup(); const acc = await t.call("addAccount", { provider: "fake" }), c = t.conns[0];
  const id = `${acc.id}:ann`, key = avatarKey("chat", id);
  c.chatList = [{ id: "ann", accountId: "x", provider: "fake", kind: "dm", name: "Ann", avatarRev: "v1" }];
  await t.call("snapshot"); await t.call("avatar", { kind: "chat", id });
  assert.equal(t.store.getAvatar(key)!.rev, "v1"); assert.equal(c.calls, 1);
  (t.hub as any).avatarCache.clear(); await t.call("avatar", { kind: "chat", id }); assert.equal(c.calls, 1, "same hint: served from the store");
  t.store.putAvatar({ ...t.store.getAvatar(key)!, fetchedAt: Date.now() - AVATAR_TTL_MS - 1000 }); (t.hub as any).avatarCache.clear();
  await t.call("avatar", { kind: "chat", id }); assert.equal(c.calls, 1, "a matching hint is trusted beyond the 7-day TTL");
  const seen: any[] = []; t.hub.subscribe((e, d) => e === "avatars-changed" && seen.push(d));
  c.chatList = [{ ...c.chatList[0], avatarRev: "v2" }]; c.pic = new Uint8Array([8, 8]);
  await t.call("snapshot"); assert.ok(seen.some((d) => d.keys.includes(key)), "UI is told");
  assert.equal((await t.call("avatar", { kind: "chat", id })).dataBase64, b64([8, 8])); assert.equal(c.calls, 2);
  assert.equal(t.store.getAvatar(key)!.rev, "v2");
  t.done();
});

test("no hint: 7 days, but 24 hours for a chat the user opened recently", async () => {
  const t = setup(); const acc = await t.call("addAccount", { provider: "fake" }), c = t.conns[0];
  const id = `${acc.id}:ann`, other = `${acc.id}:bob`;
  for (const i of [id, other]) t.store.putAvatar(makeAvatar(avatarKey("chat", i), new Uint8Array([5]), "image/png", Date.now() - 2 * 86_400_000));
  await t.call("avatar", { kind: "chat", id: other }); assert.equal(c.calls, 0, "2 days old, not opened: still fresh");
  await t.call("history", { chatId: id, limit: 5 }).catch(() => {});
  await t.call("avatar", { kind: "chat", id }); assert.equal(c.calls, 1, "opened lately: 2 days is stale");
  t.done();
});

test("a provider 'avatar-changed' event refreshes the stored copy right away", async () => {
  const t = setup(); const acc = await t.call("addAccount", { provider: "fake" }), c = t.conns[0];
  const id = `${acc.id}:ann`, key = avatarKey("chat", id); await t.call("avatar", { kind: "chat", id });
  const seen: any[] = []; t.hub.subscribe((e, d) => e === "avatars-changed" && seen.push(d));
  c.pic = new Uint8Array([6, 6]); c.emit({ type: "avatar-changed", data: { id: "ann" } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.store.getAvatar(key)!.data[0], 6); assert.ok(seen.some((d) => d.keys.includes(key)));
  t.done();
});

test("own picture: changing it in the profile UI (or the provider reporting it) refreshes every stored copy of it immediately", async () => {
  const t = setup(); const acc = await t.call("addAccount", { provider: "fake" }), c = t.conns[0];
  const self = `${acc.id}:me`, selfFull = avatarKey("chat", self, true), other = `${acc.id}:ann`;
  await t.call("avatar", { kind: "chat", id: self }); await t.call("avatar", { kind: "contact", id: self });
  c.pic = new Uint8Array([1, 2, 3]); // own picture == [1,2,3]; someone else's picture differs
  t.store.putAvatar(makeAvatar(avatarKey("chat", other), new Uint8Array([4]), "image/png"));
  const seen: any[] = []; t.hub.subscribe((e, d) => e === "avatars-changed" && seen.push(d));
  await t.call("updateProfile", { accountId: acc.id, avatar: { dataBase64: b64([9, 9]), mime: "image/png" } });
  assert.equal(t.store.getAvatar(avatarKey("chat", self))!.data[0], 9); assert.equal(t.store.getAvatar(avatarKey("contact", self))!.data[0], 9);
  assert.equal(t.store.getAvatar(avatarKey("chat", other))!.data[0], 4, "other people's pictures are left alone");
  assert.ok(seen.some((d) => d.keys.includes(avatarKey("chat", self)))); void selfFull;
  // provider-reported own change with no way to identify the old picture: the account's pictures refresh lazily
  c.pic = new Uint8Array([7]); c.emit({ type: "avatar-changed", data: { own: true } }); await new Promise((r) => setTimeout(r, 20));
  assert.equal((await t.call("avatar", { kind: "chat", id: self })).dataBase64, b64([7]));
  t.done();
});

test("negative results never replace a picture; sync-style LWW rules (tombstone vs picture vs none)", () => {
  const st = (state: "pic" | "none" | "gone", fetchedAt: number, sha = "a") => ({ state, fetchedAt, sha });
  const pic = makeAvatar("chat|a:1", new Uint8Array([1]), "image/png", 1000);
  assert.equal(avatarWins(st("none", 5000), pic), false); assert.equal(avatarWins(st("gone", 2000), pic), true); assert.equal(avatarWins(st("gone", 500), pic), false, "older tombstone loses");
  assert.equal(avatarWins(st("pic", 3000, "b"), avatarTomb("chat|a:1", 2000)), true, "newer fetch beats the tombstone"); assert.equal(avatarWins(st("pic", 1500, "b"), avatarTomb("chat|a:1", 2000)), false);
  assert.equal(avatarWins(st("pic", 3000, pic.sha), pic), false, "same hash: nothing to do");
  assert.equal(avatarWins(st("none", 3000), undefined), true);
});

test("merged chat: the picture resolves through the members from the store with no live connector", async () => {
  const t = setup(); const a1 = await t.call("addAccount", { provider: "fake" }), a2 = await t.call("addAccount", { provider: "fake" });
  const mk = (i: number, n: string) => { t.conns[i].chatList = [{ id: n, accountId: "x", provider: "fake", kind: "dm", name: n }]; t.conns[i].emit({ type: "account", data: { id: i ? a2.id : a1.id, state: "connected" } }); };
  mk(0, "ann"); mk(1, "anna");
  const A = `${a1.id}:ann`, B = `${a2.id}:anna`, row = await t.call("mergeChats", { chatIds: [A, B] });
  t.store.putAvatar(makeAvatar(avatarKey("chat", B), new Uint8Array([3, 3]), "image/png")); // only the second member has a picture
  await t.call("signOut", { accountId: a1.id }); await t.call("signOut", { accountId: a2.id });
  assert.equal((await t.call("avatar", { kind: "chat", id: row.id })).dataBase64, b64([3, 3]), "falls through to the member that has one");
  t.store.putAvatar(makeAvatar(avatarKey("chat", A), new Uint8Array([2]), "image/png"));
  assert.equal((await t.call("avatar", { kind: "chat", id: row.id })).dataBase64, b64([2]), "the primary wins when it has one");
  t.done();
});

test("pruneAvatars keeps the newest within the byte cap and drops the expired", () => {
  const s = new MemoryStore(), now = Date.now();
  for (let i = 0; i < 5; i++) s.putAvatar(makeAvatar(`chat|a:${i}`, new Uint8Array(100), "image/png", now - i * 1000));
  assert.equal(s.pruneAvatars({ maxBytes: 250 }), 3); assert.deepEqual(s.listAvatars({ limit: 10 }).map((m) => m.key), ["chat|a:0", "chat|a:1"]);
  assert.equal(s.pruneAvatars({ maxBytes: 1e6, olderThan: now - 500 }), 1);
});

test("warm-up: spaces first, then folder chats and recent chats are fetched into the store, once; only what is missing; backs off on errors; pausable", async () => {
  const t = setup(); t.hub.avatarWarmGapMs = 1; const acc = await t.call("addAccount", { provider: "fake" }), c = t.conns[0];
  c.spaceList = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, accountId: "x", provider: "fake", name: "S" + i }));
  c.chatList = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, accountId: "x", provider: "fake", kind: "dm", name: "C" + i, lastMessageAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
  const order: string[] = []; const orig = c.avatar.bind(c); c.avatar = async (tg: any) => { order.push(tg.kind + ":" + tg.id); return orig(); };
  const r = await t.call("avatarWarm");
  assert.equal(r.fetched, 45); assert.deepEqual(order.slice(0, 5), ["space:s0", "space:s1", "space:s2", "space:s3", "space:s4"], "communities first");
  assert.equal(order[5], "chat:c39", "then the most recently active chat");
  for (let i = 0; i < 5; i++) assert.ok(t.store.getAvatar(avatarKey("space", `${acc.id}:s${i}`)));
  assert.ok(t.store.getAvatar(avatarKey("chat", `${acc.id}:c0`)), "all 40 chats are within the 300 most recent");
  const calls = c.calls; assert.equal((await t.call("avatarWarm")).fetched, 0); assert.equal(c.calls, calls, "second run: everything is in the store, no provider traffic");
  // negative results are respected, errors back off and end the run after 5 in a row
  const t2 = setup(); t2.hub.avatarWarmGapMs = 1; const acc2 = await t2.call("addAccount", { provider: "fake" }), d = t2.conns[0]; void acc2;
  d.chatList = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, accountId: "x", provider: "fake", kind: "dm", name: "C" + i }));
  d.pic = undefined; await t2.call("avatarWarm"); assert.equal(d.calls, 20); await t2.call("avatarWarm"); assert.equal(d.calls, 20, "stored 'no picture' answers: not asked again");
  const t3 = setup(); t3.hub.avatarWarmGapMs = 1; await t3.call("addAccount", { provider: "fake" }); const e = t3.conns[0];
  e.chatList = d.chatList; e.fail = true; await t3.call("avatarWarm"); assert.equal(e.calls, 5, "five errors in a row stop the run (no hammering)");
  await t3.call("setAvatarWarmPaused", { paused: true }); e.fail = false; assert.equal((await t3.call("avatarWarm")).asked, 0, "paused");
  await t3.call("setAvatarWarmPaused", { paused: false });
  // an account without a live connector is not warmed
  await t3.call("signOut", { accountId: (await t3.call("accounts"))[0].id }); assert.equal((await t3.call("avatarWarm")).asked, 0);
  t.done(); t2.done(); t3.done();
});

test("forgetAvatarMisses: a remembered 'no picture' is asked again, a stored picture is untouched", async () => {
  const t = setup(); const acc = await t.call("addAccount", { provider: "fake" });
  const miss = `${acc.id}:bob`, pic = `${acc.id}:ann`;
  t.conns[0]!.pic = undefined;
  assert.equal(await t.call("avatar", { kind: "chat", id: miss }), null, "first answer: no picture (remembered)");
  t.conns[0]!.pic = new Uint8Array([9, 9]);
  assert.equal(await t.call("avatar", { kind: "chat", id: miss }), null, "still remembered as 'none' for a while");
  assert.equal((await t.call("avatar", { kind: "chat", id: pic })).dataBase64, b64([9, 9]));
  const r = await t.call("avatarForgetMisses", { accountId: acc.id });
  assert.equal(r.forgotten, 1);
  assert.equal((await t.call("avatar", { kind: "chat", id: miss })).dataBase64, b64([9, 9]), "asked again after forgetting");
  assert.equal(t.store.getAvatar(avatarKey("chat", pic))?.fetchedAt! > 1, true, "the stored picture was not touched");
  t.done();
});
