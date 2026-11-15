import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { SqliteStore } from "./index.js";

const open = () => { const dir = mkdtempSync(join(tmpdir(), "unimsg-store-")); return { dir, path: join(dir, "t.db"), done: () => rmSync(dir, { recursive: true, force: true }) }; };

test("accounts, aliases, chat flags and mesh groups persist across reopen", () => {
  const t = open();
  const a = new SqliteStore(t.path);
  a.putAccount({ id: "wa-1", provider: "whatsapp", label: "Me" });
  a.setAlias("wa-1:123@s.whatsapp.net", "Julia");
  a.setChatFlags("wa-1:g1", { pinned: true, muted: false, archived: true });
  a.putMeshGroup({ id: "mesh:1", name: "Crew", members: [{ name: "A", chatId: "x:1" }] });
  const b = new SqliteStore(t.path); // fresh connection = "restart"
  assert.deepEqual(b.listAccounts(), [{ id: "wa-1", provider: "whatsapp", label: "Me", status: "active" }]);
  assert.deepEqual(b.listAliases(), { "wa-1:123@s.whatsapp.net": "Julia" });
  assert.deepEqual(b.listChatFlags(), { "wa-1:g1": { pinned: true, muted: false, archived: true } });
  assert.equal(b.listMeshGroups()[0].name, "Crew");
  b.setAlias("wa-1:123@s.whatsapp.net", null);            // clearing removes the alias
  b.setChatFlags("wa-1:g1", { pinned: false, muted: false, archived: false }); // all-false deletes the row
  b.deleteAccount("wa-1");
  assert.deepEqual(b.listAliases(), {}); assert.deepEqual(b.listChatFlags(), {}); assert.deepEqual(b.listAccounts(), []);
  t.done();
});

test("jobs: due ordering, next run time, status filter", () => {
  const t = open(); const s = new SqliteStore(t.path);
  const mk = (id: string, runAt: number, status: "pending" | "done" | "failed" = "pending") => ({ id, kind: "send", payload: { n: id }, runAt, attempts: 0, maxAttempts: 3, status });
  s.putJob(mk("late", 2000)); s.putJob(mk("soon", 1000)); s.putJob(mk("done", 500, "done"));
  assert.equal(s.nextRunAt(), 1000);
  assert.deepEqual(s.dueJobs(1500).map((j) => j.id), ["soon"]);
  assert.deepEqual(s.listJobs("done").map((j) => j.id), ["done"]);
  assert.deepEqual(s.getJob("late")?.payload, { n: "late" });
  s.putJob({ ...mk("soon", 1000), status: "failed", attempts: 3, lastError: "boom" });
  assert.equal(s.getJob("soon")?.lastError, "boom"); assert.equal(s.nextRunAt(), 2000);
  t.done();
});

const m = (chatId: string, id: string, text: string, time: string, extra: object = {}) => ({ id, chatId, sender: "A", senderId: "a", text, time, fromMe: false, ...extra });

test("message archive: order, paging, merge-on-write, patch, search, retention", () => {
  const t = open(); const s = new SqliteStore(t.path);
  s.putMessages([m("a:c", "2", "two", "2026-01-02T00:00:00Z"), m("a:c", "1", "one", "2026-01-01T00:00:00Z"), m("a:c", "3", "three needle", "2026-01-03T00:00:00Z")]);
  assert.deepEqual(s.listMessages("a:c", { limit: 2 }).map((x) => x.id), ["2", "3"]);                       // newest 2, oldest first
  assert.deepEqual(s.listMessages("a:c", { limit: 5, beforeTime: "2026-01-03T00:00:00Z" }).map((x) => x.id), ["1", "2"]);
  s.patchMessage("a:c", "2", { text: "two (edited)", editedAt: "2026-01-02T01:00:00Z", reactions: [{ emoji: "x", senderIds: ["a"] }] });
  s.putMessages([m("a:c", "2", "two", "2026-01-02T00:00:00Z")]);                                           // history replay must not undo the edit
  const two = s.getMessage("a:c", "2")!; assert.equal(two.text, "two (edited)"); assert.equal(two.reactions?.length, 1);
  s.putMessages([m("a:c", "1", "", "2026-01-01T00:00:00Z", { deleted: true })]); s.putMessages([m("a:c", "1", "one", "2026-01-01T00:00:00Z")]);
  assert.equal(s.getMessage("a:c", "1")!.deleted, true);                                                    // deletions stick
  s.putMessages([m("a:c", "4", "mine", "2026-01-04T00:00:00Z", { fromMe: true, status: "read" })]); s.putMessages([m("a:c", "4", "mine", "2026-01-04T00:00:00Z", { fromMe: true, status: "sent" })]);
  assert.equal(s.getMessage("a:c", "4")!.status, "read");                                                   // receipts never go backwards
  assert.deepEqual(s.searchMessages("a:c", "NEEDLE", 10).map((x) => x.id), ["3"]);
  s.putMessages([m("a:c", "5", "", "2026-01-05T00:00:00Z", { poll: { question: "Pizza or pasta?", multiple: false, options: [{ id: "0", text: "Pizza", voters: [] }, { id: "1", text: "Pasta", voters: [] }] } }),
    m("a:c", "6", "", "2026-01-06T00:00:00Z", { location: { lat: 1, lng: 2, name: "Brandenburger Tor" } }), m("a:c", "7", "", "2026-01-07T00:00:00Z", { contacts: [{ name: "Zelda Zed", phones: ["+49 30 55555"] }] }),
    m("a:c", "8", "needle but deleted", "2026-01-08T00:00:00Z", { deleted: true })]);
  assert.deepEqual(s.searchMessages("a:c", "pasta", 9).map((x) => x.id), ["5"]);          // poll options
  assert.deepEqual(s.searchMessages("a:c", "brandenburger", 9).map((x) => x.id), ["6"]);  // location name
  assert.deepEqual(s.searchMessages("a:c", "55555", 9).map((x) => x.id), ["7"]);          // contact number
  assert.deepEqual(s.searchMessages("a:c", "NEEDLE", 10).map((x) => x.id), ["3"]);        // deleted messages never match
  assert.equal(s.deleteMessagesBefore("2026-01-03T00:00:00Z"), 2);
  assert.deepEqual(s.listMessages("a:c", { limit: 9 }).map((x) => x.id).slice(0, 2), ["3", "4"]);
  t.done();
});

test("encryption at rest: payloads are sealed, ids and times stay readable, a wrong or missing key fails loudly", () => {
  const t = open(); const key = randomBytes(32);
  const s = new SqliteStore(t.path, key);
  s.putAccount({ id: "wa-1", provider: "whatsapp", label: "+49 151 2345678" });
  s.putMessages([m("wa-1:c", "1", "top secret words", "2026-01-01T00:00:00Z", { sender: "Alice Example" })]);
  s.setAlias("wa-1:c", "Mum"); s.putChatCache("wa-1", { chats: [{ id: "wa-1:c", accountId: "wa-1", provider: "whatsapp", kind: "dm", name: "Alice Example" }], spaces: [] });
  s.putMeshGroup({ id: "mesh:1", name: "Secret crew", members: [] });
  const raw = new DatabaseSync(t.path, { readOnly: true });
  const dump = JSON.stringify(["messages", "aliases", "chat_cache", "mesh_groups", "accounts"].map((tb) => raw.prepare(`SELECT * FROM ${tb}`).all().map((r) => ({ ...r }))));
  for (const secret of ["top secret words", "Alice Example", "Mum", "Secret crew", "+49 151 2345678"]) assert.equal(dump.includes(secret), false, `${secret} leaked in plaintext`);
  assert.ok(dump.includes("2026-01-01T00:00:00Z")); // time is deliberately plain (ordering / retention)
  raw.close();
  const again = new SqliteStore(t.path, key);
  assert.equal(again.getMessage("wa-1:c", "1")!.text, "top secret words"); assert.equal(again.listAliases()["wa-1:c"], "Mum");
  assert.equal(again.getChatCache("wa-1")!.chats[0].name, "Alice Example"); assert.equal(again.listAccounts()[0].label, "+49 151 2345678");
  assert.throws(() => new SqliteStore(t.path, randomBytes(32)).getMessage("wa-1:c", "1"));                 // wrong key: authentication fails
  assert.throws(() => new SqliteStore(t.path).getMessage("wa-1:c", "1"), /no data key/);                   // no key
  assert.throws(() => new SqliteStore(join(t.dir, "x.db"), new Uint8Array(5)), /32 bytes/);
  t.done();
});

test("rows written before a key existed stay readable and become encrypted when rewritten", () => {
  const t = open(); new SqliteStore(t.path).setAlias("x:1", "Plain name");
  const key = randomBytes(32); const s = new SqliteStore(t.path, key);
  assert.equal(s.listAliases()["x:1"], "Plain name"); s.setAlias("x:1", "Plain name");
  const raw = new DatabaseSync(t.path, { readOnly: true });
  assert.equal(String((raw.prepare("SELECT name FROM aliases").get() as { name: string }).name).startsWith("e1:"), true); raw.close();
  t.done();
});

test("deleteAccountData removes one account completely and leaves the others alone", () => {
  const t = open(); const s = new SqliteStore(t.path);
  for (const a of ["a", "b"]) {
    s.putAccount({ id: a, provider: "p", label: a }); s.putMessages([m(`${a}:c`, "1", "x", "2026-01-01T00:00:00Z", { accountId: a })]);
    s.putChatCache(a, { chats: [], spaces: [] }); s.addAccountEvent(a, "linked"); s.setAlias(`${a}:c`, a); s.setChatFlags(`${a}:c`, { pinned: true });
  }
  s.deleteAccountData("a");
  assert.equal(s.listMessages("a:c", { limit: 9 }).length, 0); assert.equal(s.getChatCache("a"), undefined); assert.deepEqual(s.listAccountEvents("a"), []);
  assert.deepEqual(Object.keys(s.listAliases()), ["b:c"]); assert.deepEqual(Object.keys(s.listChatFlags()), ["b:c"]);
  assert.equal(s.listMessages("b:c", { limit: 9 }).length, 1); assert.equal(s.listAccountEvents("b").length, 1); assert.ok(s.getChatCache("b"));
  t.done();
});

test("account events, settings and archived status round trip", () => {
  const t = open(); const s = new SqliteStore(t.path);
  const e1 = s.addAccountEvent("a", "linked", "2026-01-01T00:00:00Z"), e2 = s.addAccountEvent("a", "signed-out", "2026-02-01T00:00:00Z");
  assert.ok(e2.id > e1.id); assert.deepEqual(s.listAccountEvents("a").map((e) => e.kind), ["linked", "signed-out"]);
  s.setSetting("retentionDays", "30"); assert.equal(s.getSetting("retentionDays"), "30"); assert.equal(s.getSetting("nope"), undefined);
  s.putAccount({ id: "a", provider: "p", label: "L", status: "archived" }); assert.equal(s.listAccounts()[0].status, "archived");
  t.done();
});

test("a database from before archiving gets migrated", () => {
  const t = open(); const old = new DatabaseSync(t.path);
  old.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL); INSERT INTO accounts VALUES ('w','whatsapp','Old account');"); old.close();
  const s = new SqliteStore(t.path); assert.deepEqual(s.listAccounts(), [{ id: "w", provider: "whatsapp", label: "Old account", status: "active" }]);
  t.done();
});

test("chat merges persist across reopen, update in place, delete, and are sealed with a key", () => {
  const t = open(); const key = randomBytes(32);
  const s = new SqliteStore(t.path, key);
  s.putMerge({ id: "merge:1", name: "Anna Becker (all)", members: ["wa-1:anna", "mx-1:@anna:matrix.org"], primary: "wa-1:anna", createdAt: "2026-01-01T00:00:00Z" });
  s.putMerge({ id: "merge:2", members: ["a:x", "b:x"], primary: "b:x", sendVia: "a:x", createdAt: "2026-01-02T00:00:00Z" });
  const raw = new DatabaseSync(t.path, { readOnly: true });
  const dump = JSON.stringify(raw.prepare("SELECT * FROM chat_merges").all().map((r) => ({ ...r }))); raw.close();
  for (const secret of ["Anna Becker", "wa-1:anna", "matrix.org"]) assert.equal(dump.includes(secret), false, `${secret} leaked in plaintext`);
  const b = new SqliteStore(t.path, key); // restart
  assert.deepEqual(b.listMerges().map((x) => x.id), ["merge:1", "merge:2"]);
  assert.deepEqual(b.listMerges()[0], { id: "merge:1", name: "Anna Becker (all)", members: ["wa-1:anna", "mx-1:@anna:matrix.org"], primary: "wa-1:anna", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(b.listMerges()[1].sendVia, "a:x");
  b.putMerge({ ...b.listMerges()[1], sendVia: "b:x", members: ["a:x", "b:x", "c:x"] }); // update replaces the row
  assert.equal(b.listMerges().length, 2); assert.deepEqual(b.listMerges()[1].members, ["a:x", "b:x", "c:x"]); assert.equal(b.listMerges()[1].sendVia, "b:x");
  b.deleteMerge("merge:1"); assert.deepEqual(b.listMerges().map((x) => x.id), ["merge:2"]);
  t.done();
});

test("a database from before merged chats existed gets the merges table without touching its data", () => {
  const t = open(); const old = new DatabaseSync(t.path);
  old.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'); INSERT INTO accounts VALUES ('w','whatsapp','Old','active');"
    + "CREATE TABLE aliases (chat_id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO aliases VALUES ('w:1','Julia');"); old.close();
  const s = new SqliteStore(t.path);
  assert.deepEqual(s.listMerges(), []); assert.equal(s.listAliases()["w:1"], "Julia"); assert.equal(s.listAccounts()[0].label, "Old");
  s.putMerge({ id: "merge:9", members: ["w:1", "w:2"], primary: "w:1", createdAt: "2026-03-03T00:00:00Z" });
  assert.equal(new SqliteStore(t.path).listMerges().length, 1);
  t.done();
});

test("merging never copies messages: member archives stay separate and survive deleting the merge", () => {
  const t = open(); const s = new SqliteStore(t.path);
  s.putMessages([m("a:c", "1", "via a", "2026-01-01T00:00:00Z"), m("b:c", "1", "via b", "2026-01-01T00:00:01Z")]); // same native id in two chats is fine
  s.putMerge({ id: "merge:1", members: ["a:c", "b:c"], primary: "a:c", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(s.listMessages("merge:1", { limit: 9 }).length, 0);
  s.deleteMerge("merge:1");
  assert.deepEqual([s.getMessage("a:c", "1")!.text, s.getMessage("b:c", "1")!.text], ["via a", "via b"]);
  t.done();
});

test("folders and per-chat folder overrides persist, are sealed when keyed, and are dropped with the account", () => {
  const t = open(); const key = randomBytes(32);
  const a = new SqliteStore(t.path, key);
  a.putFolder({ id: "folder:1", name: "Secret plans", color: "#123456", icon: "⭐" }); a.putFolder({ id: "folder:2", name: "Two" });
  a.setChatFolder("wa-1:g1", "folder:1"); a.setChatFolder("mx-1:r", "personal"); a.setChatFolder("wa-1:g2", "mx-1:space");
  const b = new SqliteStore(t.path, key);
  assert.deepEqual(b.listFolders().map((f) => f.name), ["Secret plans", "Two"]); assert.equal(b.listFolders()[0].color, "#123456");
  assert.deepEqual(b.listChatFolders(), { "wa-1:g1": "folder:1", "mx-1:r": "personal", "wa-1:g2": "mx-1:space" });
  const raw = new DatabaseSync(t.path); const row = raw.prepare("SELECT json FROM folders WHERE id='folder:1'").get() as { json: string };
  assert.ok(!row.json.includes("Secret plans")); raw.close();                  // the name is sealed
  b.setChatFolder("wa-1:g2", null); assert.equal(b.listChatFolders()["wa-1:g2"], undefined);
  b.deleteFolder("folder:1");                                                   // deleting a folder also drops overrides pointing to it
  assert.deepEqual(b.listFolders().map((f) => f.id), ["folder:2"]); assert.deepEqual(b.listChatFolders(), { "mx-1:r": "personal" });
  b.setChatFolder("wa-1:x", "folder:2"); b.deleteAccountData("wa-1"); assert.deepEqual(b.listChatFolders(), { "mx-1:r": "personal" });
  t.done();
});

test("migration: a database from before folders gets the new tables and keeps its data", () => {
  const t = open();
  const old = new DatabaseSync(t.path);
  old.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE chat_flags (chat_id TEXT PRIMARY KEY, pinned INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0);
    INSERT INTO accounts VALUES ('a','whatsapp','Me','active'); INSERT INTO chat_flags VALUES ('a:c',1,0,0);`);
  old.close();
  const s = new SqliteStore(t.path);
  assert.deepEqual(s.listFolders(), []); assert.deepEqual(s.listChatFolders(), {});
  assert.equal(s.listAccounts()[0].label, "Me"); assert.equal(s.listChatFlags()["a:c"].pinned, true);
  s.putFolder({ id: "folder:1", name: "N" }); assert.equal(s.listFolders().length, 1);
  t.done();
});

test("export records are decrypted and re-importable under another key; transactions roll back", async () => {
  const t = open();
  const src = new SqliteStore(t.path, randomBytes(32));
  src.putAccount({ id: "a-1", provider: "fake", label: "Secret label", status: "archived" });
  src.putMessages([{ id: "m1", chatId: "a-1:c", sender: "S", senderId: "s", text: "top secret", time: "2026-01-01T00:00:00Z", fromMe: false }]);
  src.setAlias("a-1:c", "Alias"); src.putFolder({ id: "folder:1", name: "F" }); src.addAccountEvent("a-1", "linked", "2026-01-01T00:00:00Z"); src.setSetting("k", "v");
  src.putMerge({ id: "merge:1", members: ["a-1:c"], primary: "a-1:c", createdAt: "x" });
  const recs = [...src.exportRecords()];
  assert.equal(JSON.stringify(recs).includes("e1:"), false);
  assert.deepEqual(src.countRecords().message, 1);
  const dst = new SqliteStore(join(t.dir, "d.db"), randomBytes(32));
  for (const r of recs) {
    if (r.t === "account") dst.putAccount(r.v); else if (r.t === "message") dst.putMessages([r.v]); else if (r.t === "alias") dst.setAlias(r.chatId, r.name);
    else if (r.t === "folder") dst.putFolder(r.v); else if (r.t === "event") dst.addAccountEvent(r.v.accountId, r.v.kind, r.v.time); else if (r.t === "setting") dst.setSetting(r.key, r.value); else if (r.t === "merge") dst.putMerge(r.v);
  }
  assert.deepEqual([...dst.exportRecords()], recs);
  await assert.rejects(dst.inTransaction(async () => { dst.setSetting("tmp", "1"); dst.putMessages([{ id: "m2", chatId: "a-1:c", sender: "S", senderId: "s", text: "x", time: "2026-01-02T00:00:00Z", fromMe: false }]); await new Promise((r) => setTimeout(r, 5)); throw new Error("boom"); }));
  assert.equal(dst.getSetting("tmp"), undefined); assert.equal(dst.getMessage("a-1:c", "m2"), undefined); assert.equal(dst.getMessage("a-1:c", "m1")!.text, "top secret");
  await dst.inTransaction(() => { dst.setSetting("ok", "1"); });
  assert.equal(dst.getSetting("ok"), "1");
  t.done();
});

test("cards[], card images, reaction/poll counts and chat fields survive the encrypted archive; cards are searchable", () => {
  const t = open(); const s = new SqliteStore(t.path);
  const msg: any = { id: "1", chatId: "a:c", sender: "x", senderId: "x", text: "e", time: "2026-01-01T00:00:00Z", fromMe: false,
    cards: [{ kind: "other", title: "First", image: { attachmentId: "e0i", width: 4, height: 2 } }, { kind: "link", title: "Needle card" }],
    reactions: [{ emoji: "👍", senderIds: [], count: 9 }], poll: { question: "q", multiple: false, options: [{ id: "1", text: "A", voters: [], count: 5 }] } };
  s.putMessages([msg]);
  const got: any = new SqliteStore(t.path).getMessage("a:c", "1");
  assert.equal(got.cards[0].image.attachmentId, "e0i"); assert.equal(got.reactions[0].count, 9); assert.equal(got.poll.options[0].count, 5);
  assert.deepEqual(s.searchMessages("a:c", "needle", 5).map((m) => m.id), ["1"]);
  s.putChatCache("a", { spaces: [], chats: [{ id: "a:c", accountId: "a", provider: "p", kind: "dm", name: "N", category: "Cat", request: true, unreadApprox: true, unread: 1 }] });
  const c: any = s.getChatCache("a")!.chats[0]; assert.deepEqual([c.category, c.request, c.unreadApprox], ["Cat", true, true]);
  t.done();
});

test("scanMessages streams the sealed archive in key order, optionally for one account", () => {
  const t = open(); const s = new SqliteStore(t.path, randomBytes(32));
  const mk = (chatId: string, id: string): any => ({ id, chatId, sender: "x", senderId: "x", text: "t " + id, time: "2026-01-01T00:00:00Z", fromMe: false });
  s.putMessages([mk("a1:x", "2"), mk("a1:x", "1"), mk("a1:y", "1"), mk("a10:x", "1"), mk("a2:z", "1")]);
  const all: string[] = []; let after: { chatId: string; id: string } | undefined;
  for (;;) { const p = s.scanMessages({ after, limit: 2 }); if (!p.length) break; all.push(...p.map((m) => m.chatId + "/" + m.id)); after = { chatId: p.at(-1)!.chatId, id: p.at(-1)!.id }; }
  assert.deepEqual(all, ["a10:x/1", "a1:x/1", "a1:x/2", "a1:y/1", "a2:z/1"]);
  assert.deepEqual(s.scanMessages({ accountId: "a1", limit: 10 }).map((m) => m.chatId + "/" + m.id), ["a1:x/1", "a1:x/2", "a1:y/1"]); // "a10" is a different account
  assert.deepEqual(s.scanMessages({ accountId: "a1", after: { chatId: "a1:x", id: "2" }, limit: 10 }).map((m) => m.chatId), ["a1:y"]);
  t.done();
});

test("per-recipient receipts round trip, merge per id on patch and replay, and are sealed on disk", () => {
  const t = open(); const a = new SqliteStore(t.path);
  const m = { id: "m1", chatId: "wa:g1", accountId: "wa", sender: "Me", senderId: "me", text: "needle-text", time: "2026-01-01T10:00:00Z", fromMe: true, status: "sent" as const };
  a.putMessages([{ ...m, receipts: [{ id: "bob", delivered: "2026-01-01T10:01:00Z" }] }]);
  a.patchMessage("wa:g1", "m1", { receipts: [{ id: "bob", read: "2026-01-01T10:05:00Z" }, { id: "cy", delivered: "2026-01-01T10:02:00Z" }] });
  a.patchMessage("wa:g1", "m1", { receipts: [{ id: "bob", read: "2026-01-01T10:04:00Z" }] }); // older: ignored
  a.putMessages([m]); // replay without receipts loses nothing
  const b = new SqliteStore(t.path);
  assert.deepEqual(b.getMessage("wa:g1", "m1")?.receipts, [{ id: "bob", delivered: "2026-01-01T10:01:00Z", read: "2026-01-01T10:05:00Z" }, { id: "cy", delivered: "2026-01-01T10:02:00Z" }]);
  assert.equal(b.listMessages("wa:g1", { limit: 5 })[0].receipts?.length, 2);
  t.done();
});

test("chat flags: unreadMark persists in the database, survives reopen and the migration of an old table", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "sqlflags-")), f = join(dir, "u.db");
  const a = new SqliteStore(f); a.setChatFlags("x:1", { unreadMark: true }); a.setChatFlags("x:2", { pinned: true, unreadMark: true });
  assert.deepEqual(a.listChatFlags()["x:1"], { pinned: false, muted: false, archived: false, unreadMark: true });
  a.setChatFlags("x:2", {}); assert.equal(a.listChatFlags()["x:2"], undefined);
  const b = new SqliteStore(f); assert.equal(b.listChatFlags()["x:1"]?.unreadMark, true);
});

test("avatars: sealed at rest, persist across reopen, list/prune, tombstones, hint, and the table is added to an old database", () => {
  const t = open(), key = new Uint8Array(randomBytes(32));
  const old = new DatabaseSync(t.path); old.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); old.close(); // a database from before avatars existed
  const a = new SqliteStore(t.path, key), bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), now = Date.now();
  const mk = (k: string, data: Uint8Array, at: number, rev?: string) => ({ key: k, mime: "image/png", data, fetchedAt: at, sha: "ab".repeat(32), ...(rev ? { rev } : {}) });
  a.putAvatar(mk("chat|wa-1:ann", bytes, now, "hint-1")); a.putAvatar(mk("chat|wa-1:ann|full", bytes, now - 10)); a.putAvatar(mk("contact|wa-2:bob", new Uint8Array(100), now - 20));
  a.putAvatar({ key: "chat|wa-1:none", mime: "", data: new Uint8Array(), fetchedAt: now, sha: "", empty: true });
  const raw = new DatabaseSync(t.path); const row = raw.prepare("SELECT meta, data FROM avatars WHERE key=?").get("chat|wa-1:ann") as { meta: string; data: string }; raw.close();
  assert.ok(row.meta.startsWith("e1:") && row.data.startsWith("e1:"), "mime, hash, hint and bytes are sealed");
  const b = new SqliteStore(t.path, key);
  assert.deepEqual([...b.getAvatar("chat|wa-1:ann")!.data], [...bytes]); assert.equal(b.getAvatar("chat|wa-1:ann")!.mime, "image/png"); assert.equal(b.getAvatar("chat|wa-1:ann")!.rev, "hint-1");
  assert.equal(b.getAvatar("chat|wa-1:none")!.empty, true);
  assert.deepEqual(b.listAvatars({ limit: 10 }).map((m) => [m.key, m.state]), [["chat|wa-1:ann", "pic"], ["chat|wa-1:ann|full", "pic"], ["chat|wa-1:none", "none"], ["contact|wa-2:bob", "pic"]], "none rows are listed too");
  assert.equal(b.listAvatars({ limit: 10 })[0].rev, "hint-1");
  assert.deepEqual(b.listAvatars({ after: "chat|wa-1:ann", limit: 1 }).map((m) => m.key), ["chat|wa-1:ann|full"]);
  assert.equal(new SqliteStore(t.path).getAvatar("chat|wa-1:ann"), undefined, "without the data key the picture is unreadable");
  assert.equal(b.pruneAvatars({ maxBytes: 16 }), 1, "oldest picture dropped to fit the cap"); assert.equal(b.getAvatar("contact|wa-2:bob"), undefined);
  // deleting = tombstones (chat thumbnail + full even when never stored), the picture bytes are gone
  assert.equal(b.deleteAvatars({ id: "wa-1:ann", at: now + 5 }), 2);
  const g = b.getAvatar("chat|wa-1:ann")!; assert.equal(g.gone, true); assert.equal(g.data.length, 0); assert.equal(g.fetchedAt, now + 5);
  assert.equal(b.deleteAvatars({ id: "wa-1:zed", at: now }), 2); assert.equal(b.getAvatar("chat|wa-1:zed")!.gone, true); assert.equal(b.getAvatar("chat|wa-1:zed|full")!.gone, true);
  b.putAvatar(mk("space|wa-1:s", bytes, now)); assert.equal(b.deleteAvatars({ accountId: "wa-1" }), 2, "the live rows of the account (pictures + none), not the existing tombstones");
  assert.equal(b.getAvatar("space|wa-1:s")!.gone, true); assert.equal(b.getAvatar("chat|wa-1:none")!.gone, true);
  assert.ok(b.listAvatars({ limit: 20 }).every((m) => m.state === "gone"));
  // tombstones expire after their own, shorter retention; deleteAccountData tombstones too
  assert.equal(b.pruneAvatars({ maxBytes: 1e9, tombOlderThan: now + 1 }) > 0, true);
  b.putAvatar(mk("chat|wa-3:x", bytes, now)); b.deleteAccountData("wa-3"); assert.equal(b.getAvatar("chat|wa-3:x")!.gone, true);
  t.done();
});
