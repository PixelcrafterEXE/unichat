import test from "node:test";
import assert from "node:assert/strict";
import { buildNotification, PostedNotifications, summarize, withAvatar, MAX_AVATAR_B64 } from "./notify.js";

const snap = { spaces: [{ id: "s1", muted: true }], chats: [{ id: "a:1", name: "Alice", kind: "dm" }, { id: "a:2", name: "Family", kind: "group" }, { id: "a:3", name: "Muted", kind: "dm", muted: true }, { id: "a:4", name: "InMutedSpace", kind: "group", spaceId: "s1" }] };

test("notification rules: muted chat/space, own, historical, privacy modes", () => {
  const at = new Date(Date.now() - 5000).toISOString(), ms = Date.parse(at);
  assert.deepEqual(buildNotification({ id: "m", chatId: "a:1", sender: "Alice", text: "hi", time: at }, snap, "full"), { chatId: "a:1", messageId: "m", title: "Alice", body: "hi", text: "hi", group: false, time: ms });
  assert.equal(buildNotification({ id: "m", chatId: "a:2", sender: "Bob", text: "yo" }, snap, "full")?.body, "Bob: yo");
  assert.equal(buildNotification({ id: "m", chatId: "a:3", sender: "X", text: "z" }, snap, "full"), undefined);
  assert.equal(buildNotification({ id: "m", chatId: "a:4", sender: "X", text: "z" }, snap, "full"), undefined);
  assert.equal(buildNotification({ id: "m", chatId: "a:1", fromMe: true, text: "z" }, snap, "full"), undefined);
  assert.deepEqual(buildNotification({ id: "m", chatId: "a:1", sender: "Alice", text: "secret", time: at }, snap, "hidden"), { chatId: "a:1", messageId: "m", title: "UniChat", body: "New message", text: "New message", group: false, time: ms });
  // one notification per chat lists its messages: in a group each line names its sender, in full mode only
  const g = buildNotification({ id: "m", chatId: "a:2", sender: "Bob", text: "yo" }, snap, "full")!;
  assert.deepEqual([g.text, g.sender, g.group], ["yo", "Bob", true]);
  const gs = buildNotification({ id: "m", chatId: "a:2", sender: "Bob", text: "yo" }, snap, "sender")!;
  assert.deepEqual([gs.text, gs.sender], ["New message", undefined], "sender mode does not reveal the text");
  assert.equal(summarize({ id: "x", chatId: "c", attachments: [{ kind: "voice" }] }), "Voice message");
});

const n = { chatId: "a:1", messageId: "m", title: "Alice", body: "hi" };
const pic = { dataBase64: "iVBORw0KGgo=", mime: "image/png" };

test("withAvatar attaches the chat picture in full and sender modes", async () => {
  assert.deepEqual(await withAvatar(n, "full", async () => pic), { ...n, avatar: pic.dataBase64 });
  assert.deepEqual(await withAvatar(n, "sender", async () => pic), { ...n, avatar: pic.dataBase64 });
});

test("withAvatar never fetches or attaches a picture in hidden mode", async () => {
  let called = 0;
  assert.deepEqual(await withAvatar(n, "hidden", async () => { called++; return pic; }), n);
  assert.equal(called, 0);
});

test("withAvatar fails safe: no picture, wrong type, too big, RPC error, timeout", async () => {
  assert.deepEqual(await withAvatar(n, "full", async () => null), n);
  assert.deepEqual(await withAvatar(n, "full", async () => ({ dataBase64: "AAAA", mime: "image/svg+xml" })), n);
  assert.deepEqual(await withAvatar(n, "full", async () => ({ dataBase64: "A".repeat(MAX_AVATAR_B64 + 1), mime: "image/jpeg" })), n);
  assert.deepEqual(await withAvatar(n, "full", async () => { throw new Error("boom"); }), n);
  assert.deepEqual(await withAvatar(n, "full", () => new Promise(() => {}), undefined, { timeoutMs: 20 }), n);
});

test("withAvatar caches answers (also misses) until the ttl", async () => {
  const cache = new Map<string, { at: number; v?: string }>(); let calls = 0, t = 0;
  const f = async () => { calls++; return pic; };
  await withAvatar(n, "full", f, cache, { now: () => t }); await withAvatar(n, "full", f, cache, { now: () => t + 1000 });
  assert.equal(calls, 1);
  await withAvatar(n, "full", f, cache, { now: () => t + 7 * 3600_000 });
  assert.equal(calls, 2);
  const miss = new Map<string, { at: number; v?: string }>(); let m = 0;
  await withAvatar(n, "full", async () => { m++; return null; }, miss); await withAvatar(n, "full", async () => { m++; return null; }, miss);
  assert.equal(m, 1);
});

test("PostedNotifications: a notification goes when its chat is no longer unread", () => {
  const p = new PostedNotifications();
  p.posted("a:1"); p.posted("a:2");
  assert.deepEqual(p.readNow({ chats: [{ id: "a:1", unread: 2 }, { id: "a:2", unread: 1 }] }), []);
  assert.deepEqual(p.readNow({ chats: [{ id: "a:1", unread: 0 }, { id: "a:2", unread: 1 }] }), ["a:1"]);
  assert.deepEqual(p.readNow({ chats: [{ id: "a:1", unread: 0 }, { id: "a:2", unread: 1 }] }), [], "cleared once, not again");
  assert.deepEqual(p.readNow({ chats: [{ id: "a:1", unread: 0 }] }), ["a:2"], "a chat that is gone counts as read");
  assert.equal(p.size, 0);
});

test("PostedNotifications: no snapshot, no chats, nothing posted -> nothing to clear", () => {
  const p = new PostedNotifications();
  assert.deepEqual(p.readNow(undefined), []);
  p.posted("a:1");
  assert.deepEqual(p.readNow(undefined), [], "without a chat list nothing is assumed");
  assert.deepEqual(p.readNow({}), []);
  assert.deepEqual(p.clear(), ["a:1"]); // the UI came to the foreground
  assert.deepEqual(p.clear(), []);
});

test("starred chats: the notification says so (its own channel); a merged chat's star and mute count for its members", () => {
  const now = new Date().toISOString();
  const m = { id: "1", chatId: "a:x", text: "hi", sender: "Ann", time: now };
  const snap = { chats: [{ id: "a:x", name: "Ann", kind: "dm", starred: true }, { id: "a:y", name: "Bob", kind: "dm" }, { id: "merge:1", name: "Bob (all)", kind: "dm", starred: true }, { id: "merge:2", name: "Cy", kind: "dm", muted: true }] };
  assert.equal(buildNotification(m, snap, "full")!.starred, true);
  assert.equal(buildNotification({ ...m, chatId: "a:y" }, snap, "full")!.starred, undefined);
  const viaMerge = buildNotification({ ...m, chatId: "a:y", mergeId: "merge:1" }, snap, "full")!;
  assert.equal(viaMerge.starred, true); assert.equal(viaMerge.title, "Bob (all)");
  assert.equal(buildNotification({ ...m, chatId: "a:y", mergeId: "merge:2" }, snap, "full"), undefined, "a muted merged chat stays quiet");
});
