import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "./hub.js";
import { MemoryStore } from "./store.js";
import { NO_CAPABILITIES, type Connector, type CoreEvent, type ProviderFactory } from "./provider.js";
import type { Chat, Message } from "./model.js";

class PFake implements Connector {
  capabilities = { ...NO_CAPABILITIES, pinMessages: true, pinDurations: [86400, 604800, 2592000] as number[] };
  emit: (e: CoreEvent) => void = () => {};
  calls: string[] = []; listed?: Message[];
  chatList: Chat[];
  constructor(public native: string, public name: string, caps?: Partial<typeof NO_CAPABILITIES>) { this.chatList = [{ id: native, accountId: "x", provider: "fake", kind: "dm", name }]; if (caps) this.capabilities = { ...this.capabilities, ...caps }; }
  async start(emit: (e: CoreEvent) => void) { this.emit = emit; }
  async stop() {} async logout() {} async submitLogin() {} async spaces() { return []; }
  async chats() { return this.chatList; }
  async history() { return []; } async members() { return []; }
  async downloadAttachment() { return { data: new Uint8Array(), mime: "application/octet-stream" }; }
  async send(chatId: string, m: { text: string }): Promise<Message> { return { id: "o", chatId, sender: "Me", senderId: "me", text: m.text, time: new Date().toISOString(), fromMe: true, status: "sent" }; }
  async pin(c: string, id: string, pinned: boolean, o?: { durationSec?: number }) { this.calls.push(`pin ${c} ${id} ${pinned} ${o?.durationSec ?? "-"}`); }
  async pins(_c: string) { if (!this.listed) throw new Error("not listable"); return this.listed; }
}
async function setup(natives: [string, string][] = [["ann", "Ann"]], caps?: Partial<typeof NO_CAPABILITIES>) {
  const dir = mkdtempSync(join(tmpdir(), "hub-pins-"));
  const conns: PFake[] = [];
  const factory: ProviderFactory = { name: "fake", displayName: "Fake", login: "qr", capabilities: { ...NO_CAPABILITIES }, create: () => { const [n, nm] = natives[conns.length]; const c = new PFake(n, nm, caps); conns.push(c); return c; } };
  const store = new MemoryStore(), hub = new Hub(dir, [factory], store);
  const call = (m: string, p?: unknown) => hub.call(m, p) as Promise<any>;
  const ids: string[] = [], events: { type: string; data: any }[] = [];
  hub.subscribe((type, data) => events.push({ type, data }));
  for (let i = 0; i < natives.length; i++) { const acc = await call("addAccount", { provider: "fake", label: "A" + i }); conns[i].emit({ type: "account", data: { id: acc.id, state: "connected" } }); ids.push(acc.id); }
  const feed = (i: number, id: string, text: string, time: string) => conns[i].emit({ type: "message", data: { id, chatId: natives[i][0], sender: natives[i][1], senderId: natives[i][0], text, time, fromMe: false } });
  return { hub, store, conns, call, ids, events, feed, A: `${ids[0]}:${natives[0][0]}`, B: ids[1] ? `${ids[1]}:${natives[1][0]}` : "", done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("pin: routed to the connector with a validated duration, the flag is archived and announced", async () => {
  const t = await setup(); t.feed(0, "m1", "hi", "2026-01-01T10:00:00.000Z");
  await t.call("pin", { chatId: t.A, messageId: "m1", pinned: true, durationSec: 86400 });
  assert.deepEqual(t.conns[0].calls, ["pin ann m1 true 86400"]);
  const m = t.store.getMessage(t.A, "m1")!; assert.equal(m.pinned, true); assert.ok(m.pinnedAt); assert.ok(Date.parse(m.pinnedUntil!) > Date.now());
  assert.ok(t.events.some((e) => e.type === "message-update" && e.data.patch.pinned === true));
  await t.call("pin", { chatId: t.A, messageId: "m1", pinned: false });
  assert.equal(t.store.getMessage(t.A, "m1")!.pinned, false); assert.equal(t.store.getMessage(t.A, "m1")!.pinnedAt, undefined);
  await t.call("pin", { chatId: t.A, messageId: "m1", pinned: true, durationSec: 5 }); // not an offered duration: the 7 day default
  assert.equal(t.conns[0].calls.at(-1), "pin ann m1 true 604800");
  t.done();
});

test("pin: capability gate and deleted messages", async () => {
  const t = await setup([["ann", "Ann"]], { pinMessages: false }); t.feed(0, "m1", "hi", "2026-01-01T10:00:00.000Z");
  await assert.rejects(t.call("pin", { chatId: t.A, messageId: "m1", pinned: true }), /does not support pinning/);
  assert.deepEqual(t.conns[0].calls, []);
  const u = await setup(); u.feed(0, "m1", "hi", "2026-01-01T10:00:00.000Z");
  u.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: "m1", patch: { deleted: true } } });
  await assert.rejects(u.call("pin", { chatId: u.A, messageId: "m1", pinned: true }), /deleted/);
  t.done(); u.done();
});

test("incoming pin / unpin updates (other participants, other devices) are persisted and survive a deletion rule", async () => {
  const t = await setup(); t.feed(0, "m1", "hi", "2026-01-01T10:00:00.000Z");
  t.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: "m1", patch: { pinned: true, pinnedAt: "2026-01-02T00:00:00.000Z", pinnedBy: "ann" } } });
  assert.equal(t.store.getMessage(t.A, "m1")!.pinnedBy, "ann");
  assert.deepEqual((await t.call("pins", { chatId: t.A })).map((m: Message) => m.id), ["m1"]);
  t.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: "m1", patch: { pinned: false } } });
  const m = t.store.getMessage(t.A, "m1")!; assert.equal(m.pinned, false); assert.equal(m.pinnedBy, undefined); assert.equal(m.pinnedAt, undefined);
  assert.deepEqual(await t.call("pins", { chatId: t.A }), []);
  t.done();
});

test("pins: expired and deleted pins are not listed; a connector listing is authoritative and fills the archive", async () => {
  const t = await setup(); t.feed(0, "m1", "one", "2026-01-01T10:00:00.000Z"); t.feed(0, "m2", "two", "2026-01-01T11:00:00.000Z");
  for (const [id, until] of [["m1", "2020-01-01T00:00:00.000Z"], ["m2", undefined]] as const) t.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: id, patch: { pinned: true, pinnedAt: "2026-01-02T00:00:00.000Z", pinnedUntil: until } } });
  assert.deepEqual((await t.call("pins", { chatId: t.A })).map((m: Message) => m.id), ["m2"]); // m1 lapsed
  t.conns[0].listed = [{ id: "m3", chatId: "ann", sender: "Ann", senderId: "ann", text: "three", time: "2026-01-01T12:00:00.000Z", fromMe: false, pinnedAt: "2026-01-03T00:00:00.000Z" }];
  assert.deepEqual((await t.call("pins", { chatId: t.A })).map((m: Message) => m.id), ["m3"]);
  assert.equal(t.store.getMessage(t.A, "m2")!.pinned, false); // the network no longer lists it
  t.done();
});

test("merge: pin routes to the network that owns the message, pins unions all members newest-pinned first", async () => {
  const t = await setup([["ann", "Ann"], ["anna", "Anna"]]);
  t.feed(0, "a1", "from A", "2026-01-01T10:00:00.000Z"); t.feed(1, "b1", "from B", "2026-01-02T10:00:00.000Z");
  const row = await t.call("mergeChats", { chatIds: [t.A, t.B] });
  await t.call("pin", { chatId: row.id, messageId: "b1", pinned: true, durationSec: 604800 });
  assert.deepEqual(t.conns[0].calls, []); assert.deepEqual(t.conns[1].calls, ["pin anna b1 true 604800"]);
  await new Promise((r) => setTimeout(r, 5));
  await t.call("pin", { chatId: row.id, messageId: "a1", pinned: true });
  assert.equal(t.conns[0].calls.length, 1);
  const pins = await t.call("pins", { chatId: row.id });
  assert.deepEqual(pins.map((m: Message) => m.id), ["a1", "b1"]); assert.ok(pins.every((m: Message) => m.mergeId === row.id));
  await assert.rejects(t.call("pin", { chatId: row.id, messageId: "nope", pinned: true }), /not part of this merged chat/);
  t.done();
});
