#!/usr/bin/env node
// End-to-end poll check for WhatsApp: UniChat (phone backend over DevTools) <-> the WhatsApp app on the same phone (over adb).
//   node scripts/live/polls-whatsapp.mjs --chat <chatId> --name "<chat name as WhatsApp shows it>"
// Steps: 1. single-choice poll from UniChat, vote A -> WhatsApp shows A=1   2. change the vote to B -> A=0, B=1   3. multiple-choice poll,
// vote A+B -> both 1, then un-vote A   4. vote in the WhatsApp app -> UniChat's tally shows it   5. a poll created in the WhatsApp app
// (not automated: creating one takes several screens) is voted on from UniChat when one exists.
import { Backend, until, sleep } from "./backend.mjs";
import * as phone from "./phone.mjs";

const args = process.argv.slice(2), opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const chatId = opt("--chat"), name = opt("--name");
if (!chatId || !name) { console.error("usage: --chat <chatId> --name <WhatsApp chat name>"); process.exit(2); }
const TAG = "[poll-test]";
const results = [];
const note = (what, ok, detail) => { results.push({ what, ok, detail }); console.log(`${ok ? "✔" : "✖"} ${what}${detail ? "  " + detail : ""}`); };

const foreground = async () => { phone.launch(phone.APPS.unichat); await sleep(1500); };
await foreground();
const b = await Backend.connect();
const msg = async (id) => (await b.call("history", { chatId, limit: 40, local: true })).find((m) => m.id === id);
const tally = (m) => m?.poll ? m.poll.options.map((o) => `${o.text}=${o.voters.length}${o.count !== undefined ? "/" + o.count : ""}`).join(" ") + ` mine=${JSON.stringify(m.poll.mine ?? [])}` : "(no poll)";
const uniVote = async (id, ids) => { await foreground(); await b.call("vote", { chatId, messageId: id, optionIds: ids }); };
const waVotes = async (pollName) => { // what the WhatsApp app shows for that poll (scrolled to the end of the chat)
  await phone.whatsappOpenChat(name);
  const nodes = await phone.waitFor((ns) => (phone.find(ns, pollName, "poll_name") ? ns : undefined), `poll "${pollName}" on the WhatsApp screen`, 20_000);
  const p = phone.whatsappMessages(nodes).filter((r) => r.kind === "poll" && r.text === pollName).pop();
  return Object.fromEntries(p.poll.options.map((o) => [o.text, o.votes]));
};

// 1. single choice
const q1 = `${TAG} single ${Date.now() % 100000}`;
let m1 = await b.call("send", { chatId, text: "", poll: { question: q1, options: ["A", "B"], multiple: false } });
m1 = await until(async () => { const m = await msg(m1.id); return m?.poll ? m : undefined; }, "poll in UniChat");
const optA = m1.poll.options[0].id, optB = m1.poll.options[1].id;
await uniVote(m1.id, [optA]); await sleep(4000);
let v = await waVotes(q1); note("single choice: vote A from UniChat reaches the WhatsApp app", v.A === 1 && v.B === 0, `WhatsApp shows A=${v.A} B=${v.B}; UniChat: ${tally(await msg(m1.id))}`);
// 2. change the vote
await uniVote(m1.id, [optB]); await sleep(4000);
v = await waVotes(q1); note("single choice: changing the vote to B", v.A === 0 && v.B === 1, `WhatsApp shows A=${v.A} B=${v.B}; UniChat: ${tally(await msg(m1.id))}`);
// 3. multiple choice
const q2 = `${TAG} multi ${Date.now() % 100000}`;
let m2 = await foreground().then(() => b.call("send", { chatId, text: "", poll: { question: q2, options: ["X", "Y", "Z"], multiple: true } }));
m2 = await until(async () => { const m = await msg(m2.id); return m?.poll ? m : undefined; }, "multi poll in UniChat");
const [oX, oY] = m2.poll.options.map((o) => o.id);
await uniVote(m2.id, [oX, oY]); await sleep(4000);
v = await waVotes(q2); note("multiple choice: X+Y from UniChat", v.X === 1 && v.Y === 1 && v.Z === 0, `WhatsApp shows X=${v.X} Y=${v.Y} Z=${v.Z}; UniChat: ${tally(await msg(m2.id))}`);
await uniVote(m2.id, [oY]); await sleep(4000);
v = await waVotes(q2); note("multiple choice: un-voting X", v.X === 0 && v.Y === 1, `WhatsApp shows X=${v.X} Y=${v.Y} Z=${v.Z}; UniChat: ${tally(await msg(m2.id))}`);
// 4. vote in the WhatsApp app (tap Z) -> UniChat
await phone.whatsappVote(q2, "Z");
await foreground();
try { const m = await until(async () => { const m = await msg(m2.id); const z = m?.poll?.options.find((o) => o.text === "Z"); return z && (z.voters.length || z.count) ? m : undefined; }, "the WhatsApp-app vote on Z to show in UniChat", 30_000); note("vote cast in the WhatsApp app shows in UniChat", true, tally(m)); }
catch (e) { note("vote cast in the WhatsApp app shows in UniChat", false, e.message + "; UniChat: " + tally(await msg(m2.id))); }
console.log(JSON.stringify(results));
b.close();
