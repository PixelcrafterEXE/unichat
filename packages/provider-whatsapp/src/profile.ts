// Pure parts of own-profile and privacy support (offline-testable).
import type { PrivacySetting } from "@unimsg/core";

export const MAX_NAME = 25;   // WhatsApp display (push) name limit
export const MAX_ABOUT = 139; // WhatsApp "about" limit
const MAX_AVATAR_BYTES = 8_000_000;

export function validateName(s: string): string {
  const n = s.trim();
  if (!n) throw new Error("The name must not be empty.");
  if ([...n].length > MAX_NAME) throw new Error(`The name can be at most ${MAX_NAME} characters.`);
  return n;
}
export function validateAbout(s: string): string {
  const n = s.trim();
  if ([...n].length > MAX_ABOUT) throw new Error(`The about text can be at most ${MAX_ABOUT} characters.`);
  if (!n) throw new Error("The about text must not be empty (WhatsApp keeps the previous one otherwise).");
  return n;
}

/** Detected image format and pixel size (when cheaply readable). */
export interface ImageInfo { format: "jpeg" | "png" | "webp"; width?: number; height?: number }

export function sniffImage(b: Uint8Array): ImageInfo | undefined {
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { format: "png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1]!;
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = (b[i + 2]! << 8) | b[i + 3]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { format: "jpeg", height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
      }
      i += 2 + len;
    }
    return { format: "jpeg" };
  }
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return { format: "webp" };
  return undefined;
}

/** Reject files that are not a usable profile picture. Bytes and declared mime must agree. */
export function validateAvatar(a: { data: Uint8Array; mime: string }): ImageInfo {
  if (a.data.length === 0) throw new Error("The picture is empty.");
  if (a.data.length > MAX_AVATAR_BYTES) throw new Error("The picture is too large (max 8 MB).");
  const info = sniffImage(a.data);
  if (!info) throw new Error("The picture must be a JPEG, PNG or WebP image.");
  const declared = a.mime.toLowerCase().replace("image/jpg", "image/jpeg");
  if (declared !== `image/${info.format}`) throw new Error("The picture's content does not match its file type.");
  if (info.width !== undefined && info.height !== undefined) {
    if (Math.min(info.width, info.height) < 64) throw new Error("The picture is too small (at least 64x64 pixels).");
    if (Math.max(info.width, info.height) > 8192) throw new Error("The picture is too large (at most 8192 pixels per side).");
  }
  return info;
}

// ---------------------------------------------------------------- privacy
type Opt = { value: string; label: string };
const WHO4: Opt[] = [
  { value: "all", label: "Everyone" }, { value: "contacts", label: "My contacts" },
  { value: "contact_blacklist", label: "My contacts except..." }, { value: "none", label: "Nobody" },
];
const EXCEPT_NOTE = " \"My contacts except...\" keeps the exclusion list you set on your phone; it is edited there.";

export interface PrivacyDef {
  id: string; key: string; label: string; description: string; options: Opt[];
  /** Name of the Baileys socket method that sets it. */
  setter: "updateLastSeenPrivacy" | "updateOnlinePrivacy" | "updateProfilePicturePrivacy" | "updateStatusPrivacy" |
    "updateReadReceiptsPrivacy" | "updateGroupsAddPrivacy" | "updateCallPrivacy" | "updateMessagesPrivacy";
  /** Only listed when WhatsApp reports this category for the account. */
  optional?: boolean;
}
export const PRIVACY_DEFS: PrivacyDef[] = [
  { id: "last_seen", key: "last", setter: "updateLastSeenPrivacy", label: "Last seen", description: "Who can see when you were last online." + EXCEPT_NOTE, options: WHO4 },
  { id: "online", key: "online", setter: "updateOnlinePrivacy", label: "Online status", description: "Who can see when you are online.",
    options: [{ value: "all", label: "Everyone" }, { value: "match_last_seen", label: "Same as last seen" }] },
  { id: "profile_picture", key: "profile", setter: "updateProfilePicturePrivacy", label: "Profile picture", description: "Who can see your profile picture." + EXCEPT_NOTE, options: WHO4 },
  { id: "about", key: "status", setter: "updateStatusPrivacy", label: "About", description: "Who can see your about text." + EXCEPT_NOTE, options: WHO4 },
  { id: "read_receipts", key: "readreceipts", setter: "updateReadReceiptsPrivacy", label: "Read receipts",
    description: "If off, you will not send or receive read receipts in chats (group chats always send them).",
    options: [{ value: "all", label: "On" }, { value: "none", label: "Off" }] },
  { id: "groups_add", key: "groupadd", setter: "updateGroupsAddPrivacy", label: "Who can add me to groups", description: "Who is allowed to add you to groups." + EXCEPT_NOTE,
    options: WHO4.filter((o) => o.value !== "none") },
  { id: "calls_add", key: "calladd", setter: "updateCallPrivacy", label: "Who can call me", description: "Calls from people who are not in your contacts can be silenced.", optional: true,
    options: [{ value: "all", label: "Everyone" }, { value: "known", label: "Known contacts only" }] },
  { id: "messages_add", key: "messages", setter: "updateMessagesPrivacy", label: "Who can message me", description: "Whether people who are not in your contacts can message you.", optional: true,
    options: [{ value: "all", label: "Everyone" }, { value: "contacts", label: "My contacts only" }] },
];

/** Map WhatsApp's raw privacy dictionary (category name -> value) to UI settings. Unknown current values stay selectable. */
export function buildPrivacy(raw: Record<string, string | undefined>): PrivacySetting[] {
  const out: PrivacySetting[] = [];
  for (const d of PRIVACY_DEFS) {
    const v = raw[d.key];
    if (v === undefined && d.optional) continue;
    const value = v ?? d.options[0]!.value;
    const options = d.options.some((o) => o.value === value) ? d.options.map((o) => ({ ...o })) : [...d.options.map((o) => ({ ...o })), { value, label: value }];
    out.push({ id: d.id, label: d.label, description: d.description, value, options });
  }
  return out;
}

/** Validate a change request; throws a user-readable error. */
export function resolvePrivacyChange(id: string, value: string): PrivacyDef {
  const d = PRIVACY_DEFS.find((x) => x.id === id);
  if (!d) throw new Error(`Unknown privacy setting "${id}".`);
  if (!d.options.some((o) => o.value === value)) throw new Error(`"${value}" is not an allowed value for "${d.label}".`);
  return d;
}

/** Turn a Baileys/WhatsApp error into a message for the user (no identifiers). */
export function friendlyWaError(e: unknown, what: string): Error {
  const code = (e as { data?: unknown })?.data;
  const msg = (e as Error)?.message ?? "";
  if (/No image processing library/i.test(msg)) return new Error(`${what}: the server has no image library (install "sharp") to prepare the picture.`);
  if (code === 429 || /rate-overlimit/i.test(msg)) return new Error(`${what}: WhatsApp is rate limiting this request. Try again in a minute.`);
  if (code === 401 || code === 403 || /not-authorized|forbidden/i.test(msg)) return new Error(`${what}: WhatsApp refused the change.`);
  if (code === 406 || code === 400 || /not-acceptable|bad-request/i.test(msg)) return new Error(`${what}: WhatsApp rejected the value.`);
  if (/Timed Out|timeout/i.test(msg)) return new Error(`${what}: WhatsApp did not answer in time.`);
  if (/Connection Closed|not connected/i.test(msg)) return new Error(`${what}: not connected to WhatsApp.`);
  return new Error(`${what}: WhatsApp reported an error${typeof code === "number" ? ` (${code})` : ""}.`);
}
