// Pure mapping helpers: Baileys/WhatsApp protocol shapes -> UniChat model. No runtime dependency on Baileys
// (type-only imports), so this file is unit-testable offline.
import { createHash } from "node:crypto";
import type { proto } from "@whiskeysockets/baileys";
import type { Attachment, AttachmentKind, ChatKind, DeliveryStatus } from "@unimsg/core";
import type { AttDesc } from "./store.js";
import { describeOther, topLevelField } from "./content.js";
import type { Card, Location, SharedContact } from "@unimsg/core";

type LongLike = number | { toNumber(): number } | null | undefined;
export const num = (t: LongLike): number => (t == null ? 0 : typeof t === "number" ? t : t.toNumber());

/** Strip device suffix and legacy @c.us: "123:7@s.whatsapp.net" -> "123@s.whatsapp.net". */
export function normJid(jid: string): string {
  const at = jid.indexOf("@");
  if (at < 0) return jid;
  let user = jid.slice(0, at);
  let server = jid.slice(at + 1);
  const colon = user.indexOf(":");
  if (colon >= 0) user = user.slice(0, colon);
  if (server === "c.us") server = "s.whatsapp.net";
  return `${user}@${server}`;
}
export const isGroupJid = (j: string) => j.endsWith("@g.us");
export const isLidJid = (j: string) => j.endsWith("@lid");
export const isUserJid = (j: string) => j.endsWith("@s.whatsapp.net") || isLidJid(j);
/** Chats we model: DMs and groups. Status, broadcast lists, newsletters are ignored. */
export const isSupportedChat = (j: string) => isGroupJid(j) || isUserJid(j);
export const chatKindOf = (j: string): ChatKind => (isGroupJid(j) ? "group" : "dm");
export const handleOf = (j: string): string | undefined => (j.endsWith("@s.whatsapp.net") ? "+" + j.slice(0, j.indexOf("@")) : undefined);

/** Canonical id: prefer the phone-number JID when a LID->PN mapping is known (stable chat ids). */
export function canon(jid: string, lidToPn: Record<string, string>, pnHint?: string | null): string {
  const j = normJid(jid);
  if (!isLidJid(j)) return j;
  if (pnHint) { const p = normJid(pnHint); if (p.endsWith("@s.whatsapp.net")) return p; }
  return lidToPn[j] ?? j;
}

export const toIso = (sec: number): string => new Date((sec > 0 ? sec : Math.floor(Date.now() / 1000)) * 1000).toISOString();

export function statusFromAck(s: number | null | undefined): DeliveryStatus | undefined {
  switch (s) {
    case 0: return "failed";
    case 1: return "sending";
    case 2: return "sent";
    case 3: return "delivered";
    case 4: case 5: return "read";
    default: return undefined;
  }
}
const RANK: Record<DeliveryStatus, number> = { failed: 0, sending: 1, sent: 2, delivered: 3, read: 4 };
export const betterStatus = (a: DeliveryStatus | undefined, b: DeliveryStatus): boolean => !a || a === "failed" || RANK[b] > RANK[a];

export function isMuted(muteEndTime: LongLike): boolean {
  const v = num(muteEndTime);
  if (v === 0) return false;
  if (v === -1) return true;
  return (v > 1e11 ? v : v * 1000) > Date.now();
}

/** Stable poll option id = hex sha256 of the option text (this is also what votes reference). */
export const optionId = (name: string): string => createHash("sha256").update(name).digest("hex");

export interface Extracted {
  text: string;
  card?: Card;
  /** A revoked message (placeholder left in history). */
  deleted?: boolean;
  /** Network notice (join/leave/pin...) rather than something a person wrote. */
  system?: boolean;
  location?: Location;
  /** Live-location update counter (newer wins). */
  seq?: number;
  contacts?: SharedContact[];
  /** Top-level proto field of content we could not map (for diagnostics). */
  unsupported?: string;
  poll?: { question: string; options: { id: string; text: string }[]; multiple: boolean };
  context?: proto.IContextInfo | null;
  attachment?: { att: Attachment; desc: AttDesc };
}

const dataUrl = (b: Uint8Array | null | undefined): string | undefined =>
  b && b.length > 0 && b.length < 32_000 ? "data:image/jpeg;base64," + Buffer.from(b).toString("base64") : undefined;

/** Wrappers Baileys' normalizeMessageContent does not unwrap (it only does ephemeral/view-once/edited/document-with-caption). */
export function unwrap(c: proto.IMessage | null | undefined): proto.IMessage | null | undefined {
  for (let i = 0; i < 5 && c; i++) {
    const inner = c.ephemeralMessage?.message ?? c.viewOnceMessage?.message ?? c.viewOnceMessageV2?.message ?? c.viewOnceMessageV2Extension?.message ??
      c.documentWithCaptionMessage?.message ?? c.editedMessage?.message ?? c.groupMentionedMessage?.message ?? c.deviceSentMessage?.message ??
      c.botInvokeMessage?.message ?? c.pollCreationMessageV4?.message ?? c.pollCreationMessageV5?.message ?? c.groupStatusMessage?.message ?? c.lottieStickerMessage?.message;
    if (!inner) break;
    c = inner;
  }
  return c;
}

type Media = proto.Message.IImageMessage & proto.Message.IVideoMessage & proto.Message.IAudioMessage & proto.Message.IDocumentMessage & proto.Message.IStickerMessage;

/** `c` must already be normalized (ephemeral/view-once/edited wrappers unwrapped). Returns undefined for non-chat content. */
export function extract(c0: proto.IMessage | null | undefined): Extracted | undefined {
  const c = unwrap(c0);
  if (!c) return undefined;
  if (c.protocolMessage || c.reactionMessage || c.senderKeyDistributionMessage || c.pollUpdateMessage) return undefined;
  if (c.conversation) return { text: c.conversation };
  if (c.extendedTextMessage) return { text: c.extendedTextMessage.text ?? "", context: c.extendedTextMessage.contextInfo };

  const media: [keyof proto.IMessage, AttDesc["type"], AttachmentKind][] = [
    ["imageMessage", "image", "image"], ["videoMessage", "video", "video"], ["audioMessage", "audio", "audio"],
    ["documentMessage", "document", "file"], ["stickerMessage", "sticker", "sticker"], ["ptvMessage", "video", "video"],
  ];
  for (const [field, type, kind0] of media) {
    const mm = c[field] as Partial<Media> | null | undefined;
    if (!mm) continue;
    const kind: AttachmentKind = type === "audio" && mm.ptt ? "voice" : kind0;
    const mime = mm.mimetype ?? "application/octet-stream";
    const att: Attachment = { id: "a0", kind, mime };
    if (mm.fileName) att.name = mm.fileName;
    if (mm.fileLength != null) att.size = num(mm.fileLength);
    if (mm.width) att.width = mm.width;
    if (mm.height) att.height = mm.height;
    if (mm.seconds) att.durationMs = mm.seconds * 1000;
    const wf = (mm as proto.Message.IAudioMessage).waveform; if (type === "audio" && wf?.length) att.waveform = Array.from(wf).slice(0, 100);
    if (type === "video" && (mm as proto.Message.IVideoMessage).gifPlayback) att.gif = true; // GIFs travel as looping muted mp4
    const th = dataUrl(mm.jpegThumbnail);
    if (th) att.thumbnailDataUrl = th;
    const desc: AttDesc = { type, mime, mediaKey: mm.mediaKey ? Buffer.from(mm.mediaKey).toString("base64") : "" };
    if (mm.directPath) desc.directPath = mm.directPath;
    if (mm.url) desc.url = mm.url;
    if (mm.fileName) desc.name = mm.fileName;
    return { text: mm.caption ?? "", context: mm.contextInfo, attachment: { att, desc } };
  }
  const pc = c.pollCreationMessage ?? c.pollCreationMessageV2 ?? c.pollCreationMessageV3;
  if (pc) {
    const options = (pc.options ?? []).map((o) => ({ id: optionId(o.optionName ?? ""), text: o.optionName ?? "" }));
    return { text: "", context: pc.contextInfo, poll: { question: pc.name ?? "", options, multiple: (pc.selectableOptionsCount ?? 0) !== 1 } };
  }
  const d = describeOther(c);
  if (d === "skip") return undefined;
  if (d) {
    const r: Extracted = { text: d.text };
    if (d.context) r.context = d.context;
    if (d.card) r.card = d.card;
    if (d.system) r.system = true;
    if (d.location) r.location = d.location;
    if (d.seq !== undefined) r.seq = d.seq;
    if (d.contacts) r.contacts = d.contacts;
    return r;
  }
  const field = topLevelField(c);
  return field ? { text: `[unsupported message: ${field}]`, unsupported: field, card: { kind: "other", title: field } } : undefined;
}

/** Text of an edited-message payload (protocolMessage.editedMessage, already unwrapped). */
export function textOf(c: proto.IMessage | null | undefined): string | undefined {
  const e = extract(c);
  return e ? e.text : undefined;
}

export const preview = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** "+49 170…" style fallback label without ever leaking more than the jid already implies. */
export const fallbackName = (jid: string) => handleOf(jid) ?? jid.slice(0, jid.indexOf("@"));

/** Parse a user-typed handle into a PN JID, or undefined. */
export function handleToJid(handle: string): string | undefined {
  const digits = handle.replace(/[^\d]/g, "");
  return digits.length >= 6 && digits.length <= 15 ? `${digits}@s.whatsapp.net` : undefined;
}

/** Summarize groupParticipantsUpdate results without exposing any jid/phone number. */
export function summarizeParticipantResults(res: { status?: string }[]): { ok: number; failed: number; reasons: string[] } {
  const reasons = new Set<string>();
  let ok = 0;
  for (const r of res) {
    if (r.status === "200") ok++;
    else reasons.add(r.status === "403" ? "403 not allowed / needs invite" : r.status === "409" ? "409 already a member" : r.status === "408" ? "408 recently left" : `status ${r.status ?? "unknown"}`);
  }
  return { ok, failed: res.length - ok, reasons: [...reasons] };
}

/** Extract the invite code from a chat.whatsapp.com link or a bare code; undefined if it doesn't look like one. */
export function parseInviteCode(input: string): string | undefined {
  const t = input.trim();
  const m = /^(?:https?:\/\/)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]{10,40})(?:[/?#].*)?$/i.exec(t);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,40}$/.test(t) ? t : undefined;
}
