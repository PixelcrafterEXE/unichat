// Poll send/secret/single-choice/persistence, on-demand history, media re-upload + failure reasons, presence (offline fakes only).
process.env.UNIMSG_DEBUG = "1";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { decryptPollVote, proto } from "@whiskeysockets/baileys";
import type { CoreEvent } from "@unimsg/core";

const { default: factory } = await import("./index.js");
const { encryptVote } = await import("./poll.js");
const oid = (n: string) => createHash("sha256").update(n).digest("hex");

/* eslint-disable @typescript-eslint/no-explicit-any */
function setup(dir?: string) {
  const d = dir ?? mkdtempSync(join(tmpdir(), "wa-f2-"));
  const c = factory.create({ accountId: "t", dataDir: d });
  const p = c as any;
  const events: CoreEvent[] = [];
  p.emit = (e: CoreEvent) => events.push(e);
  p.auth = { creds: { me: { id: "491700000000:3@s.whatsapp.net", lid: "9000:3@lid" } } };
  p.opened = true;
  return { c, p, events, dir: d, done: () => { p.store.discard(); if (!dir) rmSync(d, { recursive: true, force: true }); } };
}
const DM = "4930@s.whatsapp.net";

test("poll sent from UniChat: explicit 32-byte secret reaches Baileys, is stored, survives a restart and decrypts a later vote", async () => {
  const { c, p, done, dir } = setup();
  try {
    const sent: any[] = [];
    p.sock = { sendMessage: async (jid: string, content: any) => {
      sent.push(content);
      const pl = content.poll; const pc = { name: pl.name, selectableOptionsCount: pl.selectableCount, options: pl.values.map((v: string) => ({ optionName: v })) };
      const message = { messageContextInfo: { messageSecret: pl.messageSecret }, ...(pl.selectableCount === 1 ? { pollCreationMessageV3: pc } : { pollCreationMessage: pc }) };
      return { key: { remoteJid: jid, id: "POLLOUT" + sent.length, fromMe: true }, messageTimestamp: 9, message, status: 1 };
    } };
    const single = await c.send(DM, { text: "", poll: { question: "Lunch?", options: ["Pizza", "Sushi"], multiple: false } } as any);
    assert.equal(sent[0].poll.selectableCount, 1);
    assert.equal(sent[0].poll.messageSecret.length, 32);
    assert.equal(single.poll?.multiple, false);
    const multi = await c.send(DM, { text: "", poll: { question: "Toppings?", options: ["A", "B", "C"], multiple: true } } as any);
    assert.equal(sent[1].poll.selectableCount, 0);
    assert.equal(multi.poll?.multiple, true);
    assert.equal(p.store.find(DM, single.id).poll.secret, Buffer.from(sent[0].poll.messageSecret).toString("base64"));
    // a send path that loses the secret is repaired (and reported), never silently sent without one
    p.sock.sendMessage = async (jid: string, content: any) => ({ key: { remoteJid: jid, id: "NOSEC", fromMe: true }, messageTimestamp: 10, message: { pollCreationMessage: { name: "x", selectableOptionsCount: 0, options: [{ optionName: "a" }, { optionName: "b" }] } }, status: 1 });
    const fixed = await c.send(DM, { text: "", poll: { question: "x", options: ["a", "b"], multiple: true } } as any);
    assert.ok(p.store.find(DM, fixed.id).poll.secret.length > 0);
    // restart: a fresh connector on the same dir still holds the secret; an incoming vote decrypts
    p.store.flush();
    const r = setup(dir); const p2 = r.p; p2.store.load();
    assert.equal(p2.store.find(DM, single.id).poll.secret, p.store.find(DM, single.id).poll.secret);
    const enc = encryptVote(sent[0].poll.messageSecret, single.id, "491700000000@s.whatsapp.net", DM, [oid("Sushi")]);
    p2.intake({ key: { remoteJid: DM, id: "V1", fromMe: false }, messageTimestamp: 20, message: { pollUpdateMessage: { pollCreationMessageKey: { remoteJid: DM, id: single.id, fromMe: true }, vote: enc, senderTimestampMs: 20_000 } } }, true);
    const upd = r.events.find((e) => e.type === "message-update") as any;
    assert.deepEqual(upd.data.patch.poll.options[1].voters, [DM]);
    r.done();
  } finally { done(); }
});

test("single-choice vs multiple-choice detection, and a single-choice vote replaces the previous one", async () => {
  const { c, p, done } = setup();
  try {
    const SEC = new Uint8Array(32).fill(5);
    const mk = (id: string, field: string, count: number | undefined) => p.intake({ key: { remoteJid: DM, id, fromMe: false }, messageTimestamp: 5,
      message: { messageContextInfo: { messageSecret: SEC }, [field]: { name: "Q", ...(count === undefined ? {} : { selectableOptionsCount: count }), options: [{ optionName: "A" }, { optionName: "B" }] } } }, false);
    assert.equal(mk("a", "pollCreationMessageV3", 1)!.poll!.multiple, false);
    assert.equal(mk("b", "pollCreationMessage", 1)!.poll!.multiple, false);
    assert.equal(mk("c", "pollCreationMessage", 0)!.poll!.multiple, true);
    assert.equal(mk("d", "pollCreationMessageV3", 3)!.poll!.multiple, true);
    assert.equal(mk("e", "pollCreationMessageV3", undefined)!.poll!.multiple, true);
    const relayed: any[] = [];
    p.sock = { relayMessage: async (j: string, m: any) => { relayed.push(m); return "x"; } };
    await c.vote!(DM, "a", [oid("A")]);
    await c.vote!(DM, "a", [oid("B")]);
    assert.deepEqual(p.store.find(DM, "a").m.poll.mine, [oid("B")]);
    assert.deepEqual(p.store.find(DM, "a").m.poll.options[0].voters, []);
    await assert.rejects(c.vote!(DM, "a", [oid("A"), oid("B")]), /single choice/);
    // both votes were encrypted for the poll and decrypt with Baileys' own function
    const dec = decryptPollVote(relayed[1].pollUpdateMessage.vote, { pollEncKey: Buffer.from(SEC), pollCreatorJid: DM, pollMsgId: "a", voterJid: "9000@lid" }).selectedOptions!;
    assert.deepEqual(dec.map((b) => Buffer.from(b).toString("hex")), [oid("B")]);
  } catch (e) { throw e; } finally { done(); }
});

function historySetup() {
  const r = setup();
  const { p } = r;
  p.store.data.chats[DM] = { id: DM, kind: "dm", lastMessageAt: new Date(100_000).toISOString() };
  p.store.add(DM, { m: { id: "OLD", chatId: DM, text: "x", time: new Date(100_000).toISOString(), fromMe: false } as any, ts: 100_000 });
  const calls: any[] = [];
  let mode: "new" | "empty" | "silent" = "new";
  p.sock = { presenceSubscribe: async () => {}, fetchMessageHistory: async (n: number, key: any, ts: number) => {
    calls.push({ n, key, ts }); const sid = "S" + calls.length;
    if (mode !== "silent") setTimeout(() => {
      if (mode === "new") p.store.add(DM, { m: { id: "OLDER" + calls.length, chatId: DM, text: "y", time: new Date(50_000).toISOString(), fromMe: false } as any, ts: 50_000 - calls.length });
      p.historySeen.add(sid); p.historyWaiters.get(sid)?.();
    }, 5);
    return sid;
  } };
  return { ...r, calls, mode: (m: typeof mode) => { mode = m; } };
}

test("history(): asks the phone for 50 older messages, shares concurrent requests, remembers 'no more'", async () => {
  const { c, p, calls, mode, done } = historySetup();
  try {
    const [a, b] = await Promise.all([c.history(DM, { limit: 20 }), c.history(DM, { limit: 20 })]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].n, 50); assert.equal(calls[0].key.id, "OLD"); assert.equal(calls[0].ts, 100_000);
    assert.equal(a.length, 2); assert.equal(b.length, 2);
    mode("empty");
    await c.history(DM, { limit: 20, beforeMessageId: "OLDER1" });
    assert.equal(calls.length, 2);
    assert.ok(p.noMoreHistory.has(DM));
    await c.history(DM, { limit: 20, beforeMessageId: "OLDER1" });
    assert.equal(calls.length, 2); // exhausted: no further request
  } finally { done(); }
});

test("history(): a silent phone times out without marking the chat exhausted, then pauses requests", async () => {
  const { c, p, calls, mode, done } = historySetup();
  try {
    mode("silent"); p.historyWaitMs = 30;
    await c.history(DM, { limit: 20 });
    assert.equal(calls.length, 1);
    assert.equal(p.noMoreHistory.has(DM), false);
    await c.history(DM, { limit: 20 });
    assert.equal(calls.length, 1); // cooldown
    p.olderCooldown.clear(); mode("new");
    await c.history(DM, { limit: 20 });
    assert.equal(calls.length, 2);
  } finally { done(); }
});

function mediaSetup(opts: { first: unknown; second?: unknown }) {
  const r = setup();
  const { p } = r;
  p.intake({ key: { remoteJid: DM, id: "IMG", fromMe: false }, messageTimestamp: 5, message: { imageMessage: { mimetype: "image/jpeg", mediaKey: randomBytes(32), directPath: "/old/path", url: "https://mmg.whatsapp.net/old" } } }, false);
  const dl: any[] = [];
  p.downloader = async (info: any) => {
    dl.push(info.directPath);
    const o = dl.length === 1 ? opts.first : opts.second;
    if (o instanceof Error) throw o;
    return (async function* () { yield Buffer.from("PIXELS"); })();
  };
  const reup: any[] = [];
  p.sock = { updateMediaMessage: async (m: any) => { reup.push(m); const inner = m.message.imageMessage; inner.directPath = "/new/path"; inner.url = "https://mmg.whatsapp.net/new"; return m; } };
  return { ...r, dl, reup };
}
const http = (st: number) => Object.assign(new Error(`Request failed with status code ${st}`), { response: { status: st } });

test("media: expired (404) -> updateMediaMessage re-upload -> retry with the new path, stored for next time", async () => {
  const { c, p, dl, reup, done } = mediaSetup({ first: http(404) });
  try {
    const out = await c.downloadAttachment!(DM, "IMG", "a0");
    assert.equal(Buffer.from(out.data).toString(), "PIXELS");
    assert.deepEqual(dl, ["/old/path", "/new/path"]);
    assert.equal(reup.length, 1); assert.equal(reup[0].key.id, "IMG");
    assert.equal(p.store.find(DM, "IMG").att.a0.directPath, "/new/path");
  } finally { done(); }
});

test("media: failure reasons (expired + phone offline, disk full, no media key, network) are machine-readable", async () => {
  const { c, p, done } = mediaSetup({ first: http(410), second: http(410) });
  try {
    p.reuploadTimeoutMs = 20; p.sock.updateMediaMessage = () => new Promise(() => {});
    await assert.rejects(c.downloadAttachment!(DM, "IMG", "a0"), (e: any) => e.reason === "phone-offline");
    p.sock.updateMediaMessage = async () => { throw Object.assign(new Error("Media re-upload failed by device (NOT_FOUND)"), { output: { statusCode: 404 } }); };
    await assert.rejects(c.downloadAttachment!(DM, "IMG", "a0"), (e: any) => e.reason === "expired" && /could not provide/.test(e.message));
    p.opened = false;
    await assert.rejects(c.downloadAttachment!(DM, "IMG", "a0"), (e: any) => e.reason === "offline");
    p.opened = true;
    p.downloader = async () => { throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }); };
    await assert.rejects(c.downloadAttachment!(DM, "IMG", "a0"), (e: any) => e.reason === "disk-full");
    p.downloader = async () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); };
    await assert.rejects(c.downloadAttachment!(DM, "IMG", "a0"), (e: any) => e.reason === "network");
    p.store.find(DM, "IMG").att.a0.mediaKey = "";
    await assert.rejects(c.downloadAttachment!(DM, "IMG", "a0"), (e: any) => e.reason === "no-media-key");
    await assert.rejects(c.downloadAttachment!(DM, "NOPE", "a0"), (e: any) => e.reason === "not-cached");
  } finally { done(); }
});

test("presence: subscribes recent DMs only (max 30), maps presence.update to presence events", () => {
  const { p, events, done } = setup();
  try {
    const subs: string[] = [];
    p.sock = { presenceSubscribe: async (j: string) => { subs.push(j); } };
    const now = Date.now();
    for (let i = 0; i < 40; i++) p.store.data.chats[`49${i}@s.whatsapp.net`] = { id: `49${i}@s.whatsapp.net`, kind: "dm", lastMessageAt: new Date(now - i * 60_000).toISOString() };
    p.store.data.chats["old@s.whatsapp.net"] = { id: "old@s.whatsapp.net", kind: "dm", lastMessageAt: new Date(now - 90 * 86_400_000).toISOString() };
    p.store.data.chats["1@g.us"] = { id: "1@g.us", kind: "group", lastMessageAt: new Date(now).toISOString() };
    p.subscribeRecentPresence();
    assert.equal(subs.length, 30);
    assert.ok(!subs.includes("old@s.whatsapp.net") && !subs.includes("1@g.us"));
    assert.ok(subs.includes("490@s.whatsapp.net") && !subs.includes("4939@s.whatsapp.net")); // newest 30 kept
    // opening a 31st chat evicts the oldest subscription, never exceeding 30
    p.subscribePresence("4939@s.whatsapp.net");
    assert.equal(p.presenceSubscribed.size, 30);
  } finally { done(); }
});

test("presence.update becomes a presence event (online / last seen), groups are ignored", () => {
  const { p, events, done } = setup();
  try {
    const h: Record<string, (a: any) => void> = {};
    p.wire({ ev: { on: (n: string, f: (a: any) => void) => { h[n] = f; } } });
    h["presence.update"]!({ id: DM, presences: { [DM]: { lastKnownPresence: "available" } } });
    h["presence.update"]!({ id: DM, presences: { [DM]: { lastKnownPresence: "unavailable", lastSeen: 1_700_000_000 } } });
    h["presence.update"]!({ id: "1@g.us", presences: { [DM]: { lastKnownPresence: "available" } } });
    const pr = events.filter((e) => e.type === "presence").map((e: any) => e.data);
    assert.equal(pr.length, 2);
    assert.deepEqual(pr[0], { accountId: "t", chatId: DM, contactId: DM, online: true });
    assert.deepEqual(pr[1], { accountId: "t", chatId: DM, contactId: DM, online: false, lastSeen: new Date(1_700_000_000_000).toISOString() });
  } finally { done(); }
});
