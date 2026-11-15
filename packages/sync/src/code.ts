// Pairing codes. A code is a pronounceable string of 8 consonant-vowel syllables ("bako-lemi-zuta-nosu"):
// 80^8 ~ 2^50.6 possibilities, typed once, valid for minutes. It is NOT short enough to be brute-forced offline from a
// recorded handshake (each guess costs a scrypt evaluation, see pairingPsk) and active guessing is limited to a handful of tries.
import { randomInt, scryptSync } from "node:crypto";
const C = "bdfghjklmnprstvz", V = "aeiou";
export function newPairingCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += C[randomInt(C.length)] + V[randomInt(V.length)];
  return s.replace(/(.{4})(?=.)/g, "$1-");
}
export function normalizeCode(c: string): string { return c.toLowerCase().replace(/[^a-z]/g, ""); }
export const isValidCode = (c: string) => /^([bdfghjklmnprstvz][aeiou]){8}$/.test(normalizeCode(c));
/** scrypt N=2^15, r=8, p=1 (~32 MB, ~0.1 s): the cost an offline attacker pays PER GUESS. Computed once per pairing session on the host. */
export function pairingPsk(code: string): Buffer {
  return scryptSync(normalizeCode(code), "unichat-sync-pairing-v1", 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 << 20 });
}

import { createHmac } from "node:crypto";
/** Short authentication string of a pairing handshake: 6 digits both devices derive from the Noise transcript (which binds both static keys and all ephemeral keys). A man in the middle ends up with different transcripts on the two legs, so the digits differ. */
export function sasOf(transcript: Uint8Array): string {
  const n = createHmac("sha256", Buffer.from(transcript)).update("unichat-pairing-sas-v1").digest().readUInt32BE(0) % 1_000_000;
  const s = String(n).padStart(6, "0"); return `${s.slice(0, 3)} ${s.slice(3)}`;
}
