// Integration tests: real Hubs paired over loopback only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { converged, dump, msg, node, pairUp, joinApproved, signedIn, until, type Node } from "./testkit.js";
void joinApproved;

test("pairing, initial transfer, concurrent edits converge, transitive third device, no echo", async () => {
  const A = await node("A", "memory", undefined, (s) => {
    s.putAccount({ id: "fake-aaaa", provider: "fake", label: "Work", status: "active" });
    s.putMessages([msg("fake-aaaa:c1", "m1", "hello", "2026-01-01T10:00:00Z"), msg("fake-aaaa:c1", "m2", "second", "2026-01-01T10:01:00Z"), msg("fake-aaaa:c1", "m3", "third", "2026-01-01T10:02:00Z")]);
    s.setAlias("fake-aaaa:c1", "Julia"); s.setSetting("retentionDays", "0");
  });
  const B = await node("B", "sqlite");
  const events: string[] = []; B.hub.subscribe((e) => events.push(e));
  await pairUp(A, B);
  await until(() => dump(B.store).includes("m2") || B.store.getMessage("fake-aaaa:c1", "m2") !== undefined, "initial transfer");
  await until(() => converged(A, B), "initial convergence");
  assert.equal(B.store.listAccounts()[0].status, "archived", "an account known only from a peer is a read-only archive");
  await until(async () => (await B.call("accounts"))[0]?.state === "signed-out", "hub shows the archive");
  assert.ok(events.includes("history-updated") || events.includes("chats-changed"));
  // C joins through B
  const C = await node("C", "memory");
  await pairUp(B, C);
  await until(() => converged(A, B, C) && C.store.getMessage("fake-aaaa:c1", "m3") !== undefined, "C gets A's data via B");
  // wait for full mesh
  await until(() => A.svc.status().devices.length === 3 && A.svc.status().devices.every((d: any) => d.online), "A sees both", 12000);
  // concurrent conflicting changes on all three: edit (A), reaction (B), delete (C), alias conflict, settings conflict, new messages
  const rx = [{ emoji: "👍", senderIds: ["bob"] }];
  A.store.putMessages([msg("fake-aaaa:c1", "m1", "hello (edited)", "2026-01-01T10:00:00Z", { editedAt: "2026-01-01T11:00:00Z" })]);
  B.store.putMessages([msg("fake-aaaa:c1", "m1", "hello", "2026-01-01T10:00:00Z", { reactions: rx })]);
  C.store.putMessages([msg("fake-aaaa:c1", "m2", "second", "2026-01-01T10:01:00Z", { deleted: true })]);
  B.store.putMessages([msg("fake-aaaa:c1", "m2", "second", "2026-01-01T10:01:00Z", { reactions: rx })]);
  A.store.setAlias("fake-aaaa:c1", "from A"); await new Promise((r) => setTimeout(r, 15)); C.store.setAlias("fake-aaaa:c1", "from C");
  A.store.setSetting("railOrder", '["a"]'); await new Promise((r) => setTimeout(r, 15)); B.store.setSetting("railOrder", '["b"]');
  A.store.putMessages([msg("fake-aaaa:c1", "m4", "new on A", "2026-01-01T12:00:00Z")]); B.store.putMessages([msg("fake-aaaa:c1", "m5", "new on B", "2026-01-01T12:01:00Z")]);
  A.store.putFolder({ id: "folder:1", name: "Fam" }); C.store.setChatFlags("fake-aaaa:c1", { pinned: true });
  try { await until(() => converged(A, B, C) && !!A.store.getMessage("fake-aaaa:c1", "m5") && !!C.store.getMessage("fake-aaaa:c1", "m4"), "convergence after concurrent edits"); }
  catch (e) { for (const n of [A, B, C]) console.log("DUMP", n.name, "\n" + dump(n.store)); throw e; }
  const m1 = A.store.getMessage("fake-aaaa:c1", "m1")!, m2 = A.store.getMessage("fake-aaaa:c1", "m2")!;
  assert.equal(m1.text, "hello (edited)"); assert.equal(m1.reactions?.[0].emoji, "👍", "edit and reaction both survive");
  assert.ok(m2.deleted && !(m2.reactions?.length), "delete wins over the concurrent reaction");
  assert.equal(A.store.listAliases()["fake-aaaa:c1"], "from C"); assert.equal(A.store.getSetting("railOrder"), '["b"]');
  // idempotence / no echo: nothing keeps churning
  const seqs = [A, B, C].map((n) => (n.svc as any).ledger.maxSeq()); await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual([A, B, C].map((n) => (n.svc as any).ledger.maxSeq()), seqs, "ledgers are quiet once converged (no echo loop)");
  for (const n of [A, B, C]) await n.stop();
});

test("pairing: wrong codes only lock out their own source, approval + SAS are required, a refused device never gets the group, the code is single use", async () => {
  const A = await node("A", "memory"), B = await node("B", "memory"), C = await node("C", "memory");
  const p = await A.call("syncStartPairing", {});
  assert.equal((await A.call("syncStatus")).listening, true, "the listener is open while pairing");
  await assert.rejects(B.call("syncJoin", { host: "127.0.0.1", port: p.port, code: "baba-baba-baba-baba" }), /not accepted/);
  await assert.rejects(B.call("syncJoin", { host: "127.0.0.1", port: p.port, code: "bebe-bebe-bebe-bebe" }), /not accepted/);
  await assert.rejects(B.call("syncJoin", { host: "127.0.0.1", port: p.port, code: "bibi-bibi-bibi-bibi" }), /not accepted/);
  // the attacker (same source address) is now locked out: even the RIGHT code is refused from it ...
  await assert.rejects(B.call("syncJoin", { host: "127.0.0.1", port: p.port, code: p.code }), /not accepted|reach/);
  // ... but the pairing session is still alive (the old design closed it after 3 wrong tries: a denial of service)
  assert.ok((await A.call("syncStatus")).pairing, "pairing stays open for other sources");
  assert.equal((await A.call("syncStatus")).pairing.failures, 3);
  // a new code from the same source is still locked; wait for the lockout via the test clock is not possible, so use a fresh inviter with a different source-state: deny path
  assert.equal((await B.call("syncStatus")).enabled, false);
  await A.call("syncStopPairing");
  assert.equal((await A.call("syncStatus")).listening, true, "a device in a group keeps listening after pairing ends (default 'stay reachable on my network'); only an explicit syncSetListen {enabled:false} closes it");
  await A.call("syncSetListen", { enabled: false }); assert.equal((await A.call("syncStatus")).listening, false);
  const p2 = await A.call("syncStartPairing", {});
  // C is a different node but the same loopback address: it shares the lockout, so the source must be unlocked for this test
  (A.svc as any).src.clear();
  const j = await C.call("syncJoin", { host: "127.0.0.1", port: p2.port, code: p2.code });
  await until(async () => !!(await A.call("syncStatus")).approval, "approval shown");
  assert.equal((await A.call("syncStatus")).approval.sas, j.sas);
  // a second device with the right code while one is waiting gets "busy" and never sees the group
  await assert.rejects(B.call("syncJoin", { host: "127.0.0.1", port: p2.port, code: p2.code }).then(() => B.call("syncConfirmJoin", {})), /busy|Pairing failed|not accepted|reach/);
  // the user on A says NO: C gets nothing
  await Promise.all([A.call("syncApproveJoin", { accept: false }), C.call("syncConfirmJoin", {}).then(() => assert.fail("must not join"), (e: Error) => assert.match(e.message, /not approve|Pairing failed/))]);
  assert.equal((await C.call("syncStatus")).enabled, false);
  assert.equal(Object.keys((A.svc as any).group.devices).length, 1);
  // the joiner side can refuse too (digits differ): nothing is shared
  (A.svc as any).src.clear();
  const p3 = await A.call("syncStartPairing", {});
  await C.call("syncJoin", { host: "127.0.0.1", port: p3.port, code: p3.code });
  await until(async () => !!(await A.call("syncStatus")).approval, "approval shown again");
  await C.call("syncCancelJoin"); await A.call("syncApproveJoin", { accept: true });
  await until(async () => !(await A.call("syncStatus")).approval, "attempt over");
  assert.equal(Object.keys((A.svc as any).group.devices).length, 1);
  // QR link with a pinned wrong key is refused even with the right code
  (A.svc as any).src.clear();
  const bad = p3.link.replace(/k=[^&]+/, "k=" + Buffer.alloc(32, 7).toString("base64url"));
  await assert.rejects(C.call("syncJoin", { link: bad }), /QR code|not accepted|Pairing/);
  // success path, then the code is dead
  (A.svc as any).src.clear();
  await joinApproved(A, C, p3);
  assert.equal(Object.keys((A.svc as any).group.devices).length, 2);
  (A.svc as any).src.clear();
  await assert.rejects(B.call("syncJoin", { host: "127.0.0.1", port: p3.port, code: p3.code }), /not accepted|reach/);
  for (const n of [A, B, C]) await n.stop();
});

test("revoke: the removed device no longer receives or sends; remaining devices get the new key; offline catch-up; restart persistence", async () => {
  const dirB = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "sync-B-"));
  const A = await node("A", "memory"), B = await node("B", "sqlite", dirB), C = await node("C", "memory");
  await pairUp(A, B); await pairUp(A, C);
  await until(() => A.svc.status().devices.every((d: any) => d.online) && B.svc.status().devices.every((d: any) => d.online), "mesh", 12000);
  A.store.putMessages([msg("fake-x:c", "p1", "before revoke", "2026-02-01T10:00:00Z")]);
  await until(() => !!C.store.getMessage("fake-x:c", "p1") && !!B.store.getMessage("fake-x:c", "p1"), "pre-revoke sync");
  // B goes offline (pause), A revokes C meanwhile
  await B.call("syncPause"); await until(() => !A.svc.status().devices.find((d: any) => d.name === "B")?.online, "B offline");
  const cId = C.svc.status().deviceId; await A.call("syncRevoke", { deviceId: cId });
  A.store.putMessages([msg("fake-x:c", "p2", "after revoke", "2026-02-01T11:00:00Z")]);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(C.store.getMessage("fake-x:c", "p2"), undefined, "revoked device gets nothing new");
  C.store.putMessages([msg("fake-x:c", "p3", "from the revoked device", "2026-02-01T12:00:00Z")]);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(A.store.getMessage("fake-x:c", "p3"), undefined, "and nothing it writes is accepted");
  assert.ok(A.svc.status().devices.find((d: any) => d.id === cId)?.revoked);
  // B comes back, still with the OLD key: is upgraded and catches up
  await B.call("syncResume");
  await until(() => !!B.store.getMessage("fake-x:c", "p2"), "offline catch-up after resume", 15000);
  const keyOf = (n: Node) => (n.svc as any).group.keys.sort((a: any, b: any) => b.revoked.length - a.revoked.length)[0].tag;
  await until(() => keyOf(A) === keyOf(B), "B adopted the new group key");
  await until(() => B.svc.status().devices.find((d: any) => d.name === "C")?.revoked !== undefined, "B knows C is revoked");
  await until(async () => !(await C.call("syncStatus")).enabled, "the removed device unlinked itself");
  assert.equal(B.store.getMessage("fake-x:c", "p3"), undefined);
  // restart B from disk (sqlite store + sealed ledger): still paired, still syncs
  const bId = B.svc.status().deviceId; await B.stop();
  const B2 = await node("B", "sqlite", dirB, undefined, B.key);
  assert.ok(B2.svc.status().enabled && B2.svc.status().deviceId === bId, "identity and group survive a restart (sealed)");
  A.store.putMessages([msg("fake-x:c", "p4", "after B restart", "2026-02-02T11:00:00Z")]);
  try { await until(() => !!B2.store.getMessage("fake-x:c", "p4"), "sync continues after restart", 8000); } catch (e) { console.log("DBG", JSON.stringify(B2.svc.status().devices), JSON.stringify(A.svc.status().devices)); throw e; }
  for (const n of [A, B2, C]) await n.stop();
});

test("retention purge is not undone by a peer; account removal stays removed", async () => {
  const A = await node("A", "memory", undefined, (s) => { s.putAccount({ id: "fake-q", provider: "fake", label: "Q", status: "active" }); s.putMessages([msg("fake-q:c", "old", "old", "2020-01-01T00:00:00Z"), msg("fake-q:c", "new", "new", "2026-01-01T00:00:00Z")]); });
  const B = await node("B", "sqlite");
  await pairUp(A, B); await until(() => !!B.store.getMessage("fake-q:c", "old"), "transfer");
  A.store.deleteMessagesBefore("2025-01-01T00:00:00Z");
  A.store.putMessages([msg("fake-q:c", "n2", "trigger", "2026-03-01T00:00:00Z")]);
  B.store.putMessages([msg("fake-q:c", "old", "old", "2020-01-01T00:00:00Z", { reactions: [{ emoji: "x", senderIds: ["u"] }] })]); // B touches the old message -> entry travels to A
  await until(() => !!B.store.getMessage("fake-q:c", "n2"), "flow");
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(A.store.getMessage("fake-q:c", "old"), undefined, "purged message did not come back");
  for (const n of [A, B]) await n.stop();
});

test("account modes: archive-only default, none blocks, credentials need confirmation; same message from two linked devices dedupes", async () => {
  const A = await node("A", "memory", undefined, (s) => { s.putAccount({ id: "mattermost-1", provider: "mattermost", label: "Team", status: "active" }); s.putAccount({ id: "fake-2", provider: "fake", label: "Private", status: "active" }); });
  const B = await node("B", "memory");
  await assert.rejects(A.call("syncSetAccountMode", { accountId: "fake-2", mode: "credentials" }), /cannot be copied/);
  await A.call("syncSetAccountMode", { accountId: "fake-2", mode: "none" });
  mkdirSync(join(A.dir, "accounts", "mattermost-1"), { recursive: true }); writeFileSync(join(A.dir, "accounts", "mattermost-1", "session.json"), '{"token":"abc"}');
  await A.call("syncSetAccountMode", { accountId: "mattermost-1", mode: "credentials" });
  await pairUp(A, B);
  await until(() => B.store.listAccounts().some((a) => a.id === "mattermost-1"), "account metadata");
  // B only has a copy of the history, not the login: it must not offer (or accept) sharing the login from there
  assert.equal((await B.call("syncStatus")).accounts.find((x: any) => x.id === "mattermost-1").canShareCredentials, false);
  await assert.rejects(B.call("syncSetAccountMode", { accountId: "mattermost-1", mode: "credentials" }), /comes from another device; share it from there/);
  assert.ok(!B.store.listAccounts().some((a) => a.id === "fake-2"), "mode none: not even its metadata leaves the device");
  await until(async () => (await B.call("syncCredentials")).length === 1, "credential offer");
  assert.ok(!existsSync(join(B.dir, "accounts", "mattermost-1", "session.json")), "nothing is written before the user confirms");
  signedIn.length = 0;
  await B.call("syncConfirmCredentials", { accountId: "mattermost-1", accept: true });
  assert.equal(readFileSync(join(B.dir, "accounts", "mattermost-1", "session.json"), "utf8"), '{"token":"abc"}');
  assert.ok(signedIn.includes("mattermost-1"));
  // B now runs the login, but it came from A: it must not offer it onward (no sharing chains / loops), in the UI data and in the handlers
  const bs = (await B.call("syncStatus")).accounts.find((x: any) => x.id === "mattermost-1");
  assert.equal(bs.sharedFrom, "A"); assert.equal(bs.canShareCredentials, false); assert.equal(bs.canShareProxy, false);
  await assert.rejects(B.call("syncSetAccountMode", { accountId: "mattermost-1", mode: "credentials" }), /comes from A; share it from there/);
  await assert.rejects(B.call("syncSetProxyShare", { accountId: "mattermost-1", enabled: true }), /comes from A/);
  await assert.rejects(B.call("syncRelaySet", { deviceId: A.svc.status().deviceId, accountId: "mattermost-1", allow: true }), /comes from A/);
  assert.equal((await A.call("syncStatus")).accounts.find((x: any) => x.id === "mattermost-1").sharedFrom, undefined, "the origin itself can share");
  // both devices received the same network message separately (same ids)
  const same = msg("mattermost-1:ch", "net1", "same", "2026-04-01T00:00:00Z");
  A.store.putMessages([same]); B.store.putMessages([{ ...same }]);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(A.store.listMessages("mattermost-1:ch", { limit: 10 }).length, 1); assert.equal(B.store.listMessages("mattermost-1:ch", { limit: 10 }).length, 1);
  const msgs = (n: Node) => dump(n.store).split("\n").filter((l) => l.startsWith("m ")).join("\n"); assert.equal(msgs(A), msgs(B));
  for (const n of [A, B]) await n.stop();
});
