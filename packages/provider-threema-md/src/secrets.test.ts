// No Threema ID, name, key, message text, blob id or URL may leak into error text, error/account events or UNIMSG_DEBUG output.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import factory from "./index.js";
import { Ty, hexId, textBody } from "./e2e.js";
import { newPeer } from "./fake/servers.js";
import { linked, wait, waitFor, world } from "./helpers.js";

test("secrets never appear in errors, error/account events or debug logs", async () => {
  process.env.UNIMSG_DEBUG = "1";
  const logs: string[] = []; const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (c: any) => { logs.push(String(c)); return true; };
  const SECRET = "TOP-SECRET-MESSAGE-TEXT", SENT = "SENT-SECRET-TEXT-2";
  const w = await world(); const alice = w.phone.addContact("ALICE001", { first: "Alicia", last: "Wonderland", nick: "ally" }); w.phone.nickname = "PhoneOwnerName";
  const errors: string[] = []; let L;
  try {
    L = await linked(factory, w, { phoneOnline: true });
    await w.phone.incoming("ALICE001", 4242n, Ty.TEXT, textBody(SECRET)); await waitFor(() => L!.of("message").length === 1);
    await L.conn.send("ALICE001", { text: SENT });
    await w.phone.incoming("ALICE001", 4243n, Ty.FS, new Uint8Array([1])); await waitFor(() => L!.of("error").length >= 1);
    await L.conn.startChat("ZZZZZZZZ").catch((e: Error) => errors.push(e.message));
    await L.conn.startChat("bad id").catch((e: Error) => errors.push(e.message));
    w.http.rateLimitNext = 1; await L.conn.startChat("QWERTY12").catch((e: Error) => errors.push(e.message));
    await L.conn.send("QWERTY12", { text: "x" }).catch((e: Error) => errors.push(e.message));
    await L.conn.downloadAttachment("ALICE001", hexId(1n), "file").catch((e: Error) => errors.push(e.message));
    await L.conn.edit("ALICE001", hexId(9n), "t").catch((e: Error) => errors.push(e.message));
    const ghost = newPeer("GHOST999"); w.http.dir.set("GHOST999", { pk: ghost.pk, featureMask: 0n }); await w.phone.incoming("GHOST999", 4244n, Ty.TEXT, textBody("hi")); // unknown contact, no feature bits
    await L.conn.react("GHOST999", hexId(4244n), "🎉").catch((e: Error) => errors.push(e.message));
    const g = [...w.be.groups.values()][0]; const me = [...g.devs.values()].find((d) => d.id !== w.phone.deviceId)!; w.be.dropFromServer(g, me.id, 4113);
    await waitFor(() => L!.stateOf() === "needs-login", 5000); await wait(100);
    await L.conn.logout().catch((e: Error) => errors.push(e.message));
  } finally { (process.stderr as any).write = orig; await L?.stop(); await w.close(); delete process.env.UNIMSG_DEBUG; }
  assert.ok(logs.length > 0, "debug logging is active"); assert.ok(errors.length >= 5, "errors were produced and checked");
  const events = L!.ev.filter((e) => e.type === "error" || e.type === "account").map((e) => JSON.stringify(e));
  const blob = [...errors, ...events, ...logs].join("\n");
  const secrets = [SECRET, SENT, "PHONE001", "ALICE001", "ALICE", "Alicia", "Wonderland", "ally", "PhoneOwnerName", "QWERTY12", "ZZZZZZZZ", "GHOST999", "127.0.0.1", "ws://", "http://",
    Buffer.from(w.phone.me.sk).toString("hex"), Buffer.from(w.phone.dgk).toString("hex"), Buffer.from(w.phone.keys.dgpkPublic).toString("hex"), Buffer.from(alice.peer.pk).toString("hex"), "threema://", "4242", "deviceId"];
  for (const s of secrets) assert.ok(!blob.includes(s), `leaked: ${s}`);
  // the login prompts themselves never carry keys/ids (the QR payload is the one-time link URL, by design)
  const prompts = JSON.stringify(L!.of("login").filter((p: any) => p.kind !== "qr"));
  for (const s of ["PHONE001", Buffer.from(w.phone.dgk).toString("hex")]) assert.ok(!prompts.includes(s));
  void readdirSync; void readFileSync; void join;
});
