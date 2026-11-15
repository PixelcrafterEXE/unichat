// Pinned messages against the fake Discord: PUT / DELETE /channels/{id}/pins/{message}, GET /channels/{id}/pins, MESSAGE_UPDATE {pinned}. No real service.
import test from "node:test";
import assert from "node:assert/strict";
import factory from "./index.js";
import { ALICE, C, setup, waitFor } from "./helpers.js";

test("pin / unpin use the pins endpoints; the gateway echo marks the message, a pin by someone else too", async () => {
  const s = await setup(factory);
  try {
    await s.loaded(); const F = s.fake;
    assert.equal(s.conn.capabilities.pinMessages, true);
    const m = F.say(C.general, ALICE, "pin me"); F.dispatch("MESSAGE_CREATE", m);
    await waitFor(() => s.of("message").length === 1);
    await s.conn.pin(C.general, m.id, true);
    assert.equal(F.reqs(/PUT \/channels\/\d+\/pins\/\d+$/).length, 1);
    assert.equal(F.messages.get(C.general)!.find((x: any) => x.id === m.id)!.pinned, true);
    await waitFor(() => s.of("message-update").some((e: any) => e.patch.pinned === true));
    assert.deepEqual((await s.conn.pins(C.general)).map((x: any) => [x.id, x.pinned, x.text]), [[m.id, true, "pin me"]]);
    await s.conn.pin(C.general, m.id, false);
    assert.equal(F.reqs(/DELETE \/channels\/\d+\/pins\/\d+$/).length, 1);
    await waitFor(() => s.of("message-update").some((e: any) => e.patch.pinned === false));
    assert.deepEqual(await s.conn.pins(C.general), []);
    // pinned by another participant (gateway only)
    const n0 = s.of("message-update").length;
    F.dispatch("MESSAGE_UPDATE", { id: m.id, channel_id: C.general, pinned: true });
    await waitFor(() => s.of("message-update").length > n0);
    assert.equal(s.of("message-update").at(-1).patch.pinned, true); assert.ok(s.of("message-update").at(-1).patch.pinnedAt);
    // a plain update without the flag leaves pins alone
    const n1 = s.of("message-update").length;
    F.dispatch("MESSAGE_UPDATE", { id: m.id, channel_id: C.general, embeds: [] });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(s.of("message-update").slice(n1).every((e: any) => e.patch.pinned === undefined));
  } finally { await s.close(); }
});

test("history marks pinned messages, a refused pin says so in plain words", async () => {
  const s = await setup(factory, { prep: (f: any) => { f.say(C.general, ALICE, "old pinned", { pinned: true }); } });
  try {
    await s.loaded(); const F = s.fake;
    const h = await s.conn.history(C.general, { limit: 50 });
    assert.equal(h.find((x: any) => x.text === "old pinned").pinned, true);
    F.blockedChannels.add("pins:" + C.general);
    await assert.rejects(s.conn.pin(C.general, h.find((x: any) => x.text === "old pinned").id, false), /permission to pin/);
    await assert.rejects(s.conn.pin(C.general, "abc", true), /Unknown message/);
  } finally { await s.close(); }
});
