// Offline fixtures driving the connector's internal handlers (no network, no WhatsApp account).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreEvent } from "@unimsg/core";
import factory from "./index.js";
import { encryptVote } from "./poll.js";
import { optionId } from "./map.js";

type Priv = {
  emit: (e: CoreEvent) => void; store: import("./store.js").Store;
  applyContact(c: object): void; applyChat(c: object): void; applyGroup(g: object): void; learn(l: string, p: string): void;
  intake(w: object, live: boolean): import("@unimsg/core").Message | undefined; selfId(): string; nameOf(j: string): string;
};
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wa-test-"));
  const c = factory.create({ accountId: "t", dataDir: dir });
  const p = c as unknown as Priv;
  const events: CoreEvent[] = [];
  p.emit = (e) => events.push(e);
  return { c, p, events, done: () => { p.store.discard(); rmSync(dir, { recursive: true, force: true }); } };
}
const PN = "491701234567@s.whatsapp.net", LID = "9001@lid";
const text = (id: string, remote: string, ts: number, extra: object = {}) =>
  ({ key: { remoteJid: remote, id, fromMe: false }, messageTimestamp: ts, message: { conversation: "hi" }, ...extra });

test("names saved under a LID show up on the phone-number chat; stubs are hidden; lid chat merges", async () => {
  const { c, p, done } = setup();
  try {
    p.intake(text("m1", PN, 100), false);               // DM keyed by phone number
    p.intake(text("m2", LID, 200), false);              // same person, keyed by LID (mapping unknown yet)
    p.applyContact({ id: LID, name: "Ann", lid: LID }); // address-book name stored under the LID
    p.applyChat({ id: "stub@s.whatsapp.net", name: "Stub" });
    assert.equal((await c.chats()).find((x) => x.id === PN)?.name, "+49 170 1234567"); // not known yet
    p.learn(LID, PN);                                    // mapping arrives
    const chats = await c.chats();
    assert.equal(chats.find((x) => x.id === PN)?.name, "Ann");
    assert.equal(chats.find((x) => x.id === LID), undefined);   // merged, no duplicate
    assert.equal(chats.find((x) => x.id === "stub@s.whatsapp.net"), undefined); // address-book stub hidden
    assert.deepEqual((await c.history(PN, { limit: 10 })).map((m) => m.id), ["m1", "m2"]);
  } finally { done(); }
});

test("unmapped lid chat is named from its push name, else 'WhatsApp user'", async () => {
  const { c, p, done } = setup();
  try {
    p.intake(text("a", LID, 1), false);
    assert.equal((await c.chats())[0]?.name, "WhatsApp user");
    p.intake(text("b", LID, 2, { pushName: "Zed" }), false);
    assert.equal((await c.chats())[0]?.name, "~Zed");
  } finally { done(); }
});

test("group senders get push names from every message, both keys, and participant lids map to numbers", async () => {
  const { p, done } = setup();
  try {
    const g = "120363@g.us";
    p.applyGroup({ id: g, subject: "G", participants: [{ id: "55@lid", lid: "55@lid", jid: "4915@s.whatsapp.net" }] });
    const m = p.intake({ key: { remoteJid: g, id: "x", fromMe: false, participant: "55@lid" }, messageTimestamp: 5, pushName: "Kim", message: { conversation: "yo" } }, false);
    assert.equal(m?.senderId, "4915@s.whatsapp.net");
    assert.equal(m?.sender, "~Kim");
    assert.equal(p.nameOf("55@lid"), "~Kim");
    assert.equal(p.nameOf("4915@s.whatsapp.net"), "~Kim");
  } finally { done(); }
});

test("empty-subject groups never show an empty name; member groups are visible while empty", async () => {
  const { c, p, done } = setup();
  try {
    p.applyGroup({ id: "1@g.us", subject: "", participants: [{ id: "4915@s.whatsapp.net", jid: "4915@s.whatsapp.net" }] });
    const chats = await c.chats();
    assert.equal(chats.length, 1);
    assert.notEqual(chats[0]!.name, "");
  } finally { done(); }
});

test("poll: creation, encrypted vote from another member, patch emitted, mine tracked", async () => {
  const { p, events, done } = setup();
  try {
    const g = "120363@g.us", secret = new Uint8Array(32).fill(3);
    const create = {
      key: { remoteJid: g, id: "POLL1", fromMe: false, participant: "4915@s.whatsapp.net" }, messageTimestamp: 10,
      message: { messageContextInfo: { messageSecret: secret }, pollCreationMessage: { name: "Lunch?", selectableOptionsCount: 1, options: [{ optionName: "Pizza" }, { optionName: "Sushi" }] } },
    };
    const m = p.intake(create, false);
    assert.equal(m?.poll?.question, "Lunch?");
    assert.deepEqual(m?.poll?.options.map((o) => o.id), [optionId("Pizza"), optionId("Sushi")]);
    const enc = encryptVote(secret, "POLL1", "4915@s.whatsapp.net", "4916@s.whatsapp.net", [optionId("Sushi")]);
    p.intake({
      key: { remoteJid: g, id: "V1", fromMe: false, participant: "4916@s.whatsapp.net" }, messageTimestamp: 11,
      message: { pollUpdateMessage: { pollCreationMessageKey: create.key, vote: enc, senderTimestampMs: 11_000 } },
    }, true);
    const upd = events.filter((e) => e.type === "message-update").at(-1);
    assert.ok(upd && upd.type === "message-update");
    assert.deepEqual(upd.data.patch.poll?.options[1]!.voters, ["4916@s.whatsapp.net"]);
    assert.equal(events.some((e) => e.type === "message" && e.data.id === "V1"), false); // votes are not messages
  } finally { done(); }
});

test("better names patch earlier messages' sender", () => {
  const { p, events, done } = setup();
  try {
    const g = "120363@g.us", who = "4915@s.whatsapp.net";
    const m = p.intake({ key: { remoteJid: g, id: "s1", fromMe: false, participant: who }, messageTimestamp: 5, message: { conversation: "yo" } }, false);
    assert.equal(m?.sender, "+4915"); // number fallback, not a raw jid
    p.applyContact({ id: who, name: "Lena" });
    (p as unknown as { refreshSenderNames(): void }).refreshSenderNames();
    const u = events.filter((e) => e.type === "message-update").at(-1);
    assert.ok(u && u.type === "message-update");
    assert.equal(u.data.messageId, "s1");
    assert.equal(u.data.patch.sender, "Lena");
  } finally { done(); }
});

// ---- logout: remote device removal must be confirmed, local state wiped either way
type LoggingOut = Priv & {
  sock?: unknown; opened: boolean; auth?: unknown; stopped: boolean;
  logoutWaitMs: number; logoutQueryMs: number; logoutSettleMs: number; reconnectTimer?: unknown;
};
function logoutSetup(query: (node: any, ms?: number) => Promise<any>, opened = true) {
  const t = setup();
  const p = t.p as unknown as LoggingOut;
  const ended: number[] = [];
  p.auth = { creds: { me: { id: "491700000000:3@s.whatsapp.net" } } };
  p.sock = { query, end: () => { ended.push(Date.now()); } };
  p.opened = opened;
  p.logoutWaitMs = 300; p.logoutQueryMs = 200; p.logoutSettleMs = 10;
  return { ...t, p, ended };
}

test("logout sends remove-companion-device, awaits the ack, then closes and wipes", async () => {
  const nodes: any[] = [];
  const { c, p, ended, events, done } = logoutSetup(async (node, ms) => { nodes.push([node, ms]); await new Promise((r) => setTimeout(r, 20)); return { tag: "iq", attrs: { type: "result" } }; });
  try {
    p.store.data.contacts["x@s.whatsapp.net"] = "X"; p.store.touch();
    await c.logout();
    const [node, ms] = nodes[0];
    assert.equal(node.tag, "iq");
    assert.equal(node.attrs.to, "@s.whatsapp.net");
    assert.equal(node.attrs.type, "set");
    assert.equal(node.attrs.xmlns, "md");
    assert.deepEqual(node.content[0], { tag: "remove-companion-device", attrs: { jid: "491700000000:3@s.whatsapp.net", reason: "user_initiated" } });
    assert.equal(ms, 200);
    assert.equal(ended.length, 1);
    assert.deepEqual(p.store.data.contacts, {});
    assert.equal(p.stopped, true);
    assert.equal(events.some((e) => e.type === "account" && e.data.state === "needs-login"), true);
  } finally { done(); }
});

test("logout wipes locally and then throws when the server never answers", async () => {
  const { c, p, ended, done } = logoutSetup(() => new Promise(() => {}));
  try {
    p.store.data.contacts["x@s.whatsapp.net"] = "X";
    await assert.rejects(c.logout(), /Remove it manually on your phone/);
    assert.deepEqual(p.store.data.contacts, {});
    assert.equal(ended.length, 1);
    assert.equal(p.stopped, true);
  } finally { done(); }
});

test("logout treats an error reply as unconfirmed", async () => {
  const { c, p, done } = logoutSetup(async () => { throw Object.assign(new Error("forbidden"), { data: 403 }); });
  try {
    await assert.rejects(c.logout(), /Couldn't reach WhatsApp/);
    assert.equal(p.stopped, true);
  } finally { done(); }
});

test("logout waits for a reconnecting socket to open before sending", async () => {
  let sent = 0;
  const { c, p, done } = logoutSetup(async () => { sent++; return { tag: "iq", attrs: { type: "result" } }; }, false);
  try {
    setTimeout(() => { p.opened = true; }, 80);
    await c.logout();
    assert.equal(sent, 1);
  } finally { done(); }
});

test("logout without a connection fails after the wait, but still wipes", async () => {
  const { c, p, done } = logoutSetup(async () => ({ tag: "iq", attrs: { type: "result" } }), false);
  try {
    p.reconnectTimer = setTimeout(() => {}, 1000); // a reconnect is pending, so no fresh socket is created
    p.store.data.contacts["x@s.whatsapp.net"] = "X";
    await assert.rejects(c.logout(), /Linked devices/);
    assert.deepEqual(p.store.data.contacts, {});
  } finally { done(); }
});

test("stub messages become info notices and do not count as unread", async () => {
  const { c, p, done } = setup();
  try {
    const g = "120363@g.us";
    p.applyGroup({ id: g, subject: "G", participants: [] });
    p.store.data.push["4915@s.whatsapp.net"] = "Anna";
    p.store.data.push["4916@s.whatsapp.net"] = "Ben";
    const m = p.intake({
      key: { remoteJid: g, id: "st1", fromMe: false, participant: "4915@s.whatsapp.net" }, messageTimestamp: 7,
      messageStubType: 27, messageStubParameters: ['{"id":"4916@s.whatsapp.net"}'],
    }, true);
    assert.equal(m?.text, "~Anna added ~Ben");
    assert.deepEqual(m?.system, { kind: "info" });
    assert.equal((await c.chats())[0]?.unread, undefined);
    const call = p.intake({ key: { remoteJid: g, id: "st2", fromMe: false }, messageTimestamp: 8, messageStubType: 40, messageStubParameters: [] }, false);
    assert.equal(call?.card?.kind, "call");
    assert.equal(p.intake({ key: { remoteJid: g, id: "st3", fromMe: false }, messageTimestamp: 9, messageStubType: 39 }, false), undefined);
  } finally { done(); }
});

test("a re-delivered message replaces an old placeholder text, but never an edited message", () => {
  const { p, events, done } = setup();
  try {
    const g = "120363@g.us";
    const key = { remoteJid: g, id: "old1", fromMe: false, participant: "4915@s.whatsapp.net" };
    p.intake({ key, messageTimestamp: 5, message: { conversation: "placeholder" } }, false);
    const stored = p.store.find(g, "old1")!;
    stored.m.text = "[unsupported message]"; // as stored by an older version
    const m = p.intake({ key, messageTimestamp: 5, message: { eventMessage: { name: "Board", startTime: 1_741_113_000 } } }, false);
    assert.equal(m?.card?.kind, "event");
    assert.equal(p.store.find(g, "old1")!.m.card?.title, "Board");
    assert.equal(events.filter((e) => e.type === "message" && e.data.id === "old1").length, 2);
    // an edited message is left alone
    const key2 = { ...key, id: "old2" };
    p.intake({ key: key2, messageTimestamp: 6, message: { conversation: "x" } }, false);
    const s2 = p.store.find(g, "old2")!; s2.m.text = "[unsupported message]"; s2.m.editedAt = "2025-01-01T00:00:00.000Z";
    assert.equal(p.intake({ key: key2, messageTimestamp: 6, message: { eventMessage: { name: "B" } } }, false), undefined);
  } finally { done(); }
});

// ---- name sources for people who are not in the address book
import { deflateSync } from "node:zlib";
import { proto } from "@whiskeysockets/baileys";
import { buildVcard, parseVcard } from "./content.js";

test("push name sources: PUSH_NAME contacts, contacts.update notify, message pushName, verifiedBizName, chat name", () => {
  const { p, done } = setup();
  try {
    const a = "4911@s.whatsapp.net", b = "4922@s.whatsapp.net", c2 = "4933@s.whatsapp.net", d = "4944@s.whatsapp.net";
    p.applyContact({ id: a, notify: "Push A" });                       // history PUSH_NAME chunk / contacts.update
    p.intake({ key: { remoteJid: "9@g.us", id: "n1", fromMe: false, participant: b }, messageTimestamp: 1, pushName: "Push B", message: { conversation: "x" } }, false);
    p.intake({ key: { remoteJid: c2, id: "n2", fromMe: false }, messageTimestamp: 2, verifiedBizName: "Biz C", message: { conversation: "x" } }, false);
    p.applyChat({ id: d, name: "Chat D" });                            // chats.upsert conversation name for a DM
    assert.equal(p.nameOf(a), "~Push A");
    assert.equal(p.nameOf(b), "~Push B");
    assert.equal(p.nameOf(c2), "Biz C");
    assert.equal(p.nameOf(d), "Chat D");
  } finally { done(); }
});

test("a LID participant with a phone-number alt on the key is mapped, and a later pushName patches earlier messages", () => {
  const { p, events, done } = setup();
  try {
    const g = "120363@g.us", lid = "7001@lid", pn = "4977@s.whatsapp.net";
    const m1 = p.intake({ key: { remoteJid: g, id: "e1", fromMe: false, participant: lid, participantPn: pn }, messageTimestamp: 1, message: { conversation: "first" } }, false);
    assert.equal(m1?.senderId, pn);                                    // both ids recorded and mapped
    assert.equal(p.store.data.lidToPn[lid], pn);
    // second sender seen only as LID (no mapping, no name)
    const lid2 = "7002@lid";
    const m2 = p.intake({ key: { remoteJid: g, id: "e2", fromMe: false, participant: lid2 }, messageTimestamp: 2, message: { conversation: "hi" } }, false);
    assert.equal(m2?.sender, "WhatsApp user");
    // they finally speak live with a push name and a key that reveals the number
    events.length = 0;
    p.intake({ key: { remoteJid: g, id: "e3", fromMe: false, participant: lid2, participantPn: "4988@s.whatsapp.net" }, messageTimestamp: 3, pushName: "Late Larry", message: { conversation: "yo" } }, true);
    (p as unknown as { refreshSenderNames(): void }).refreshSenderNames();
    const patched = events.filter((e) => e.type === "message-update").map((e) => (e.type === "message-update" ? [e.data.messageId, e.data.patch.sender] : []));
    assert.deepEqual(patched, [["e2", "~Late Larry"]]);
    assert.equal(p.store.find(g, "e2")?.m.sender, "~Late Larry");
  } finally { done(); }
});

test("an inline history payload is decoded and stored (Baileys itself cannot read it)", async () => {
  const { p, events, done } = setup();
  try {
    const hist = proto.HistorySync.create({
      syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
      conversations: [{ id: "4955@s.whatsapp.net", name: "Inline Ina", messages: [{ message: { key: { remoteJid: "4955@s.whatsapp.net", id: "h1", fromMe: false }, messageTimestamp: 50, message: { conversation: "from history" } } }] }],
    });
    const payload = deflateSync(Buffer.from(proto.HistorySync.encode(hist).finish()));
    (p as unknown as { sock: unknown }).sock = {};
    (p as unknown as { onHistoryNotification(w: object): void }).onHistoryNotification({
      key: { id: "N1" },
      message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION, historySyncNotification: { syncType: proto.Message.HistorySyncNotification.HistorySyncType.INITIAL_BOOTSTRAP, initialHistBootstrapInlinePayload: payload } } },
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(p.store.find("4955@s.whatsapp.net", "h1")?.m.text, "from history");
    assert.equal(p.nameOf("4955@s.whatsapp.net"), "Inline Ina");
    assert.equal(events.some((e) => e.type === "message" && e.data.id === "h1"), true);
  } finally { done(); }
});

test("revoke stubs become deleted messages; undecryptable stubs keep a placeholder", () => {
  const { p, events, done } = setup();
  try {
    const c = "4966@s.whatsapp.net";
    const rv = p.intake({ key: { remoteJid: c, id: "r1", fromMe: false }, messageTimestamp: 5, messageStubType: proto.WebMessageInfo.StubType.REVOKE }, false);
    assert.equal(rv?.deleted, true); assert.equal(rv?.text, "");
    // live message that is later seen again as a revoke stub is marked deleted
    p.intake({ key: { remoteJid: c, id: "r2", fromMe: false }, messageTimestamp: 6, message: { conversation: "secret" } }, false);
    events.length = 0;
    p.intake({ key: { remoteJid: c, id: "r2", fromMe: false }, messageTimestamp: 6, messageStubType: proto.WebMessageInfo.StubType.REVOKE }, false);
    assert.equal(p.store.find(c, "r2")?.m.deleted, true);
    assert.equal(events.some((e) => e.type === "message-update" && e.data.patch.deleted === true), true);
    const ph = p.intake({ key: { remoteJid: c, id: "r3", fromMe: false }, messageTimestamp: 7, messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT }, true);
    assert.match(ph?.text ?? "", /^Waiting for this message\./);
    assert.equal(ph?.card?.kind, "other");
    // the retried message (same id) replaces the placeholder, flagged as a re-delivery
    events.length = 0;
    p.intake({ key: { remoteJid: c, id: "r3", fromMe: false }, messageTimestamp: 7, message: { conversation: "decrypted now" } }, true);
    assert.equal(p.store.find(c, "r3")?.m.text, "decrypted now");
    const re = events.find((e) => e.type === "message" && e.data.id === "r3");
    assert.ok(re && re.type === "message" && re.data.historical === true && re.data.text === "decrypted now");
  } finally { done(); }
});

test("sending contact cards and locations builds the right Baileys content", async () => {
  const { c, p, done } = setup();
  try {
    const sent: any[] = [];
    (p as unknown as { sock: unknown; opened: boolean }).opened = true;
    (p as unknown as { sock: unknown }).sock = {
      sendMessage: async (jid: string, content: any) => {
        sent.push(content);
        const message = content.location ? { locationMessage: content.location } : { contactMessage: content.contacts.contacts[0] };
        return { key: { remoteJid: jid, id: `S${sent.length}`, fromMe: true }, messageTimestamp: 9, message, status: 1 };
      },
    };
    const chat = "4999@s.whatsapp.net";
    const loc = await c.send(chat, { text: "", location: { lat: 52.5, lng: 13.4, name: "Office", address: "Street 1" } });
    assert.deepEqual(sent[0], { location: { degreesLatitude: 52.5, degreesLongitude: 13.4, name: "Office", address: "Street 1" } });
    assert.deepEqual(loc.location, { lat: 52.5, lng: 13.4, name: "Office", address: "Street 1" });
    const card = await c.send(chat, { text: "", contacts: [{ name: "Ann Lee", phones: ["+49 170 1234567"], emails: ["ann@example.org"] }] });
    assert.equal(sent[1].contacts.contacts[0].displayName, "Ann Lee");
    assert.match(sent[1].contacts.contacts[0].vcard, /^BEGIN:VCARD\nVERSION:3\.0\nN:;Ann Lee;;;\nFN:Ann Lee\nTEL;type=CELL;waid=491701234567:\+49 170 1234567\nEMAIL:ann@example\.org\nEND:VCARD$/);
    assert.equal(card.contacts?.[0]?.name, "Ann Lee");
    await assert.rejects(c.send(chat, { text: "", location: { lat: 200, lng: 0 } }), /invalid location/);
    assert.equal(c.capabilities.location && c.capabilities.contactCards, true);
    assert.deepEqual(parseVcard(buildVcard({ name: "A,B;C", phones: ["12"], handle: "+4915123456789" })).handle, "+4915123456789");
  } finally { done(); }
});

test("historical flag: set for history, append and re-deliveries, never for live notify or own sends", () => {
  const { p, events, done } = setup();
  try {
    const c = "4970@s.whatsapp.net";
    const flag = (id: string) => { const e = events.find((x) => x.type === "message" && x.data.id === id); return e && e.type === "message" ? e.data.historical : "none"; };
    p.intake({ key: { remoteJid: c, id: "live", fromMe: false }, messageTimestamp: 1, message: { conversation: "a" } }, true);
    p.intake({ key: { remoteJid: c, id: "appended", fromMe: false }, messageTimestamp: 2, message: { conversation: "b" } }, false);
    (p as unknown as { applyHistory(h: object): void }).applyHistory({ chats: [], contacts: [], messages: [{ key: { remoteJid: c, id: "hist", fromMe: false }, messageTimestamp: 3, message: { conversation: "c" } }], syncType: 3 });
    assert.equal(flag("live"), undefined);
    assert.equal(flag("appended"), true);
    assert.equal(flag("hist"), true);
    assert.equal(p.store.find(c, "hist")?.m.historical, undefined); // stored copy stays unflagged
  } finally { done(); }
});

test("unread gap: a chat that lists unread messages we do not hold triggers one newest-first backfill", async () => {
  const { c, p, done } = setup();
  try {
    const chat = "4971@s.whatsapp.net";
    const asked: any[] = [];
    (p as unknown as { opened: boolean }).opened = true;
    (p as unknown as { sock: unknown }).sock = {
      presenceSubscribe: async () => {},
      fetchMessageHistory: async (count: number, key: any, ts: number) => { asked.push([count, key, ts]); return "sid" + asked.length; },
    };
    (p as unknown as { historySeen: Set<string> }).historySeen.add("sid1"); // phone answers immediately
    (p as unknown as { noMoreHistory: Set<string> }).noMoreHistory.add(chat); // isolate the unread backfill from older-page fetches
    p.applyChat({ id: chat, unreadCount: 2, conversationTimestamp: 1000 });
    p.intake({ key: { remoteJid: chat, id: "old", fromMe: false }, messageTimestamp: 100, message: { conversation: "old" } }, false);
    await c.history(chat, { limit: 50 });
    await c.history(chat, { limit: 50 });  // second open: already tried this session
    assert.equal(asked.length, 1);
    assert.equal(asked[0][0] <= 50 && asked[0][0] >= 2, true);
    assert.equal(asked[0][2] > 1000 * 1000, true); // anchored just after the chat's newest activity
  } finally { done(); }
});

// ================= polls: own votes, missing secrets =================
import { tryDecryptVote } from "./poll.js";
import { encryptEventEdit, tryDecryptEventEdit } from "./eventcrypto.js";
type Wired = Priv & { auth: unknown; sock: unknown; opened: boolean; wire(s: unknown): void };
const ME_PN = "491700000000@s.whatsapp.net", ME_LID = "9000@lid";
function withMe() {
  const t = setup();
  const p = t.p as unknown as Wired;
  p.auth = { creds: { me: { id: "491700000000:3@s.whatsapp.net", lid: "9000:3@lid" } } };
  return { ...t, p };
}
const G = "120363@g.us", CREATOR = "4915@s.whatsapp.net";
const pollMsg = (secret?: Uint8Array, extra: object = {}) => ({
  key: { remoteJid: G, id: "POLL", fromMe: false, participant: CREATOR }, messageTimestamp: 10, ...extra,
  message: { ...(secret ? { messageContextInfo: { messageSecret: secret } } : {}), pollCreationMessage: { name: "Lunch?", selectableOptionsCount: 1, options: [{ optionName: "Pizza" }, { optionName: "Sushi" }] } },
});

test("own vote cast on my phone (LID form) is decrypted and counted with my id", () => {
  const { p, events, done } = withMe();
  try {
    const secret = new Uint8Array(32).fill(5);
    p.intake(pollMsg(secret), false);
    events.length = 0;
    const enc = encryptVote(secret, "POLL", CREATOR, ME_LID, [optionId("Pizza")]);
    p.intake({ key: { remoteJid: G, id: "MYV", fromMe: true, participant: "9000:3@lid" }, messageTimestamp: 11, message: { pollUpdateMessage: { pollCreationMessageKey: { remoteJid: G, id: "POLL", fromMe: false, participant: CREATOR }, vote: enc, senderTimestampMs: 11_000 } } }, false);
    const u = events.filter((e) => e.type === "message-update").at(-1);
    assert.ok(u && u.type === "message-update");
    assert.deepEqual(u.data.patch.poll?.mine, [optionId("Pizza")]);
    assert.deepEqual(u.data.patch.poll?.options[0]!.voters, [p.selfId()]);
  } finally { done(); }
});

test("voting from UniChat updates the tally at once and sends a vote others can decrypt", async () => {
  const { c, p, events, done } = withMe();
  try {
    const secret = new Uint8Array(32).fill(6);
    p.intake(pollMsg(secret), false);
    const relayed: any[] = [];
    p.opened = true;
    p.sock = { relayMessage: async (jid: string, msg: any, opts: any) => { relayed.push([jid, msg, opts]); return "x"; } };
    events.length = 0;
    await c.vote!(G, "POLL", [optionId("Sushi")]);
    const u = events.filter((e) => e.type === "message-update").at(-1);
    assert.ok(u && u.type === "message-update");
    assert.deepEqual(u.data.patch.poll?.mine, [optionId("Sushi")]);
    assert.deepEqual(u.data.patch.poll?.options[1]!.voters, [p.selfId()]);
    const enc = relayed[0][1].pollUpdateMessage.vote;
    assert.deepEqual(tryDecryptVote(enc, secret, "POLL", [CREATOR], [ME_PN]), [optionId("Sushi")]);
    assert.deepEqual(relayed[0][2].additionalNodes, [{ tag: "meta", attrs: { polltype: "vote", content_type: "add_on" } }]);
    await c.vote!(G, "POLL", [optionId("Pizza")]); // changing the vote works too
    assert.deepEqual(p.store.find(G, "POLL")?.m.poll?.mine, [optionId("Pizza")]);
  } finally { done(); }
});

test("history polls: secret from WebMessageInfo and already-decrypted pollUpdates (incl. my own vote) are used", () => {
  const { p, done } = withMe();
  try {
    const w = pollMsg(undefined, {
      messageSecret: new Uint8Array(32).fill(8),
      pollUpdates: [
        { pollUpdateMessageKey: { remoteJid: G, id: "v1", fromMe: true }, vote: { selectedOptions: [Buffer.from(optionId("Pizza"), "hex")] }, senderTimestampMs: 1000 },
        { pollUpdateMessageKey: { remoteJid: G, id: "v2", fromMe: false, participant: "4916@s.whatsapp.net" }, vote: { selectedOptions: [Buffer.from(optionId("Sushi"), "hex")] }, senderTimestampMs: 1001 },
      ],
    });
    const m = p.intake(w, false);
    assert.equal(m?.poll?.closed, undefined);
    assert.deepEqual(m?.poll?.mine, [optionId("Pizza")]);
    assert.deepEqual(m?.poll?.options.map((o) => o.voters.length), [1, 1]);
    assert.ok(p.store.find(G, "POLL")?.poll?.secret);
  } finally { done(); }
});

test("poll without a secret is read-only; recovery via the phone works, otherwise a clear error", async () => {
  const { c, p, events, done } = withMe();
  try {
    const m = p.intake(pollMsg(undefined), false);
    assert.equal(m?.poll?.closed, true);
    p.opened = true;
    // phone does not answer
    p.sock = { requestPlaceholderResend: async () => "id", relayMessage: async () => "x" };
    (p as unknown as { secretWaiters: Map<string, () => void> }).secretWaiters = new Map();
    const slow = c.vote!(G, "POLL", [optionId("Pizza")]);
    await assert.rejects(Promise.race([slow, new Promise((_, r) => setTimeout(() => r(new Error("test-timeout")), 9500))]), /encryption key|test-timeout/);
  } finally { done(); }
});

test("poll secret learned from a resent message makes it votable again", async () => {
  const { c, p, events, done } = withMe();
  try {
    p.intake(pollMsg(undefined), false);
    p.opened = true;
    const sent: any[] = [];
    p.sock = {
      requestPlaceholderResend: async () => { setTimeout(() => p.intake(pollMsg(new Uint8Array(32).fill(4)), false), 20); return "id"; },
      relayMessage: async (...a: any[]) => { sent.push(a); return "x"; },
    };
    await c.vote!(G, "POLL", [optionId("Pizza")]);
    assert.equal(sent.length, 1);
    assert.equal(p.store.find(G, "POLL")?.m.poll?.closed, undefined);
    assert.equal(events.some((e) => e.type === "message-update" && e.data.patch.poll?.closed === undefined), true);
  } finally { done(); }
});

// ================= notices with me =================
test("group notices recognise me under any id form and never print raw ids", () => {
  const { p, done } = withMe();
  try {
    p.store.data.push["4916@s.whatsapp.net"] = "Ben";
    p.store.data.push["4915@s.whatsapp.net"] = "Anna";
    p.store.data.lidToPn["7777@lid"] = "4916@s.whatsapp.net";
    const note = (stubType: number, params: string[], participant?: string, fromMe = false) =>
      p.intake({ key: { remoteJid: G, id: `n${Math.random()}`, fromMe, participant }, messageTimestamp: 5, messageStubType: stubType, messageStubParameters: params }, false)?.text;
    assert.equal(note(27, [JSON.stringify({ id: "7777@lid", phone_number: "4916@s.whatsapp.net" })], "9000:3@lid", false), "You added ~Ben");
    assert.equal(note(27, [JSON.stringify({ id: "9000:3@lid", phone_number: "491700000000:3@s.whatsapp.net" })], "4915@s.whatsapp.net"), "~Anna added you");
    assert.equal(note(27, [JSON.stringify({ id: "9000@lid" })]), "You were added");
    assert.equal(note(28, ["4916@s.whatsapp.net"], "491700000000:5@s.whatsapp.net"), "You removed ~Ben");
    assert.equal(note(32, ["7777@lid"]), "~Ben left");
    assert.equal(note(31, ["491700000000:3@s.whatsapp.net"]), "You joined using an invite link");
    assert.equal(note(27, ["4916@s.whatsapp.net", "4915@s.whatsapp.net", "491700000000@s.whatsapp.net"], "9000@lid"), "You added ~Ben, ~Anna and you");
  } finally { done(); }
});

// ================= avatars =================
test("community cover falls back to the announcement group's picture; contacts try both ids", async () => {
  const { c, p, done } = setup();
  const realFetch = globalThis.fetch;
  try {
    const parent = "120000@g.us", ann = "120001@g.us";
    p.applyGroup({ id: parent, subject: "Community", isCommunity: true, participants: [] });
    p.applyGroup({ id: ann, subject: "Announcements", isCommunityAnnounce: true, linkedParent: parent, participants: [] });
    const asked: string[] = [];
    (p as unknown as { opened: boolean }).opened = true;
    (p as unknown as { sock: unknown }).sock = {
      profilePictureUrl: async (jid: string, type: string) => {
        asked.push(`${jid}:${type}`);
        if (jid === parent) throw Object.assign(new Error("item-not-found"), { data: 404 });
        if (jid === ann && type === "preview") return "https://cdn.example/ann.jpg";
        if (jid === "4915@s.whatsapp.net") return "https://cdn.example/c.jpg";
        return undefined;
      },
    };
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } })) as typeof fetch;
    const cover = await c.avatar!({ kind: "space", id: parent });
    assert.deepEqual(Array.from(cover!.data), [1, 2, 3]);
    assert.deepEqual(asked, [`${parent}:preview`, `${parent}:image`, `${ann}:preview`]);
    // contact known only by LID: the mapped phone number is used
    p.store.data.lidToPn["5555@lid"] = "4915@s.whatsapp.net";
    const pic = await c.avatar!({ kind: "contact", id: "5555@lid" });
    assert.equal(pic?.mime, "image/jpeg");
    assert.equal(asked.includes("4915@s.whatsapp.net:preview"), true);
    // rate limit is never cached as "no picture"
    (p as unknown as { sock: unknown }).sock = { profilePictureUrl: async () => { throw Object.assign(new Error("rate-overlimit"), { data: 429 }); } };
    assert.equal(await c.avatar!({ kind: "chat", id: "4999@s.whatsapp.net" }), undefined);
    assert.equal((p as unknown as { avatars: { get(j: string): { state: string } } }).avatars.get("4999@s.whatsapp.net").state, "miss");
  } finally { globalThis.fetch = realFetch; done(); }
});

// ================= live locations =================
test("live location updates arrive as same-id messages and as messages.update; stale shares end", () => {
  const { p, events, done } = setup();
  try {
    const c = "4930@s.whatsapp.net";
    const live = (lat: number, seq: number, ts: number) => ({ key: { remoteJid: c, id: "LOC", fromMe: false }, messageTimestamp: ts, message: { liveLocationMessage: { degreesLatitude: lat, degreesLongitude: 13, sequenceNumber: seq } } });
    const m = p.intake(live(52, 1, 1000), true);
    assert.equal(m?.location?.live, true); assert.equal(m?.location?.updatedAt, new Date(1000 * 1000).toISOString());
    events.length = 0;
    p.intake(live(52.1, 2, 1060), true);
    const u = events.find((e) => e.type === "message-update");
    assert.ok(u && u.type === "message-update");
    assert.equal(u.data.patch.location?.lat, 52.1);
    assert.equal(p.store.find(c, "LOC")?.m.location?.lat, 52.1);
    p.intake(live(50, 1, 1070), true); // older sequence number is ignored
    assert.equal(p.store.find(c, "LOC")?.m.location?.lat, 52.1);
    // share ends: no update for > 30 min
    events.length = 0;
    (p as unknown as { sweepLiveLocations(now: number): void }).sweepLiveLocations(1060 * 1000 + 31 * 60_000);
    assert.equal(p.store.find(c, "LOC")?.m.location?.live, false);
    assert.equal(events.some((e) => e.type === "message-update" && e.data.patch.location?.live === false), true);
  } finally { done(); }
});

// ================= events =================
test("events: create, receive edits, edit my own; others' events cannot be edited", async () => {
  const { c, p, events, done } = withMe();
  try {
    const relayed: any[] = [];
    p.opened = true;
    p.sock = { relayMessage: async (jid: string, msg: any, opts: any) => { relayed.push([jid, msg, opts]); return "x"; } };
    const m = await c.send(G, { text: "", event: { name: "Board", description: "Agenda", start: "2025-03-04T18:30:00Z", end: "2025-03-04T19:30:00Z", place: "HQ" } });
    const [, msg, opts] = relayed[0];
    assert.equal(msg.eventMessage.name, "Board"); assert.equal(msg.eventMessage.startTime, 1_741_113_000); assert.equal(msg.eventMessage.location.name, "HQ");
    assert.equal(msg.messageContextInfo.messageSecret.length, 32);
    assert.deepEqual(opts.additionalAttributes, { type: "event" });
    assert.deepEqual(opts.additionalNodes, [{ tag: "meta", attrs: { event_type: "creation" } }]);
    assert.equal(m.card?.kind, "event"); assert.equal(m.card?.editable, true); assert.equal(m.card?.place, "HQ");
    // edit my event
    events.length = 0;
    await c.editEvent!(G, m.id, { name: "Board (moved)", start: "2025-03-05T10:00:00Z", canceled: false });
    const sem = relayed[1][1].secretEncryptedMessage;
    assert.equal(sem.secretEncType, 1); assert.equal(sem.targetMessageKey.id, m.id);
    const secret = Buffer.from(p.store.find(G, m.id)!.event!.secret, "base64");
    const dec = tryDecryptEventEdit(sem, secret, m.id, [ME_PN], [ME_PN]);
    assert.equal(dec?.eventMessage?.name, "Board (moved)");
    const upd = events.find((e) => e.type === "message-update");
    assert.ok(upd && upd.type === "message-update" && upd.data.patch.card?.title === "Board (moved)" && upd.data.patch.card.editable === true);
    // cancel
    await c.editEvent!(G, m.id, { canceled: true });
    assert.equal(p.store.find(G, m.id)?.m.card?.canceled, true);
    assert.equal(p.store.find(G, m.id)?.m.card?.editable, undefined);
    // an event from someone else: receive an encrypted edit from the creator
    const osecret = new Uint8Array(32).fill(2);
    p.intake({ key: { remoteJid: G, id: "OEV", fromMe: false, participant: CREATOR }, messageTimestamp: 20, message: { messageContextInfo: { messageSecret: osecret }, eventMessage: { name: "Party", startTime: 1_741_113_000 } } }, false);
    assert.equal(p.store.find(G, "OEV")?.m.card?.editable, undefined);
    const enc = encryptEventEdit(osecret, "OEV", CREATOR, CREATOR, { name: "Party!", startTime: 1_741_113_000, isCanceled: true });
    events.length = 0;
    p.intake({ key: { remoteJid: G, id: "ED1", fromMe: false, participant: CREATOR }, messageTimestamp: 21, message: { secretEncryptedMessage: { targetMessageKey: { remoteJid: G, id: "OEV", fromMe: false, participant: CREATOR }, encPayload: enc.encPayload, encIv: enc.encIv, secretEncType: 1 } } }, true);
    const ou = events.find((e) => e.type === "message-update");
    assert.ok(ou && ou.type === "message-update");
    assert.equal(ou.data.patch.card?.title, "Party!"); assert.equal(ou.data.patch.card?.canceled, true);
    await assert.rejects(c.editEvent!(G, "OEV", { name: "x" }), /Only events you created/);
    await assert.rejects(c.send(G, { text: "", event: { name: "", start: "x" } }), /needs a name/);
  } finally { done(); }
});

// ================= reactions on deleted messages =================
test("no reactions on deleted messages: react() rejects and incoming reactions are ignored", async () => {
  const { c, p, events, done } = withMe();
  try {
    const ch = "4930@s.whatsapp.net";
    p.intake({ key: { remoteJid: ch, id: "D1", fromMe: false }, messageTimestamp: 1, message: { conversation: "x" } }, false);
    p.intake({ key: { remoteJid: ch, id: "D1", fromMe: false }, messageTimestamp: 1, messageStubType: proto.WebMessageInfo.StubType.REVOKE }, false);
    assert.equal(p.store.find(ch, "D1")?.m.deleted, true);
    p.opened = true;
    const handlers: Record<string, (a: any) => void> = {};
    p.sock = { ev: { on: (n: string, h: (a: any) => void) => { handlers[n] = h; } }, sendMessage: async () => { throw new Error("must not send"); } };
    await assert.rejects(c.react!(ch, "D1", "👍"), /deleted for everyone/);
    p.wire(p.sock);
    events.length = 0;
    handlers["messages.reaction"]!([{ key: { remoteJid: ch, id: "D1", fromMe: false }, reaction: { key: { remoteJid: ch, fromMe: false }, text: "👍" } }]);
    assert.equal(events.some((e) => e.type === "message-update"), false);
    assert.equal(p.store.find(ch, "D1")?.m.reactions, undefined);
  } finally { done(); }
});

// ================= placeholder resend =================
const WAIT_RE = /^Waiting for this message\. Your phone is being asked to send it again\./;
function resendSetup() {
  const t = withMe();
  const p = t.p as unknown as Wired & { resend: { size(): number; has(id: string): boolean; list(c?: string): any[] } ; initResend(): void; refreshChat(c: string): Promise<string>; stopped: boolean };
  const asked: any[] = [];
  p.initResend();
  p.opened = true; p.stopped = false;
  const handlers: Record<string, (a: any) => void> = {};
  p.sock = {
    ev: { on: (n: string, h: (a: any) => void) => { handlers[n] = h; } },
    requestPlaceholderResend: async (key: any) => { asked.push(key); return "id"; },
    fetchMessageHistory: async () => "sid",
  };
  p.wire(p.sock);
  return { ...t, p, asked, handlers };
}
const cipher = (chat: string, id: string, part?: string) => ({ key: { remoteJid: chat, id, fromMe: false, ...(part ? { participant: part } : {}) }, messageTimestamp: 30, messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT });

test("each undecryptable message gets a placeholder and exactly one resend request", async () => {
  const { p, asked, done } = resendSetup();
  try {
    p.intake(cipher(G, "u1", CREATOR), true);
    p.intake(cipher(G, "u2", CREATOR), true);
    p.intake(cipher(G, "u1", CREATOR), true); // duplicate delivery
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(p.resend.size(), 2);
    assert.match(p.store.find(G, "u1")!.m.text, WAIT_RE);
    assert.deepEqual(asked.map((k) => [k.id, k.remoteJid, k.participant, k.fromMe]), [["u1", G, CREATOR, false]]); // second starts 1.5s later (rate limit)
    assert.ok(p.store.data.pending["u1"] && p.store.data.pending["u2"]); // persisted in the cache
  } finally { done(); }
});

test("the phone's resend answer (messages.upsert with requestId) replaces the placeholder, flagged historical, and clears the queue", async () => {
  const { p, events, handlers, done } = resendSetup();
  try {
    p.intake(cipher(G, "u1", CREATOR), true);
    const unreadBefore = p.store.data.chats[G]?.unread;
    events.length = 0;
    handlers["messages.upsert"]!({ messages: [{ key: { remoteJid: G, id: "u1", fromMe: false, participant: CREATOR }, messageTimestamp: 30, message: { conversation: "the real text" } }], type: "notify", requestId: "REQ1" });
    const s = p.store.find(G, "u1")!;
    assert.equal(s.m.text, "the real text");
    assert.equal(s.waiting, undefined);
    assert.equal(p.resend.has("u1"), false);
    assert.equal(p.store.data.pending["u1"], undefined);
    const e = events.find((x) => x.type === "message" && x.data.id === "u1");
    assert.ok(e && e.type === "message" && e.data.historical === true && e.data.text === "the real text");
    assert.equal(p.store.data.chats[G]?.unread, unreadBefore); // no unread bump for a replay
  } finally { done(); }
});

test("a resend answer for a message we never stored is ingested as a replay", () => {
  const { p, events, handlers, done } = resendSetup();
  try {
    handlers["messages.upsert"]!({ messages: [{ key: { remoteJid: G, id: "new1", fromMe: false, participant: CREATOR }, messageTimestamp: 31, message: { conversation: "late" } }], type: "notify", requestId: "R" });
    const e = events.find((x) => x.type === "message");
    assert.ok(e && e.type === "message" && e.data.historical === true);
    assert.equal(p.store.data.chats[G]?.unread, undefined);
  } finally { done(); }
});

test("old placeholders in the cache are migrated into the queue and get the new honest text", () => {
  const { p, done } = withMe();
  try {
    p.intake(cipher(G, "old1", CREATOR), true);
    const s = p.store.find(G, "old1")!;
    delete s.waiting; delete p.store.data.pending["old1"];
    s.m.text = "Waiting for this message. Open WhatsApp on your phone to let it be delivered.";
    (p as unknown as { initResend(): void }).initResend();
    assert.equal(s.waiting, true);
    assert.match(s.m.text, WAIT_RE);
    assert.ok(p.store.data.pending["old1"]);
  } finally { done(); }
});

test("giving up changes the placeholder text and a later real message still replaces it", async () => {
  const { p, events, done } = resendSetup();
  try {
    p.intake(cipher(G, "g1", CREATOR), true);
    const e = p.store.data.pending["g1"]!;
    // simulate the queue giving up
    (p as unknown as { resend: { o?: unknown } }).resend;
    e.gaveUp = true;
    const priv = p as unknown as { resend: any };
    priv.resend.o.onGiveUp(e);
    assert.equal(p.store.find(G, "g1")!.m.text, "This message couldn't be decrypted. Open WhatsApp on your phone to read it.");
    assert.ok(events.some((x) => x.type === "message-update" && x.data.patch.text?.startsWith("This message couldn't")));
    p.intake({ key: { remoteJid: G, id: "g1", fromMe: false, participant: CREATOR }, messageTimestamp: 30, message: { conversation: "finally" } }, true);
    assert.equal(p.store.find(G, "g1")!.m.text, "finally");
  } finally { done(); }
});

test("refreshChat: nothing to ask, asked and answered, asked and not answered", async () => {
  const { c, p, asked, done } = resendSetup();
  try {
    assert.equal(await c.refreshChat!(G), "Nothing to ask for: all messages are here.");
    p.intake(cipher(G, "r1", CREATOR), true);
    p.intake(cipher(G, "r2", CREATOR), true);
    asked.length = 0;
    // the phone answers one message shortly after being asked
    setTimeout(() => p.intake({ key: { remoteJid: G, id: "r1", fromMe: false, participant: CREATOR }, messageTimestamp: 30, message: { conversation: "back" } }, false), 100);
    assert.equal(await c.refreshChat!(G), "Asked your phone to resend 2 messages.");
    assert.equal(asked.length >= 2, true);
    // no answer within the wait
    const p2 = p as unknown as { waitForActivity(c: string, ms: number): Promise<boolean> };
    const orig = p2.waitForActivity.bind(p);
    p2.waitForActivity = (chat, ms) => orig(chat, Math.min(ms, 150));
    assert.equal(await c.refreshChat!(G), "Your phone didn't answer. Open WhatsApp on it and try again.");
  } finally { done(); }
});

// ================= names: every source =================
type NameP = Wired & {
  applyHarvest(h: { pushnames: [string, string][]; pairs: [string, string][] }, src: string): void;
  tapFrame(n: unknown): void; refreshSenderNames(): void;
  nameSources: Map<string, number>;
};
test("unnamed group senders: contacts.update notify, history pushnames, lid migration sync and participant nodes all deliver names/numbers", () => {
  const { p, events, done } = withMe();
  try {
    const p2 = p as unknown as NameP;
    const l1 = "101@lid", l2 = "102@lid", l3 = "103@lid", l4 = "104@lid";
    const from = (id: string, who: string) => p.intake({ key: { remoteJid: G, id, fromMe: false, participant: who }, messageTimestamp: 50, message: { conversation: "yo" } }, false);
    for (const [i, l] of [l1, l2, l3, l4].entries()) assert.equal(from(`m${i}`, l)?.sender, "WhatsApp user");
    // 1. contacts.update with a notify name for a LID (Baileys emits it for every message pushName)
    p.applyContact({ id: l1, notify: "Via Notify" });
    // 2. pushnames of a non-PUSH_NAME history chunk
    p2.applyHarvest({ pushnames: [[l2, "Via History"]], pairs: [] }, "bootstrap");
    // 3. the phone's LID migration table (self-only protocol message)
    const payload = proto.LIDMigrationMappingSyncPayload.encode({ pnToLidMappings: [{ pn: 4917000003, assignedLid: 103 }] }).finish();
    assert.equal(p.intake({ key: { remoteJid: ME_PN, id: "LM", fromMe: true }, messageTimestamp: 51, message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC, lidMigrationMappingSyncMessage: { encodedMappingPayload: payload } } } }, false), undefined);
    // 4. group info participant node with a display name (hypothesis about the wire format, parsed defensively)
    p2.tapFrame({ tag: "iq", attrs: {}, content: [{ tag: "group", attrs: {}, content: [{ tag: "participant", attrs: { jid: l4, phone_number: "4917000004@s.whatsapp.net", display_name: "Via Node" } }] }] });
    p2.refreshSenderNames();
    assert.equal(p.nameOf(l1), "~Via Notify");
    assert.equal(p.nameOf(l2), "~Via History");
    assert.equal(p.nameOf(l3), "+49 170 00003");           // number known => formatted number, not "WhatsApp user"
    assert.equal(p.nameOf(l4), "~Via Node");
    assert.equal(p.nameOf("999@lid"), "WhatsApp user");    // no source at all
    const patched = events.filter((e) => e.type === "message-update").map((e) => (e as { data: { messageId: string; patch: { sender?: string } } }).data);
    assert.equal(patched.find((x) => x.messageId === "m2")?.patch.sender, "+49 170 00003");
    assert.equal(patched.find((x) => x.messageId === "m0")?.patch.sender, "~Via Notify");
    assert.ok(p2.nameSources.get("contacts-notify")); assert.ok(p2.nameSources.get("pushnames-bootstrap")); assert.ok(p2.nameSources.get("participant-node"));
    assert.ok(p2.nameSources.get("lid-map-sync"));
    // a lid migration sync from somebody else is ignored (self-only)
    const before = Object.keys(p.store.data.lidToPn).length;
    p.intake({ key: { remoteJid: G, id: "LM2", fromMe: false, participant: CREATOR }, messageTimestamp: 52, message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC, lidMigrationMappingSyncMessage: { encodedMappingPayload: proto.LIDMigrationMappingSyncPayload.encode({ pnToLidMappings: [{ pn: 1234567, assignedLid: 777 }] }).finish() } } } }, false);
    assert.equal(Object.keys(p.store.data.lidToPn).length, before);
  } finally { done(); }
});

// ================= revoke =================
test("protocolMessage REVOKE deletes the original (reactions cleared, pending placeholder dropped); unknown originals leave a deleted placeholder", () => {
  const { p, events, done } = withMe();
  try {
    const rev = (id: string, orig: object, extra: object = {}) => ({ key: { remoteJid: G, id, fromMe: false, participant: CREATOR }, messageTimestamp: 70, ...extra,
      message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { remoteJid: G, fromMe: false, participant: CREATOR, ...orig } } } });
    p.intake({ key: { remoteJid: G, id: "K1", fromMe: false, participant: CREATOR }, messageTimestamp: 60, message: { conversation: "oops" } }, false);
    p.store.find(G, "K1")!.m.reactions = [{ emoji: "x", senderIds: [CREATOR] }];
    events.length = 0;
    assert.equal(p.intake(rev("R1", { id: "K1" }), true), undefined);
    const k1 = p.store.find(G, "K1")!;
    assert.equal(k1.m.deleted, true); assert.equal(k1.m.text, ""); assert.equal(k1.m.reactions, undefined);
    const upd = events.find((e) => e.type === "message-update");
    assert.ok(upd && upd.type === "message-update" && upd.data.messageId === "K1" && upd.data.patch.deleted === true && upd.data.patch.reactions?.length === 0);
    // a second delivery changes nothing
    events.length = 0; p.intake(rev("R1b", { id: "K1" }), true);
    assert.equal(events.length, 0);
    // a message that is still a decrypt placeholder: the resend request is cancelled
    const priv = p as unknown as { initResend(): void; resend: { has(id: string): boolean } };
    priv.initResend();
    p.intake({ key: { remoteJid: G, id: "K2", fromMe: false, participant: CREATOR }, messageTimestamp: 61, messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT }, true);
    assert.equal(priv.resend.has("K2"), true);
    p.intake(rev("R2", { id: "K2" }), true);
    assert.equal(priv.resend.has("K2"), false); assert.equal(p.store.find(G, "K2")!.waiting, undefined); assert.equal(p.store.find(G, "K2")!.m.deleted, true);
    // never seen: deleted placeholder under the original id, flagged historical, by the original author, no unread bump
    events.length = 0;
    const unreadBefore = p.store.data.chats[G]?.unread;
    p.intake(rev("R3", { id: "K3", participant: "4916@s.whatsapp.net" }, { key: { remoteJid: G, id: "R3", fromMe: false, participant: CREATOR } }), true);
    const ph = p.store.find(G, "K3")!;
    assert.equal(ph.m.deleted, true); assert.equal(ph.m.senderId, "4916@s.whatsapp.net"); assert.equal(ph.m.text, "");
    const ev = events.find((e) => e.type === "message");
    assert.ok(ev && ev.type === "message" && ev.data.id === "K3" && ev.data.historical === true && ev.data.deleted === true);
    assert.equal(p.store.data.chats[G]?.unread, unreadBefore);
    // the original arriving later (history) does not resurrect it
    p.intake({ key: { remoteJid: G, id: "K3", fromMe: false, participant: "4916@s.whatsapp.net" }, messageTimestamp: 59, message: { conversation: "back from the dead" } }, false);
    assert.equal(p.store.find(G, "K3")!.m.deleted, true); assert.equal(p.store.find(G, "K3")!.m.text, "");
    // own revoke from my phone of my own message
    p.intake({ key: { remoteJid: G, id: "R4", fromMe: true, participant: ME_PN }, messageTimestamp: 80, message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { remoteJid: G, id: "K4", fromMe: true } } } }, false);
    const mine = p.store.find(G, "K4")!;
    assert.equal(mine.m.fromMe, true); assert.equal(mine.m.deleted, true); assert.equal(mine.m.senderId, ME_PN);
  } finally { done(); }
});

test("messages.update REVOKE clears reactions and a waiting placeholder; REVOKE stubs from history stay deleted", () => {
  const { p, events, handlers, done } = resendSetup();
  try {
    p.intake(cipher(G, "W1", CREATOR), true);
    assert.equal(p.resend.has("W1"), true);
    events.length = 0;
    handlers["messages.update"]!([{ key: { remoteJid: G, id: "W1", fromMe: false, participant: CREATOR }, update: { message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE } }]);
    assert.equal(p.store.find(G, "W1")!.m.deleted, true);
    assert.equal(p.resend.has("W1"), false);
    // history delivers the original as a REVOKE stub
    const h = p.intake({ key: { remoteJid: G, id: "H1", fromMe: false, participant: CREATOR }, messageTimestamp: 5, messageStubType: proto.WebMessageInfo.StubType.REVOKE }, false);
    assert.equal(h?.deleted, true); assert.equal(h?.text, "");
  } finally { done(); }
});

// ================= resend queue edge cases =================
test("undecryptable messages: a swallowed request is not counted, orphaned queue entries are pruned on start", async () => {
  const { p, asked, done } = resendSetup();
  try {
    const sock = p.sock as { requestPlaceholderResend: (k: unknown) => Promise<string | undefined> };
    let n = 0;
    sock.requestPlaceholderResend = async (k) => { asked.push(k); return n++ === 0 ? undefined : "id"; }; // first call: Baileys already had one in flight
    p.intake(cipher(G, "S1", CREATOR), true);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(p.store.data.pending["S1"]!.skips, 1);
    assert.equal(p.store.data.pending["S1"]!.attempts, 0);
    // orphan: entry without a stored message
    p.store.data.pending["GONE"] = { chatId: G, id: "GONE", fromMe: false, attempts: 1, next: 0 };
    p.initResend();
    assert.equal(p.store.data.pending["GONE"], undefined);
    assert.ok(p.store.data.pending["S1"]);
  } finally { done(); }
});

// ================= sending contact cards and locations =================
test("sending: several contacts, a location reply, live shares, invalid cards; the stored copy matches what was sent", async () => {
  const { c, p, done } = setup();
  try {
    const sent: { content: any; opts: any }[] = [];
    (p as unknown as { sock: unknown; opened: boolean }).opened = true;
    (p as unknown as { sock: unknown }).sock = {
      sendMessage: async (jid: string, content: any, opts: any) => {
        sent.push({ content, opts });
        let message: any;
        if (content.location) message = { locationMessage: content.location };
        else if (content.contacts) message = content.contacts.contacts.length === 1 ? { contactMessage: content.contacts.contacts[0] } : { contactsArrayMessage: content.contacts };
        else message = { conversation: content.text };
        if (opts?.quoted) { const k = Object.keys(message)[0]!; message[k] = { ...(typeof message[k] === "string" ? { text: message[k] } : message[k]), contextInfo: { stanzaId: opts.quoted.key.id, participant: opts.quoted.key.participant ?? opts.quoted.key.remoteJid, quotedMessage: opts.quoted.message } }; }
        return { key: { remoteJid: jid, id: `S${sent.length}`, fromMe: true }, messageTimestamp: 9, message, status: 1 };
      },
    };
    const chat = "4999@s.whatsapp.net";
    // two contacts => one contactsArrayMessage with a combined display name, vcards with waid numbers
    const two = await c.send(chat, { text: "", contacts: [{ name: "Ann Lee", phones: ["+49 170 1234567"] }, { name: "Bob", handle: "+4915123456789", emails: ["b@example.org"] }] });
    assert.equal(sent[0]!.content.contacts.displayName, "2 contacts");
    assert.equal(sent[0]!.content.contacts.contacts.length, 2);
    assert.match(sent[0]!.content.contacts.contacts[1].vcard, /TEL;type=CELL;waid=4915123456789:\+4915123456789/);
    assert.deepEqual(two.contacts?.map((x) => x.name), ["Ann Lee", "Bob"]);
    assert.equal(two.contacts?.[1]?.handle, "+4915123456789"); assert.deepEqual(two.contacts?.[1]?.emails, ["b@example.org"]);
    assert.equal(p.store.find(chat, two.id)?.m.contacts?.length, 2);
    // a name-less card falls back to its number; one with nothing at all is rejected
    await c.send(chat, { text: "", contacts: [{ name: "  ", phones: ["+49 170 1"] }] });
    assert.equal(sent[1]!.content.contacts.contacts[0].displayName, "+49 170 1");
    await assert.rejects(c.send(chat, { text: "", contacts: [{ name: " " }] }), /invalid contact/);
    // a reply to a location quotes a real locationMessage, a reply to a contact card quotes a contactMessage
    const loc = await c.send(chat, { text: "", location: { lat: 1.5, lng: 2.5, name: " Cafe ", address: "Main St" } });
    assert.deepEqual(sent.at(-1)!.content, { location: { degreesLatitude: 1.5, degreesLongitude: 2.5, name: "Cafe", address: "Main St" } });
    const reply = await c.send(chat, { text: "", replyToMessageId: loc.id, location: { lat: 3, lng: 4 } });
    const q1 = sent.at(-1)!.opts.quoted;
    assert.equal(q1.key.id, loc.id); assert.deepEqual(q1.message.locationMessage, { degreesLatitude: 1.5, degreesLongitude: 2.5, name: "Cafe", address: "Main St" });
    assert.deepEqual(reply.location, { lat: 3, lng: 4 });
    assert.equal(reply.replyTo?.messageId, loc.id);
    await c.send(chat, { text: "", replyToMessageId: two.id, contacts: [{ name: "Cy", phones: ["+49 1 2"] }] });
    const q2 = sent.at(-1)!.opts.quoted;
    assert.equal(q2.message.contactsArrayMessage.displayName, "2 contacts");
    assert.equal(sent.at(-1)!.content.contacts.contacts.length, 1);
    // a live share (live/liveUntil) is sent as a plain position: Baileys 6.7.24 has no live-location send; the stored copy says so
    const live = await c.send(chat, { text: "", location: { lat: 5, lng: 6, live: true, liveUntil: new Date(Date.now() + 3600_000).toISOString() } });
    assert.deepEqual(sent.at(-1)!.content, { location: { degreesLatitude: 5, degreesLongitude: 6 } });
    assert.equal(live.location?.live, undefined);
    // location with caption text: position first, text as its own message
    await c.send(chat, { text: "meet here", location: { lat: 7, lng: 8 } });
    assert.deepEqual(sent.slice(-2).map((s) => Object.keys(s.content)[0]), ["location", "text"]);
    await assert.rejects(c.send(chat, { text: "", location: { lat: NaN, lng: 0 } }), /invalid location/);
  } finally { done(); }
});

// ================= avatars =================
test("avatars: group lookups outlive the old 80-request bound, absent/hidden TTLs differ for groups, picture notifications invalidate", async () => {
  const { c, p, done } = setup();
  const realFetch = globalThis.fetch;
  try {
    const pp = p as unknown as { opened: boolean; sock: unknown; avatars: { get(j: string, now?: number): { state: string; fresh?: boolean } }; wire(s: unknown): void; avatarStats: Map<string, number>; takeAvatarStats(): string | undefined };
    pp.opened = true;
    const handlers: Record<string, (a: any) => void> = {};
    pp.sock = {
      ev: { on: (n: string, h: (a: any) => void) => { handlers[n] = h; } },
      profilePictureUrl: async (jid: string) => {
        if (jid.startsWith("1") ) return "https://cdn.example/g.jpg";
        if (jid.startsWith("2")) throw Object.assign(new Error("item-not-found"), { data: 404 });
        if (jid.startsWith("3")) throw Object.assign(new Error("not-authorized"), { data: 401 });
        throw Object.assign(new Error("boom"), { data: 500 });
      },
    };
    pp.wire(pp.sock);
    globalThis.fetch = (async () => new Response(new Uint8Array([9]), { status: 200, headers: { "content-type": "image/jpeg" } })) as typeof fetch;
    const jids = Array.from({ length: 150 }, (_, i) => `1${String(i).padStart(5, "0")}@g.us`);
    const res = await Promise.all(jids.map((j) => c.avatar!({ kind: "chat", id: j })));
    assert.equal(res.filter((r) => r).length, 150, "no request is dropped (the old limit answered 'none' beyond 80 pending)");
    const absent = "200001@g.us", hidden = "300001@g.us";
    assert.equal(await c.avatar!({ kind: "chat", id: absent }), undefined);
    assert.equal(await c.avatar!({ kind: "chat", id: hidden }), undefined);
    const now = Date.now();
    assert.equal(pp.avatars.get(absent, now + 3 * 3600_000).fresh, true);     // groups: absent verdict lasts 6h
    assert.equal(pp.avatars.get(absent, now + 7 * 3600_000).fresh, false);
    assert.equal(pp.avatars.get(hidden, now + 30 * 60_000).fresh, true);      // groups: hidden verdict is retried after 1h
    assert.equal(pp.avatars.get(hidden, now + 2 * 3600_000).fresh, false);
    const person = "4915000@s.whatsapp.net";
    p.store.data.lidToPn = {};
    (pp.sock as { profilePictureUrl: unknown }).profilePictureUrl = async () => { throw Object.assign(new Error("not-authorized"), { data: 401 }); };
    assert.equal(await c.avatar!({ kind: "contact", id: person }), undefined);
    assert.equal(pp.avatars.get(person, now + 20 * 3600_000).fresh, true);    // people keep the day-long privacy verdict
    // a 'picture changed' notification drops the stale "no picture" verdict
    assert.equal(pp.avatars.get(absent).state, "none");
    handlers["contacts.update"]!([{ id: absent, imgUrl: "changed" }]);
    assert.equal(pp.avatars.get(absent).state, "miss");
    const stats = pp.takeAvatarStats() ?? "";
    assert.match(stats, /g-ok=150/); assert.match(stats, /g-absent=1/); assert.match(stats, /g-hidden=1/); assert.match(stats, /p-hidden=1/);
  } finally { globalThis.fetch = realFetch; done(); }
});

test("per-recipient receipts: group message-receipt.update (lid mapped, own devices skipped), 1:1 ack, history userReceipt", () => {
  const { p, events, handlers, done } = resendSetup();
  try {
    const BOB = "4916@s.whatsapp.net", BOB_LID = "7001@lid", EVE = "4917@s.whatsapp.net";
    p.learn(BOB_LID, BOB);
    p.intake({ key: { remoteJid: G, id: "S1", fromMe: true, participant: ME_PN }, messageTimestamp: 100, message: { conversation: "hi group" }, status: 2 }, false);
    events.length = 0;
    handlers["message-receipt.update"]!([
      { key: { remoteJid: G, id: "S1", fromMe: true }, receipt: { userJid: BOB_LID, receiptTimestamp: 110 } },
      { key: { remoteJid: G, id: "S1", fromMe: true }, receipt: { userJid: BOB_LID, readTimestamp: 130 } },
      { key: { remoteJid: G, id: "S1", fromMe: true }, receipt: { userJid: EVE, receiptTimestamp: 120, playedTimestamp: 140 } },
      { key: { remoteJid: G, id: "S1", fromMe: true }, receipt: { userJid: ME_PN, readTimestamp: 150 } }, // my other device: ignored
    ]);
    const rs = events.filter((e) => e.type === "receipt").map((e) => (e as any).data);
    assert.deepEqual(rs.map((r: any) => [r.status, r.by, r.at]), [
      ["delivered", BOB, "1970-01-01T00:01:50.000Z"], ["read", BOB, "1970-01-01T00:02:10.000Z"],
      ["delivered", EVE, "1970-01-01T00:02:00.000Z"], ["read", EVE, "1970-01-01T00:02:20.000Z"]]);
    assert.deepEqual(p.store.find(G, "S1")!.m.receipts, [{ id: BOB, delivered: "1970-01-01T00:01:50.000Z", read: "1970-01-01T00:02:10.000Z" }, { id: EVE, delivered: "1970-01-01T00:02:00.000Z", read: "1970-01-01T00:02:20.000Z" }]);
    assert.equal(p.store.find(G, "S1")!.m.status, "read");
    // 1:1: the ack has no jid; the peer is the chat
    p.intake({ key: { remoteJid: BOB, id: "D1", fromMe: true }, messageTimestamp: 200, message: { conversation: "hi bob" }, status: 2 }, false);
    events.length = 0;
    handlers["messages.update"]!([{ key: { remoteJid: BOB, id: "D1", fromMe: true }, update: { status: 3 } }, { key: { remoteJid: BOB, id: "D1", fromMe: true }, update: { status: 2 } }]);
    const d = events.filter((e) => e.type === "receipt").map((e) => (e as any).data);
    assert.equal(d.length, 1); assert.equal(d[0].by, BOB); assert.equal(d[0].status, "delivered"); assert.ok(!Number.isNaN(Date.parse(d[0].at)));
    // history sync: userReceipt on a sent message becomes receipts (canonical ids)
    const h = p.intake({ key: { remoteJid: G, id: "S2", fromMe: true, participant: ME_PN }, messageTimestamp: 300, message: { conversation: "old" }, status: 4,
      userReceipt: [{ userJid: BOB_LID, receiptTimestamp: 301, readTimestamp: 305 }, { userJid: EVE, receiptTimestamp: 302 }, { userJid: ME_PN, readTimestamp: 9 }] }, false);
    assert.deepEqual(h?.receipts, [{ id: BOB, delivered: "1970-01-01T00:05:01.000Z", read: "1970-01-01T00:05:05.000Z" }, { id: EVE, delivered: "1970-01-01T00:05:02.000Z" }]);
    assert.equal((p as any).capabilities.receiptDetails, true);
  } finally { done(); }
});

test("a notice WhatsApp flags fromMe but someone else caused is attributed to that person; old wrong notices are repaired", () => {
  const { p, done } = withMe();
  try {
    p.store.data.push["4916@s.whatsapp.net"] = "Ben";
    p.store.data.push["4915@s.whatsapp.net"] = "Anna";
    const note = (params: string[], participant?: string, fromMe = false) =>
      p.intake({ key: { remoteJid: G, id: `m${Math.random()}`, fromMe, participant }, messageTimestamp: 5, messageStubType: 27, messageStubParameters: params }, false);
    assert.equal(note(["4916@s.whatsapp.net"], "4915@s.whatsapp.net", true)?.text, "~Anna added ~Ben", "fromMe alone must not make it 'You'");
    assert.equal(note(["4916@s.whatsapp.net"], "491700000000@s.whatsapp.net", true)?.text, "You added ~Ben", "but my own participant id still does");
    assert.equal(note(["4916@s.whatsapp.net"], undefined, true)?.text, "You added ~Ben", "no participant + fromMe stays 'You'");
    // repair of earlier wrong text
    const old = p.store.find(G, "OLD") ?? p.intake({ key: { remoteJid: G, id: "OLD", fromMe: true, participant: "4915@s.whatsapp.net" }, messageTimestamp: 4, messageStubType: 27, messageStubParameters: ["4916@s.whatsapp.net"] }, false);
    const sm = p.store.find(G, "OLD")!; sm.m.text = "You added ~Ben"; sm.pj = "4915@s.whatsapp.net";
    const events: any[] = []; p.emit = (e: any) => events.push(e);
    (p as any).fixActorNotices();
    assert.equal(sm.m.text, "~Anna added ~Ben");
    assert.ok(events.some((e) => e.type === "message-update" && e.data.messageId === "OLD" && e.data.patch.text === "~Anna added ~Ben"));
    void old;
  } finally { done(); }
});

test("group members: one row per person (LID + number forms merged) and me shown once as You", async () => {
  const { p, c, done } = withMe();
  try {
    p.store.data.lidToPn["7777@lid"] = "4916@s.whatsapp.net";
    p.applyGroup({ id: G, subject: "G", participants: [
      { id: "7777@lid", jid: "4916@s.whatsapp.net" }, { id: "4916@s.whatsapp.net" },                       // same person twice
      { id: "9000@lid", jid: "491700000000@s.whatsapp.net" }, { id: "491700000000@s.whatsapp.net" },        // me twice
      { id: "4915@s.whatsapp.net" },
    ] });
    const m = await c.members(G);
    assert.equal(m.length, 3, JSON.stringify(m.map((x) => x.id)));
    assert.equal(m.filter((x) => x.name === "You").length, 1);
  } finally { done(); }
});

test("adding members: added, invited by message when only invitations are accepted, clear errors otherwise", async () => {
  const { p, c, events, done } = withMe();
  try {
    p.opened = true;
    p.applyGroup({ id: G, subject: "Grp", addressingMode: "pn", participants: [{ id: "491700000000@s.whatsapp.net", admin: "superadmin" }] });
    const sent: any[] = [];
    const answers: Record<string, any> = {
      "491100001111@s.whatsapp.net": { status: "200", jid: "491100001111@s.whatsapp.net" },
      "491100002222@s.whatsapp.net": { status: "403", jid: "491100002222@s.whatsapp.net", content: { content: [{ tag: "add_request", attrs: { code: "ABCDEF", expiration: "1900000000" } }] } },
      "491100003333@s.whatsapp.net": { status: "409", jid: "491100003333@s.whatsapp.net" },
    };
    p.sock = {
      onWhatsApp: async (...j: string[]) => j.map((x) => ({ jid: x, exists: x !== "491100004444@s.whatsapp.net" })),
      groupMetadata: async () => ({ id: G, subject: "Grp", participants: [] }),
      groupParticipantsUpdate: async (_g: string, ps: string[]) => [answers[ps[0]!]],
      sendMessage: async (to: string, content: any) => { sent.push([to, content]); return {}; },
    };
    await assert.rejects(c.addMembers!(G, ["+491100001111", "+491100002222", "+491100003333", "+491100004444"]), /Added 1, invited 1 of 4.*1 not on WhatsApp.*1 could not be added \(already in the group\)/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], "491100002222@s.whatsapp.net");
    assert.equal(sent[0][1].groupInvite.inviteCode, "ABCDEF");
    assert.equal(sent[0][1].groupInvite.subject, "Grp");
    assert.ok(events.some((e: any) => e.type === "error" && e.data.code === "group-invited"));
    await assert.rejects(c.addMembers!(G, ["abc"]), /not a valid phone number/);
  } finally { done(); }
});
