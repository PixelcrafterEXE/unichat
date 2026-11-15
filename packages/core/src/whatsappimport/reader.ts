// Reads the decrypted WhatsApp msgstore.db (SQLite) and maps it to UniChat messages, streaming message by message.
// The schema differs between WhatsApp versions, so every table/column is discovered with PRAGMA table_info; a missing optional table or
// column simply means "not available". Only an unrecognisable core (no message/chat/jid tables) is refused as an unsupported schema.
// The mapping follows the schema as documented by the community (wa-crypt-tools / forensic write-ups) and is verified only against a
// synthetic database built by fixture.ts, not a real msgstore.db.
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { BackupError } from "../container.js";
import type { Attachment, AttachmentKind, Message, Poll, Reaction, SharedContact } from "../model.js";

export interface WaChat { id: string; kind: "dm" | "group"; name?: string; unresolved?: boolean; disappearing?: number; count: number; first?: number; last?: number }
export interface WaMsg { chat: WaChat; message: Message }
export interface RunOpts {
  signal?: AbortSignal; onProgress?: (done: number, total: number) => void;
  /** the WhatsApp folder (the one that holds `Media/`); undefined = no media available */
  mediaRoot?: string; attachments: boolean; since?: number; until?: number;
  ownId: string; lidToPn?: (lid: string) => string | undefined;
  onMessage(m: WaMsg): Promise<void> | void;
  onBlob(att: Attachment, owner: WaMsg, data: Buffer): Promise<void> | void;
}
export interface RunStats {
  messages: number; skipped: Record<string, number>; chats: WaChat[]; first?: number; last?: number;
  attachments: { listed: number; bytes: number; present: number; stored: number; missing: number; mismatch: number; tooLarge: number };
  unresolvedChats: number; warnings: string[];
}

type V = null | number | bigint | string | Uint8Array;
type Row = Record<string, V>;
const num = (v: V | undefined): number | undefined => (v === null || v === undefined ? undefined : typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: V | undefined): string | undefined => (v === null || v === undefined ? undefined : typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" ? String(v) : undefined);
const MAX_MEDIA = 256 * 1024 * 1024;
export const iso = (ms: number) => new Date(ms).toISOString();
const preview = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---- jid helpers (same canonical form as provider-whatsapp/map.ts: no device suffix, c.us -> s.whatsapp.net)
export function normJid(jid: string): string {
  const at = jid.indexOf("@"); if (at < 0) return jid;
  let user = jid.slice(0, at), server = jid.slice(at + 1);
  const colon = user.indexOf(":"); if (colon >= 0) user = user.slice(0, colon);
  if (server === "c.us") server = "s.whatsapp.net";
  return `${user}@${server}`;
}
const isGroup = (j: string) => j.endsWith("@g.us"), isLid = (j: string) => j.endsWith("@lid"), isUser = (j: string) => j.endsWith("@s.whatsapp.net") || isLid(j);
const handleOf = (j: string) => (j.endsWith("@s.whatsapp.net") ? "+" + j.slice(0, j.indexOf("@")) : undefined);

const T = { TEXT: 0, IMAGE: 1, AUDIO: 2, VIDEO: 3, CONTACT: 4, LOCATION: 5, SYSTEM: 7, CALL: 8, DOC: 9, MISSED: 10, GIF: 13, VCARDS: 14, REVOKED: 15, LIVE: 16, STICKER: 20, VO_IMAGE: 42, VO_VIDEO: 43, REVOKED_ADMIN: 64, POLL: 66, CALL_LOG: 90 } as const;
const MEDIA_TYPES = new Set<number>([T.IMAGE, T.AUDIO, T.VIDEO, T.DOC, T.GIF, T.STICKER]);
export const VIEW_ONCE_TEXT = "[View-once media - open it in WhatsApp on your phone]";
const placeholder = (k: AttachmentKind, name?: string) => k === "image" ? "[Photo]" : k === "video" ? "[Video]" : k === "voice" ? "[Voice message]" : k === "audio" ? "[Audio]" : k === "sticker" ? "[Sticker]" : `[File${name ? ": " + name : ""}]`;
/** Stable poll option id = hex sha256 of the option text: the same id the live provider (map.ts optionId) and votes use. */
export const optionId = (name: string) => createHash("sha256").update(name).digest("hex");

/** "Missed voice call", "Video call · 4:12", "Outgoing voice call · 0:42", "Unanswered video call". */
export function callText(c: { video: boolean; outgoing: boolean; seconds: number; missed?: boolean }): string {
  const kind = c.video ? "video call" : "voice call", s = Math.max(0, Math.round(c.seconds));
  if (s > 0 && !c.missed) return `${c.outgoing ? "Outgoing" : "Incoming"} ${kind} · ${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}` : Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return c.outgoing && !c.missed ? `Unanswered ${kind}` : `Missed ${kind}`;
}

export class Schema {
  private t = new Map<string, Set<string>>();
  constructor(db: any) {
    for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]) {
      const cols = new Set<string>();
      for (const c of db.prepare(`PRAGMA table_info("${r.name.replace(/"/g, '""')}")`).all() as { name: string }[]) cols.add(String(c.name).toLowerCase());
      this.t.set(r.name.toLowerCase(), cols);
    }
  }
  has(t: string, c?: string) { const x = this.t.get(t); return !!x && (!c || x.has(c)); }
  first(t: string, ...c: string[]) { return c.find((n) => this.has(t, n)); }
  tables() { return [...this.t.keys()]; }
}

let sqliteMod: any;
async function loadSqlite() {
  if (!sqliteMod) { try { sqliteMod = await import("node:sqlite"); } catch { /* reported by open() */ } }
  if (!sqliteMod?.DatabaseSync) throw new BackupError("unsupported-version", "This system has no built-in SQLite support (Node 22.5 or newer is needed to read WhatsApp backups).");
  return sqliteMod;
}

export class WaReader {
  readonly schema: Schema; readonly dbVersion: number;
  private constructor(private db: any) {
    this.schema = new Schema(db);
    this.dbVersion = Number((db.prepare("PRAGMA user_version").get() as any)?.user_version ?? 0);
  }
  static async open(path: string): Promise<WaReader> {
    const mod = await loadSqlite();
    const bad = () => new BackupError("corrupt", "The decrypted backup is not a readable SQLite database.");
    let db: any; try { db = new mod.DatabaseSync(path); db.exec("PRAGMA query_only=ON"); } catch { throw bad(); }
    try { const r = new WaReader(db); r.check(); return r; }
    catch (e) { try { db.close(); } catch { /* ignore */ } throw e instanceof BackupError ? e : bad(); }
  }
  close() { try { this.db.close(); } catch { /* ignore */ } }

  private check() {
    const s = this.schema;
    if (!s.has("message") && (s.has("messages") || s.has("chat_list")))
      throw new BackupError("unsupported-version", "Unsupported schema: this backup uses the pre-2022 WhatsApp database layout (a `messages` table). Update WhatsApp on the phone, create a new backup and import that one.");
    for (const [t, cols] of [["message", ["_id", "chat_row_id", "key_id", "timestamp", "message_type", "from_me"]], ["chat", ["_id", "jid_row_id"]], ["jid", ["_id"]]] as const)
      for (const c of cols) if (!s.has(t, c)) throw new BackupError("unsupported-version", `Unsupported schema: the table \`${t}\` ${s.has(t) ? `has no column \`${c}\`` : "is missing"}. This backup comes from a WhatsApp version this importer has not seen, or it is not msgstore.db.`);
    if (!s.has("jid", "raw_string") && !(s.has("jid", "user") && s.has("jid", "server"))) throw new BackupError("unsupported-version", "Unsupported schema: the table `jid` has neither `raw_string` nor `user`+`server`.");
  }

  total(): number { return Number((this.db.prepare("SELECT COUNT(*) AS n FROM message").get() as any).n); }
  private all(sql: string): Row[] { try { return this.db.prepare(sql).all() as Row[]; } catch { return []; } }
  private pick(table: string, alias: string, cols: string[], prefix: string) { return cols.filter((c) => this.schema.has(table, c)).map((c) => `${alias}.${c} AS ${prefix}${c}`); }

  async run(o: RunOpts): Promise<RunStats> {
    const s = this.schema, db = this.db;
    const stats: RunStats = { messages: 0, skipped: {}, chats: [], attachments: { listed: 0, bytes: 0, present: 0, stored: 0, missing: 0, mismatch: 0, tooLarge: 0 }, unresolvedChats: 0, warnings: [] };
    const skip = (k: string) => { stats.skipped[k] = (stats.skipped[k] ?? 0) + 1; };

    // ---- small tables, loaded once
    const jids = new Map<number, string>();
    for (const r of this.all(`SELECT _id${s.has("jid", "raw_string") ? ", raw_string" : ""}${s.has("jid", "user") ? ", user" : ""}${s.has("jid", "server") ? ", server" : ""} FROM jid`)) {
      let raw = str(r.raw_string); if (!raw && str(r.user)) raw = `${str(r.user)}@${str(r.server) || "s.whatsapp.net"}`;
      if (raw) jids.set(num(r._id)!, normJid(raw));
    }
    const lidMap = new Map<string, string>(); // lid -> phone-number jid, from the backup's own jid_map (the live provider's map wins)
    if (s.has("jid_map", "lid_row_id") && s.has("jid_map", "jid_row_id")) for (const r of this.all("SELECT lid_row_id, jid_row_id FROM jid_map")) { const l = jids.get(num(r.lid_row_id)!), p = jids.get(num(r.jid_row_id)!); if (l && p && isLid(l) && p.endsWith("@s.whatsapp.net")) lidMap.set(l, p); }
    const canon = (j: string): string => { const n = normJid(j); if (!isLid(n)) return n; const live = o.lidToPn?.(n); return (live ? normJid(live) : undefined) ?? lidMap.get(n) ?? n; };
    const nameOf = (j: string) => handleOf(j) ?? (isLid(j) ? "WhatsApp user" : j.slice(0, j.indexOf("@")) || j);
    const chatCols = ["subject", "ephemeral_expiration"].filter((c) => s.has("chat", c));
    const chats = new Map<number, { jid: string; stats: WaChat }>(), byJid = new Map<string, WaChat>();
    for (const r of this.all(`SELECT _id, jid_row_id${chatCols.map((c) => ", " + c).join("")} FROM chat`)) {
      const j = jids.get(num(r.jid_row_id)!); if (!j) continue;
      const id = canon(j), kind = isGroup(id) ? "group" : "dm", eph = num(r.ephemeral_expiration);
      let st = byJid.get(id);
      if (!st) { st = { id, kind, name: kind === "group" ? str(r.subject) || undefined : undefined, count: 0, ...(isLid(id) ? { unresolved: true } : {}), ...(eph && eph > 0 ? { disappearing: eph } : {}) }; byJid.set(id, st); }
      chats.set(num(r._id)!, { jid: id, stats: st });
    }

    // reactions / poll votes: message_add_on (+ typed child tables), keyed by the message they belong to
    const addOn = new Map<number, { msg: number; sender?: string; fromMe: boolean }>();
    const reactions = new Map<number, Map<string, string>>(); // msgRow -> sender -> emoji (last wins)
    const who = (a: { sender?: string; fromMe: boolean }) => (a.fromMe ? o.ownId : a.sender ?? "?");
    if (s.has("message_add_on", "message_row_id")) {
      const cs = ["_id", "message_row_id", "sender_jid_row_id", "from_me"].filter((c) => s.has("message_add_on", c));
      for (const r of this.all(`SELECT ${cs.join(",")} FROM message_add_on ORDER BY _id`)) { const j = jids.get(num(r.sender_jid_row_id)!); addOn.set(num(r._id)!, { msg: num(r.message_row_id)!, sender: j ? canon(j) : undefined, fromMe: num(r.from_me) === 1 }); }
      if (s.has("message_add_on_reaction", "message_add_on_row_id") && s.has("message_add_on_reaction", "reaction"))
        for (const r of this.all("SELECT message_add_on_row_id, reaction FROM message_add_on_reaction ORDER BY message_add_on_row_id")) {
          const a = addOn.get(num(r.message_add_on_row_id)!); if (!a) continue;
          const m = reactions.get(a.msg) ?? new Map<string, string>(), e = str(r.reaction);
          if (e) m.set(who(a), e); else m.delete(who(a)); reactions.set(a.msg, m);
        }
    }
    const pollOpts = new Map<number, { rowId: number; name: string }[]>(), pollMeta = new Map<number, number | undefined>();
    if (s.has("message_poll_option", "message_row_id") && s.has("message_poll_option", "option_name"))
      for (const r of this.all("SELECT _id, message_row_id, option_name FROM message_poll_option ORDER BY _id")) { const l = pollOpts.get(num(r.message_row_id)!) ?? []; l.push({ rowId: num(r._id)!, name: str(r.option_name) ?? "" }); pollOpts.set(num(r.message_row_id)!, l); }
    const selCol = s.first("message_add_on_poll_vote_selected_option", "message_poll_option_id", "poll_option_id", "selected_option_id", "option_id");
    const votes = new Map<number, Map<string, Set<number>>>(); // poll msgRow -> voter -> selected option row ids (a voter's latest update replaces the earlier ones)
    if (selCol && s.has("message_add_on_poll_vote_selected_option", "message_add_on_row_id")) {
      const latest = new Map<string, number>();
      const rows = this.all(`SELECT message_add_on_row_id AS a, ${selCol} AS o FROM message_add_on_poll_vote_selected_option ORDER BY message_add_on_row_id`);
      for (const r of rows) { const a = addOn.get(num(r.a)!); if (a) latest.set(`${a.msg}|${who(a)}`, num(r.a)!); }
      for (const r of rows) {
        const aid = num(r.a)!, a = addOn.get(aid); if (!a || latest.get(`${a.msg}|${who(a)}`) !== aid) continue;
        const m = votes.get(a.msg) ?? new Map<string, Set<number>>(), set = m.get(who(a)) ?? new Set<number>(); set.add(num(r.o)!); m.set(who(a), set); votes.set(a.msg, m);
      }
    }
    if (s.has("message_poll", "message_row_id")) { const c = s.first("message_poll", "selectable_options_count"); for (const r of this.all(`SELECT message_row_id${c ? ", " + c : ""} FROM message_poll`)) pollMeta.set(num(r.message_row_id)!, c ? num(r[c]) : undefined); }
    const vcards = new Map<number, string[]>();
    if (s.has("message_vcard", "message_row_id") && s.has("message_vcard", "vcard")) for (const r of this.all("SELECT message_row_id, vcard FROM message_vcard ORDER BY _id")) { const l = vcards.get(num(r.message_row_id)!) ?? []; const v = str(r.vcard); if (v) l.push(v); vcards.set(num(r.message_row_id)!, l); }
    const revoked = new Set<number>();
    if (s.has("message_revoked", "message_row_id")) for (const r of this.all("SELECT message_row_id FROM message_revoked")) revoked.add(num(r.message_row_id)!);

    // ---- the main stream: message + 1:1 side tables in one ordered scan
    const sel: string[] = ["m._id AS id", "m.chat_row_id AS chat_row_id", "m.key_id AS key_id", "m.timestamp AS ts", "m.message_type AS mtype", "m.from_me AS from_me",
      ...this.pick("message", "m", ["sender_jid_row_id", "status", "received_timestamp", "text_data"], "m_")];
    const joins: string[] = [];
    const side = (t: string, alias: string, cols: string[]) => { if (!s.has(t, "message_row_id")) return; joins.push(`LEFT JOIN ${t} ${alias} ON ${alias}.message_row_id = m._id`); sel.push(...this.pick(t, alias, cols, alias + "_")); };
    side("message_media", "mm", ["file_path", "file_size", "mime_type", "media_name", "media_caption", "file_hash", "media_duration", "width", "height", "gif_attribution"]);
    side("message_location", "ml", ["latitude", "longitude", "place_name", "place_address"]);
    side("message_quoted", "mq", ["key_id", "text_data", "sender_jid_row_id", "from_me"]);
    side("message_edit_info", "me", ["original_key_id", "edited_timestamp"]);
    side("message_ephemeral", "mp", ["duration"]);
    side("message_forwarded", "mf", ["forward_score"]);
    side("message_system", "ms", ["action_type"]);
    // calls: type 8 (call), 10 (missed call), 90 (call log). The details live in `call_log`, linked by message_row_id or by call_id = key_id (schema differs by version)
    const clKey = s.has("call_log", "message_row_id") ? "message_row_id" : s.has("call_log", "call_id") ? "call_id" : undefined;
    if (clKey) { joins.push(`LEFT JOIN call_log cl ON cl.${clKey} = ${clKey === "call_id" ? "m.key_id" : "m._id"}`); sel.push(...this.pick("call_log", "cl", ["video_call", "duration", "call_result", "from_me"], "cl_")); }
    side("message_view_once_media", "mv", ["state"]);
    const stmt = db.prepare(`SELECT ${sel.join(", ")} FROM message m ${joins.join(" ")} ORDER BY m._id`);
    const total = this.total();
    const realRoot = o.mediaRoot && existsSync(o.mediaRoot) ? realpathSync(o.mediaRoot) : undefined;
    const inside = (p: string) => { const r = relative(realRoot!, p); return !!r && !r.startsWith("..") && !isAbsolute(r); };
    const findMedia = (rel: string | undefined): string | undefined => {
      if (!realRoot || !rel) return undefined;
      const r = rel.replace(/\\/g, "/").replace(/^\/+/, "");
      for (const cand of new Set([r, r.replace(/^WhatsApp\//i, ""), r.replace(/^(.*?\/)?Media\//i, "Media/")])) {
        const p = resolve(realRoot, cand); if (!inside(p)) continue;
        try { if (!existsSync(p) || !statSync(p).isFile()) continue; const rp = realpathSync(p); if (inside(rp)) return rp; } catch { /* next */ }
      }
      return undefined;
    };

    let n = 0;
    for (const row of stmt.iterate() as Iterable<Row>) {
      if (++n % 500 === 0) { o.onProgress?.(n, total); await new Promise((r) => setImmediate(r)); }
      if (o.signal?.aborted) throw new BackupError("cancelled", "Cancelled. Nothing was imported.");
      const chat = chats.get(num(row.chat_row_id)!);
      if (!chat) { skip("no-chat"); continue; }
      const cj = chat.jid;
      if (!(isGroup(cj) || isUser(cj))) { skip("chat-unsupported"); continue; } // status, broadcast lists, newsletters
      const rowId = num(row.id)!, type = num(row.mtype) ?? -1, keyId = str(row.key_id);
      if (!keyId) { skip("no-id"); continue; }
      let ts = num(row.ts) ?? 0; if (!(ts > 0)) ts = num(row.m_received_timestamp) ?? 0; if (ts > 0 && ts < 1e11) ts *= 1000;
      if (!(ts > 0)) { skip("no-time"); continue; }
      if ((o.since !== undefined && ts < o.since) || (o.until !== undefined && ts > o.until)) { skip("out-of-range"); continue; }
      const fromMe = num(row.from_me) === 1;
      const text0 = str(row.m_text_data) ?? str(row.mm_media_caption) ?? "";
      const isRevoked = type === T.REVOKED || type === T.REVOKED_ADMIN || revoked.has(rowId);
      const isCall = type === T.CALL || type === T.MISSED || type === T.CALL_LOG;
      if (!isRevoked && type === T.SYSTEM) { skip(`system-${num(row.ms_action_type) ?? "?"}`); continue; }

      const sj = jids.get(num(row.m_sender_jid_row_id)!);
      const senderId = fromMe ? o.ownId : isGroup(cj) ? (sj ? canon(sj) : cj) : cj;
      const m: Message = { id: str(row.me_original_key_id) || keyId, chatId: cj, sender: fromMe ? "Me" : nameOf(senderId), senderId, text: "", time: iso(ts), fromMe };
      const eph = num(row.mp_duration); if (eph && eph > 0) m.expiresIn = eph;
      if ((num(row.mf_forward_score) ?? 0) > 0) m.forwarded = true;
      const ed = num(row.me_edited_timestamp); if (ed && ed > 0) m.editedAt = iso(ed < 1e11 ? ed * 1000 : ed);
      if (fromMe) { const st = num(row.m_status); m.status = st === 13 || st === 14 || st === 8 ? "read" : st === 5 ? "delivered" : "sent"; }
      let blob: Buffer | undefined;

      if (isRevoked) m.deleted = true;
      else {
        const qk = str(row.mq_key_id);
        if (qk) {
          const qj = jids.get(num(row.mq_sender_jid_row_id)!), qt = str(row.mq_text_data);
          m.replyTo = { messageId: qk, ...(num(row.mq_from_me) === 1 ? { sender: "Me" } : qj ? { sender: nameOf(canon(qj)) } : isGroup(cj) ? {} : { sender: nameOf(cj) }), ...(qt ? { textPreview: preview(qt) } : {}) };
        }
        if (isCall) {
          const outgoing = row.cl_from_me !== undefined && row.cl_from_me !== null ? num(row.cl_from_me) === 1 : fromMe;
          m.text = callText({ video: (num(row.cl_video_call) ?? 0) === 1, outgoing, seconds: num(row.cl_duration) ?? num(row.mm_media_duration) ?? 0, missed: type === T.MISSED });
          m.system = { kind: "info" };
        } else {
        const viewOnce = type === T.VO_IMAGE || type === T.VO_VIDEO || (row.mv_state !== undefined && row.mv_state !== null);
        if (viewOnce) { m.viewOnce = true; m.text = VIEW_ONCE_TEXT; }
        else if (MEDIA_TYPES.has(type)) {
          const mime = str(row.mm_mime_type) || (type === T.IMAGE ? "image/jpeg" : type === T.VIDEO || type === T.GIF ? "video/mp4" : type === T.AUDIO ? "audio/ogg" : type === T.STICKER ? "image/webp" : "application/octet-stream");
          const path = str(row.mm_file_path), name = str(row.mm_media_name) || (path ? path.split(/[\\/]/).pop() : undefined);
          const voice = type === T.AUDIO && (/Voice Notes/i.test(path ?? "") || /\.opus$/i.test(path ?? ""));
          const kind: AttachmentKind = type === T.STICKER ? "sticker" : type === T.IMAGE ? "image" : type === T.VIDEO || type === T.GIF ? "video" : type === T.AUDIO ? (voice ? "voice" : "audio") : "file";
          const att: Attachment = { id: "a0", kind, mime }; if (name && kind === "file") att.name = name;
          const w = num(row.mm_width), h = num(row.mm_height), dur = num(row.mm_media_duration), size = num(row.mm_file_size);
          if (w) att.width = w; if (h) att.height = h; if (dur) att.durationMs = dur * 1000; if (size && size > 0) att.size = size;
          if (type === T.GIF || (type === T.VIDEO && (num(row.mm_gif_attribution) ?? 0) > 0)) att.gif = true;
          m.text = text0;
          stats.attachments.listed++; stats.attachments.bytes += size ?? 0;
          const file = findMedia(path);
          if (file) {
            stats.attachments.present++;
            if (o.attachments) {
              if (statSync(file).size > MAX_MEDIA) stats.attachments.tooLarge++;
              else {
                const b = await readFile(file), hash = str(row.mm_file_hash);
                if ((size && size > 0 && b.length !== size) || (hash && /^[A-Za-z0-9+/]{43}=$/.test(hash) && createHash("sha256").update(b).digest("base64") !== hash)) stats.attachments.mismatch++;
                else blob = b;
              }
            }
          }
          if (blob) { att.size = blob.length; m.attachments = [att]; }
          else { if (!m.text) m.text = placeholder(kind, att.name); }
        } else if (type === T.LOCATION || type === T.LIVE) {
          const lat = num(row.ml_latitude), lng = num(row.ml_longitude);
          if (lat === undefined || lng === undefined) { skip("location-empty"); continue; }
          m.location = { lat, lng, ...(str(row.ml_place_name) ? { name: str(row.ml_place_name) } : {}), ...(str(row.ml_place_address) ? { address: str(row.ml_place_address) } : {}), ...(type === T.LIVE ? { live: true, updatedAt: m.time } : {}) };
          m.text = text0;
        } else if (type === T.CONTACT || type === T.VCARDS) {
          const cs = (vcards.get(rowId) ?? []).map(parseVcard).filter((x): x is SharedContact => !!x);
          if (!cs.length) { skip("contact-empty"); continue; }
          m.contacts = cs; m.text = text0;
        } else if (type === T.POLL) {
          const os = pollOpts.get(rowId) ?? []; if (!os.length) { skip("poll-empty"); continue; }
          const byRow = new Map(os.map((x) => [x.rowId, optionId(x.name)]));
          const poll: Poll = { question: text0, multiple: (pollMeta.get(rowId) ?? 0) !== 1, options: os.map((x) => ({ id: optionId(x.name), text: x.name, voters: [] as string[] })) };
          const mine: string[] = [];
          for (const [v, set] of votes.get(rowId) ?? []) for (const ro of set) { const opt = poll.options.find((p) => p.id === byRow.get(ro)); if (opt) { opt.voters.push(v); if (v === o.ownId && !mine.includes(opt.id)) mine.push(opt.id); } }
          if (mine.length) poll.mine = mine; m.poll = poll;
        } else if (type === T.TEXT || text0) {
          m.text = text0; if (!m.text) { skip("empty"); continue; }
        } else { skip(`type-${type}`); continue; }
        }
        const rs = reactions.get(rowId);
        if (rs?.size) {
          const by = new Map<string, Reaction>();
          for (const [v, e] of rs) { const r = by.get(e) ?? { emoji: e, senderIds: [] }; r.senderIds.push(v); if (v === o.ownId) r.mine = true; by.set(e, r); }
          m.reactions = [...by.values()];
        }
      }

      const ch = chat.stats; ch.count++; ch.first = Math.min(ch.first ?? Infinity, ts); ch.last = Math.max(ch.last ?? 0, ts);
      stats.first = Math.min(stats.first ?? Infinity, ts); stats.last = Math.max(stats.last ?? 0, ts);
      stats.messages++;
      const owner: WaMsg = { chat: ch, message: m };
      await o.onMessage(owner);
      if (blob && m.attachments?.[0]) { await o.onBlob(m.attachments[0], owner, blob); stats.attachments.stored++; }
    }
    o.onProgress?.(total, total);
    stats.chats = [...byJid.values()].filter((c) => c.count > 0);
    stats.unresolvedChats = stats.chats.filter((c) => c.unresolved).length;
    stats.attachments.missing = stats.attachments.listed - stats.attachments.present;
    if (stats.unresolvedChats) stats.warnings.push(`${stats.unresolvedChats} conversations are addressed by a WhatsApp privacy id (LID) that could not be mapped to a phone number. They are imported under that id and may appear next to the same person's live chat.`);
    if (stats.skipped["no-chat"]) stats.warnings.push(`${stats.skipped["no-chat"]} messages belong to conversations that could not be identified and were skipped.`);
    if (stats.attachments.mismatch) stats.warnings.push(`${stats.attachments.mismatch} media files differ from what WhatsApp recorded (size or hash) and were not imported.`);
    if (stats.attachments.tooLarge) stats.warnings.push(`${stats.attachments.tooLarge} media files over 256 MB were not imported.`);
    return stats;
  }
}

function parseVcard(v: string): SharedContact | undefined {
  let name = "", handle: string | undefined; const phones: string[] = [], emails: string[] = [];
  for (const l of v.replace(/\r/g, "").split("\n")) {
    const i = l.indexOf(":"); if (i < 0) continue; const key = l.slice(0, i).toUpperCase(), val = l.slice(i + 1).trim();
    if (key === "FN" && val) name = val;
    else if (key.startsWith("TEL") && val) { phones.push(val); const w = /waid=(\d+)/i.exec(l.slice(0, i)); if (w && !handle) handle = "+" + w[1]; }
    else if (key.startsWith("EMAIL") && val) emails.push(val);
  }
  if (!name && !phones.length) return undefined;
  return { name: name || phones[0]!, ...(phones.length ? { phones } : {}), ...(emails.length ? { emails } : {}), ...(handle ? { handle } : {}) };
}
