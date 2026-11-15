// Row interpretation for the Signal Android database as it appears in a legacy backup. Table and column names changed over the years
// (sms+mms+part -> message+attachment; recipient_preferences -> recipient; reactions blob -> reaction table), so every access goes through
// small synonym lists and a missing column simply means "not available". Anything not understood is skipped and counted, never guessed.
import type { Message, Reaction } from "../model.js";
import type { SqlValue } from "./legacy.js";
import { Schema } from "./sql.js";
import { pbFields, pbString } from "./proto.js";
import { attachmentKind, groupIdFromAndroid, isE164, isUuid, iso, normAci, ourMsgId, placeholder, timerText, toMs, VIEW_ONCE_TEXT,
  type BackupIdentity, type ImportChat, type ImportedAttachment, type ImportedMessage } from "./model.js";

export type Row = Record<string, SqlValue>;
export const MESSAGE_TABLES = new Set(["sms", "mms", "message"]);
const num = (v: SqlValue | undefined): number | undefined => (v === null || v === undefined ? undefined : typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : undefined);
const str = (v: SqlValue | undefined): string | undefined => (v === null || v === undefined ? undefined : typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" ? String(v) : undefined);
const first = (r: Row, ...names: string[]) => { for (const n of names) if (r[n] !== undefined && r[n] !== null) return r[n]; return undefined; };
const idStr = (v: SqlValue | undefined) => (v === undefined || v === null ? undefined : String(v));

export interface RecipientInfo { id: string; aci?: string; e164?: string; groupRaw?: string; name?: string; username?: string; self?: boolean }
export interface PartRow { rowId?: string; uniqueId?: string; ct: string; name?: string; size: number; width?: number; height?: number; voice: boolean; gif: boolean; sticker: boolean; quote: boolean; blobKey: string }
export interface ReactionRow { author: string; emoji: string }

/** What the first pass learns about the backup (everything except the messages themselves). */
export class LegacyIndex {
  schema = new Schema();
  dbVersion?: number;
  recipients = new Map<string, RecipientInfo>();
  threads = new Map<string, string>();            // thread id -> recipient id
  groupTitles = new Map<string, string>();        // recipient id | raw group id -> title
  parts = new Map<string, PartRow[]>();           // "<mms|message>:<id>" -> parts
  reactions = new Map<string, ReactionRow[]>();   // same keys (+ "sms:")
  origSent = new Map<string, number>();           // revision handling: old revision row id -> its sent time
  identity: BackupIdentity = {};
  unknownTables = new Set<string>();
  messageTables = new Map<string, number>();
  rows = { unmappable: 0, statements: 0 };
  needSchema = new Set<string>();

  /** Feed one statement of the first pass. */
  feedRow(table: string, r: Row) {
    switch (table) {
      case "recipient": case "recipient_preferences": return this.recipient(r);
      case "thread": { const id = idStr(r["_id"]), rid = idStr(first(r, "recipient_id", "thread_recipient_id", "recipient_ids", "address")); if (id && rid) this.threads.set(id, rid); return; }
      case "groups": { const title = str(r["title"]); if (title) { const rid = idStr(r["recipient_id"]), gid = str(r["group_id"]); if (rid) this.groupTitles.set("r:" + rid, title); if (gid) this.groupTitles.set("g:" + gid, title); } return; }
      case "part": case "attachment": {
        const mid = idStr(first(r, "mid", "message_id")); if (!mid) return;
        const key = (table === "part" ? "mms:" : "message:") + mid;
        const p: PartRow = {
          rowId: idStr(r["_id"]), uniqueId: idStr(r["unique_id"]), ct: str(first(r, "ct", "content_type")) ?? "application/octet-stream", name: str(first(r, "file_name", "name")) || undefined,
          size: num(first(r, "data_size", "data_length")) ?? 0, width: num(r["width"]) || undefined, height: num(r["height"]) || undefined,
          voice: num(r["voice_note"]) === 1 || (table === "part" && r["voice_note"] === undefined && ((num(r["flags"]) ?? 0) & 1) === 1), gif: num(first(r, "video_gif")) === 1,
          sticker: !!str(first(r, "sticker_pack_id")), quote: num(r["quote"]) === 1 || num(r["quote_attachment"]) === 1, blobKey: "",
        };
        p.blobKey = `${p.rowId ?? ""}:${p.uniqueId ?? ""}`;
        const l = this.parts.get(key); if (l) l.push(p); else this.parts.set(key, [p]); return;
      }
      case "reaction": {
        const mid = idStr(r["message_id"]); const author = idStr(first(r, "author_id", "author")), emoji = str(r["emoji"]); if (!mid || !author || !emoji) return;
        const kind = r["is_mms"] === undefined ? "message" : num(r["is_mms"]) === 1 ? "mms" : "sms";
        const k = `${kind}:${mid}`; const l = this.reactions.get(k); const e = { author, emoji }; if (l) l.push(e); else this.reactions.set(k, [e]); return;
      }
    }
  }
  private recipient(r: Row) {
    const id = idStr(r["_id"]); if (!id) return;
    const uuid = str(first(r, "aci", "uuid")), phone = str(first(r, "e164", "phone", "recipient_ids")), raw = str(first(r, "group_id"));
    const join = (a?: string, b?: string) => [a, b].filter(Boolean).join(" ").trim() || undefined;
    const name = str(r["nickname_joined_name"]) || str(r["system_joined_name"]) || join(str(r["system_given_name"]), str(r["system_family_name"])) || str(r["system_display_name"])
      || str(r["profile_joined_name"]) || join(str(r["profile_given_name"]), str(r["profile_family_name"])) || str(r["signal_profile_name"]) || str(r["profile_name"]) || undefined;
    const groupRaw = raw ?? (phone && /^__(textsecure|signal)_group__/.test(phone) ? phone : undefined);
    this.recipients.set(id, { id, aci: isUuid(uuid) ? normAci(uuid) : undefined, e164: isE164(phone) ? phone : undefined, groupRaw, name, username: str(r["username"]) || undefined });
  }
  /** Own identity from KeyValue / preference frames. */
  feedKey(key: string, value: unknown) {
    const k = key.toLowerCase();
    if (typeof value !== "string") return;
    if ((/(^|[._])(aci|local_uuid|uuid)$/.test(k) || k === "pref_local_uuid") && isUuid(value)) this.identity.aci ??= normAci(value);
    else if ((/(^|[._])(e164|local_number|number)$/.test(k) || k === "pref_local_number") && isE164(value)) this.identity.e164 ??= value;
  }
  finish() {
    // the recipient row of the account owner (to tell outgoing rows in the merged message table)
    for (const r of this.recipients.values()) if ((this.identity.aci && r.aci === this.identity.aci) || (this.identity.e164 && r.e164 === this.identity.e164 && !r.aci)) r.self = true;
  }
}

export interface MapOptions { since?: number; until?: number; attachments: boolean; ownAci: string; resolveE164?: (e164: string) => string | undefined }
export type MapResult = { ok: ImportedMessage } | { skip: "draft" | "noise" | "empty" | "story" | "legacy-group" | "no-chat" | "range" | "revision" | "bad-time" | "unmappable" };

export class LegacyMapper {
  private chats = new Map<string, ImportChat>();
  private selfRid?: string | null;
  constructor(private ix: LegacyIndex, private o: MapOptions) {}
  chatList() { return [...this.chats.values()]; }

  private nameOf(rid: string | undefined): string {
    const r = rid ? this.ix.recipients.get(rid) : undefined;
    return r?.name || r?.username || r?.e164 || "Unknown";
  }
  /** native id of a person (ACI preferred) */
  private person(rid: string | undefined): { id: string; name: string; self: boolean; unresolved?: boolean } | undefined {
    if (!rid) return undefined; let r = this.ix.recipients.get(rid);
    if (!r) { if (isUuid(rid)) r = { id: rid, aci: normAci(rid) }; else if (isE164(rid)) r = { id: rid, e164: rid }; else return undefined; }
    if (r.self) return { id: this.o.ownAci, name: "Me", self: true };
    const aci = r.aci ?? (r.e164 ? this.o.resolveE164?.(r.e164) : undefined);
    if (aci) return { id: aci, name: this.nameOf(rid), self: aci === this.o.ownAci };
    if (r.e164) return { id: `e164:${r.e164}`, name: this.nameOf(rid), self: false, unresolved: true };
    return undefined;
  }
  private chatOf(threadId: string | undefined): ImportChat | { skip: "legacy-group" | "no-chat" } {
    const rid = threadId ? this.ix.threads.get(threadId) : undefined; if (!rid) return { skip: "no-chat" };
    const key = "t:" + rid; const hit = this.chats.get(key); if (hit) return hit;
    const r = this.ix.recipients.get(rid); if (!r) return { skip: "no-chat" };
    let c: ImportChat;
    if (r.groupRaw) {
      const g = groupIdFromAndroid(r.groupRaw); if (!g.id) return { skip: "legacy-group" };
      c = { id: g.id, kind: "group", name: this.ix.groupTitles.get("r:" + rid) ?? this.ix.groupTitles.get("g:" + r.groupRaw) ?? r.name, count: 0 };
    } else {
      const p = this.person(rid); if (!p) return { skip: "no-chat" };
      c = { id: p.id, kind: "dm", name: p.self ? "Note to Self" : p.name, count: 0, ...(p.unresolved ? { unresolved: true } : {}) };
    }
    this.chats.set(key, c); return c;
  }

  map(table: string, r: Row): MapResult {
    const type = num(r["type"]) ?? num(r["msg_box"]) ?? 0;
    const base = type & 0x1f;
    if (base === 27) return { skip: "draft" };
    const sentRaw = table === "mms" && r["date_sent"] === undefined ? num(r["date"]) : (num(r["date_sent"]) ?? num(r["date"]));
    const recvRaw = num(first(r, "date_received", "date"));
    const sent = toMs(sentRaw && sentRaw > 0 ? sentRaw : recvRaw ?? 0);
    if (!(sent > 0)) return { skip: "bad-time" };
    const latestRev = num(r["latest_revision_id"]);
    const rowId = idStr(r["_id"]);
    if (latestRev && latestRev > 0) { if (rowId) this.ix.origSent.set(rowId, sent); return { skip: "revision" }; }
    if ((this.o.since !== undefined && sent < this.o.since) || (this.o.until !== undefined && sent > this.o.until)) return { skip: "range" };
    if ((num(r["story_type"]) ?? 0) > 0 || (num(r["parent_story_id"]) ?? 0) !== 0) return { skip: "story" };
    const chat = this.chatOf(idStr(r["thread_id"])); if ("skip" in chat) return chat;

    // direction
    if (this.selfRid === undefined) this.selfRid = [...this.ix.recipients.values()].find((x) => x.self)?.id ?? null;
    const selfRid = this.selfRid ?? undefined;
    const fromRid = idStr(first(r, "from_recipient_id", "recipient_id", "address"));
    const outgoing = (base >= 21 && base <= 26) || base === 2 || base === 11 || (!!selfRid && r["from_recipient_id"] !== undefined && idStr(r["from_recipient_id"]) === selfRid);
    const author = outgoing ? { id: this.o.ownAci, name: "Me" } : this.person(fromRid) ?? (chat.kind === "dm" ? { id: chat.id, name: chat.name ?? "Unknown" } : undefined);
    if (!author) return { skip: "no-chat" };

    let text = str(r["body"]) ?? "";
    let system = false;
    // system rows
    const CALLS: Record<number, string> = { 1: "Incoming voice call", 2: "Outgoing voice call", 3: "Missed voice call", 8: "Missed video call", 10: "Incoming video call", 11: "Outgoing video call", 12: "Group call" };
    if (CALLS[base]) { text = CALLS[base]!; system = true; }
    else if (base < 20) return { skip: "noise" };             // joined Signal, profile change, GV1 migration, unsupported/invalid
    else if ((type & 0x40000) !== 0) { const ms = num(r["expires_in"]) ?? 0; text = timerText(ms > 1e6 ? ms / 1000 : ms); system = true; }
    else if ((type & 0x10000) !== 0 || (type & 0xff00) !== 0 || (type & 0x400000) !== 0) return { skip: "noise" }; // group updates, key exchange / safety number, end session

    const parts: ImportedAttachment[] = [];
    // id: an edited message keeps the id of its first revision (the live provider patches the original)
    const orig = num(r["original_message_id"]); const origSent = orig ? this.ix.origSent.get(String(orig)) : undefined;
    const idTs = origSent ?? sent, id = ourMsgId(author.id, idTs);
    const key = `${table === "sms" ? "sms" : table === "mms" ? "mms" : "message"}:${rowId}`;
    const rawParts = (this.ix.parts.get(key) ?? []).filter((p) => !p.quote);
    const viewOnce = num(r["view_once"]) === 1;
    if (!system && !viewOnce) {
      let i = 0;
      for (const p of rawParts) {
        const kind = attachmentKind(p.ct, { voice: p.voice, sticker: p.sticker });
        const attId = p.sticker ? `${id}#sticker` : `${id}#${i++}`;
        parts.push({ partKey: p.blobKey, size: p.size, att: { id: attId, kind, mime: p.ct, ...(p.name ? { name: p.name } : {}), ...(p.size ? { size: p.size } : {}), ...(p.width ? { width: p.width } : {}), ...(p.height ? { height: p.height } : {}), ...(p.gif ? { gif: true } : {}) } });
      }
    }
    text = this.mentions(text, r);
    const deleted = num(r["remote_deleted"]) === 1;
    if (deleted) text = "";
    if (viewOnce && !text) text = VIEW_ONCE_TEXT;

    const contacts = this.sharedContacts(str(r["shared_contacts"]));
    const card = this.linkCard(str(r["link_previews"]));
    if (!text && !(parts.length && this.o.attachments) && !contacts.length && !card && !deleted) {
      if (rawParts.length && !viewOnce) text = placeholder(attachmentKind(rawParts[0]!.ct, { voice: rawParts[0]!.voice, sticker: rawParts[0]!.sticker }), rawParts[0]!.name); else return { skip: "empty" };
    }

    const m: Message = { id, chatId: chat.id, sender: outgoing ? "Me" : author.name, senderId: author.id, text, time: iso(idTs), fromMe: outgoing,
      ...(parts.length && this.o.attachments ? { attachments: parts.map((p) => p.att) } : {}),
      ...(contacts.length ? { contacts } : {}), ...(card ? { card } : {}), ...(system ? { system: { kind: "info" as const } } : {}),
      ...(deleted ? { deleted: true } : {}) };
    if (origSent !== undefined || (num(r["revision_number"]) ?? 0) > 0) m.editedAt = iso(sent);
    if (outgoing && !system) {
      m.status = base === 24 || base === 25 || base === 26 ? "failed" : (num(r["read_receipt_count"]) ?? 0) > 0 || (num(r["viewed_receipt_count"]) ?? 0) > 0 ? "read" : (num(r["delivery_receipt_count"]) ?? 0) > 0 ? "delivered" : "sent";
    }
    // reply
    const qid = num(r["quote_id"]), qauthor = idStr(r["quote_author"]);
    if (qid && qid > 0 && qauthor) {
      const qa = this.person(qauthor);
      if (qa) m.replyTo = { messageId: ourMsgId(qa.id, toMs(qid)), sender: qa.self ? "Me" : qa.name, ...(str(r["quote_body"]) ? { textPreview: str(r["quote_body"])! } : {}) };
    }
    // reactions (reaction table, or the legacy blob column)
    const rl = this.ix.reactions.get(key) ?? this.blobReactions(r["reactions"]);
    if (rl?.length && !deleted) m.reactions = this.groupReactions(rl);
    return { ok: { chat, message: m, attachments: parts } };
  }

  private groupReactions(rl: { author: string; emoji: string }[]): Reaction[] {
    const by = new Map<string, Reaction>();
    for (const x of rl) {
      const p = this.person(x.author); const sid = p?.id ?? `r:${x.author}`; const e = by.get(x.emoji) ?? { emoji: x.emoji, senderIds: [] };
      if (!e.senderIds.includes(sid)) e.senderIds.push(sid); if (p?.self) e.mine = true; by.set(x.emoji, e);
    }
    return [...by.values()];
  }
  /** Old databases kept reactions as a protobuf ReactionList blob on the message row: { repeated Reaction { author=1 (recipient id), emoji=2, sentTime=3, receivedTime=4 } }. */
  private blobReactions(v: SqlValue | undefined): { author: string; emoji: string }[] | undefined {
    if (!Buffer.isBuffer(v) || !v.length) return undefined;
    try {
      const out: { author: string; emoji: string }[] = [];
      for (const f of pbFields(v)) if (f.n === 1 && f.w === 2) { let author = "", emoji = ""; for (const g of pbFields(f.v as Uint8Array)) { if (g.n === 1) author = String(g.v); else if (g.n === 2) emoji = pbString(g.v); } if (author && emoji) out.push({ author, emoji }); }
      return out;
    } catch { return undefined; }
  }
  /** Mentions are U+FFFC placeholders in the body; the BodyRangeList blob names who. */
  private mentions(text: string, r: Row): string {
    if (!text.includes("￼")) return text;
    const blob = first(r, "message_ranges", "body_ranges"); const names: string[] = [];
    if (Buffer.isBuffer(blob)) {
      try {
        const rs: { start: number; uuid?: string }[] = [];
        for (const f of pbFields(blob)) if (f.n === 1 && f.w === 2) { let start = 0, uuid: string | undefined; for (const g of pbFields(f.v as Uint8Array)) { if (g.n === 1) start = Number(g.v); else if (g.n === 3) uuid = pbString(g.v); } if (uuid) rs.push({ start, uuid }); }
        rs.sort((a, b) => a.start - b.start);
        for (const x of rs) { const rec = [...this.ix.recipients.values()].find((q) => q.aci === normAci(x.uuid)); names.push(rec ? (rec.self ? "me" : this.nameOf(rec.id)) : "someone"); }
      } catch { /* fall through to generic */ }
    }
    let i = 0; return text.replace(/￼/g, () => "@" + (names[i++] ?? "someone"));
  }
  private sharedContacts(json: string | undefined) {
    if (!json) return [];
    try {
      const a = JSON.parse(json) as any[]; if (!Array.isArray(a)) return [];
      return a.map((k) => ({ name: [k?.name?.givenName, k?.name?.familyName].filter(Boolean).join(" ") || k?.name?.nickname || k?.organization || "Contact",
        phones: (k?.phoneNumbers ?? k?.number ?? []).map((p: any) => p?.value).filter(Boolean), emails: (k?.emails ?? k?.email ?? []).map((p: any) => p?.value).filter(Boolean) }));
    } catch { return []; }
  }
  private linkCard(json: string | undefined) {
    if (!json) return undefined;
    try { const a = JSON.parse(json) as any[]; const p = Array.isArray(a) ? a.find((x) => x?.url) : undefined; if (!p) return undefined;
      return { kind: "link" as const, title: String(p.title || p.url), url: String(p.url), ...(p.description ? { body: String(p.description) } : {}) }; } catch { return undefined; }
  }
  /** Bookkeeping for the per-chat summary (counts, date range). */
  note(m: ImportedMessage) { const c = m.chat, t = Date.parse(m.message.time); c.count++; if (c.first === undefined || t < c.first) c.first = t; if (c.last === undefined || t > c.last) c.last = t; }
}
