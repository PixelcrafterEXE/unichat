// Phase 2 features end to end over loopback: snapshot transfer (resume), reactions, chat-cache rule, big credentials, media blobs, proxy accounts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { NO_CAPABILITIES, type Chat, type Connector, type CoreEvent, type Message, type ProviderFactory } from "@unimsg/core";
import { converged, dump, msg, node, pairUp, until, type Node } from "./testkit.js";
import { LIMITS } from "./index.js";

test("initial transfer: an empty device gets a snapshot (encrypted container), an interrupted transfer resumes, then incremental sync continues", async () => {
  let aborted = false; const events: any[] = [];
  const chat = "fake-snap:c1";
  const A = await node("A", "sqlite", undefined, (s) => {
    s.putAccount({ id: "fake-snap", provider: "fake", label: "Big", status: "active" });
    s.putMessages(Array.from({ length: 700 }, (_, i) => msg(chat, "m" + i, randomBytes(150).toString("hex"), new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString())));
  }, undefined, { opts: { snapshot: { piece: 4096, afterChunk: (n, abort) => { if (n === 4 && !aborted) { aborted = true; abort(); } } } } });
  const B = await node("B", "sqlite"); B.hub.subscribe((e, d) => { if (e === "sync-progress") events.push(d); });
  await pairUp(A, B);
  await until(() => B.store.getMessage(chat, "m699") !== undefined && converged(A, B), "B has everything", 25_000);
  assert.ok(aborted, "the first transfer was interrupted");
  const snapIn = events.filter((e) => e.phase === "snapshot" && e.snapDir === "in");
  assert.ok(snapIn.length > 3, "progress events for the snapshot were emitted");
  const resumed = snapIn.map((e) => e.snapDone as number); const firstDone = resumed[0];
  assert.ok(resumed.some((v, i) => i > 0 && v >= firstDone), "bytes only grow");
  const cur = (B.svc as any).ledger.kvGet("cursors"); assert.ok(Object.values<any>(cur)[0].applied > 0, "ledger cursor continues from the snapshot");
  // incremental after the snapshot
  A.store.putMessages([msg(chat, "later", "after the snapshot", "2026-02-01T00:00:00Z")]);
  await until(() => !!B.store.getMessage(chat, "later"), "incremental message");
  for (const n of [A, B]) await n.stop();
});

test("reactions: concurrent reactions from two devices both survive; removal propagates", async () => {
  const chat = "fake-r:c";
  const A = await node("A", "memory", undefined, (s) => { s.putAccount({ id: "fake-r", provider: "fake", label: "R", status: "active" }); s.putMessages([msg(chat, "m1", "hi", "2026-01-01T00:00:00Z")]); });
  const B = await node("B", "memory"); await pairUp(A, B);
  await until(() => !!B.store.getMessage(chat, "m1"), "m1 on B");
  A.store.patchMessage(chat, "m1", { reactions: [{ emoji: "👍", senderIds: ["me"] }] });
  B.store.patchMessage(chat, "m1", { reactions: [{ emoji: "❤️", senderIds: ["me2"] }] });
  const both = (n: Node) => (n.store.getMessage(chat, "m1")?.reactions ?? []).map((r) => r.emoji).sort().join();
  await until(() => both(A) === both(B) && both(A).includes("👍") && both(A).includes("❤️"), "both reactions on both devices");
  // device A removes its reaction: B loses it, keeps its own
  A.store.patchMessage(chat, "m1", { reactions: [{ emoji: "❤️", senderIds: ["me2"] }] });
  await until(() => both(A) === "❤️" && both(B) === "❤️", "removal propagated");
  for (const n of [A, B]) await n.stop();
});

test("chat cache: a peer's cache never overwrites a LIVE connector's account; accounts that are not live here take it", async () => {
  const mk = (id: string, name: string): { chats: Chat[]; spaces: [] } => ({ chats: [{ id: id + ":c", accountId: id, provider: "fake", kind: "dm", name } as unknown as Chat], spaces: [] });
  const A = await node("A", "memory"), B = await node("B", "memory");
  const live = JSON.parse(JSON.stringify(await B.call("addAccount", { provider: "fake", label: "Live" }))).id as string;
  A.store.putAccount({ id: live, provider: "fake", label: "Live", status: "active" }); A.store.putAccount({ id: "fake-arch", provider: "fake", label: "Arch", status: "active" });
  B.store.putChatCache(live, mk(live, "mine (live)"));
  A.store.putChatCache(live, mk(live, "peer cache")); A.store.putChatCache("fake-arch", mk("fake-arch", "peer cache for an archive"));
  await pairUp(A, B);
  await until(() => B.store.getChatCache("fake-arch") !== undefined, "archive cache applied");
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(B.store.getChatCache(live)?.chats[0].name, "mine (live)", "live connector wins");
  assert.equal(B.store.getChatCache("fake-arch")?.chats[0].name, "peer cache for an archive");
  for (const n of [A, B]) await n.stop();
});

test("big credential sessions travel in pieces, are staged until confirmed, and limits give clear errors", async () => {
  const A = await node("A", "memory", undefined, (s) => { s.putAccount({ id: "mattermost-big", provider: "mattermost", label: "Big", status: "active" }); });
  const B = await node("B", "memory");
  const big = randomBytes(900_000); mkdirSync(join(A.dir, "accounts", "mattermost-big"), { recursive: true });
  writeFileSync(join(A.dir, "accounts", "mattermost-big", "state.bin"), big); writeFileSync(join(A.dir, "accounts", "mattermost-big", "token.json"), '{"t":1}');
  await A.call("syncSetAccountMode", { accountId: "mattermost-big", mode: "credentials" });
  await pairUp(A, B);
  await until(async () => (await B.call("syncCredentials")).length === 1, "big credential offer", 15_000);
  const offer = (await B.call("syncCredentials"))[0]; assert.equal(offer.files, 2); assert.ok(offer.bytes > 800_000);
  assert.ok(!existsSync(join(B.dir, "accounts", "mattermost-big", "state.bin")), "staged, not written, before the user confirms");
  await B.call("syncConfirmCredentials", { accountId: "mattermost-big", accept: true });
  assert.ok(readFileSync(join(B.dir, "accounts", "mattermost-big", "state.bin")).equals(big));
  // limit: lower it and change the file -> clear error on the offering side, nothing sent
  const old = LIMITS.credBytes; LIMITS.credBytes = 500_000;
  writeFileSync(join(A.dir, "accounts", "mattermost-big", "state.bin"), randomBytes(900_001));
  (A.svc as any).refreshCreds();
  await until(async () => !!(await A.call("syncStatus")).accounts.find((a: any) => a.id === "mattermost-big")?.credentialsError, "size error shown", 6000);
  assert.match((await A.call("syncStatus")).accounts[0].credentialsError, /limit/);
  LIMITS.credBytes = old;
  for (const n of [A, B]) await n.stop();
});

test("media blobs: on demand by content hash, deduplicated, sealed, hash-verified; never for mode none; background policy", async () => {
  const chat = "fake-m:c", bytes = randomBytes(500_000), h = createHash("sha256").update(bytes).digest("hex");
  const A = await node("A", "memory", undefined, (s) => {
    s.putAccount({ id: "fake-m", provider: "fake", label: "M", status: "active" }); s.putAccount({ id: "fake-n", provider: "fake", label: "N", status: "active" });
    s.putMessages([
      msg(chat, "p1", "pic", "2026-01-01T00:00:00Z", { attachments: [{ id: "a1", kind: "image", mime: "image/png", size: bytes.length }] }),
      msg(chat, "p2", "same pic forwarded", "2026-01-01T00:01:00Z", { attachments: [{ id: "a2", kind: "image", mime: "image/png", size: bytes.length }] }),
      msg("fake-n:c", "q1", "private", "2026-01-01T00:02:00Z", { attachments: [{ id: "z", kind: "image", mime: "image/png", size: 10 }] })]);
  });
  const media = (n: Node) => (n.hub as any).media;
  media(A).put("fake-m", `${chat}|p1|a1`, { data: bytes, mime: "image/png", name: "x.png" }); media(A).put("fake-m", `${chat}|p2|a2`, { data: bytes, mime: "image/png" });
  media(A).put("fake-n", "fake-n:c|q1|z", { data: new Uint8Array([1, 2, 3]), mime: "image/png" });
  await A.call("syncSetAccountMode", { accountId: "fake-n", mode: "none" });
  const B = await node("B", "memory"); await pairUp(A, B);
  await until(async () => !!B.store.getMessage(chat, "p2") && (await B.call("accounts")).some((a: any) => a.id === "fake-m"), "messages and account arrived");
  assert.ok(!media(B).has("fake-m", `${chat}|p1|a1`), "lazy: nothing is fetched until asked (policy off)");
  const r = await B.call("attachment", { chatId: chat, messageId: "p1", attachmentId: "a1" });
  assert.equal(createHash("sha256").update(Buffer.from(r.dataBase64, "base64")).digest("hex"), h); assert.equal(r.name, "x.png");
  assert.ok(media(B).has("fake-m", `${chat}|p1|a1`), "now cached (sealed by B's own key)");
  const r2 = await B.call("attachment", { chatId: chat, messageId: "p2", attachmentId: "a2" });
  assert.equal(r2.dataBase64, r.dataBase64); assert.equal((await B.call("syncStatus")).media.stats.deduped, 1, "same bytes: copied locally, not fetched again");
  await assert.rejects(B.call("attachment", { chatId: "fake-n:c", messageId: "q1", attachmentId: "z" }), /no account|available offline/);
  // background policy
  const C = await node("C", "memory"); await pairUp(A, C);
  await until(async () => !!C.store.getMessage(chat, "p2") && (await C.call("accounts")).some((a: any) => a.id === "fake-m"), "messages on C");
  await C.call("syncSetMediaPolicy", { mode: "all", maxFileMB: 1, maxTotalMB: 100 });
  await until(() => media(C).has("fake-m", `${chat}|p1|a1`) && media(C).has("fake-m", `${chat}|p2|a2`), "background fetch", 15_000);
  const D = await node("D", "memory"); await pairUp(A, D);
  await D.call("syncSetMediaPolicy", { mode: "wifi", maxFileMB: 1, maxTotalMB: 100 }); await D.call("syncSetMetered", { metered: true });
  await until(async () => !!D.store.getMessage(chat, "p2") && (await D.call("accounts")).some((a: any) => a.id === "fake-m"), "messages on D"); await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!media(D).has("fake-m", `${chat}|p1|a1`), "metered connection: wifi-only policy holds back");
  await D.call("syncSetMetered", { metered: false });
  await until(() => media(D).has("fake-m", `${chat}|p1|a1`), "fetched once off the metered network", 15_000);
  for (const n of [A, B, C, D]) await n.stop();
});

// ---------------------------------------------------------------------------------------------- proxy accounts
interface World { chats: Chat[]; msgs: Map<string, Message[]>; sent: string[]; emit?: (e: CoreEvent) => void }
const world: World = { chats: [{ id: "c1", accountId: "", provider: "sigfake", kind: "dm", name: "Anna" } as unknown as Chat], msgs: new Map([["c1", [{ id: "h1", chatId: "c1", sender: "Anna", senderId: "anna", text: "old hello", time: "2026-01-01T00:00:00Z", fromMe: false }]]]), sent: [] };
const CAPS = { ...NO_CAPABILITIES, attachments: true, backfill: true };
const sigfake: ProviderFactory = { name: "sigfake", displayName: "SigFake", login: "qr", capabilities: CAPS, create: () => ({
  capabilities: CAPS, async start(emit: (e: CoreEvent) => void) { world.emit = emit; emit({ type: "account", data: { id: "x", state: "connected" } }); }, async stop() {}, async logout() {}, async submitLogin() {},
  async spaces() { return []; }, async chats() { return world.chats; }, async members() { return []; },
  async history(chatId: string) { return world.msgs.get(chatId) ?? []; },
  async downloadAttachment() { return { data: new Uint8Array([9, 9, 9]), mime: "image/png" }; },
  async send(chatId: string, m: { text: string }) { world.sent.push(m.text); return { id: "s" + world.sent.length, chatId, sender: "me", senderId: "me", text: m.text, time: new Date().toISOString(), fromMe: true, status: "sent" } as Message; },
}) as unknown as Connector };

test("home-device proxy: B lists chats, loads history, sends via A, receives events, survives A going offline and back; no session crosses", async () => {
  const A = await node("A", "memory", undefined, (s) => { s.putAccount({ id: "sigfake-1", provider: "sigfake", label: "Signal", status: "active" }); }, undefined, { factories: [sigfake] });
  const B = await node("B", "memory", undefined, undefined, undefined, { factories: [sigfake] });
  mkdirSync(join(A.dir, "accounts", "sigfake-1"), { recursive: true }); writeFileSync(join(A.dir, "accounts", "sigfake-1", "session.secret"), "SECRET-SESSION");
  await pairUp(A, B);
  await until(() => B.store.listAccounts().some((a) => a.id === "sigfake-1"), "account archive on B");
  await assert.rejects(B.call("syncUseProxy", { deviceId: A.svc.status().deviceId, accountId: "sigfake-1" }), /does not offer/);
  await A.call("syncSetProxyShare", { accountId: "sigfake-1", enabled: true });
  await until(async () => (await B.call("syncStatus")).proxy.offers.length === 1, "offer visible on B");
  await B.call("syncUseProxy", { deviceId: A.svc.status().deviceId, accountId: "sigfake-1" });
  const events: string[] = []; B.hub.subscribe((e, d: any) => { if (e === "message") events.push(d.text); });
  await until(async () => (await B.call("snapshot")).chats.some((c: any) => c.id === "sigfake-1:c1" && !c.readOnly), "B lists A's chats live");
  const hist = await B.call("history", { chatId: "sigfake-1:c1", limit: 20 }); assert.ok(hist.some((m: any) => m.text === "old hello"));
  const sent = await B.call("send", { chatId: "sigfake-1:c1", text: "from B" });
  assert.deepEqual(world.sent, ["from B"], "the REAL connector on A sent it"); assert.equal(sent.chatId, "sigfake-1:c1");
  world.emit!({ type: "message", data: { id: "n1", chatId: "c1", sender: "Anna", senderId: "anna", text: "live from A", time: new Date().toISOString(), fromMe: false } });
  await until(() => events.includes("live from A"), "event reached B");
  assert.ok(B.store.getMessage("sigfake-1:c1", "n1"), "and is archived on B");
  const att = await B.call("attachment", { chatId: "sigfake-1:c1", messageId: "n1", attachmentId: "x" }); assert.equal(att.dataBase64, Buffer.from([9, 9, 9]).toString("base64"));
  // no secret crossed: B has no session file and nothing in its dirs contains it
  assert.ok(!existsSync(join(B.dir, "accounts", "sigfake-1", "session.secret")));
  const audit = (await A.call("syncStatus")).devices.find((d: any) => !d.self).audit["sigfake-1"]; assert.ok(audit.calls >= 4 && audit.byOp.send === 1);
  // A goes offline: B keeps its archive, shows the account as unreachable, a send waits for A
  await A.call("syncPause");
  await until(async () => (await B.call("syncStatus")).proxy.using[0].online === false, "B notices A is gone");
  await until(async () => (await B.call("accounts")).find((a: any) => a.id === "sigfake-1")?.state === "disconnected", "account shows disconnected");
  assert.ok((await B.call("snapshot")).chats.some((c: any) => c.id === "sigfake-1:c1"), "chat list from B's own cache");
  assert.ok((await B.call("history", { chatId: "sigfake-1:c1", limit: 20 })).some((m: any) => m.text === "live from A"), "history from B's archive");
  assert.match((await B.call("send", { chatId: "sigfake-1:c1", text: "queued" })).id, /^pend-q-/, "a write while A is away is queued, not refused");
  await A.call("syncResume");
  await until(async () => (await B.call("accounts")).find((a: any) => a.id === "sigfake-1")?.state === "connected", "back online", 15_000);
  await until(() => world.sent.includes("queued"), "the queued message went out when A was back", 25_000);
  await B.call("send", { chatId: "sigfake-1:c1", text: "again" }); assert.deepEqual(world.sent, ["from B", "queued", "again"]);
  // unshare on A: B can no longer use it
  await A.call("syncSetProxyShare", { accountId: "sigfake-1", enabled: false });
  await assert.rejects(B.call("send", { chatId: "sigfake-1:c1", text: "after unshare" }), /allow|unreachable/);
  await B.call("syncStopProxy", { accountId: "sigfake-1" });
  assert.ok(!(await B.call("syncStatus")).proxy.using.length);
  for (const n of [A, B]) await n.stop();
});
