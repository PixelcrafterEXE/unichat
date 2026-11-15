// Poll creation wire format (real Baileys content builder), vote bookkeeping (replacement/ordering) and voter-form handling. Offline.
process.env.UNIMSG_DEBUG = "1";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { generateWAMessageContent } from "@whiskeysockets/baileys";
import type { CoreEvent } from "@unimsg/core";
import { applyVote, buildPoll, encryptVote, tryDecryptVote, tryDecryptVoteEx } from "./poll.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { default: factory } = await import("./index.js");
const oid = (n: string) => createHash("sha256").update(n).digest("hex");
const realWrite = process.stderr.write.bind(process.stderr);
(process.stderr.write as unknown) = () => true; // debug lines are not under test here
process.on("exit", () => { process.stderr.write = realWrite; });

const sp = (multiple = false) => ({ secret: "", question: "Q", multiple, options: [{ id: oid("A"), text: "A" }, { id: oid("B"), text: "B" }, { id: oid("C"), text: "C" }], votes: {} as Record<string, { o: string[]; t: number }> });

test("creation: single choice builds V3 with count 1, multiple builds v1 with count 0; secret rides in messageContextInfo", async () => {
  const mk = (selectableCount: number, secret = randomBytes(32)) => generateWAMessageContent({ poll: { name: "Q", values: ["A", "B", "C"], selectableCount, messageSecret: secret } } as any, {} as any).then((m) => ({ m, secret }));
  const one = await mk(1);
  assert.equal(one.m.pollCreationMessageV3?.selectableOptionsCount, 1);
  assert.ok(!one.m.pollCreationMessage);
  assert.deepEqual(one.m.pollCreationMessageV3?.options?.map((o) => o.optionName), ["A", "B", "C"]);
  assert.deepEqual(Buffer.from(one.m.messageContextInfo!.messageSecret!), one.secret);
  assert.equal(one.m.messageContextInfo!.messageSecret!.length, 32);
  const many = await mk(0);
  assert.equal(many.m.pollCreationMessage?.selectableOptionsCount, 0);
  assert.ok(!many.m.pollCreationMessageV3);
  await assert.rejects(mk(4), /selectableCount/); // more selectable than options is refused by Baileys
});

test("option ids are sha256(optionName) hex, as the phone computes them for the vote payload", () => {
  const m = sp(); const p = buildPoll({ ...m, secret: "x" }, "me");
  assert.deepEqual(p.options.map((o) => o.id), [oid("A"), oid("B"), oid("C")]);
  assert.equal(p.options[0]!.id.length, 64);
});

test("applyVote: newer replaces, equal/older ignored, empty vote clears, unknown option ids dropped", () => {
  const s = sp();
  assert.equal(applyVote(s, "v", [oid("A")], 10), true);
  assert.equal(applyVote(s, "v", [oid("B")], 10), false);  // same timestamp: first wins
  assert.equal(applyVote(s, "v", [oid("B")], 5), false);   // late-arriving older vote
  assert.deepEqual(s.votes.v, { o: [oid("A")], t: 10 });
  assert.equal(applyVote(s, "v", [oid("B"), "deadbeef"], 11), true);
  assert.deepEqual(s.votes.v!.o, [oid("B")]);
  assert.equal(applyVote(s, "v", [], 12), true);            // retraction
  assert.deepEqual(s.votes.v!.o, []);
  assert.equal(buildPoll({ ...s, secret: "x" }, "v").mine, undefined);
});

test("buildPoll: tallies per option, mine only for self, closed without secret, multiple voters", () => {
  const s = sp(true);
  applyVote(s, "me", [oid("A"), oid("C")], 1); applyVote(s, "x", [oid("A")], 1); applyVote(s, "y", [], 1);
  const p = buildPoll({ ...s, secret: "k" }, "me");
  assert.deepEqual(p.options.map((o) => o.voters), [["me", "x"], [], ["me"]]);
  assert.deepEqual(p.mine, [oid("A"), oid("C")]);
  assert.equal(p.multiple, true); assert.equal(p.closed, undefined);
  assert.equal(buildPoll(s, "me").closed, true);
});

test("tryDecryptVote finds the matching creator/voter form among PN/LID candidates", () => {
  const SEC = randomBytes(32);
  const enc = encryptVote(SEC, "P", "7001@lid", "4916@s.whatsapp.net", [oid("B"), oid("A")]);
  const hit = tryDecryptVoteEx(enc, SEC, "P", ["4915@s.whatsapp.net", "7001@lid"], ["7002@lid", "4916@s.whatsapp.net"]);
  assert.deepEqual(hit, { options: [oid("B"), oid("A")], creator: "7001@lid", voter: "4916@s.whatsapp.net" }); // multi-select keeps order and 32-byte ids
  assert.equal(tryDecryptVote(enc, SEC, "P", ["7001@lid"], ["7002@lid"]), undefined);       // wrong voter form
  assert.equal(tryDecryptVote(enc, SEC, "OTHER", ["7001@lid"], ["4916@s.whatsapp.net"]), undefined); // wrong message id
  assert.equal(tryDecryptVote(enc, randomBytes(32), "P", ["7001@lid"], ["4916@s.whatsapp.net"]), undefined);
  assert.equal(tryDecryptVote(enc, SEC, "P", [], []), undefined);
  assert.deepEqual(tryDecryptVote(encryptVote(SEC, "P", "a@lid", "b@lid", []), SEC, "P", ["a@lid"], ["b@lid"]), []); // retraction decrypts to no options
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wa-pw2-"));
  const p = factory.create({ accountId: "t", dataDir: dir }) as any;
  const events: CoreEvent[] = [];
  p.emit = (e: CoreEvent) => events.push(e);
  p.auth = { creds: { me: { id: "491700000000:3@s.whatsapp.net", lid: "9000:3@lid" } } };
  return { p, events, done: () => { p.store.discard(); rmSync(dir, { recursive: true, force: true }); } };
}
const SEC = new Uint8Array(32).fill(21);
const G = "120363@g.us", CREATOR = "7001@lid";
const create = (p: any, multiple: boolean) => p.intake({ key: { remoteJid: G, id: "P", fromMe: false, participant: CREATOR }, messageTimestamp: 10,
  message: { messageContextInfo: { messageSecret: SEC }, pollCreationMessage: { name: "Q", selectableOptionsCount: multiple ? 0 : 1, options: ["A", "B", "C"].map((o) => ({ optionName: o })) } } }, false);
const vote = (p: any, id: string, participant: string, enc: any, t: number, extra: object = {}) => p.intake({ key: { remoteJid: G, id, fromMe: false, participant, ...extra }, messageTimestamp: t / 1000,
  message: { pollUpdateMessage: { pollCreationMessageKey: { remoteJid: G, id: "P", fromMe: false, participant: CREATOR }, vote: enc, senderTimestampMs: t } } }, true);

test("the same person voting under LID key then PN key is ONE voter; a later vote replaces, a stale one is ignored", () => {
  const { p, done } = setup();
  try {
    const lid = "7002@lid", pn = "4916@s.whatsapp.net";
    p.store.data.lidToPn[lid] = pn;
    const m = create(p, false)!; assert.equal(m.poll!.multiple, false);
    vote(p, "V1", lid, encryptVote(SEC, "P", CREATOR, lid, [oid("A")]), 11_000);
    vote(p, "V2", pn, encryptVote(SEC, "P", CREATOR, lid, [oid("B")]), 12_000);      // phone sends the PN key, crypto uses the LID form
    vote(p, "V3", lid, encryptVote(SEC, "P", CREATOR, lid, [oid("C")]), 9_000);      // arrives late but is older
    const st = p.store.find(G, "P").poll;
    assert.deepEqual(Object.keys(st.votes), [pn]);
    assert.deepEqual(st.votes[pn].o, [oid("B")]);
    assert.deepEqual(buildPoll(st, "x").options.map((o) => o.voters), [[], [pn], []]);
  } finally { done(); }
});

test("multiple-choice vote carries several options; a retraction (empty vote) clears them", () => {
  const { p, events, done } = setup();
  try {
    const lid = "7003@lid";
    create(p, true);
    vote(p, "V1", lid, encryptVote(SEC, "P", CREATOR, lid, [oid("A"), oid("C")]), 11_000);
    let upd = [...events].reverse().find((e) => e.type === "message-update") as any;
    assert.deepEqual(upd.data.patch.poll.options.map((o: any) => o.voters.length), [1, 0, 1]);
    vote(p, "V2", lid, encryptVote(SEC, "P", CREATOR, lid, []), 12_000);
    upd = [...events].reverse().find((e) => e.type === "message-update") as any;
    assert.deepEqual(upd.data.patch.poll.options.map((o: any) => o.voters.length), [0, 0, 0]);
    // an option id that is not in the poll is dropped, the rest counts
    vote(p, "V3", lid, encryptVote(SEC, "P", CREATOR, lid, [oid("B"), oid("nope")]), 13_000);
    assert.deepEqual(p.store.find(G, "P").poll.votes[lid].o, [oid("B")]);
  } finally { done(); }
});

test("a vote that cannot be decrypted changes nothing and is not retried as another voter", () => {
  const { p, events, done } = setup();
  try {
    create(p, false); const before = events.length;
    vote(p, "V1", "7004@lid", encryptVote(new Uint8Array(32).fill(1), "P", CREATOR, "7004@lid", [oid("A")]), 11_000);
    assert.deepEqual(p.store.find(G, "P").poll.votes, {});
    assert.equal(events.slice(before).some((e) => e.type === "message-update"), false);
  } finally { done(); }
});
