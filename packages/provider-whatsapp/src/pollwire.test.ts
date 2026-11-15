// Poll traffic as the phone really sends it (key forms, device-sent copies, LID groups) + the counts-only diagnostics.
process.env.UNIMSG_DEBUG = "1"; // must be set before the provider module is evaluated
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { proto, decryptPollVote } from "@whiskeysockets/baileys";
import type { CoreEvent } from "@unimsg/core";

const { default: factory } = await import("./index.js");
const { encryptVote } = await import("./poll.js");
const oid = (n: string) => createHash("sha256").update(n).digest("hex");

const lines: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);
(process.stderr.write as unknown) = (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; };
process.on("exit", () => { process.stderr.write = realWrite; });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wa-pw-"));
  const c = factory.create({ accountId: "t", dataDir: dir });
  const p = c as any;
  const events: CoreEvent[] = [];
  p.emit = (e: CoreEvent) => events.push(e);
  p.auth = { creds: { me: { id: "491700000000:3@s.whatsapp.net", lid: "9000:3@lid" } } };
  return { c, p, events, done: () => { p.store.discard(); rmSync(dir, { recursive: true, force: true }); } };
}
const last = (re: RegExp) => lines.filter((l) => re.test(l)).at(-1) ?? "";
const SEC = new Uint8Array(32).fill(11);
const poll = (chat: string, id: string, extra: object, opts = ["Pizza", "Sushi"]) => ({
  key: { remoteJid: chat, id, fromMe: false, ...extra }, messageTimestamp: 10,
  message: { messageContextInfo: { messageSecret: SEC }, pollCreationMessage: { name: "Q", selectableOptionsCount: 1, options: opts.map((o) => ({ optionName: o })) } },
});

test("group poll by a LID-addressed participant; vote arrives with the voter's PN key while encrypted with the LID form", () => {
  const { p, events, done } = setup();
  try {
    const G = "120363@g.us", creator = "7001@lid", voterLid = "7002@lid", voterPn = "4916@s.whatsapp.net";
    p.store.data.lidToPn[voterLid] = voterPn;
    p.intake(poll(G, "P1", { participant: creator }), false);
    const enc = encryptVote(SEC, "P1", creator, voterLid, [oid("Sushi")]);
    events.length = 0;
    p.intake({ key: { remoteJid: G, id: "V1", fromMe: false, participant: voterPn }, messageTimestamp: 11, message: { pollUpdateMessage: { pollCreationMessageKey: { remoteJid: G, id: "P1", fromMe: false, participant: creator }, vote: enc, senderTimestampMs: 11_000 } } }, true);
    const u = events.find((e) => e.type === "message-update") as any;
    assert.deepEqual(u.data.patch.poll.options[1].voters, [voterPn]);
    assert.match(last(/poll-update in/), /fromMe=false chat=group creatorForm=lid voterForm=lid secret=have pollKnown=yes decrypt=ok options=1/);
  } finally { done(); }
});

test("own vote cast on the phone arrives device-sent (wrapped) with a LID key", () => {
  const { p, events, done } = setup();
  try {
    const DM = "4930@s.whatsapp.net";
    p.intake(poll(DM, "P2", {}), false);
    const enc = encryptVote(SEC, "P2", "4930@s.whatsapp.net", "491700000000@s.whatsapp.net", [oid("Pizza")]);
    events.length = 0;
    p.intake({ key: { remoteJid: DM, id: "V2", fromMe: true }, messageTimestamp: 12, message: { deviceSentMessage: { destinationJid: DM, message: { pollUpdateMessage: { pollCreationMessageKey: { remoteJid: DM, id: "P2", fromMe: false }, vote: enc, senderTimestampMs: 12_000 } } } } }, false);
    const u = events.find((e) => e.type === "message-update") as any;
    assert.deepEqual(u.data.patch.poll.mine, [oid("Pizza")]);
    assert.match(last(/poll-update in/), /fromMe=true chat=dm creatorForm=pn voterForm=pn secret=have pollKnown=yes decrypt=ok options=1/);
    assert.equal(lines.some((l) => /dropped:/.test(l)), false);
  } finally { done(); }
});

test("diagnostics pinpoint failures: unknown poll, missing secret, wrong key", () => {
  const { p, done } = setup();
  try {
    const G = "120363@g.us";
    const enc = encryptVote(SEC, "PX", "7001@lid", "7002@lid", [oid("Pizza")]);
    const vote = (id: string, pid: string, e = enc) => ({ key: { remoteJid: G, id, fromMe: false, participant: "7002@lid" }, messageTimestamp: 13, message: { pollUpdateMessage: { pollCreationMessageKey: { remoteJid: G, id: pid, fromMe: false }, vote: e, senderTimestampMs: 13_000 } } });
    p.intake(vote("V3", "PX"), true);
    assert.match(last(/poll-update in/), /pollKnown=no decrypt=deferred/);
    const nosecret = poll(G, "PN", { participant: "7001@lid" }); delete (nosecret.message as any).messageContextInfo;
    p.intake(nosecret, false);
    p.intake(vote("V4", "PN"), true);
    assert.match(last(/poll-update in/), /secret=missing pollKnown=yes decrypt=fail:no-secret/);
    p.intake(poll(G, "PW", { participant: "7001@lid" }), false);
    p.intake(vote("V5", "PW", encryptVote(new Uint8Array(32).fill(1), "PW", "7001@lid", "7002@lid", [oid("Pizza")])), true);
    assert.match(last(/poll-update in/), /decrypt=fail:no-key-match\(c=\d,v=\d\)/);
    assert.equal(lines.filter((l) => /poll-update in/.test(l)).every((l) => !/[0-9]{5,}@/.test(l)), true); // no ids in the output
  } finally { done(); }
});

test("outgoing vote has the shape the phone expects (stanza type poll, meta, sha256 bytes, keys per whatsmeow)", async () => {
  const { c, p, done } = setup();
  try {
    const relayed: any[] = [];
    p.opened = true;
    p.sock = { relayMessage: async (jid: string, msg: any, o: any) => { relayed.push([jid, msg, o]); return "x"; } };
    // 1) someone else's poll in a LID group (voter = my LID)
    const G = "120363@g.us", creator = "7001@lid";
    p.groups.set(G, { id: G, addressingMode: "lid", participants: [] });
    p.intake(poll(G, "P3", { participant: "7001:5@lid" }), false);
    await c.vote!(G, "P3", [oid("Pizza")]);
    let [jid, msg, o] = relayed[0];
    assert.equal(jid, G);
    assert.deepEqual(o.additionalAttributes, { type: "poll" });
    assert.deepEqual(o.additionalNodes, [{ tag: "meta", attrs: { polltype: "vote", content_type: "add_on" } }]);
    assert.deepEqual(msg.pollUpdateMessage.pollCreationMessageKey, { remoteJid: G, id: "P3", fromMe: false, participant: creator });
    const dec = decryptPollVote(msg.pollUpdateMessage.vote, { pollEncKey: Buffer.from(SEC), pollCreatorJid: creator, pollMsgId: "P3", voterJid: "9000@lid" });
    assert.equal(dec.selectedOptions![0]!.length, 32);                                  // sha256 bytes, not hex text
    assert.deepEqual(Buffer.from(dec.selectedOptions![0]!), createHash("sha256").update("Pizza").digest());
    // 2) my own poll in a DM: fromMe true, no participant, my PN
    p.sock.relayMessage = async (...a: any[]) => { relayed.push(a); return "x"; };
    const DM = "4930@s.whatsapp.net";
    const mine = p.intake({ key: { remoteJid: DM, id: "P4", fromMe: true }, messageTimestamp: 14, message: { messageContextInfo: { messageSecret: SEC }, pollCreationMessage: { name: "Q", selectableOptionsCount: 0, options: [{ optionName: "A" }, { optionName: "B" }] } } }, false);
    await c.vote!(DM, mine!.id, [oid("A"), oid("B")]);
    [jid, msg, o] = relayed[1];
    assert.deepEqual(msg.pollUpdateMessage.pollCreationMessageKey, { remoteJid: DM, id: "P4", fromMe: true });
    const dec2 = decryptPollVote(msg.pollUpdateMessage.vote, { pollEncKey: Buffer.from(SEC), pollCreatorJid: "9000@lid", pollMsgId: "P4", voterJid: "9000@lid" });
    assert.equal(dec2.selectedOptions!.length, 2);
    assert.match(last(/poll-vote out/), /chat=dm creatorForm=lid voterForm=lid secret=have options=2 relay=ok/);
    // relay failure is reported without content and surfaced
    p.sock.relayMessage = async () => { throw Object.assign(new Error("Connection Closed"), { name: "Boom" }); };
    await assert.rejects(c.vote!(DM, "P4", [oid("A")]), /not connected|Could not send the vote/);
    assert.match(last(/poll-vote out/), /relay=error:Boom/);
  } finally { done(); }
});
