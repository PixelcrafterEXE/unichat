// Poll model building + vote crypto. Baileys 6.7.24 does NOT decrypt incoming votes (that code is commented out in
// process-message.js) and has no API to cast one, so both directions are done here with its exported primitives.
import { randomBytes } from "node:crypto";
import { aesEncryptGCM, decryptPollVote, hmacSign, proto } from "@whiskeysockets/baileys";
import type { Poll } from "@unimsg/core";
import type { StoredPoll } from "./store.js";

export function buildPoll(sp: StoredPoll, selfId: string): Poll {
  const options = sp.options.map((o) => ({ id: o.id, text: o.text, voters: Object.entries(sp.votes).filter(([, v]) => v.o.includes(o.id)).map(([id]) => id) }));
  const mine = sp.votes[selfId]?.o;
  // Without the poll's encryption secret we can show it (history carries decrypted tallies) but never vote or decrypt: read-only.
  return { question: sp.question, options, multiple: sp.multiple, ...(sp.secret ? {} : { closed: true }), ...(mine && mine.length ? { mine: [...mine] } : {}) };
}

/** Record a vote unless an equal-or-newer one from the same voter exists. Returns true when state changed. */
export function applyVote(sp: StoredPoll, voterId: string, optionIds: string[], t: number): boolean {
  const known = new Set(sp.options.map((o) => o.id));
  const o = optionIds.filter((x) => known.has(x));
  const cur = sp.votes[voterId];
  if (cur && cur.t >= t) return false;
  sp.votes[voterId] = { o, t };
  return true;
}

function keyFor(secret: Uint8Array, msgId: string, creatorJid: string, voterJid: string) {
  const sign = Buffer.concat([Buffer.from(msgId), Buffer.from(creatorJid), Buffer.from(voterJid), Buffer.from("Poll Vote"), new Uint8Array([1])]);
  const key0 = hmacSign(secret, new Uint8Array(32), "sha256");
  return { decKey: hmacSign(sign, key0, "sha256"), aad: Buffer.from(`${msgId}\u0000${voterJid}`) };
}

/** Mirror of Baileys' decryptPollVote. */
export function encryptVote(secret: Uint8Array, msgId: string, creatorJid: string, voterJid: string, selectedOptionIds: string[]) {
  const { decKey, aad } = keyFor(secret, msgId, creatorJid, voterJid);
  const plain = proto.Message.PollVoteMessage.encode({ selectedOptions: selectedOptionIds.map((h) => Buffer.from(h, "hex")) }).finish();
  const encIv = randomBytes(12);
  return { encPayload: aesEncryptGCM(plain, decKey, encIv, aad), encIv };
}

/** WhatsApp may use phone-number or LID forms of creator/voter in the key derivation: try the candidates. */
export function tryDecryptVoteEx(
  enc: proto.Message.IPollEncValue, secret: Uint8Array, msgId: string, creators: string[], voters: string[],
): { options: string[]; creator: string; voter: string } | undefined {
  for (const creator of new Set(creators)) for (const voter of new Set(voters)) {
    try {
      const v = decryptPollVote(enc, { pollEncKey: secret as Buffer, pollCreatorJid: creator, pollMsgId: msgId, voterJid: voter });
      return { options: (v.selectedOptions ?? []).map((b) => Buffer.from(b).toString("hex")), creator, voter };
    } catch { /* wrong candidate: GCM auth fails */ }
  }
  return undefined;
}
export function tryDecryptVote(enc: proto.Message.IPollEncValue, secret: Uint8Array, msgId: string, creators: string[], voters: string[]): string[] | undefined {
  return tryDecryptVoteEx(enc, secret, msgId, creators, voters)?.options;
}
