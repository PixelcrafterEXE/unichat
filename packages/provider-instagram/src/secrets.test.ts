// No password / session token / cookie / message text / username may leak into error text, error/account events or UNIMSG_DEBUG output.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOGIN, setup, waitFor } from "./helpers.js";

test("secrets never appear in errors, error/account events or debug logs", async () => {
  process.env.UNIMSG_DEBUG = "1";
  const logs: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (c: any) => { logs.push(String(c)); return true; };
  const { default: factory } = await import("./index.js");
  const SECRET_TEXT = "TOP-SECRET-MESSAGE-TEXT";
  const s = await setup(factory, { noSession: true, prep: (f) => { f.addThread("t1", ["2001"]); f.text("t1", "2001", SECRET_TEXT); } });
  const errors: string[] = []; let raw = "";
  try {
    await waitFor(() => s.of("login").length > 0);
    const id = s.of("login")[0].promptId;
    for (const v of [{ ...LOGIN, password: "BADPASSWORD-9" }, { ...LOGIN, username: "someghost" }, { ...LOGIN, confirm: "" }])
      await s.conn.submitLogin(id, v).catch((e: Error) => errors.push(e.message));
    await s.conn.submitLogin(id, LOGIN);
    await waitFor(s.connected);
    const hist = await s.conn.history("t1", { limit: 5 });
    assert.equal(hist[0].text, SECRET_TEXT);
    await s.conn.send("t1", { text: "SENT-SECRET-TEXT-2" });
    await s.conn.startChat("alice");
    await s.conn.startChat("zzz-nobody").catch((e: Error) => errors.push(e.message));
    s.fake.failNext = 1; await s.conn.history("t1", { limit: 5 }).catch((e: Error) => errors.push(e.message));
    await s.conn.delete("t1", "nope").catch((e: Error) => errors.push(e.message));
    s.fake.rateLimitNext = 1; await s.conn.history("t1", { limit: 5 }).catch((e: Error) => errors.push(e.message));
    await s.conn.history("t1", { limit: 5 }).catch((e: Error) => errors.push(e.message));
    s.fake.tokens.clear();
    await s.conn.logout().catch((e: Error) => errors.push(e.message));
    await new Promise((r) => setTimeout(r, 200));
  } finally { (process.stderr as any).write = orig; await s.close(); }
  raw = "";
  const blob = [...errors, ...s.ev.filter((e) => e.type === "error" || e.type === "account").map((e) => JSON.stringify(e)), ...logs].join("\n");
  assert.ok(logs.length > 0, "debug logging is active");
  assert.ok(errors.length >= 5, "errors were produced and checked");
  for (const secret of ["fakepw", "BADPASSWORD-9", "someghost", "fakeme", "SESSION-SECRET-ABC", "IGT:2:", "MID-SECRET", "Bearer", "enc_password", "PWD_INSTAGRAM", SECRET_TEXT, "SENT-SECRET-TEXT-2", "SECRET-SERVER-TEXT", "Alice", "alice", "Bob Builder", "2001", "zzz-nobody"])
    assert.ok(!blob.includes(secret), `leaked: ${secret}`);
  // login prompts themselves must not echo credentials either
  assert.ok(!JSON.stringify(s.of("login")).includes("fakepw"));
  void raw; void readFileSync; void join;
});
