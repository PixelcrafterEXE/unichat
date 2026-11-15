// Multi-device test campaign (in-process fakes, loopback, temp dirs only): pairing failures, forged peers, conflicts, scale, chains, secrets.
import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { dial, generateKeyPair, syncPsk, ChannelError } from "./index.js";
import { converged, dump, fac, msg, node, pairUp, until, type Node } from "./testkit.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const online = (n: Node) => n.svc.status().devices.filter((d: any) => !d.self).every((d: any) => d.online);
const walk = (d: string, out: string[] = []): string[] => { for (const n of readdirSync(d)) { const p = join(d, n), s = statSync(p); if (s.isDirectory()) walk(p, out); else out.push(p); } return out; };
const rogue = (port: number, mode: "pair" | "sync", psk: Buffer, tags?: string[]) =>
  new Promise<any>((ok, bad) => { const s = createConnection({ host: "127.0.0.1", port }); s.once("error", bad); s.once("connect", () => { dial(s, { mode, psk, tags, s: generateKeyPair(), hello: { id: "rogue", name: "rogue", v: 1 }, timeoutMs: 3000, checkRemote() {} }).then(ok, bad); }); });

test("pairing: an expired code is refused, a used code cannot be replayed by a third device", async () => {
  const A = await node("A", "memory", undefined, undefined, undefined, { opts: { pairingTtlMs: 400 } });
  const B = await node("B", "memory"), C = await node("C", "memory");
  const p = await A.call("syncStartPairing", {});
  await sleep(700);
  assert.ok(!(await A.call("syncStatus")).pairing, "pairing session expired");
  await assert.rejects(B.call("syncJoin", { host: "127.0.0.1", port: p.port, code: p.code }), /not accepted|reach/);
  assert.equal((await B.call("syncStatus")).enabled, false);
  const A2 = await node("A2", "memory"), B2 = await node("B2", "memory");
  const p2 = await A2.call("syncStartPairing", { keepListening: true });
  const { joinApproved } = await import("./testkit.js");
  await joinApproved(A2, B2, p2);
  await assert.rejects(C.call("syncJoin", { host: "127.0.0.1", port: p2.port, code: p2.code }), /not accepted|reach/);
  assert.equal((await C.call("syncStatus")).enabled, false);
  assert.equal(Object.keys((A2.svc as any).group.devices).length, 2);
  for (const n of [A, B, C, A2, B2]) await n.stop();
});

test("forged peers: wrong group key, unknown key tag, stolen key without membership, garbage and oversize frames change nothing", async () => {
  const A = await node("A", "memory", undefined, (s) => s.putMessages([msg("fake-x:c", "m1", "one", "2026-01-01T00:00:00Z")])), B = await node("B", "memory");
  await pairUp(A, B);
  const g = (A.svc as any).group, key = g.keys[0], port = A.svc.status().port!;
  const before = dump(A.store), devs = Object.keys(g.devices).length;
  await assert.rejects(rogue(port, "sync", syncPsk(randomBytes(32).toString("base64")), [key.tag]), /accept|closed|key|auth/i, "right tag, wrong key");
  await assert.rejects(rogue(port, "sync", syncPsk(key.key), ["deadbeef"]), /accept|closed|key|auth/i, "unknown tag");
  { const ch = await rogue(port, "sync", syncPsk(key.key), [key.tag]).catch(() => undefined); // key stolen, device not a member: the host drops it right after the handshake
    if (ch) await assert.rejects(ch.recv(3000), /closed|auth|timed/i, "a non-member never gets a session"); }
  await assert.rejects(rogue(port, "pair", randomBytes(32)), /accept|closed|code|auth/i, "pair mode with no pairing open");
  for (const bytes of [Buffer.from("GET / HTTP/1.1\r\n\r\n"), Buffer.alloc(64, 0xff), (() => { const b = Buffer.alloc(8); b.writeUInt32BE(0x7fffffff); return b; })(), Buffer.from([0, 0, 0, 0])]) {
    const s = createConnection({ host: "127.0.0.1", port }); await new Promise<void>((ok) => s.once("connect", () => ok())); s.on("error", () => {}); s.write(bytes);
    await new Promise<void>((ok) => { s.once("close", () => ok()); setTimeout(() => { s.destroy(); ok(); }, 1500); });
  }
  A.store.putMessages([msg("fake-x:c", "m2", "two", "2026-01-01T00:01:00Z")]);
  await until(() => !!B.store.getMessage("fake-x:c", "m2"), "real peer still syncs after the attacks");
  assert.equal(Object.keys(g.devices).length, devs, "no device was added");
  assert.ok(dump(A.store).startsWith(before) && !dump(A.store).includes("rogue"), "nothing but the real peer's message was added");
  assert.ok(online(A));
  for (const n of [A, B]) await n.stop();
});

test("conflicts: same message edited on both devices, edit vs delete, and chat flags (pinned/muted/archived/unreadMark) converge identically", async () => {
  const chat = "fake-x:c";
  const A = await node("A", "sqlite", undefined, (s) => s.putMessages([msg(chat, "e1", "orig", "2026-01-01T00:00:00Z"), msg(chat, "e2", "orig2", "2026-01-01T00:01:00Z"), msg(chat, "e3", "orig3", "2026-01-01T00:02:00Z")])), B = await node("B", "sqlite");
  await pairUp(A, B); await until(() => converged(A, B) && !!B.store.getMessage(chat, "e3"), "initial");
  await A.call("syncPause"); await B.call("syncPause"); await sleep(300);
  A.store.putMessages([msg(chat, "e1", "A edit", "2026-01-01T00:00:00Z", { editedAt: "2026-01-02T00:00:00Z" })]);
  B.store.putMessages([msg(chat, "e1", "B edit later", "2026-01-01T00:00:00Z", { editedAt: "2026-01-03T00:00:00Z" })]);
  A.store.putMessages([msg(chat, "e2", "orig2", "2026-01-01T00:01:00Z", { deleted: true })]);
  B.store.putMessages([msg(chat, "e2", "edited after", "2026-01-01T00:01:00Z", { editedAt: "2026-01-05T00:00:00Z" })]);
  A.store.setChatFlags(chat, { pinned: true, muted: true });
  await sleep(20); B.store.setChatFlags(chat, { archived: true, unreadMark: true });
  A.store.setChatFlags("fake-x:other", { unreadMark: true });
  await A.call("syncResume"); await B.call("syncResume");
  await until(() => converged(A, B) && online(A), "convergence after offline edits", 15000);
  assert.equal(A.store.getMessage(chat, "e1")!.text, "B edit later", "latest edit wins");
  assert.ok(A.store.getMessage(chat, "e2")!.deleted && B.store.getMessage(chat, "e2")!.deleted, "delete is sticky over a concurrent edit");
  assert.deepEqual(A.store.listChatFlags()[chat], B.store.listChatFlags()[chat], "flags identical on both");
  await until(() => !!B.store.listChatFlags()["fake-x:other"]?.unreadMark, "a chat with ONLY unreadMark replicates", 5000);
  assert.equal(B.store.listChatFlags()[chat]?.unreadMark, true, "unreadMark survives replication");
  for (const n of [A, B]) await n.stop();
});

test("chain A->B->C with A offline, then A catches up and sees C's data; unpair (leave) and revoke", async () => {
  const chat = "fake-x:c";
  const A = await node("A", "memory", undefined, (s) => s.putMessages([msg(chat, "a1", "from A", "2026-01-01T00:00:00Z")])), B = await node("B", "sqlite"), C = await node("C", "memory");
  await pairUp(A, B); await until(() => !!B.store.getMessage(chat, "a1"), "B has A's data");
  await A.call("syncPause"); await until(() => !B.svc.status().devices.find((d: any) => d.name === "A")?.online, "A offline");
  await pairUp(B, C); await until(() => !!C.store.getMessage(chat, "a1"), "C gets A's data through B (A offline)");
  C.store.putMessages([msg(chat, "c1", "from C", "2026-01-02T00:00:00Z")]);
  assert.equal(A.store.getMessage(chat, "c1"), undefined);
  await A.call("syncResume");
  await until(() => !!A.store.getMessage(chat, "c1") && converged(A, B, C), "A caught up with C's message and learned about C", 25000);
  await until(() => A.svc.status().devices.length === 3, "A knows 3 devices");
  // C leaves the group: it stops syncing; the others still see it as a device until revoked
  await C.call("syncLeave"); assert.equal((await C.call("syncStatus")).enabled, false);
  A.store.putMessages([msg(chat, "a2", "after C left", "2026-01-03T00:00:00Z")]);
  await sleep(1500); assert.equal(C.store.getMessage(chat, "a2"), undefined, "a device that left gets nothing");
  await A.call("syncRevoke", { deviceId: C.svc.status().deviceId ?? (B.svc.status().devices.find((d: any) => d.name === "C") as any).id }).catch(() => {});
  for (const n of [A, B, C]) await n.stop();
});

test("secrets: Signal/WhatsApp-style sessions are never replicated, not even when the user tries to share them; archive-only never copies files", async () => {
  const SECRET = "TOPSECRET-" + randomBytes(8).toString("hex");
  const facs = [fac("signal"), fac("whatsapp")];
  const A = await node("A", "sqlite", undefined, (s) => { for (const p of ["signal", "whatsapp", "mattermost"]) { s.putAccount({ id: p + "-1", provider: p, label: p, status: "active" }); s.putMessages([msg(p + "-1:c", "m", "hello " + p, "2026-01-01T00:00:00Z")]); } }, undefined, { factories: facs });
  const B = await node("B", "sqlite", undefined, undefined, undefined, { factories: facs });
  for (const p of ["signal", "whatsapp", "mattermost"]) { mkdirSync(join(A.dir, "accounts", p + "-1", "auth"), { recursive: true }); writeFileSync(join(A.dir, "accounts", p + "-1", "auth", "creds.json"), SECRET + p); }
  for (const p of ["signal", "whatsapp"]) await assert.rejects(A.call("syncSetAccountMode", { accountId: p + "-1", mode: "credentials" }), /cannot be copied/);
  await pairUp(A, B);
  await until(() => B.store.listAccounts().length === 3 && !!B.store.getMessage("signal-1:c", "m") && !!B.store.getMessage("mattermost-1:c", "m"), "history replicated");
  await sleep(1200);
  assert.deepEqual(await B.call("syncCredentials"), [], "no credential offer without explicit opt-in");
  assert.equal((B.store.listAccounts().find((a) => a.id === "signal-1"))!.status, "archived");
  await B.call("syncPause"); await A.call("syncPause"); await B.stop();
  const leaked = walk(B.dir).filter((f) => readFileSync(f).includes(SECRET));
  assert.deepEqual(leaked, [], "no session file or secret on the other device's disk");
  assert.ok(!existsSync(join(B.dir, "accounts", "signal-1", "auth")));
  await A.stop();
});

test("large archive: 50,000 messages with attachments replicate to an empty device, then incremental sync continues", { timeout: 280_000 }, async () => {
  const chats = 25, per = 2000, acct = "fake-big";
  const A = await node("A", "sqlite", undefined, (s) => {
    s.putAccount({ id: acct, provider: "fake", label: "Big", status: "active" });
    for (let c = 0; c < chats; c++) s.putMessages(Array.from({ length: per }, (_, i) => msg(`${acct}:c${c}`, "m" + i, "t" + c + "-" + i + " " + "x".repeat(60), new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + (c * per + i) * 1000).toISOString(),
      i % 10 === 0 ? { attachments: [{ id: "a" + i, kind: "image", mime: "image/png", name: "p" + i + ".png" }] } : {})));
  });
  const B = await node("B", "sqlite"); const t = Date.now();
  await pairUp(A, B);
  await until(() => B.store.countRecords().message === chats * per, "50k messages arrived", 240_000);
  assert.equal(B.store.getMessage(`${acct}:c24`, "m1999")?.text.startsWith("t24-1999"), true);
  assert.equal(B.store.getMessage(`${acct}:c3`, "m10")?.attachments?.length, 1);
  assert.ok(Date.now() - t < 240_000);
  A.store.putMessages([msg(`${acct}:c0`, "late", "after bulk", "2027-01-01T00:00:00Z")]);
  await until(() => !!B.store.getMessage(`${acct}:c0`, "late"), "incremental after bulk");
  for (const n of [A, B]) await n.stop();
});
