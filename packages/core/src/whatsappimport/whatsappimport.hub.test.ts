// Hub-level tests of the WhatsApp history import (synthetic crypt15/crypt14 backups only; temp dirs honour TMPDIR and are removed afterwards).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../hub.js";
import { MemoryStore } from "../store.js";
import { NO_CAPABILITIES, type Connector, type CoreEvent, type ProviderFactory } from "../provider.js";
import type { Message } from "../model.js";
import { writeSyntheticBackup, jid, PNG, VOICE, T0 } from "./fixture.js";

const made: string[] = [];
const mk = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const rejects = (f: () => Promise<unknown>, code: string, re?: RegExp) => assert.rejects(f, (e: any) => { assert.equal(e.code, code, e.message); if (re) assert.match(e.message, re); return true; });

class FakeWa implements Connector {
  capabilities = NO_CAPABILITIES; emit: (e: CoreEvent) => void = () => {};
  maps: { own: string[]; lidToPn?(l: string): string | undefined } | undefined = { own: [jid.ME] };
  async start(emit: (e: CoreEvent) => void) { this.emit = emit; } async stop() {} async logout() {} async submitLogin() {}
  async spaces() { return []; } async chats() { return []; } async history() { return []; } async members() { return []; }
  async downloadAttachment(): Promise<any> { throw new Error("provider has nothing"); }
  async send(): Promise<Message> { throw new Error("n/a"); }
  importMaps() { return this.maps; }
}
function setup(backup: any = { paths: "any" }) {
  const dir = mk("waimp-hub-"), conns: FakeWa[] = [], store = new MemoryStore();
  const factory: ProviderFactory = { name: "whatsapp", displayName: "WhatsApp", login: "qr", capabilities: NO_CAPABILITIES, create: () => { const c = new FakeWa(); conns.push(c); return c; } };
  const hub = new Hub(join(dir, "data"), [factory], store, { backup });
  const call = (m: string, p?: unknown) => hub.call(m, p) as Promise<any>;
  const events: { e: string; d: any }[] = []; hub.subscribe((e, d) => events.push({ e, d }));
  return { hub, store, conns, call, dir, data: join(dir, "data"), events };
}
type T = ReturnType<typeof setup>;
async function linked(t: T) { const acc = await t.call("addAccount", { provider: "whatsapp" }); t.conns[0]!.emit({ type: "account", data: { id: acc.id, state: "connected" } }); return acc.id as string; }
const msgs = async (t: T, chat: string): Promise<Message[]> => (await t.call("history", { chatId: chat, limit: 500 })).filter((m: Message) => !(m.system && m.system.kind !== "info"));
const mediaFiles = (t: T) => (existsSync(join(t.data, "media")) ? readdirSync(join(t.data, "media")).flatMap((d) => readdirSync(join(t.data, "media", d))) : []);
const strays = (t: T) => (existsSync(join(t.data, ".backup")) ? readdirSync(join(t.data, ".backup")).filter((n) => n.startsWith(".import-")) : []);

test("inspect: counts, chats, media found next to the file, account match, noise counted; writes nothing and leaves no plaintext", async () => {
  const t = setup(), acc = await linked(t), s = await writeSyntheticBackup(t.dir);
  const before = JSON.stringify([...t.store.exportRecords()]);
  const r = await t.call("whatsappBackupInspect", { path: s.file, key: s.keyHex.toUpperCase().replace(/(.{4})/g, "$1 ") });
  assert.equal(r.format, "crypt15"); assert.equal(r.messages, 21); assert.deepEqual(r.chats, { total: 3, dms: 2, groups: 1, unresolved: 0 });
  assert.deepEqual(r.attachments, { count: 4, bytes: PNG.length + VOICE.length + 1234 + 26, present: 3, missing: 1 }); assert.equal(r.canAttachments, true);
  assert.deepEqual(r.accounts.map((a: any) => [a.id, a.match]), [[acc, "match"]]);
  assert.equal(r.skipped["system-59"], 1); assert.equal(r.topChats[0].name, "Hikers"); assert.equal(r.firstAt, new Date(T0 + 1000).toISOString());
  assert.equal(JSON.stringify([...t.store.exportRecords()]), before, "inspect does not write"); assert.deepEqual(strays(t), []);
  await rejects(() => t.call("whatsappBackupInspect", { path: s.file, key: "0".repeat(64) }), "bad-passphrase", /Wrong key/);
  await rejects(() => t.call("whatsappBackupInspect", { path: s.file, key: "12345" }), "bad-passphrase", /64-digit/);
  assert.deepEqual(strays(t), [], "no plaintext copy survives a failed attempt either");
});

test("import: history, ids = WhatsApp key ids, media through the attachment RPC, chat list, no unread/notifications, progress events without secrets", async () => {
  const t = setup(), acc = await linked(t), s = await writeSyntheticBackup(t.dir);
  const res = await t.call("whatsappBackupImport", { path: s.file, key: s.keyHex, accountId: acc, options: { attachments: true } });
  assert.equal(res.messages.added, 21); assert.equal(res.messages.existing, 0); assert.deepEqual(res.attachments, { stored: 2, missing: 1, mismatch: 1, skipped: 0 }); assert.equal(res.chats.created, 3);
  const anna = await msgs(t, `${acc}:${jid.ANNA}`);
  assert.deepEqual(anna.map((m) => m.id), ["AAA1", "BBB2", "IMG3", "DEL4", "LOC5", "VC6", "LID1"]);
  const photo = anna[2]!; assert.equal(photo.attachments![0]!.id, "a0");
  const a = await t.call("attachment", { chatId: photo.chatId, messageId: photo.id, attachmentId: "a0" }); assert.deepEqual(Buffer.from(a.dataBase64, "base64"), PNG);
  const g = await msgs(t, `${acc}:${jid.GROUP}`), vn = g.find((m) => m.id === "VN2")!;
  assert.deepEqual(Buffer.from((await t.call("attachment", { chatId: vn.chatId, messageId: vn.id, attachmentId: "a0" })).dataBase64, "base64"), VOICE);
  assert.equal(g.find((m) => m.id === "IMGMISS")!.text, "[Photo]"); assert.equal(g.find((m) => m.id === "POLL4")!.poll!.options[1]!.voters.length, 2);
  const snap = await t.call("snapshot"), cs = snap.chats.filter((c: any) => c.accountId === acc);
  assert.deepEqual(cs.map((c: any) => [c.id.slice(acc.length + 1), c.kind, c.name, c.disappearing ?? 0]).sort(), [[jid.GROUP, "group", "Hikers", 0], [jid.ANNA, "dm", "+4915111111111", 3600], [jid.CARL, "dm", "+4915133333333", 0]]);
  assert.ok(cs.every((c: any) => !c.unread)); assert.ok(!t.events.some((e) => e.e === "message"), "no live message events");
  assert.ok(t.events.some((e) => e.e === "backup-progress" && e.d.op === "whatsapp-import" && e.d.stage === "finished"));
  assert.ok(!JSON.stringify(t.events).includes(s.keyHex), "the key never appears in an event");
  assert.equal((await t.call("search", { chatId: `${acc}:${jid.ANNA}`, q: "ünïcode" })).length, 1);
  assert.deepEqual(strays(t), []);
});

test("idempotent and merge-safe: a second import adds nothing; live messages with the same id are never overwritten, only completed", async () => {
  const t = setup(), acc = await linked(t), s = await writeSyntheticBackup(t.dir);
  const chat = `${acc}:${jid.ANNA}`;
  t.store.putMessages([{ id: "AAA1", chatId: chat, accountId: acc, sender: "Anna (live)", senderId: jid.ANNA, text: "LIVE TEXT", time: new Date(T0 + 1000).toISOString(), fromMe: false },
    { id: "DEL4", chatId: chat, accountId: acc, sender: "Anna", senderId: jid.ANNA, text: "", time: new Date(T0 + 4000).toISOString(), fromMe: false, deleted: true }]);
  const r1 = await t.call("whatsappBackupImport", { path: s.file, key: s.keyHex, accountId: acc });
  assert.equal(r1.messages.added, 19); assert.equal(r1.messages.existing, 2);
  const h = await msgs(t, chat); assert.equal(h.find((m) => m.id === "AAA1")!.text, "LIVE TEXT"); assert.equal(h.find((m) => m.id === "AAA1")!.sender, "Anna (live)");
  const snap = () => JSON.stringify([...t.store.exportRecords()].filter((x) => x.t === "message" || x.t === "setting").map((x: any) => JSON.stringify(x)).sort()); const a = snap(), files = mediaFiles(t).length;
  const r2 = await t.call("whatsappBackupImport", { path: s.file, key: s.keyHex, accountId: acc });
  assert.equal(r2.messages.added, 0); assert.equal(r2.messages.filled, 0); assert.equal(r2.messages.existing, 21); assert.equal(snap(), a, "store unchanged"); assert.equal(mediaFiles(t).length, files);
});

test("attachments off / date range / media folder choices", async () => {
  const t = setup(), acc = await linked(t), s = await writeSyntheticBackup(t.dir);
  const r = await t.call("whatsappBackupImport", { path: s.file, key: s.keyHex, accountId: acc, options: { attachments: false, since: new Date(T0 + 10_000).toISOString() } });
  assert.equal(r.attachments.stored, 0); assert.equal(mediaFiles(t).length, 0); assert.ok(r.messages.added < 21 && r.messages.added > 5);
  const t2 = setup(), a2 = await linked(t2), s2 = await writeSyntheticBackup(t2.dir, { noMedia: true });
  const i = await t2.call("whatsappBackupInspect", { path: s2.file, key: s2.keyHex }); assert.equal(i.canAttachments, false);
  const r2 = await t2.call("whatsappBackupImport", { path: s2.file, key: s2.keyHex, accountId: a2 }); assert.equal(r2.attachments.stored, 0);
  // media copied somewhere else is picked by naming its folder
  const t3 = setup(), a3 = await linked(t3), s3 = await writeSyntheticBackup(t3.dir), other = join(t3.dir, "elsewhere", "Databases"); (await import("node:fs")).mkdirSync(other, { recursive: true });
  const copy = join(other, "msgstore.db.crypt15"); writeFileSync(copy, readFileSync(s3.file));
  assert.equal((await t3.call("whatsappBackupInspect", { path: copy, key: s3.keyHex })).canAttachments, false);
  assert.equal((await t3.call("whatsappBackupInspect", { path: copy, key: s3.keyHex, mediaPath: s3.root })).canAttachments, true);
  await rejects(() => t3.call("whatsappBackupInspect", { path: copy, key: s3.keyHex, mediaPath: other }), "invalid", /no Media folder/);
  assert.equal((await t3.call("whatsappBackupImport", { path: copy, key: s3.keyHex, accountId: a3, mediaPath: s3.root })).attachments.stored, 2);
});

test("account check: another number needs a confirmation; a signed-out account is unverified and needs one too", async () => {
  const t = setup(), acc = await linked(t), s = await writeSyntheticBackup(t.dir, { jidSuffix: "77" });
  assert.equal((await t.call("whatsappBackupInspect", { path: s.file, key: s.keyHex })).accounts[0].match, "mismatch");
  await rejects(() => t.call("whatsappBackupImport", { path: s.file, key: s.keyHex, accountId: acc }), "invalid", /different WhatsApp number/); assert.equal(t.store.countRecords().message, 0);
  assert.equal((await t.call("whatsappBackupImport", { path: s.file, key: s.keyHex, accountId: acc, confirmMismatch: true })).messages.added, 21);
  const t2 = setup(), a2 = await linked(t2), s2 = await writeSyntheticBackup(t2.dir); t2.conns[0]!.maps = undefined;
  assert.equal((await t2.call("whatsappBackupInspect", { path: s2.file, key: s2.keyHex })).accounts[0].match, "unknown");
  await rejects(() => t2.call("whatsappBackupImport", { path: s2.file, key: s2.keyHex, accountId: a2 }), "invalid", /cannot check/);
  const r = await t2.call("whatsappBackupImport", { path: s2.file, key: s2.keyHex, accountId: a2, confirmUnverified: true }); assert.ok(r.warnings.some((w: string) => /not signed in/.test(w)));
  await rejects(() => t.call("whatsappBackupImport", { path: s.file, key: s.keyHex, accountId: "nope" }), "invalid", /Choose the WhatsApp account/);
});

test("live identity and LID map decide ids: own messages carry the account's own jid, LID chats fold into the phone-number chat", async () => {
  const t = setup(), acc = await linked(t), s = await writeSyntheticBackup(t.dir); t.conns[0]!.maps = { own: ["4915100000001@s.whatsapp.net", "99@lid"], lidToPn: (l) => (l === "111222333@lid" ? jid.ANNA : undefined) };
  await t.call("whatsappBackupImport", { path: s.file, key: s.keyHex, accountId: acc });
  const m = (await msgs(t, `${acc}:${jid.ANNA}`)).find((x) => x.id === "BBB2")!; assert.equal(m.senderId, jid.ME); assert.equal(await t.call("snapshot").then((x: any) => x.chats.some((c: any) => c.id.includes("@lid"))), false);
});

test("crypt14: needs the 158-byte key file (documented as root-only); with it the import works; crypt15 key on crypt14 fails cleanly", async () => {
  const t = setup(), acc = await linked(t), s = await writeSyntheticBackup(t.dir, { kind: 14 });
  await rejects(() => t.call("whatsappBackupInspect", { path: s.file, key: "a".repeat(64) }), "bad-passphrase", /root/);
  const kf = readFileSync(join(t.dir, "key")).toString("base64");
  assert.equal((await t.call("whatsappBackupInspect", { path: s.file, keyFileBase64: kf })).format, "crypt14");
  assert.equal((await t.call("whatsappBackupImport", { path: s.file, keyFileBase64: kf, accountId: acc, confirmUnverified: true, confirmMismatch: true })).messages.added, 21);
});

test("path policy: with UNIMSG_BACKUP_DIR semantics a backup or media folder outside the managed folder is refused", async () => {
  const t = setup({ paths: "dir", dir: join(mk("waimp-bk-"), "b") }), acc = await linked(t), s = await writeSyntheticBackup(t.dir);
  await rejects(() => t.call("whatsappBackupInspect", { path: s.file, key: s.keyHex }), "invalid", /backup files must be inside/);
  const none = setup({ paths: "none" }); await linked(none);
  await rejects(() => none.call("whatsappBackupInspect", { path: s.file, key: s.keyHex }), "invalid", /does not accept file paths/);
  void acc;
});

test("cancel: rolls everything back (messages, chat list, media) and leaves no plaintext; a new import works afterwards", async () => {
  const t = setup(), acc = await linked(t), s = await writeSyntheticBackup(t.dir, { bigN: 30_000 });
  let go = false; t.hub.subscribe((e, d: any) => { if (e === "backup-progress" && d.op === "whatsapp-import" && d.stage === "importing" && d.done > 1000 && !go) { go = true; void t.call("whatsappBackupCancel"); } });
  await rejects(() => t.call("whatsappBackupImport", { path: s.file, key: s.keyHex, accountId: acc }), "cancelled", /Cancelled/);
  assert.equal(t.store.countRecords().message, 0); assert.equal(mediaFiles(t).length, 0); assert.deepEqual(strays(t), []); assert.equal(t.store.getSetting(`whatsappImport.chats.${acc}`), undefined);
  const r = await t.call("whatsappBackupImport", { path: s.file, key: s.keyHex, accountId: acc }); assert.equal(r.messages.added, 21 + 30_000);
  assert.equal((await t.call("whatsappBackupCancel")).cancelled, false);
});

test("a hundred thousand messages stream through without trouble (50k here)", async () => {
  const t = setup(), acc = await linked(t), s = await writeSyntheticBackup(t.dir, { bigN: 50_000 }); const t0 = Date.now();
  const r = await t.call("whatsappBackupImport", { path: s.file, key: s.keyHex, accountId: acc });
  assert.equal(r.messages.added, 50_021); assert.ok(Date.now() - t0 < 60_000, "took " + (Date.now() - t0));
});
