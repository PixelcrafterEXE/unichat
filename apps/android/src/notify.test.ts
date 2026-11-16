import test from "node:test";
import assert from "node:assert/strict";
import { buildNotification, summarize, withAvatar, MAX_AVATAR_B64 } from "./notify.js";

const snap = { spaces: [{ id: "s1", muted: true }], chats: [{ id: "a:1", name: "Alice", kind: "dm" }, { id: "a:2", name: "Family", kind: "group" }, { id: "a:3", name: "Muted", kind: "dm", muted: true }, { id: "a:4", name: "InMutedSpace", kind: "group", spaceId: "s1" }] };

test("notification rules: muted chat/space, own, historical, privacy modes", () => {
  assert.deepEqual(buildNotification({ id: "m", chatId: "a:1", sender: "Alice", text: "hi" }, snap, "full"), { chatId: "a:1", messageId: "m", title: "Alice", body: "hi" });
  assert.equal(buildNotification({ id: "m", chatId: "a:2", sender: "Bob", text: "yo" }, snap, "full")?.body, "Bob: yo");
  assert.equal(buildNotification({ id: "m", chatId: "a:3", sender: "X", text: "z" }, snap, "full"), undefined);
  assert.equal(buildNotification({ id: "m", chatId: "a:4", sender: "X", text: "z" }, snap, "full"), undefined);
  assert.equal(buildNotification({ id: "m", chatId: "a:1", fromMe: true, text: "z" }, snap, "full"), undefined);
  assert.deepEqual(buildNotification({ id: "m", chatId: "a:1", sender: "Alice", text: "secret" }, snap, "hidden"), { chatId: "a:1", messageId: "m", title: "UniChat", body: "New message" });
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
