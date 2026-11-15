import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "./hub.js";
import { MemoryStore } from "./store.js";
import { normalizeCategories, normalizeChatCategories, applyCategories } from "./categories.js";
import { NO_CAPABILITIES, type Connector, type CoreEvent, type ProviderFactory } from "./provider.js";
import type { Chat, Space } from "./model.js";

class C implements Connector {
  capabilities = NO_CAPABILITIES; emit: (e: CoreEvent) => void = () => {};
  spaceList: Space[] = [{ id: "a", accountId: "x", provider: "fake", name: "A" }, { id: "b", accountId: "x", provider: "fake", name: "B" }];
  // a1 / a2 carry the provider's category "Text", a3 none; b1, b2 in B
  chatList: Chat[] = [
    { id: "a1", accountId: "x", provider: "fake", kind: "channel", name: "a1", spaceId: "a", category: "Text" },
    { id: "a2", accountId: "x", provider: "fake", kind: "channel", name: "a2", spaceId: "a", category: "Text" },
    { id: "a3", accountId: "x", provider: "fake", kind: "channel", name: "a3", spaceId: "a" },
    { id: "b1", accountId: "x", provider: "fake", kind: "channel", name: "b1", spaceId: "b" },
    { id: "b2", accountId: "x", provider: "fake", kind: "channel", name: "b2", spaceId: "b" },
    { id: "dm", accountId: "x", provider: "fake", kind: "dm", name: "dm" },
  ];
  async start(emit: (e: CoreEvent) => void) { this.emit = emit; } async stop() {} async logout() {} async submitLogin() {}
  async spaces() { return this.spaceList; } async chats() { return this.chatList; }
  async history() { return []; } async members() { return []; } async downloadAttachment() { return { data: new Uint8Array(), mime: "x" }; }
  async send(): Promise<never> { throw new Error("no"); }
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hub-cat-"));
  let conn!: C;
  const factory: ProviderFactory = { name: "fake", displayName: "Fake", login: "qr", capabilities: NO_CAPABILITIES, create: () => (conn = new C()) };
  const store = new MemoryStore(), hub = new Hub(dir, [factory], store);
  const call = (m: string, p?: unknown) => hub.call(m, p) as Promise<any>;
  const acc = await call("addAccount", { provider: "fake", label: "L" }); conn.emit({ type: "account", data: { id: acc.id, state: "connected" } });
  const id = (n: string) => `${acc.id}:${n}`;
  const chat = async (n: string) => (await call("snapshot")).chats.find((c: Chat) => c.id === id(n));
  return { hub, store, call, conn, id, chat, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("categories: normalize trims, dedupes, prunes, renumbers order, rejects bad input when strict", () => {
  const out = normalizeCategories({
    a: [{ id: "cat:2", name: "  Two ", color: "#ff0000", order: 5 }, { id: "cat:1", name: "x".repeat(99), color: "red;x", order: 1 }, { id: "cat:1", name: "dup" }, { id: "nope", name: "bad" }, null, { id: "cat:3", name: "  " }],
    ghost: [{ id: "cat:9", name: "vanished space" }],
    personal: [{ id: "cat:2", name: "id already used elsewhere" }],
    b: [], home: [{ id: "cat:8", name: "h" }],
  }, ["a", "b"]);
  assert.deepEqual(Object.keys(out), ["a"]);
  assert.deepEqual(out.a.map((c) => [c.id, c.order]), [["cat:1", 0], ["cat:3", 1], ["cat:2", 2]]);
  assert.equal(out.a[0].name.length, 40); assert.equal(out.a[0].color, undefined);
  assert.equal(out.a[1].name, "Category"); assert.equal(out.a[2].name, "Two"); assert.equal(out.a[2].color, "#ff0000");
  assert.deepEqual(normalizeCategories("junk"), {}); assert.deepEqual(normalizeCategories([1]), {});
  assert.throws(() => normalizeCategories("junk", undefined, true), /map of lists/);
  assert.throws(() => normalizeCategories({ a: [{ id: "x", name: "n" }] }, undefined, true), /Bad category id/);
  assert.throws(() => normalizeCategories({ a: "no" }, undefined, true), /malformed/);
  assert.ok(normalizeCategories({ personal: [{ id: "cat:p", name: "P" }] }, ["a"]).personal, "Personal is always a valid view");
});

test("categories: chat overrides need an existing category of the chat's view", () => {
  const cats = normalizeCategories({ a: [{ id: "cat:1", name: "One" }], personal: [{ id: "cat:p", name: "P" }] });
  const view = new Map([["c1", "a"], ["c2", "a"], ["c3", "personal"]]);
  assert.deepEqual(normalizeChatCategories({ c1: "cat:1", c2: "none", c3: "cat:1", c4: "none", c5: "cat:zzz", c6: 7, c7: "cat:p" }, cats), { c1: "cat:1", c2: "none", c3: "cat:1", c4: "none", c7: "cat:p" });
  assert.deepEqual(normalizeChatCategories({ c1: "cat:1", c2: "none", c3: "cat:1", c4: "none", c7: "cat:p" }, cats, view), { c1: "cat:1", c2: "none" });
  assert.throws(() => normalizeChatCategories({ c3: "cat:1" }, cats, view, true), /not valid/);
});

test("categories: applyCategories sets effective / user / provider category; Personal has no provider headings", () => {
  const cats = normalizeCategories({ a: [{ id: "cat:1", name: "Mine" }], personal: [{ id: "cat:p", name: "Fam" }] });
  const chats = [
    { id: "p", spaceId: "a", category: "Text" }, { id: "u", spaceId: "a", category: "Text" }, { id: "n", spaceId: "a", category: "Text" }, { id: "w", spaceId: "a", category: "Text" },
    { id: "d" }, { id: "dp", category: "Orphan" }, { id: "dn" },
  ] as Chat[];
  const out = applyCategories(chats, { categories: cats, chatCategory: { u: "cat:1", n: "none", w: "cat:p", d: "cat:p" } });
  const by = Object.fromEntries(out.map((c) => [c.id, c]));
  assert.deepEqual([by.p.category, by.p.categoryId, by.p.providerCategory], ["Text", undefined, "Text"]);
  assert.deepEqual([by.u.category, by.u.categoryId, by.u.providerCategory], ["Mine", "cat:1", "Text"]);
  assert.deepEqual([by.n.category, by.n.categoryId, by.n.providerCategory], [undefined, undefined, "Text"]);
  assert.equal(by.w.category, "Text", "an override of another view is ignored");
  assert.deepEqual([by.d.category, by.d.categoryId], ["Fam", "cat:p"]);
  assert.equal(by.dp.category, undefined); assert.equal(by.dp.providerCategory, "Orphan");
});

test("hub categories: create / rename / colour / order / delete with validation", async () => {
  const t = await setup(); const events: string[] = []; t.hub.subscribe((e) => events.push(e));
  const x = await t.call("createCategory", { spaceId: t.id("a"), name: "  Work  ", color: "#e0a030" });
  assert.match(x.id, /^cat:/); assert.equal(x.name, "Work"); assert.equal(x.order, 0);
  const y = await t.call("createCategory", { spaceId: t.id("a"), name: "Play" });
  await t.call("createCategory", { spaceId: "personal", name: "Fam" });
  assert.ok(events.includes("chats-changed") && events.includes("spaces-changed"));
  await assert.rejects(t.call("createCategory", { spaceId: t.id("a"), name: "work" }), /already a category/);
  await assert.rejects(t.call("createCategory", { spaceId: t.id("a"), name: " " }), /name/);
  await assert.rejects(t.call("createCategory", { spaceId: t.id("a"), name: "x".repeat(41) }), /at most 40/);
  await assert.rejects(t.call("createCategory", { spaceId: t.id("a"), name: "q", color: "red" }), /colour/);
  await assert.rejects(t.call("createCategory", { spaceId: "folder:nope", name: "q" }), /no longer exists/);
  await t.call("updateCategory", { id: y.id, name: "Fun", color: "#111" });
  await assert.rejects(t.call("updateCategory", { id: y.id, name: "Work" }), /already a category/);
  await t.call("updateCategory", { id: y.id, color: null });
  await assert.rejects(t.call("updateCategory", { id: "cat:zzz", name: "q" }), /no longer exists/);
  await t.call("setCategoryOrder", { spaceId: t.id("a"), ids: [y.id, x.id] });
  let snap = await t.call("snapshot");
  assert.deepEqual(snap.categories[t.id("a")].map((c: any) => [c.name, c.order]), [["Fun", 0], ["Work", 1]]);
  assert.equal(snap.categories[t.id("a")][0].color, undefined);
  assert.deepEqual(snap.categories.personal.map((c: any) => c.name), ["Fam"]);
  assert.deepEqual((await t.call("categories")).categories[t.id("a")].length, 2);
  await t.call("deleteCategory", { id: y.id });
  snap = await t.call("snapshot"); assert.deepEqual(snap.categories[t.id("a")].map((c: any) => [c.name, c.order]), [["Work", 0]]);
  await assert.rejects(t.call("deleteCategory", { id: y.id }), /no longer exists/);
  t.done();
});

test("hub categories: setChatCategory batch, none, reset; effective category in the snapshot", async () => {
  const t = await setup();
  const w = await t.call("createCategory", { spaceId: t.id("a"), name: "Work" });
  assert.equal((await t.chat("a1")).category, "Text"); assert.equal((await t.chat("a1")).providerCategory, "Text");
  const r = await t.call("setChatCategory", { chatIds: [t.id("a1"), t.id("a3")], categoryId: w.id }); assert.equal(r.changed, 2);
  let a1 = await t.chat("a1"); assert.deepEqual([a1.category, a1.categoryId, a1.providerCategory], ["Work", w.id, "Text"]);
  assert.equal((await t.chat("a3")).category, "Work"); assert.equal((await t.chat("a2")).category, "Text");
  await t.call("setChatCategory", { chatIds: [t.id("a2")], categoryId: "none" });
  const a2 = await t.chat("a2"); assert.deepEqual([a2.category, a2.categoryId, a2.providerCategory], [undefined, undefined, "Text"]);
  await t.call("setChatCategory", { chatIds: [t.id("a1"), t.id("a2")], categoryId: null });
  assert.equal((await t.chat("a1")).category, "Text"); assert.equal((await t.chat("a2")).category, "Text");
  // atomic: a chat of another view makes the whole batch fail
  await assert.rejects(t.call("setChatCategory", { chatIds: [t.id("a2"), t.id("b1")], categoryId: w.id }), /another folder/);
  assert.equal((await t.chat("a2")).category, "Text");
  await assert.rejects(t.call("setChatCategory", { chatIds: [t.id("a2")], categoryId: "cat:zzz" }), /no longer exists/);
  await assert.rejects(t.call("setChatCategory", { chatIds: [t.id("ghost")], categoryId: "none" }), /no longer exists/);
  await assert.rejects(t.call("setChatCategory", { chatIds: [], categoryId: "none" }), /No chat/);
  // Personal chat
  const p = await t.call("createCategory", { spaceId: "personal", name: "Family" });
  await t.call("setChatCategory", { chatIds: [t.id("dm")], categoryId: p.id }); assert.equal((await t.chat("dm")).category, "Family");
  // delete falls back to the provider category
  await t.call("setChatCategory", { chatIds: [t.id("a1"), t.id("a3")], categoryId: w.id });
  await t.call("deleteCategory", { id: w.id });
  a1 = await t.chat("a1"); assert.deepEqual([a1.category, a1.categoryId], ["Text", undefined]); assert.equal((await t.chat("a3")).category, undefined);
  assert.deepEqual((await t.call("categories")).chatCategory, { [t.id("dm")]: p.id });
  t.done();
});

test("hub categories: moving a chat keeps the override only for a category of the target view; folders take their categories along", async () => {
  const t = await setup();
  const ca = await t.call("createCategory", { spaceId: t.id("a"), name: "CA" });
  const f = await t.call("createFolder", { name: "F" });
  const cf = await t.call("createCategory", { spaceId: f.id, name: "CF" });
  const cp = await t.call("createCategory", { spaceId: "personal", name: "CP" });
  await t.call("setChatCategory", { chatIds: [t.id("a1")], categoryId: ca.id });
  await t.call("setChatCategory", { chatIds: [t.id("a2")], categoryId: "none" });
  await t.call("moveChat", { chatId: t.id("a1"), folderId: f.id }); await t.call("moveChat", { chatId: t.id("a2"), folderId: f.id });
  let a1 = await t.chat("a1"); assert.deepEqual([a1.spaceId, a1.category, a1.categoryId], [f.id, "Text", undefined], "cleared; falls back to the provider category");
  assert.equal((await t.chat("a2")).category, "Text", "'none' belongs to the old view and is cleared too");
  assert.deepEqual(await t.call("categories").then((s) => s.chatCategory), {});
  await assert.rejects(t.call("setChatCategory", { chatIds: [t.id("a1")], categoryId: ca.id }), /another folder/);
  await t.call("setChatCategory", { chatIds: [t.id("a1")], categoryId: cf.id });
  await t.call("moveChat", { chatId: t.id("a1"), folderId: "personal" });
  assert.equal((await t.chat("a1")).categoryId, undefined);
  await t.call("setChatCategory", { chatIds: [t.id("a1")], categoryId: cp.id });
  await t.call("moveChat", { chatId: t.id("a1"), folderId: null }); // back to community A
  assert.equal((await t.chat("a1")).spaceId, t.id("a")); assert.equal((await t.chat("a1")).categoryId, undefined);
  await t.call("setChatCategory", { chatIds: [t.id("a1")], categoryId: ca.id });
  await t.call("moveChat", { chatId: t.id("a1"), folderId: null }); // moving to the place it already is: still valid
  assert.equal((await t.chat("a1")).categoryId, ca.id);
  // deleting a folder deletes its categories and the overrides
  await t.call("moveChat", { chatId: t.id("b1"), folderId: f.id }); await t.call("setChatCategory", { chatIds: [t.id("b1")], categoryId: cf.id });
  await t.call("deleteFolder", { id: f.id });
  const s = await t.call("snapshot"); assert.equal(s.categories[f.id], undefined);
  assert.equal((await t.chat("b1")).categoryId, undefined); assert.equal((await t.chat("b1")).spaceId, t.id("b"));
  assert.ok(!Object.values((await t.call("categories")).chatCategory).includes(cf.id));
  assert.ok(t.store.getSetting("userCategories")!.includes(ca.id) && !t.store.getSetting("userCategories")!.includes(cf.id));
  t.done();
});

test("hub categories: settings are stored (so backups carry them) and survive a restart of the Hub", async () => {
  const t = await setup();
  const c = await t.call("createCategory", { spaceId: t.id("a"), name: "Keep" }); await t.call("setChatCategory", { chatIds: [t.id("a1")], categoryId: c.id });
  assert.ok(JSON.parse(t.store.getSetting("userCategories")!)[t.id("a")]); assert.equal(JSON.parse(t.store.getSetting("chatCategories")!)[t.id("a1")], c.id);
  const records = [...t.store.exportRecords()].filter((r) => r.t === "setting" && (r.key === "userCategories" || r.key === "chatCategories"));
  assert.equal(records.length, 2);
  const dir = mkdtempSync(join(tmpdir(), "hub-cat2-")); const store2 = new MemoryStore();
  for (const r of records) if (r.t === "setting") store2.setSetting(r.key, r.value);
  assert.equal(new (await import("./categories.js")).Categories(() => store2, () => {}, async () => ({ spaces: [t.id("a")], chats: [{ id: t.id("a1"), spaceId: t.id("a") }] })).state().chatCategory[t.id("a1")], c.id);
  rmSync(dir, { recursive: true, force: true }); t.done();
});
