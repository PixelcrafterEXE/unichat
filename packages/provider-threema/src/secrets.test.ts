// No key / secret / Threema ID / message text may leak into error text, error/account/login events or UNIMSG_DEBUG output; stored files are sealed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ALICE, BOB, setup, waitFor } from "./helpers.js";
import { GW, SECRET } from "./fake-server.js";
import { T, hex, textPayload } from "./proto.js";

test("secrets never appear in errors, events, debug logs or stored files", async () => {
  process.env.UNIMSG_DEBUG = "1";
  const logs: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (c: any) => { logs.push(String(c)); return true; };
  const { default: factory } = await import("./index.js");
  const s = await setup(factory, { noSession: true });
  const errors: string[] = [];
  const TEXT_IN = "TOP-SECRET-INCOMING", TEXT_OUT = "TOP-SECRET-OUTGOING", TEXT_CAP = "SECRET-CAPTION";
  const sk = hex(s.fake.gw.secretKey);
  try {
    const id = s.of("login")[0].promptId;
    for (const v of [{ gatewayId: GW, secret: "WRONG-SECRET-777", privateKey: sk, confirm: "true" }, { gatewayId: GW, secret: SECRET, privateKey: "ab".repeat(32), confirm: "true" }, { gatewayId: GW, secret: SECRET, privateKey: "short", confirm: "true" }])
      await s.conn.submitLogin(id, v).catch((e: Error) => errors.push(e.message));
    await s.conn.submitLogin(id, { gatewayId: GW, secret: SECRET, privateKey: "private:" + sk, callbackPort: String(s.port), confirm: "true" });
    await waitFor(s.connected);
    await s.conn.send(ALICE, { text: TEXT_OUT });
    await s.conn.send(ALICE, { text: TEXT_CAP, attachments: [{ kind: "file", mime: "text/plain", name: "secret-name.txt", data: new Uint8Array(10) }] });
    await s.fake.deliver(ALICE, T.TEXT, textPayload(TEXT_IN));
    await s.fake.deliver(BOB, T.TEXT, textPayload(TEXT_IN), { badMac: true });
    await s.fake.deliver(BOB, T.TEXT, textPayload(TEXT_IN), { secret: "x" });
    s.fake.failNext = 1; await s.conn.send(ALICE, { text: TEXT_OUT }).catch((e: Error) => errors.push(e.message));
    s.fake.rateLimitNext = 1; await s.conn.send(ALICE, { text: TEXT_OUT }).catch((e: Error) => errors.push(e.message));
    await s.conn.startChat("NOBODY99").catch((e: Error) => errors.push(e.message));
    await s.conn.react(ALICE, "0000000000000000", "👍").catch((e: Error) => errors.push(e.message));
    await s.conn.downloadAttachment(ALICE, "nope", "file").catch((e: Error) => errors.push(e.message));
    s.fake.credits = 0; await s.conn.send(ALICE, { text: TEXT_OUT }).catch((e: Error) => errors.push(e.message));
    s.fake.credits = 5;
    await new Promise((r) => setTimeout(r, 100));
  } finally { (process.stderr as any).write = orig; await s.close(); delete process.env.UNIMSG_DEBUG; }
  const blob = [...errors, ...s.ev.filter((e) => e.type === "error" || e.type === "account" || e.type === "login").map((e) => JSON.stringify(e)), ...logs].join("\n");
  assert.ok(logs.length > 0, "debug logging is active");
  assert.ok(errors.length >= 7, "errors were produced and checked");
  const secrets = [SECRET, "WRONG-SECRET", sk, TEXT_IN, TEXT_OUT, TEXT_CAP, "secret-name", GW, ALICE, BOB, "Alice W", "NOBODY99", s.dir, hex(s.fake.peers.get(ALICE)!.pk), hex(s.fake.gw.publicKey)];
  for (const secret of secrets) assert.ok(!blob.includes(secret), `leaked: ${secret}`);
  // stored files are sealed
  for (const f of readdirSync(s.dir)) if (f !== "threema.key") {
    const c = readFileSync(join(s.dir, f), "utf8");
    for (const p of [SECRET, sk, TEXT_IN, TEXT_OUT, GW, ALICE]) assert.ok(!c.includes(p), `plain ${p} in ${f}`);
  }
});
