// In server channels people are named by their server nickname (Discord's "server profile"), not their username or global name.
import test from "node:test";
import assert from "node:assert/strict";
import factory from "./index.js";
import { ALICE, BOB, C, G1, setup } from "./helpers.js";

const GONE = "1000000000000009";
test("server nicknames: history senders, mentions and replies use them; DMs keep the profile name; unknown members are looked up once", async () => {
  const s = await setup(factory, { prep: (f) => {
    f.user(GONE, "gone", "Gone Person");
    f.guilds.get(G1)!.members.find((m) => m.user.id === BOB)!.nick = "Bobby"; // not in the start-up payload: looked up
    const q = f.say(C.general, ALICE, "who knows?");
    f.say(C.general, BOB, `<@${ALICE}> me`, { mentions: [f.users.get(ALICE)!] as any, message_reference: { message_id: q.id, channel_id: C.general } as any, referenced_message: q as any });
    f.say(C.general, GONE, "bye");
    f.say(C.dm, ALICE, "hi in private");
  } });
  try {
    await s.loaded();
    const h = await s.conn.history(C.general, { limit: 50 });
    const by = (t: string) => h.find((m: any) => m.text === t || m.text.endsWith(t))!;
    assert.equal(by("who knows?").sender, "Ally");
    const r = by(" me"); assert.equal(r.sender, "Bobby"); assert.equal(r.text, "@Ally me"); assert.equal(r.replyTo.sender, "Ally");
    assert.equal(by("bye").sender, "Gone Person"); // left the server: the profile name
    const looked = s.fake.reqs(/^GET \/guilds\/\d+\/members\/\d+$/).length;
    assert.ok(looked >= 2 && looked <= 3, `member lookups: ${looked}`);
    await s.conn.history(C.general, { limit: 50 });
    assert.equal(s.fake.reqs(/^GET \/guilds\/\d+\/members\/\d+$/).length, looked, "known nicknames are not looked up again");
    const dm = await s.conn.history(C.dm, { limit: 50 });
    assert.equal(dm.find((m: any) => m.text === "hi in private").sender, "Alice Wonder");
    const mem = await s.conn.members(C.general);
    assert.ok(mem.some((c: any) => c.id === BOB && c.name === "Bobby"));
  } finally { await s.close(); }
});

test("aliases of a DM's person: profile name, @username and their nickname per shared server", async () => {
  const s = await setup(factory);
  try {
    await s.loaded(); await s.conn.startChat(ALICE); // a bot knows a DM once it is opened
    assert.deepEqual(await s.conn.aliases(C.dm), [{ name: "Alice Wonder", kind: "profile" }, { name: "@alice", kind: "username" }, { name: "Ally", kind: "nickname", space: G1 }]);
    assert.deepEqual(await s.conn.aliases(C.general), [], "only direct chats");
  } finally { await s.close(); }
});
