// Profile field crypto, ported from Signal-Desktop:
//   ts/Crypto.node.ts          encryptProfile / decryptProfile / encryptProfileItemWithPadding / decryptProfileName / PaddedLengths
//   ts/util/encryptProfileData.preload.ts   request body layout for PUT /v1/profile
//   ts/util/zkgroup.node.ts    deriveProfileKeyVersion / deriveProfileKeyCommitment
// Every field is: IV(12) | AES-256-GCM(profileKey, paddedPlaintext) | tag(16); name = given \0 family, zero-padded.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Aci } from "@signalapp/libsignal-client";
import { ProfileKey } from "@signalapp/libsignal-client/dist/zkgroup/index.js";
import { toBytes } from "../protocol/bytes.js";

export const PADDED_LENGTHS = { name: [53, 257], about: [128, 254, 512], aboutEmoji: [32] } as const;
const IV_LEN = 12, TAG_LEN = 16, KEY_LEN = 32;

/** encryptProfile(): used unpadded for the avatar and the phone-number-sharing flag. */
export function encryptProfile(data: Uint8Array, key: Uint8Array, iv: Uint8Array = randomBytes(IV_LEN)): Buffer {
  if (key.length !== KEY_LEN) throw new Error("invalid profile key length");
  const c = createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(iv));
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([Buffer.from(iv), ct, c.getAuthTag()]);
}

export function decryptProfile(data: Uint8Array, key: Uint8Array): Buffer {
  if (key.length !== KEY_LEN) throw new Error("invalid profile key length");
  if (data.length < IV_LEN + TAG_LEN + 1) throw new Error("profile ciphertext too short");
  const b = Buffer.from(data);
  const d = createDecipheriv("aes-256-gcm", Buffer.from(key), b.subarray(0, IV_LEN));
  d.setAuthTag(b.subarray(b.length - TAG_LEN));
  try { return Buffer.concat([d.update(b.subarray(IV_LEN, b.length - TAG_LEN)), d.final()]); }
  catch { throw new Error("could not decrypt profile data (profile key changed?)"); }
}

export function encryptProfileItemWithPadding(item: Uint8Array, key: Uint8Array, lengths: readonly number[]): Buffer {
  const len = lengths.find((l) => item.length <= l);
  if (!len) throw new Error("Oversized value");
  const padded = Buffer.alloc(len);
  padded.set(item);
  return encryptProfile(padded, key);
}

/** Strip the trailing zero padding of a single-valued field (about, emoji). */
export function decryptProfileText(b64: string, key: Uint8Array): string {
  const p = decryptProfile(Buffer.from(b64, "base64"), key);
  let end = p.length;
  while (end > 0 && p[end - 1] === 0) end--;
  return p.subarray(0, end).toString("utf8");
}

/**
 * A person-supplied name is shown only when it is valid UTF-8 without control characters / U+FFFD / unpaired surrogates (e.g. the result of
 * a wrong key or a garbled record). Returns the trimmed name, or undefined = ignore it.
 */
export function cleanName(v: string | Uint8Array | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  let s: string;
  if (typeof v === "string") s = v;
  else { try { s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(v); } catch { return undefined; } }
  if (/[\p{Cc}\p{Cs}\u{FFFD}\u{2028}\u{2029}\u{FFFE}\u{FFFF}]/u.test(s)) return undefined;
  const t = s.trim();
  return t || undefined;
}

export function decryptProfileName(b64: string, key: Uint8Array): { given: string; family?: string } {
  const p = decryptProfile(Buffer.from(b64, "base64"), key);
  let givenEnd = 0;
  while (givenEnd < p.length && p[givenEnd] !== 0) givenEnd++;
  let familyEnd = givenEnd + 1;
  while (familyEnd < p.length && p[familyEnd] !== 0) familyEnd++;
  const family = familyEnd > givenEnd + 1 ? cleanName(p.subarray(givenEnd + 1, familyEnd)) : undefined;
  return { given: cleanName(p.subarray(0, givenEnd)) ?? "", family };
}

export function profileKeyVersion(profileKey: Uint8Array, aci: string): string {
  return new ProfileKey(toBytes(profileKey)).getProfileKeyVersion(Aci.fromUuid(aci)).toString();
}
export function profileKeyCommitment(profileKey: Uint8Array, aci: string): string {
  return Buffer.from(new ProfileKey(toBytes(profileKey)).getCommitment(Aci.fromUuid(aci)).contents).toString("base64");
}

/** Server's view of the profile: encrypted base64 fields, as returned by GET /v1/profile/<aci>/<version>. */
export interface ServerProfile {
  name?: string; about?: string; aboutEmoji?: string; avatar?: string; phoneNumberSharing?: string;
  paymentAddress?: string; badges?: unknown;
}

export interface PutProfileInput {
  given: string; family?: string; about?: string; aboutEmoji?: string;
  /** true = there will be an avatar after this request; sameAvatar = keep the existing upload */
  hasAvatar: boolean; sameAvatar: boolean;
  /** server-side values we must carry over so PUT (which replaces the whole profile) does not erase them */
  carry: Pick<ServerProfile, "phoneNumberSharing" | "paymentAddress" | "badges">;
}

/** Body of PUT /v1/profile (layout of Signal-Desktop `ProfileRequestDataType`). */
export function buildPutProfileBody(profileKey: Uint8Array, aci: string, i: PutProfileInput) {
  const name = [i.given, i.family].filter(Boolean).join("\0");
  const badgeIds = Array.isArray(i.carry.badges)
    ? (i.carry.badges as { id?: unknown; visible?: unknown }[]).filter((b) => typeof b?.id === "string" && b.visible !== false).map((b) => b.id as string)
    : [];
  return {
    version: profileKeyVersion(profileKey, aci),
    name: encryptProfileItemWithPadding(Buffer.from(name, "utf8"), profileKey, PADDED_LENGTHS.name).toString("base64"),
    about: i.about ? encryptProfileItemWithPadding(Buffer.from(i.about, "utf8"), profileKey, PADDED_LENGTHS.about).toString("base64") : null,
    aboutEmoji: i.aboutEmoji ? encryptProfileItemWithPadding(Buffer.from(i.aboutEmoji, "utf8"), profileKey, PADDED_LENGTHS.aboutEmoji).toString("base64") : null,
    badgeIds,
    paymentAddress: i.carry.paymentAddress ?? null,
    avatar: i.hasAvatar,
    sameAvatar: i.sameAvatar,
    commitment: profileKeyCommitment(profileKey, aci),
    phoneNumberSharing: i.carry.phoneNumberSharing ?? null,
  };
}
