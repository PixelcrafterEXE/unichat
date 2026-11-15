// No token / message text / user names / ids may leak into error text, error/account/login events or UNIMSG_DEBUG output.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ALICE, BOB, C, G1, ME, setup, waitFor } from "./helpers.js";

for (const mode of ["bot", "user"] as const) {
  test(`secrets never appear in errors, error/account/login events, debug logs or stored files (${mode} mode)`, async () => {
    process.env.UNIMSG_DEBUG = "1";
    const logs: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (c: any) => { logs.push(String(c)); return true; };
    const { default: factory } = await import("./index.js");
    const SECRET_TEXT = "TOP-SECRET-MESSAGE-TEXT";
    const TOKEN = mode === "bot" ? "bot-SECRETTOKEN-xyz" : "user-SECRETTOKEN-xyz";
    const s = await setup(factory, { mode, noSession: true, prep: (f) => { f.token(TOKEN, mode, ME); f.say(C.general, ALICE, SECRET_TEXT); f.say(C.dm, BOB, "secret server text"); } });
    const errors: string[] = [];
    try {
      await waitFor(() => s.of("login").length > 0);
      const id = s.of("login")[0].promptId;
      for (const v of [{ mode, token: "wrong-BADTOKEN-123", confirm: "YES" }, { mode: "user", token: TOKEN, confirm: "" }])
        await s.conn.submitLogin(id, v).catch((e: Error) => errors.push(e.message));
      await s.conn.submitLogin(id, { mode, token: TOKEN, confirm: "YES" });
      await s.loaded();
      const hist = await s.conn.history(C.general, { limit: 5 });
      assert.equal(hist.at(-1).text, SECRET_TEXT);
      await s.conn.send(C.general, { text: "SENT-SECRET-TEXT-2 @alice" });
      s.fake.rateLimitNext = 1; await s.conn.history(C.general, { limit: 5 });
      s.fake.failNext = 1; await s.conn.history(C.general, { limit: 5 }).catch((e: Error) => errors.push(e.message));
      await s.conn.edit(C.general, "123456789012345", "EDIT-SECRET").catch((e: Error) => errors.push(e.message));
      await s.conn.startChat("zzz-nobody-name").catch((e: Error) => errors.push(e.message));
      await s.conn.react(C.general, hist.at(-1).id, ":nosuchemoji:").catch((e: Error) => errors.push(e.message));
      await s.conn.downloadAttachment(C.general, hist.at(-1).id, "nope").catch((e: Error) => errors.push(e.message));
      // live traffic with text
      const live = s.fake.say(C.general, BOB, "LIVE-SECRET-TEXT"); s.fake.dispatch("MESSAGE_CREATE", live);
      await waitFor(() => s.of("message").some((m: any) => m.text === "LIVE-SECRET-TEXT"));
      s.fake.dispatch("GARBAGE_EVENT", null); s.fake.dispatch("MESSAGE_UPDATE", { id: "1", channel_id: "no-such", content: "BROKEN-SECRET" });
      s.fake.tokens.delete(TOKEN); s.fake.killGatewayHard();
      await waitFor(() => s.ev.some((e) => e.type === "account" && e.data.state === "needs-login"), 15000);
      await new Promise((r) => setTimeout(r, 200));
    } finally { (process.stderr as any).write = orig; await s.close(); delete process.env.UNIMSG_DEBUG; }
    const blob = [...errors, ...s.ev.filter((e) => e.type === "error" || e.type === "account" || e.type === "login").map((e) => JSON.stringify(e)), ...logs].join("\n");
    assert.ok(logs.length > 0, "debug logging is active");
    assert.ok(errors.length >= 5, "errors were produced and checked");
    const secrets = [TOKEN, "SECRETTOKEN", "BADTOKEN", "bot-good", "user-good", "Bearer", "Bot bot-", SECRET_TEXT, "SENT-SECRET-TEXT-2", "EDIT-SECRET", "LIVE-SECRET-TEXT", "BROKEN-SECRET", "secret server text", "SECRET-SERVER-TEXT",
      "Alice", "alice", "bob", "Bob", "meuser", "Me Myself", ALICE, BOB, ME, G1, C.general, C.dm, "Test Guild", "general", "zzz-nobody-name", "nosuchemoji", "nope"];
    for (const secret of secrets) assert.ok(!blob.includes(secret), `leaked: ${secret}`);
    // stored files: the token is sealed, never plain
    for (const f of readdirSync(s.dir)) if (f !== "discord-session.key") assert.ok(!readFileSync(join(s.dir, f), "utf8").includes("SECRETTOKEN"), `plain token in ${f}`);
  });
}
