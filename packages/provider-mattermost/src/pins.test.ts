// Pinned posts against the fake Mattermost: POST /posts/{id}/pin|unpin, GET /channels/{id}/pinned, post_edited with is_pinned. No real service.
import test from "node:test";
import assert from "node:assert/strict";
import factory from "./index.js";
import { setup, waitFor } from "./helpers.js";

test("pin / unpin call the pin endpoints; the server echo and a pin by someone else mark the post without counting as an edit", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected);
    assert.equal(s.conn.capabilities.pinMessages, true);
    const p = s.fake.addPost("c_gm", "u_bob", "group hi"); s.fake.pushPosted(p);
    await waitFor(() => s.of("message").some((m: any) => m.chatId === "c_gm"));
    await s.conn.pin("c_gm", p.id, true);
    assert.equal(s.fake.reqs(/^POST \/posts\/\w+\/pin$/).length, 1);
    await waitFor(() => s.of("message-update").filter((u: any) => u.patch.pinned === true).length >= 1);
    assert.deepEqual((await s.conn.pins("c_gm")).map((m: any) => [m.id, m.pinned]), [[p.id, true]]);
    await s.conn.pin("c_gm", p.id, false);
    assert.equal(s.fake.reqs(/^POST \/posts\/\w+\/unpin$/).length, 1);
    await waitFor(() => s.of("message-update").some((u: any) => u.patch.pinned === false));
    assert.deepEqual(await s.conn.pins("c_gm"), []);
    // somebody else pins: a post_edited whose only change is is_pinned
    const n = s.of("message-update").length;
    p.is_pinned = true; p.update_at = p.create_at + 50; s.fake.push("post_edited", { post: JSON.stringify(p) }, { channel_id: "c_gm" });
    await waitFor(() => s.of("message-update").length > n);
    await new Promise((r) => setTimeout(r, 100));
    const ups = s.of("message-update").slice(n);
    assert.ok(ups.some((u: any) => u.patch.pinned === true && u.patch.pinnedAt));
    assert.ok(ups.every((u: any) => u.patch.text === undefined && u.patch.editedAt === undefined), "a pin is not an edit");
  } finally { await s.close(); }
});

test("history marks posts that are pinned on the server", async () => {
  const s = await setup(factory, { prep: (f) => { const p = f.addPost("c_gm", "u_bob", "old pinned"); (p as any).is_pinned = true; } });
  try {
    await waitFor(s.connected);
    const h = await s.conn.history("c_gm", { limit: 50 });
    assert.equal(h.find((m: any) => m.text === "old pinned")!.pinned, true);
  } finally { await s.close(); }
});
