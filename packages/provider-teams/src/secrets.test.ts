// No token / message text / names / ids may leak into error text, error/account/login events or UNIMSG_DEBUG output.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ALICE, BOB, C, CHAN, ME, T1, setup, waitFor } from "./helpers.js";
import { CLIENT_ID } from "./fake-server.js";

test("secrets never appear in errors, error/account/login events, debug logs or stored files", async () => {
  process.env.UNIMSG_DEBUG = "1";
  const logs: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (c: any) => { logs.push(String(c)); return true; };
  const { default: factory } = await import("./index.js");
  const SECRET_TEXT = "TOP-SECRET-MESSAGE-TEXT";
  const s = await setup(factory, { noSession: true, prep: (f) => { f.say(C.dm, ALICE, `<p>${SECRET_TEXT}</p>`); f.say(C.group, BOB, "<p>secret group text</p>"); f.say(CHAN.general, ALICE, "<p>secret channel text</p>"); } });
  const errors: string[] = [];
  try {
    await waitFor(() => s.of("login").length > 0);
    const id = s.of("login")[0].promptId;
    await s.conn.submitLogin(id, { client_id: "bad-SECRETCLIENT" }).catch((e: Error) => errors.push(e.message));
    await s.conn.submitLogin(id, { client_id: CLIENT_ID, tenant: "organizations", channels: "true", files: "true" });
    await waitFor(s.connected);
    await s.conn.chats();
    const hist = await s.conn.history(C.dm, { limit: 5 });
    assert.equal(hist.at(-1).text, SECRET_TEXT);
    await s.conn.history(CHAN.general, { limit: 5 });
    await s.conn.send(C.dm, { text: "SENT-SECRET-TEXT-2 @Alice" });
    s.fake.throttleNext = 1; await s.conn.history(C.dm, { limit: 5 });
    s.fake.failNext = 1; await s.conn.members(C.dm).catch((e: Error) => errors.push(e.message));
    await s.conn.edit(C.dm, "123456789", "EDIT-SECRET").catch((e: Error) => errors.push(e.message));
    await s.conn.delete(C.dm, hist.at(-1).id).catch((e: Error) => errors.push(e.message));
    await s.conn.startChat("zzz-nobody@example.test").catch((e: Error) => errors.push(e.message));
    await s.conn.startChat("not an address").catch((e: Error) => errors.push(e.message));
    await s.conn.downloadAttachment(C.dm, hist.at(-1).id, "ref:nope").catch((e: Error) => errors.push(e.message));
    await s.conn.leaveChat(C.dm).catch((e: Error) => errors.push(e.message));
    s.fake.live(); s.fake.say(C.dm, BOB, "<p>LIVE-SECRET-TEXT</p>");
    await waitFor(() => s.of("message").some((m: any) => m.text === "LIVE-SECRET-TEXT"));
    s.fake.revokeAll();
    await s.conn.history(C.dm, { limit: 5 }).catch((e: Error) => errors.push(e.message));
    await waitFor(() => s.ev.some((e) => e.type === "account" && e.data.state === "needs-login"), 15000);
    await new Promise((r) => setTimeout(r, 200));
  } finally { (process.stderr as any).write = orig; await s.close(); delete process.env.UNIMSG_DEBUG; }
  const blob = [...errors, ...s.ev.filter((e) => e.type === "error" || e.type === "account" || e.type === "login").map((e) => JSON.stringify(e)), ...logs].join("\n");
  assert.ok(logs.length > 0, "debug logging is active");
  assert.ok(errors.length >= 5, "errors were produced and checked");
  const secrets = ["fakeAT", "fakeRT", "Bearer", "dc-", "SECRETCLIENT", SECRET_TEXT, "SENT-SECRET-TEXT-2", "EDIT-SECRET", "LIVE-SECRET-TEXT", "secret group text", "secret channel text", "SERVER-ERROR-DETAIL", "SECRET-DESC",
    "Alice", "alice", "Bob", "bob", "Me Myself", "me@example", "zzz-nobody", ALICE, BOB, ME, T1, C.dm, C.group, "thread.v2", "thread.tacv2", "Engineering", "Weekly Standup", "123456789"];
  for (const secret of secrets) assert.ok(!blob.includes(secret), `leaked: ${secret}`);
  // the device user code is shown to the user on purpose (it is public by design), but never the device_code
  for (const f of readdirSync(s.dir)) assert.ok(!/fakeRT|fakeAT/.test(readFileSync(join(s.dir, f), "utf8")), `plain token in ${f}`);
});
