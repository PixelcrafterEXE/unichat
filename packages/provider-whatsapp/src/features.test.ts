// Mentions, link previews, forwarded, disappearing messages (offline: fake socket, loopback fake web server via injected resolver).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreEvent, Message } from "@unimsg/core";
import factory from "./index.js";
import { buildLinkPreview, firstUrl, isBlockedAddress, parseMeta } from "./linkpreview.js";
import { renderMentions, rewriteMentions } from "./mentions.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Priv = {
  emit: (e: CoreEvent) => void; store: import("./store.js").Store; sock?: unknown; opened: boolean; previewOpts: any;
  applyContact(c: object): void; applyChat(c: object): void; applyGroup(g: object, authoritative?: boolean): void; learn(l: string, p: string): void;
  intake(w: object, live: boolean): Message | undefined; ephemeralOf(chatId: string): number;
};
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wa-feat-"));
  const c = factory.create({ accountId: "t", dataDir: dir });
  const p = c as unknown as Priv;
  const events: CoreEvent[] = [];
  p.emit = (e) => events.push(e);
  const sent: { jid: string; content: any; opts: any }[] = [];
  p.opened = true;
  p.sock = {
    sendMessage: async (jid: string, content: any, opts?: any) => {
      sent.push({ jid, content, opts });
      // echo what Baileys would build: text -> extendedTextMessage, image -> imageMessage, with mentions/forward in contextInfo
      const ctx: any = { ...(content.mentions ? { mentionedJid: content.mentions } : {}), ...(content.contextInfo ?? {}), ...(opts?.ephemeralExpiration ? { expiration: opts.ephemeralExpiration } : {}) };
      const contextInfo = Object.keys(ctx).length ? ctx : undefined;
      const message = content.image ? { imageMessage: { mimetype: "image/png", caption: content.caption, contextInfo } }
        : content.text !== undefined ? { extendedTextMessage: { text: content.text, contextInfo } } : { conversation: "x" };
      return { key: { remoteJid: jid, id: `S${sent.length}`, fromMe: true }, messageTimestamp: 9, message, status: 1 };
    },
  };
  return { c, p, events, sent, done: () => { p.store.discard(); rmSync(dir, { recursive: true, force: true }); } };
}
const G = "120363@g.us", ANN = "4915111@s.whatsapp.net", BOB = "4915222@s.whatsapp.net", ANN_LID = "70010001@lid", BOB_LID = "70020002@lid";
const members = [
  { id: ANN, jid: ANN, lid: ANN_LID }, { id: BOB, jid: BOB, lid: BOB_LID },
];

// ------------------------------------------------------------------ mentions
test("mentions: pure rewrite handles offsets, repeats, invalid and overlapping spans", () => {
  const t = (id: string) => (id === "a" ? { jid: "111@s.whatsapp.net" } : id === "b" ? { jid: "222@lid" } : undefined);
  const text = "hi @Ann and @Bob, @Ann! @Zed @";
  const spans = (needle: string) => { const r: number[] = []; for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) r.push(i); return r; };
  const [a1, a2] = spans("@Ann") as [number, number];
  const r = rewriteMentions(text, [
    { id: "a", name: "Ann", start: a1, length: 4 }, { id: "b", name: "Bob", start: text.indexOf("@Bob"), length: 4 },
    { id: "a", name: "Ann", start: a2, length: 4 }, { id: "z", name: "Zed", start: text.indexOf("@Zed"), length: 4 }, // unknown member: left as typed
    { id: "a", name: "x", start: 3, length: 3 },      // overlaps the first span (and is not "@Ann")
    { id: "a", name: "x", start: 99, length: 4 },     // out of range
    { id: "a", name: "x", start: 1, length: 1 },      // does not start at '@'
  ], t);
  assert.equal(r.text, "hi @111 and @222, @111! @Zed @");
  assert.deepEqual(r.jids, ["111@s.whatsapp.net", "222@lid"]);
  assert.deepEqual(rewriteMentions("plain", undefined, t), { text: "plain", jids: [] });
});

test("mentions: render only tokens whose jid is listed and named; either id form matches", () => {
  const names = (j: string) => (j === "90000009@lid" ? { forms: ["49150000@s.whatsapp.net"], name: "Ann" } : { forms: [], name: undefined });
  assert.equal(renderMentions("hey @49150000 and @99999999 and @12345", ["90000009@lid", "88888888@lid"], names), "hey @Ann and @99999999 and @12345");
  assert.equal(renderMentions("hey @90000009", ["90000009@lid"], names), "hey @Ann");
  assert.equal(renderMentions("no mentions @49150000", undefined, names), "no mentions @49150000");
});

test("send: mentions in a phone-number group use number jids; the stored copy shows names", async () => {
  const { c, p, sent, done } = setup();
  try {
    p.applyGroup({ id: G, subject: "G", addressingMode: "pn", participants: members });
    p.applyContact({ id: ANN, name: "Ann" });
    const m = await c.send(G, { text: "hi @Ann!", mentions: [{ id: ANN, name: "Ann", start: 3, length: 4 }] });
    assert.equal(sent[0]!.content.text, "hi @4915111!");
    assert.deepEqual(sent[0]!.content.mentions, [ANN]);
    assert.equal(m.text, "hi @Ann!");
    assert.equal(c.capabilities.mentions, true);
  } finally { done(); }
});

test("send: LID-addressed groups mention by LID and write the LID user part; contact ids in either form resolve", async () => {
  const { c, p, sent, done } = setup();
  try {
    p.applyGroup({ id: G, subject: "G", addressingMode: "lid", participants: [{ id: ANN_LID, lid: ANN_LID, jid: ANN }, { id: BOB_LID, lid: BOB_LID }] });
    p.applyContact({ id: ANN, name: "Ann" });
    p.applyContact({ id: BOB_LID, name: "Bob" });
    const m = await c.send(G, { text: "@Ann @Bob", mentions: [{ id: ANN, name: "Ann", start: 0, length: 4 }, { id: BOB_LID, name: "Bob", start: 5, length: 4 }] });
    assert.equal(sent[0]!.content.text, "@70010001 @70020002");
    assert.deepEqual(sent[0]!.content.mentions, [ANN_LID, BOB_LID]);
    assert.equal(m.text, "@Ann @Bob");
  } finally { done(); }
});

test("send: a LID-only member of a phone-number group falls back to the LID; a number-only member of a LID group to the number", async () => {
  const { c, p, sent, done } = setup();
  try {
    p.applyGroup({ id: G, subject: "G", addressingMode: "pn", participants: [{ id: BOB_LID, lid: BOB_LID }] });
    await c.send(G, { text: "@Bob", mentions: [{ id: BOB_LID, name: "Bob", start: 0, length: 4 }] });
    assert.equal(sent[0]!.content.text, "@70020002");
    p.applyGroup({ id: G, subject: "G", addressingMode: "lid", participants: [{ id: BOB, jid: BOB }] });
    await c.send(G, { text: "@Bob", mentions: [{ id: BOB, name: "Bob", start: 0, length: 4 }] });
    assert.equal(sent[1]!.content.text, "@4915222");
    assert.deepEqual(sent[1]!.content.mentions, [BOB]);
  } finally { done(); }
});

test("send: mentions on a media caption; DMs and unknown members keep the text and add no mentions", async () => {
  const { c, p, sent, done } = setup();
  try {
    p.applyGroup({ id: G, subject: "G", addressingMode: "pn", participants: members });
    p.applyContact({ id: ANN, name: "Ann" });
    const m = await c.send(G, { text: "look @Ann", mentions: [{ id: ANN, name: "Ann", start: 5, length: 4 }], attachments: [{ kind: "image", mime: "image/png", data: new Uint8Array([1]) }] });
    assert.equal(sent[0]!.content.caption, "look @4915111");
    assert.deepEqual(sent[0]!.content.mentions, [ANN]);
    assert.equal(m.text, "look @Ann");
    const dm = await c.send(ANN, { text: "hi @Ann", mentions: [{ id: ANN, name: "Ann", start: 3, length: 4 }] });
    assert.equal(sent[1]!.content.text, "hi @Ann");
    assert.equal(sent[1]!.content.mentions, undefined);
    assert.equal(dm.text, "hi @Ann");
    await c.send(G, { text: "@Nobody", mentions: [{ id: "not-a-jid", name: "Nobody", start: 0, length: 7 }] });
    assert.equal(sent[2]!.content.text, "@Nobody");
    assert.equal(sent[2]!.content.mentions, undefined);
  } finally { done(); }
});

test("receive: tokens become names (push, contact, phone format); lid tokens map via the known pair; media captions and edits too", async () => {
  const { p, events, done } = setup();
  try {
    p.applyGroup({ id: G, subject: "G", addressingMode: "lid", participants: members });
    p.applyContact({ id: ANN, name: "Ann" });
    p.intake({ key: { remoteJid: G, id: "p1", fromMe: false, participant: BOB }, messageTimestamp: 5, pushName: "Bob", message: { conversation: "x" } }, true);
    const m1 = p.intake({ key: { remoteJid: G, id: "m1", fromMe: false, participant: BOB }, messageTimestamp: 6,
      message: { extendedTextMessage: { text: "@70010001 and @4915222 and @4915333 and @77777777", contextInfo: { mentionedJid: [ANN_LID, BOB, "4915333@s.whatsapp.net"] } } } }, true);
    assert.match(m1!.text, /^@Ann and @~Bob and @\+49 /);
    assert.ok(m1!.text.endsWith("@77777777"));
    const m2 = p.intake({ key: { remoteJid: G, id: "m2", fromMe: false, participant: BOB }, messageTimestamp: 7,
      message: { imageMessage: { mimetype: "image/jpeg", caption: "see @70010001", contextInfo: { mentionedJid: [ANN_LID] } } } }, true);
    assert.equal(m2?.text, "see @Ann");
    // contact renamed later: an edit re-renders with the current name
    p.applyContact({ id: ANN, name: "Anna" });
    assert.equal(events.filter((e) => e.type === "message").length, 3);
  } finally { done(); }
});

// ------------------------------------------------------------------ plain sends, forwarded, replies
test("plain send is unchanged: same content object, no options", async () => {
  const { c, p, sent, done } = setup();
  try {
    p.applyGroup({ id: G, subject: "G", participants: members });
    await c.send(G, { text: "hello there" });
    assert.deepEqual(sent[0]!.content, { text: "hello there" });
    assert.equal(sent[0]!.opts, undefined);
    await c.send(ANN, { text: "visit www.example.org", });
    assert.equal(sent[1]!.content.mentions, undefined);
    assert.equal(sent[1]!.content.contextInfo, undefined);
  } finally { done(); }
});

test("forwarded: isForwarded + forwardingScore on every part; incoming flag is mapped; not set otherwise", async () => {
  const { c, p, sent, done } = setup();
  try {
    const m = await c.send(ANN, { text: "fwd", forwarded: true });
    assert.deepEqual(sent[0]!.content.contextInfo, { isForwarded: true, forwardingScore: 1 });
    assert.equal(m.forwarded, true);
    await c.send(ANN, { text: "cap", forwarded: true, attachments: [{ kind: "image", mime: "image/png", data: new Uint8Array([1]) }] });
    assert.deepEqual(sent[1]!.content.contextInfo, { isForwarded: true, forwardingScore: 1 });
    const plain = await c.send(ANN, { text: "no" });
    assert.equal(plain.forwarded, undefined);
    const inc = p.intake({ key: { remoteJid: ANN, id: "f1", fromMe: false }, messageTimestamp: 3, message: { extendedTextMessage: { text: "x", contextInfo: { isForwarded: true, forwardingScore: 2 } } } }, true);
    assert.equal(inc?.forwarded, true);
  } finally { done(); }
});

test("reply edge cases: quote goes on the first part only; unknown target sends a plain message; group quote carries the participant", async () => {
  const { c, p, sent, done } = setup();
  try {
    p.applyGroup({ id: G, subject: "G", participants: members });
    p.intake({ key: { remoteJid: G, id: "q1", fromMe: false, participant: BOB }, messageTimestamp: 4, message: { conversation: "orig" } }, true);
    await c.send(G, { text: "re", replyToMessageId: "q1", attachments: [{ kind: "image", mime: "image/png", data: new Uint8Array([1]) }, { kind: "image", mime: "image/png", data: new Uint8Array([2]) }] });
    assert.equal(sent[0]!.opts.quoted.key.id, "q1");
    assert.equal(sent[0]!.opts.quoted.key.participant, BOB);
    assert.equal(sent[1]!.opts, undefined);
    await c.send(G, { text: "re2", replyToMessageId: "gone" });
    assert.equal(sent[2]!.opts, undefined);
  } finally { done(); }
});

// ------------------------------------------------------------------ disappearing messages
test("ephemeral: learned from group metadata, chats.update, timer stubs and message expiration; newer wins; sends follow it", async () => {
  const { c, p, sent, done } = setup();
  try {
    p.applyGroup({ id: G, subject: "G", participants: members, ephemeralDuration: 604800 });
    assert.equal(p.ephemeralOf(G), 604800);
    await c.send(G, { text: "timed" });
    assert.deepEqual(sent[0]!.opts, { ephemeralExpiration: 604800 });
    // partial group updates without the field do not reset it
    p.applyGroup({ id: G, subject: "G2", participants: members }, false);
    assert.equal(p.ephemeralOf(G), 604800);
    // a protocol EPHEMERAL_SETTING arrives as a chat update (null = off), newer than the metadata
    p.applyChat({ id: G, ephemeralExpiration: null, ephemeralSettingTimestamp: Math.floor(Date.now() / 1000) + 10 });
    assert.equal(p.ephemeralOf(G), 0);
    await c.send(G, { text: "untimed" });
    assert.equal(sent[1]!.opts, undefined);
    // DM: expiration in an incoming message's contextInfo
    p.intake({ key: { remoteJid: ANN, id: "e1", fromMe: false }, messageTimestamp: 100, message: { extendedTextMessage: { text: "x", contextInfo: { expiration: 86400 } } } }, true);
    assert.equal(p.ephemeralOf(ANN), 86400);
    await c.send(ANN, { text: "a", replyToMessageId: "e1" });
    assert.equal(sent[2]!.opts.ephemeralExpiration, 86400);
    assert.equal(sent[2]!.opts.quoted.key.id, "e1");
    // an older timer-change stub does not override; a newer one (0) turns it off
    p.intake({ key: { remoteJid: ANN, id: "s0", fromMe: false }, messageTimestamp: 50, messageStubType: 72, messageStubParameters: ["604800"] }, false);
    assert.equal(p.ephemeralOf(ANN), 86400);
    p.intake({ key: { remoteJid: ANN, id: "s1", fromMe: false }, messageTimestamp: 200, messageStubType: 72, messageStubParameters: ["0"] }, true);
    assert.equal(p.ephemeralOf(ANN), 0);
    // nothing is ever deleted by us
    assert.ok(p.store.find(ANN, "e1"));
  } finally { done(); }
});

test("setDisappearing (fake socket): group -> groupToggleEphemeral, DM -> disappearingMessagesInChat; Chat.disappearing + Message.expiresIn follow", async () => {
  const { c, p, events, sent, done } = setup();
  try {
    const toggled: [string, number][] = [];
    (p.sock as any).groupToggleEphemeral = async (j: string, s: number) => { toggled.push([j, s]); };
    assert.equal(c.capabilities.disappearing, true);
    p.applyGroup({ id: G, subject: "G", participants: members });
    await c.setDisappearing!(G, 604800);
    assert.deepEqual(toggled, [[G, 604800]]);
    assert.equal(p.ephemeralOf(G), 604800);
    assert.equal((await c.chats()).find((x) => x.id === G)?.disappearing, 604800);
    assert.ok(events.some((e) => e.type === "chats-changed"));
    p.intake({ key: { remoteJid: ANN, id: "m1", fromMe: false }, messageTimestamp: 100, message: { extendedTextMessage: { text: "x", contextInfo: { expiration: 86400 } } } }, true);
    assert.equal(p.store.find(ANN, "m1")?.m.expiresIn, 86400);
    await c.setDisappearing!(ANN, 86400);
    assert.deepEqual(sent.at(-1)!.content, { disappearingMessagesInChat: 86400 });
    await c.setDisappearing!(ANN, 0);
    assert.deepEqual(sent.at(-1)!.content, { disappearingMessagesInChat: false });
    assert.equal(p.ephemeralOf(ANN), 0);
    await assert.rejects(() => c.setDisappearing!(ANN, 123), /24 hours/);
    await toggled.length; await c.setDisappearing!(G, 0); assert.equal((await c.chats()).find((x) => x.id === G)?.disappearing, undefined);
  } finally { done(); }
});

test("ephemeral: a fetched group without ephemeralDuration means off", () => {
  const { p, done } = setup();
  try {
    p.applyGroup({ id: G, subject: "G", participants: members, ephemeralDuration: 86400 });
    p.applyGroup({ id: G, subject: "G", participants: members });
    assert.equal(p.ephemeralOf(G), 0);
  } finally { done(); }
});

// ------------------------------------------------------------------ link previews
test("firstUrl and address policy", () => {
  assert.equal(firstUrl("see https://example.org/a?b=1, ok"), "https://example.org/a?b=1");
  assert.equal(firstUrl("(https://en.wikipedia.org/wiki/X_(y))."), "https://en.wikipedia.org/wiki/X_(y)");
  assert.equal(firstUrl("go www.example.org!"), "www.example.org");
  assert.equal(firstUrl("no link, ftp://x.org mailto:a@b.c"), undefined);
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::", "::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:7f00:1::", "ff02::1", "not-an-ip"]) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isBlockedAddress(ip), false, ip);
});

test("parseMeta: og tags win, entities decoded, falls back to <title>/description", () => {
  const m = parseMeta(`<html><head><title>Fall &amp; back</title><meta name="description" content="plain"><meta property="og:title" content="T &quot;1&quot;"><meta content='D &#233;' property='og:description'><meta property="og:image" content="/i.jpg"><link rel="canonical" href="/c"></head>`);
  assert.deepEqual(m, { title: 'T "1"', description: "D é", image: "/i.jpg", canonical: "/c" });
  assert.deepEqual(parseMeta("<title> only </title>"), { title: "only" });
});

const JPEG = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
interface Site { base: string; hits: string[]; close(): Promise<void> }
async function site(routes: Record<string, (res: http.ServerResponse) => void>): Promise<Site> {
  const hits: string[] = [];
  const srv = http.createServer((req, res) => { hits.push(req.url ?? ""); (routes[req.url ?? ""] ?? ((r) => { r.statusCode = 404; r.end(); }))(res); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return { base: `http://site.test:${port}`, hits, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
const html = (res: http.ServerResponse, body: string, type = "text/html; charset=utf-8") => { res.setHeader("content-type", type); res.end(body); };
/** loopback is allowed ONLY here, through the injected override */
const loopbackOnly = { resolve: async (h: string) => (h === "site.test" ? ["127.0.0.1"] : h === "internal.test" ? ["10.0.0.5"] : h === "mixed.test" ? ["127.0.0.1", "192.168.0.9"] : ["8.8.8.8"]), isBlocked: (ip: string) => ip !== "127.0.0.1" && isBlockedAddress(ip) };

test("preview: fetches og data, resolves relative image/canonical, small jpeg becomes the thumbnail", async () => {
  const s = await site({
    "/p": (r) => html(r, `<head><meta property="og:title" content="Hello"><meta property="og:description" content="World"><meta property="og:image" content="/img.jpg"><meta property="og:url" content="/canon"></head>`),
    "/img.jpg": (r) => { r.setHeader("content-type", "image/jpeg"); r.end(JPEG(500)); },
  });
  try {
    const pv = await buildLinkPreview(`look ${s.base}/p now`, loopbackOnly);
    assert.equal(pv?.matchedText, `${s.base}/p`);
    assert.equal(pv?.canonicalUrl, `${s.base}/canon`);
    assert.equal(pv?.title, "Hello"); assert.equal(pv?.description, "World");
    assert.equal(pv?.jpegThumbnail?.length, 504);
    assert.deepEqual(s.hits, ["/p", "/img.jpg"]);
  } finally { await s.close(); }
});

test("preview: big or non-jpeg images shrink via makeThumb when available, else the preview has no thumbnail", async () => {
  const s = await site({
    "/p": (r) => html(r, `<title>T</title><meta property="og:image" content="/big.jpg">`),
    "/big.jpg": (r) => { r.setHeader("content-type", "image/jpeg"); r.end(JPEG(200_000)); },
  });
  try {
    const none = await buildLinkPreview(`${s.base}/p`, loopbackOnly);
    assert.equal(none?.title, "T"); assert.equal(none?.jpegThumbnail, undefined);
    const small = await buildLinkPreview(`${s.base}/p`, { ...loopbackOnly, makeThumb: async () => JPEG(100) });
    assert.equal(small?.jpegThumbnail?.length, 104);
    const tooBig = await buildLinkPreview(`${s.base}/p`, { ...loopbackOnly, makeThumb: async () => JPEG(70_000) });
    assert.equal(tooBig?.jpegThumbnail, undefined);
    const throws = await buildLinkPreview(`${s.base}/p`, { ...loopbackOnly, makeThumb: async () => { throw new Error("no sharp"); } });
    assert.equal(throws?.jpegThumbnail, undefined);
  } finally { await s.close(); }
});

test("preview: SSRF protection (default policy, resolved addresses, redirects), redirect cap, type and size limits, timeout", async () => {
  const s = await site({
    "/r1": (r) => { r.statusCode = 302; r.setHeader("location", "/r2"); r.end(); },
    "/r2": (r) => { r.statusCode = 302; r.setHeader("location", "/r3"); r.end(); },
    "/r3": (r) => { r.statusCode = 302; r.setHeader("location", "/ok"); r.end(); },
    "/r4": (r) => { r.statusCode = 302; r.setHeader("location", "/r1"); r.end(); },
    "/ok": (r) => html(r, "<title>OK</title>"),
    "/to-private": (r) => { r.statusCode = 301; r.setHeader("location", "http://internal.test/secret"); r.end(); },
    "/to-literal": (r) => { r.statusCode = 301; r.setHeader("location", "http://169.254.169.254/latest"); r.end(); },
    "/json": (r) => html(r, `{"a":1}`, "application/json"),
    "/huge": (r) => { r.setHeader("content-type", "text/html"); r.write("<title>Early</title>"); r.write(Buffer.alloc(1_100_000, 32)); r.end("<title>late</title>"); },
    "/slow": () => { /* never answers */ },
  });
  try {
    // default policy (no injected override): loopback and private literals/hosts are refused without any request
    assert.equal(await buildLinkPreview(`${s.base}/ok`, { resolve: loopbackOnly.resolve }), undefined);
    assert.equal(await buildLinkPreview(`http://127.0.0.1:1/ok`), undefined);
    assert.equal(await buildLinkPreview(`http://[::1]:1/ok`), undefined);
    assert.equal(await buildLinkPreview(`http://localhost/ok`), undefined);
    assert.deepEqual(s.hits, []);
    assert.equal((await buildLinkPreview(`${s.base}/ok`, loopbackOnly))?.title, "OK");
    // every address a host resolves to must be public
    assert.equal(await buildLinkPreview(`http://mixed.test:${new URL(s.base).port}/ok`, loopbackOnly), undefined);
    // redirects: 3 allowed, the 4th refused; targets are re-checked
    assert.equal((await buildLinkPreview(`${s.base}/r1`, loopbackOnly))?.title, "OK");
    assert.equal(await buildLinkPreview(`${s.base}/r4`, loopbackOnly), undefined);
    const before = s.hits.length;
    assert.equal(await buildLinkPreview(`${s.base}/to-private`, loopbackOnly), undefined);
    assert.equal(await buildLinkPreview(`${s.base}/to-literal`, loopbackOnly), undefined);
    assert.equal(s.hits.length - before, 2); // only the redirecting requests reached the server
    assert.equal(await buildLinkPreview(`${s.base}/json`, loopbackOnly), undefined);
    assert.equal((await buildLinkPreview(`${s.base}/huge`, loopbackOnly))?.title, "Early"); // body capped at 1 MB, head still parsed
    const t0 = Date.now();
    assert.equal(await buildLinkPreview(`${s.base}/slow`, { ...loopbackOnly, timeoutMs: 300 }), undefined);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(await buildLinkPreview(`${s.base}/nothing-here`, loopbackOnly), undefined); // 404
    assert.equal(await buildLinkPreview("no link at all", loopbackOnly), undefined);
  } finally { await s.close(); }
});

test("send: the preview fields reach Baileys; no title / blocked host / no url send plain text; Baileys' own fetch is disabled", async () => {
  const { c, p, sent, done } = setup();
  const s = await site({
    "/p": (r) => html(r, `<meta property="og:title" content="Hello"><meta property="og:description" content="World"><meta property="og:image" content="/i.jpg">`),
    "/i.jpg": (r) => { r.setHeader("content-type", "image/jpeg"); r.end(JPEG(50)); },
    "/bare": (r) => html(r, "<p>no title</p>"),
  });
  try {
    p.previewOpts = loopbackOnly;
    const m = await c.send(ANN, { text: `hey ${s.base}/p` });
    const lp = sent[0]!.content.linkPreview;
    assert.equal(lp.title, "Hello"); assert.equal(lp.description, "World");
    assert.equal(lp["matched-text"], `${s.base}/p`); assert.equal(lp["canonical-url"], `${s.base}/p`);
    assert.equal(lp.jpegThumbnail.length, 54);
    assert.equal(m.text, `hey ${s.base}/p`);
    await c.send(ANN, { text: `${s.base}/bare` });
    assert.equal(sent[1]!.content.linkPreview, null);
    p.previewOpts = {}; // default policy: the loopback site is refused
    await c.send(ANN, { text: `${s.base}/p` });
    assert.equal(sent[2]!.content.linkPreview, null);
    await c.send(ANN, { text: "just text" });
    assert.equal("linkPreview" in sent[3]!.content, false);
    // media captions are never previewed
    await c.send(ANN, { text: `${s.base}/p`, attachments: [{ kind: "image", mime: "image/png", data: new Uint8Array([1]) }] });
    assert.equal("linkPreview" in sent[4]!.content, false);
  } finally { await s.close(); done(); }
});
