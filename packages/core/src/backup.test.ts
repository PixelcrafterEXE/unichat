import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Hub } from "./hub.js";
import { MemoryStore } from "./store.js";
import { MediaCache } from "./media.js";
import { BackupError } from "./container.js";
import { NO_CAPABILITIES, type Connector, type CoreEvent, type ProviderFactory } from "./provider.js";
import type { Message } from "./model.js";

const started: string[] = [];
const factory: ProviderFactory = { name: "fake", displayName: "Fake", login: "qr", capabilities: NO_CAPABILITIES, create: ({ accountId }) => ({
  capabilities: NO_CAPABILITIES, async start(_e: (e: CoreEvent) => void) { started.push(accountId); }, async stop() {}, async logout() {}, async submitLogin() {},
  async spaces() { return []; }, async chats() { return []; }, async history() { return []; }, async members() { return []; },
  async downloadAttachment() { return { data: new Uint8Array(), mime: "x" }; }, async send() { throw new Error("n/a"); } }) as unknown as Connector };

const KDF = { kdfN: 1 << 14 };
function mk(withData = false) {
  const root = mkdtempSync(join(tmpdir(), "bk-")), dir = join(root, "accounts"), key = new Uint8Array(randomBytes(32)), store = new MemoryStore();
  const hub = new Hub(dir, [factory], store, { dataKey: key, backup: { paths: "any" } });
  const media = new MediaCache(join(dir, "media"), key);
  if (withData) populate(store, dir, media);
  return { hub, store, dir, media, call: (m: string, p?: any) => hub.call(m, p) as Promise<any>, root };
}
const msg = (chat: string, id: string, text: string, time: string, extra: Partial<Message> = {}): Message => ({ id, chatId: chat, sender: "Ann", senderId: "ann", text, time, fromMe: false, ...extra });
function populate(store: MemoryStore, dir: string, media: MediaCache) {
  store.putAccount({ id: "fake-aaaa", provider: "fake", label: "Work", status: "active" });
  store.putAccount({ id: "fake-bbbb", provider: "fake", label: "Private", status: "archived" });
  store.addAccountEvent("fake-aaaa", "linked", "2026-01-01T00:00:00Z");
  store.putMessages([msg("fake-aaaa:ann", "m1", "hello", "2026-01-01T10:00:00Z", { attachments: [{ id: "att1", kind: "image", mime: "image/png", name: "p.png" }] }),
    msg("fake-aaaa:ann", "m2", "world", "2026-01-01T10:01:00Z", { reactions: [{ emoji: "x", senderIds: ["me"], mine: true }] }), msg("fake-bbbb:bob", "b1", "hi bob", "2026-01-02T10:00:00Z")]);
  store.setAlias("fake-aaaa:ann", "Annie"); store.setChatFlags("fake-aaaa:ann", { pinned: true });
  store.putFolder({ id: "folder:1", name: "Fam" }); store.setChatFolder("fake-bbbb:bob", "folder:1");
  store.putMerge({ id: "merge:1", members: ["fake-aaaa:ann", "fake-bbbb:bob"], primary: "fake-aaaa:ann", createdAt: "2026-01-01T00:00:00Z" });
  store.putChatCache("fake-aaaa", { chats: [{ id: "fake-aaaa:ann", accountId: "fake-aaaa", provider: "fake", kind: "dm", name: "Ann" }], spaces: [] });
  store.setSetting("railOrder", "[]");
  store.setSetting("userCategories", '{"personal":[{"id":"cat:1","name":"Fam","order":0}]}'); store.setSetting("chatCategories", '{"fake-aaaa:ann":"cat:1"}'); // user categories (categories.ts)
  media.put("fake-aaaa", "fake-aaaa:ann|m1|att1", { data: new Uint8Array([1, 2, 3, 4]), mime: "image/png", name: "p.png" });
  mkdirSync(join(dir, "fake-aaaa", "auth"), { recursive: true }); writeFileSync(join(dir, "fake-aaaa", "auth", "creds.json"), '{"secret":1}'); writeFileSync(join(dir, "fake-aaaa", "x.tmp"), "junk");
  mkdirSync(join(dir, "fake-aaaa", "avatars"), { recursive: true }); writeFileSync(join(dir, "fake-aaaa", "avatars", "a.jpg"), "cache");
}
const PASS = "a long passphrase";
async function exportTo(src: ReturnType<typeof mk>, parts: any, extra: any = {}) {
  const file = join(src.root, `out-${Math.random().toString(36).slice(2)}.unimsg-backup`);
  const r = await src.call("exportData", { passphrase: PASS, parts, targetPath: file, ...KDF, ...extra }); return { file, r };
}
const snap = (s: MemoryStore) => JSON.stringify([...s.exportRecords()].filter((r) => r.t !== "event"));

test("new-install restore: messages, settings, media; accounts arrive read-only; no session by default", async () => {
  const src = mk(true); const { file, r } = await exportTo(src, { media: true });
  assert.ok(r.size > 0 && /^[0-9a-f]{64}$/.test(r.sha256)); assert.equal(r.manifest.parts.sessions, false);
  const dst = mk(); const events: any[] = []; dst.hub.subscribe((e, d) => e === "backup-progress" && events.push(d));
  const insp = await dst.call("importInspect", { path: file, passphrase: PASS });
  assert.equal(insp.suggestedMode, "new-install"); assert.equal(insp.manifest.counts.message, 3);
  const res = await dst.call("importData", { path: file, passphrase: PASS, mode: "new-install" });
  assert.equal(res.messages.added, 3); assert.equal(res.needSignIn, 2); assert.deepEqual(res.moved, []);
  assert.ok(events.some((e) => e.stage === "verifying") && events.some((e) => e.stage === "finished"));
  const norm = (s: MemoryStore) => JSON.parse(snap(s)).map((r: any) => (r.t === "account" ? { ...r, v: { ...r.v, status: "x" } } : r));
  assert.deepEqual(norm(dst.store), norm(src.store));
  assert.equal(dst.store.getSetting("userCategories"), src.store.getSetting("userCategories")); assert.equal(dst.store.getSetting("chatCategories"), src.store.getSetting("chatCategories")); // user categories ride along
  assert.ok(dst.store.listAccounts().every((a) => a.status === "archived"));
  assert.ok(!existsSync(join(dst.dir, "fake-aaaa", "auth")), "no session files without the sessions part");
  const m = new MediaCache(join(dst.dir, "media"), (dst.hub as any).backup.h.dataKey).get("fake-aaaa", "fake-aaaa:ann|m1|att1");
  assert.deepEqual([...m!.data], [1, 2, 3, 4]); // re-sealed with the target key
  const accs = await dst.call("accounts"); assert.ok(accs.every((a: any) => a.state === "signed-out"));
  assert.ok(readdirSync(dst.dir).every((n) => !n.startsWith(".import")));
  assert.equal((await dst.call("history", { chatId: "fake-aaaa:ann" })).some((x: any) => x.text === "hello"), true);
});

test("new-install refuses a non-empty target; wrong passphrase / tampering leave the target untouched", async () => {
  const src = mk(true); const { file } = await exportTo(src, {});
  const dst = mk(true);
  await assert.rejects(dst.call("importData", { path: file, passphrase: PASS, mode: "new-install" }), (e: BackupError) => e.code === "not-empty");
  const before = snap(dst.store);
  await assert.rejects(dst.call("importData", { path: file, passphrase: "wrong wrong", mode: "merge" }), (e: BackupError) => e.code === "bad-passphrase");
  const raw = readFileSync(file); raw[raw.length - 60] ^= 1; const bad = file + ".bad"; writeFileSync(bad, raw);
  await assert.rejects(dst.call("importData", { path: bad, passphrase: PASS, mode: "merge" }), BackupError);
  writeFileSync(bad, readFileSync(file).subarray(0, 300));
  await assert.rejects(dst.call("importData", { path: bad, passphrase: PASS, mode: "merge" }), BackupError);
  assert.equal(snap(dst.store), before);
});

test("merge: dedupes by id, never overwrites, matches accounts by provider+label, adds the rest archived", async () => {
  const src = mk(true); const { file } = await exportTo(src, { media: true });
  const dst = mk();
  dst.store.putAccount({ id: "fake-zzzz", provider: "fake", label: "work", status: "active" }); // same provider+label, other id
  dst.store.putMessages([msg("fake-zzzz:ann", "m1", "LOCAL TEXT", "2026-01-01T10:00:00Z")]);
  dst.store.setAlias("fake-zzzz:ann", "Mine");
  const res = await dst.call("importData", { path: file, passphrase: PASS, mode: "merge" });
  const plan = Object.fromEntries(res.accounts.map((a: any) => [a.src, a]));
  assert.equal(plan["fake-aaaa"].outcome, "matched"); assert.equal(plan["fake-aaaa"].dst, "fake-zzzz"); assert.equal(plan["fake-bbbb"].outcome, "added");
  assert.equal(dst.store.getMessage("fake-zzzz:ann", "m1")!.text, "LOCAL TEXT");
  assert.equal(dst.store.getMessage("fake-zzzz:ann", "m2")!.text, "world");
  assert.equal(dst.store.getMessage("fake-bbbb:bob", "b1")!.text, "hi bob");
  assert.equal(dst.store.listAliases()["fake-zzzz:ann"], "Mine");
  assert.equal(dst.store.listAccounts().find((a) => a.id === "fake-zzzz")!.status, "active");
  assert.equal(dst.store.listAccounts().find((a) => a.id === "fake-bbbb")!.status, "archived");
  assert.deepEqual(dst.store.listMerges()[0].members, ["fake-zzzz:ann", "fake-bbbb:bob"]);
  assert.equal(res.messages.existing, 1);
  // importing the same archive again adds nothing
  const again = await dst.call("importData", { path: file, passphrase: PASS, mode: "merge" });
  assert.equal(again.messages.added, 0); assert.equal(dst.store.listMerges().length, 1);
});

test("sessions included: files restored, accounts flagged moved and started only after confirmation", async () => {
  const src = mk(true); const { file } = await exportTo(src, { sessions: true });
  const dst = mk(); started.length = 0;
  const res = await dst.call("importData", { path: file, passphrase: PASS, mode: "new-install" });
  assert.deepEqual(res.moved, ["fake-aaaa"]); assert.equal(res.sessionFiles, 1);
  assert.equal(readFileSync(join(dst.dir, "fake-aaaa", "auth", "creds.json"), "utf8"), '{"secret":1}');
  assert.ok(!existsSync(join(dst.dir, "fake-aaaa", "x.tmp")) && !existsSync(join(dst.dir, "fake-aaaa", "avatars")), "temp/cache files are not exported");
  assert.deepEqual(started, []);
  assert.equal((await dst.call("movedAccounts")).length, 1);
  await dst.call("confirmMovedAccount", { accountId: "fake-aaaa" });
  assert.deepEqual(started, ["fake-aaaa"]); assert.equal((await dst.call("movedAccounts")).length, 0);
  // dismiss path
  const d2 = mk(); await d2.call("importData", { path: file, passphrase: PASS, mode: "new-install" });
  await d2.call("dismissMovedAccount", { accountId: "fake-aaaa" });
  assert.ok(!existsSync(join(d2.dir, "fake-aaaa")));
});

test("one-account transfer: session-only archive, source moves away without remote logout", async () => {
  const src = mk(true); await src.hub.init();
  const { file } = await exportTo(src, { data: false, sessions: true }, { accountIds: ["fake-aaaa"] });
  const dst = mk(); dst.store.putAccount({ id: "fake-aaaa", provider: "fake", label: "Work", status: "archived" }); await dst.hub.init();
  const ins = await dst.call("importInspect", { path: file, passphrase: PASS });
  assert.equal(ins.manifest.counts.message, 3); assert.equal(ins.accounts.length, 1);
  const res = await dst.call("importData", { path: file, passphrase: PASS, mode: "merge" });
  assert.deepEqual(res.moved, ["fake-aaaa"]); assert.equal(res.messages.added, 0);
  assert.ok(existsSync(join(dst.dir, "fake-aaaa", "auth", "creds.json")));
  await assert.rejects(src.call("moveAwayAccount", { accountId: "fake-aaaa" }), BackupError); // needs confirmation
  await src.call("moveAwayAccount", { accountId: "fake-aaaa", confirmedSaved: true });
  assert.ok(!existsSync(join(src.dir, "fake-aaaa")));
  assert.equal(src.store.listAccounts().find((a) => a.id === "fake-aaaa")!.status, "archived");
  assert.equal(src.store.getMessage("fake-aaaa:ann", "m1")!.text, "hello"); // archive kept
});

test("path policy and upload/download tickets", async () => {
  const root = mkdtempSync(join(tmpdir(), "bk-")), dir = join(root, "accounts");
  const hub = new Hub(dir, [factory], new MemoryStore(), { backup: { paths: "dir", maxUploadBytes: 10 } });
  await assert.rejects(hub.call("exportData", { passphrase: PASS, targetPath: "/tmp/evil.unimsg-backup", ...KDF }), BackupError);
  const ok = await hub.call("exportData", { passphrase: PASS, deliver: "download", ...KDF }) as any;
  assert.ok(ok.downloadId && !ok.path);
  const dl = hub.backup.openDownload(ok.downloadId); assert.throws(() => hub.backup.openDownload(ok.downloadId)); dl.done(true);
  assert.throws(() => hub.backup.openDownload(ok.downloadId));
  const up = await hub.call("backupUploadStart", { size: 5 }) as any;
  await hub.call("backupUploadChunk", { id: up.id, dataBase64: Buffer.from("hello world!!").toString("base64") }).then(() => assert.fail(), (e) => assert.equal(e.code, "too-large"));
  await assert.rejects(hub.call("backupUploadStart", { size: 99 }), BackupError);
  await assert.rejects(hub.call("importInspect", { path: "../../etc/passwd", passphrase: PASS }), BackupError);
});

test("export chat as html and json (merged chats too)", async () => {
  const s = mk(true);
  const h = await s.call("exportChat", { chat: "merge:1", format: "html" });
  const html = Buffer.from(h.dataBase64, "base64").toString();
  assert.match(html, /hello/); assert.match(html, /hi bob/); assert.match(html, /data:image\/png;base64/); assert.equal(h.count, 3);
  const j = JSON.parse(Buffer.from((await s.call("exportChat", { chat: "fake-aaaa:ann", format: "json", from: "2026-01-01T10:00:30Z" })).dataBase64, "base64").toString());
  assert.deepEqual(j.messages.map((m: Message) => m.id), ["m2"]);
});

test("provider session hooks: the secret travels in portable form and is re-sealed by the target", async () => {
  const hooked: ProviderFactory = { ...factory, name: "hooked",
    async exportSession(dir) { const sealed = readFileSync(join(dir, "sealed.bin"), "utf8"); return { files: [{ rel: "portable.txt", data: Buffer.from(sealed.replace("SEALED:", "")) }], omit: ["sealed.bin", "sealed.key"] }; },
    async importSession(dir) { writeFileSync(join(dir, "sealed.bin"), "RESEALED:" + readFileSync(join(dir, "portable.txt"), "utf8")); rmSync(join(dir, "portable.txt")); } };
  const mkH = () => { const root = mkdtempSync(join(tmpdir(), "bk-")), dir = join(root, "accounts"), key = new Uint8Array(randomBytes(32)), store = new MemoryStore();
    return { root, dir, store, call: (m: string, p?: any) => hub.call(m, p) as Promise<any>, hub: undefined as any }; };
  const s = mkH(), d = mkH();
  const hub = new Hub(s.dir, [hooked], s.store, { dataKey: new Uint8Array(randomBytes(32)), backup: { paths: "any" } });
  const hub2 = new Hub(d.dir, [hooked], d.store, { dataKey: new Uint8Array(randomBytes(32)), backup: { paths: "any" } });
  s.store.putAccount({ id: "hooked-1", provider: "hooked", label: "H", status: "active" });
  mkdirSync(join(s.dir, "hooked-1"), { recursive: true });
  writeFileSync(join(s.dir, "hooked-1", "sealed.bin"), "SEALED:token-xyz"); writeFileSync(join(s.dir, "hooked-1", "sealed.key"), "k");
  const file = join(s.root, "h.unimsg-backup");
  await hub.call("exportData", { passphrase: PASS, parts: { data: false, sessions: true }, targetPath: file, accountIds: ["hooked-1"], ...KDF });
  const res = await hub2.call("importData", { path: file, passphrase: PASS, mode: "new-install" }) as any;
  assert.deepEqual(res.moved, ["hooked-1"]); assert.deepEqual(res.warnings, []);
  assert.equal(readFileSync(join(d.dir, "hooked-1", "sealed.bin"), "utf8"), "RESEALED:token-xyz");
  assert.deepEqual(readdirSync(join(d.dir, "hooked-1")).sort(), ["sealed.bin"], "sealed key and portable file are not left behind");
});
