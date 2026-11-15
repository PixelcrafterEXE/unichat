// The Signal history import against the real SQLite store: one transaction (cancel / failure rolls back), merge never overwrites, re-import is a no-op.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Hub, NO_CAPABILITIES, type Connector, type CoreEvent, type Message, type ProviderFactory } from "@unimsg/core";
import { ids, groupId, writeSynthetic, writeBig, T0 } from "../../core/src/signalimport/fixture.js";
import { SqliteStore } from "./index.js";

const dirs: string[] = [];
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
class Fake implements Connector {
  capabilities = NO_CAPABILITIES; emit: (e: CoreEvent) => void = () => {};
  async start(emit: (e: CoreEvent) => void) { this.emit = emit; } async stop() {} async logout() {} async submitLogin() {}
  async spaces() { return []; } async chats() { return []; } async history() { return []; } async members() { return []; }
  async downloadAttachment(): Promise<any> { throw new Error("n/a"); } async send(): Promise<Message> { throw new Error("n/a"); }
  importIdentity() { return { aci: ids.ME }; }
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sigimp-sql-")); dirs.push(dir);
  const key = new Uint8Array(randomBytes(32)), store = new SqliteStore(join(dir, "t.db"), key);
  const conns: Fake[] = [], factory: ProviderFactory = { name: "signal", displayName: "Signal", login: "qr", capabilities: NO_CAPABILITIES, create: () => { const c = new Fake(); conns.push(c); return c; } };
  const hub = new Hub(join(dir, "acc"), [factory], store, { dataKey: key, backup: { paths: "any" } });
  const call = (m: string, p?: unknown) => hub.call(m, p) as Promise<any>;
  const acc = (await call("addAccount", { provider: "signal" })).id as string; conns[0]!.emit({ type: "account", data: { id: acc, state: "connected" } });
  return { dir, store, hub, call, acc };
}

test("SQLite: import, history, attachment bytes from the sealed media cache, idempotent re-import", async () => {
  const t = await setup(), f = join(t.dir, "a.backup"), s = writeSynthetic(f, "message");
  const r = await t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: t.acc });
  assert.equal(r.messages.added, s.totalImported); assert.equal(r.attachments.stored, 3);
  const h: Message[] = await t.call("history", { chatId: `${t.acc}:${groupId}`, limit: 50 });
  assert.equal(h.find((m) => m.text === "look at this")!.attachments!.length, 2);
  const m = h.find((x) => x.text === "look at this")!, a = await t.call("attachment", { chatId: m.chatId, messageId: m.id, attachmentId: m.attachments![0]!.id });
  assert.ok(Buffer.from(a.dataBase64, "base64").length > 0);
  const n = t.store.countRecords().message;
  const r2 = await t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: t.acc });
  assert.equal(r2.messages.added, 0); assert.equal(t.store.countRecords().message, n);
  assert.ok((await t.call("snapshot")).chats.some((c: any) => c.id === `${t.acc}:${groupId}` && c.name === "Hikers"));
});

test("SQLite: cancel rolls the whole transaction back", async () => {
  const t = await setup(), f = join(t.dir, "big.backup"); writeBig(f, 5000);
  let n = 0; t.hub.subscribe((e, d: any) => { if (e === "backup-progress" && d.op === "signal-import" && d.stage === "importing" && d.done > 0 && ++n === 1) void t.call("signalBackupCancel"); });
  await assert.rejects(() => t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: t.acc }), (e: any) => e.code === "cancelled");
  assert.equal(t.store.countRecords().message, 0); assert.equal(t.store.getSetting(`signalImport.chats.${t.acc}`), undefined);
  // existing messages are untouched by a failed/cancelled run
  t.store.putMessages([{ id: `${ids.ANNA}.${T0 + 1}`, chatId: `${t.acc}:${ids.ANNA}`, sender: "A", senderId: ids.ANNA, text: "live", time: new Date(T0 + 1).toISOString(), fromMe: false }]);
  const g = join(t.dir, "b.backup"); writeSynthetic(g, "mms");
  const ok = await t.call("signalBackupImport", { path: g, passphrase: ids.PASS, accountId: t.acc }); assert.ok(ok.messages.added > 0);
  assert.equal(t.store.getMessage(`${t.acc}:${ids.ANNA}`, `${ids.ANNA}.${T0 + 1}`)!.text, "live");
});
