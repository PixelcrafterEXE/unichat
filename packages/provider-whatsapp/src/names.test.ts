// Pure helpers: extra name/id sources and console-noise classification (no network, no Baileys connection).
import test from "node:test";
import assert from "node:assert/strict";
import { harvestHistorySync, isMaskedName, lidMigrationPairs, scanParticipants, senderNameStats, pickName } from "./names.js";
import { NoiseCounter, classifyConsole, classifyDecryptError, installConsoleFilter } from "./libnoise.js";

test("history harvest reads pushnames and lid/pn pairs of any sync type", () => {
  const h = harvestHistorySync({
    pushnames: [{ id: "4915@s.whatsapp.net", pushname: " Ann " }, { id: "77@lid", pushname: "Bob" }, { id: "x@s.whatsapp.net", pushname: "  " }, { pushname: "no id" }],
    phoneNumberToLidMappings: [{ pnJid: "4915@s.whatsapp.net", lidJid: "77@lid" }, { pnJid: "bad", lidJid: "bad" }],
  });
  assert.deepEqual(h.pushnames, [["4915@s.whatsapp.net", "Ann"], ["77@lid", "Bob"]]);
  assert.deepEqual(h.pairs, [["77@lid", "4915@s.whatsapp.net"]]);
});

test("LID migration payload gives pairs for assigned and latest lid (Long-like ids)", () => {
  const pairs = lidMigrationPairs({ pnToLidMappings: [{ pn: { toString: () => "4915" }, assignedLid: 11, latestLid: 12 }, { pn: 4916, assignedLid: 13, latestLid: 13 }, { pn: 0, assignedLid: 1 }] });
  assert.deepEqual(pairs, [["11@lid", "4915@s.whatsapp.net"], ["12@lid", "4915@s.whatsapp.net"], ["13@lid", "4916@s.whatsapp.net"]]);
});

test("participant nodes: names and lid/pn pairs are read, attribute NAMES are counted, other stanzas are ignored", () => {
  const attrs = new Map<string, number>();
  const node = { tag: "iq", attrs: {}, content: [{ tag: "group", attrs: {}, content: [
    { tag: "participant", attrs: { jid: "55@lid", phone_number: "4915@s.whatsapp.net", display_name: "Kim", type: "admin" } },
    { tag: "participant", attrs: { jid: "4916@s.whatsapp.net" } },
    { tag: "participant", attrs: { jid: "56@lid" } },
  ] }] };
  const r = scanParticipants(node, attrs);
  assert.deepEqual(r, [{ lid: "55@lid", pn: "4915@s.whatsapp.net", name: "Kim" }]);
  assert.equal(attrs.get("display_name"), 1); assert.equal(attrs.get("jid"), 3);
  assert.deepEqual(scanParticipants({ tag: "message", attrs: {}, content: node.content }), []);
});

test("sender name stats: named / phone-fallback / unknown", () => {
  const src: Record<string, { push?: string }> = { a: { push: "A" }, b: {}, c: {} };
  const st = senderNameStats(["a", "b", "c"], (id) => ({ ...src[id], known: id === "b" }));
  assert.deepEqual(st, { total: 3, named: 1, phone: 1, unknown: 1 });
});

test("phone-number fallback instead of 'WhatsApp user' whenever the number is known", () => {
  assert.equal(pickName("491701234567@s.whatsapp.net", {}), "+49 170 1234567");
  assert.equal(pickName("9001@lid", {}), "WhatsApp user");
  assert.equal(pickName("9001@lid", { push: "Zed" }), "~Zed");
});

test("libsignal console noise is classified; real errors are not", () => {
  assert.equal(classifyConsole(["Failed to decrypt message with any known session..."]), "signal-no-session");
  assert.equal(classifyConsole(["Session error:Error: Bad MAC", "stack"]), "signal-bad-mac");
  assert.equal(classifyConsole(["Session error:Error: x"]), "signal-session-error");
  assert.equal(classifyConsole(["Closing session:", { big: "dump" }]), "signal-session-lifecycle");
  assert.equal(classifyConsole(["Decrypted message with closed session."]), "signal-closed-session");
  assert.equal(classifyConsole(["something real broke", new Error("x")]), undefined);
  assert.equal(classifyConsole([new Error("Bad MAC")]), undefined);
  assert.equal(classifyDecryptError("failed to decrypt message", "Bad MAC"), "decrypt-bad-mac");
  assert.equal(classifyDecryptError("failed to decrypt message", "No matching sessions found for message"), "decrypt-no-session");
  assert.equal(classifyDecryptError("failed to decrypt message", "boom"), "decrypt-other");
  assert.equal(classifyDecryptError("unexpected error in 'x'", "Bad MAC"), undefined);
});

test("console filter swallows and counts noise, forwards everything else, installs once", () => {
  const seen: unknown[][] = [];
  const target: Record<string, unknown> = { log() {}, info() {}, warn() {}, error: (...a: unknown[]) => { seen.push(a); } };
  const c = new NoiseCounter();
  assert.equal(installConsoleFilter(c, target), true);
  assert.equal(installConsoleFilter(c, target), false);
  (target.error as (...a: unknown[]) => void)("Session error:Error: Bad MAC", "stack");
  (target.error as (...a: unknown[]) => void)("Session error:Error: Bad MAC", "stack");
  (target.error as (...a: unknown[]) => void)("a real problem");
  assert.deepEqual(seen, [["a real problem"]]);
  assert.equal(c.take(), "signal-bad-mac=2");
  assert.equal(c.take(), undefined);
  assert.equal(c.totalOf("signal-bad-mac"), 2);
});

test("masked number placeholders are never used as names", () => {
  assert.equal(isMaskedName("+49∙∙∙∙∙∙∙∙78"), true);
  assert.equal(isMaskedName("Anna ∙ Becker"), false);
  assert.equal(pickName("491714112578@s.whatsapp.net", { push: "+49∙∙∙∙∙∙∙∙78" }), "+49 171 4112578"); // falls back to the real number
  assert.equal(pickName("491714112578@s.whatsapp.net", { contact: "Anna", push: "+49∙∙∙∙∙∙∙∙78" }), "Anna");
  const r = scanParticipants({ tag: "iq", content: [{ tag: "participant", attrs: { jid: "491714112578@s.whatsapp.net", display_name: "+49∙∙∙∙∙∙∙∙78" } }] });
  assert.equal(r.length, 0);
});
