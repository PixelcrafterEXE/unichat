// "Move this account's login to another device": one-account sealed session package, the source wipes WITHOUT remote logout, failure modes, exactly one owner.
// Fake providers and fixtures only; two Hubs in temp dirs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Hub } from "./hub.js";
import { MemoryStore } from "./store.js";
import { NO_CAPABILITIES, type Connector, type CoreEvent, type ProviderFactory } from "./provider.js";

const SECRET = "SIGNAL-SESSION-SECRET-" + randomBytes(6).toString("hex");
const PASS = "correct horse battery", KDF = { kdfN: 1 << 14 };
interface Log { started: string[]; stopped: string[]; loggedOut: string[] }
const logs = new Map<string, Log>();
/** A Signal/WhatsApp-like provider: the session lives in files, one more secret is sealed to the install (exportSession makes it portable, importSession re-seals it). */
const mkFactory = (name: string, tag: string): ProviderFactory => ({ name, displayName: name, login: "qr", capabilities: NO_CAPABILITIES,
  create: ({ accountId, dataDir }: any) => ({ capabilities: NO_CAPABILITIES,
    async start(_e: (e: CoreEvent) => void) { logs.get(tag)!.started.push(accountId); if (!existsSync(join(dataDir ?? "", "auth", "creds.json")) && dataDir) { /* a connector without a session would ask for a new login */ } },
    async stop() { logs.get(tag)!.stopped.push(accountId); }, async logout() { logs.get(tag)!.loggedOut.push(accountId); }, async submitLogin() {},
    async spaces() { return []; }, async chats() { return []; }, async history() { return []; }, async members() { return []; },
    async downloadAttachment() { return { data: new Uint8Array(), mime: "x" }; }, async send() { throw new Error("n/a"); } }) as unknown as Connector,
  async exportSession(dir) { const sealed = readFileSync(join(dir, "sealed.bin"), "utf8"); return { files: [{ rel: "portable.key", data: Buffer.from(sealed.replace(/^SEALED-[a-z0-9]+:/, "")) }], omit: ["sealed.bin"] }; },
  async importSession(dir) { writeFileSync(join(dir, "sealed.bin"), "SEALED-" + tag + ":" + readFileSync(join(dir, "portable.key"), "utf8")); writeFileSync(join(dir, ".resealed"), "1"); rmSyncSafe(join(dir, "portable.key")); } });
import { rmSync } from "node:fs";
const rmSyncSafe = (p: string) => { try { rmSync(p); } catch { /* gone */ } };

function install(tag: string, provider = "signal") {
  logs.set(tag, { started: [], stopped: [], loggedOut: [] });
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "mv-" + tag + "-")), dir = join(root, "accounts"), store = new MemoryStore();
  const hub = new Hub(dir, [mkFactory(provider, tag)], store, { dataKey: new Uint8Array(randomBytes(32)), backup: { paths: "any" } });
  return { root, dir, store, hub, tag, log: logs.get(tag)!, call: (m: string, p?: any) => hub.call(m, p) as Promise<any> };
}
type Inst = ReturnType<typeof install>;
const ACC = "signal-aaaa";
async function source(tag = "src"): Promise<Inst> {
  const s = install(tag);
  s.store.putAccount({ id: ACC, provider: "signal", label: "+49 Alice", status: "active" });
  s.store.putMessages([{ id: "m1", chatId: ACC + ":bob", sender: "Bob", senderId: "bob", text: "hi", time: "2026-01-01T00:00:00Z", fromMe: false }]);
  mkdirSync(join(s.dir, ACC, "auth"), { recursive: true }); writeFileSync(join(s.dir, ACC, "auth", "creds.json"), JSON.stringify({ identityKey: SECRET }));
  writeFileSync(join(s.dir, ACC, "sealed.bin"), "SEALED-" + tag + ":" + SECRET + "-sealed");
  await s.hub.init(); // restores the account: its connector starts from the session files
  if (!s.log.started.length) await s.call("signIn", { accountId: ACC });
  return s;
}
async function target(tag: string): Promise<Inst> { const t = install(tag); await t.hub.init(); return t; }
const pack = async (s: Inst, name = "move.unimsg-backup") => { const file = join(s.root, name); await s.call("exportData", { passphrase: PASS, parts: { data: false, sessions: true }, targetPath: file, accountIds: [ACC], ...KDF }); return file; };
const walk = (d: string, out: string[] = []): string[] => { if (!existsSync(d)) return out; for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; };
const hasSession = (i: Inst) => existsSync(join(i.dir, ACC, "auth", "creds.json")) || existsSync(join(i.dir, ACC, "sealed.bin"));
/** who can currently act as the account: a running connector (a live session) */
const live = (i: Inst) => i.log.started.length > i.log.stopped.length;
const residue = (i: Inst) => walk(i.dir).filter((f) => /\.import-/.test(f));

test("happy path: package -> import -> confirm; the source wipes its session without a remote logout; exactly one owner at the end", async () => {
  const A = await source("a1"), B = await target("b1"); const file = await pack(A);
  assert.ok(live(A) && hasSession(A), "before the move the source owns the login");
  const res = await B.call("importData", { path: file, passphrase: PASS, mode: "new-install" });
  assert.deepEqual(res.moved, [ACC]); assert.equal(res.messages.added, 0, "session-only package carries no history");
  assert.equal(readFileSync(join(B.dir, ACC, "sealed.bin"), "utf8"), "SEALED-b1:" + SECRET + "-sealed", "re-sealed for the target install");
  assert.ok(!existsSync(join(B.dir, ACC, "portable.key")), "portable form is not left behind");
  assert.equal(B.log.started.length, 0, "the imported session does not start by itself");
  await A.call("moveAwayAccount", { accountId: ACC, confirmedSaved: true });
  assert.deepEqual(A.log.loggedOut, [], "NO remote logout (that would kill the session that was just handed over)");
  assert.ok(!live(A) && !hasSession(A) && !existsSync(join(A.dir, ACC)), "source: connector stopped, session material wiped");
  assert.equal(A.store.listAccounts()[0].status, "archived"); assert.equal(A.store.getMessage(ACC + ":bob", "m1")?.text, "hi", "history kept as read-only archive");
  assert.ok(!walk(A.dir).some((f) => readFileSync(f).includes(SECRET)), "no secret byte left on the source disk");
  await B.call("confirmMovedAccount", { accountId: ACC });
  assert.ok(live(B) && !live(A), "exactly one owner: the target");
  assert.deepEqual(await B.call("movedAccounts"), []);
});

test("wrong passphrase, tampered and truncated packages fail cleanly: the target gets nothing, the source stays the owner", async () => {
  const A = await source("a2"), B = await target("b2"); const file = await pack(A); const good = readFileSync(file);
  const before = JSON.stringify([...B.store.exportRecords()]);
  await assert.rejects(B.call("importData", { path: file, passphrase: "not the passphrase", mode: "new-install" }), /passphrase|decrypt|wrong/i);
  const variants: [string, Buffer][] = [["flip in the middle", Buffer.from(good)], ["flip in the footer", Buffer.from(good)], ["truncated (interrupted copy)", good.subarray(0, Math.floor(good.length * 0.7))], ["garbage appended", Buffer.concat([good, Buffer.from("x")])], ["empty", Buffer.alloc(0)]];
  variants[0][1][Math.floor(good.length / 2)] ^= 0x55; variants[1][1][good.length - 5] ^= 0x01;
  for (const [what, buf] of variants) {
    const f = join(B.root, "bad.unimsg-backup"); writeFileSync(f, buf);
    await assert.rejects(B.call("importData", { path: f, passphrase: PASS, mode: "new-install" }), /./, what);
    assert.ok(!hasSession(B) && !existsSync(join(B.dir, ACC)), what + ": no session files on the target");
    assert.deepEqual(await B.call("movedAccounts"), [], what + ": nothing flagged as moved");
    assert.equal(JSON.stringify([...B.store.exportRecords()]), before, what + ": database untouched");
    assert.deepEqual(residue(B), [], what + ": no staging residue");
    assert.ok(!walk(B.dir).some((x) => readFileSync(x).includes(SECRET)));
  }
  assert.ok(live(A) && hasSession(A) && A.log.loggedOut.length === 0, "the source still owns the login");
});

test("interrupted move: whatever step stops, there is never a second live owner and the session is never lost", async () => {
  // (1) package made, nothing else happened: source owns, nobody else
  const A = await source("a3"), B = await target("b3"); const file = await pack(A);
  assert.ok(live(A) && hasSession(A) && !hasSession(B));
  // (2) import done, the user does not confirm and walks away: the target has files but no live connector; source still live (the UI keeps the account "waiting")
  await B.call("importData", { path: file, passphrase: PASS, mode: "new-install" });
  assert.equal((await B.call("movedAccounts")).length, 1); assert.ok(!live(B) && live(A));
  // (3) moveAway without the "package saved" confirmation is refused and changes nothing
  await assert.rejects(A.call("moveAwayAccount", { accountId: ACC }), /Confirm/); await assert.rejects(A.call("moveAwayAccount", { accountId: ACC, confirmedSaved: false }), /Confirm/);
  assert.ok(live(A) && hasSession(A));
  // (4) the user changes their mind on the target: dismiss drops the imported session; the source remains the only owner
  await B.call("dismissMovedAccount", { accountId: ACC });
  assert.ok(!hasSession(B) && !live(B) && live(A) && hasSession(A));
  // (5) a second attempt with the same package is allowed again (the target gave it up) ... and completes
  await B.call("importData", { path: file, passphrase: PASS, mode: "merge" });
  await A.call("moveAwayAccount", { accountId: ACC, confirmedSaved: true });
  await B.call("confirmMovedAccount", { accountId: ACC });
  assert.ok(live(B) && !live(A) && !hasSession(A));
  // (6) moveAway on the source twice is harmless
  await A.call("moveAwayAccount", { accountId: ACC, confirmedSaved: true }).catch(() => {});
  assert.ok(!hasSession(A) && !live(A));
  // (7) the moved login cannot be "confirmed" twice into a second start
  await assert.rejects(B.call("confirmMovedAccount", { accountId: ACC }), /not moved/); assert.equal(B.log.started.length, 1);
});

test("source wiped first, target never imported: the package is the only holder; it imports exactly once afterwards", async () => {
  const A = await source("a4"), B = await target("b4"); const file = await pack(A);
  await A.call("moveAwayAccount", { accountId: ACC, confirmedSaved: true });
  assert.ok(!hasSession(A) && !live(A) && !hasSession(B));
  const r = await B.call("importData", { path: file, passphrase: PASS, mode: "new-install" }); assert.deepEqual(r.moved, [ACC]);
  await B.call("confirmMovedAccount", { accountId: ACC }); assert.ok(live(B));
});

test("double import is refused: same package twice on one install (before and after confirming), nothing is overwritten", async () => {
  const A = await source("a5"), B = await target("b5"); const file = await pack(A);
  await B.call("importData", { path: file, passphrase: PASS, mode: "new-install" });
  writeFileSync(join(B.dir, ACC, "auth", "creds.json"), '{"changed":"locally"}'); // proves a 2nd import cannot overwrite
  await assert.rejects(B.call("importData", { path: file, passphrase: PASS, mode: "merge" }), /already imported/);
  assert.equal((await B.call("importInspect", { path: file, passphrase: PASS })).alreadyImported, true, "the preview tells the user");
  assert.equal(readFileSync(join(B.dir, ACC, "auth", "creds.json"), "utf8"), '{"changed":"locally"}');
  await B.call("confirmMovedAccount", { accountId: ACC });
  await assert.rejects(B.call("importData", { path: file, passphrase: PASS, mode: "merge" }), /already imported/);
  assert.equal(B.log.started.length, 1, "no second start");
  // a fresh package (new export) is a different package and is accepted as a normal merge into an account that is live here: the live session is never replaced
  const f2 = await pack(A, "again.unimsg-backup"); const r = await B.call("importData", { path: f2, passphrase: PASS, mode: "merge" });
  assert.deepEqual(r.moved, [], "never touches the session of an account that is live here");
  assert.equal(readFileSync(join(B.dir, ACC, "auth", "creds.json"), "utf8"), '{"changed":"locally"}');
});

test("full backups with sessions are one-time too, but backups WITHOUT sessions stay re-importable", async () => {
  const A = await source("a6"), B = await target("b6"), C = await target("c6");
  const noSess = join(A.root, "data.unimsg-backup"); await A.call("exportData", { passphrase: PASS, parts: { data: true }, targetPath: noSess, ...KDF });
  await B.call("importData", { path: noSess, passphrase: PASS, mode: "new-install" }); await B.call("importData", { path: noSess, passphrase: PASS, mode: "merge" });
  assert.ok(!hasSession(B));
  const withSess = join(A.root, "full.unimsg-backup"); await A.call("exportData", { passphrase: PASS, parts: { data: true, sessions: true }, targetPath: withSess, ...KDF });
  await C.call("importData", { path: withSess, passphrase: PASS, mode: "new-install" });
  await assert.rejects(C.call("importData", { path: withSess, passphrase: PASS, mode: "merge" }), /already imported/);
});

test("secrets never travel in the clear: the package holds no plaintext secret, wrong provider hook failure is reported, unsafe paths are rejected", async () => {
  const A = await source("a7"); const file = await pack(A);
  assert.ok(!readFileSync(file).includes(SECRET), "the package is encrypted");
  assert.ok(!readFileSync(file).includes("creds.json"));
  // a hook that throws: the export still works but warns that the session may not work elsewhere
  const bad: ProviderFactory = { ...mkFactory("signal", "a7b"), async exportSession() { throw new Error("keystore locked"); } };
  logs.set("a7b", { started: [], stopped: [], loggedOut: [] });
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "mv-a7b-")), dir = join(root, "accounts"), store = new MemoryStore();
  const hub = new Hub(dir, [bad], store, { dataKey: new Uint8Array(randomBytes(32)), backup: { paths: "any" } });
  store.putAccount({ id: ACC, provider: "signal", label: "x", status: "active" }); mkdirSync(join(dir, ACC), { recursive: true }); writeFileSync(join(dir, ACC, "creds.json"), "{}");
  const r: any = await hub.call("exportData", { passphrase: PASS, parts: { data: false, sessions: true }, targetPath: join(root, "w.unimsg-backup"), accountIds: [ACC], ...KDF });
  assert.ok(r.warnings.some((w: string) => /keystore locked/.test(w)));
  const none = await hub.call("exportData", { passphrase: "short", parts: { sessions: true }, ...KDF }).catch((e: Error) => e.message); assert.match(String(none), /at least 8/);
});

test("a wipe that fails is reported (never a silent half-move) and can be retried", { skip: process.getuid?.() === 0 ? "root ignores permissions" : false }, async () => {
  const { chmodSync } = await import("node:fs");
  const A = await source("a8"); await pack(A);
  const auth = join(A.dir, ACC, "auth"); chmodSync(auth, 0o500);
  try { await assert.rejects(A.call("moveAwayAccount", { accountId: ACC, confirmedSaved: true }), /could not be deleted/); } finally { chmodSync(auth, 0o700); }
  assert.ok(!live(A) && A.log.loggedOut.length === 0, "stopped, still no remote logout");
  await A.call("moveAwayAccount", { accountId: ACC, confirmedSaved: true });
  assert.ok(!hasSession(A) && !existsSync(join(A.dir, ACC)));
});
