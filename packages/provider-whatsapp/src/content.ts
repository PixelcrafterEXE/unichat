// Readable plain text (no emoji) for WhatsApp content types that are not text/media/polls. Pure and offline-testable.
import type { proto } from "@whiskeysockets/baileys";
import type { Card, Location, SharedContact } from "@unimsg/core";

type LongLike = number | { toNumber(): number } | null | undefined;
const n = (t: LongLike): number => (t == null ? 0 : typeof t === "number" ? t : t.toNumber());

/** "2025-03-04 18:30 UTC" (the provider does not know the viewer's time zone). */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
const fmtDuration = (s: number): string => {
  const m = Math.floor(s / 60), r = s % 60;
  return m ? `${m}m ${r}s` : `${r}s`;
};
const join = (parts: (string | null | undefined | false)[], sep: string) => parts.filter((x): x is string => !!x && x.trim() !== "").join(sep);

/** Parse a vCard into the shared contact model. */
export function parseVcard(vcard: string | null | undefined, displayName?: string | null): SharedContact {
  const lines = (vcard ?? "").replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const phones: string[] = [], emails: string[] = [];
  let fn: string | undefined, handle: string | undefined;
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const head = line.slice(0, i), val = line.slice(i + 1).trim();
    const prop = head.split(";")[0]!.toUpperCase().replace(/^ITEM\d+\./, "");
    if (prop === "FN" && val) fn = val;
    else if (prop === "TEL" && val) {
      phones.push(val);
      const waid = /waid=(\d+)/i.exec(head)?.[1];
      if (waid && !handle) handle = "+" + waid;
    } else if (prop === "EMAIL" && val) emails.push(val);
  }
  const c: SharedContact = { name: fn ?? displayName ?? phones[0] ?? "Contact" };
  if (phones.length) c.phones = phones;
  if (emails.length) c.emails = emails;
  if (handle) c.handle = handle;
  return c;
}

const vEsc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
/** vCard 3.0 for a shared contact. Numbers that look like phone numbers get a `waid` so WhatsApp can open the chat. */
export function buildVcard(c: SharedContact): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `N:;${vEsc(c.name)};;;`, `FN:${vEsc(c.name)}`];
  const phones = [...(c.phones ?? [])];
  if (c.handle && !phones.some((p) => p.replace(/\D/g, "") === c.handle!.replace(/\D/g, ""))) phones.unshift(c.handle);
  for (const p of phones) {
    const digits = p.replace(/\D/g, "");
    lines.push(digits.length >= 6 && digits.length <= 15 ? `TEL;type=CELL;waid=${digits}:${p}` : `TEL;type=CELL:${p}`);
  }
  for (const e of c.emails ?? []) lines.push(`EMAIL:${e}`);
  lines.push("END:VCARD");
  return lines.join("\n");
}

export const toLocation = (l: proto.Message.ILocationMessage): Location => {
  const loc: Location = { lat: l.degreesLatitude ?? 0, lng: l.degreesLongitude ?? 0 };
  if (l.name) loc.name = l.name;
  if (l.address) loc.address = l.address;
  if (l.isLive) loc.live = true;
  return loc;
};

const nativeLabel = (b: { name?: string | null; buttonParamsJson?: string | null }): string | undefined => {
  try {
    const j = JSON.parse(b.buttonParamsJson ?? "{}") as { display_text?: string; title?: string };
    return j.display_text || j.title || undefined;
  } catch { return undefined; }
};

function interactive(m: proto.Message.IInteractiveMessage, depth = 0): string {
  const buttons = (m.nativeFlowMessage?.buttons ?? []).map((b) => nativeLabel(b) ?? b.name).filter(Boolean) as string[];
  const cards = depth < 1 ? (m.carouselMessage?.cards ?? []).map((c) => interactive(c, depth + 1)).filter(Boolean) : [];
  return join([
    m.header?.title, m.header?.subtitle, m.body?.text, m.footer?.text,
    buttons.length ? `Options: ${buttons.join(", ")}` : "",
    ...cards.map((c, i) => `Card ${i + 1}: ${c.replace(/\n/g, " - ")}`),
  ], "\n");
}

function interactiveCard(m: proto.Message.IInteractiveMessage): Card {
  const card: Card = { kind: "template", title: m.header?.title || m.body?.text || "Message" };
  if (m.header?.subtitle) card.subtitle = m.header.subtitle;
  if (m.header?.title && m.body?.text) card.body = m.body.text;
  if (m.footer?.text) card.footer = m.footer.text;
  const b = btnLabels(m); if (b.length) card.buttons = b;
  const cards = m.carouselMessage?.cards ?? [];
  if (cards.length) card.rows = cards.map((x, i) => ({ label: `Card ${i + 1}`, value: x.header?.title || x.body?.text || "" }));
  return card;
}

function hydrated(t: proto.Message.TemplateMessage.IHydratedFourRowTemplate): string {
  const btns = (t.hydratedButtons ?? []).map((b) => b.quickReplyButton?.displayText ?? b.urlButton?.displayText ?? b.callButton?.displayText).filter(Boolean) as string[];
  return join([t.hydratedTitleText, t.hydratedContentText, t.hydratedFooterText, btns.length ? `Options: ${btns.join(", ")}` : ""], "\n");
}

const money = (amount1000: LongLike, cur?: string | null) => (amount1000 == null ? "" : `${(n(amount1000) / 1000).toFixed(2)}${cur ? " " + cur : ""}`);

const btnLabels = (m: proto.Message.IInteractiveMessage): string[] =>
  (m.nativeFlowMessage?.buttons ?? []).map((b) => nativeLabel(b) ?? b.name).filter((x): x is string => !!x);
const hydratedLabels = (t: proto.Message.TemplateMessage.IHydratedFourRowTemplate): string[] =>
  (t.hydratedButtons ?? []).map((b) => b.quickReplyButton?.displayText ?? b.urlButton?.displayText ?? b.callButton?.displayText).filter((x): x is string => !!x);

export interface Described { seq?: number; text: string; card?: Card; location?: Location; contacts?: SharedContact[]; context?: proto.IContextInfo | null; system?: boolean }
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Describe content that is neither plain text, media nor a poll.
 * Returns: Described = show it, "skip" = protocol/system noise that must not create a chat message, undefined = not recognised.
 */
export function describeOther(c: proto.IMessage): Described | "skip" | undefined {
  // --- structured payloads that become message fields
  if (c.locationMessage) return { text: c.locationMessage.comment ?? "", location: toLocation(c.locationMessage), context: c.locationMessage.contextInfo };
  if (c.liveLocationMessage) {
    const l = c.liveLocationMessage;
    return { text: l.caption ?? "", location: { lat: l.degreesLatitude ?? 0, lng: l.degreesLongitude ?? 0, live: true }, seq: n(l.sequenceNumber), context: l.contextInfo };
  }
  if (c.contactMessage) return { text: "", contacts: [parseVcard(c.contactMessage.vcard, c.contactMessage.displayName)], context: c.contactMessage.contextInfo };
  if (c.contactsArrayMessage) {
    return { text: "", contacts: (c.contactsArrayMessage.contacts ?? []).map((x) => parseVcard(x.vcard, x.displayName)), context: c.contactsArrayMessage.contextInfo };
  }

  // --- events
  if (c.eventMessage) {
    const e = c.eventMessage;
    const start = n(e.startTime) * 1000, end = n(e.endTime) * 1000;
    const when = start ? fmtTime(start) + (end ? ` to ${fmtTime(end)}` : "") : "";
    const place = join([e.location?.name, e.location?.address], ", ");
    const head = join([`${e.isCanceled ? "Event (canceled)" : "Event"}: ${e.name ?? ""}`.trim(), when, place], " - ");
    const card: Card = { kind: "event", title: e.name || "Event" };
    if (e.isCanceled) card.canceled = true;
    if (e.description) card.body = e.description;
    if (start) card.when = iso(start);
    if (end) card.until = iso(end);
    if (place) card.place = place;
    if (e.joinLink) card.url = e.joinLink;
    return { text: join([head, e.description, e.joinLink ? `Join: ${e.joinLink}` : ""], "\n"), card, context: e.contextInfo };
  }
  if (c.encEventResponseMessage || c.secretEncryptedMessage || c.eventCoverImage) return "skip";

  // --- invites
  if (c.groupInviteMessage) {
    const g = c.groupInviteMessage;
    const kind = g.groupType === 1 ? "Community invite" : "Group invite";
    const card: Card = { kind: "invite", title: g.groupName ?? kind, subtitle: kind };
    if (g.caption) card.body = g.caption;
    if (g.inviteCode) card.url = `https://chat.whatsapp.com/${g.inviteCode}`;
    return { text: join([`${kind}: ${g.groupName ?? ""}`.trim(), g.caption], "\n"), card, context: g.contextInfo };
  }
  if (c.newsletterAdminInviteMessage) {
    const g = c.newsletterAdminInviteMessage;
    const card: Card = { kind: "invite", title: g.newsletterName ?? "Channel", subtitle: "Channel admin invite" };
    if (g.caption) card.body = g.caption;
    return { text: join([`Channel admin invite: ${g.newsletterName ?? ""}`.trim(), g.caption], "\n"), card, context: g.contextInfo };
  }

  // --- calls
  if (c.scheduledCallCreationMessage) {
    const s = c.scheduledCallCreationMessage;
    const kind = s.callType === 2 ? "video" : s.callType === 1 ? "voice" : "";
    const ts = n(s.scheduledTimestampMs);
    const card: Card = { kind: "call", title: s.title || `Scheduled ${kind ? kind + " " : ""}call`, subtitle: `Scheduled ${kind ? kind + " " : ""}call` };
    if (ts) card.when = iso(ts);
    return { text: join([`Scheduled ${kind ? kind + " " : ""}call${s.title ? ": " + s.title : ""}`, ts ? fmtTime(ts) : ""], " - "), card };
  }
  if (c.scheduledCallEditMessage) {
    const t = c.scheduledCallEditMessage.editType === 1 ? "Scheduled call canceled" : "Scheduled call changed";
    return { text: t, card: { kind: "call", title: t } };
  }
  if (c.callLogMesssage) {
    const l = c.callLogMesssage;
    const kind = l.isVideo ? "video call" : "voice call";
    const out = l.callOutcome;
    const dur = n(l.durationSecs);
    const text = out === 1 ? `Missed ${kind}` : out === 3 ? `Declined ${kind}` : out === 2 ? `Failed ${kind}`
      : out === 4 ? `${kind[0]!.toUpperCase()}${kind.slice(1)} answered on another device`
      : out === 5 ? `Ongoing ${kind}` : out === 6 || out === 7 ? `${kind[0]!.toUpperCase()}${kind.slice(1)} silenced`
      : `${kind[0]!.toUpperCase()}${kind.slice(1)}${dur ? ` (${fmtDuration(dur)})` : ""}`;
    const card: Card = { kind: "call", title: text };
    if (dur) card.rows = [{ label: "Duration", value: fmtDuration(dur) }];
    return { text, card };
  }
  if (c.call) return { text: "Call", card: { kind: "call", title: "Call" } };

  // --- lists, buttons, templates, interactive
  if (c.listMessage) {
    const l = c.listMessage;
    const rowsRaw = (l.sections ?? []).flatMap((s) => (s.rows ?? []).filter((r) => r.title).map((r) => ({ label: r.title!, value: r.description ?? "" })));
    const rows = rowsRaw.map((r) => r.label);
    const card: Card = { kind: "list", title: l.title || l.description || "List" };
    if (l.title && l.description) card.body = l.description;
    if (l.footerText) card.footer = l.footerText;
    if (rowsRaw.length) card.rows = rowsRaw;
    if (l.buttonText) card.buttons = [l.buttonText];
    return { text: join([l.title, l.description, rows.length ? `Options: ${rows.join(", ")}` : "", l.footerText], "\n"), card, context: l.contextInfo };
  }
  if (c.listResponseMessage) return { text: `Selected: ${c.listResponseMessage.title ?? c.listResponseMessage.description ?? ""}`.trim(), context: c.listResponseMessage.contextInfo };
  if (c.buttonsMessage) {
    const b = c.buttonsMessage;
    const labels = (b.buttons ?? []).map((x) => x.buttonText?.displayText).filter(Boolean) as string[];
    const card: Card = { kind: "buttons", title: b.contentText ?? b.text ?? "Buttons" };
    if (b.footerText) card.footer = b.footerText;
    if (labels.length) card.buttons = labels;
    return { text: join([b.contentText ?? b.text, b.footerText, labels.length ? `Options: ${labels.join(", ")}` : ""], "\n"), card, context: b.contextInfo };
  }
  if (c.buttonsResponseMessage) return { text: `Selected: ${c.buttonsResponseMessage.selectedDisplayText ?? ""}`.trim(), context: c.buttonsResponseMessage.contextInfo };
  if (c.templateMessage) {
    const t = c.templateMessage;
    const h = t.hydratedTemplate ?? t.hydratedFourRowTemplate;
    if (h) {
      const card: Card = { kind: "template", title: h.hydratedTitleText || h.hydratedContentText || "Message" };
      if (h.hydratedTitleText && h.hydratedContentText) card.body = h.hydratedContentText;
      if (h.hydratedFooterText) card.footer = h.hydratedFooterText;
      const b = hydratedLabels(h); if (b.length) card.buttons = b;
      return { text: hydrated(h), card, context: t.contextInfo };
    }
    if (t.interactiveMessageTemplate) return { text: interactive(t.interactiveMessageTemplate), card: interactiveCard(t.interactiveMessageTemplate), context: t.contextInfo };
    const f = t.fourRowTemplate;
    const body = f?.content?.fallbackLg ?? f?.content?.deterministicLg ?? "";
    const card: Card = { kind: "template", title: body || "Message" };
    if (f?.footer?.fallbackLg) card.footer = f.footer.fallbackLg;
    return { text: join([body, f?.footer?.fallbackLg], "\n"), card, context: t.contextInfo };
  }
  if (c.templateButtonReplyMessage) return { text: `Selected: ${c.templateButtonReplyMessage.selectedDisplayText ?? ""}`.trim(), context: c.templateButtonReplyMessage.contextInfo };
  if (c.interactiveMessage) return { text: interactive(c.interactiveMessage), card: interactiveCard(c.interactiveMessage), context: c.interactiveMessage.contextInfo };
  if (c.interactiveResponseMessage) {
    const r = c.interactiveResponseMessage;
    return { text: `Selected: ${r.body?.text ?? r.nativeFlowResponseMessage?.name ?? ""}`.trim(), context: r.contextInfo };
  }
  if (c.highlyStructuredMessage) {
    const h = c.highlyStructuredMessage;
    const hy = h.hydratedHsm?.hydratedTemplate;
    const text = (hy ? hydrated(hy) : "") || h.fallbackLg || h.deterministicLg || (h.params ?? []).join(" ");
    const card: Card = { kind: "template", title: hy?.hydratedTitleText || hy?.hydratedContentText || text || "Message" };
    if (hy?.hydratedTitleText && hy.hydratedContentText) card.body = hy.hydratedContentText;
    if (hy?.hydratedFooterText) card.footer = hy.hydratedFooterText;
    const b = hy ? hydratedLabels(hy) : []; if (b.length) card.buttons = b;
    return { text, card };
  }

  // --- commerce
  if (c.productMessage) {
    const p = c.productMessage.product;
    const price = money(p?.priceAmount1000, p?.currencyCode);
    const card: Card = { kind: "product", title: p?.title ?? "Product" };
    if (p?.description) card.body = p.description;
    const rows: { label: string; value: string }[] = [];
    if (price) rows.push({ label: "Price", value: price });
    if (p?.retailerId) rows.push({ label: "Item", value: p.retailerId });
    if (rows.length) card.rows = rows;
    if (p?.url) card.url = p.url;
    if (c.productMessage.body) card.footer = c.productMessage.body;
    return { text: join([`Product: ${p?.title ?? ""}`.trim(), price, p?.description, c.productMessage.body], " - "), card, context: c.productMessage.contextInfo };
  }
  if (c.orderMessage) {
    const o = c.orderMessage;
    const total = money(o.totalAmount1000, o.totalCurrencyCode);
    const card: Card = { kind: "order", title: o.orderTitle ?? o.message ?? "Order" };
    if (o.message && o.orderTitle) card.body = o.message;
    const rows: { label: string; value: string }[] = [];
    if (o.itemCount) rows.push({ label: "Items", value: String(o.itemCount) });
    if (total) rows.push({ label: "Total", value: total });
    if (o.sellerJid) rows.push({ label: "Seller", value: o.sellerJid.slice(0, o.sellerJid.indexOf("@")) });
    if (rows.length) card.rows = rows;
    return { text: join([`Order: ${o.orderTitle ?? o.message ?? ""}`.trim(), o.itemCount ? `${o.itemCount} items` : "", total], " - "), card, context: o.contextInfo };
  }

  // --- payments
  if (c.requestPaymentMessage) {
    const r = c.requestPaymentMessage;
    const amount = money(r.amount1000, r.currencyCodeIso4217);
    const card: Card = { kind: "payment", title: "Payment request" };
    if (amount) card.rows = [{ label: "Amount", value: amount }];
    if (n(r.expiryTimestamp)) card.until = iso(n(r.expiryTimestamp) * 1000);
    return { text: join(["Payment request", amount], " - "), card };
  }
  if (c.sendPaymentMessage) return { text: "Payment sent", card: { kind: "payment", title: "Payment sent" } };
  if (c.declinePaymentRequestMessage) return { text: "Payment request declined", card: { kind: "payment", title: "Payment request declined" } };
  if (c.cancelPaymentRequestMessage) return { text: "Payment request canceled", card: { kind: "payment", title: "Payment request canceled" } };
  if (c.paymentInviteMessage) return { text: "Payment invitation", card: { kind: "payment", title: "Payment invitation" } };
  if (c.invoiceMessage) {
    const card: Card = { kind: "payment", title: "Invoice" };
    if (c.invoiceMessage.note) card.body = c.invoiceMessage.note;
    return { text: join(["Invoice", c.invoiceMessage.note], " - "), card };
  }

  // --- chat-level actions
  if (c.pinInChatMessage) return { text: c.pinInChatMessage.type === 2 ? "Unpinned a message" : "Pinned a message", system: true };
  if (c.keepInChatMessage || c.albumMessage || c.placeholderMessage || c.statusMentionMessage || c.pollResultSnapshotMessage ||
      c.messageHistoryBundle || c.messageHistoryNotice || c.limitSharingMessage || c.groupStatusMentionMessage || c.associatedChildMessage) return "skip";
  if (c.requestPhoneNumberMessage) return { text: "Asked for your phone number", context: c.requestPhoneNumberMessage.contextInfo };
  if (c.stickerPackMessage) return { text: "Sticker pack", card: { kind: "other", title: "Sticker pack" } };
  return undefined;
}

/** Name of the first populated top-level field, for the "[unsupported message: x]" fallback. */
export function topLevelField(c: proto.IMessage): string | undefined {
  return Object.keys(c).find((k) => (c as Record<string, unknown>)[k] != null && k !== "messageContextInfo");
}
