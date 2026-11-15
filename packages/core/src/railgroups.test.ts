import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "./hub.js";
import { MemoryStore } from "./store.js";
import { normalizeRailGroups } from "./railgroups.js";
import { NO_CAPABILITIES, type Connector, type CoreEvent, type ProviderFactory } from "./provider.js";
import type { Chat, Space } from "./model.js";

class C implements Connector {
  capabilities = NO_CAPABILITIES; emit: (e: CoreEvent) => void = () => {};
  spaceList: Space[] = [{ id: "a", accountId: "x", provider: "fake", name: "A" }, { id: "b", accountId: "x", provider: "fake", name: "B" }, { id: "c", accountId: "x", provider: "fake", name: "C" }];
  chatList: Chat[] = ["a", "b", "c"].flatMap((s) => [1, 2].map((n): Chat => ({ id: `${s}${n}`, accountId: "x", provider: "fake", kind: "channel", name: `${s}${n}`, spaceId: s })));
  async start(emit: (e: CoreEvent) => void) { this.emit = emit; } async stop() {} async logout() {} async submitLogin() {}
  async spaces() { return this.spaceList; } async chats() { return this.chatList; }
  async history() { return []; } async members() { return []; } async downloadAttachment() { return { data: new Uint8Array(), mime: "x" }; }
  async send(): Promise<never> { throw new Error("no"); }
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hub-rg-"));
  let conn!: C;
  const factory: ProviderFactory = { name: "fake", displayName: "Fake", login: "qr", capabilities: NO_CAPABILITIES, create: () => (conn = new C()) };
  const store = new MemoryStore(), hub = new Hub(dir, [factory], store);
  const call = (m: string, p?: unknown) => hub.call(m, p) as Promise<any>;
  const acc = await call("addAccount", { provider: "fake", label: "L" }); conn.emit({ type: "account", data: { id: acc.id, state: "connected" } });
  return { hub, store, call, conn, id: (n: string) => `${acc.id}:${n}`, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("railgroups: normalize repairs/prunes (names, colours, duplicates, unknown ids, empty groups)", () => {
  const known = ["s1", "s2", "s3", "folder:f"];
  const out = normalizeRailGroups([
    { id: "group:1", name: "  Work  ", color: "#ff0000", members: ["s1", "s1", "folder:f", "ghost", "home", "personal", "group:2", 5] },
    { id: "group:1", name: "dup id", members: ["s2"] },       // duplicate group id: dropped
    { id: "nope", name: "bad id", members: ["s2"] },            // not a group id: dropped
    { id: "group:2", name: "x".repeat(100), color: "red; background:url(x)", members: ["s1", "s2"] }, // s1 already used, bad colour, long name
    { id: "group:3", name: "empty", members: ["ghost"] },       // nothing valid left: dropped
    null, 7,
  ], known);
  assert.deepEqual(out, [{ id: "group:1", name: "Work", color: "#ff0000", members: ["s1", "folder:f"] }, { id: "group:2", name: "x".repeat(40), members: ["s2"] }]);
  assert.deepEqual(normalizeRailGroups("junk"), []);
  assert.deepEqual(normalizeRailGroups([{ id: "group:1", name: "", members: ["a"] }]), [{ id: "group:1", name: "Group", members: ["a"] }]); // no known list: nothing is pruned
  assert.throws(() => normalizeRailGroups("junk", [], true), /list/);
  assert.throws(() => normalizeRailGroups([{ id: "x", members: [] }], [], true), /group id/);
  assert.throws(() => normalizeRailGroups([{ id: "group:1" }], [], true), /members/);
});

test("railgroups: Hub persists groups in the settings, prunes vanished spaces and survives a restart of the store", async () => {
  const t = await setup();
  assert.deepEqual(await t.call("railGroups"), []);
  const g = [{ id: "group:one", name: "Mine", color: "#3b82f6", members: [t.id("a"), t.id("b"), t.id("zzz")] }];
  let events = 0; t.hub.subscribe((e: string) => { if (e === "spaces-changed") events++; });
  const saved = await t.call("setRailGroups", { groups: g });
  assert.deepEqual(saved, [{ id: "group:one", name: "Mine", color: "#3b82f6", members: [t.id("a"), t.id("b")] }]); // unknown id dropped
  assert.ok(events >= 1);
  assert.deepEqual(JSON.parse(t.store.getSetting("railGroups")!), saved);
  assert.deepEqual(await t.call("railGroups"), saved);
  // the group's place in the rail is the existing railOrder (unknown ids such as the group's are ignored by the snapshot)
  await t.call("setRailOrder", { ids: ["group:one", t.id("c")] });
  const snap = await t.call("snapshot"); assert.ok(snap.spaces.every((s: any) => !s.id.startsWith("group:")));
  // ids of spaces that vanished (left community, removed account) are pruned on read; a group left empty disappears
  t.store.setSetting("railGroups", JSON.stringify([{ id: "group:one", name: "Mine", members: [t.id("a"), "acc9:gone"] }, { id: "group:two", name: "Dead", members: ["acc9:gone2"] }]));
  assert.deepEqual(await t.call("railGroups"), [{ id: "group:one", name: "Mine", members: [t.id("a")] }]);
  t.store.setSetting("railGroups", "{not json"); assert.deepEqual(await t.call("railGroups"), []);
  await assert.rejects(t.call("setRailGroups", { groups: "nope" }), /list/);
  await assert.rejects(t.call("setRailGroups", { groups: [{ id: "bad", members: [] }] }), /group id/);
  t.done();
});

test("railgroups: a folder and a community can share a group; Personal and other groups can't be members; a rail entry sits in one group", async () => {
  const t = await setup();
  const f = await t.call("createFolder", { name: "F" });
  const out = await t.call("setRailGroups", { groups: [
    { id: "group:1", name: "G1", members: [f.id, t.id("b"), "personal", "home"] },
    { id: "group:2", name: "G2", members: [t.id("b"), t.id("c"), "group:1"] }] });
  assert.deepEqual(out.map((g: any) => g.members), [[f.id, t.id("b")], [t.id("c")]]);
  await t.call("deleteFolder", { id: f.id }); // deleting the folder removes it from the group on the next read
  assert.deepEqual((await t.call("railGroups")).map((g: any) => g.members), [[t.id("b")], [t.id("c")]]);
  t.done();
});
