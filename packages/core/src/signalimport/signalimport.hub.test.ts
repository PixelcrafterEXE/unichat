// Hub-level tests of the Signal history import (synthetic backups only; temp dirs honour TMPDIR and are removed afterwards).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../hub.js";
import { MemoryStore } from "../store.js";
import { MediaCache } from "../media.js";
import { NO_CAPABILITIES, type Connector, type CoreEvent, type ProviderFactory } from "../provider.js";
import type { Message } from "../model.js";
import { ids, groupId, writeSynthetic, writeBig, writeSecureBackup, writeSecureFolderBackup, secureFrames, ANNA_PROFILE_KEY, LegacyBackupWriter, T0, PNG, VOICE } from "./fixture.js";

const made: string[] = [];
const mk = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const rejects = (f: () => Promise<unknown>, code: string, re?: RegExp) => assert.rejects(f, (e: any) => { assert.equal(e.code, code, e.message); if (re) assert.match(e.message, re); return true; });

class FakeSignal implements Connector {
  capabilities = NO_CAPABILITIES; emit: (e: CoreEvent) => void = () => {}; identity: { aci: string; number?: string; numberToAci?(n: string): string | undefined } | undefined = { aci: ids.ME.toUpperCase(), number: "+4915100000001" };
  async start(emit: (e: CoreEvent) => void) { this.emit = emit; } async stop() {} async logout() {} async submitLogin() {}
  async spaces() { return []; } async chats() { return []; } async history() { return []; } async members() { return []; }
  async downloadAttachment(): Promise<any> { throw new Error("provider has nothing"); }
  async send(): Promise<Message> { throw new Error("n/a"); }
  importIdentity() { return this.identity; }
  keys = new Map<string, string>(); got: { aci: string; profileKey?: string; name?: string }[][] = [];
  importContacts(list: { aci: string; profileKey?: string; name?: string }[]) { this.got.push(list); let n = 0; for (const c of list) if (c.profileKey && !this.keys.has(c.aci)) { this.keys.set(c.aci, c.profileKey); n++; } return n; }
}
function setup() {
  const dir = mk("sigimp-hub-"), conns: FakeSignal[] = [], store = new MemoryStore();
  const factory: ProviderFactory = { name: "signal", displayName: "Signal", login: "qr", capabilities: NO_CAPABILITIES, create: () => { const c = new FakeSignal(); conns.push(c); return c; } };
  const hub = new Hub(dir, [factory], store, { backup: { paths: "any" } });
  const call = (m: string, p?: unknown) => hub.call(m, p) as Promise<any>;
  const events: { e: string; d: any }[] = []; hub.subscribe((e, d) => events.push({ e, d }));
  return { hub, store, conns, call, dir, events };
}
type T = ReturnType<typeof setup>;
async function linkedAccount(t: T) { const acc = await t.call("addAccount", { provider: "signal" }); t.conns[0]!.emit({ type: "account", data: { id: acc.id, state: "connected" } }); return acc.id as string; }
const msgs = async (t: T, chat: string, limit = 500): Promise<Message[]> => (await t.call("history", { chatId: chat, limit })).filter((m: Message) => !(m.system && m.system.kind !== "info"));
const text = (ms: Message[]) => ms.map((m) => m.text);
const writeFx = (d: string, era: "mms" | "message", o: any = {}) => { const f = join(d, `${era}${o.positional ? "-pos" : ""}.backup`); const s = writeSynthetic(f, era, o); return { f, s }; };
const mediaFiles = (t: T) => (existsSync(join(t.dir, "media")) ? readdirSync(join(t.dir, "media")).flatMap((d) => readdirSync(join(t.dir, "media", d))) : []);

test("inspect: counts, chats, date range, own identity, account match; writes nothing", async () => {
  const t = setup(), acc = await linkedAccount(t); const { f, s } = writeFx(t.dir, "mms");
  const before = JSON.stringify([...t.store.exportRecords()]);
  const r = await t.call("signalBackupInspect", { path: f, passphrase: ids.PASS });
  assert.equal(r.format, "android-legacy"); assert.equal(r.messages, s.totalImported);
  assert.deepEqual(r.chats, { total: 4, dms: 3, groups: 1, unresolved: 1 }); assert.equal(r.attachments.count, 3);
  assert.equal(r.own.aci, ids.ME); assert.equal(r.firstAt, new Date(T0 + 1000).toISOString());
  assert.deepEqual(r.accounts.map((a: any) => [a.id, a.match]), [[acc, "match"]]);
  assert.equal(r.skipped.draft, 1); assert.ok(r.skipped.noise >= 2); assert.equal(r.skipped["legacy-group"], 1); assert.ok(r.warnings.some((w: string) => /old-style/.test(w)));
  assert.equal(JSON.stringify([...t.store.exportRecords()]), before, "inspect does not write");
  await rejects(() => t.call("signalBackupInspect", { path: f, passphrase: "00000 00000 00000 00000 00000 00000" }), "bad-passphrase");
});

test("import (sms/mms/part era): messages, replies, reactions, mentions, edits, deletes, calls, attachments, chats listed", async () => {
  const t = setup(), acc = await linkedAccount(t); const { f, s } = writeFx(t.dir, "mms");
  const res = await t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: acc, options: { attachments: true } });
  assert.equal(res.messages.added, s.totalImported); assert.equal(res.messages.existing, 0); assert.equal(res.attachments.stored, 3); assert.equal(res.chats.created, 4);
  const anna = await msgs(t, `${acc}:${ids.ANNA}`);
  assert.deepEqual(text(anna), ["hi from Anna", "hello Anna, it's me — \"quoted\" and 'single' ünïcode 😀", "Missed voice call", "Disappearing messages set to 1 hour", "photo!"]);
  assert.equal(anna[0]!.id, `${ids.ANNA}.${T0 + 1000}`, "same id scheme as the live provider: author ACI + sent timestamp");
  assert.equal(anna[1]!.id, `${ids.ME}.${T0 + 2000}`); assert.equal(anna[1]!.fromMe, true); assert.equal(anna[1]!.status, "read");
  assert.equal(anna[0]!.time, new Date(T0 + 1000).toISOString()); assert.equal(anna[0]!.sender, "Anna Alder");
  assert.equal(anna[2]!.system?.kind, "info"); assert.equal(anna[3]!.system?.kind, "info");
  const photo = anna[4]!; assert.deepEqual(photo.replyTo, { messageId: `${ids.ME}.${T0 + 2000}`, sender: "Me", textPreview: "hello Anna" });
  assert.deepEqual(photo.reactions, [{ emoji: "👍", senderIds: [ids.ME], mine: true }]);
  assert.equal(photo.attachments![0]!.id, `${photo.id}#0`); assert.equal(photo.attachments![0]!.kind, "image");
  // the bytes are served through the normal `attachment` RPC from the sealed media cache (no provider involved)
  const a = await t.call("attachment", { chatId: photo.chatId, messageId: photo.id, attachmentId: photo.attachments![0]!.id });
  assert.deepEqual(Buffer.from(a.dataBase64, "base64"), PNG); assert.equal(a.mime, "image/png");
  const g = await msgs(t, `${acc}:${groupId}`);
  assert.deepEqual(text(g), ["look at this", "@Bob thanks!", "", "[View-once media - open it in Signal on your phone]", "fixed"]);
  assert.equal(g[0]!.senderId, ids.BOB); assert.equal(g[0]!.attachments!.length, 2); assert.equal(g[0]!.attachments![1]!.kind, "voice");
  assert.deepEqual(g[0]!.reactions!.map((r) => [r.emoji, [...r.senderIds].sort(), !!r.mine]), [["❤️", [ids.ANNA, ids.ME].sort(), true], ["😂", [ids.BOB], false]]);
  assert.equal(g[0]!.replyTo!.messageId, `${ids.ANNA}.${T0 + 1000}`);
  assert.equal(g[2]!.deleted, true); assert.equal(g[4]!.id, `${ids.BOB}.${T0 + 14_000}`, "an edited message keeps the id of its first revision"); assert.equal(g[4]!.editedAt, new Date(T0 + 15_000).toISOString());
  const voice = await t.call("attachment", { chatId: g[0]!.chatId, messageId: g[0]!.id, attachmentId: g[0]!.attachments![1]!.id }); assert.deepEqual(Buffer.from(voice.dataBase64, "base64"), VOICE);
  assert.deepEqual(text(await msgs(t, `${acc}:e164:+4915133333333`)), ["hi, no ACI here"]);
  assert.deepEqual(text(await msgs(t, `${acc}:${ids.ME}`)), ["note to self"]);
  // chat list: imported chats are listed although the provider knows none of them
  const snap = await t.call("snapshot"), names = snap.chats.filter((c: any) => c.accountId === acc).map((c: any) => [c.id.slice(acc.length + 1), c.kind, c.name]);
  assert.ok(names.some((n: any) => n[0] === groupId && n[1] === "group" && n[2] === "Hikers")); assert.ok(names.some((n: any) => n[0] === ids.ANNA && n[2] === "Anna Alder")); assert.equal(names.length, 4);
  assert.ok(snap.chats.every((c: any) => !c.unread), "imported messages never count as unread");
  assert.ok(!t.events.some((e) => e.e === "message"), "no live message events (no notifications, no mesh relay)");
  assert.ok(t.events.some((e) => e.e === "backup-progress" && e.d.op === "signal-import" && e.d.stage === "finished"));
  assert.equal((await t.call("search", { chatId: `${acc}:${ids.ANNA}`, q: "single" })).length, 1, "search index sees the history");
});

test("the 'message'/'attachment' schema generation and positional INSERTs map to the same history", async () => {
  const t1 = setup(), a1 = await linkedAccount(t1), t2 = setup(), a2 = await linkedAccount(t2), t3 = setup(), a3 = await linkedAccount(t3);
  await t1.call("signalBackupImport", { path: writeFx(t1.dir, "mms").f, passphrase: ids.PASS, accountId: a1 });
  await t2.call("signalBackupImport", { path: writeFx(t2.dir, "message").f, passphrase: ids.PASS, accountId: a2 });
  const r3 = await t3.call("signalBackupImport", { path: writeFx(t3.dir, "message", { positional: true }).f, passphrase: ids.PASS, accountId: a3 });
  assert.equal(r3.attachments.stored, 3);
  const norm = async (t: T, a: string) => { const o: any = {}; for (const c of [ids.ANNA, groupId, ids.ME, "e164:+4915133333333"]) o[c] = (await msgs(t, `${a}:${c}`)).map((m) => [m.id, m.text, m.fromMe, m.senderId, !!m.deleted, m.replyTo?.messageId, (m.reactions ?? []).length, (m.attachments ?? []).length]); return o; };
  const n1 = await norm(t1, a1); assert.deepEqual(await norm(t2, a2), n1); assert.deepEqual(await norm(t3, a3), n1);
});

test("a backup without table definitions that uses positional INSERTs is refused with a clear message", async () => {
  const t = setup(), acc = await linkedAccount(t), f = join(t.dir, "nocreate.backup"), w = new LegacyBackupWriter(f, ids.PASS);
  w.version(200); w.keyValue("account.aci", ids.ME); w.statement("INSERT INTO sms VALUES (1,2,3)"); w.statement("INSERT INTO recipient VALUES (1,2)"); w.end(); w.close();
  await rejects(() => t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: acc }), "unsupported-version", /does not describe its tables/);
});

test("merge rules: never overwrite or delete, only fill what is missing; live ids dedupe; re-import adds nothing", async () => {
  const t = setup(), acc = await linkedAccount(t); const { f, s } = writeFx(t.dir, "mms");
  const chat = `${acc}:${ids.ANNA}`, liveId = `${ids.ANNA}.${T0 + 1000}`, own = `${ids.ME}.${T0 + 2000}`, del = `${ids.ANNA}.${T0 + 8000}`;
  t.store.putMessages([{ id: liveId, chatId: chat, accountId: acc, sender: "Anna (live)", senderId: ids.ANNA, text: "LIVE TEXT", time: new Date(T0 + 1000).toISOString(), fromMe: false, reactions: [{ emoji: "🔥", senderIds: [ids.ANNA] }] },
    { id: own, chatId: chat, accountId: acc, sender: "Me", senderId: ids.ME, text: "EDITED", editedAt: "2026-01-01T00:00:00.000Z", time: new Date(T0 + 2000).toISOString(), fromMe: true, status: "delivered" },
    { id: del, chatId: chat, accountId: acc, sender: "Anna", senderId: ids.ANNA, text: "", time: new Date(T0 + 8000).toISOString(), fromMe: false, deleted: true }]);
  const r1 = await t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: acc });
  assert.equal(r1.messages.added, s.totalImported - 3); assert.equal(r1.messages.existing + r1.messages.filled, 3);
  const h = await msgs(t, chat);
  assert.equal(h.find((m) => m.id === liveId)!.text, "LIVE TEXT"); assert.equal(h.find((m) => m.id === own)!.text, "EDITED");
  assert.equal(h.find((m) => m.id === own)!.status, "delivered", "live status kept");
  const d = h.find((m) => m.id === del)!; assert.ok(d.deleted && d.text === "", "deleted stays deleted");
  const snap = () => JSON.stringify([...t.store.exportRecords()].filter((x) => x.t === "message" || x.t === "setting").map((x: any) => JSON.stringify(x)).sort());
  const a = snap();
  const r2 = await t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: acc });
  assert.equal(r2.messages.added, 0, "idempotent"); assert.equal(r2.messages.filled, 0);
  assert.equal(snap(), a, "second run changes nothing in the archive");
});

test("an existing message missing text/attachments/reactions is filled, never replaced", async () => {
  const t = setup(), acc = await linkedAccount(t); const { f } = writeFx(t.dir, "mms");
  const id = `${ids.ANNA}.${T0 + 8000}`, chat = `${acc}:${ids.ANNA}`;
  t.store.putMessages([{ id, chatId: chat, accountId: acc, sender: "A", senderId: ids.ANNA, text: "", time: new Date(T0 + 8000).toISOString(), fromMe: false, reactions: [{ emoji: "😮", senderIds: [ids.ANNA] }] }]);
  const r = await t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: acc });
  assert.equal(r.messages.filled, 1);
  const m = t.store.getMessage(chat, id)!; assert.equal(m.text, "photo!"); assert.equal(m.attachments!.length, 1); assert.deepEqual(m.reactions!.map((x) => x.emoji).sort(), ["😮", "👍"].sort()); assert.equal(m.sender, "A");
});

test("options: attachments off keeps text, date range limits what is imported", async () => {
  const t = setup(), acc = await linkedAccount(t); const { f } = writeFx(t.dir, "mms");
  const r = await t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: acc, options: { attachments: false, since: new Date(T0 + 7500).toISOString(), until: new Date(T0 + 10_500).toISOString() } });
  assert.equal(r.messages.added, 2); assert.equal(r.attachments.stored, 0); assert.equal(r.attachments.skipped, 3);
  const photo = (await msgs(t, `${acc}:${ids.ANNA}`))[0]!; assert.equal(photo.text, "photo!"); assert.equal(photo.attachments, undefined);
  assert.equal((await msgs(t, `${acc}:${groupId}`))[0]!.attachments, undefined); assert.equal(mediaFiles(t).length, 0, "no media written");
});

test("account checks: another account's backup needs explicit confirmation; a signed-out account cannot be verified", async () => {
  const t = setup(), acc = await linkedAccount(t); const { f } = writeFx(t.dir, "mms");
  t.conns[0]!.identity = { aci: "0f0f0f0f-0000-4000-8000-00000000ffff" };
  assert.equal((await t.call("signalBackupInspect", { path: f, passphrase: ids.PASS })).accounts[0].match, "mismatch");
  await rejects(() => t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: acc }), "invalid", /different Signal account/);
  assert.equal(t.store.countRecords().message, 0);
  const r = await t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: acc, confirmMismatch: true }); assert.ok(r.warnings.some((w: string) => /different account/.test(w)));
  const u = setup(), a2 = await linkedAccount(u); u.conns[0]!.identity = undefined; const g = writeFx(u.dir, "mms").f;
  assert.equal((await u.call("signalBackupInspect", { path: g, passphrase: ids.PASS })).accounts[0].match, "unknown");
  await rejects(() => u.call("signalBackupImport", { path: g, passphrase: ids.PASS, accountId: a2 }), "invalid", /not signed in/);
  const ok = await u.call("signalBackupImport", { path: g, passphrase: ids.PASS, accountId: a2, confirmUnverified: true }); assert.ok(ok.messages.added > 0);
  await rejects(() => u.call("signalBackupImport", { path: g, passphrase: ids.PASS, accountId: "nope" }), "invalid", /Choose the Signal account/);
});

test("wrong passphrase / corrupted file: error, archive and media untouched", async () => {
  const t = setup(), acc = await linkedAccount(t); const { f } = writeFx(t.dir, "mms");
  await rejects(() => t.call("signalBackupImport", { path: f, passphrase: "99999 99999 99999 99999 99999 99999", accountId: acc }), "bad-passphrase", /Wrong passphrase/);
  const raw = readFileSync(f), bad = join(t.dir, "bad.backup"); raw[raw.length - 200]! ^= 0xff; writeFileSync(bad, raw);
  await rejects(() => t.call("signalBackupImport", { path: bad, passphrase: ids.PASS, accountId: acc }), "corrupt");
  assert.equal(t.store.countRecords().message, 0); assert.equal(mediaFiles(t).length, 0);
});

test("cancel mid-import: everything rolled back, a later import works", async () => {
  const t = setup(), acc = await linkedAccount(t), f = join(t.dir, "big.backup"); writeBig(f, 3000);
  let n = 0; t.hub.subscribe((e, d: any) => { if (e === "backup-progress" && d.op === "signal-import" && d.stage === "importing" && d.done > 0 && ++n === 1) void t.call("signalBackupCancel"); });
  await rejects(() => t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: acc }), "cancelled");
  assert.equal(t.store.countRecords().message, 0, "nothing committed"); assert.equal(t.store.getSetting(`signalImport.chats.${acc}`), undefined);
  const { f: g } = writeFx(t.dir, "mms"); const ok = await t.call("signalBackupImport", { path: g, passphrase: ids.PASS, accountId: acc }); assert.ok(ok.messages.added > 0, "the job lock was released");
});

test("a failure after attachments were written removes them again and leaves the archive untouched", async () => {
  const t = setup(), acc = await linkedAccount(t); const { f } = writeFx(t.dir, "mms");
  const set = t.store.setSetting.bind(t.store); t.store.setSetting = ((k: string, v: string) => { if (k.startsWith("signalImport.chats.")) throw new Error("disk full"); set(k, v); }) as any;
  await assert.rejects(() => t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: acc }), /disk full/);
  assert.equal(t.store.countRecords().message, 0); assert.equal(mediaFiles(t).length, 0, "orphaned media removed");
});

test("memory stays flat on a large backup: 200k messages streamed", { timeout: 900_000 }, async () => {
  const t = setup(), acc = await linkedAccount(t), f = join(t.dir, "huge.backup"); writeBig(f, 200_000);
  const fileMb = statSync(f).size / 1024 / 1024; assert.ok(fileMb > 20, "the fixture is big: " + fileMb.toFixed(0) + " MB");
  const peakOf = async <R>(run: () => Promise<R>) => { const base = process.memoryUsage().rss; let peak = base; const tk = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20); try { return { r: await run(), grown: (peak - base) / 1024 / 1024 }; } finally { clearInterval(tk); } };
  const ins = await peakOf(() => t.call("signalBackupInspect", { path: f, passphrase: ids.PASS }));
  assert.equal(ins.r.messages, 200_000);
  console.log(`  inspect: ${fileMb.toFixed(0)} MB file, 200k messages, rss grew ${ins.grown.toFixed(0)} MB`);
  assert.ok(ins.grown < 150, `inspect streams: grew ${ins.grown.toFixed(0)} MB for a ${fileMb.toFixed(0)} MB file`);
  const imp = await peakOf(() => t.call("signalBackupImport", { path: f, passphrase: ids.PASS, accountId: acc }));
  assert.equal(imp.r.messages.added, 200_000);
  console.log(`  import:  rss grew ${imp.grown.toFixed(0)} MB (includes the in-memory test store holding all 200k messages)`);
});

test("Secure Backup (new format): container authenticated and decrypted, libsignal JSON mapped, wrong key / account refused", { timeout: 120_000 }, async () => {
  const { AccountEntropyPool } = await import("@signalapp/libsignal-client/dist/AccountKeys.js");
  const aep = AccountEntropyPool.generate(), t = setup(), acc = await linkedAccount(t), f = join(t.dir, "x.binary");
  await writeSecureBackup(f, aep, ids.ME, secureFrames(), { padding: 100 });
  const ins = await t.call("signalBackupInspect", { path: f, passphrase: aep, accountId: acc });
  assert.equal(ins.format, "secure-backup"); assert.equal(ins.messages, 3); assert.equal(ins.chats.dms, 2); assert.equal(ins.canAttachments, false, "a single file has no media folder");
  const r = await t.call("signalBackupImport", { path: f, passphrase: aep.toUpperCase().replace(/(.{8})/g, "$1 "), accountId: acc });
  assert.equal(r.messages.added, 3);
  const anna = await msgs(t, `${acc}:${ids.ANNA}`);
  assert.deepEqual(text(anna), ["hello from the new format", "reply from me"]); assert.equal(anna[0]!.id, `${ids.ANNA}.${T0 + 1000}`);
  assert.equal(anna[1]!.fromMe, true); assert.deepEqual(anna[1]!.replyTo, { messageId: `${ids.ANNA}.${T0 + 1000}`, sender: "Anna", textPreview: "hello from the new format" });
  assert.deepEqual(anna[1]!.reactions, [{ emoji: "👍", senderIds: [ids.ANNA] }]);
  assert.deepEqual(text(await msgs(t, `${acc}:${ids.BOB}`)), ["bob here"]);
  await rejects(() => t.call("signalBackupInspect", { path: f, passphrase: AccountEntropyPool.generate(), accountId: acc }), "bad-passphrase");
  await rejects(() => t.call("signalBackupInspect", { path: f, passphrase: aep, aci: ids.ANNA }), "bad-passphrase");
  await rejects(() => t.call("signalBackupInspect", { path: f, passphrase: "short", accountId: acc }), "bad-passphrase");
  const raw = readFileSync(f); raw[40]! ^= 1; const bad = join(t.dir, "bad.binary"); writeFileSync(bad, raw);
  await rejects(() => t.call("signalBackupInspect", { path: bad, passphrase: aep, accountId: acc }), "bad-passphrase");
});

test("Secure Backup import hands the contacts' profile keys to the connector; re-running adds only missing keys and no messages", { timeout: 120_000 }, async () => {
  const { AccountEntropyPool } = await import("@signalapp/libsignal-client/dist/AccountKeys.js");
  const aep = AccountEntropyPool.generate(), t = setup(), acc = await linkedAccount(t), f = join(t.dir, "k.binary");
  await writeSecureBackup(f, aep, ids.ME, secureFrames());
  const r1 = await t.call("signalBackupImport", { path: f, passphrase: aep, accountId: acc });
  assert.deepEqual(r1.contacts, { inBackup: 2, newProfileKeys: 1 });
  const conn = t.conns[0]!; assert.equal(conn.keys.get(ids.ANNA), ANNA_PROFILE_KEY.toString("base64")); assert.equal(conn.keys.has(ids.BOB), false, "Bob has no key in the fixture");
  const r2 = await t.call("signalBackupImport", { path: f, passphrase: aep, accountId: acc });
  assert.equal(r2.messages.added, 0); assert.equal(r2.messages.existing, 3); assert.deepEqual(r2.contacts, { inBackup: 2, newProfileKeys: 0 });
});

test("the test encoder's container is accepted by libsignal's own validate(): MAC, AES-CBC, gzip and BackupInfo pass (it stops at semantic AccountData rules)", { timeout: 60_000 }, async () => {
  const { AccountEntropyPool } = await import("@signalapp/libsignal-client/dist/AccountKeys.js");
  const { MessageBackupKey, validate, Purpose } = await import("@signalapp/libsignal-client/dist/MessageBackup.js"); const { Aci } = await import("@signalapp/libsignal-client/dist/Address.js");
  const aep = AccountEntropyPool.generate(), f = join(mk("sigimp-val-"), "v.binary"); await writeSecureBackup(f, aep, ids.ME, secureFrames());
  const buf = readFileSync(f), key = new MessageBackupKey({ accountEntropy: aep, aci: Aci.fromUuid(ids.ME) });
  const stream = () => { let pos = 0; return { read: async (n: number) => { const r = buf.subarray(pos, pos + n); pos += r.length; return r; }, skip: async (n: number) => { pos += n; }, close: async () => {} } as any; };
  const ok = await validate(key, Purpose.RemoteBackup, stream, BigInt(buf.length));
  assert.match(String(ok.errorMessage), /AccountData/, "container layer accepted; only the semantic AccountData check of the toy fixture fails");
  const wrong = await validate(new MessageBackupKey({ accountEntropy: AccountEntropyPool.generate(), aci: Aci.fromUuid(ids.ME) }), Purpose.RemoteBackup, stream, BigInt(buf.length));
  assert.ok(!/AccountData/.test(String(wrong.errorMessage)), "a wrong key never reaches the frames: " + wrong.errorMessage);
});

test("Secure Backup on-device folder with media: files decrypted (AES-CBC + HMAC, localKey), stored, bad/absent/keyless counted missing; inspect offers attachments", { timeout: 120_000 }, async () => {
  const { AccountEntropyPool } = await import("@signalapp/libsignal-client/dist/AccountKeys.js");
  const aep = AccountEntropyPool.generate(), t = setup(), acc = await linkedAccount(t), root = join(t.dir, "backup-root");
  const big = Buffer.concat([PNG, Buffer.alloc(5000, 7)]);
  const { main, sentAt } = await writeSecureFolderBackup(root, aep, ids.ME, [
    { id: "a", ct: "image/png", name: "pic.png", data: big, text: "look" },
    { id: "b", ct: "audio/ogg", data: VOICE, flag: 1 },
    { id: "c", ct: "video/mp4", name: "gone.mp4", data: Buffer.from("video"), mode: "absent" },
    { id: "d", ct: "application/pdf", name: "bad.pdf", data: Buffer.from("pdf!"), mode: "tampered" },
    { id: "e", ct: "image/png", data: PNG, mode: "nokey" },
    { id: "f", ct: "image/png", data: PNG, mode: "wronghash" },
  ]);
  const ins = await t.call("signalBackupInspect", { path: main, passphrase: aep, accountId: acc });
  assert.equal(ins.format, "secure-backup"); assert.equal(ins.canAttachments, true); assert.equal(ins.attachments.count, 6); assert.equal(ins.messages, 9);
  const before = mediaFiles(t).length;
  const r = await t.call("signalBackupImport", { path: main, passphrase: aep, accountId: acc, options: { attachments: true } });
  assert.deepEqual([r.attachments.stored, r.attachments.missing, r.attachments.skipped], [2, 4, 0]);
  const anna = await msgs(t, `${acc}:${ids.ANNA}`), by = (i: number) => anna.find((m) => m.id === `${ids.ANNA}.${sentAt(i)}`)!;
  assert.equal(by(0).text, "look"); assert.equal(by(0).attachments![0]!.kind, "image"); assert.equal(by(0).attachments![0]!.name, "pic.png"); assert.equal(by(0).attachments![0]!.size, big.length);
  assert.equal(by(1).attachments![0]!.kind, "voice"); assert.equal(by(1).text, "");
  for (const i of [2, 3, 4, 5]) { assert.equal(by(i).attachments, undefined); assert.match(by(i).text, /^\[(Video|File: bad\.pdf|Photo)\]$/); }
  assert.equal(mediaFiles(t).length - before, 2);
  const got = await t.call("attachment", { chatId: by(0).chatId, messageId: by(0).id, attachmentId: by(0).attachments![0]!.id });
  assert.deepEqual(Buffer.from(got.dataBase64, "base64"), big); assert.equal(got.mime, "image/png");
  // without the media option: placeholders only, nothing stored
  const t2 = setup(), acc2 = await linkedAccount(t2);
  const r2 = await t2.call("signalBackupImport", { path: main, passphrase: aep, accountId: acc2, options: { attachments: false } });
  assert.deepEqual([r2.attachments.stored, r2.attachments.missing, r2.attachments.skipped], [0, 0, 6]); assert.equal(mediaFiles(t2).length, 0);
  assert.equal((await msgs(t2, `${acc2}:${ids.ANNA}`)).find((m) => m.id === `${ids.ANNA}.${sentAt(0)}`)!.text, "look\n[Photo]");
  // a folder without media dir: placeholders, canAttachments false
  const { rmSync: rm } = await import("node:fs"); rm(join(root, "files"), { recursive: true });
  const ins3 = await t.call("signalBackupInspect", { path: main, passphrase: aep, accountId: acc });
  assert.equal(ins3.canAttachments, false);
});
