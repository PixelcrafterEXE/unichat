import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import factory from "./index.js";
import { ALICE, BOB, freePort, setup, waitFor } from "./helpers.js";
import { GW, SECRET } from "./fake-server.js";
import { RECEIPT, T, receiptPayload, textPayload, hex, unhex } from "./proto.js";
import { secretbox, secretboxOpen } from "./nacl.js";
import { blobNonce } from "./proto.js";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

test("factory metadata and capability gating (listener on vs send-only)", async () => {
  assert.equal(factory.name, "threema"); assert.equal(factory.login, "form"); assert.equal(factory.capabilities.e2ee, true);
  for (const k of ["edits", "deletes", "replies", "typing", "createGroup", "polls", "location", "spaces"] as const) assert.ok(!factory.capabilities[k], k);
  const a = await setup(factory); await waitFor(a.connected);
  assert.equal(a.conn.capabilities.reactions, true); assert.equal(a.conn.capabilities.readReceipts, true);
  await a.close();
  const b = await setup(factory, { port: "none" }); await waitFor(b.connected);
  assert.equal(b.conn.capabilities.reactions, false); assert.equal(b.conn.capabilities.readReceipts, false); assert.equal(b.conn.capabilities.attachments, true);
  assert.match(b.of("account").at(-1).detail, /Send-only/);
  await b.close();
});

test("login form validates, checks secret + registered key, stores sealed 0600", async () => {
  const s = await setup(factory, { noSession: true });
  const form = s.of("login")[0]; assert.equal(form.kind, "form"); assert.ok(form.warning); assert.ok(form.fields.some((f: any) => f.name === "confirm" && f.required));
  const ok = { gatewayId: GW, secret: SECRET, privateKey: "private:" + hex(s.fake.gw.secretKey), callbackPort: String(s.port), confirm: "true" };
  const bad = (patch: object, re: RegExp) => assert.rejects(s.conn.submitLogin(form.promptId, { ...ok, ...patch }), re);
  await bad({ gatewayId: "ABC" }, /start with \*/);
  await bad({ privateKey: "zz" }, /64 hex/);
  await bad({ callbackPort: "99999" }, /port/);
  await bad({ confirm: "false" }, /confirm/);
  await bad({ secret: "nope" }, /rejected the Gateway ID or secret/);
  await bad({ privateKey: "11".repeat(32) }, /does not belong/);
  assert.ok(!existsSync(join(s.dir, "threema-session.json")));
  await s.conn.submitLogin(form.promptId, ok);
  await waitFor(s.connected);
  const f = join(s.dir, "threema-session.json");
  assert.equal(statSync(f).mode & 0o777, 0o600); assert.equal(statSync(join(s.dir, "threema.key")).mode & 0o777, 0o600);
  assert.ok(!readFileSync(f, "utf8").includes(SECRET));
  await s.close();
  // restart restores without prompt
  const again = factory.create({ accountId: "acc", dataDir: s.dir }); const ev: any[] = [];
  const fake2 = s.fake; await fake2.start(); process.env.UNIMSG_THREEMA_BASE = fake2.url;
  await again.start((e: any) => ev.push(e)); await waitFor(() => ev.some((e) => e.type === "account" && e.data.state === "connected"));
  assert.ok(!ev.some((e) => e.type === "login")); await again.stop(); await fake2.close();
});

test("send text: native id, E2E decryptable by the peer, credits used; bad targets rejected", async () => {
  const s = await setup(factory); await waitFor(s.connected);
  const chat = await s.conn.startChat(" alice123 ");
  assert.equal(chat.id, ALICE);
  const m = await s.conn.send(ALICE, { text: "Hallo Wörld 👍" });
  assert.equal(m.chatId, ALICE); assert.equal(m.status, "sent"); assert.ok(m.fromMe); assert.match(m.id, /^[0-9a-f]{16}$/);
  assert.equal(s.fake.sent.length, 1); assert.equal(s.fake.sent[0].type, T.TEXT); assert.equal(dec(s.fake.sent[0].data), "Hallo Wörld 👍"); assert.equal(s.fake.sent[0].id, m.id);
  assert.equal(s.fake.credits, 99);
  await assert.rejects(s.conn.startChat("NOBODY99"), /does not know/);
  await assert.rejects(s.conn.startChat("bad"), /8 characters/);
  await assert.rejects(s.conn.send(ALICE, { text: "x".repeat(3501) }), /too long/);
  await assert.rejects(s.conn.send(ALICE, { text: "", location: { lat: 1, lng: 2 } }), /only supports/);
  await assert.rejects(s.conn.send("g:ALICE123:00", { text: "x" }), /receive-only/);
  s.fake.credits = 0; await assert.rejects(s.conn.send(ALICE, { text: "x" }), /credits/);
  const hist = await s.conn.history(ALICE, { limit: 10 }); assert.equal(hist.length, 1);
  await s.close();
});

test("incoming text via callback: MAC enforced, dedupe, nickname, unread, history, chats", async () => {
  const s = await setup(factory); await waitFor(s.connected);
  assert.equal((await s.fake.deliver(ALICE, T.TEXT, textPayload("bad mac"), { badMac: true })).status, 403);
  assert.equal((await s.fake.deliver(ALICE, T.TEXT, textPayload("wrong secret"), { secret: "other" })).status, 403);
  assert.equal(s.of("message").length, 0);
  const r = await s.fake.deliver(ALICE, T.TEXT, textPayload("hi there"), { date: 1_700_000_000 });
  assert.equal(r.status, 200);
  const msg = s.of("message")[0];
  assert.deepEqual([msg.id, msg.chatId, msg.senderId, msg.sender, msg.text, msg.fromMe, msg.time], [r.messageId, ALICE, ALICE, "Alice W", "hi there", false, "2023-11-14T22:13:20.000Z"]);
  // duplicate retry from the gateway is idempotent
  await s.fake.deliver(ALICE, T.TEXT, textPayload("hi there"), { messageId: r.messageId });
  assert.equal(s.of("message").length, 1);
  const chats = await s.conn.chats(); assert.equal(chats.length, 1); assert.equal(chats[0].unread, 1); assert.equal(chats[0].name, "Alice W");
  // wrong http path / method
  assert.equal((await fetch(`http://127.0.0.1:${s.port}/other`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${s.port}/threema/callback`)).status, 404);
  // oversized body
  assert.equal((await fetch(`http://127.0.0.1:${s.port}/threema/callback`, { method: "POST", body: "a".repeat(70000) }).catch(() => ({ status: 413 }))).status, 413);
  await s.close();
});

test("delivery receipts, acknowledge/decline reactions, markRead and react send the right receipts", async () => {
  const s = await setup(factory); await waitFor(s.connected);
  await s.conn.startChat(ALICE);
  const m = await s.conn.send(ALICE, { text: "ping" });
  await s.fake.deliver(ALICE, T.RECEIPT, receiptPayload(RECEIPT.RECEIVED, [unhex(m.id)]));
  await waitFor(() => s.of("receipt").length === 1); assert.equal(s.of("receipt")[0].status, "delivered"); assert.equal(s.of("receipt")[0].by, ALICE); assert.ok(Date.parse(s.of("receipt")[0].at) > 0); assert.equal(s.conn.capabilities.receiptDetails, undefined); // 1:1 only: the UI shows the single recipient anyway
  await s.fake.deliver(ALICE, T.RECEIPT, receiptPayload(RECEIPT.READ, [unhex(m.id)]));
  await waitFor(() => s.of("receipt").length === 2); assert.equal(s.of("receipt")[1].status, "read");
  await s.fake.deliver(ALICE, T.RECEIPT, receiptPayload(RECEIPT.RECEIVED, [unhex(m.id)]));   // no downgrade
  await s.fake.deliver(ALICE, T.RECEIPT, receiptPayload(RECEIPT.ACK, [unhex(m.id)]));
  await waitFor(() => s.of("message-update").length === 1);
  assert.deepEqual(s.of("message-update")[0].patch.reactions, [{ emoji: "👍", senderIds: [ALICE] }]);
  await s.fake.deliver(ALICE, T.RECEIPT, receiptPayload(RECEIPT.DECLINE, [unhex(m.id)]));
  await waitFor(() => s.of("message-update").length === 2);
  assert.deepEqual(s.of("message-update")[1].patch.reactions, [{ emoji: "👎", senderIds: [ALICE] }]);
  assert.equal(s.of("receipt").length, 2);
  // incoming -> I react and mark read
  const a = (await s.fake.deliver(ALICE, T.TEXT, textPayload("one"))).messageId;
  const b = (await s.fake.deliver(ALICE, T.TEXT, textPayload("two"))).messageId;
  await s.conn.react(ALICE, a, "👍");
  const ack = s.fake.sent.at(-1)!; assert.equal(ack.type, T.RECEIPT); assert.deepEqual([...ack.data], [RECEIPT.ACK, ...unhex(a)]);
  await assert.rejects(s.conn.react(ALICE, a, "😀"), /only knows/);
  await assert.rejects(s.conn.react(ALICE, a, null), /cannot withdraw/);
  await assert.rejects(s.conn.react(ALICE, m.id, "👍"), /received/);
  await s.conn.markRead(ALICE, b);
  const rd = s.fake.sent.at(-1)!; assert.deepEqual([...rd.data], [RECEIPT.READ, ...unhex(a), ...unhex(b)]);
  assert.equal((await s.conn.chats())[0].unread, 0);
  await s.close();
});

test("files: upload encrypted blob, receive file message, download + decrypt", async () => {
  const s = await setup(factory); await waitFor(s.connected);
  const data = new Uint8Array(5000).map((_, i) => i % 251);
  const m = await s.conn.send(ALICE, { text: "caption", attachments: [{ kind: "image", mime: "image/png", name: "a.png", data }] });
  assert.equal(m.text, "caption"); assert.equal(m.attachments[0].kind, "image");
  const sent = s.fake.sent.at(-1)!; assert.equal(sent.type, T.FILE);
  const j = JSON.parse(dec(sent.data)); assert.equal(j.m, "image/png"); assert.equal(j.s, 5000); assert.equal(j.d, "caption"); assert.equal(j.j, 1);
  const blob = s.fake.blobs.get(j.b)!; assert.notDeepEqual(blob.subarray(16), data);   // stored encrypted
  assert.deepEqual(secretboxOpen(blob, blobNonce(1), unhex(j.k)), data);
  const back = await s.conn.downloadAttachment(ALICE, m.id, "file"); assert.deepEqual(back.data, data); assert.equal(back.name, "a.png");
  // incoming file
  const key = new Uint8Array(32).fill(9), plain = new TextEncoder().encode("PDFDATA".repeat(100));
  s.fake.blobs.set("ab".repeat(16), secretbox(plain, blobNonce(1), key));
  const r = await s.fake.deliver(ALICE, T.FILE, textPayload(JSON.stringify({ b: "ab".repeat(16), k: hex(key), m: "application/pdf", n: "x.pdf", s: plain.length, j: 0, d: "see" })));
  assert.equal(r.status, 200);
  const im = s.of("message").find((x: any) => x.attachments)!;
  assert.deepEqual([im.text, im.attachments[0].kind, im.attachments[0].name], ["see", "file", "x.pdf"]);
  assert.deepEqual((await s.conn.downloadAttachment(ALICE, im.id, "file")).data, plain);
  // a corrupted file message is ignored without breaking the callback
  assert.equal((await s.fake.deliver(ALICE, T.FILE, textPayload("{not json"))).status, 200);
  // file too large
  await assert.rejects(s.conn.send(ALICE, { text: "", attachments: [{ kind: "file", mime: "x/y", data: { length: 51 * 1024 * 1024 } as any }] }), /too large/);
  await s.close();
});

test("group text is received read-only; unknown types and undecryptable data are survived", async () => {
  const s = await setup(factory); await waitFor(s.connected);
  const payload = new Uint8Array([...new TextEncoder().encode(BOB), 1, 2, 3, 4, 5, 6, 7, 8, ...new TextEncoder().encode("group hello")]);
  assert.equal((await s.fake.deliver(BOB, T.GROUP_TEXT, payload)).status, 200);
  const g = (await s.conn.chats()).find((c: any) => c.kind === "group")!;
  assert.deepEqual([g.id, g.readOnly], [`g:${BOB}:0102030405060708`, true]);
  assert.equal(s.of("message")[0].text, "group hello"); assert.equal(s.of("message")[0].senderId, BOB);
  assert.equal((await s.fake.deliver(ALICE, 0x77, new Uint8Array(40))).status, 200);   // unknown type
  assert.equal(s.of("message").length, 1);
  await s.close();
});

test("gateway outage: connector reports disconnected, retries and recovers; 401 -> needs-login with wiped session", async () => {
  const s = await setup(factory, { env: {} });
  await waitFor(s.connected);
  await s.close();
  const fake = new (await import("./fake-server.js")).FakeGateway(); await fake.start(); fake.peer(ALICE);
  const { mkdtempSync } = await import("node:fs"); const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "tm-")); const { saveSession } = await import("./secret.js");
  process.env.UNIMSG_THREEMA_BASE = fake.url;
  saveSession(dir, { gatewayId: GW, secret: SECRET, privateKey: hex(fake.gw.secretKey), callbackPort: 0 });
  fake.failNext = 2;   // credits check fails with 500 twice
  const ev: any[] = []; const c = factory.create({ accountId: "a", dataDir: dir });
  await c.start((e: any) => ev.push(e));
  await waitFor(() => ev.some((e) => e.data?.state === "connected"), 8000, "recover");
  assert.ok(ev.some((e) => e.data?.state === "disconnected"));
  await c.stop();
  // wrong secret in saved session
  saveSession(dir, { gatewayId: GW, secret: "revoked", privateKey: hex(fake.gw.secretKey), callbackPort: 0 });
  const ev2: any[] = []; const c2 = factory.create({ accountId: "a", dataDir: dir });
  await c2.start((e: any) => ev2.push(e));
  await waitFor(() => ev2.some((e) => e.data?.state === "needs-login"));
  assert.ok(ev2.some((e) => e.type === "login")); assert.ok(!existsSync(join(dir, "threema-session.json")));
  await c2.stop(); await fake.close();
});

test("callback port in use: send still works, error event, send-only capabilities", async () => {
  const net = await import("node:net"); const port = await freePort();
  const blocker = net.createServer(); await new Promise<void>((ok) => blocker.listen(port, "127.0.0.1", ok));
  const s = await setup(factory, { port }); await waitFor(s.connected);
  assert.ok(s.of("error").some((e: any) => e.code === "callback-port")); assert.equal(s.conn.capabilities.reactions, false);
  await s.conn.send(ALICE, { text: "still works" });
  await s.close(); blocker.close();
});

test("logout wipes session, state and key; non-loopback base override is ignored", async () => {
  const s = await setup(factory); await waitFor(s.connected);
  await s.conn.send(ALICE, { text: "x" });
  assert.ok(readdirSync(s.dir).includes("threema-state.json"));
  await s.conn.logout();
  assert.deepEqual(readdirSync(s.dir), []);
  const { baseUrl, DEFAULT_BASE } = await import("./api.js");
  process.env.UNIMSG_THREEMA_BASE = "https://evil.example.com"; assert.equal(baseUrl(), DEFAULT_BASE);
  process.env.UNIMSG_THREEMA_BASE = "http://127.0.0.1:1234"; assert.equal(baseUrl(), "http://127.0.0.1:1234");
  await s.fake.close();
});
