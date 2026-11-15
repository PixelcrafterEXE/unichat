// Pinned chat messages (Graph pinnedChatMessageInfo) against the fake Graph. Channels are refused. No real service.
import test from "node:test";
import assert from "node:assert/strict";
import factory from "./index.js";
import { C, CHAN, setup, waitFor } from "./helpers.js";

test("pin / unpin / pins use /chats/{id}/pinnedMessages; others' pins are learnt through pins(); channels are refused", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected); await s.conn.chats();
    assert.equal(s.conn.capabilities.pinMessages, true);
    s.fake.say(C.dm, "aaaaaaaa-0000-4000-8000-000000000002", "<p>second</p>");
    const hist = await s.conn.history(C.dm, { limit: 20 }); assert.ok(hist.length >= 2);
    const id = hist[hist.length - 1]!.id;
    await s.conn.pin(C.dm, id, true);
    const body = s.fake.bodies.find((b) => /pinnedMessages$/.test(b.path))!.body;
    assert.match(body["message@odata.bind"], new RegExp(`/chats/.+/messages/${id}$`));
    assert.equal(s.of("message-update").at(-1).patch.pinned, true);
    assert.deepEqual((await s.conn.pins(C.dm)).map((m: any) => [m.id, m.pinned]), [[id, true]]);
    // someone else pinned another one: only visible through pins()
    const other = hist[0]!.id; s.fake.pinned.get(s.fake.chats.get(C.dm)!.id)!.push({ id: "pinX", messageId: other });
    assert.deepEqual((await s.conn.pins(C.dm)).map((m: any) => m.id).sort(), [id, other].sort());
    await s.conn.pin(C.dm, other, false); // the info id was learnt from the listing
    assert.deepEqual((await s.conn.pins(C.dm)).map((m: any) => m.id), [id]);
    assert.deepEqual(s.of("message-update").at(-1).patch, { pinned: false });
    await assert.rejects(s.conn.pin(C.dm, other, false), /not pinned/);
    await assert.rejects(s.conn.pin(CHAN.general, "1", true), /channels/);
    assert.deepEqual(await s.conn.pins(CHAN.general), []);
  } finally { await s.close(); }
});
