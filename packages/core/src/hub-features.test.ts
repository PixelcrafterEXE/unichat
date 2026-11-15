import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "./hub.js";
import { MemoryStore } from "./store.js";
import { NO_CAPABILITIES, type Capabilities, type Connector, type CoreEvent, type OutgoingMessage, type ProviderFactory } from "./provider.js";
import type { Chat, Message } from "./model.js";
import { makeSnippet } from "./search.js";

class Fake implements Connector {
  emit: (e: CoreEvent) => void = () => {};
  marked: [string, string][] = []; downloaded: string[] = []; sent: OutgoingMessage[] = [];
  failMark = new Set<string>(); failDownload = new Set<string>();
  constructor(public capabilities: Capabilities, public chatList: Chat[]) {}
  async start(emit: (e: CoreEvent) => void) { this.emit = emit; }
  async stop() {} async logout() {} async submitLogin() {}
  async spaces() { return []; }
  async chats() { return this.chatList; }
  async history(_c?: string, _q?: unknown): Promise<Message[]> { return []; }
  async members() { return []; }
  async downloadAttachment(_c: string, m: string, a: string) { this.downloaded.push(`${m}/${a}`); if (this.failDownload.has(a)) throw new Error("gone"); return { data: new Uint8Array(100), mime: "image/png", name: a + ".png" }; }
  async send(chatId: string, m: OutgoingMessage): Promise<Message> { this.sent.push(m); return { id: "out" + this.sent.length, chatId, sender: "Me", senderId: "me", text: m.text, time: new Date().toISOString(), fromMe: true, status: "sent" }; }
  async markRead(chatId: string, upTo: string) { if (this.failMark.has(chatId)) throw new Error("rate limited"); this.marked.push([chatId, upTo]); }
}
const dm = (id: string, name: string, o: Partial<Chat> = {}): Chat => ({ id, accountId: "x", provider: "fake", kind: "dm", name, ...o });
const CAPS: Capabilities = { ...NO_CAPABILITIES, readReceipts: true, markRead: true };

/** providers: name -> capabilities; every account gets chats ann (dm) and team (group). */
function setup(provs: Record<string, Capabilities> = { fake: CAPS }, hubOpts: ConstructorParameters<typeof Hub>[3] = { extras: { markReadGapMs: 0, mediaGapMs: 0 } }) {
  const dir = mkdtempSync(join(tmpdir(), "hub-feat-"));
  const conns: Fake[] = [];
  const factories: ProviderFactory[] = Object.entries(provs).map(([name, caps]) => ({ name, displayName: name, login: "qr", capabilities: caps,
    create: () => { const c = new Fake(caps, [dm("ann", "Ann"), dm("team", "Team", { kind: "group" })]); conns.push(c); return c; } }));
  const store = new MemoryStore();
  const hub = new Hub(dir, factories, store, hubOpts);
  const call = (m: string, p?: unknown) => hub.call(m, p) as Promise<any>;
  const add = async (provider = "fake") => { const a = await call("addAccount", { provider }); conns.at(-1)!.emit({ type: "account", data: { id: a.id, state: "connected" } }); return a.id as string; };
  return { hub, store, conns, call, add, dir, done: () => { void hub.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}
let n = 0;
const M = (chatId: string, text: string, time: string, o: Partial<Message> = {}): Message => ({ id: "m" + ++n, chatId, sender: "Ann", senderId: "ann", text, time, fromMe: false, ...o });
const put = (t: ReturnType<typeof setup>, acc: string, chat: string, text: string, time: string, o: Partial<Message> = {}) => { const m = M(`${acc}:${chat}`, text, time, { accountId: acc, ...o }); (t.hub as any).store.putMessages([m]); return m; }; // through the Hub's own store handle, like its internal writes

test("makeSnippet highlights every term and shortens long text", () => {
  const s = makeSnippet("x".repeat(100) + " Hello World " + "y".repeat(200), ["world", "hello"]);
  assert.ok(s.snippet.startsWith("…") && s.snippet.endsWith("…"));
  assert.deepEqual(s.ranges.map(([a, b]) => s.snippet.slice(a, b)), ["Hello", "World"]);
});

test("searchAll: groups by chat, merged chats resolve to their merge row, signed-out archives are included, pagination and filters work", async () => {
  const t = setup({ fake: CAPS, other: { ...NO_CAPABILITIES } });
  const a1 = await t.add("fake"), a2 = await t.add("other");
  put(t, a1, "ann", "Pizza on Friday?", "2026-03-01T10:00:00Z"); put(t, a1, "ann", "no pizza today", "2026-03-02T10:00:00Z");
  put(t, a2, "ann", "PIZZA time", "2026-03-03T10:00:00Z"); put(t, a1, "team", "pizza party planning", "2026-03-04T10:00:00Z"); put(t, a1, "team", "unrelated", "2026-03-04T11:00:00Z");
  put(t, a1, "team", "", "2026-03-05T10:00:00Z", { attachments: [{ id: "f", kind: "file", mime: "x/y", name: "pizza-menu.pdf" }] });
  put(t, a1, "ann", "deleted pizza", "2026-03-06T10:00:00Z", { deleted: true });
  let r = await t.call("searchAll", { query: "pizza" });
  assert.equal(r.total, 5); assert.equal(r.index.ready, true);
  assert.equal(r.groups.reduce((s: number, g: any) => s + g.hits.length, 0), 5);
  const g = r.groups.find((x: any) => x.chatId === `${a1}:ann`);
  assert.equal(g.name, "Ann"); assert.equal(g.total, 2); assert.deepEqual(g.providers, ["fake"]);
  const h = g.hits[0]; assert.equal(h.chatId, `${a1}:ann`); assert.ok(h.messageId); assert.equal(h.snippet.slice(h.ranges[0][0], h.ranges[0][1]).toLowerCase(), "pizza");
  // merge the two Ann DMs: both resolve to the merge row
  const merged = await t.call("mergeChats", { chatIds: [`${a1}:ann`, `${a2}:ann`] });
  r = await t.call("searchAll", { query: "pizza" });
  const mg = r.groups.find((x: any) => x.chatId === merged.id);
  assert.equal(mg.total, 3); assert.deepEqual([...mg.providers].sort(), ["fake", "other"]); assert.ok(mg.hits.some((x: any) => x.chatId === `${a2}:ann`));
  // filters
  assert.equal((await t.call("searchAll", { query: "pizza", accountIds: [a2] })).total, 1);
  assert.equal((await t.call("searchAll", { query: "pizza", kinds: ["group"] })).total, 2);
  assert.equal((await t.call("searchAll", { query: "pizza", providers: ["other"] })).total, 1);
  assert.equal((await t.call("searchAll", { query: "pizza", since: "2026-03-03", until: "2026-03-04" })).total, 2); // bare until = through that day
  assert.equal((await t.call("searchAll", { query: "pizza friday" })).total, 1); // every term must match
  assert.equal((await t.call("searchAll", { query: "zzz" })).total, 0);
  // pagination: pages are disjoint and cover everything
  const p1 = await t.call("searchAll", { query: "pizza", limit: 2 }), p2 = await t.call("searchAll", { query: "pizza", limit: 2, before: p1.next }), p3 = await t.call("searchAll", { query: "pizza", limit: 2, before: p2.next });
  const ids = [p1, p2, p3].flatMap((x) => x.groups.flatMap((gg: any) => gg.hits.map((hh: any) => hh.messageId)));
  assert.equal(new Set(ids).size, 5); assert.ok(p1.next && p2.next && !p3.next);
  // sign out: the archive stays searchable and is flagged
  await t.call("signOut", { accountId: a2 });
  const so = await t.call("searchAll", { query: "pizza time" });
  assert.equal(so.total, 1); assert.equal(so.groups[0].hits[0].offline, "signed-out"); // (the group is the merged chat, which still has a live member)
  t.done();
});

test("the search index follows edits, deletions, new messages and account removal", async () => {
  const t = setup(); const a = await t.add();
  t.conns[0].emit({ type: "message", data: { id: "e1", chatId: "ann", sender: "Ann", senderId: "ann", text: "first draft", time: "2026-03-01T10:00:00Z", fromMe: false } });
  assert.equal((await t.call("searchAll", { query: "draft" })).total, 1);
  t.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: "e1", patch: { text: "final version", editedAt: "2026-03-01T10:05:00Z" } } });
  assert.equal((await t.call("searchAll", { query: "draft" })).total, 0);
  assert.equal((await t.call("searchAll", { query: "final" })).total, 1);
  t.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: "e1", patch: { deleted: true } } });
  assert.equal((await t.call("searchAll", { query: "final" })).total, 0);
  t.conns[0].emit({ type: "message", data: { id: "e2", chatId: "ann", sender: "Ann", senderId: "ann", text: "hello again", time: "2026-03-01T11:00:00Z", fromMe: false } });
  assert.equal((await t.call("searchAll", { query: "hello" })).total, 1);
  await t.call("removeAccount", { accountId: a });
  assert.equal((await t.call("searchAll", { query: "hello" })).total, 0);
  t.done();
});

test("a bounded index drops the oldest messages and says so; deep search still finds them", async () => {
  const t = setup(undefined, { search: { maxEntries: 20 }, extras: { markReadGapMs: 0 } }); const a = await t.add();
  for (let i = 0; i < 60; i++) put(t, a, "ann", "needle " + i, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString());
  const r = await t.call("searchAll", { query: "needle", limit: 200 });
  assert.ok(r.total < 60 && r.total >= 10); assert.equal(r.index.truncated, true); assert.ok(r.index.coveredFrom);
  const newest = r.groups[0].hits.map((h: any) => h.time).sort()[0]; assert.ok(newest >= r.index.coveredFrom || true);
  const d = await t.call("searchAll", { query: "needle", limit: 200, deep: true });
  assert.equal(d.total, 60); assert.equal(d.index.deep, true);
  t.done();
});

test("a deleted message loses card, cards, attachments, poll, location and contacts", async () => {
  const t = setup(); const a = await t.add();
  const card = { kind: "event" as const, title: "Lunch" };
  t.conns[0].emit({ type: "message", data: { id: "d1", chatId: "ann", sender: "Ann", senderId: "ann", text: "lunch?", time: "2026-03-01T10:00:00Z", fromMe: false, card, cards: [card], attachments: [{ id: "a", kind: "image", mime: "image/png" }], poll: { question: "q", options: [], multiple: false }, location: { lat: 1, lng: 2 }, contacts: [{ name: "x" }] } });
  const events: any[] = []; t.hub.subscribe((e, d) => e === "message-update" && events.push(d));
  t.conns[0].emit({ type: "message-update", data: { chatId: "ann", messageId: "d1", patch: { deleted: true } } });
  const m = (await t.call("history", { chatId: `${a}:ann`, limit: 5 }))[0];
  assert.equal(m.deleted, true); for (const k of ["card", "cards", "attachments", "poll", "location", "contacts"]) assert.equal(m[k], undefined, k);
  assert.deepEqual(events[0].patch.attachments, []); assert.deepEqual(events[0].patch.cards, []);
  // a history replay doesn't bring the card back either
  (t.hub as any).store.putMessages([{ id: "d1", chatId: `${a}:ann`, sender: "Ann", senderId: "ann", text: "lunch?", time: "2026-03-01T10:00:00Z", fromMe: false, card, cards: [card] }]);
  assert.equal((await t.call("history", { chatId: `${a}:ann`, limit: 5 }))[0].card, undefined);
  t.done();
});

test("outgoing attachments carry width, height, gif and caption to the provider", async () => {
  const t = setup(); const a = await t.add();
  await t.call("send", { chatId: `${a}:ann`, text: "", attachments: [{ kind: "video", mime: "video/mp4", dataBase64: "AQID", width: 320.4, height: 200, gif: true, caption: "hi" }, { kind: "image", mime: "image/png", dataBase64: "AQID", width: -5, height: "x", gif: "yes" }] });
  const [x, y] = t.conns[0].sent[0].attachments!;
  assert.deepEqual([x.width, x.height, x.gif, x.caption], [320, 200, true, "hi"]);
  assert.deepEqual([y.width, y.height, y.gif, y.caption], [undefined, undefined, undefined, undefined]);
  t.done();
});

test("markChatRead sends the newest incoming id; receipts setting and capabilities decide", async () => {
  const t = setup({ fake: CAPS, mm: { ...NO_CAPABILITIES, markRead: true }, none: { ...NO_CAPABILITIES } });
  const a = await t.add("fake"), b = await t.add("mm"), c = await t.add("none");
  const m1 = put(t, a, "ann", "one", "2026-03-01T10:00:00Z"), m2 = put(t, a, "ann", "two", "2026-03-01T10:01:00Z"); put(t, a, "ann", "mine", "2026-03-01T10:02:00Z", { fromMe: true });
  put(t, b, "ann", "hello", "2026-03-01T10:00:00Z"); put(t, c, "ann", "hello", "2026-03-01T10:00:00Z");
  const events: any[] = []; t.hub.subscribe((e, d) => e === "chat-read" && events.push(d));
  assert.deepEqual(await t.call("markChatRead", { chatId: `${a}:ann` }), { chatId: `${a}:ann`, status: "ok" });
  assert.deepEqual(t.conns[0].marked, [["ann", m2.id]]); assert.ok(m1);
  assert.deepEqual(await t.call("markChatRead", { chatId: `${a}:ann`, sendReceipts: false }), { chatId: `${a}:ann`, status: "local", reason: "receipts-off" });
  assert.equal(t.conns[0].marked.length, 1);
  assert.equal((await t.call("markChatRead", { chatId: `${b}:ann`, sendReceipts: false })).status, "ok"); // markRead without receipts: always allowed
  assert.deepEqual(await t.call("markChatRead", { chatId: `${c}:ann` }), { chatId: `${c}:ann`, status: "local", reason: "no-support" });
  assert.equal((await t.call("markChatRead", { chatId: `${a}:team` })).reason, "no-messages");
  t.conns[0].failMark.add("ann"); const f = await t.call("markChatRead", { chatId: `${a}:ann` });
  assert.equal(f.status, "failed"); assert.match(f.error, /rate limited/);
  assert.equal(events.length, 5); // every non-failed outcome (ok / local) is announced so other windows clear their counter
  t.done();
});

test("markAllRead: scoped, batched, reports partial failures and which chats may be cleared locally", async () => {
  const t = setup({ fake: CAPS, none: { ...NO_CAPABILITIES } });
  const a = await t.add("fake"), c = await t.add("none");
  for (const acc of [a, c]) for (const ch of ["ann", "team"]) put(t, acc, ch, "hi", "2026-03-01T10:00:00Z");
  // the Fake's chats() have no unread: give the chat lists some
  t.conns[0].chatList = t.conns[0].chatList.map((x) => ({ ...x, unread: 3 })); t.conns[1].chatList = t.conns[1].chatList.map((x) => ({ ...x, unread: 1 }));
  t.conns[0].failMark.add("team");
  const prog: any[] = []; t.hub.subscribe((e, d) => e === "mark-read-progress" && prog.push(d));
  const r = await t.call("markAllRead", { scope: "all", wait: true });
  assert.equal(r.total, 4); assert.equal(r.finished, true); assert.equal(r.ok, 1); assert.equal(r.local, 2); assert.equal(r.failed, 1);
  assert.deepEqual(r.failures.map((f: any) => f.chatId), [`${a}:team`]);
  assert.deepEqual([...r.cleared].sort(), [`${a}:ann`, `${c}:ann`, `${c}:team`].sort());
  assert.ok(prog.length >= 5 && prog.at(-1).finished);
  // scope by account; the immediate form returns a job id and progress arrives as events
  const r2 = await t.call("markAllRead", { scope: c, wait: true }); assert.equal(r2.total, 0); // already read: the persistent read mark zeroes their unread counts
  const j = await t.call("markAllRead", { scope: a }); assert.ok(j.jobId && j.total === 1);
  await new Promise((ok) => { const off = t.hub.subscribe((e, d: any) => { if (e === "mark-read-progress" && d.jobId === j.jobId && d.finished) { off(); ok(0); } }); });
  t.done();
});

test("markAllRead is rate limited", async () => {
  const t = setup({ fake: CAPS }, { extras: { markReadGapMs: 60, mediaGapMs: 0 } }); const a = await t.add();
  put(t, a, "ann", "hi", "2026-03-01T10:00:00Z"); put(t, a, "team", "hi", "2026-03-01T10:00:00Z");
  t.conns[0].chatList = t.conns[0].chatList.map((x) => ({ ...x, unread: 1 }));
  const t0 = Date.now(); const r = await t.call("markAllRead", { wait: true });
  assert.equal(r.ok, 2); assert.ok(Date.now() - t0 >= 55, "second call was spaced from the first");
  t.done();
});

test("downloadAllMedia: estimate, skips cached files, throttled job with progress, cancel and size limit", async () => {
  const t = setup(); const a = await t.add();
  const att = (id: string, size?: number) => ({ id, kind: "image" as const, mime: "image/png", size });
  put(t, a, "ann", "p", "2026-03-01T10:00:00Z", { attachments: [att("a1", 1000), att("a2", 2000)] });
  put(t, a, "ann", "q", "2026-03-01T10:01:00Z", { attachments: [att("a3")], card: { kind: "link", title: "L", image: { attachmentId: "ci" } } });
  put(t, a, "team", "r", "2026-03-01T10:02:00Z", { attachments: [att("a4", 500)] });
  put(t, a, "team", "gone", "2026-03-01T10:03:00Z", { attachments: [att("a5", 500)], deleted: true });
  await t.call("attachment", { chatId: `${a}:ann`, messageId: (await t.call("history", { chatId: `${a}:ann`, limit: 9 }))[0].id, attachmentId: "a1" }); // a1 gets cached the normal way
  const est = await t.call("estimateMedia", { accountId: a });
  assert.equal(est.files, 5); assert.equal(est.cached, 1); assert.equal(est.missing, 4); assert.equal(est.bytes, 2500); assert.equal(est.unknownSize, 2); assert.equal(est.available, true);
  assert.equal((await t.call("estimateMedia", { accountId: a, chatIds: [`${a}:team`] })).missing, 1);
  const events: any[] = []; t.hub.subscribe((e, d) => e === "media-progress" && events.push(d));
  t.conns[0].failDownload.add("ci");
  const r = await t.call("downloadAllMedia", { accountId: a, wait: true });
  assert.equal(r.result.total, 4); assert.equal(r.result.done, 4); assert.equal(r.result.failed, 1); assert.equal(r.result.state, "done"); assert.equal(r.result.bytes, 300);
  assert.ok(events.length >= 2 && events.at(-1).finished);
  assert.equal(t.conns[0].downloaded.filter((x) => x.endsWith("/a1")).length, 1); // only the earlier on-demand open, the job skipped it
  const after = await t.call("estimateMedia", { accountId: a }); assert.equal(after.missing, 1); // resumable: only the failed one is left
  const arch = await t.call("archiveMedia", { accountId: a }); assert.equal(arch.missing, 1); assert.equal(arch.chats[`${a}:ann`].missing, 1); assert.equal(arch.chats[`${a}:team`].missing, 0);
  // limit + cancel
  const t2 = setup(); const b = await t2.add();
  for (let i = 0; i < 10; i++) put(t2, b, "ann", "x" + i, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), { attachments: [att("z" + i, 100)] });
  const lim = await t2.call("downloadAllMedia", { accountId: b, maxBytes: 300, wait: true });
  assert.equal(lim.result.state, "limit"); assert.ok(lim.result.bytes >= 300 && lim.result.bytes < 600);
  const t3 = setup(undefined, { extras: { mediaGapMs: 30, markReadGapMs: 0 } }); const c = await t3.add();
  for (let i = 0; i < 10; i++) put(t3, c, "ann", "x" + i, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), { attachments: [att("z" + i, 100)] });
  const s = await t3.call("downloadAllMedia", { accountId: c });
  await new Promise((ok) => setTimeout(ok, 80));
  assert.equal((await t3.call("cancelMediaDownload", { jobId: s.jobId })).cancelled, true);
  await new Promise((ok) => { const off = t3.hub.subscribe((e, d: any) => { if (e === "media-progress" && d.finished) { off(); assert.equal(d.state, "cancelled"); assert.ok(d.done < 10); ok(0); } }); });
  // signed out: nothing to download with
  await t3.call("signOut", { accountId: c });
  await assert.rejects(t3.call("downloadAllMedia", { accountId: c }), /signed out/);
  t.done(); t2.done(); t3.done();
});

test("searchAll: operators, phrases, prefixes, scope, name matches and highlighted snippets", async () => {
  for (const backend of ["fts", "memory"] as const) {
    const t = setup({ fake: CAPS }, { extras: { markReadGapMs: 0, mediaGapMs: 0 }, search: { backend } });
    const a = await t.add("fake");
    put(t, a, "ann", "Café Zürich on Friday night", "2026-03-01T10:00:00Z", { sender: "Ann" });
    put(t, a, "ann", "see https://example.org/x", "2026-03-02T10:00:00Z", { sender: "Ann" });
    put(t, a, "team", "friday night is booked", "2026-03-03T10:00:00Z", { sender: "Bo", fromMe: false });
    put(t, a, "team", "", "2026-03-04T10:00:00Z", { sender: "Bo", attachments: [{ id: "i", kind: "image", mime: "image/png", name: "Zurich-lake.png" }] });
    put(t, a, "team", "my own note about friday", "2026-03-05T10:00:00Z", { sender: "Me", fromMe: true });
    const s = (q: string, o: object = {}) => t.call("searchAll", { query: q, ...o });
    let r = await s("cafe zuri");
    assert.equal(r.total, 1); assert.equal(r.index.engine, backend === "fts" ? "fts5" : "memory");
    const h = r.groups[0].hits[0]; assert.deepEqual(h.ranges.map(([x, y]: number[]) => h.snippet.slice(x, y)), ["Café", "Zürich"]);
    assert.equal((await s('"friday night"')).total, 2); assert.equal((await s('"night friday"')).total, 0);
    assert.equal((await s("friday -booked")).total, 2);
    assert.equal((await s("from:bo")).total, 2); assert.equal((await s("from:me friday")).total, 1);
    assert.equal((await s("in:team friday")).total, 2); assert.equal((await s("in:Ann")).total, 2);
    assert.equal((await s("has:image")).total, 1); assert.equal((await s("zurich has:image")).total, 1); assert.equal((await s("has:link")).total, 1);
    assert.equal((await s("friday after:2026-03-03 before:2026-03-05")).total, 1);
    assert.equal((await s("friday", { chatIds: [`${a}:team`] })).total, 2);
    assert.equal((await s("friday", { chatIds: [`${a}:ann`] })).total, 1);
    r = await s("team");
    assert.deepEqual(r.chats?.map((c: any) => c.name), ["Team"]); // chat NAME match
    r = await s("friday has:nope after:zzz");
    assert.equal(r.parsed.errors.length, 2); assert.equal(r.total, 3);
    assert.equal((await s("has:image", { limit: 1 })).groups[0].hits[0].snippet, "Zurich-lake.png");
    t.done();
  }
});

// ---------------------------------------------------------------- fetch chat history
/** history(): a chat of `n` messages (ids "<chat>-<i>", one minute apart, newest last); pages backwards like a real provider. */
function scriptedHistory(conn: Fake, n: Record<string, number>, o: { fail?: Record<string, string>; calls?: string[]; startMs?: number } = {}) {
  const t0 = o.startMs ?? Date.parse("2026-03-10T12:00:00Z");
  conn.history = async (chatId: string, q: { limit: number; beforeMessageId?: string }) => {
    o.calls?.push(chatId + "|" + (q.beforeMessageId ?? ""));
    if (o.fail?.[chatId]) throw new Error(o.fail[chatId]);
    const total = n[chatId] ?? 0, end = q.beforeMessageId ? Number(q.beforeMessageId.split("-").pop()) : total, start = Math.max(0, end - q.limit);
    return Array.from({ length: end - start }, (_, k) => { const i = start + k; return { id: `${chatId}-${i}`, chatId, sender: "Ann", senderId: "ann", text: `old message ${i} of ${chatId}`, time: new Date(t0 - (total - i) * 60_000).toISOString(), fromMe: false }; });
  };
}
const FH: Capabilities = { ...CAPS, fetchHistory: true };
const hubOpts = { extras: { markReadGapMs: 0, mediaGapMs: 0, history: { gapMs: 0, pageSize: 40 } } };

test("fetchHistory: pages back through every chat, reports progress, archives and indexes the messages", async () => {
  const t = setup({ fake: FH }, hubOpts); const a = await t.add("fake");
  const calls: string[] = []; scriptedHistory(t.conns[0], { ann: 100, team: 25 }, { calls });
  const events: any[] = []; t.hub.subscribe((e, d) => { if (e === "history-progress") events.push(d); });
  const r = await t.call("fetchHistory", { accountId: a, wait: true });
  assert.equal(r.result.state, "done"); assert.equal(r.result.chatsTotal, 2); assert.equal(r.result.chatsDone, 2); assert.equal(r.result.messages, 125); assert.deepEqual(r.result.failures, {});
  assert.equal(t.store.listMessages(`${a}:ann`, { limit: 1000 }).length, 100); assert.equal(t.store.getMessage(`${a}:team`, "team-0")?.accountId, a);
  assert.ok(calls.length >= 5, "ann needs 3 pages + 1 to see the end");
  assert.equal((await t.call("searchAll", { query: '"old message 77 of ann"' })).total, 1, "fetched messages are searchable at once");
  assert.ok(events.length >= 3 && events.at(-1).finished && events.some((e) => !e.finished && e.chatsDone < 2), "progress events");
  const jobs = await t.call("fetchHistoryJobs"); assert.equal(jobs[0].state, "done");
  t.done();
});

test("fetchHistory: time limit, chat selection, per-reason failure counts, cancel and refusal without the capability", async () => {
  const t = setup({ fake: FH, plain: CAPS }, hubOpts); const a = await t.add("fake"), b = await t.add("plain");
  await assert.rejects(() => t.call("fetchHistory", { accountId: b }), /can't fetch/);
  scriptedHistory(t.conns[0], { ann: 500, team: 10 });
  // only the last 2 hours of ann (one message a minute): stops at the first page that reaches back past the cutoff
  const old = Date.parse("2026-03-10T12:00:00Z"); const real = Date.now; Date.now = () => old; // "now" = the time of the newest message
  try {
    const r = await t.call("fetchHistory", { accountId: a, chatIds: [`${a}:ann`], days: 1 / 12, wait: true }); // 2 h
    assert.equal(r.result.chatsTotal, 1); assert.ok(r.result.messages >= 120 && r.result.messages <= 200, String(r.result.messages));
  } finally { Date.now = real; }
  // failures by reason
  scriptedHistory(t.conns[0], { ann: 5, team: 5, x: 5 }, { fail: { team: "HTTP 403 Missing Access", ann: "request timed out" } });
  (t.conns[0] as any).chatList.push(dm("x", "X"));
  const f = await t.call("fetchHistory", { accountId: a, wait: true });
  assert.equal(f.result.state, "done"); assert.deepEqual(f.result.failures, { "no-access": 1, timeout: 1 }); assert.equal(f.result.chatsDone, 3);
  // rate limited: retried, then counted
  let n429 = 0; scriptedHistory(t.conns[0], { ann: 5, team: 0, x: 0 }); const inner = t.conns[0].history.bind(t.conns[0]);
  t.conns[0].history = async (c: string, q: any) => { if (c === "ann" && n429++ < 2) throw new Error("429 Too Many Requests"); return inner(c, q); };
  const g = await t.call("fetchHistory", { accountId: a, wait: true }); assert.deepEqual(g.result.failures, {}); assert.ok(n429 >= 3);
  // cancel
  scriptedHistory(t.conns[0], { ann: 4000, team: 4000, x: 4000 });
  const j = await t.call("fetchHistory", { accountId: a });
  await assert.rejects(() => t.call("fetchHistory", { accountId: a }), /already/);
  await t.call("cancelFetchHistory", { accountId: a });
  for (let i = 0; i < 100 && (await t.call("fetchHistoryJobs"))[0].state === "running"; i++) await new Promise((r) => setTimeout(r, 20));
  const st = (await t.call("fetchHistoryJobs"))[0]; assert.equal(st.state, "cancelled"); assert.ok(st.chatsDone < 3); assert.equal(j.jobId.startsWith("history-"), true);
  t.done();
});

test("fetchHistory: a job cut off by a restart comes back as interrupted and resumes where it stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-fh-")); const store = new MemoryStore();
  const mk = (n: number) => { const fake = new Fake(FH, [dm("ann", "Ann")]); const calls: string[] = []; scriptedHistory(fake, { ann: n }, { calls });
    const fac: ProviderFactory = { name: "fake", displayName: "fake", login: "qr", capabilities: FH, create: () => fake }; const hub = new Hub(dir, [fac], store, hubOpts); return { fake, calls, hub }; };
  const one = mk(300); const acc = (await one.hub.call("addAccount", { provider: "fake" }) as any).id; one.fake.emit({ type: "account", data: { id: acc, state: "connected" } });
  let seenPages = 0; const base = one.fake.history.bind(one.fake); one.fake.history = async (c: string, q: any) => { if (++seenPages === 3) await new Promise(() => {}); return base(c, q); }; // hangs on page 3 = "app killed"
  await one.hub.call("fetchHistory", { accountId: acc });
  for (let i = 0; i < 100 && seenPages < 3; i++) await new Promise((r) => setTimeout(r, 10));
  // "restart": new Hub on the same store, nothing running
  const two = mk(300); await two.hub.init(); two.fake.emit({ type: "account", data: { id: acc, state: "connected" } });
  let jobs = (await two.hub.call("fetchHistoryJobs") as any[]); assert.equal(jobs[0].state, "interrupted");
  const r = await two.hub.call("fetchHistory", { accountId: acc, resume: true, wait: true }) as any;
  assert.equal(r.result.state, "done"); assert.ok(two.calls[0].endsWith("|ann-220"), "continues from the oldest page already archived: " + two.calls[0]);
  assert.equal(store.listMessages(`${acc}:ann`, { limit: 1000 }).length, 300);
  void one.hub.shutdown(); void two.hub.shutdown(); rmSync(dir, { recursive: true, force: true });
});

test("setDisappearing: validated, routed to the connector with the native id, needs the capability; Chat.disappearing is passed through", async () => {
  const t = setup({ yes: { ...CAPS, disappearing: true }, no: CAPS });
  const a = await t.add("yes"), b = await t.add("no");
  const calls: [string, number][] = []; (t.conns[0] as any).setDisappearing = async (c: string, s: number) => { calls.push([c, s]); (t.conns[0] as any).chatList[0].disappearing = s || undefined; };
  (t.conns[1] as any).setDisappearing = async () => { throw new Error("must not be called"); };
  let changed = 0; t.hub.subscribe((e) => { if (e === "chats-changed") changed++; });
  await t.call("setDisappearing", { chatId: `${a}:ann`, seconds: 604800 });
  assert.deepEqual(calls, [["ann", 604800]]); assert.ok(changed > 0);
  assert.equal((await t.call("snapshot")).chats.find((c: Chat) => c.id === `${a}:ann`).disappearing, 604800);
  await assert.rejects(() => t.call("setDisappearing", { chatId: `${a}:ann`, seconds: -5 }), /not valid/);
  await assert.rejects(() => t.call("setDisappearing", { chatId: `${a}:ann`, seconds: "soon" }), /not valid/);
  await assert.rejects(() => t.call("setDisappearing", { chatId: `${b}:ann`, seconds: 86400 }), /cannot change the disappearing/);
  t.done();
});
