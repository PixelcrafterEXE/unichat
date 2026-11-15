// Shared types of the Signal history import (legacy Android backup + new Secure Backup) and the mapping rules both formats share.
import type { Attachment, Message } from "../model.js";

export type ImportFormat = "android-legacy" | "secure-backup";

/** A conversation found in a backup, in the Signal provider's native id space (ACI uuid for 1:1, "g."+base64url(groupId) for groups). */
export interface ImportChat {
  id: string; kind: "dm" | "group"; name?: string;
  /** a 1:1 chat for which the backup knew only a phone number (no ACI): imported as "e164:+49…", not merged with live chats */
  unresolved?: boolean;
  count: number; first?: number; last?: number;
}
export interface ImportedAttachment { partKey: string; att: Attachment; /** declared size in the backup */ size: number }
export interface ImportedMessage {
  chat: ImportChat; message: Message;
  /** attachments the message refers to (bytes arrive separately, matched by partKey) */
  attachments: ImportedAttachment[];
}
export interface BackupIdentity { aci?: string; e164?: string }

/** The same id the live provider uses (provider-signal inbound.ts messageId()): dedupes an imported message against a live/archived one. */
export const ourMsgId = (authorAci: string, ts: number) => `${authorAci}.${ts}`;
export const normAci = (s: string | undefined | null) => (s ? s.trim().toLowerCase().replace(/^aci:/, "") : undefined);
export const isUuid = (s: string | undefined | null): s is string => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export const isE164 = (s: string | undefined | null): s is string => !!s && /^\+\d{6,15}$/.test(s);

export const groupNativeId = (groupId: Uint8Array) => `g.${Buffer.from(groupId).toString("base64url")}`;
/** Android stores v2 group ids as "__signal_group__v2__!<64 hex>"; the old v1/MMS ones ("__textsecure_group__!") are dead groups. */
export function groupIdFromAndroid(s: string | undefined | null): { id?: string; legacy?: boolean } {
  if (!s) return {};
  const m = /^__signal_group__v2__!([0-9a-fA-F]{64})$/.exec(s); if (m) return { id: groupNativeId(Buffer.from(m[1]!, "hex")) };
  if (/^__(textsecure|signal)_group__/.test(s)) return { legacy: true };
  return {};
}

export function timerText(seconds: number): string {
  if (!(seconds > 0)) return "Disappearing messages turned off";
  const f = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`;
  const t = seconds >= 604800 ? f(Math.round(seconds / 604800), "week") : seconds >= 86400 ? f(Math.round(seconds / 86400), "day") : seconds >= 3600 ? f(Math.round(seconds / 3600), "hour") : seconds >= 60 ? f(Math.round(seconds / 60), "minute") : f(seconds, "second");
  return `Disappearing messages set to ${t}`;
}
export const toMs = (n: number) => (n > 0 && n < 1e11 ? n * 1000 : n); // very old rows stored seconds
export const iso = (ms: number) => new Date(ms).toISOString();

export function attachmentKind(ct: string, o: { voice?: boolean; sticker?: boolean }): Attachment["kind"] {
  const c = (ct || "").toLowerCase();
  if (o.sticker) return "sticker";
  if (c.startsWith("image/")) return "image";
  if (c.startsWith("video/")) return "video";
  if (c.startsWith("audio/")) return o.voice ? "voice" : "audio";
  return "file";
}
export const placeholder = (k: Attachment["kind"], name?: string) => k === "image" ? "[Photo]" : k === "video" ? "[Video]" : k === "voice" ? "[Voice message]" : k === "audio" ? "[Audio]" : k === "sticker" ? "[Sticker]" : `[File${name ? ": " + name : ""}]`;
export const VIEW_ONCE_TEXT = "[View-once media - open it in Signal on your phone]";
