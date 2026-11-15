// Rendering of Signal content types that are not plain text into UniChat's Message.text + Message.card / system notice.
// Everything here is pure (no store, no network) so it can be unit-tested with codec fixtures.
// Every mapped type produces a short plain-text summary (for chat previews and search) PLUS a Card where useful.
import type { Card } from "@unimsg/core";
import { serviceIdFromBinary } from "../protocol/ids.js";
import type { BodyRange, CallEventPb, CallMessagePb, DataMessage } from "../protocol/codec.js";

/** Replace mention placeholders (U+FFFC at each mention range) with "@name". Formatting ranges keep the plain text. */
export function renderMentions(body: string, ranges: BodyRange[] | undefined, nameOf: (aci: string) => string): string {
  if (!ranges?.length) return body;
  const mentions = ranges
    .map((r) => ({ r, aci: r.mentionAci || serviceIdFromBinary(r.mentionAciBinary) }))
    .filter((x): x is { r: BodyRange; aci: string } => !!x.aci && x.r.start !== undefined && x.r.start >= 0 && x.r.start < body.length)
    .sort((a, b) => b.r.start! - a.r.start!);
  let out = body;
  let lastStart = Infinity;
  for (const { r, aci } of mentions) {
    const start = r.start!, end = Math.min(start + (r.length ?? 1), lastStart, out.length);
    if (end <= start) continue;
    out = out.slice(0, start) + `@${nameOf(aci)}` + out.slice(end);
    lastStart = start;
  }
  return out;
}

const UNITS: [number, string][] = [[604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]];
export function describeDuration(seconds: number): string {
  for (const [size, name] of UNITS) {
    if (seconds >= size && seconds % size === 0) { const n = seconds / size; return `${n} ${name}${n === 1 ? "" : "s"}`; }
  }
  return `${seconds} seconds`;
}
export const timerNotice = (seconds: number | undefined) =>
  seconds ? `Disappearing messages: ${describeDuration(seconds)}` : "Disappearing messages: turned off";

export interface Rendered { text: string; card?: Card }

const voiceOrVideo = (video: boolean) => (video ? "video call" : "voice call");

/** Card/summary for the non-text parts of a DataMessage (preview, gift badge, payment, group call, story reply...). */
export function renderDataExtras(dm: DataMessage, nameOf: (aci: string) => string, timeIso: string): Rendered | undefined {
  if (dm.giftBadge) {
    return { text: "Gift badge", card: { kind: "payment", title: "Gift badge", subtitle: "A donation gift badge was sent. Redeem it in Signal on your phone." } };
  }
  if (dm.payment?.notification) {
    const note = dm.payment.notification.note;
    return {
      text: note ? `Payment: ${note}` : "Payment sent",
      card: { kind: "payment", title: "Payment", subtitle: "MobileCoin payment", ...(note ? { body: note } : {}), footer: "Amount is only visible in Signal on your phone." },
    };
  }
  if (dm.payment?.activation) {
    const requested = dm.payment.activation.type === 0;
    return { text: requested ? "Payments activation requested" : "Payments activated", card: { kind: "payment", title: requested ? "Payments activation requested" : "Payments activated" } };
  }
  if (dm.groupCallUpdate) {
    return { text: "Group call started", card: { kind: "call", title: "Group call", subtitle: "A group call is in progress", when: timeIso } };
  }
  return undefined;
}

/** First link preview of a message as a card (text is kept as is). */
export function renderPreview(dm: DataMessage): Card | undefined {
  const p = dm.preview?.find((x) => x.url);
  if (!p) return undefined;
  return { kind: "link", title: p.title || p.url!, ...(p.description ? { body: p.description } : {}), url: p.url };
}

export function renderStoryReply(dm: DataMessage, authorName: string): Rendered | undefined {
  if (!dm.storyContext) return undefined;
  if (dm.reaction?.remove) return undefined; // removing a story reaction: nothing to show
  if (dm.reaction) {
    return { text: `Reacted ${dm.reaction.emoji ?? ""} to ${authorName}'s story`.replace("  ", " "), card: { kind: "other", title: "Story reaction", subtitle: `to ${authorName}'s story`, body: dm.reaction.emoji } };
  }
  return { text: dm.body ?? "", card: { kind: "other", title: "Reply to a story", subtitle: `${authorName}'s story` } };
}

/** Legacy CallMessage (modern 1:1 calls are signalled with opaque messages; the call log arrives as SyncMessage.CallEvent). */
export function renderCallMessage(c: CallMessagePb, timeIso: string): Rendered | undefined {
  if (c.offer) {
    const video = c.offer.type === 1;
    return { text: `Incoming ${voiceOrVideo(video)}`, card: { kind: "call", title: `Incoming ${voiceOrVideo(video)}`, subtitle: "Answer on your phone", when: timeIso } };
  }
  return undefined; // answer / ice / busy / hangup / opaque are signalling only
}

/** Call log entry mirrored from the phone (SyncMessage.CallEvent). */
export function renderCallEvent(e: CallEventPb): (Rendered & { incoming: boolean; group: boolean }) | undefined {
  // enums: type 1 audio, 2 video, 3 group, 4 ad-hoc; direction 1 incoming, 2 outgoing; event 1 accepted, 2 not accepted
  if (e.event !== 1 && e.event !== 2) return undefined; // DELETE / OBSERVED / unknown: not a user-visible entry
  const group = e.type === 3 || e.type === 4;
  const incoming = e.direction !== 2;
  const kind = group ? "group call" : voiceOrVideo(e.type === 2);
  const title = e.event === 1
    ? (group ? "Group call" : `${incoming ? "Incoming" : "Outgoing"} ${kind}`)
    : (incoming ? `Missed ${kind}` : `Unanswered ${kind}`);
  const when = e.timestamp !== undefined ? new Date(e.timestamp).toISOString() : undefined;
  return { text: title, incoming, group, card: { kind: "call", title, ...(when ? { when } : {}) } };
}

export const KNOWN_DATA_FIELDS = new Set([
  "body", "attachments", "groupV2", "flags", "expireTimer", "expireTimerVersion", "profileKey", "timestamp", "quote", "contact", "preview",
  "sticker", "requiredProtocolVersion", "isViewOnce", "reaction", "delete", "bodyRanges", "groupCallUpdate", "payment", "storyContext",
  "giftBadge", "pollCreate", "pollTerminate", "pollVote", "pinMessage", "unpinMessage", "adminDelete",
]);
/** Content oneof members we handle or deliberately ignore (signalling, stories we did not subscribe to, ...). */
export const KNOWN_CONTENT_FIELDS = new Set([
  "dataMessage", "syncMessage", "callMessage", "nullMessage", "receiptMessage", "typingMessage", "decryptionErrorMessage", "storyMessage", "editMessage",
]);

export function unsupportedFields(obj: object, known: Set<string>): string[] {
  return Object.keys(obj).filter((k) => !known.has(k) && k !== "content");
}
