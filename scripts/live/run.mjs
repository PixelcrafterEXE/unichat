#!/usr/bin/env node
// Live feature tests against REAL messenger accounts, through a running UniChat (the Android app over adb, or the desktop app).
//
//   adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell pidof app.unimsg.android)   # debug APK: WebView DevTools is on
//   node scripts/live/run.mjs [--only whatsapp,signal] [--skip pin,poll] [--chat whatsapp=<chatId>] [--devtools http://127.0.0.1:9333]
//
// Rules the suite follows: it only ever writes into chats where the account is the ONLY member (a "Note to Self" style chat, a group it
// created without other members, a channel in a server/community that has no other member) or into a chat given with --chat. Nobody else
// receives a test message. Groups it creates are called "UniChat live test" and are reused on the next run.
//
// Every check records one row of docs/live-results.json: feature id x provider -> { status: verified | failed | unsupported | skipped, at, note }.
// `scripts/feature-table.mjs` turns that file (plus the manual records in it) into the README feature table. See issue #66.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Backend, sleep, until } from "./backend.mjs";
import { FEATURES } from "./features.mjs";

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, "..", "..");
const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const only = opt("--only")?.split(",").filter(Boolean), skip = new Set((opt("--skip") ?? "").split(",").filter(Boolean));
const forced = Object.fromEntries(args.flatMap((a, i) => (a === "--chat" ? [args[i + 1].split("=")] : [])));
const onlyFeatures = opt("--feature")?.split(",").filter(Boolean); // run just these checks (others are left untouched in the results)
const outFile = opt("--out") ?? join(root, "docs", "live-results.json");
const fixtures = (n) => readFileSync(join(here, "fixtures", n));
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const TAG = "[live-test]";
const stamp = new Date().toISOString();

// docs/live-results.json is committed, so nothing identifying may reach it: account ids, chat ids, phone numbers, Signal
// UUIDs and @-handles are replaced by placeholders. Which chat each provider writes into is remembered in a git-ignored
// file next to the repository instead (targetsFile).
const scrub = (s) => String(s)
  .replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){0,4}(-[0-9a-f]{1,12})?\b/gi, "<uuid>") // also a UUID cut in half by truncation
  .replace(/\b[a-z-]+-[0-9a-f]{8}:\S*/gi, "<chat>")
  .replace(/\b\d[\d\s-]{6,}\d(@[\w.]+)?\b/g, "<number>")
  .replace(/\b[0-9a-z]{20,}\b/gi, "<id>")
  .replace(/@[\w.-]{3,}/g, "<handle>");
const targetsFile = opt("--targets") ?? join(root, ".live-targets.json");
const results = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : { results: {}, runs: [] };
results.results ??= {}; results.runs ??= [];
delete results.targets; // older runs stored chat ids here
const targets = existsSync(targetsFile) ? JSON.parse(readFileSync(targetsFile, "utf8")) : {};
const known = new Set(FEATURES.map((f) => f.id));
function record(feature, provider, status, note) {
  if (!known.has(feature)) throw new Error("unknown feature id " + feature);
  (results.results[feature] ??= {})[provider] = { status, at: stamp, ...(note ? { note: scrub(note).slice(0, 300) } : {}) };
  const mark = { verified: "✔", failed: "✖", unsupported: "–", skipped: "·" }[status];
  console.log(`  ${mark} ${feature.padEnd(22)} ${status}${note ? "  " + String(note).slice(0, 160) : ""}`);
}
function save() { mkdirSync(dirname(outFile), { recursive: true }); writeFileSync(outFile, JSON.stringify(results, null, 1) + "\n"); writeFileSync(targetsFile, JSON.stringify(targets, null, 1) + "\n"); }

const b = await Backend.connect(opt("--devtools") ?? "http://127.0.0.1:9333");
console.log(`connected (${b.kind} transport)`);
const snapshot = async () => b.call("snapshot");
let snap = await snapshot();
const accounts = snap.accounts.filter((a) => a.state === "connected" && (!only || only.includes(a.provider)));
if (!accounts.length) { console.error("no connected account matches"); process.exit(2); }
results.runs.push({ at: stamp, transport: b.kind, accounts: accounts.map((a) => a.provider) });
if (results.runs.length > 20) results.runs.splice(0, results.runs.length - 20);

/** Members of a chat as the backend reports them; `selfOnly` = nobody but this account is in it. */
async function membersOf(chatId) { try { return await b.call("members", { chatId }); } catch { return undefined; } }
const isSelfOnly = (list, selfIds) => Array.isArray(list) && list.length <= 1 && (list.length === 0 || list[0].name === "You" || selfIds.has(list[0].id));

for (const acct of accounts) {
  const P = acct.provider, caps = acct.capabilities ?? {}, A = acct.id;
  console.log(`\n== ${P} (${A})`);
  const myChats = () => snap.chats.filter((c) => c.accountId === A);
  const has = (cap) => !!caps[cap];
  const sup = (feature, cap, what) => { if (!has(cap)) { record(feature, P, "unsupported", `capability ${cap} is off`); return false; } if (skip.has(feature)) { record(feature, P, "skipped", "--skip"); return false; } return true; };
  const UNSUPPORTED = "unsupported by capability";
  const tryStep = async (feature, fn) => { if (onlyFeatures && !onlyFeatures.includes(feature)) return false; if (skip.has(feature)) return record(feature, P, "skipped", "--skip"); try { const note = await fn(); record(feature, P, note === UNSUPPORTED ? "unsupported" : "verified", note); return note !== UNSUPPORTED; } catch (e) { record(feature, P, "failed", e.message.split("\n")[0]); return false; } };
  // names under which this account appears in member lists (so a chat whose only member is us counts as "nobody else in it")
  const selfNames = new Set(["You"]);
  try { const p = await b.call("getProfile", { accountId: A }); for (const n of [p?.displayName, p?.name, p?.handle, p?.handle?.replace(/^@/, "")]) if (n) selfNames.add(n); } catch { /* no profile: "You" only */ }
  const fresh = async (chatId, limit = 40) => b.call("history", { chatId, limit, local: true });
  const findMsg = async (chatId, id) => (await fresh(chatId)).find((m) => m.id === id);
  const waitMsg = (chatId, id, pred, what, ms = 25_000) => until(async () => { const m = await findMsg(chatId, id); return m && pred(m) ? m : undefined; }, what, ms);

  // ---- 1. where may we write? ----
  let target = forced[P] ?? targets[P]?.chatId, targetNote = forced[P] ? "given with --chat" : "from the last run";
  if (target && !myChats().some((c) => c.id === target)) target = undefined;
  if (!target) {
    const self = myChats().find((c) => c.kind === "dm" && /^note to self$/i.test(c.name));
    const selfIds = new Set();
    const candidates = [];
    for (const c of myChats()) {
      if (/live test/i.test(c.name) || /^test2?$/i.test(c.name) || c === self) {
        const m = await membersOf(c.id);
        if (c === self || isSelfOnly(m, selfIds)) candidates.push(c);
      }
    }
    const pick = candidates.find((c) => /live test/i.test(c.name)) ?? candidates.find((c) => c.kind !== "dm") ?? candidates[0];
    if (pick) { target = pick.id; targetNote = `${pick.kind} "${pick.name}" (only member: this account)`; }
  }
  if (!target && P === "mattermost" && has("startChat")) { // Mattermost lets you message yourself: a direct channel with only this account in it
    try { const p = await b.call("getProfile", { accountId: A }); const c = await b.call("startChat", { accountId: A, handle: p.handle }); target = c.id; targetNote = `direct message with myself (${p.handle})`; snap = await snapshot(); } catch (e) { console.log("  (no self chat: " + e.message + ")"); }
  }
  if (!target && has("createGroup")) {
    try { const c = await b.call("createGroup", { accountId: A, name: "UniChat live test", handles: [] }); target = c.id; targetNote = `created group "${c.name}"`; snap = await snapshot(); }
    catch (e) { console.log("  (cannot create a members-free group: " + e.message + ")"); }
  }
  if (!target) { console.log(`  no safe chat to write into (give one with --chat ${P}=<chatId>); read-only checks only`); }
  else { targets[P] = { chatId: target, note: targetNote }; console.log(`  target: ${target}  ${targetNote}`); }
  const chat = () => snap.chats.find((c) => c.id === target);

  // ---- 2. account-level, read-only ----
  await tryStep("profile-pictures", async () => {
    const withPic = myChats().filter((c) => c.avatarUrl || c.kind === "dm").slice(0, 6);
    let got = 0; for (const c of withPic) { const r = await b.call("avatar", { kind: "chat", id: c.id }).catch(() => null); if (r?.dataBase64) got++; }
    if (!got) throw new Error(`no picture for any of ${withPic.length} chats tried`); return `${got}/${withPic.length} chats returned a picture`;
  });
  if (sup("profile", "profile")) await tryStep("profile", async () => {
    const p = await b.call("getProfile", { accountId: A });
    const name = p.displayName ?? p.name; if (!name && !p.about) throw new Error("profile came back empty: " + JSON.stringify(p).slice(0, 120));
    if (P !== "discord" && name) { const q = await b.call("updateProfile", { accountId: A, displayName: name }); if ((q.displayName ?? q.name) !== name) throw new Error("display name changed by a no-op update"); return `read name/about; update with the same name accepted`; }
    return "read only (no-op update not attempted on " + P + ")";
  });
  if (sup("privacy", "privacy")) await tryStep("privacy", async () => { const l = await b.call("getPrivacy", { accountId: A }); if (!Array.isArray(l) || !l.length) throw new Error("no settings returned"); return `${l.length} settings read: ${l.map((s) => s.id).slice(0, 5).join(", ")}`; });
  await tryStep("spaces", async () => { if (!has("spaces")) return "unsupported by capability"; const n = (snap.spaces ?? []).filter((s) => s.id.startsWith(A + ":")).length; if (!n) throw new Error("no community listed"); return `${n} communities listed`; });
  await tryStep("groups-receive", async () => { const g = myChats().filter((c) => c.kind === "group" || c.kind === "channel"); if (!g.length) throw new Error("no group chat listed"); const named = g.filter((c) => c.name).length; return `${g.length} groups/channels listed, ${named} with a name`; });
  await tryStep("history-older", async () => {
    if (!has("backfill")) return "unsupported by capability";
    const big = myChats().filter((c) => c.id !== target && c.lastMessageAt).sort((x, y) => (y.lastMessageAt ?? "").localeCompare(x.lastMessageAt ?? ""))[0];
    if (!big) throw new Error("no chat to page through");
    const first = await b.call("history", { chatId: big.id, limit: 20 }); if (!first.length) throw new Error("empty history");
    const oldest = first.reduce((a, m) => (m.time < a.time ? m : a));
    const more = await b.call("history", { chatId: big.id, limit: 20, beforeMessageId: oldest.id }, 120_000);
    const older = more.filter((m) => m.time < oldest.time).length; if (!older) throw new Error(`nothing older than ${oldest.time} came back (${more.length} rows)`);
    return `${older} older messages paged in "${big.name}"`;
  });
  const hits = async (query) => { const r = await b.call("searchAll", { query, limit: 5 }); return r?.total ?? (r?.groups ?? []).reduce((n, g) => n + (g.hits?.length ?? g.messages?.length ?? 0), 0); };
  await tryStep("search", async () => { const n = await hits("the"); if (!n) throw new Error("no hit for 'the'"); return `${n} hits`; });

  if (!target) { save(); continue; }

  // ---- 3. messages in the target chat ----
  const sent = {};
  const send = async (params, what) => { const m = await b.call("send", { chatId: target, ...params }); if (!m?.id) throw new Error(`send returned no message (${what})`); return m; };
  const settled = (m) => m.status && m.status !== "sending" && m.status !== "failed";
  if (await tryStep("send-text", async () => {
    const text = `${TAG} text ${Date.now()}`; const m = await send({ text }, "text"); sent.text = m;
    const got = await waitMsg(target, m.id, (x) => settled(x) || !x.status, "the message to be accepted by the service");
    sent.text = got; return `status ${got.status ?? "(none)"}, id ${got.id.slice(0, 24)}`;
  })) {
    await tryStep("live-updates", async () => {
      const ev = await b.events(); const mine = ev.filter((e) => (e.event === "message" || e.event === "message-update" || e.event === "receipt") && (e.data?.chatId === target || e.data?.message?.chatId === target));
      if (!mine.length) throw new Error("no message/receipt event for the chat reached the UI"); return `${mine.length} events (${[...new Set(mine.map((e) => e.event))].join(", ")})`;
    });
  }
  if (sup("replies", "replies")) await tryStep("replies", async () => { const m = await send({ text: `${TAG} reply`, replyToMessageId: sent.text.id }, "reply"); const got = await waitMsg(target, m.id, (x) => !!x.replyTo, "the reply to carry its quote"); return `quotes ${got.replyTo.messageId === sent.text.id ? "the right message" : "another id: " + got.replyTo.messageId}`; });
  if (sup("reactions", "reactions")) await tryStep("reactions", async () => {
    await b.call("react", { chatId: target, messageId: sent.text.id, emoji: "👍" });
    await waitMsg(target, sent.text.id, (x) => x.reactions?.some((r) => r.emoji === "👍"), "the reaction to show on the message");
    await b.call("react", { chatId: target, messageId: sent.text.id, emoji: null });
    await waitMsg(target, sent.text.id, (x) => !x.reactions?.some((r) => r.emoji === "👍"), "the reaction to be removed again");
    return "added 👍 and removed it";
  });
  if (sup("edit", "edits")) await tryStep("edit", async () => { const m = await send({ text: `${TAG} before edit` }, "edit"); await waitMsg(target, m.id, settled, "accepted"); await b.call("edit", { chatId: target, messageId: m.id, text: `${TAG} after edit` }); const got = await waitMsg(target, m.id, (x) => x.text.includes("after edit"), "the edited text"); sent.edited = got; return `editedAt ${got.editedAt ? "set" : "missing"}`; });
  if (sup("delete", "deletes")) await tryStep("delete", async () => { const m = await send({ text: `${TAG} to delete` }, "delete"); await waitMsg(target, m.id, settled, "accepted"); await b.call("delete", { chatId: target, messageId: m.id }); await waitMsg(target, m.id, (x) => x.deleted === true, "the message to be marked deleted"); return "deleted for everyone"; });
  if (sup("pin", "pinMessages")) await tryStep("pin", async () => {
    await b.call("pin", { chatId: target, messageId: sent.text.id, pinned: true });
    await waitMsg(target, sent.text.id, (x) => x.pinned === true, "pinned flag");
    const pins = await b.call("pins", { chatId: target }); if (!pins.some((p) => p.id === sent.text.id)) throw new Error("pins() does not list it");
    await b.call("pin", { chatId: target, messageId: sent.text.id, pinned: false }); await waitMsg(target, sent.text.id, (x) => !x.pinned, "unpinned");
    return "pinned, listed, unpinned";
  });
  if (sup("typing", "typing")) await tryStep("typing", async () => { await b.call("setTyping", { chatId: target, typing: true }); await sleep(800); await b.call("setTyping", { chatId: target, typing: false }); return "start/stop accepted by the service (nobody else in the chat to see it)"; });
  await tryStep("mark-read", async () => { if (!has("readReceipts") && !has("markRead")) return "unsupported by capability"; const r = await b.call("markChatRead", { chatId: target }); if (r && r.result === "failed") throw new Error(JSON.stringify(r)); return `markChatRead -> ${JSON.stringify(r ?? "ok").slice(0, 80)}`; });

  const media = async (feature, file, kind, mime, extra = {}) => tryStep(feature, async () => {
    const data = fixtures(file); const m = await send({ text: "", attachments: [{ kind, mime, name: file, dataBase64: data.toString("base64"), ...extra }] }, file);
    const got = await waitMsg(target, m.id, (x) => x.attachments?.length && (settled(x) || !x.status), "the attachment message", 60_000);
    const a = got.attachments[0]; const d = await b.call("attachment", { chatId: target, messageId: got.id, attachmentId: a.id }, 90_000);
    const bytes = Buffer.from(d.dataBase64, "base64"); if (!bytes.length) throw new Error("download returned 0 bytes");
    return `${a.kind} ${a.mime}, ${data.length} B up, ${bytes.length} B down${sha(bytes) === sha(data) ? " (identical)" : " (re-encoded by the service)"}`;
  });
  if (sup("send-media", "attachments")) { await media("send-media", "photo.jpg", "image", "image/jpeg", { width: 320, height: 240 }); await media("send-file", "note.txt", "file", "text/plain"); await media("send-video", "video.mp4", "video", "video/mp4", { width: 160, height: 120, durationMs: 2000 }); }
  if (sup("send-voice", "voiceNotes")) await media("send-voice", "voice.ogg", "voice", "audio/ogg; codecs=opus", { durationMs: 2000, waveform: Array.from({ length: 64 }, (_, i) => 20 + (i % 7) * 10) });
  if (sup("gif", "attachments")) await media("gif", "anim.gif", "image", "image/gif", { width: 120, height: 90 });
  if (sup("polls", "polls")) await tryStep("polls", async () => {
    const m = await send({ text: "", poll: { question: `${TAG} poll`, options: ["A", "B"], multiple: false } }, "poll");
    const got = await waitMsg(target, m.id, (x) => x.poll?.options?.length === 2, "the poll");
    if (has("pollVote") || caps.pollVote === undefined) { await b.call("vote", { chatId: target, messageId: m.id, optionIds: [got.poll.options[0].id] }); const v = await waitMsg(target, m.id, (x) => x.poll?.mine?.length || x.poll?.options?.[0]?.voters?.length || x.poll?.options?.[0]?.count, "my vote to show", 30_000); return `poll shown, vote on "${v.poll.options[0].text}" reflected`; }
    return "poll shown (voting not offered)";
  });
  if (sup("location", "location")) await tryStep("location", async () => { const m = await send({ text: "", location: { lat: 53.4627, lng: 9.9693, name: "TUHH" } }, "location"); await waitMsg(target, m.id, (x) => !!x.location, "the location"); return "location message round trip"; });
  if (sup("contact-cards", "contactCards")) await tryStep("contact-cards", async () => { const m = await send({ text: "", contacts: [{ name: "Live Test", phones: ["+49 40 428780"] }] }, "contact"); await waitMsg(target, m.id, (x) => x.contacts?.length, "the contact card"); return "contact card round trip"; });
  if (sup("events", "events") && P === "whatsapp") await tryStep("events", async () => { const start = new Date(Date.now() + 86_400_000).toISOString(); const m = await send({ text: "", event: { name: `${TAG} event`, start, place: "TUHH" } }, "event"); await waitMsg(target, m.id, (x) => x.card || x.cards?.length, "the event card"); return "event card round trip"; });
  if (sup("mentions", "mentions")) await tryStep("mentions", async () => {
    const list = await membersOf(target); const me = list?.find((x) => x.name === "You") ?? list?.[0]; if (!me) throw new Error("no member to mention");
    const text = `${TAG} hi @${me.name}`; const m = await send({ text, mentions: [{ id: me.id, name: me.name, start: text.indexOf("@"), length: me.name.length + 1 }] }, "mention");
    await waitMsg(target, m.id, settled, "accepted"); return `mention of ${me.name} accepted`;
  });
  await tryStep("link-preview", async () => { const m = await send({ text: `${TAG} https://www.tuhh.de/` }, "link"); const got = await waitMsg(target, m.id, (x) => x.card || x.cards?.length || settled(x), "the link message", 30_000); if (!(got.card || got.cards?.length)) throw new Error("sent, but no preview card attached"); return "preview card attached"; });
  if (sup("forward", "replies")) await tryStep("forward", async () => { const r = await b.call("forward", { message: sent.text, toChatId: target }); const id = r?.id ?? r?.message?.id; if (!id) throw new Error("forward returned no message"); const got = await waitMsg(target, id, (x) => settled(x) || !x.status, "the forwarded copy"); return `forwarded copy ${got.forwarded ? "flagged as forwarded" : "(no forwarded flag)"}`; });
  await tryStep("schedule", async () => { const r = await b.call("scheduleMessage", { chatId: target, text: `${TAG} scheduled`, at: Date.now() + 4000 }); await until(async () => (await fresh(target)).some((m) => m.text === `${TAG} scheduled` && settled(m)), "the scheduled message to go out", 40_000); return `job ${JSON.stringify(r).slice(0, 40)} went out`; });
  if (sup("disappearing", "disappearing")) await tryStep("disappearing", async () => {
    const secs = (caps.disappearingDurations ?? [86400])[0]; await b.call("setDisappearing", { chatId: target, seconds: secs });
    await until(async () => { snap = await snapshot(); return chat()?.disappearing === secs; }, `the chat to show a ${secs} s timer`, 30_000);
    await b.call("setDisappearing", { chatId: target, seconds: 0 }); await until(async () => { snap = await snapshot(); return !chat()?.disappearing; }, "the timer to be off again", 30_000);
    return `timer set to ${secs} s and switched off again`;
  });
  if (sup("refresh-chat", "refreshChat")) await tryStep("refresh-chat", async () => { const r = await b.call("refreshChat", { chatId: target }, 120_000); return `refresh -> ${JSON.stringify(r).slice(0, 80)}`; });
  if (sup("fetch-history", "fetchHistory")) await tryStep("fetch-history", async () => { const r = await b.call("fetchHistory", { accountId: A, chatIds: [target], days: 2, wait: true }, 180_000); const res = r.result ?? r; if (res?.failed && !res?.fetched && !res?.messages) throw new Error(JSON.stringify(res).slice(0, 120)); return JSON.stringify(res).slice(0, 100); });
  await tryStep("search-own", async () => { const q = sent.text?.text?.split(" ").pop(); if (!q) return UNSUPPORTED; // nothing was sent in this run (--feature): not a result await until(async () => (await hits(q)) > 0, "the archive search to find the test message", 20_000); return "found by full-text search"; });

  // ---- 4. group management on the test group (never on a chat with other people) ----
  const c0 = chat();
  const ownGroup = c0 && c0.kind !== "dm" && isSelfOnly(await membersOf(target), new Set());
  if (sup("rename-group", "renameChat")) await tryStep("rename-group", async () => { if (!ownGroup) throw new Error("the target is not a group of our own"); const old = c0.name; await b.call("renameChat", { chatId: target, name: old + " ✓" }); await until(async () => { snap = await snapshot(); return chat()?.name === old + " ✓"; }, "the new name", 30_000); await b.call("renameChat", { chatId: target, name: old }); await until(async () => { snap = await snapshot(); return chat()?.name === old; }, "the old name back", 30_000); return "renamed and restored"; });
  if (sup("group-description", "chatDescription")) await tryStep("group-description", async () => { if (!ownGroup) throw new Error("the target is not a group of our own"); const t = `${TAG} description ${Date.now()}`; await b.call("setChatDescription", { chatId: target, text: t }); await until(async () => { snap = await snapshot(); return chat()?.description === t; }, "the description", 30_000); return "description set and shown"; });
  if (sup("group-picture", "chatPicture")) await tryStep("group-picture", async () => { if (!ownGroup) throw new Error("the target is not a group of our own"); const before = (await b.call("avatar", { kind: "chat", id: target }).catch(() => null))?.dataBase64 ?? ""; await b.call("setChatPicture", { chatId: target, dataBase64: fixtures("photo.jpg").toString("base64"), mime: "image/jpeg" }); const after = await until(async () => { const r = await b.call("avatar", { kind: "chat", id: target }).catch(() => null); return r?.dataBase64 && r.dataBase64 !== before ? r : undefined; }, "a new group picture", 40_000); return `picture set (${Buffer.from(after.dataBase64, "base64").length} B)`; });
  if (sup("create-group", "createGroup")) await tryStep("create-group", async () => {
    let c; try { c = await b.call("createGroup", { accountId: A, name: "UniChat live test (leave)", handles: [] }); } catch (e) { if (/at least one|member/i.test(e.message)) throw new Error("needs another member: " + e.message); throw e; }
    if (!c?.id) throw new Error("no chat returned"); snap = await snapshot();
    if (has("leaveChat")) { await b.call("leaveChat", { chatId: c.id }); await until(async () => { snap = await snapshot(); const x = snap.chats.find((y) => y.id === c.id); return !x || x.readOnly || x.offline; }, "the left group to disappear or go read-only", 30_000).catch(() => {}); record("leave-group", P, "verified", "left the throwaway group"); }
    return `created "${c.name}"` + (has("leaveChat") ? " and left it" : "");
  }); else record("leave-group", P, has("leaveChat") ? "skipped" : "unsupported", "needs create-group");
  if (has("manageMembers")) record("members", P, "skipped", "adding / removing other people is not done by the live test");
  save();
}
console.log(`\nresults written to ${outFile}`);
b.close();
