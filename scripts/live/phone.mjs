// Driving the OTHER messenger apps on the phone over adb (the end-to-end half of the live tests): dump the screen (uiautomator),
// find a node by text / resource id, tap it, type, scroll. Apps that expose their messages to accessibility (WhatsApp, Mattermost,
// Discord, Threema) can be read like a DOM; Signal hides message text from it, so Signal is checked with screenshots.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const serial = process.env.ANDROID_SERIAL || "";
const adb = (...args) => execFileSync("adb", [...(serial ? ["-s", serial] : []), ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
export const shell = (cmd) => adb("shell", cmd);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unescape = (s) => s.replace(/&#10;/g, "\n").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** The current screen as a flat list of nodes { text, desc, id, cls, bounds: [x1,y1,x2,y2], cx, cy }. */
export function dump() {
  shell("uiautomator dump /sdcard/ui.xml >/dev/null 2>&1");
  const xml = adb("exec-out", "cat", "/sdcard/ui.xml");
  const out = [];
  for (const m of xml.matchAll(/<node[^>]*>/g)) {
    const n = m[0], attr = (k) => { const r = new RegExp(` ${k}="([^"]*)"`).exec(n); return r ? unescape(r[1]) : ""; };
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr("bounds")); if (!b) continue;
    const bounds = b.slice(1, 5).map(Number);
    out.push({ text: attr("text"), desc: attr("content-desc"), id: attr("resource-id").split("/").pop(), cls: attr("class"), bounds, cx: (bounds[0] + bounds[2]) >> 1, cy: (bounds[1] + bounds[3]) >> 1 });
  }
  return out;
}
/** First node whose text or description contains `text` (string or RegExp), optionally with that resource id. */
export const find = (nodes, text, id) => nodes.find((n) => (!id || n.id === id) && (text instanceof RegExp ? text.test(n.text) || text.test(n.desc) : n.text.includes(text) || n.desc.includes(text)));
export const byId = (nodes, id) => nodes.filter((n) => n.id === id);
export const tap = (n) => shell(`input tap ${n.cx} ${n.cy}`);
export const tapXY = (x, y) => shell(`input tap ${x} ${y}`);
export const back = () => shell("input keyevent KEYCODE_BACK");
export const home = () => shell("input keyevent KEYCODE_HOME");
export const scrollUp = () => shell("input swipe 540 700 540 1900 500");
export const scrollDown = () => shell("input swipe 540 1900 540 700 500");
/** Types text into the focused field (adb's input text: spaces and a few symbols need escaping). */
export const type = (s) => shell(`input text ${JSON.stringify(s.replace(/ /g, "%s"))}`);
export const launch = (component) => shell(`am start -n ${component} >/dev/null 2>&1`);
export const screenshot = (file) => { const png = execFileSync("adb", [...(serial ? ["-s", serial] : []), "exec-out", "screencap", "-p"], { maxBuffer: 64 << 20 }); writeFileSync(file, png); return file; };
/** Poll the screen until `pred(nodes)` returns something truthy. */
export async function waitFor(pred, what, ms = 15_000) {
  const t0 = Date.now();
  for (;;) { const r = pred(dump()); if (r) return r; if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what} on the phone screen`); await sleep(800); }
}

export const APPS = {
  whatsapp: "com.whatsapp/.Main",
  signal: "org.thoughtcrime.securesms/.RoutingActivity",
  discord: "com.discord/.main.MainDefault",
  mattermost: "com.mattermost.rn/.MainActivity",
  threema: "ch.threema.app/.activities.HomeActivity",
  unichat: "app.unimsg.android/.MainActivity",
};

/** WhatsApp: open the chat called `name` through the search box and return once its message list is up. */
export async function whatsappOpenChat(name) {
  launch(APPS.whatsapp); await sleep(2500);
  let nodes = dump();
  for (let i = 0; i < 3 && !find(nodes, "Ask Meta AI or Search"); i++) { back(); await sleep(800); nodes = dump(); } // leave an open chat first
  tap(find(nodes, "Ask Meta AI or Search")); await sleep(800); type(name); await sleep(1500);
  const row = await waitFor((ns) => byId(ns, "conversations_row_contact_name").find((n) => n.text === name), `the chat "${name}" in the search results`);
  tap(row);
  await waitFor((ns) => byId(ns, "entry").length > 0, "the conversation to open");
}
/** WhatsApp: the messages currently on screen, newest last: { text, kind, poll?: { name, options: [{ text, votes }] } , edited, deleted, forwarded, quoted }. */
export function whatsappMessages(nodes = dump()) {
  const rows = [];
  const sorted = [...nodes].sort((a, b) => a.bounds[1] - b.bounds[1]);
  let poll;
  for (const n of sorted) {
    if (n.id === "poll_name") { poll = { name: n.text, options: [] }; rows.push({ kind: "poll", text: n.text, poll }); }
    else if (n.id === "poll_option_name" && poll) poll.options.push({ text: n.text, votes: 0 });
    else if (n.id === "poll_option_vote_count" && poll?.options.length) poll.options[poll.options.length - 1].votes = Number(n.text) || 0;
    else if (n.id === "message_text") rows.push({ kind: "text", text: n.text });
    else if (n.id === "edit_label" && rows.length) rows[rows.length - 1].edited = true;
    else if (n.id === "quoted_text" ) rows.push({ kind: "quote", text: n.text });
    else if (n.id === "conversation_row_top_text_attribute" && /Forwarded/.test(n.text)) rows.push({ kind: "forwarded" });
    else if (n.id === "info") rows.push({ kind: "info", text: n.text });
    else if (n.id === "place_name") rows.push({ kind: "location", text: n.text });
    else if (n.id === "vcard_text") rows.push({ kind: "contact", text: n.text });
    else if (n.id === "event_name") rows.push({ kind: "event", text: n.text });
    else if (n.id === "title" && n.cls.endsWith("TextView")) rows.push({ kind: "preview", text: n.text });
    else if (/^(image|video|voice|audio|document|gif)/i.test(n.desc) || n.id === "file_type") rows.push({ kind: "media", text: n.desc || n.text });
  }
  return rows;
}
/** WhatsApp: tap the poll option `optionText` of the poll called `pollName` that is on screen. */
export async function whatsappVote(pollName, optionText) {
  const nodes = await waitFor((ns) => (find(ns, pollName, "poll_name") ? ns : undefined), `the poll "${pollName}"`);
  const p = find(nodes, pollName, "poll_name");
  const opt = byId(nodes, "poll_option_name").filter((n) => n.bounds[1] > p.bounds[1]).find((n) => n.text === optionText);
  if (!opt) throw new Error(`option "${optionText}" not on screen`);
  tap(opt); await sleep(1500);
}
