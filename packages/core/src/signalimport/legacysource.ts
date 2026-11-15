// Legacy Android backup as a streaming history source: pass 1 authenticates the whole file and learns the small tables
// (recipients, threads, groups, parts, reactions, own identity); pass 2 maps the message rows one by one. Attachment frames come right
// after their part rows, i.e. after their message, so their bytes can be handed out in the same pass (a rare out-of-order file
// is repaired with a third pass that only reads the missing blobs).
import { BackupError } from "../container.js";
import { readLegacyBackup, type LegacyFrame } from "./legacy.js";
import { LegacyIndex, LegacyMapper, MESSAGE_TABLES, type Row } from "./legacymap.js";
import { parseStatement } from "./sql.js";
import { isE164, isUuid, normAci, type BackupIdentity, type ImportChat, type ImportedMessage } from "./model.js";

const INTERESTING = new Set(["recipient", "recipient_preferences", "thread", "groups", "part", "attachment", "reaction", ...MESSAGE_TABLES]);
const MIN_DB_VERSION = 20;   // sanity floor only: anything older has no usable recipient/thread tables and fails the schema checks below

export interface RunOptions {
  signal?: AbortSignal; onProgress?: (done: number, total: number) => void;
  attachments: boolean; since?: number; until?: number; ownAci: string; resolveE164?: (e164: string) => string | undefined;
  onMessage(m: ImportedMessage): Promise<void> | void;
  onBlob(m: ImportedMessage["attachments"][number], owner: ImportedMessage, data: Buffer): Promise<void> | void;
}
export interface RunStats {
  messages: number; skipped: Record<string, number>; chats: ImportChat[]; first?: number; last?: number;
  attachments: { listed: number; bytes: number; stored: number; missing: number };
  legacyGroupsSkipped: number; unresolvedChats: number; warnings: string[];
  /** people of the backup (Secure Backup only) with their profile key (base64, 32 bytes) when it holds one */
  contacts?: ImportContact[];
}
export interface ImportContact { aci: string; profileKey?: string; name?: string; e164?: string; pni?: string }
export interface HistorySource { format: "android-legacy" | "secure-backup"; identity: BackupIdentity; size: number; dbVersion?: number; hasMedia?: boolean; run(o: RunOptions): Promise<RunStats> }

export class LegacySource implements HistorySource {
  readonly format = "android-legacy" as const;
  private constructor(private path: string, private pass: string, private ix: LegacyIndex, readonly size: number) {}
  get identity() { return this.ix.identity; }
  get dbVersion() { return this.ix.dbVersion; }

  /** Pass 1. Verifies every MAC of the file (so nothing is written for a damaged backup) and reads the small tables. */
  static async open(path: string, passphrase: string, o: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<LegacySource> {
    const ix = new LegacyIndex(); let size = 0;
    for await (const { frame } of readLegacyBackup(path, passphrase, { signal: o.signal, onProgress: (p, s) => { size = s; o.onProgress?.(p, s); } })) {
      switch (frame.kind) {
        case "version": ix.dbVersion = frame.version; break;
        case "preference": if (frame.value !== undefined) ix.feedKey(frame.key, frame.value); break;
        case "keyvalue": ix.feedKey(frame.key, frame.value); break;
        case "statement": {
          const p = parseStatement(frame.sql, frame.params);
          if (p.kind === "create") { ix.schema.note(p.table, p.columns); break; }
          if (p.kind !== "insert" || !INTERESTING.has(p.table)) break;
          for (const vals of p.rows) {
            const r = ix.schema.row(p.table, p.columns, vals);
            if (!r) { ix.rows.unmappable++; ix.needSchema.add(p.table); continue; }
            if (MESSAGE_TABLES.has(p.table)) { ix.messageTables.set(p.table, (ix.messageTables.get(p.table) ?? 0) + 1); continue; }
            ix.feedRow(p.table, r);
          }
          break;
        }
      }
    }
    ix.finish();
    if (ix.dbVersion !== undefined && ix.dbVersion < MIN_DB_VERSION) throw new BackupError("unsupported-version", `This backup comes from a very old Signal version (database version ${ix.dbVersion}). Update Signal on the phone, create a new backup and import that one.`);
    if (ix.needSchema.size && [...ix.needSchema].some((t) => MESSAGE_TABLES.has(t) || t === "thread" || t === "recipient"))
      throw new BackupError("unsupported-version", "This backup does not describe its tables (no CREATE TABLE statements), so the rows cannot be interpreted safely. It was probably made by a Signal version this importer has not seen.");
    if (![...MESSAGE_TABLES].some((t) => ix.messageTables.has(t))) throw new BackupError("unsupported-version", "This backup has no message tables this importer understands (looked for sms, mms and message).");
    if (!ix.recipients.size || !ix.threads.size) throw new BackupError("unsupported-version", "This backup has no conversation list (recipient/thread tables) this importer understands.");
    return new LegacySource(path, passphrase, ix, size);
  }

  get messageRows() { let n = 0; for (const v of this.ix.messageTables.values()) n += v; return n; }

  async run(o: RunOptions): Promise<RunStats> {
    const mapper = new LegacyMapper(this.ix, { since: o.since, until: o.until, attachments: o.attachments, ownAci: o.ownAci, resolveE164: o.resolveE164 });
    const stats: RunStats = { messages: 0, skipped: {}, chats: [], attachments: { listed: 0, bytes: 0, stored: 0, missing: 0 }, legacyGroupsSkipped: 0, unresolvedChats: 0, warnings: [] };
    const targets = new Map<string, { m: ImportedMessage; part: ImportedMessage["attachments"][number] }>();
    const late = new Set<string>();
    const lookup = (f: Extract<LegacyFrame, { kind: "attachment" }>) => { for (const k of [`${f.rowId}:${f.attachmentId}`, `${f.rowId}:`, `${f.rowId}:0`]) if (targets.has(k)) return k; return undefined; };
    const wantKeys = (f: LegacyFrame) => f.kind === "attachment" && o.attachments && (!!lookup(f));
    const pass = async (blobsOnly: boolean) => {
      for await (const { frame, blob } of readLegacyBackup(this.path, this.pass, { signal: o.signal, onProgress: (p, s) => o.onProgress?.(p, s),
        wantBlob: (f) => (blobsOnly ? f.kind === "attachment" && o.attachments && (late.has(`${f.rowId}:${f.attachmentId}`) || late.has(`${f.rowId}:`)) && !!lookup(f) : wantKeys(f)) })) {
        if (frame.kind === "attachment" && o.attachments) {
          const k = lookup(frame);
          if (k && blob) { const t = targets.get(k)!; targets.delete(k); await o.onBlob(t.part, t.m, blob); stats.attachments.stored++; }
          else if (!blobsOnly && !k) late.add(`${frame.rowId}:${frame.attachmentId}`);
          continue;
        }
        if (blobsOnly || frame.kind !== "statement") continue;
        const p = parseStatement(frame.sql, frame.params);
        if (p.kind !== "insert" || !MESSAGE_TABLES.has(p.table)) continue;
        for (const vals of p.rows) {
          const r = this.ix.schema.row(p.table, p.columns, vals); if (!r) continue;
          const res = mapper.map(p.table, r as Row);
          if ("skip" in res) { stats.skipped[res.skip] = (stats.skipped[res.skip] ?? 0) + 1; continue; }
          const m = res.ok; mapper.note(m); stats.messages++;
          for (const part of m.attachments) { stats.attachments.listed++; stats.attachments.bytes += part.size; if (o.attachments) targets.set(part.partKey, { m, part }); }
          await o.onMessage(m);
        }
      }
    };
    await pass(false);
    // an attachment that came BEFORE its message (unusual table order) is fetched with one more read that only keeps those blobs
    if (o.attachments && late.size && [...targets.keys()].some((tk) => late.has(tk) || (tk.endsWith(":") && [...late].some((l) => l.startsWith(tk))))) await pass(true);
    stats.attachments.missing = o.attachments ? Math.max(0, stats.attachments.listed - stats.attachments.stored) : stats.attachments.listed;
    targets.clear();
    const byId = new Map<string, ImportChat>();
    for (const c of mapper.chatList()) { const e = byId.get(c.id); if (!e) byId.set(c.id, c); else { e.count += c.count; e.first = Math.min(e.first ?? Infinity, c.first ?? Infinity); e.last = Math.max(e.last ?? 0, c.last ?? 0); } }
    stats.chats = [...byId.values()].filter((c) => c.count > 0);
    for (const c of stats.chats) { if (c.first === Infinity) c.first = undefined; stats.first = Math.min(stats.first ?? Infinity, c.first ?? Infinity); stats.last = Math.max(stats.last ?? 0, c.last ?? 0); }
    if (stats.first === Infinity) stats.first = undefined;
    stats.legacyGroupsSkipped = stats.skipped["legacy-group"] ?? 0; stats.unresolvedChats = stats.chats.filter((c) => c.unresolved).length;
    if (stats.skipped["no-chat"]) stats.warnings.push(`${stats.skipped["no-chat"]} messages belong to conversations that could not be identified and were skipped.`);
    if (stats.legacyGroupsSkipped) stats.warnings.push(`${stats.legacyGroupsSkipped} messages from old-style (v1/MMS) groups were skipped: those groups no longer exist in Signal.`);
    if (stats.unresolvedChats) stats.warnings.push(`${stats.unresolvedChats} conversations only know a phone number, not a Signal account id. They are imported as separate chats named by number and are not merged with live chats.`);
    return stats;
  }
}
export { isE164, isUuid, normAci };
