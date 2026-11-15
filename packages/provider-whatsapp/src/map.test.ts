import test from "node:test";
import assert from "node:assert/strict";
import { normJid, canon, extract, statusFromAck, isMuted, handleToJid, betterStatus, summarizeParticipantResults, parseInviteCode } from "./map.js";

test("normJid strips device and legacy server", () => {
  assert.equal(normJid("123:7@s.whatsapp.net"), "123@s.whatsapp.net");
  assert.equal(normJid("123@c.us"), "123@s.whatsapp.net");
  assert.equal(normJid("55-66@g.us"), "55-66@g.us");
});
test("canon prefers phone jid for lids", () => {
  assert.equal(canon("9:1@lid", { "9@lid": "123@s.whatsapp.net" }), "123@s.whatsapp.net");
  assert.equal(canon("9@lid", {}, "5:2@s.whatsapp.net"), "5@s.whatsapp.net");
  assert.equal(canon("9@lid", {}), "9@lid");
});
test("extract text, media, unsupported", () => {
  assert.equal(extract({ conversation: "hi" })?.text, "hi");
  const m = extract({ audioMessage: { ptt: true, mimetype: "audio/ogg", seconds: 3, mediaKey: new Uint8Array([1, 2]) } });
  assert.equal(m?.attachment?.att.kind, "voice");
  assert.equal(m?.attachment?.att.durationMs, 3000);
  assert.equal(extract({ reactionMessage: {} }), undefined);
  const u = extract({ bcallMessage: { sessionId: "x" } });
  assert.equal(u?.text, "[unsupported message: bcallMessage]");
  assert.equal(u?.unsupported, "bcallMessage");
  assert.deepEqual(u?.card, { kind: "other", title: "bcallMessage" });
});
test("status/mute/handle", () => {
  assert.equal(statusFromAck(4), "read");
  assert.equal(isMuted(0), false);
  assert.equal(isMuted(-1), true);
  assert.equal(handleToJid("+49 170 1234567"), "491701234567@s.whatsapp.net");
  assert.equal(handleToJid("abc"), undefined);
  assert.equal(betterStatus("read", "sent"), false);
  assert.equal(betterStatus("sent", "delivered"), true);
});
test("summarizeParticipantResults", () => {
  const r = summarizeParticipantResults([{ status: "200" }, { status: "403" }, { status: "409" }, { status: "403" }]);
  assert.deepEqual([r.ok, r.failed], [1, 3]);
  assert.deepEqual(r.reasons, ["403 not allowed / needs invite", "409 already a member"]);
});
test("parseInviteCode", () => {
  assert.equal(parseInviteCode("https://chat.whatsapp.com/AbCdEfGhIjKlMn"), "AbCdEfGhIjKlMn");
  assert.equal(parseInviteCode(" chat.whatsapp.com/invite/AbCdEfGhIjKlMn?mode=r "), "AbCdEfGhIjKlMn");
  assert.equal(parseInviteCode("AbCdEfGhIjKlMn"), "AbCdEfGhIjKlMn");
  assert.equal(parseInviteCode("https://example.com/AbCdEfGhIjKlMn"), undefined);
  assert.equal(parseInviteCode("short"), undefined);
});

import { formatPhone, pickName, groupFallbackName } from "./names.js";
import { AvatarCache, isFresh, limiter, POSITIVE_TTL_MS, NEGATIVE_TTL_MS } from "./avatar.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("formatPhone", () => {
  assert.equal(formatPhone("491701234567"), "+49 170 1234567");
  assert.equal(formatPhone("14155550123"), "+1 415 5550123");
  assert.equal(formatPhone("12"), "+12");
});
test("pickName precedence and never a raw jid", () => {
  const j = "491701234567@s.whatsapp.net";
  assert.equal(pickName(j, { contact: "Ann", push: "annie", verified: "Biz" }), "Ann");
  assert.equal(pickName(j, { push: "annie", verified: "Biz" }), "~annie");
  assert.equal(pickName(j, { verified: "Biz" }), "Biz");
  assert.equal(pickName(j, { contact: "  " }), "+49 170 1234567");
  assert.equal(pickName("99@lid", {}), "WhatsApp user");
  assert.equal(pickName("99@lid", { push: "x" }), "~x");
});
test("groupFallbackName", () => {
  assert.equal(groupFallbackName([], 0), "Group");
  assert.equal(groupFallbackName(["a", "b"], 2), "a, b");
  assert.equal(groupFallbackName(["a", "b", "c", "d"], 9), "a, b, c +6");
});
test("avatar cache expiry and storage", () => {
  assert.equal(isFresh({ t: 0 }, POSITIVE_TTL_MS - 1), true);
  assert.equal(isFresh({ t: 0 }, POSITIVE_TTL_MS), false);
  assert.equal(isFresh({ t: 0, neg: true }, NEGATIVE_TTL_MS - 1), true);
  assert.equal(isFresh({ t: 0, neg: true }, NEGATIVE_TTL_MS), false);
  const d = mkdtempSync(join(tmpdir(), "av-"));
  try {
    const c = new AvatarCache(d);
    assert.equal(c.get("a@g.us").state, "miss");
    c.putPositive("a@g.us", new Uint8Array([1, 2, 3]), "image/png", 1000);
    const r = c.get("a@g.us", 1000 + 5);
    assert.equal(r.state === "hit" && r.fresh && r.mime === "image/png" && r.data.length === 3, true);
    c.putNegative("b@g.us", 0);
    const n = c.get("b@g.us", NEGATIVE_TTL_MS + 1);
    assert.equal(n.state === "none" && !n.fresh, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test("limiter caps concurrency", async () => {
  const run = limiter(2); let cur = 0, max = 0;
  await Promise.all([1, 2, 3, 4, 5].map(() => run(async () => { cur++; max = Math.max(max, cur); await new Promise((r) => setTimeout(r, 5)); cur--; })));
  assert.equal(max, 2);
});

import { counterparts, lookupName, mergeLid, mergeAllLids, visibleChatIds } from "./chatlist.js";
import { Store, type StoreData, type StoredMsg } from "./store.js";

const msg = (id: string, chatId: string, ts: number, senderId = chatId): StoredMsg =>
  ({ ts, m: { id, chatId, senderId, sender: "x", text: "t", time: new Date(ts).toISOString(), fromMe: false } });
const fresh = (): StoreData => new Store("").data;

test("name lookup works in both directions through lidToPn", () => {
  const d = fresh();
  d.lidToPn["9@lid"] = "491701234567@s.whatsapp.net";
  d.contacts["9@lid"] = "Ann";          // contact stored under the LID
  d.push["491701234567@s.whatsapp.net"] = "annie"; // push under the PN
  assert.equal(lookupName(d, "491701234567@s.whatsapp.net").contact, "Ann");
  assert.equal(lookupName(d, "9@lid").push, "annie");
  assert.deepEqual(counterparts(d, "491701234567@s.whatsapp.net"), ["9@lid"]);
  assert.equal(pickName("491701234567@s.whatsapp.net", lookupName(d, "491701234567@s.whatsapp.net")), "Ann");
  assert.equal(pickName("77@lid", lookupName(d, "77@lid")), "WhatsApp user");
});

test("dm chat name from chat list is a contact-level fallback", () => {
  const d = fresh();
  d.chats["1@s.whatsapp.net"] = { id: "1@s.whatsapp.net", kind: "dm", name: "Bob" };
  assert.equal(lookupName(d, "1@s.whatsapp.net").contact, "Bob");
});

test("mergeLid folds lid chat, messages, names and anchors into the pn chat", () => {
  const d = fresh();
  const pn = "491701234567@s.whatsapp.net", lid = "9@lid";
  d.chats[lid] = { id: lid, kind: "dm", unread: 2, lastMessageAt: "2024-01-02T00:00:00.000Z" };
  d.chats[pn] = { id: pn, kind: "dm", unread: 1, lastMessageAt: "2024-01-01T00:00:00.000Z" };
  d.msgs[lid] = [msg("a", lid, 2000), msg("c", lid, 4000)];
  d.msgs[pn] = [msg("b", pn, 3000), msg("a", pn, 2000)];
  d.contacts[lid] = "Ann";
  d.anchors[lid] = { id: "c", fromMe: false, rj: lid, ts: 4000 };
  assert.equal(mergeLid(d, lid, pn), true);
  assert.equal(d.chats[lid], undefined);
  assert.equal(d.chats[pn]!.unread, 3);
  assert.equal(d.chats[pn]!.lastMessageAt, "2024-01-02T00:00:00.000Z");
  assert.deepEqual(d.msgs[pn]!.map((s) => s.m.id), ["a", "b", "c"]);
  assert.equal(d.msgs[pn]!.every((s) => s.m.chatId === pn), true);
  assert.equal(d.msgs[lid], undefined);
  assert.equal(d.contacts[pn], "Ann");
  assert.equal(d.anchors[pn]!.id, "c");
  assert.equal(mergeLid(d, lid, pn), false); // idempotent
});

test("mergeAllLids and visibleChatIds hide stubs", () => {
  const d = fresh();
  d.lidToPn["9@lid"] = "5@s.whatsapp.net";
  d.chats["9@lid"] = { id: "9@lid", kind: "dm" }; d.msgs["9@lid"] = [msg("a", "9@lid", 1)];
  d.chats["stub@s.whatsapp.net"] = { id: "stub@s.whatsapp.net", kind: "dm" };
  d.chats["g1@g.us"] = { id: "g1@g.us", kind: "group", member: true };
  d.chats["g2@g.us"] = { id: "g2@g.us", kind: "group", member: false };
  d.chats["new@s.whatsapp.net"] = { id: "new@s.whatsapp.net", kind: "dm", started: true };
  assert.equal(mergeAllLids(d), 1);
  assert.deepEqual(visibleChatIds(d).sort(), ["5@s.whatsapp.net", "g1@g.us", "new@s.whatsapp.net"]);
});

import { buildPoll, applyVote, encryptVote, tryDecryptVote } from "./poll.js";
import { optionId } from "./map.js";

test("poll extraction and stable option ids", () => {
  const ex = extract({ pollCreationMessage: { name: "Lunch?", selectableOptionsCount: 0, options: [{ optionName: "Pizza" }, { optionName: "Sushi" }] } });
  assert.equal(ex?.poll?.question, "Lunch?");
  assert.equal(ex?.poll?.multiple, true);
  assert.equal(ex?.poll?.options[0]!.id, optionId("Pizza"));
  assert.equal(extract({ pollCreationMessageV3: { name: "q", selectableOptionsCount: 1, options: [{ optionName: "a" }] } })?.poll?.multiple, false);
  assert.equal(extract({ pollUpdateMessage: {} }), undefined);
});
test("poll votes: aggregate, newest wins, mine", () => {
  const sp = { secret: "", question: "q", multiple: false, options: [{ id: optionId("a"), text: "a" }, { id: optionId("b"), text: "b" }], votes: {} };
  assert.equal(applyVote(sp, "x@s.whatsapp.net", [optionId("a")], 10), true);
  assert.equal(applyVote(sp, "x@s.whatsapp.net", [optionId("b")], 5), false);
  assert.equal(applyVote(sp, "me", [optionId("b"), "bogus"], 20), true);
  const p = buildPoll(sp, "me");
  assert.deepEqual(p.options.map((o) => o.voters), [["x@s.whatsapp.net"], ["me"]]);
  assert.deepEqual(p.mine, [optionId("b")]);
});
test("vote encryption round-trips through Baileys' decryptPollVote and tries jid candidates", () => {
  const secret = new Uint8Array(32).fill(7);
  const enc = encryptVote(secret, "MSGID", "111@s.whatsapp.net", "222@s.whatsapp.net", [optionId("a")]);
  assert.deepEqual(tryDecryptVote(enc, secret, "MSGID", ["999@lid", "111@s.whatsapp.net"], ["333@lid", "222@s.whatsapp.net"]), [optionId("a")]);
  assert.equal(tryDecryptVote(enc, secret, "MSGID", ["999@lid"], ["222@s.whatsapp.net"]), undefined);
});

import { classifyAvatarError, withTimeout } from "./avatar.js";
test("avatar error classification (Baileys Boom: data=code, message=node text)", () => {
  const boom = (message: string, data?: number) => Object.assign(new Error(message), { data, output: { statusCode: 500 } });
  assert.equal(classifyAvatarError(boom("item-not-found", 404)), "absent");
  assert.equal(classifyAvatarError(boom("not-authorized", 401)), "hidden");
  assert.equal(classifyAvatarError(boom("forbidden", 403)), "hidden");
  assert.equal(classifyAvatarError(boom("rate-overlimit", 429)), "ratelimit");
  assert.equal(classifyAvatarError(boom("Timed Out", 408)), "transient");
  assert.equal(classifyAvatarError(new Error("Connection Closed")), "transient");
});
test("withTimeout resolves the fallback", async () => {
  assert.equal(await withTimeout(20, new Promise<string>(() => {}), "x"), "x");
  assert.equal(await withTimeout(200, Promise.resolve("y"), "x"), "y");
  assert.equal(await withTimeout(200, Promise.reject(new Error("e")), "x"), "x");
});

import { validateAvatar, validateName, validateAbout, buildPrivacy, resolvePrivacyChange, sniffImage, friendlyWaError, PRIVACY_DEFS } from "./profile.js";
const pngHeader = (w: number, h: number) => { const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); const dv = new DataView(b.buffer); dv.setUint32(16, w); dv.setUint32(20, h); return b; };
const jpegHeader = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

test("avatar validation", () => {
  assert.deepEqual(sniffImage(pngHeader(640, 480)), { format: "png", width: 640, height: 480 });
  assert.deepEqual(sniffImage(jpegHeader(300, 200)), { format: "jpeg", width: 300, height: 200 });
  assert.equal(validateAvatar({ data: jpegHeader(640, 640), mime: "image/jpeg" }).format, "jpeg");
  assert.throws(() => validateAvatar({ data: pngHeader(640, 640), mime: "image/jpeg" }), /does not match/);
  assert.throws(() => validateAvatar({ data: pngHeader(20, 20), mime: "image/png" }), /too small/);
  assert.throws(() => validateAvatar({ data: new Uint8Array([1, 2, 3, 4, 5]), mime: "image/png" }), /JPEG, PNG or WebP/);
  assert.throws(() => validateAvatar({ data: new Uint8Array(), mime: "image/png" }), /empty/);
});
test("name/about validation", () => {
  assert.equal(validateName("  Ann "), "Ann");
  assert.throws(() => validateName(" "), /empty/);
  assert.throws(() => validateName("x".repeat(26)), /25/);
  assert.throws(() => validateAbout("x".repeat(140)), /139/);
  assert.equal(validateAbout("Hey there"), "Hey there");
});
test("privacy settings map to accepted values only", () => {
  const list = buildPrivacy({ last: "contacts", online: "match_last_seen", profile: "all", status: "contact_blacklist", readreceipts: "none", groupadd: "contacts" });
  const byId = Object.fromEntries(list.map((s) => [s.id, s]));
  assert.equal(byId.last_seen!.value, "contacts");
  assert.deepEqual(byId.last_seen!.options.map((o) => o.value), ["all", "contacts", "contact_blacklist", "none"]);
  assert.deepEqual(byId.online!.options.map((o) => o.value), ["all", "match_last_seen"]);
  assert.deepEqual(byId.groups_add!.options.map((o) => o.value), ["all", "contacts", "contact_blacklist"]);
  assert.deepEqual(byId.read_receipts!.options.map((o) => o.value), ["all", "none"]);
  assert.equal(byId.calls_add, undefined); // optional categories only when WhatsApp reports them
  assert.equal(buildPrivacy({ calladd: "known" }).some((s) => s.id === "calls_add"), true);
  assert.equal(buildPrivacy({ last: "weird" }).find((s) => s.id === "last_seen")!.options.some((o) => o.value === "weird"), true); // unknown current value stays visible
  assert.equal(PRIVACY_DEFS.every((d) => d.options.length >= 2), true);
});
test("privacy change validation and error messages", () => {
  assert.equal(resolvePrivacyChange("last_seen", "none").setter, "updateLastSeenPrivacy");
  assert.throws(() => resolvePrivacyChange("groups_add", "none"), /not an allowed value/);
  assert.throws(() => resolvePrivacyChange("nope", "all"), /Unknown privacy setting/);
  assert.match(friendlyWaError(Object.assign(new Error("rate-overlimit"), { data: 429 }), "X").message, /rate limiting/);
  assert.match(friendlyWaError(new Error("No image processing library available"), "X").message, /sharp/);
});

import { describeStub, stubJids, ephemeralText } from "./system.js";
import { parseVcard, fmtTime } from "./content.js";

const T = 1_741_113_000; // 2025-03-04 18:30:00 UTC
test("event message -> card + text; canceled prefix; responses are skipped", () => {
  const e = extract({ eventMessage: { name: "Board meeting", description: "Agenda attached", startTime: T, endTime: T + 3600, joinLink: "https://call.whatsapp.com/x", location: { name: "HQ", address: "Main St 1" } } });
  assert.equal(e?.card?.kind, "event");
  assert.equal(e?.card?.title, "Board meeting");
  assert.equal(e?.card?.body, "Agenda attached");
  assert.equal(e?.card?.when, new Date(T * 1000).toISOString());
  assert.equal(e?.card?.until, new Date((T + 3600) * 1000).toISOString());
  assert.equal(e?.card?.place, "HQ, Main St 1");
  assert.equal(e?.card?.url, "https://call.whatsapp.com/x");
  assert.match(e!.text, /^Event: Board meeting - 2025-03-04 18:30 UTC to 2025-03-04 19:30 UTC - HQ, Main St 1\nAgenda attached\nJoin: https/);
  const canceled = extract({ eventMessage: { name: "x", isCanceled: true } });
  assert.equal(canceled?.card?.canceled, true); assert.equal(canceled?.card?.title, "x"); assert.match(canceled!.text, /^Event \(canceled\): x/);
  assert.equal(extract({ encEventResponseMessage: {} }), undefined);
  assert.equal(extract({ secretEncryptedMessage: {} }), undefined);
  assert.equal(fmtTime(T * 1000), "2025-03-04 18:30 UTC");
});
test("invites", () => {
  const g = extract({ groupInviteMessage: { groupName: "Infra", caption: "Join us", inviteCode: "ABC123" } });
  assert.deepEqual(g?.card, { kind: "invite", title: "Infra", subtitle: "Group invite", body: "Join us", url: "https://chat.whatsapp.com/ABC123" });
  assert.match(g!.text, /^Group invite: Infra\nJoin us/);
  assert.equal(extract({ groupInviteMessage: { groupName: "C", groupType: 1 } })?.card?.subtitle, "Community invite");
  assert.equal(extract({ newsletterAdminInviteMessage: { newsletterName: "News" } })?.card?.title, "News");
});
test("calls", () => {
  const sc = extract({ scheduledCallCreationMessage: { title: "Sync", callType: 2, scheduledTimestampMs: T * 1000 } });
  assert.equal(sc?.card?.kind, "call"); assert.equal(sc?.card?.when, new Date(T * 1000).toISOString());
  assert.equal(sc?.text, "Scheduled video call: Sync - 2025-03-04 18:30 UTC");
  assert.equal(extract({ scheduledCallEditMessage: { editType: 1 } })?.text, "Scheduled call canceled");
  assert.equal(extract({ callLogMesssage: { isVideo: false, callOutcome: 1 } })?.text, "Missed voice call");
  assert.equal(extract({ callLogMesssage: { isVideo: true, callOutcome: 0, durationSecs: 125 } })?.text, "Video call (2m 5s)");
  assert.equal(extract({ callLogMesssage: { callOutcome: 3 } })?.card?.kind, "call");
});
test("list, buttons, template, interactive, hsm", () => {
  const l = extract({ listMessage: { title: "Menu", description: "Pick", buttonText: "Open", footerText: "f", sections: [{ title: "s", rows: [{ title: "A", description: "a" }, { title: "B" }] }] } });
  assert.equal(l?.card?.kind, "list"); assert.deepEqual(l?.card?.rows, [{ label: "A", value: "a" }, { label: "B", value: "" }]); assert.deepEqual(l?.card?.buttons, ["Open"]);
  assert.match(l!.text, /Options: A, B/);
  assert.equal(extract({ listResponseMessage: { title: "A" } })?.text, "Selected: A");
  const b = extract({ buttonsMessage: { contentText: "Sure?", footerText: "ft", buttons: [{ buttonText: { displayText: "Yes" } }, { buttonText: { displayText: "No" } }] } });
  assert.equal(b?.card?.kind, "buttons"); assert.deepEqual(b?.card?.buttons, ["Yes", "No"]); assert.equal(b?.card?.footer, "ft");
  assert.equal(extract({ buttonsResponseMessage: { selectedDisplayText: "Yes" } })?.text, "Selected: Yes");
  const t = extract({ templateMessage: { hydratedTemplate: { hydratedTitleText: "Hi", hydratedContentText: "Body", hydratedFooterText: "F", hydratedButtons: [{ quickReplyButton: { displayText: "Go" } }, { urlButton: { displayText: "Site" } }] } } });
  assert.equal(t?.card?.kind, "template"); assert.equal(t?.card?.title, "Hi"); assert.equal(t?.card?.body, "Body"); assert.deepEqual(t?.card?.buttons, ["Go", "Site"]);
  assert.equal(extract({ templateButtonReplyMessage: { selectedDisplayText: "Go" } })?.text, "Selected: Go");
  const i = extract({ interactiveMessage: { header: { title: "H" }, body: { text: "B" }, footer: { text: "F" }, nativeFlowMessage: { buttons: [{ name: "cta_url", buttonParamsJson: JSON.stringify({ display_text: "Open" }) }] } } });
  assert.equal(i?.card?.kind, "template"); assert.deepEqual(i?.card?.buttons, ["Open"]); assert.equal(i?.card?.body, "B");
  assert.equal(extract({ interactiveResponseMessage: { body: { text: "Chosen" } } })?.text, "Selected: Chosen");
  const h = extract({ highlyStructuredMessage: { fallbackLg: "Your code is 123" } });
  assert.equal(h?.text, "Your code is 123"); assert.equal(h?.card?.kind, "template");
});
test("product, order, payments, pin, phone request, sticker pack", () => {
  const p = extract({ productMessage: { product: { title: "Mug", priceAmount1000: 12500, currencyCode: "EUR", retailerId: "r1", url: "https://shop/x" }, body: "b" } });
  assert.equal(p?.card?.kind, "product"); assert.deepEqual(p?.card?.rows, [{ label: "Price", value: "12.50 EUR" }, { label: "Item", value: "r1" }]); assert.equal(p?.card?.url, "https://shop/x");
  const o = extract({ orderMessage: { orderTitle: "Order 7", itemCount: 3, totalAmount1000: 30000, totalCurrencyCode: "EUR", sellerJid: "4915@s.whatsapp.net" } });
  assert.equal(o?.card?.kind, "order"); assert.deepEqual(o?.card?.rows, [{ label: "Items", value: "3" }, { label: "Total", value: "30.00 EUR" }, { label: "Seller", value: "4915" }]);
  assert.equal(extract({ requestPaymentMessage: { amount1000: 5000, currencyCodeIso4217: "USD" } })?.card?.kind, "payment");
  assert.equal(extract({ sendPaymentMessage: {} })?.card?.kind, "payment");
  assert.equal(extract({ pinInChatMessage: { type: 1 } })?.text, "Pinned a message");
  assert.equal(extract({ pinInChatMessage: { type: 1 } })?.system, true);
  assert.equal(extract({ pinInChatMessage: { type: 2 } })?.text, "Unpinned a message");
  assert.equal(extract({ requestPhoneNumberMessage: {} })?.text, "Asked for your phone number");
  assert.equal(extract({ keepInChatMessage: {} }), undefined);
});
test("location and contact cards fill structured fields; wrappers unwrap", () => {
  const l = extract({ locationMessage: { degreesLatitude: 52.5, degreesLongitude: 13.4, name: "Office", address: "Street 1" } });
  assert.deepEqual(l?.location, { lat: 52.5, lng: 13.4, name: "Office", address: "Street 1" }); assert.equal(l?.text, "");
  assert.equal(extract({ liveLocationMessage: { degreesLatitude: 1, degreesLongitude: 2, caption: "on my way" } })?.location?.live, true);
  const vcard = "BEGIN:VCARD\nVERSION:3.0\nFN:Ann Lee\nTEL;type=CELL;waid=491701234567:+49 170 1234567\nEMAIL:ann@example.org\nEND:VCARD";
  assert.deepEqual(parseVcard(vcard), { name: "Ann Lee", phones: ["+49 170 1234567"], emails: ["ann@example.org"], handle: "+491701234567" });
  assert.equal(extract({ contactMessage: { displayName: "Ann", vcard } })?.contacts?.[0]?.name, "Ann Lee");
  assert.equal(extract({ contactsArrayMessage: { contacts: [{ vcard }, { displayName: "Bob" }] } })?.contacts?.length, 2);
  assert.equal(extract({ groupMentionedMessage: { message: { conversation: "hey" } } })?.text, "hey");
  assert.equal(extract({ deviceSentMessage: { destinationJid: "x", message: { conversation: "mine" } } })?.text, "mine");
  assert.equal(extract({ pollCreationMessageV4: { message: { pollCreationMessage: { name: "q", selectableOptionsCount: 1, options: [{ optionName: "a" }] } } } })?.poll?.question, "q");
  assert.equal(extract({ ptvMessage: { mimetype: "video/mp4", mediaKey: new Uint8Array([1]) } })?.attachment?.att.kind, "video");
});
test("stub notices", () => {
  assert.deepEqual(stubJids(['{"id":"1@lid","phone_number":"49@s.whatsapp.net"}', "5@s.whatsapp.net", "junk"]), ["49@s.whatsapp.net", "5@s.whatsapp.net"]);
  assert.equal(describeStub(27, [], "Anna", ["Ben"])?.text, "Anna added Ben");
  assert.equal(describeStub(27, [], "", ["Ben", "Cy"])?.text, "Ben and Cy were added");
  assert.equal(describeStub(28, [], "Anna", ["Ben"])?.text, "Anna removed Ben");
  assert.equal(describeStub(32, [], "", ["Ben"])?.text, "Ben left");
  assert.equal(describeStub(21, ["New"], "Anna", [])?.text, 'Anna changed the group name to "New"');
  assert.equal(describeStub(21, ["New"], "", [])?.text, 'The group name was changed to "New"');
  assert.equal(describeStub(72, ["604800"], "", [])?.text, "Disappearing messages: 7 days");
  assert.equal(ephemeralText(0), "Disappearing messages turned off");
  assert.equal(describeStub(29, [], "", ["Ben"])?.text, "Ben is now an admin");
  assert.equal(describeStub(38, [], "", ["Ben"])?.text, "Ben's security code changed");
  assert.equal(describeStub(40, [], "", [])?.card?.kind, "call");
  assert.equal(describeStub(134, [], "", [])?.text, "This group was added to a community");
  assert.equal(describeStub(39, [], "", []), undefined); // end-to-end banner is noise
  assert.equal(describeStub(2, [], "", []), undefined);  // undecryptable placeholder
});

test("gif playback videos are flagged", () => {
  const g = extract({ videoMessage: { mimetype: "video/mp4", gifPlayback: true, mediaKey: new Uint8Array([1]) } });
  assert.equal(g?.attachment?.att.gif, true); assert.equal(g?.attachment?.att.kind, "video"); assert.equal(g?.attachment?.att.mime, "video/mp4");
  assert.equal(extract({ videoMessage: { mimetype: "video/mp4", mediaKey: new Uint8Array([1]) } })?.attachment?.att.gif, undefined);
});
import { encryptEventEdit, tryDecryptEventEdit } from "./eventcrypto.js";
test("event edit crypto round-trips and rejects wrong participants", () => {
  const secret = new Uint8Array(32).fill(9);
  const enc = encryptEventEdit(secret, "EV1", "1@s.whatsapp.net", "1@s.whatsapp.net", { name: "New", startTime: 100 });
  assert.equal(tryDecryptEventEdit(enc, secret, "EV1", ["2@lid", "1@s.whatsapp.net"], ["1@s.whatsapp.net"])?.eventMessage?.name, "New");
  assert.equal(tryDecryptEventEdit(enc, secret, "EV1", ["2@lid"], ["1@s.whatsapp.net"]), undefined);
});
test("stub notices with me as actor or target", () => {
  assert.equal(describeStub(27, [], "You", ["Ben"])?.text, "You added Ben");
  assert.equal(describeStub(27, [], "You", ["A", "B", "C"])?.text, "You added A, B and C");
  assert.equal(describeStub(27, [], "Anna", ["You"])?.text, "Anna added you");
  assert.equal(describeStub(27, [], "", ["You"])?.text, "You were added");
  assert.equal(describeStub(27, [], "", ["Ben", "You"])?.text, "Ben and You were added");
  assert.equal(describeStub(28, [], "You", ["Ben"])?.text, "You removed Ben");
  assert.equal(describeStub(28, [], "Anna", ["You"])?.text, "Anna removed you");
  assert.equal(describeStub(28, [], "", ["You"])?.text, "You were removed");
  assert.equal(describeStub(32, [], "", ["Ben"])?.text, "Ben left");
  assert.equal(describeStub(32, [], "You", [])?.text, "You left");
  assert.equal(describeStub(31, [], "", ["You"])?.text, "You joined using an invite link");
  assert.equal(describeStub(31, [], "", ["Ben"])?.text, "Ben joined using the invite link");
  assert.equal(describeStub(29, [], "", ["You"])?.text, "You are now an admin");
  assert.equal(describeStub(166, [], "Anna", ["Ben"])?.text, "Anna added Ben");
  assert.equal(describeStub(27, [], "", [])?.text, "Someone was added");
});
