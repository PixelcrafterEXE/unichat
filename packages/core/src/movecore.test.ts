// Hub half of the device-to-device move (the primitives the sync service calls): collect a session, install it atomically, roll back on failure.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Hub, type SyncHandler, type SyncHostApi } from "./hub.js";
import { MemoryStore } from "./store.js";
import { NO_CAPABILITIES, type Connector, type ProviderFactory } from "./provider.js";

const SECRET = "SECRET-" + randomBytes(6).toString("hex");
const ctl = { fail: false, started: 0, stopped: 0, state: "connected" as string };
const factory: ProviderFactory = { name: "signal", displayName: "Signal", login: "qr", capabilities: NO_CAPABILITIES,
  create: () => ({ capabilities: NO_CAPABILITIES, async start(emit: (e: any) => void) { if (ctl.fail) throw new Error("refused"); ctl.started++; setTimeout(() => emit({ type: "account", data: { id: "x", state: ctl.state } }), 5); }, async stop() { ctl.stopped++; }, async logout() {}, async submitLogin() {},
    async spaces() { return []; }, async chats() { return []; }, async history() { return []; }, async members() { return []; }, async downloadAttachment() { return { data: new Uint8Array(), mime: "x" }; }, async send() { throw new Error("n/a"); } }) as unknown as Connector,
  async exportSession(dir) { return { files: [{ rel: "portable.key", data: Buffer.from(readFileSync(join(dir, "sealed.bin"), "utf8").replace(/^SEALED:/, "")) }], omit: ["sealed.bin"] }; },
  async importSession(dir) { writeFileSync(join(dir, "sealed.bin"), "SEALED:" + readFileSync(join(dir, "portable.key"), "utf8")); } };
async function hub() {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "mvc-")), dir = join(root, "accounts"), store = new MemoryStore();
  const h = new Hub(dir, [factory], store, { dataKey: new Uint8Array(randomBytes(32)) }); let api!: SyncHostApi;
  h.attachSync((a) => { api = a; return { handles: () => false, call: async () => ({}) } as SyncHandler; }); await h.init();
  return { h, dir, store, api, call: (m: string, p?: any) => h.call(m, p) as Promise<any> };
}
test("moveCollect makes the session portable and changes nothing; moveInstall installs, re-seals and starts; a second install over a live account is refused", async () => {
  const A = await hub(), B = await hub();
  A.store.putAccount({ id: "signal-1", provider: "signal", label: "Alice", status: "active" }); mkdirSync(join(A.dir, "signal-1", "auth"), { recursive: true });
  writeFileSync(join(A.dir, "signal-1", "auth", "creds.json"), SECRET); writeFileSync(join(A.dir, "signal-1", "sealed.bin"), "SEALED:" + SECRET + "-k"); await A.h.reloadFromStore();
  const b = await A.api.moveCollect("signal-1");
  assert.equal(b.provider, "signal"); assert.deepEqual(b.files.map((f) => f.rel).sort(), ["auth/creds.json", "portable.key"]); assert.ok(existsSync(join(A.dir, "signal-1", "sealed.bin")), "the source is untouched");
  await B.api.moveInstall("signal-1", b.provider, b.label, b.files, { settleMs: 200 });
  assert.equal(readFileSync(join(B.dir, "signal-1", "sealed.bin"), "utf8"), "SEALED:" + SECRET + "-k"); assert.equal(B.store.listAccounts()[0].status, "active");
  assert.equal(ctl.started, 1); assert.equal((await B.call("accounts"))[0].state, "connected");
  await assert.rejects(B.api.moveInstall("signal-1", b.provider, b.label, b.files), /already signed in/);
});
test("moveInstall is all or nothing: a connector that does not start, a refused login and an unsafe path leave the previous state (archive / nothing) behind", async () => {
  const B = await hub(); const files = [{ rel: "auth/creds.json", data: Buffer.from(SECRET) }, { rel: "portable.key", data: Buffer.from("k") }];
  ctl.fail = true; await assert.rejects(B.api.moveInstall("signal-2", "signal", "New", files), /refused/); ctl.fail = false;
  assert.equal(B.store.listAccounts().length, 0, "an account that did not exist before does not exist after"); assert.ok(!existsSync(join(B.dir, "signal-2")));
  B.store.putAccount({ id: "signal-3", provider: "signal", label: "Old", status: "archived" }); await B.h.reloadFromStore(); mkdirSync(join(B.dir, "signal-3")); writeFileSync(join(B.dir, "signal-3", "old.txt"), "old");
  ctl.state = "needs-login"; await assert.rejects(B.api.moveInstall("signal-3", "signal", "Old", files, { settleMs: 300 }), /did not accept the login/); ctl.state = "connected";
  assert.equal(B.store.listAccounts().find((a) => a.id === "signal-3")?.status, "archived", "back to the read-only archive"); assert.equal(readFileSync(join(B.dir, "signal-3", "old.txt"), "utf8"), "old", "what was there is restored");
  assert.ok(!existsSync(join(B.dir, "signal-3", "auth")), "no new secret left behind"); assert.deepEqual(readdirSync(B.dir).filter((n) => n.startsWith(".move-")), []);
  await assert.rejects(B.api.moveInstall("signal-4", "signal", "Evil", [{ rel: "../escape", data: Buffer.from("x") }]), /unsafe/);
  await assert.rejects(B.api.moveInstall("signal-5", "nope", "X", files), /cannot run/);
});
test("moveInstall over a history copy (archived row with messages) keeps the messages and flips the account to active", async () => {
  const B = await hub(); B.store.putAccount({ id: "signal-7", provider: "signal", label: "Mirror", status: "archived" });
  B.store.putMessages([{ id: "m1", chatId: "signal-7:c", sender: "Bob", senderId: "bob", text: "kept", time: "2026-01-01T00:00:00Z", fromMe: false }]); await B.h.reloadFromStore();
  await B.api.moveInstall("signal-7", "signal", "Mirror", [{ rel: "auth/creds.json", data: Buffer.from("x") }, { rel: "portable.key", data: Buffer.from("k") }], { settleMs: 100 });
  assert.equal(B.store.listAccounts()[0].status, "active"); assert.equal(B.store.getMessage("signal-7:c", "m1")?.text, "kept");
});
