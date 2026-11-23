// node --test (via tsx): Mattermost thread links derived for saved messages.   cd apps/ui && npx tsx --test src/threadlinks.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { withThreadLinks } from "./threadlinks";
import type { Message } from "./types";

const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, chatId: "mm:c", sender: "A", senderId: "a", text: id, time: "2026-01-01T00:00:00Z", fromMe: false, ...extra });
const mm = () => "mattermost";

test("replies link to their thread; a loaded first post counts its replies; network links and other providers stay as they are", () => {
  const out = withThreadLinks([msg("root"), msg("plain"), msg("r1", { replyTo: { messageId: "root" } }), msg("r2", { replyTo: { messageId: "root" } }), msg("r3", { replyTo: { messageId: "gone" } })], mm);
  assert.deepEqual(out.map((m) => m.thread ?? null), [{ id: "thread~root", count: 2 }, null, { id: "thread~root" }, { id: "thread~root" }, { id: "thread~gone" }]);
  const given = msg("root2", { thread: { id: "thread~root2", count: 9 } });
  assert.equal(withThreadLinks([given, msg("x", { replyTo: { messageId: "root2" } })], mm)[0], given, "the network's own link wins");
  const wa = [msg("a"), msg("b", { replyTo: { messageId: "a" } })];
  assert.equal(withThreadLinks(wa, () => "whatsapp"), wa, "other networks: untouched");
});
