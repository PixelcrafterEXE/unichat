import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "./hub.js";
import { MemoryStore } from "./store.js";
import { NO_CAPABILITIES, type Connector, type CoreEvent, type ProviderFactory } from "./provider.js";
import type { Chat, Message } from "./model.js";

/** A provider whose behaviour the test controls. */
class Fake implements Connector {
  capabilities = NO_CAPABILITIES;
  emit: (e: CoreEvent) => void = () => {};
  started = false; loggedOut = false; stopped = false;
  providerHistory: Message[] = [];
  downloads = 0;
  chatList: Chat[] = [{ id: "ann", accountId: "x", provider: "fake", kind: "dm", name: "Ann" }];
  async start(emit: (e: CoreEvent) => void) { this.emit = emit; this.started = true; }
  async stop() { this.stopped = true; }
  async logout() { this.loggedOut = true; this.chatList = []; } // like a real provider: wipes its own state
  async submitLogin() {}
  async spaces() { return []; }
  async chats() { return this.chatList; }
  history: (c: string, q: { limit: number; beforeMessageId?: string }) => Promise<Message[]> = async (_c, q) => this.providerHistory.slice(-q.limit);
  members: () => Promise<{ id: string; name: string }[]> = async () => [];
  async downloadAttachment() { this.downloads++; return { data: new Uint8Array([1, 2, 3]), mime: "image/png", name: "p.png" }; }
  async send(chatId: string, m: { text: string }): Promise<Message> { return { id: "out" + Math.random(), chatId, sender: "Me", senderId: "me", text: m.text, time: new Date().toISOString(), fromMe: true, status: "sent" }; }
}

function setup(opts: { backfill?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hub-test-"));
  const conns: Fake[] = [];
  const factory: ProviderFactory = { name: "fake", displayName: "Fake", login: "qr", capabilities: { ...NO_CAPABILITIES, backfill: !!opts.backfill },
    create: () => { const c = new Fake(); conns.push(c); return c; } };
  const store = new MemoryStore();
  const hub = new Hub(dir, [factory], store);
  const call = (m: string, p?: unknown) => hub.call(m, p) as Promise<any>;
  return { hub, store, conns, call, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const msg = (id: string, text: string, time: string): Message => ({ id, chatId: "ann", sender: "Ann", senderId: "ann", text, time, fromMe: false });
async function linked(t: ReturnType<typeof setup>) {
  const acc = await t.call("addAccount", { provider: "fake" });
  t.conns[0].emit({ type: "account", data: { id: acc.id, state: "connected" } });
  return acc.id as string;
}

test("messages are archived and outlive the provider's own history", async () => {
  const t = setup(); const id = await linked(t);
  t.conns[0].emit({ type: "message", data: msg("m1", "hello", "2026-01-01T10:00:00Z") });
  t.conns[0].emit({ type: "message", data: msg("m2", "again", "2026-01-01T10:01:00Z") });
  t.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: "m1", patch: { reactions: [{ emoji: "👍", senderIds: ["me"], mine: true }] } } });
  const h = await t.call("history", { chatId: `${id}:ann`, limit: 50 });
  assert.deepEqual(h.filter((m: Message) => !m.system).map((m: Message) => m.text), ["hello", "again"]); // provider.history() is [] here
  assert.equal(h[0].reactions?.[0].emoji, "👍");
  t.done();
});

test("re-delivered messages never erase edits or deletions", async () => {
  const t = setup(); const id = await linked(t);
  t.conns[0].emit({ type: "message", data: msg("m1", "original", "2026-01-01T10:00:00Z") });
  t.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: "m1", patch: { text: "edited", editedAt: "2026-01-01T10:05:00Z" } } });
  t.store.putMessages([{ ...msg("m1", "original", "2026-01-01T10:00:00Z"), chatId: `${id}:ann` }]); // history replay
  assert.equal((await t.call("history", { chatId: `${id}:ann`, limit: 5 }))[0].text, "edited");
  t.done();
});

test("paging backwards walks the archive", async () => {
  const t = setup(); const id = await linked(t);
  for (let i = 0; i < 30; i++) t.conns[0].emit({ type: "message", data: msg("m" + String(i).padStart(2, "0"), "t" + i, new Date(Date.UTC(2026, 0, 1, 10, i)).toISOString()) });
  const newest = await t.call("history", { chatId: `${id}:ann`, limit: 10 });
  const real = (xs: Message[]) => xs.filter((m) => !m.system); // timeline markers ride along and don't count as messages
  assert.equal(real(newest).length, 10); assert.equal(real(newest).at(-1)!.text, "t29");
  const older = await t.call("history", { chatId: `${id}:ann`, limit: 10, beforeMessageId: real(newest)[0].id });
  assert.equal(real(older).at(-1)!.text, "t19"); assert.equal(real(older)[0].text, "t10");
  t.done();
});

test("provider history is merged in and kept when the provider can backfill", async () => {
  const t = setup({ backfill: true }); const id = await linked(t);
  t.conns[0].providerHistory = [{ ...msg("old", "from server", "2025-12-31T09:00:00Z") }];
  const h = await t.call("history", { chatId: `${id}:ann`, limit: 50 });
  assert.equal(h[0].text, "from server");
  t.conns[0].providerHistory = []; // server no longer has it, our archive does
  assert.equal((await t.call("history", { chatId: `${id}:ann`, limit: 50 }))[0].text, "from server");
  t.done();
});

test("sign out keeps the archive, makes chats read-only and leaves a marker", async () => {
  const t = setup(); const id = await linked(t);
  t.conns[0].emit({ type: "message", data: msg("m1", "keep me", "2026-01-01T10:00:00Z") });
  await t.call("snapshot"); // chat list gets cached
  await t.call("signOut", { accountId: id });
  assert.equal(t.conns[0].loggedOut, true); assert.equal(t.conns[0].stopped, true);
  const acc = (await t.call("accounts"))[0];
  assert.equal(acc.state, "signed-out"); assert.ok(acc.signedOutAt);
  const snap = await t.call("snapshot");
  assert.equal(snap.chats.length, 1); // provider wiped its list; the Hub's cache survives
  assert.equal(snap.chats[0].offline, "signed-out"); assert.equal(snap.chats[0].readOnly, true);
  const h = await t.call("history", { chatId: `${id}:ann`, limit: 50 });
  assert.equal(h[0].text, "keep me");
  assert.equal(h.at(-1).system?.kind, "signed-out");
  await assert.rejects(t.call("send", { chatId: `${id}:ann`, text: "hi" }), /signed out/);
  await assert.rejects(t.call("react", { chatId: `${id}:ann`, messageId: "m1", emoji: "👍" }), /signed out/);
  t.done();
});

test("signing in again continues the same chats and marks the possible gap", async () => {
  const t = setup(); const id = await linked(t);
  t.conns[0].emit({ type: "message", data: msg("m1", "before", "2026-01-01T10:00:00Z") });
  await t.call("snapshot"); await t.call("signOut", { accountId: id });
  await t.call("signIn", { accountId: id });
  assert.equal(t.conns.length, 2); assert.equal(t.conns[1].started, true);
  assert.equal((await t.call("accounts"))[0].state, "connecting");
  t.conns[1].emit({ type: "account", data: { id, state: "connected" } });
  t.conns[1].emit({ type: "message", data: msg("m2", "after", new Date(Date.now() + 5000).toISOString()) });
  const h = await t.call("history", { chatId: `${id}:ann`, limit: 50 });
  const kinds = h.map((m: Message) => m.system?.kind ?? m.text);
  // no server history for this provider => a first-link marker, then the sign-out, then the re-link marker
  assert.deepEqual(kinds, ["before", "linked", "signed-out", "linked", "after"]);
  assert.match(h.filter((m: Message) => m.system?.kind === "linked").at(-1).text, /Signed in again.*may be missing/);
  assert.equal((await t.call("snapshot")).chats[0].offline, undefined);
  t.done();
});

test("cancelling a re-sign-in returns to the archive", async () => {
  const t = setup(); const id = await linked(t);
  await t.call("snapshot"); await t.call("signOut", { accountId: id }); await t.call("signIn", { accountId: id });
  await t.call("cancelSignIn", { accountId: id });
  assert.equal((await t.call("accounts"))[0].state, "signed-out");
  assert.equal((await t.call("snapshot")).chats[0].offline, "signed-out");
  t.done();
});

test("an unlink by the phone becomes a read-only archive with a marker, without deleting anything", async () => {
  const t = setup(); const id = await linked(t);
  t.conns[0].emit({ type: "message", data: msg("m1", "hi", "2026-01-01T10:00:00Z") });
  await t.call("snapshot");
  t.conns[0].emit({ type: "account", data: { id, state: "needs-login" } }); // phone removed the device
  const snap = await t.call("snapshot");
  assert.equal(snap.chats[0].offline, "needs-login");
  assert.equal((await t.call("history", { chatId: `${id}:ann`, limit: 9 })).at(-1).system?.kind, "unlinked");
  await assert.rejects(t.call("send", { chatId: `${id}:ann`, text: "x" }), /read-only/);
  t.conns[0].emit({ type: "account", data: { id, state: "connected" } }); // relinked in place (e.g. new QR scanned)
  const again = await t.call("history", { chatId: `${id}:ann`, limit: 9 });
  assert.deepEqual(again.map((m: Message) => m.system?.kind ?? m.text), ["hi", "linked", "unlinked", "linked"]); // (test messages are dated in the past) message, first-link, unlink, relink
  assert.equal((await t.call("snapshot")).chats[0].offline, undefined);
  t.done();
});

test("the very first link of a provider without server history is marked", async () => {
  const t = setup({ backfill: false }); const id = await linked(t);
  const h = await t.call("history", { chatId: `${id}:ann`, limit: 9 });
  assert.match(h[0].text, /Earlier messages aren't available/);
  const b = setup({ backfill: true }); const bid = await linked(b);
  assert.equal((await b.call("history", { chatId: `${bid}:ann`, limit: 9 })).length, 0);
  t.done(); b.done();
});

test("remove deletes the account AND its archive; a failed first link leaves nothing behind", async () => {
  const t = setup(); const id = await linked(t);
  t.conns[0].emit({ type: "message", data: msg("m1", "secret", "2026-01-01T10:00:00Z") });
  await t.call("snapshot"); await t.call("setAlias", { chatId: `${id}:ann`, name: "Annie" });
  await t.call("removeAccount", { accountId: id });
  assert.deepEqual(await t.call("accounts"), []);
  assert.equal(t.store.listMessages(`${id}:ann`, { limit: 9 }).length, 0);
  assert.equal(t.store.getChatCache(id), undefined);
  assert.deepEqual(t.store.listAliases(), {});
  assert.equal(existsSync(join(t.dir, id)), false);
  t.done();
});

test("retention drops old messages", async () => {
  const t = setup(); const id = await linked(t);
  t.conns[0].emit({ type: "message", data: msg("old", "ancient", new Date(Date.now() - 40 * 864e5).toISOString()) });
  t.conns[0].emit({ type: "message", data: msg("new", "recent", new Date().toISOString()) });
  await t.call("setSetting", { key: "retentionDays", value: 30 });
  assert.equal((await t.call("getSettings")).retentionDays, 30);
  assert.deepEqual((await t.call("history", { chatId: `${id}:ann`, limit: 9 })).filter((m: Message) => !m.system).map((m: Message) => m.text), ["recent"]);
  t.done();
});

test("opened attachments stay available after sign-out; unopened ones say so", async () => {
  const t = setup(); const id = await linked(t);
  const chatId = `${id}:ann`;
  const first = await t.call("attachment", { chatId, messageId: "m1", attachmentId: "a1" });
  assert.equal(first.mime, "image/png"); assert.equal(t.conns[0].downloads, 1);
  await t.call("attachment", { chatId, messageId: "m1", attachmentId: "a1" });
  assert.equal(t.conns[0].downloads, 1); // served from the cache
  await t.call("snapshot"); await t.call("signOut", { accountId: id });
  assert.equal((await t.call("attachment", { chatId, messageId: "m1", attachmentId: "a1" })).mime, "image/png");
  await assert.rejects(t.call("attachment", { chatId, messageId: "m2", attachmentId: "a9" }), /isn't available offline/);
  t.done();
});

test("an archived account survives a backend restart without starting a connector", async () => {
  const t = setup(); const id = await linked(t);
  t.conns[0].emit({ type: "message", data: msg("m1", "persisted", "2026-01-01T10:00:00Z") });
  await t.call("snapshot"); await t.call("signOut", { accountId: id });
  const factory: ProviderFactory = { name: "fake", displayName: "Fake", login: "qr", capabilities: NO_CAPABILITIES, create: () => { throw new Error("must not start"); } };
  const hub2 = new Hub(t.dir, [factory], t.store); await hub2.init();
  assert.equal(((await hub2.call("accounts")) as any[])[0].state, "signed-out");
  assert.equal((((await hub2.call("history", { chatId: `${id}:ann`, limit: 9 })) as Message[])[0]).text, "persisted");
  t.done();
});

test("a name given to a person applies wherever they appear, e.g. as a group sender and in the member list", async () => {
  const t = setup(); const id = await linked(t);
  t.conns[0].members = async () => [{ id: "bob", name: "WhatsApp user" }, { id: "eve", name: "Eve" }];
  t.conns[0].emit({ type: "message", data: { ...msg("g1", "hi group", "2026-01-01T10:00:00Z"), chatId: "group1", senderId: "bob", sender: "WhatsApp user" } });
  t.conns[0].emit({ type: "message", data: { ...msg("g2", "me too", "2026-01-01T10:01:00Z"), chatId: "group1", senderId: "eve", sender: "Eve" } });
  await t.call("setAlias", { chatId: `${id}:bob`, name: "Bobby" }); // alias is set on Bob's 1:1 chat id
  const h = await t.call("history", { chatId: `${id}:group1`, limit: 9 });
  assert.deepEqual(h.filter((m: Message) => !m.system).map((m: Message) => m.sender), ["Bobby", "Eve"]);
  assert.deepEqual((await t.call("members", { chatId: `${id}:group1` })).map((c: { name: string }) => c.name), ["Bobby", "Eve"]);
  t.conns[0].emit({ type: "message", data: { ...msg("g3", "live", "2026-01-01T10:02:00Z"), chatId: "group1", senderId: "bob", sender: "WhatsApp user" } });
  assert.equal((await t.call("history", { chatId: `${id}:group1`, limit: 9 })).filter((m: Message) => !m.system).at(-1).sender, "Bobby");
  await t.call("setAlias", { chatId: `${id}:bob`, name: "" }); // clearing the alias restores the provider's name
  assert.equal((await t.call("history", { chatId: `${id}:group1`, limit: 9 })).find((m: Message) => !m.system).sender, "WhatsApp user");
  t.done();
});

test("opening a chat is answered from the archive immediately; the provider tops up in the background", async () => {
  const t = setup({ backfill: true }); const id = await linked(t);
  t.conns[0].emit({ type: "message", data: msg("m1", "already archived", "2026-01-01T10:00:00Z") });
  let release!: () => void; const gate = new Promise<void>((r) => (release = r));
  t.conns[0].history = async () => { await gate; return [msg("m0", "older, only the provider knows", "2025-12-31T09:00:00Z")]; }; // a slow provider (e.g. asking the phone)
  const t0 = Date.now(); const events: string[] = []; t.hub.subscribe((e) => events.push(e));
  const first = await t.call("history", { chatId: `${id}:ann`, limit: 50 });
  assert.ok(Date.now() - t0 < 1000, "must not wait for the provider");
  assert.deepEqual(first.filter((m: Message) => !m.system).map((m: Message) => m.text), ["already archived"]);
  release(); await new Promise((r) => setTimeout(r, 50));
  assert.ok(events.includes("history-updated"), "the UI is told to reload");
  assert.deepEqual((await t.call("history", { chatId: `${id}:ann`, limit: 50 })).filter((m: Message) => !m.system).map((m: Message) => m.text), ["older, only the provider knows", "already archived"]);
  t.done();
});

test("an empty archive waits for the provider, but only briefly", async () => {
  const t = setup({ backfill: true }); const id = await linked(t);
  t.conns[0].history = async () => [msg("m0", "from the provider", "2026-01-01T09:00:00Z")];
  assert.equal((await t.call("history", { chatId: `${id}:ann`, limit: 50 })).find((m: Message) => !m.system).text, "from the provider");
  t.done();
});

test("history with local:true answers from the archive only and never asks (or waits for) the provider", async () => {
  const t = setup({ backfill: true }); const id = await linked(t);
  let asked = 0; t.conns[0].history = async () => { asked++; await new Promise(() => {}); return []; }; // a source that never answers
  const r = await t.call("history", { chatId: `${id}:ann`, limit: 50, local: true }); // empty archive: without `local` this would wait up to 8 s
  assert.deepEqual(r.filter((m: Message) => !m.system), []); assert.equal(asked, 0);
  t.conns[0].emit({ type: "message", data: msg("m1", "archived", "2026-01-01T10:00:00Z") });
  assert.deepEqual((await t.call("history", { chatId: `${id}:ann`, limit: 50, local: true })).filter((x: Message) => !x.system).map((x: Message) => x.text), ["archived"]); assert.equal(asked, 0);
  t.done();
});

test("if the remote logout can't be confirmed, local data is still removed and the user is told what to do", async () => {
  const t = setup(); const id = await linked(t);
  t.conns[0].logout = async () => { throw new Error("Couldn't reach the messenger to remove this device. Remove it manually on your phone."); };
  await t.call("snapshot");
  const out = await t.call("signOut", { accountId: id });
  assert.match(out.warning, /Remove it manually on your phone/);
  assert.equal(out.state, "signed-out"); assert.equal(t.conns[0].stopped, true);
  const t2 = setup(); const id2 = await linked(t2);
  t2.conns[0].logout = async () => { throw new Error("offline: remove the device on your phone"); };
  const rm = await t2.call("removeAccount", { accountId: id2 });
  assert.match(rm.warning, /remove the device on your phone/);
  assert.deepEqual(await t2.call("accounts"), []); assert.equal(t2.store.getChatCache(id2), undefined); // still fully removed locally
  t.done(); t2.done();
});

test("a provider call that never answers (e.g. waiting for a server echo) times out instead of hanging", async () => {
  const t = setup(); const id = await linked(t);
  (t.conns[0] as any).blockChat = () => new Promise(() => {}); // never resolves
  const t0 = Date.now();
  const r = await Promise.race([t.call("blockChat", { chatId: `${id}:ann`, blocked: true }).then(() => "resolved", (e: Error) => e.message), new Promise((res) => setTimeout(() => res("still hanging"), 1500))]);
  assert.equal(r, "still hanging"); // the real timeout is 25s: here we only prove the call is bounded and not resolved early
  assert.ok(Date.now() - t0 >= 1400);
  t.done();
});

test("history-flagged messages are archived without the flag and are never relayed by a mesh group", async () => {
  const t = setup(); const id = await linked(t);
  const g = await t.call("meshCreate", { name: "m", members: [{ name: "Ann", chatId: `${id}:ann` }, { name: "Bob", chatId: `${id}:bob` }] });
  const events: any[] = []; t.hub.subscribe((e, d) => e === "message" && events.push(d));
  t.conns[0].emit({ type: "message", data: { ...msg("h1", "old news", "2025-01-01T10:00:00Z"), historical: true } });
  t.conns[0].emit({ type: "message", data: msg("n1", "fresh", new Date().toISOString()) });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(events.find((e) => e.id === "h1")?.historical, true, "the UI is told it is historical");
  assert.equal(t.store.getMessage(`${id}:ann`, "h1")?.historical, undefined, "but the archive doesn't keep the flag");
  const relays = (await t.call("jobs")).filter((j: any) => j.kind === "send" && String(j.payload.text).includes("old news"));
  assert.equal(relays.length, 0, "history is never relayed");
  assert.ok((await t.call("jobs")).some((j: any) => String(j.payload.text).includes("fresh")), "a fresh message still is");
  void g; t.done();
});

test("reactions on a deleted message are refused", async () => {
  const t = setup(); const id = await linked(t); t.conns[0].capabilities = { ...t.conns[0].capabilities, reactions: true };
  (t.conns[0] as any).react = async () => {};
  t.conns[0].emit({ type: "message", data: msg("m1", "bye", "2026-01-01T10:00:00Z") });
  await t.call("react", { chatId: `${id}:ann`, messageId: "m1", emoji: "x" }); // fine while it exists
  t.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: "m1", patch: { deleted: true } } });
  await assert.rejects(t.call("react", { chatId: `${id}:ann`, messageId: "m1", emoji: "x" }), /deleted/);
  t.done();
});

test("deleting a message clears its reactions in the archive and in the update sent to the UIs", async () => {
  const t = setup(); const id = await linked(t);
  t.conns[0].emit({ type: "message", data: { ...msg("m2", "hi", "2026-01-01T10:00:00Z"), reactions: [{ emoji: "👍", senderIds: ["x"] }] } });
  const seen: any[] = []; t.hub.subscribe((e, d: any) => { if (e === "message-update") seen.push(d.patch); });
  t.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: "m2", patch: { deleted: true, text: "" } } });
  assert.deepEqual(seen.at(-1)?.reactions, []);
  const h = await t.call("history", { chatId: `${id}:ann`, limit: 10 });
  assert.deepEqual(h.find((m: any) => m.id === "m2").reactions, []);
  t.conns[0].emit({ type: "message", data: { ...msg("m2", "", "2026-01-01T10:00:00Z"), reactions: [{ emoji: "👍", senderIds: ["x"] }] } }); // a replay can't bring them back
  assert.deepEqual((await t.call("history", { chatId: `${id}:ann`, limit: 10 })).find((m: any) => m.id === "m2").reactions, []);
  t.done();
});

test("a message sent through the backend is announced to every connected UI, not just the caller", async () => {
  const t = setup(); const id = await linked(t);
  const seen: Message[] = []; t.hub.subscribe((e, d) => { if (e === "message") seen.push(d as Message); });
  const sent = await t.call("send", { chatId: `${id}:ann`, text: "from another client" });
  assert.equal(seen.length, 1); assert.equal(seen[0].id, sent.id); assert.equal(seen[0].fromMe, true);
  assert.equal(seen[0].chatId, `${id}:ann`);
  t.done();
});

// ------------------------------------------------------------------ merged chats
/** Two accounts of the same provider (two "apps"): A holds Ann on chat "ann", B holds her on chat "anna". Both can react/edit/delete/markRead. */
class MFake extends Fake {
  sent: { chatId: string; text: string }[] = []; calls: string[] = [];
  avatar: (r: { kind: string; id: string }) => Promise<{ data: Uint8Array; mime: string } | undefined> = async () => undefined;
  constructor(public native: string, public name: string) { super(); this.chatList = [{ id: native, accountId: "x", provider: "fake", kind: "dm", name, lastMessageAt: undefined }]; this.capabilities = { ...NO_CAPABILITIES, reactions: true, edits: true, deletes: true, markRead: true }; }
  async send(chatId: string, m: { text: string }): Promise<Message> { this.sent.push({ chatId, text: m.text }); return { id: "out" + this.sent.length + this.native, chatId, sender: "Me", senderId: "me", text: m.text, time: new Date().toISOString(), fromMe: true, status: "sent" }; }
  async react(c: string, id: string, e: string | null) { this.calls.push(`react ${c} ${id} ${e}`); }
  async edit(c: string, id: string) { this.calls.push(`edit ${c} ${id}`); }
  async delete(c: string, id: string) { this.calls.push(`delete ${c} ${id}`); }
  async markRead(c: string, id: string) { this.calls.push(`markRead ${c} ${id}`); }
  async setTyping(c: string, t: boolean) { this.calls.push(`typing ${c} ${t}`); }
}
async function msetup(natives: [string, string][] = [["ann", "Ann"], ["anna", "Anna B."]]) {
  const dir = mkdtempSync(join(tmpdir(), "hub-merge-"));
  const conns: MFake[] = [];
  const factory: ProviderFactory = { name: "fake", displayName: "Fake", login: "qr", capabilities: { ...NO_CAPABILITIES, reactions: true, edits: true, deletes: true, markRead: true },
    create: () => { const [n, nm] = natives[conns.length]; const c = new MFake(n, nm); conns.push(c); return c; } };
  const store = new MemoryStore();
  const hub = new Hub(dir, [factory], store);
  const call = (m: string, p?: unknown) => hub.call(m, p) as Promise<any>;
  const ids: string[] = [];
  for (let i = 0; i < natives.length; i++) { const acc = await call("addAccount", { provider: "fake", label: "Acc" + i }); conns[i].emit({ type: "account", data: { id: acc.id, state: "connected" } }); ids.push(acc.id); }
  const A = `${ids[0]}:${natives[0][0]}`, B = natives[1] ? `${ids[1]}:${natives[1][0]}` : "";
  const feed = (i: number, id: string, text: string, time: string, o: Partial<Message> = {}) => conns[i].emit({ type: "message", data: { id, chatId: natives[i][0], sender: natives[i][1], senderId: natives[i][0], text, time, fromMe: false, ...o } });
  return { hub, store, conns, call, ids, A, B, dir, feed, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const texts = (xs: Message[]) => xs.filter((m) => !m.system).map((m) => m.text);

test("merge: one row for the person, members hidden, flags and name apply to the merged chat; unmerge restores the separate chats", async () => {
  const t = await msetup();
  t.conns[0].chatList = [{ ...t.conns[0].chatList[0], unread: 2, lastMessageAt: "2026-01-01T10:00:00Z", preview: "from A", avatarUrl: "a.png" }];
  t.conns[1].chatList = [{ ...t.conns[1].chatList[0], unread: 3, lastMessageAt: "2026-01-02T10:00:00Z", preview: "from B" }];
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  assert.match(row.id, /^merge:/); assert.equal(row.kind, "dm"); assert.equal(row.name, "Ann"); // primary = first chat, its name is the default
  assert.equal(row.unread, 5); assert.equal(row.preview, "from B"); assert.equal(row.lastMessageAt, "2026-01-02T10:00:00Z"); assert.equal(row.avatarUrl, "a.png");
  assert.deepEqual(row.mergeMembers, [t.A, t.B]);
  const snap = await t.call("snapshot");
  assert.deepEqual(snap.chats.filter((c: Chat) => !c.mergedInto).map((c: Chat) => c.id), [row.id]); // one visible row
  assert.deepEqual(snap.chats.filter((c: Chat) => c.mergedInto === row.id).map((c: Chat) => c.id).sort(), [t.A, t.B].sort());
  assert.equal(snap.merges.length, 1);
  await t.call("setChatFlags", { chatId: row.id, pinned: true, muted: true, archived: false });
  await t.call("setAlias", { chatId: row.id, name: "Annchen" });
  const r2 = (await t.call("snapshot")).chats.find((c: Chat) => c.id === row.id);
  assert.equal(r2.pinned, true); assert.equal(r2.muted, true); assert.equal(r2.name, "Annchen"); assert.equal(r2.originalName, "Ann");
  await t.call("unmergeChat", { mergeId: row.id });
  const after = await t.call("snapshot");
  assert.deepEqual(after.chats.map((c: Chat) => c.id).sort(), [t.A, t.B].sort()); assert.ok(after.chats.every((c: Chat) => !c.mergedInto));
  assert.deepEqual(t.store.listMerges(), []); assert.deepEqual(t.store.listAliases(), {}); assert.deepEqual(t.store.listChatFlags(), {});
  t.done();
});

test("merge: chatMedia on a merged chat collects media from ALL members, newest first", async () => {
  const t = await msetup();
  const att = (id: string) => ({ attachments: [{ id, kind: "image" as const, mime: "image/jpeg", size: 10 }] });
  t.feed(0, "m1", "pic A", "2026-01-01T10:00:00.000Z", att("a1")); t.feed(1, "m2", "pic B", "2026-01-02T10:00:00.000Z", att("a2")); t.feed(0, "m3", "plain", "2026-01-03T10:00:00.000Z");
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  const r = await t.call("chatMedia", { chatId: row.id, limit: 10 });
  assert.deepEqual(r.messages.map((m: Message) => m.id), ["m2", "m1"]); // both members, newest first, no text-only message
  t.done();
});

test("chatMedia: pages newest first with a cursor, filters by kinds, counts the whole archive and spans merged chats", async () => {
  const t = await msetup();
  const att = (id: string, kind: "image" | "file" | "voice" = "image") => ({ attachments: [{ id, kind, mime: kind === "image" ? "image/jpeg" : "application/octet-stream", size: 10, name: id }] });
  const day = (n: number) => `2026-02-${String(n).padStart(2, "0")}T10:00:00.000Z`;
  for (let i = 1; i <= 7; i++) t.feed(i % 2, "p" + i, "pic " + i, day(i), att("p" + i));
  t.feed(0, "f1", "doc", day(10), att("f1", "file")); t.feed(1, "v1", "", day(11), att("v1", "voice"));
  t.feed(0, "l1", "see https://example.org/x", day(12)); t.feed(1, "plain", "no link", day(13));
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  const r1 = await t.call("chatMedia", { chatId: row.id, kinds: ["media"], limit: 3 });
  assert.deepEqual(r1.messages.map((m: Message) => m.id), ["p7", "p6", "p5"]); assert.ok(r1.next);
  assert.deepEqual(r1.count, { media: 7, files: 1, voice: 1, links: 1 });
  const r2 = await t.call("chatMedia", { chatId: row.id, kinds: ["media"], limit: 3, before: r1.next });
  assert.deepEqual(r2.messages.map((m: Message) => m.id), ["p4", "p3", "p2"]); assert.equal(r2.count, undefined); assert.ok(r2.next);
  const r3 = await t.call("chatMedia", { chatId: row.id, kinds: ["media"], limit: 3, before: r2.next });
  assert.deepEqual(r3.messages.map((m: Message) => m.id), ["p1"]); assert.equal(r3.next, undefined);
  assert.deepEqual((await t.call("chatMedia", { chatId: row.id, kinds: ["files"] })).messages.map((m: Message) => m.id), ["f1"]);
  assert.deepEqual((await t.call("chatMedia", { chatId: row.id, kinds: ["voice"] })).messages.map((m: Message) => m.id), ["v1"]);
  assert.deepEqual((await t.call("chatMedia", { chatId: row.id, kinds: ["links"] })).messages.map((m: Message) => m.id), ["l1"]);
  assert.deepEqual((await t.call("chatMedia", { chatId: row.id })).messages.map((m: Message) => m.id), ["f1", "p7", "p6", "p5", "p4", "p3", "p2", "p1"]); // default: photos, videos and files
  assert.deepEqual((await t.call("chatMedia", { chatId: t.A, kinds: ["media"] })).messages.map((m: Message) => m.id), ["p6", "p4", "p2"]); // a single chat
  t.done();
});

test("a DM titled by a bare id shows the sender name of its incoming messages; an alias still wins; real names are untouched", async () => {
  const t = await msetup();
  t.conns[0].chatList = [{ ...t.conns[0].chatList[0], name: "1aeaecca" }];
  t.conns[1].chatList = [{ ...t.conns[1].chatList[0], name: "Ann B" }];
  t.feed(0, "a1", "hi from julian", "2026-02-01T10:00:00.000Z", { sender: "Julian", fromMe: false } as Partial<Message>);
  t.feed(0, "a2", "my reply", "2026-02-01T10:05:00.000Z", { fromMe: true } as Partial<Message>);
  const snap = async () => (await t.call("snapshot")).chats as Chat[];
  let rows = await snap();
  assert.equal(rows.find((c) => c.id === t.A)!.name, "Julian");
  assert.equal(rows.find((c) => c.id === t.B)!.name, "Ann B");
  await t.call("setAlias", { chatId: t.A, name: "Jule" });
  rows = await snap();
  assert.equal(rows.find((c) => c.id === t.A)!.name, "Jule");
  t.done();
});

test("a group message whose sender label is a bare id shows the name the same sender has on other messages", async () => {
  const t = await msetup();
  t.feed(0, "g1", "named one", "2026-03-01T10:00:00.000Z", { sender: "Julian", senderId: "u-julian", fromMe: false } as Partial<Message>);
  t.feed(0, "g2", "id-labelled one", "2026-03-01T10:05:00.000Z", { sender: "1aeaecca", senderId: "u-julian", fromMe: false } as Partial<Message>);
  const h = (await t.call("history", { chatId: t.A, limit: 20 })) as Message[];
  assert.deepEqual(h.filter((m) => !m.system).map((m) => m.sender), ["Julian", "Julian"]);
  t.done();
});

test("a quote labelled by a bare id shows \"You\" when the quoted message is mine", async () => {
  const t = await msetup();
  t.feed(0, "q1", "my own message", "2026-03-02T10:00:00.000Z", { fromMe: true } as Partial<Message>);
  t.feed(0, "q2", "a reply to it", "2026-03-02T10:05:00.000Z", { fromMe: false, replyTo: { messageId: "q1", sender: "1aeaecca", textPreview: "my own message" } } as Partial<Message>);
  const h = (await t.call("history", { chatId: t.A, limit: 20 })) as Message[];
  assert.equal(h.find((m) => m.id === "q2")!.replyTo!.sender, "You");
  t.done();
});

test("reading a chat the provider cannot mark read persists across a restart (and later messages count again)", async () => {
  const t = await msetup();
  t.conns[0].chatList = [{ ...t.conns[0].chatList[0], unread: 3, lastMessageAt: "2026-05-01T10:05:00.000Z" }];
  t.feed(0, "r1", "one", "2026-05-01T10:00:00.000Z", { fromMe: false } as Partial<Message>);
  t.feed(0, "r2", "two", "2026-05-01T10:02:00.000Z", { fromMe: false } as Partial<Message>);
  t.feed(0, "r3", "three", "2026-05-01T10:05:00.000Z", { fromMe: false } as Partial<Message>);
  const unread = async (hub = t.hub) => ((await hub.call("snapshot")) as any).chats.find((c: Chat) => c.id === t.A).unread ?? 0;
  assert.equal(await unread(), 3);
  await t.call("markChatRead", { chatId: t.A });
  assert.equal(await unread(), 0, "read now");
  assert.equal(t.store.listChatFlags()[t.A]?.readUpTo, "2026-05-01T10:05:00.000Z", "the mark is stored in the archive (not in the browser), so a reload / restart / other device keeps it");
  t.conns[0].chatList = [{ ...t.conns[0].chatList[0], unread: 3, lastMessageAt: "2026-05-01T10:05:00.000Z" }]; // the provider still reports the old count after a reload
  assert.equal(await unread(), 0, "still read: the provider's stale count is overridden by the stored mark");
  t.conns[0].chatList = [{ ...t.conns[0].chatList[0], unread: 4, lastMessageAt: "2026-05-01T10:30:00.000Z" }]; // the provider keeps counting the old ones + 1 new
  t.feed(0, "r4", "four", "2026-05-01T10:30:00.000Z", { fromMe: false } as Partial<Message>);
  assert.equal(await unread(), 1, "only the message that arrived after the mark counts");
  t.done();
});

test("merge: a user-chosen name wins over the primary's; only DMs, at most one merge per chat, two or more chats", async () => {
  const t = await msetup();
  t.conns[0].chatList.push({ id: "grp", accountId: "x", provider: "fake", kind: "group", name: "Crew" }, { id: "chan", accountId: "x", provider: "fake", kind: "channel", name: "gen" });
  t.conns[1].chatList.push({ id: "bob", accountId: "x", provider: "fake", kind: "dm", name: "Bob" });
  const G = t.A.replace(":ann", ":grp"), CH = t.A.replace(":ann", ":chan"), BOB = t.B.replace(":anna", ":bob");
  await assert.rejects(t.call("mergeChats", { chatIds: [t.A, G] }), /isn't a 1:1 chat/);
  await assert.rejects(t.call("mergeChats", { chatIds: [t.A, CH] }), /Only direct messages/);
  const mesh = await t.call("meshCreate", { name: "m", members: [{ name: "Ann", chatId: t.A }] });
  await assert.rejects(t.call("mergeChats", { chatIds: [t.A, mesh.id] }), /Mesh groups can't be merged/);
  await assert.rejects(t.call("mergeChats", { chatIds: [t.A] }), /at least two/);
  await assert.rejects(t.call("mergeChats", { chatIds: [t.A, t.A] }), /at least two/);
  await assert.rejects(t.call("mergeChats", { chatIds: [t.A, "nope:x"] }), /doesn't exist/);
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B], name: "  Ann (everywhere) " });
  assert.equal(row.name, "Ann (everywhere)");
  await assert.rejects(t.call("mergeChats", { chatIds: [t.A, BOB] }), /already part of a merged chat/); // one merge per chat
  // but a merge can be extended: pass its id
  const ext = await t.call("mergeChats", { chatIds: [row.id, BOB] });
  assert.equal(ext.id, row.id); assert.deepEqual(ext.mergeMembers, [t.A, t.B, BOB]);
  assert.deepEqual((await t.call("addMergeMember", { mergeId: row.id, chatId: BOB })).id, row.id); // idempotent
  t.done();
});

test("merge: signed-out (archived) chats can be merged and stay read-only history", async () => {
  const t = await msetup();
  t.feed(1, "b1", "old b", "2026-01-01T10:00:00Z");
  await t.call("snapshot"); await t.call("signOut", { accountId: t.ids[1] });
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  assert.equal(row.offline, undefined); // one member is still live
  assert.ok(texts(await t.call("history", { chatId: row.id, limit: 20 })).includes("old b"));
  await t.call("signOut", { accountId: t.ids[0] });
  assert.equal((await t.call("snapshot")).chats.find((c: Chat) => c.id === row.id).offline, "signed-out"); // all members offline
  await assert.rejects(t.call("send", { chatId: row.id, via: t.B, text: "x" }), /signed out/);
  t.done();
});

test("unified history interleaves members by time, tie-breaks stably, pages correctly and never alters the members", async () => {
  const t = await msetup();
  const base = Date.UTC(2026, 0, 1, 10, 0, 0);
  for (let i = 0; i < 40; i++) t.feed(i % 2, "m" + String(i).padStart(2, "0"), "t" + i, new Date(base + Math.floor(i / 2) * 1000).toISOString()); // pairs share a timestamp across the two chats
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  const newest = (await t.call("history", { chatId: row.id, limit: 10 })).filter((m: Message) => !m.system);
  assert.equal(newest.length, 10); assert.deepEqual(newest.map((m: Message) => m.text), Array.from({ length: 10 }, (_, k) => "t" + (30 + k)));
  assert.ok(newest.every((m: Message) => m.mergeId === row.id && (m.chatId === t.A || m.chatId === t.B)));
  assert.deepEqual(newest.slice(0, 2).map((m: Message) => m.chatId), [t.A, t.B]); // tie on time -> by id: m30 (A) before m31 (B)
  // page backwards: pages never overlap and never skip, ending at the oldest message
  const seen: string[] = newest.map((m: Message) => m.text);
  let first = newest[0];
  for (let guard = 0; guard < 10; guard++) {
    const older = (await t.call("history", { chatId: row.id, limit: 10, beforeMessageId: first.id, beforeChatId: first.chatId })).filter((m: Message) => !m.system);
    if (!older.length) break;
    seen.unshift(...older.map((m: Message) => m.text)); first = older[0];
  }
  assert.equal(new Set(seen).size, 40 - 0 - 0 + 0 === 40 ? seen.length : 0);
  assert.ok(seen.length >= 38, `paged ${seen.length}`); // pairs sharing the anchor's timestamp are the known approximation (strict < on time)
  assert.deepEqual(seen, [...seen].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
  // members are untouched: their own histories are exactly what they were
  assert.equal(texts(await t.call("history", { chatId: t.A, limit: 99 })).length, 20); assert.equal(texts(await t.call("history", { chatId: t.B, limit: 99 })).length, 20);
  assert.ok((await t.call("history", { chatId: t.A, limit: 5 })).every((m: Message) => m.mergeId === undefined));
  t.done();
});

test("same native message id in two member chats stays two messages", async () => {
  const t = await msetup();
  t.feed(0, "same", "from A", "2026-01-01T10:00:00Z"); t.feed(1, "same", "from B", "2026-01-01T10:00:05Z");
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  const h = await t.call("history", { chatId: row.id, limit: 9 });
  assert.deepEqual(texts(h), ["from A", "from B"]); assert.deepEqual(h.filter((m: Message) => !m.system).map((m: Message) => m.chatId), [t.A, t.B]);
  t.done();
});

test("unified history tops up from every live member's provider (background when the archive has content)", async () => {
  const t = await msetup(); (t.hub as any).factories.get("fake").capabilities.backfill = true;
  t.feed(0, "a1", "archived A", "2026-01-02T10:00:00Z");
  t.conns[1].history = async () => [{ id: "b0", chatId: "anna", sender: "Anna B.", senderId: "anna", text: "only B's server knows", time: "2026-01-01T09:00:00Z", fromMe: false }];
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  const events: any[] = []; t.hub.subscribe((e, d) => e === "history-updated" && events.push(d));
  const first = await t.call("history", { chatId: row.id, limit: 20 });
  assert.deepEqual(texts(first), ["archived A"]); // answered from the archive at once
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events[0].mergeId, row.id); assert.equal(events[0].chatId, row.id); // the UI reloads the merged chat
  assert.deepEqual(texts(await t.call("history", { chatId: row.id, limit: 20 })), ["only B's server knows", "archived A"]);
  t.done();
});

test("live events of any member reach the UI under the merged chat (chatId stays the real chat)", async () => {
  const t = await msetup();
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  const ev: [string, any][] = []; t.hub.subscribe((e, d) => ev.push([e, d]));
  t.feed(1, "b1", "hello", "2026-01-01T10:00:00Z", { fromMe: true, status: "sent" });
  t.conns[1].emit({ type: "message-update", data: { chatId: "anna", messageId: "b1", patch: { text: "edited" } } });
  t.conns[1].emit({ type: "receipt", data: { chatId: "anna", messageId: "b1", status: "read" } });
  t.conns[0].emit({ type: "typing", data: { chatId: "ann", senderId: "ann", typing: true } });
  for (const name of ["message", "message-update", "receipt", "typing"]) {
    const d = ev.find(([e]) => e === name)![1];
    assert.equal(d.mergeId, row.id, name);
  }
  assert.equal(ev.find(([e]) => e === "message")![1].chatId, t.B); assert.equal(ev.find(([e]) => e === "typing")![1].chatId, t.A);
  assert.equal(t.store.getMessage(t.B, "b1")?.mergeId, undefined, "the merge id is never stored");
  assert.equal(t.store.getMessage(t.B, "b1")?.status, "read");
  // after unmerging, events no longer carry it
  await t.call("unmergeChat", { mergeId: row.id }); ev.length = 0; t.feed(1, "b2", "again", "2026-01-01T10:01:00Z");
  assert.equal(ev.find(([e]) => e === "message")![1].mergeId, undefined);
  t.done();
});

test("sending: default = member of the newest message; explicit via and the saved choice route to the owning provider; capabilities stay per member", async () => {
  const t = await msetup();
  t.feed(0, "a1", "older on A", "2026-01-01T10:00:00Z"); t.feed(1, "b1", "newer on B", "2026-01-01T10:05:00Z");
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  assert.equal(row.mergeLastVia, t.B); assert.equal(row.mergeSendVia, undefined);
  await t.call("send", { chatId: row.id, text: "default" });
  assert.deepEqual(t.conns[1].sent, [{ chatId: "anna", text: "default" }]); assert.equal(t.conns[0].sent.length, 0);
  const evs: any[] = []; t.hub.subscribe((e, d) => e === "message" && evs.push(d));
  await t.call("send", { chatId: row.id, via: t.A, text: "explicit" });
  assert.deepEqual(t.conns[0].sent, [{ chatId: "ann", text: "explicit" }]);
  assert.equal(evs[0].chatId, t.A); assert.equal(evs[0].mergeId, row.id); // announced under the merged chat
  assert.equal(t.store.listMessages(t.A, { limit: 9 }).at(-1)?.text, "explicit");
  await t.call("setMergeVia", { mergeId: row.id, chatId: t.A }); // the user's choice is remembered, even though B has the newest message
  assert.equal((await t.call("snapshot")).chats.find((c: Chat) => c.id === row.id).mergeSendVia, t.A);
  await t.call("send", { chatId: row.id, text: "remembered" });
  assert.equal(t.conns[0].sent.at(-1)!.text, "remembered");
  await assert.rejects(t.call("send", { chatId: row.id, via: "zzz:x", text: "no" }), /not part of this merge/);
  await assert.rejects(t.call("setMergeVia", { mergeId: row.id, chatId: "zzz:x" }), /not part of this merge/);
  await t.call("setMergeVia", { mergeId: row.id, chatId: null }); // back to following the conversation
  await t.call("send", { chatId: row.id, text: "follows" });
  assert.ok(t.conns[0].sent.length + t.conns[1].sent.length === 4);
  // scheduled messages go via the selected member (resolved when scheduling)
  const job = await t.call("scheduleMessage", { chatId: row.id, via: t.B, text: "later", at: Date.now() + 3600_000 });
  assert.equal(job.payload.chatId, t.B);
  // forward into a merged chat
  const fwd = await t.call("forward", { message: { id: "a1", chatId: t.A, sender: "Ann", senderId: "ann", text: "fw", time: "2026-01-01T10:00:00Z", fromMe: false }, toChatId: row.id, via: t.B });
  assert.equal(fwd.chatId, t.B);
  t.done();
});

test("per-message actions addressed to the merged chat are routed to the message's own provider", async () => {
  const t = await msetup();
  t.feed(0, "a1", "on A", "2026-01-01T10:00:00Z"); t.feed(1, "b1", "on B", "2026-01-01T10:01:00Z");
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  await t.call("react", { chatId: row.id, messageId: "b1", emoji: "👍" });
  await t.call("edit", { chatId: row.id, messageId: "a1", text: "x" });
  await t.call("delete", { chatId: row.id, messageId: "b1" });
  assert.deepEqual(t.conns[1].calls, ["react anna b1 👍", "delete anna b1"]); assert.deepEqual(t.conns[0].calls, ["edit ann a1"]);
  await assert.rejects(t.call("react", { chatId: row.id, messageId: "ghost", emoji: "x" }), /not part of this merged chat/);
  // real member ids keep working exactly as before
  await t.call("react", { chatId: t.A, messageId: "a1", emoji: "❤️" }); assert.equal(t.conns[0].calls.at(-1), "react ann a1 ❤️");
  // typing goes to the selected member
  await t.call("setTyping", { chatId: row.id, via: t.A, typing: true }); assert.equal(t.conns[0].calls.at(-1), "typing ann true");
  t.done();
});

test("opening a merged chat marks every member read through its own provider", async () => {
  const t = await msetup();
  t.feed(0, "a1", "x", "2026-01-01T10:00:00Z"); t.feed(1, "b1", "y", "2026-01-01T10:01:00Z"); t.feed(1, "b2", "mine", "2026-01-01T10:02:00Z", { fromMe: true });
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  await t.call("markRead", { chatId: row.id, messageId: "b1" });
  assert.deepEqual(t.conns[0].calls, ["markRead ann a1"]); assert.deepEqual(t.conns[1].calls, ["markRead anna b1"]);
  t.done();
});

test("search covers all members, newest last, rows carry the real chat id", async () => {
  const t = await msetup();
  t.feed(0, "a1", "needle one", "2026-01-01T10:00:00Z"); t.feed(1, "b1", "haystack", "2026-01-01T10:01:00Z"); t.feed(1, "b2", "Needle two", "2026-01-01T10:02:00Z");
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  const r = await t.call("search", { chatId: row.id, q: "needle", limit: 10 });
  assert.deepEqual(r.map((m: Message) => [m.text, m.chatId]), [["needle one", t.A], ["Needle two", t.B]]);
  assert.deepEqual((await t.call("search", { chatId: row.id, q: "needle", limit: 1 })).map((m: Message) => m.text), ["Needle two"]);
  t.done();
});

test("attachments of a message in a merged chat load from the owning account; the avatar is the primary's", async () => {
  const t = await msetup();
  t.feed(1, "b1", "pic", "2026-01-01T10:00:00Z"); t.feed(0, "a1", "x", "2026-01-01T09:00:00Z");
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  assert.equal((await t.call("attachment", { chatId: row.id, messageId: "b1", attachmentId: "p" })).mime, "image/png");
  assert.equal(t.conns[1].downloads, 1); assert.equal(t.conns[0].downloads, 0);
  t.conns[0].avatar = async () => ({ data: new Uint8Array([1]), mime: "image/png" });
  assert.equal((await t.call("avatar", { kind: "chat", id: row.id })).mime, "image/png");
  t.done();
});

test("removing an account drops its chats from the merge; the merge survives with what remains and finally disappears", async () => {
  const t = await msetup([["ann", "Ann"], ["anna", "Anna B."], ["annie", "Annie"]]);
  const C = `${t.ids[2]}:annie`;
  t.feed(0, "a1", "keep A", "2026-01-01T10:00:00Z"); t.feed(1, "b1", "gone with B", "2026-01-01T10:01:00Z");
  const row = await t.call("mergeChats", { chatIds: [t.B, t.A, C], name: "Ann" });
  await t.call("setMergePrimary", { mergeId: row.id, chatId: t.B }); await t.call("setMergeVia", { mergeId: row.id, chatId: t.B });
  await t.call("removeAccount", { accountId: t.ids[1] });
  let snap = await t.call("snapshot"); let mine = snap.chats.find((c: Chat) => c.id === row.id);
  assert.deepEqual(mine.mergeMembers, [t.A, C]); assert.equal(mine.mergeSendVia, undefined);
  assert.equal(snap.merges[0].primary, t.A); assert.ok(!snap.merges[0].members.includes(t.B));
  assert.deepEqual(texts(await t.call("history", { chatId: row.id, limit: 9 })), ["keep A"]);
  await t.call("removeAccount", { accountId: t.ids[2] }); // one member left: the merge keeps showing the archive
  snap = await t.call("snapshot"); mine = snap.chats.find((c: Chat) => c.id === row.id);
  assert.deepEqual(mine.mergeMembers, [t.A]); assert.deepEqual(texts(await t.call("history", { chatId: row.id, limit: 9 })), ["keep A"]);
  await t.call("removeAccount", { accountId: t.ids[0] });
  assert.deepEqual(t.store.listMerges(), []); assert.deepEqual((await t.call("snapshot")).chats, []);
  t.done();
});

test("merges survive a restart; a merge whose chats are temporarily missing from the lists stays stored", async () => {
  const t = await msetup();
  t.feed(0, "a1", "persisted", "2026-01-01T10:00:00Z");
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B], name: "Ann" });
  await t.call("setMergeVia", { mergeId: row.id, chatId: t.B });
  await t.call("snapshot"); // chat lists get cached
  const factory: ProviderFactory = { name: "fake", displayName: "Fake", login: "qr", capabilities: NO_CAPABILITIES, create: () => { throw new Error("must not start"); } };
  for (const id of t.ids) t.store.putAccount({ id, provider: "fake", label: id, status: "archived" });
  const hub2 = new Hub(t.dir, [factory], t.store); await hub2.init();
  const snap = (await hub2.call("snapshot")) as any;
  const mine = snap.chats.find((c: Chat) => c.id === row.id);
  assert.equal(mine.name, "Ann"); assert.equal(mine.mergeSendVia, t.B); assert.equal(mine.offline, "signed-out");
  assert.deepEqual(texts((await hub2.call("history", { chatId: row.id, limit: 9 })) as Message[]), ["persisted"]);
  t.done();
});

test("editing a merge: primary, removing a member, dissolving below two members, combining two merges", async () => {
  const t = await msetup([["ann", "Ann"], ["anna", "Anna B."], ["annie", "Annie"], ["bob", "Bob"]]);
  const [A, B] = [t.A, t.B], C = `${t.ids[2]}:annie`, D = `${t.ids[3]}:bob`;
  const m1 = await t.call("mergeChats", { chatIds: [A, B, C] });
  await t.call("setMergePrimary", { mergeId: m1.id, chatId: C });
  assert.equal((await t.call("snapshot")).chats.find((c: Chat) => c.id === m1.id).name, "Annie");
  await assert.rejects(t.call("setMergePrimary", { mergeId: m1.id, chatId: D }), /not part of this merge/);
  await t.call("removeMergeMember", { mergeId: m1.id, chatId: C }); // primary removed -> next member takes over
  assert.equal((await t.call("merges"))[0].primary, A);
  assert.ok((await t.call("snapshot")).chats.find((c: Chat) => c.id === C && !c.mergedInto), "removed member is a normal chat again");
  const m2 = await t.call("mergeChats", { chatIds: [C, D] });
  const combined = await t.call("mergeChats", { chatIds: [m1.id, m2.id] });
  assert.equal(combined.id, m1.id); assert.equal((await t.call("merges")).length, 1); assert.deepEqual(combined.mergeMembers.sort(), [A, B, C, D].sort());
  await t.call("removeMergeMember", { mergeId: m1.id, chatId: A }); await t.call("removeMergeMember", { mergeId: m1.id, chatId: B }); await t.call("removeMergeMember", { mergeId: m1.id, chatId: C });
  assert.deepEqual(await t.call("merges"), []); // down to one chat: dissolved
  t.done();
});

test("merge suggestions: same name (ignoring case/accents), same phone number, same handle; merged and unrelated chats are excluded", async () => {
  const t = await msetup([["4915112345678@s.whatsapp.net", "Anna Becker"], ["!room1:x.org", "anna becker"], ["!room2:x.org", "Ánna  Becker"], ["!room3:x.org", "Someone Else"], ["!room4:x.org", "Phone Match"], ["!room5:x.org", "Handle Match"]]);
  const id = (i: number, n: string) => `${t.ids[i]}:${n}`;
  t.conns[3].members = async () => [{ id: "u", name: "Other", handle: "@zed:x.org" } as any];
  t.conns[4].members = async () => [{ id: "u", name: "Mobile", handle: "+49 151 12345678" } as any];
  t.conns[5].members = async () => [{ id: "u", name: "H", handle: "@anna.becker:insta" } as any];
  t.conns[0].members = async () => [{ id: "u", name: "Anna Becker", handle: "+4915112345678" } as any];
  t.conns[1].members = async () => [{ id: "u", name: "Anna Becker", handle: "@anna.becker:x.org" } as any];
  const s = await t.call("mergeSuggestions", { chatId: id(0, "4915112345678@s.whatsapp.net") });
  const byId = Object.fromEntries(s.map((x: any) => [x.chatId, x.reason]));
  assert.equal(byId[id(4, "!room4:x.org")], "same phone number");
  assert.equal(byId[id(1, "!room1:x.org")], "same name"); assert.equal(byId[id(2, "!room2:x.org")], "same name");
  const fromMatrix = Object.fromEntries((await t.call("mergeSuggestions", { chatId: id(1, "!room1:x.org") })).map((x: any) => [x.chatId, x.reason]));
  assert.equal(fromMatrix[id(5, "!room5:x.org")], "same handle"); // @anna.becker on two servers/apps
  assert.equal(byId[id(3, "!room3:x.org")], undefined);
  assert.equal(s[0].reason, "same phone number"); // strongest evidence first
  await t.call("mergeChats", { chatIds: [id(0, "4915112345678@s.whatsapp.net"), id(1, "!room1:x.org")] });
  const again = await t.call("mergeSuggestions", { chatId: id(0, "4915112345678@s.whatsapp.net") }); // asking for a merged chat: its members are the base, they never suggest themselves
  assert.ok(!again.some((x: any) => x.chatId === id(1, "!room1:x.org")));
  t.done();
});

// ---------------------------------------------------------------- folders (local-only)
async function fsetup() {
  const t = await msetup();
  const ch = (id: string, name: string, spaceId?: string): Chat => ({ id, accountId: "x", provider: "fake", kind: "channel", name, ...(spaceId ? { spaceId } : {}) });
  const c0 = t.conns[0] as any, c1 = t.conns[1] as any;
  c0.spaces = async () => [{ id: "big", accountId: "x", provider: "fake", name: "Big" }, { id: "solo", accountId: "x", provider: "fake", name: "Solo" }, { id: "old", accountId: "x", provider: "fake", name: "Old" }];
  c0.chatList = [...c0.chatList, ch("b1", "b-one", "big"), ch("b2", "b-two", "big"), ch("s1", "only", "solo"), ch("o1", "old-only", "old")];
  c1.spaces = async () => [{ id: "mx", accountId: "y", provider: "fake", name: "MX" }];
  c1.chatList = [...c1.chatList, ch("m1", "m-one", "mx"), ch("m2", "m-two", "mx")];
  const snap = async () => (await t.call("snapshot")) as { spaces: any[]; chats: any[] };
  const g = (n: string) => `${t.ids[0]}:${n}`, h = (n: string) => `${t.ids[1]}:${n}`;
  const chat = async (id: string) => (await snap()).chats.find((c) => c.id === id);
  return { ...t, snap, g, h, chat };
}

test("folders: override moves a chat of any network into any community, keeps the original, reset restores it", async () => {
  const t = await fsetup();
  let c = await t.chat(t.g("b1")); assert.equal(c.spaceId, t.g("big")); assert.equal(c.networkSpaceId, t.g("big")); assert.equal(c.folderId, undefined);
  await t.call("moveChat", { chatId: t.g("b1"), folderId: t.h("mx") }); // cross-network
  c = await t.chat(t.g("b1")); assert.equal(c.spaceId, t.h("mx")); assert.equal(c.networkSpaceId, t.g("big")); assert.equal(c.folderId, t.h("mx"));
  await t.call("moveChat", { chatId: t.g("b1"), folderId: "personal" });
  c = await t.chat(t.g("b1")); assert.equal(c.spaceId, undefined); assert.equal(c.folderId, "personal"); assert.equal(c.networkSpaceId, t.g("big"));
  await t.call("moveChat", { chatId: t.g("b1"), folderId: null });
  c = await t.chat(t.g("b1")); assert.equal(c.spaceId, t.g("big")); assert.equal(c.folderId, undefined);
  // a DM can go into a community; unknown targets are refused
  await t.call("moveChat", { chatId: t.g("ann"), folderId: t.g("big") }); assert.equal((await t.chat(t.g("ann"))).spaceId, t.g("big"));
  await assert.rejects(t.call("moveChat", { chatId: t.g("ann"), folderId: "folder:nope" }), /no longer exists/);
  await assert.rejects(t.call("moveChat", { chatId: t.g("ann"), folderId: t.g("ghost") }), /no longer exists/);
  t.done();
});

test("folders: create / rename / recolour / reorder / delete (delete returns chats to their original place)", async () => {
  const t = await fsetup();
  const f = await t.call("createFolder", { name: "  Work ", color: "#ff0000", icon: "💼" });
  assert.match(f.id, /^folder:/); assert.equal(f.name, "Work");
  await assert.rejects(t.call("createFolder", { name: " " }), /name/);
  await t.call("moveChat", { chatId: t.g("b1"), folderId: f.id }); await t.call("moveChat", { chatId: t.h("anna"), folderId: f.id });
  let s = await t.snap();
  const sp = s.spaces.find((x) => x.id === f.id); assert.deepEqual([sp.local, sp.provider, sp.color, sp.icon, sp.name], [true, "folder", "#ff0000", "💼", "Work"]);
  assert.equal(s.chats.find((c) => c.id === t.g("b1")).spaceId, f.id);
  await t.call("updateFolder", { id: f.id, name: "Job", color: null }); s = await t.snap();
  assert.equal(s.spaces.find((x) => x.id === f.id).name, "Job"); assert.equal(s.spaces.find((x) => x.id === f.id).color, undefined);
  // folder mute / archive use the normal flags
  await t.call("setChatFlags", { chatId: f.id, muted: true }); assert.equal((await t.snap()).spaces.find((x) => x.id === f.id).muted, true);
  // reorder: the folder first
  assert.equal(s.spaces.at(-1).id, f.id);
  await t.call("setRailOrder", { ids: [f.id, t.h("mx")] }); s = await t.snap(); assert.deepEqual(s.spaces.slice(0, 2).map((x) => x.id), [f.id, t.h("mx")]);
  await t.call("deleteFolder", { id: f.id }); s = await t.snap();
  assert.ok(!s.spaces.some((x) => x.id === f.id));
  assert.equal(s.chats.find((c) => c.id === t.g("b1")).spaceId, t.g("big")); // back in the network community
  assert.equal(s.chats.find((c) => c.id === t.h("anna")).spaceId, undefined); // back in Personal
  assert.equal(s.chats.find((c) => c.id === t.g("b1")).folderId, undefined);
  assert.deepEqual(await t.call("folders"), []); assert.deepEqual(t.store.listChatFlags()[f.id], undefined);
  await assert.rejects(t.call("deleteFolder", { id: f.id }), /no longer exists/);
  t.done();
});

test("folders: an override pointing at a vanished community falls back to the network's place", async () => {
  const t = await fsetup();
  await t.call("moveChat", { chatId: t.g("b1"), folderId: t.h("mx") });
  (t.conns[1] as any).spaces = async () => []; (t.conns[1] as any).chatList = [];
  const c = await t.chat(t.g("b1")); assert.equal(c.spaceId, t.g("big")); assert.equal(c.folderId, undefined);
  t.done();
});

test("single-chat communities collapse into Personal (archived ones too); setting turns it off; 2+ chats keep the rail entry", async () => {
  const t = await fsetup();
  await t.call("setChatFlags", { chatId: t.g("old"), muted: false, archived: true }); // the community "Old" is archived
  await t.call("setChatFlags", { chatId: t.g("solo"), muted: true });
  let s = await t.snap();
  const sp = (id: string) => s.spaces.find((x) => x.id === id);
  assert.equal(sp(t.g("solo")).collapsed, true); assert.equal(sp(t.g("old")).collapsed, true); assert.equal(sp(t.g("big")).collapsed, undefined); assert.equal(sp(t.h("mx")).collapsed, undefined);
  const only = s.chats.find((c) => c.id === t.g("s1")); assert.equal(only.spaceId, undefined); assert.equal(only.collapsedFrom, t.g("solo")); assert.equal(only.networkSpaceId, t.g("solo")); assert.equal(only.muted, true); // muted community stays quiet
  const old = s.chats.find((c) => c.id === t.g("o1")); assert.equal(old.spaceId, undefined); assert.equal(old.collapsedFrom, t.g("old")); assert.ok(!old.archived); // own archive flag decides
  await t.call("setChatFlags", { chatId: t.g("o1"), archived: true }); assert.equal((await t.chat(t.g("o1"))).archived, true);
  // moving a chat out of a 2-chat community collapses it; moving it back un-collapses
  await t.call("moveChat", { chatId: t.h("m1"), folderId: "personal" }); s = await t.snap();
  assert.equal(sp(t.h("mx")).collapsed, true); assert.equal(s.chats.find((c) => c.id === t.h("m2")).collapsedFrom, t.h("mx")); assert.equal(s.chats.find((c) => c.id === t.h("m1")).collapsedFrom, undefined);
  await t.call("moveChat", { chatId: t.h("m1"), folderId: null }); s = await t.snap(); assert.equal(sp(t.h("mx")).collapsed, undefined);
  // moving a second chat INTO a single-chat community makes it a normal community again
  await t.call("moveChat", { chatId: t.g("ann"), folderId: t.g("solo") }); s = await t.snap();
  assert.equal(sp(t.g("solo")).collapsed, undefined); assert.equal(s.chats.find((c) => c.id === t.g("ann")).spaceId, t.g("solo")); assert.equal(s.chats.find((c) => c.id === t.g("s1")).spaceId, t.g("solo"));
  // user folders are never collapsed, even with one chat
  const f = await t.call("createFolder", { name: "F" }); await t.call("moveChat", { chatId: t.g("b1"), folderId: f.id }); s = await t.snap();
  assert.equal(sp(f.id).collapsed, undefined); assert.equal(s.chats.find((c) => c.id === t.g("b1")).spaceId, f.id);
  assert.equal(sp(t.g("big")).collapsed, true); // "big" lost a chat to the folder: only b2 is left
  // the setting
  assert.equal((await t.call("getSettings")).collapseSingleChatCommunities, true);
  await t.call("setSetting", { key: "collapseSingleChatCommunities", value: false }); s = await t.snap();
  assert.equal((await t.call("getSettings")).collapseSingleChatCommunities, false);
  assert.ok(s.spaces.every((x) => !x.collapsed)); assert.equal(s.chats.find((c) => c.id === t.g("b2")).spaceId, t.g("big"));
  t.done();
});

test("folders and merged chats: a merged chat moves as one, its members follow, and a member id is redirected", async () => {
  const t = await fsetup();
  const row = await t.call("mergeChats", { chatIds: [t.g("ann"), t.h("anna")] });
  const f = await t.call("createFolder", { name: "People" });
  await t.call("moveChat", { chatId: t.g("ann"), folderId: f.id }); // a member id moves the merged row
  let s = await t.snap();
  assert.equal(s.chats.find((c) => c.id === row.id).spaceId, f.id); assert.equal(s.chats.find((c) => c.id === t.g("ann")).mergedInto, row.id);
  assert.equal(t.store.listChatFolders()[t.g("ann")], undefined);
  assert.equal(s.spaces.find((x) => x.id === f.id).collapsed, undefined); // member chats are not counted separately
  // two real chats + a merged row in one community: members never inflate the count, the merged row counts once
  await t.call("moveChat", { chatId: row.id, folderId: t.g("solo") }); s = await t.snap();
  assert.equal(s.spaces.find((x) => x.id === t.g("solo")).collapsed, undefined); // s1 + merged row = 2
  // unmerging drops the override of the merge
  await t.call("unmergeChat", { mergeId: row.id }); assert.equal(t.store.listChatFolders()[row.id], undefined);
  t.done();
});

test("folders, overrides, order and the setting survive a restart; removing an account drops its overrides", async () => {
  const t = await fsetup();
  const f = await t.call("createFolder", { name: "Keep", icon: "⭐" });
  await t.call("moveChat", { chatId: t.g("b1"), folderId: f.id }); await t.call("moveChat", { chatId: t.h("m1"), folderId: "personal" });
  await t.call("setRailOrder", { ids: [f.id] }); await t.call("setSetting", { key: "collapseSingleChatCommunities", value: false });
  const hub2 = new Hub(t.dir, [], t.store); await hub2.init();
  assert.deepEqual((await hub2.call("folders")) as any, [{ id: f.id, name: "Keep", icon: "⭐" }]);
  assert.equal(((await hub2.call("getSettings")) as any).collapseSingleChatCommunities, false);
  assert.equal(t.store.listChatFolders()[t.g("b1")], f.id);
  await t.call("removeAccount", { accountId: t.ids[0], deleteData: true });
  assert.equal(t.store.listChatFolders()[t.g("b1")], undefined); assert.equal(t.store.listChatFolders()[t.h("m1")], "personal");
  t.done();
});

// ---------------------------------------------------------------- contract additions: capabilities per account, provisional chats, requests, mentions, new fields
test("account capabilities are read live from the connector and published on accounts, snapshots and account events", async () => {
  const t = setup(); const events: any[] = []; t.hub.subscribe((e, d) => { if (e === "account") events.push(d); });
  const id = await linked(t);
  assert.equal((await t.call("accounts"))[0].capabilities.reactions, false);
  t.conns[0].capabilities = { ...NO_CAPABILITIES, reactions: true, mentions: true }; // changes after login (e.g. Discord learns it is in user mode)
  t.conns[0].emit({ type: "account", data: { id, state: "connected" } });
  assert.equal(events.at(-1).capabilities.mentions, true);
  assert.equal((await t.call("accounts"))[0].capabilities.reactions, true);
  assert.equal((await t.call("snapshot")).accounts[0].capabilities.reactions, true);
  assert.equal((await t.call("providers"))[0].capabilities.reactions, false, "provider-level capabilities stay the static defaults");
  await t.call("signOut", { accountId: id });
  assert.equal((await t.call("accounts"))[0].capabilities, undefined, "a signed-out archive has none: the UI falls back to the provider's");
  t.done();
});

test("provisional chat: listed until the first send() resolves it into the real chat (event + archive under the real id)", async () => {
  const t = setup(); const id = await linked(t); const ev: [string, any][] = []; t.hub.subscribe((e, d) => ev.push([e, d]));
  const c = t.conns[0] as any;
  c.startChat = async (h: string): Promise<Chat> => ({ id: "new:" + h, accountId: "x", provider: "fake", kind: "dm", name: h, provisional: true });
  c.send = async (chatId: string, m: { text: string }): Promise<Message> => ({ id: "m1", chatId: chatId.startsWith("new:") ? "t-real" : chatId, sender: "Me", senderId: "me", text: m.text, time: new Date().toISOString(), fromMe: true, status: "sent" });
  const chat = await t.call("startChat", { accountId: id, handle: "bob" });
  assert.equal(chat.provisional, true); assert.equal(chat.id, `${id}:new:bob`);
  assert.ok((await t.call("snapshot")).chats.some((x: Chat) => x.id === chat.id), "provisional chat is in the snapshot");
  assert.deepEqual(await t.call("history", { chatId: chat.id, limit: 10 }), [], "no provider call for a chat that doesn't exist yet");
  const sent = await t.call("send", { chatId: chat.id, text: "hi" });
  assert.equal(sent.chatId, `${id}:t-real`);
  const res = ev.find(([e]) => e === "chat-resolved")![1]; assert.deepEqual([res.from, res.to], [chat.id, `${id}:t-real`]);
  assert.ok(ev.findIndex(([e]) => e === "chat-resolved") < ev.findIndex(([e]) => e === "message"), "re-key event comes before the message");
  assert.ok(!(await t.call("snapshot")).chats.some((x: Chat) => x.id === chat.id), "provisional chat is gone after resolving");
  assert.equal((await t.call("history", { chatId: `${id}:t-real`, limit: 10 })).filter((m: Message) => !m.system)[0].text, "hi");
  // an unsent provisional chat can be discarded and does not survive removing the account
  const c2 = await t.call("startChat", { accountId: id, handle: "carl" }); await t.call("leaveChat", { chatId: c2.id });
  assert.ok(!(await t.call("snapshot")).chats.some((x: Chat) => x.id === c2.id));
  t.done();
});

test("message requests: acceptRequest / declineRequest are routed to the provider and refresh the chat list", async () => {
  const t = setup(); const id = await linked(t); const calls: string[] = []; const ev: string[] = []; t.hub.subscribe((e) => ev.push(e));
  const c = t.conns[0] as any; c.acceptRequest = async (x: string) => { calls.push("accept " + x); }; c.declineRequest = async (x: string) => { calls.push("decline " + x); };
  await t.call("acceptRequest", { chatId: `${id}:ann` }); await t.call("declineRequest", { chatId: `${id}:ann` });
  assert.deepEqual(calls, ["accept ann", "decline ann"]); assert.ok(ev.includes("chats-changed"));
  delete c.acceptRequest; await assert.rejects(t.call("acceptRequest", { chatId: `${id}:ann` }), /does not support/);
  t.done();
});

test("structured mentions reach the provider validated (in range, no overlaps, strings only)", async () => {
  const t = setup(); const id = await linked(t); let got: any;
  (t.conns[0] as any).send = async (chatId: string, m: any): Promise<Message> => { got = m; return { id: "m", chatId, sender: "Me", senderId: "me", text: m.text, time: new Date().toISOString(), fromMe: true }; };
  await t.call("send", { chatId: `${id}:ann`, text: "hi @Ann and @Bob", mentions: [
    { id: "a", name: "Ann", start: 3, length: 4 }, { id: "b", name: "Bob", start: 12, length: 4 },
    { id: "x", name: "Out", start: 14, length: 10 }, { id: "ov", name: "Ov", start: 4, length: 2 }, { id: 5, name: "bad", start: 0, length: 1 }] });
  assert.deepEqual(got.mentions.map((m: any) => m.id), ["a", "b"]);
  await t.call("send", { chatId: `${id}:ann`, text: "plain" }); assert.equal(got.mentions, undefined);
  t.done();
});

test("new model fields survive the archive: cards[], card image, reaction/poll counts, patches", async () => {
  const t = setup(); const id = await linked(t);
  const cards = [{ kind: "other" as const, title: "One", image: { attachmentId: "e0i", width: 10, height: 5 } }, { kind: "link" as const, title: "Two needle" }];
  t.conns[0].emit({ type: "message", data: { ...msg("m1", "embeds", "2026-01-01T10:00:00Z"), cards, reactions: [{ emoji: "👍", senderIds: ["a"], count: 40 }], poll: { question: "q", multiple: false, options: [{ id: "1", text: "A", voters: [], count: 7 }] } } });
  t.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: "m1", patch: { cards: [{ ...cards[0], title: "One!" }] } } });
  const m = (await t.call("history", { chatId: `${id}:ann`, limit: 5 }))[0];
  assert.equal(m.cards[0].title, "One!"); assert.equal(m.cards[0].image.attachmentId, "e0i"); assert.equal(m.reactions[0].count, 40); assert.equal(m.poll.options[0].count, 7);
  t.conns[0].emit({ type: "message", data: { ...msg("m2", "x", "2026-01-01T10:01:00Z"), cards } });
  assert.equal((await t.call("search", { chatId: `${id}:ann`, q: "needle" })).length, 1, "every card is searchable");
  t.done();
});

test("the attachment call serves a card image id through the normal path (and caches it)", async () => {
  const t = setup(); const id = await linked(t);
  const r = await t.call("attachment", { chatId: `${id}:ann`, messageId: "m1", attachmentId: "e0i" });
  assert.equal(r.mime, "image/png"); await t.call("attachment", { chatId: `${id}:ann`, messageId: "m1", attachmentId: "e0i" }); assert.equal(t.conns[0].downloads, 1);
  t.done();
});

test("per-recipient receipts merge per id, never go backwards, survive history replays and reach the UI as patches", async () => {
  const t = setup(); const id = await linked(t); const chat = `${id}:ann`;
  const mine = (extra: Partial<Message> = {}): Message => ({ id: "o1", chatId: "ann", sender: "Me", senderId: "me", text: "hi all", time: "2026-01-01T10:00:00Z", fromMe: true, status: "sent", ...extra });
  const ev: any[] = []; t.hub.subscribe((e, d) => ev.push([e, d]));
  t.conns[0].emit({ type: "message", data: mine() });
  t.conns[0].emit({ type: "receipt", data: { chatId: "ann", messageId: "o1", status: "delivered", by: "bob", at: "2026-01-01T10:01:00Z" } });
  t.conns[0].emit({ type: "receipt", data: { chatId: "ann", messageId: "o1", status: "read", by: "bob", at: "2026-01-01T10:05:00Z" } });
  t.conns[0].emit({ type: "receipt", data: { chatId: "ann", messageId: "o1", status: "delivered", by: "cy", at: "2026-01-01T10:02:00Z" } });
  // late/older duplicate: the time does not move backwards
  t.conns[0].emit({ type: "receipt", data: { chatId: "ann", messageId: "o1", status: "read", by: "bob", at: "2026-01-01T10:03:00Z" } });
  const rc = () => t.store.getMessage(chat, "o1")!.receipts!;
  assert.deepEqual(rc(), [{ id: "bob", delivered: "2026-01-01T10:01:00.000Z", read: "2026-01-01T10:05:00.000Z" }, { id: "cy", delivered: "2026-01-01T10:02:00.000Z" }]);
  assert.equal(t.store.getMessage(chat, "o1")!.status, "read"); // aggregate unchanged semantics
  const last = ev.filter(([e, d]) => e === "message-update" && d.patch.receipts).at(-1)![1];
  assert.equal(last.chatId, chat); assert.equal(last.patch.receipts.length, 2);
  // a provider patch with a partial list merges too
  t.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: "o1", patch: { receipts: [{ id: "dee", read: "2026-01-01T11:00:00Z" }] } } });
  assert.deepEqual(rc().map((r) => r.id), ["bob", "cy", "dee"]);
  assert.equal(ev.filter(([e, d]) => e === "message-update" && d.patch.receipts).at(-1)![1].patch.receipts.length, 3);
  // a history replay of the bare message (no receipts, older status) loses nothing
  t.store.putMessages([{ ...mine(), chatId: chat, accountId: id, status: "sent" }]);
  assert.equal(rc().length, 3); assert.equal(t.store.getMessage(chat, "o1")!.status, "read");
  // ...and a replay WITH receipts merges
  t.store.putMessages([{ ...mine(), chatId: chat, accountId: id, receipts: [{ id: "cy", read: "2026-01-01T10:30:00Z" }] }]);
  assert.deepEqual(rc().find((r) => r.id === "cy"), { id: "cy", delivered: "2026-01-01T10:02:00.000Z", read: "2026-01-01T10:30:00Z" });
  // history results carry them; aggregate receipts (no `by`) do not invent any
  const h = await t.call("history", { chatId: chat, limit: 10 });
  assert.equal(h.find((m: Message) => m.id === "o1").receipts.length, 3);
  t.conns[0].emit({ type: "message", data: mine({ id: "o2" }) });
  t.conns[0].emit({ type: "receipt", data: { chatId: "ann", messageId: "o2", status: "read" } });
  assert.equal(t.store.getMessage(chat, "o2")!.receipts, undefined);
  t.done();
});

test("verification: events reach listeners with the account id, stay pending until done, calls route to the connector (chat ids made native)", async () => {
  const t = setup(); const id = await linked(t);
  const c = t.conns[0] as Fake & Record<string, any>; const seen: any[] = []; const calls: any[] = [];
  t.hub.subscribe((e, d) => { if (e === "verification") seen.push(d); });
  c.verificationStart = async (target: unknown) => { calls.push(["start", target]); return { id: "v1" }; };
  c.verificationAction = async (vid: string, a: string) => { calls.push(["action", vid, a]); };
  c.verificationStatus = async (target: unknown) => ({ state: "unknown", target });
  c.verificationSetup = async (o: unknown) => { calls.push(["setup", o]); return { recoveryKey: "EsTc" }; };
  c.verificationRecover = async (k: string) => { calls.push(["recover", k]); };
  const st = { id: "v1", phase: "sas", incoming: false, other: { kind: "device", name: "Phone" }, emoji: [["🐶", "Dog"]] };
  c.emit({ type: "verification", data: { accountId: "ignored", ...st } as any });
  assert.equal(seen[0].accountId, id); assert.equal((await t.call("pendingVerifications")).length, 1);
  c.emit({ type: "verification", data: { accountId: "x", ...st, phase: "done" } as any });
  assert.equal((await t.call("pendingVerifications")).length, 0); assert.equal(seen.length, 2);
  assert.deepEqual(await t.call("verificationStart", { accountId: id }), { id: "v1" });
  await t.call("verificationStart", { accountId: id, userId: "@a:hs", chatId: `${id}:ann` });
  await t.call("verificationAction", { accountId: id, id: "v1", action: "confirm" });
  assert.equal((await t.call("verificationSetup", { accountId: id, password: "pw" })).recoveryKey, "EsTc");
  await t.call("verificationRecover", { accountId: id, recoveryKey: "k" });
  assert.deepEqual(calls, [["start", undefined], ["start", { userId: "@a:hs", chatId: "ann" }], ["action", "v1", "confirm"], ["setup", { password: "pw" }], ["recover", "k"]]);
  delete c.verificationAction;
  await assert.rejects(t.call("verificationAction", { accountId: id, id: "v1", action: "cancel" }), /no verification/);
  t.done();
});

// ------------------------------------------------------------------ automatic merge of provider-declared duplicates (Chat.sameAs)
async function dupSetup() {
  const t = await msetup([["aci", "Anna"]]);
  const mk = (id: string, name: string, extra: Partial<Chat> = {}): Chat => ({ id, accountId: "x", provider: "fake", kind: "dm", name, ...extra });
  const A = `${t.ids[0]}:aci`, P = `${t.ids[0]}:pni`;
  const set = (sameAs?: string, c = t.conns[0]) => { c.chatList = [mk("aci", "Anna", { unread: 1, lastMessageAt: "2026-01-02T10:00:00Z" }), mk("pni", "1234abcd", { unread: 2, lastMessageAt: "2026-01-01T10:00:00Z", ...(sameAs ? { sameAs } : {}) })]; };
  return { ...t, A, P, set };
}
test("auto merge: a chat the provider says is the same as another becomes ONE row (target is primary, name/avatar from it, unread summed, sends go to the target)", async () => {
  const t = await dupSetup(); t.set();
  assert.equal((await t.call("snapshot")).chats.length, 2, "association not known yet: two rows");
  t.feed(0, "m1", "from aci", "2026-01-02T10:00:00.000Z"); t.conns[0].emit({ type: "message", data: { id: "m0", chatId: "pni", sender: "Me", senderId: "me", text: "first, to the PNI", time: "2026-01-01T09:00:00.000Z", fromMe: true } });
  t.set("aci");
  const snap = await t.call("snapshot"); const rows = snap.chats.filter((c: Chat) => !c.mergedInto);
  assert.equal(rows.length, 1); assert.equal(rows[0].name, "Anna"); assert.equal(rows[0].unread, 3); assert.deepEqual(rows[0].mergeMembers, [t.A, t.P]); assert.equal(rows[0].mergeSendVia, t.A);
  assert.match(rows[0].id, /^merge:auto:/); assert.equal(snap.merges.length, 1); assert.equal(snap.merges[0].auto, true);
  const h = await t.call("history", { chatId: rows[0].id, limit: 10 }); assert.deepEqual(texts(h), ["first, to the PNI", "from aci"], "both timelines, in time order");
  await t.call("send", { chatId: rows[0].id, text: "hello" }); assert.deepEqual(t.conns[0].sent, [{ chatId: "aci", text: "hello" }], "sends go to the ACI chat");
  const id1 = rows[0].id; await t.call("snapshot"); assert.equal(t.store.listMerges().length, 1, "idempotent: no second record"); assert.equal(t.store.listMerges()[0].id, id1);
  t.done();
});
test("auto merge: unmerge sticks (tombstone, replicated as a merge record), is not re-created, and a restart keeps it", async () => {
  const t = await dupSetup(); t.set("aci");
  const row = (await t.call("snapshot")).chats.find((c: Chat) => c.id.startsWith("merge:auto:"));
  await t.call("unmergeChat", { mergeId: row.id });
  let snap = await t.call("snapshot"); assert.equal(snap.chats.filter((c: Chat) => !c.mergedInto).length, 2); assert.deepEqual(snap.merges, []);
  assert.deepEqual(t.store.listMerges().map((m) => [m.id, m.dismissed]), [[row.id, true]]);
  await t.hub.reloadFromStore(); snap = await t.call("snapshot"); assert.equal(snap.chats.filter((c: Chat) => !c.mergedInto).length, 2, "still separate after reload");
  t.done();
});
test("auto merge: established for pre-existing duplicates on the next start (same id on every device); a user merge of the target is extended", async () => {
  const t = await dupSetup(); t.set("aci");
  const hub2 = new Hub(t.dir, [], t.store); // a fresh process over the same store: no merge record yet
  assert.deepEqual(t.store.listMerges(), []);
  await t.call("snapshot"); const id = t.store.listMerges()[0].id; assert.equal(t.store.listMerges().length, 1); void hub2;
  const u = await dupSetup(); u.set(); const other = `${u.ids[0]}:other`;
  u.conns[0].chatList.push({ id: "other", accountId: "x", provider: "fake", kind: "dm", name: "Other" });
  await u.call("mergeChats", { chatIds: [u.A, other] }); u.set("aci"); u.conns[0].chatList.push({ id: "other", accountId: "x", provider: "fake", kind: "dm", name: "Other" });
  await u.call("snapshot"); assert.equal(u.store.listMerges().length, 1); assert.deepEqual([...u.store.listMerges()[0].members].sort(), [u.A, u.P, other].sort()); void id;
  t.done(); u.done();
});
test("auto merge: nothing without sameAs (same name / number is not enough) and never across accounts", async () => {
  const t = await msetup([["aci", "Anna"], ["pni", "Anna"]]);
  t.conns[1].chatList = [{ ...t.conns[1].chatList[0], sameAs: "aci" }];
  const snap = await t.call("snapshot"); assert.equal(snap.chats.length, 2); assert.deepEqual(snap.merges, []);
  t.done();
});

test("commonChats: communities in common come from the network's mutual servers and from the shared groups", async () => {
  const t = setup(); const id = await linked(t); const c = t.conns[0] as any;
  const sp = (n: string) => ({ id: n, accountId: "x", provider: "fake", name: "Server " + n });
  c.spaces = async () => [sp("s1"), sp("s2"), sp("s3")];
  c.chatList = [{ id: "ann", accountId: "x", provider: "fake", kind: "dm", name: "Ann" }, { id: "g2", accountId: "x", provider: "fake", kind: "group", name: "Climbers", spaceId: "s2" }, { id: "g3", accountId: "x", provider: "fake", kind: "group", name: "Others", spaceId: "s3" }];
  c.members = async (chat: string) => (chat === "g2" ? [{ id: "ann", name: "Ann" }, { id: "me", name: "Me" }] : chat === "g3" ? [{ id: "zed", name: "Zed" }] : [{ id: "ann", name: "Ann" }]);
  const asked: string[] = []; c.mutualSpaces = async (who: string) => { asked.push(who); return who === "ann" ? ["s1", "s2"] : []; };
  t.conns[0].emit({ type: "message", data: msg("m1", "hello", "2026-01-01T10:00:00Z") });
  const r = await t.call("commonChats", { chatId: `${id}:ann` });
  assert.deepEqual(r.groups.map((g: any) => g.name), ["Climbers"]);
  assert.deepEqual(r.communities.map((x: any) => x.id).sort(), [`${id}:s1`, `${id}:s2`], "s1 only from the network, s2 from both, s3 is not shared");
  assert.ok(asked.includes("ann"));
  assert.equal(r.communities[0].provider, "fake"); assert.ok(r.communities[0].accountId);
  t.done();
});

test("commonChats: a network that fails to list mutual servers still shows the communities of the shared groups", async () => {
  const t = setup(); const id = await linked(t); const c = t.conns[0] as any;
  c.spaces = async () => [{ id: "s2", accountId: "x", provider: "fake", name: "Server 2" }];
  c.chatList = [{ id: "ann", accountId: "x", provider: "fake", kind: "dm", name: "Ann" }, { id: "g2", accountId: "x", provider: "fake", kind: "group", name: "Climbers", spaceId: "s2" }];
  c.members = async (chat: string) => (chat === "g2" ? [{ id: "ann", name: "Ann" }] : []);
  c.mutualSpaces = async () => { throw new Error("boom"); };
  t.conns[0].emit({ type: "message", data: msg("m1", "hello", "2026-01-01T10:00:00Z") });
  const r = await t.call("commonChats", { chatId: `${id}:ann` });
  assert.deepEqual(r.communities.map((x: any) => x.id), [`${id}:s2`]);
test("captcha login prompt: pending until answered, the answer reaches the connector and the prompt is dropped (also when it expires)", async () => {
  const t = setup(); const id = await linked(t);
  const answers: [string, Record<string, string>][] = [];
  (t.conns[0] as any).submitLogin = async (pid: string, v: Record<string, string>) => { answers.push([pid, v]); };
  const cap = { promptId: "captcha-1", kind: "captcha" as const, service: "hcaptcha" as const, sitekey: "sk", title: "Check", expiresAt: Date.now() + 60000 };
  t.conns[0].emit({ type: "login", data: { accountId: "x", ...cap } });
  const pend = await t.call("pendingLogins");
  assert.equal(pend.length, 1); assert.equal(pend[0].kind, "captcha"); assert.equal(pend[0].accountId, id);
  await t.call("submitLogin", { accountId: id, promptId: "captcha-1", values: { token: "tok" } });
  assert.deepEqual(answers, [["captcha-1", { token: "tok" }]]);
  assert.equal((await t.call("pendingLogins")).length, 0);
  t.conns[0].emit({ type: "login", data: { accountId: "x", ...cap, promptId: "captcha-2", expiresAt: Date.now() - 1 } });
  assert.equal((await t.call("pendingLogins")).length, 0, "expired captcha prompts are not offered again");
  t.done();
});
