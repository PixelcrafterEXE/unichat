// Attachment sending: fake chat connection (upload form), fake CDN transport, fake Sender, throwaway temp-dir store. No network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { IdentityKeyPair } from "@signalapp/libsignal-client";
import type { CoreEvent } from "@unimsg/core";
import { ContentCodec, type Content } from "../protocol/codec.js";
import { decryptAttachmentBlob } from "../service/attachments.js";
import { paddedSize, type CdnHttp, type HttpReq } from "../service/attachmentUpload.js";
import { SignalClient } from "../service/client.js";
import { groupChatId, groupIdFromMasterKey } from "../service/groups.js";
import { readFileSync } from "node:fs";

const ME = "22222222-2222-4222-8222-222222222222";
const A = "11111111-1111-4111-8111-111111111111";
const B = "44444444-4444-4444-8444-444444444444";

interface Call { aci: string; content: Content; ts: number; mode: string }

async function setup(o: { cdn?: 2 | 3; form?: { status: number; body?: string }; cdnStatus?: number; group?: boolean } = {}) {
  const client = new SignalClient({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-signal-att-")) });
  await client.store.load();
  client.store.setAccount({ aci: ME, deviceId: 2, password: "pw", registrationId: 5, aciIdentity: Buffer.from(IdentityKeyPair.generate().serialize()).toString("base64"), readReceipts: true, linkedAt: 0 });
  const priv = client as unknown as Record<string, unknown> & { makeInbound(): void; emit: (e: CoreEvent) => void };
  const events: CoreEvent[] = []; priv.emit = (e) => events.push(e);
  const cdn = o.cdn ?? 3;
  const formCalls: string[] = [];
  priv.chatConn = { fetch: async (r: { verb: string; path: string }) => {
    formCalls.push(`${r.verb} ${r.path}`);
    if (o.form) return { status: o.form.status, body: Buffer.from(o.form.body ?? "") };
    return { status: 200, body: Buffer.from(JSON.stringify({ cdn, key: "ATT-KEY-1", headers: { "x-test": "1" }, signedUploadLocation: `https://cdn${cdn}.signal.org/attachments/upload/abc` })) };
  } };
  const reqs: HttpReq[] = []; const stored: Buffer[] = [];
  const http: CdnHttp = async (r) => {
    reqs.push(r);
    if (o.cdnStatus) return { status: o.cdnStatus, headers: {} };
    if (r.method === "POST") return { status: cdn === 3 ? 201 : 200, headers: { location: "/resumable/xyz" } };
    stored.push(r.body!); return { status: cdn === 3 ? 204 : 200, headers: {} };
  };
  priv.cdnHttp = http;
  let chatId = A;
  const members = [ME, A, B];
  let masterKey = randomBytes(32);
  if (o.group) {
    chatId = groupChatId(groupIdFromMasterKey(masterKey));
    priv.groupResolver = { needs: () => false, request: async () => {}, ensure: async () => {
      client.store.upsertChat({ id: chatId, kind: "group", groupMasterKey: Buffer.from(masterKey).toString("base64"), groupRevision: 7, groupMembers: members });
      client.store.data.chats[chatId]!.groupFetchedAt = Date.now(); return "refreshed";
    } };
  }
  priv.makeInbound();
  const calls: Call[] = [];
  priv.sender = { deliver: async (aci: string, content: Content, ts: number, mode: string) => { calls.push({ aci, content, ts, mode }); } };
  return { client, chatId, calls, reqs, stored, formCalls, events };
}

test("capabilities: attachments and voice notes are on; location stays off", () => {
  // index.ts pulls in @unimsg/core at runtime (not resolvable from the compiled test dir), so check the source text.
  const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /attachments: true, voiceNotes: true/); assert.doesNotMatch(src, /location: true/);
});

test("bucket padding: monotonic, >= size, 541 minimum", () => {
  assert.equal(paddedSize(1), 541); assert.equal(paddedSize(541), 541);
  for (const n of [542, 1000, 5000, 123456, 10_000_000]) { const p = paddedSize(n); assert.ok(p >= n && p <= Math.ceil(n * 1.05) + 1, String(n)); }
});

for (const cdn of [3, 2] as const) {
  test(`voice message 1:1 over cdn${cdn}: pointer, VOICE flag, roundtrip decrypt, transcript`, async () => {
    const h = await setup({ cdn });
    const data = randomBytes(5000);
    const wave = Array.from({ length: 64 }, (_, i) => i % 101);
    const m = await h.client.send(A, { text: "", attachments: [{ kind: "voice", mime: "audio/ogg; codecs=opus", name: "x.ogg", data, durationMs: 4200, waveform: wave }] });
    assert.deepEqual(h.formCalls, ["GET /v4/attachments/form/upload"]);
    // transport shape
    assert.equal(h.reqs.length, 2); assert.equal(h.reqs[0]!.headers["x-test"], "1");
    assert.equal(h.reqs[1]!.url.href, `https://cdn${cdn}.signal.org/resumable/xyz`);
    if (cdn === 3) {
      assert.equal(h.reqs[1]!.method, "PATCH"); assert.equal(h.reqs[1]!.headers["Upload-Offset"], "0");
      assert.equal(h.reqs[0]!.headers["Upload-Length"], String(h.stored[0]!.length));
    } else assert.equal(h.reqs[1]!.method, "PUT");
    // pointer
    const msgCalls = h.calls.filter((c) => c.mode === "message");
    assert.equal(msgCalls.length, 1);
    const p = msgCalls[0]!.content.dataMessage!.attachments![0]!;
    assert.equal(p.cdnKey, "ATT-KEY-1"); assert.equal(p.cdnNumber, cdn); assert.equal(p.contentType, "audio/ogg");
    assert.equal(p.flags, 1); assert.equal(p.size, 5000); assert.equal(p.key!.length, 64); assert.equal(p.clientUuid!.length, 16);
    assert.match(p.fileName!, /^signal-voice-note-.*\.ogg$/); assert.equal(p.audioDurationSeconds!, 4.2);
    assert.equal(p.audioWaveform!.length, 64); assert.ok(Math.max(...p.audioWaveform!) <= 255);
    assert.ok(p.uploadTimestamp! > 0);
    // roundtrip through the download-side decrypt, with digest + MAC checks
    const blob = h.stored[0]!;
    assert.equal(blob.length, 16 + (Math.floor(paddedSize(5000) / 16) + 1) * 16 /* CBC + PKCS7 */ + 32);
    assert.deepEqual(decryptAttachmentBlob(blob, p.key!, { digest: p.digest, size: p.size }), data);
    const ref = h.client.store.data.attachments[m.attachments![0]!.id]!;
    assert.deepEqual(decryptAttachmentBlob(blob, Buffer.from(ref.key, "base64"), { digest: Buffer.from(ref.digest!, "base64"), size: ref.size }), data);
    // sync transcript carries the same pointer
    const sync = h.calls.find((c) => c.mode === "sync")!.content.syncMessage!.sent!;
    assert.equal(sync.destinationServiceId, A); assert.deepEqual(sync.message!.attachments, [p]);
    // wire codec survives the extra fields
    const rt = ContentCodec.decode(ContentCodec.encode(msgCalls[0]!.content)).dataMessage!.attachments![0]!;
    assert.equal(rt.flags, 1); assert.equal(rt.cdnKey, "ATT-KEY-1"); assert.deepEqual(Buffer.from(rt.digest!), Buffer.from(p.digest!));
    // returned message
    assert.equal(m.attachments![0]!.kind, "voice"); assert.deepEqual(m.attachments![0]!.waveform, wave);
  });
}

test("image + GIF + file with caption and reply; multiple attachments, one upload each", async () => {
  const h = await setup();
  const img = randomBytes(900), gif = randomBytes(700), file = randomBytes(300);
  const m = await h.client.send(A, { text: "look", replyToMessageId: `${A}.1234`, attachments: [
    { kind: "image", mime: "image/jpeg", name: "a.jpg", data: img, width: 640, height: 480 } as never,
    { kind: "video", mime: "video/mp4", name: "g.mp4", data: gif, gif: true } as never,
    { kind: "file", mime: "application/pdf", name: "d.pdf", data: file },
  ] });
  const dm = h.calls.find((c) => c.mode === "message")!.content.dataMessage!;
  assert.equal(dm.body, "look"); assert.equal(dm.quote!.id, 1234);
  const [p1, p2, p3] = dm.attachments!;
  assert.deepEqual([p1!.contentType, p1!.width, p1!.height, p1!.flags, p1!.fileName], ["image/jpeg", 640, 480, 0, "a.jpg"]);
  assert.deepEqual([p2!.contentType, p2!.flags], ["video/mp4", 8]);
  assert.deepEqual([p3!.contentType, p3!.flags, p3!.fileName], ["application/pdf", 0, "d.pdf"]);
  assert.equal(h.formCalls.length, 3); assert.equal(h.stored.length, 3);
  assert.deepEqual(decryptAttachmentBlob(h.stored[0]!, p1!.key!, { digest: p1!.digest, size: p1!.size }), img);
  assert.deepEqual(decryptAttachmentBlob(h.stored[2]!, p3!.key!, { digest: p3!.digest, size: p3!.size }), file);
  assert.equal(m.attachments!.length, 3); assert.equal(m.attachments![1]!.gif, true);
  // tamper -> MAC failure
  const bad = Buffer.from(h.stored[0]!); bad[30] ^= 1;
  assert.throws(() => decryptAttachmentBlob(bad, p1!.key!, { digest: p1!.digest }), /digest/);
});

test("group: upload once, same pointers to every member with groupV2, one transcript", async () => {
  const h = await setup({ group: true });
  const data = randomBytes(2000);
  await h.client.send(h.chatId, { text: "hi", attachments: [{ kind: "voice", mime: "audio/ogg", data, durationMs: 1000 }] });
  assert.equal(h.formCalls.length, 1); assert.equal(h.stored.length, 1);
  const msgs = h.calls.filter((c) => c.mode === "message");
  assert.deepEqual(msgs.map((c) => c.aci).sort(), [A, B].sort());
  const p0 = msgs[0]!.content.dataMessage!.attachments![0]!;
  for (const c of msgs) { assert.deepEqual(c.content.dataMessage!.attachments, [p0]); assert.equal(c.content.dataMessage!.groupV2!.revision, 7); }
  assert.equal(h.calls.filter((c) => c.mode === "sync").length, 1);
  assert.deepEqual(h.calls.find((c) => c.mode === "sync")!.content.syncMessage!.sent!.message!.attachments, [p0]);
});

test("errors are plain-language, leak nothing, and send nothing", async () => {
  const big = { kind: "file" as const, mime: "x/y", data: new Uint8Array(101 * 1024 * 1024) };
  const h = await setup();
  await assert.rejects(h.client.send(A, { text: "", attachments: [big] }), /too large for Signal \(the limit is 100 MB\)/);
  await assert.rejects(h.client.send(A, { text: "", attachments: [{ kind: "file", mime: "x/y", data: new Uint8Array(0) }] }), /empty/);
  await assert.rejects(h.client.send(A, { text: "", attachments: Array.from({ length: 33 }, () => ({ kind: "file" as const, mime: "x/y", data: new Uint8Array(1) })) }), /at most 32/);
  assert.equal(h.formCalls.length, 0);
  const f = await setup({ form: { status: 413 } });
  await assert.rejects(f.client.send(A, { text: "", attachments: [{ kind: "file", mime: "x/y", data: new Uint8Array(10) }] }), /too large/);
  const f2 = await setup({ form: { status: 200, body: "garbage" } });
  await assert.rejects(f2.client.send(A, { text: "", attachments: [{ kind: "file", mime: "x/y", data: new Uint8Array(10) }] }), (e: Error) => /didn't accept/.test(e.message) && !/ATT-KEY|json|cdn|HTTP/.test(e.message));
  const u = await setup({ cdnStatus: 413 });
  await assert.rejects(u.client.send(A, { text: "", attachments: [{ kind: "file", mime: "x/y", data: new Uint8Array(10) }] }), /too large/);
  const u2 = await setup({ cdnStatus: 403 });
  await assert.rejects(u2.client.send(A, { text: "", attachments: [{ kind: "file", mime: "x/y", data: new Uint8Array(10) }] }), /could not be uploaded/);
  for (const x of [h, f, f2, u, u2]) assert.equal(x.calls.length, 0);
});

test("debug lines carry step, byte count, cdn and result only", async () => {
  const lines: string[] = [];
  const orig = console.debug; const prev = process.env.UNIMSG_DEBUG;
  process.env.UNIMSG_DEBUG = "1"; console.debug = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const h = await setup();
    await h.client.send(A, { text: "secret body", attachments: [{ kind: "file", mime: "x/y", name: "secret.txt", data: new Uint8Array(10) }] });
    const u = await setup({ cdnStatus: 403 });
    await u.client.send(A, { text: "", attachments: [{ kind: "file", mime: "x/y", data: new Uint8Array(10) }] }).catch(() => {});
  } finally { console.debug = orig; if (prev === undefined) delete process.env.UNIMSG_DEBUG; else process.env.UNIMSG_DEBUG = prev; }
  assert.equal(lines[0], "[signal] attachment upload: step=encrypt bytes=10 cdn=0 result=ok");
  assert.equal(lines[1], "[signal] attachment upload: step=form bytes=10 cdn=3 result=ok");
  assert.match(lines[2]!, /^\[signal\] attachment upload: step=upload bytes=\d+ cdn=3 result=ok$/);
  assert.equal(lines[3], "[signal] attachment upload: step=send bytes=10 cdn=0 result=ok");
  assert.ok(lines.some((l) => l.includes("step=upload") && l.includes("result=error:http-403")));
  assert.ok(!lines.join("\n").includes("secret"));
});
