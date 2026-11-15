import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "./hub.js";
import { MemoryStore } from "./store.js";
import { NO_CAPABILITIES, type Capabilities, type Connector, type CoreEvent, type ProviderFactory } from "./provider.js";
import type { Chat, Message } from "./model.js";

class Fake implements Connector {
  emit: (e: CoreEvent) => void = () => {}; presenceOn: boolean[] = [];
  constructor(public capabilities: Capabilities) {}
  setPresenceEnabled(on: boolean) { this.presenceOn.push(on); }
  async start(emit: (e: CoreEvent) => void) { this.emit = emit; }
  async stop() {} async logout() {} async submitLogin() {}
  async spaces() { return []; }
  async chats(): Promise<Chat[]> { return [{ id: "ann", accountId: "x", provider: "fake", kind: "dm", name: "Ann" }, { id: "team", accountId: "x", provider: "fake", kind: "group", name: "Team" }]; }
  async history(): Promise<Message[]> { return []; }
  async members() { return [{ id: "ann", name: "Ann" }, { id: "bob", name: "Bob" }]; }
  async downloadAttachment(): Promise<never> { throw new Error("n/a"); }
  async send(): Promise<Message> { throw new Error("n/a"); }
}

test("presence: forwarded with global ids, shown on DM chats and members, not archived, privacy switch clears it", async () => {
  const caps: Capabilities = { ...NO_CAPABILITIES, presence: true };
  const dir = mkdtempSync(join(tmpdir(), "hub-pres-")); let conn!: Fake;
  const factories: ProviderFactory[] = [{ name: "fake", displayName: "fake", login: "qr", capabilities: caps, create: () => (conn = new Fake(caps)) }];
  const hub = new Hub(dir, factories, new MemoryStore(), { extras: { markReadGapMs: 0, mediaGapMs: 0 } });
  const call = (m: string, p?: unknown) => hub.call(m, p) as Promise<any>;
  const seen: [string, any][] = []; hub.subscribe((e: string, d: unknown) => seen.push([e, d]));
  try {
    const a = await call("addAccount", { provider: "fake" }); conn.emit({ type: "account", data: { id: a.id, state: "connected" } });
    assert.deepEqual(conn.presenceOn, [true], "connector is told the setting before start");
    const listed = async () => (await call("snapshot")).chats as Chat[];
    assert.equal((await listed()).find((c) => c.name === "Ann")!.online, undefined, "unknown at first");
    conn.emit({ type: "presence", data: { accountId: a.id, chatId: "ann", contactId: "ann", online: true } });
    const ev = seen.find(([e]) => e === "presence")!; assert.ok(ev, "forwarded to clients");
    assert.deepEqual(ev[1], { accountId: a.id, chatId: `${a.id}:ann`, contactId: "ann", online: true });
    const chats = await listed();
    assert.equal(chats.find((c) => c.name === "Ann")!.online, true, "DM chat carries online");
    assert.equal(chats.find((c) => c.name === "Team")!.online, undefined, "groups never do");
    const mem = await call("members", { chatId: `${a.id}:team` }); assert.equal(mem.find((m: any) => m.id === "ann").online, true); assert.equal(mem.find((m: any) => m.id === "bob").online, undefined);
    const n = seen.filter(([e]) => e === "presence").length;
    conn.emit({ type: "presence", data: { accountId: a.id, contactId: "ann", online: true } }); assert.equal(seen.filter(([e]) => e === "presence").length, n, "unchanged: not forwarded again");
    conn.emit({ type: "presence", data: { accountId: a.id, chatId: "ann", contactId: "ann", online: false, lastSeen: "2026-01-01T10:00:00.000Z" } });
    const off = (await listed()).find((c) => c.name === "Ann")!; assert.equal(off.online, false); assert.equal(off.lastSeen, "2026-01-01T10:00:00.000Z");
    await call("setSetting", { key: "showPresence", value: false });
    assert.deepEqual(conn.presenceOn, [true, false]);
    assert.equal((await listed()).find((c) => c.name === "Ann")!.online, undefined, "switch off: nothing shown");
    const m = seen.filter(([e]) => e === "presence").length; conn.emit({ type: "presence", data: { accountId: a.id, chatId: "ann", contactId: "ann", online: true } });
    assert.equal(seen.filter(([e]) => e === "presence").length, m, "switch off: events dropped");
    assert.equal((await call("getSettings")).showPresence, false);
  } finally { await hub.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
