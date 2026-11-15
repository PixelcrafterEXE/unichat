// No token / password / message text may leak into error text, error events, account events or UNIMSG_DEBUG output.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, waitFor } from "./helpers.js";

test("secrets never appear in errors, error/account events or debug logs", async () => {
  process.env.UNIMSG_DEBUG = "1";
  const logs: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (c: any) => { logs.push(String(c)); return true; };
  const { default: factory } = await import("./index.js");
  const SECRET_TEXT = "TOP-SECRET-MESSAGE-TEXT";
  const s = await setup(factory, { noSession: true, prep: (f) => { f.addPost("c_town", "u_bob", SECRET_TEXT); } });
  const errors: string[] = [];
  try {
    await waitFor(() => s.of("login").length > 0);
    const id = s.of("login")[0].promptId;
    for (const v of [{ server: s.fake.url, token: "pat-BADTOKEN-123" }, { server: s.fake.url, login_id: "someuser", password: "BADPASSWORD-9" }])
      await s.conn.submitLogin(id, v).catch((e: Error) => errors.push(e.message));
    await s.conn.submitLogin(id, { server: s.fake.url, login_id: "me", password: "pw" });
    await waitFor(s.connected);
    const hist = await s.conn.history("c_town", { limit: 5 });
    assert.equal(hist[0].text, SECRET_TEXT);
    await s.conn.send("c_town", { text: "SENT-SECRET-TEXT-2" });
    s.fake.rateLimitNext = 1; await s.conn.history("c_town", { limit: 5 });
    s.fake.validTokens.clear();
    await s.conn.history("c_town", { limit: 5 }).catch((e: Error) => errors.push(e.message));
    await s.conn.edit("c_town", "nope", "EDIT-SECRET").catch((e: Error) => errors.push(e.message));
    await new Promise((r) => setTimeout(r, 200));
  } finally { (process.stderr as any).write = orig; await s.close(); }
  const blob = [...errors, ...s.ev.filter((e) => e.type === "error" || e.type === "account").map((e) => JSON.stringify(e)), ...logs].join("\n");
  assert.ok(logs.length > 0, "debug logging is active");
  for (const secret of ["pat-BADTOKEN-123", "BADPASSWORD-9", "sess-tok", "pat-good", "pw\"", "someuser", SECRET_TEXT, "SENT-SECRET-TEXT-2", "EDIT-SECRET", "secret server text", "Bob Builder", "u_bob"])
    assert.ok(!blob.includes(secret), `leaked: ${secret}`);
});
