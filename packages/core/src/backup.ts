// Backup / migration service: export the whole UniChat state to ONE encrypted archive and import it on another install.
// The archive format lives in container.ts; this file decides WHAT goes in and how it is merged back. The Hub only wires
// `hub.call` to `BackupService.call` (see hub.ts) and hands over a small BackupHost.
//
// Archive layout (entries, in this order; the importer relies on "rows" being last so the database part is one short transaction):
//   manifest                      (first entry, written by the container)
//   session  {accountId, rel}     provider session files of an account dir (only with the "sessions" part)
//   media    {accountId, chatId, messageId, attachmentId, mime, name}   cached attachment bytes, PLAINTEXT inside the archive
//   rows     NDJSON of StateRecord, ~256 KiB per entry; accounts come first
// Nothing in the archive depends on the source install's data key: rows are exported decrypted (through Store.exportRecords)
// and media is decrypted; the importer re-seals both with the TARGET's key.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { hostname, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BackupError, collectBody, inspectArchive, openArchive, verifyArchive, writeArchive, zstdAvailable, type EntryOut } from "./container.js";
import type { Attachment, Chat, Message, Space } from "./model.js";
import { cardsOf } from "./model.js";
import { MediaCache } from "./media.js";
import { STATE_RECORD_TYPES, type StateRecord, type Store, type StoredAccount } from "./store.js";
import type { ProviderFactory } from "./provider.js";
import { exportChatDocument, type ChatExportOptions } from "./chatexport.js";

export type BackupPart = "data" | "media" | "sessions";
export interface BackupPolicy {
  /** Where the caller may name files: "any" (desktop: the user picked it in a native dialog), "dir" (only inside `dir`), "none". */
  paths: "any" | "dir" | "none";
  /** Folder for archives the app creates / receives itself (default "<accounts dir>/.backup"). */
  dir?: string;
  /** Upload size cap in bytes (default 16 GiB). */
  maxUploadBytes?: number;
}
export interface BackupHost {
  store: Store; media: MediaCache; accountsDir: string; dataKey?: Uint8Array;
  policy: BackupPolicy; appVersion?: string;
  emit(event: string, data: unknown): void;
  /** Hub.call, for signIn after the user confirmed a moved account. */
  call(method: string, params?: unknown): Promise<unknown>;
  /** Re-read accounts / merges / aliases / mesh groups from the store after an import. */
  reload(): Promise<void>;
  /** One-account transfer: stop the connector WITHOUT a remote logout, wipe the local session material, keep the archive read-only. */
  moveAway?(accountId: string): Promise<void>;
  /** The provider's optional session hooks (ProviderFactory.exportSession / importSession). */
  provider?(name: string): Pick<ProviderFactory, "exportSession" | "importSession"> | undefined;
}

export const BACKUP_EXT = ".unimsg-backup";
const MOVED_KEY = "backup.moved";
const TRANSFERS_KEY = "backup.transfers"; // ids of session packages already imported here: a package works once
const MAX_SESSION_FILE = 128 * 1024 * 1024;
const DENY_DIR = /^(cache|caches|tmp|temp|media|avatars|downloads|thumbnails|thumbs|logs?|crashpad|code cache|gpucache)$/i;
const DENY_FILE = /(\.(tmp|part|lock|log|pid|sock|swp)|~)$/i;

const accountOfChat = (chatId: string) => (chatId.startsWith("mesh:") || chatId.startsWith("merge:") ? "" : chatId.split(":")[0]);
const safeDir = (id: string) => id.replace(/[^\w.-]/g, "_");
const mediaKey = (chatId: string, messageId: string, attId: string) => `${chatId}|${messageId}|${attId}`;
export function attachmentIds(m: Message): string[] {
  const ids = (m.attachments ?? []).map((a: Attachment) => a.id);
  for (const c of cardsOf(m)) if (c.image?.attachmentId) ids.push(c.image.attachmentId);
  return ids;
}

/** Files of a provider's account dir that make up its session (generic allow/deny list: no caches, logs, temp files). */
export function sessionFiles(dir: string): { rel: string; abs: string; size: number }[] {
  const out: { rel: string; abs: string; size: number }[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    let names: string[]; try { names = readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      const abs = join(d, n), r = rel ? `${rel}/${n}` : n;
      let st; try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (depth < 8 && !DENY_DIR.test(n)) walk(abs, r, depth + 1); }
      else if (st.isFile() && !DENY_FILE.test(n) && st.size <= MAX_SESSION_FILE) out.push({ rel: r, abs, size: st.size });
    }
  };
  if (existsSync(dir)) walk(dir, "", 0);
  return out;
}
function dirSize(root: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const walk = (d: string) => { let ns: string[]; try { ns = readdirSync(d); } catch { return; } for (const n of ns) { const p = join(d, n); try { const st = lstatSync(p); if (st.isDirectory()) walk(p); else if (st.isFile()) { files++; bytes += st.size; } } catch { /* gone */ } } };
  if (existsSync(root)) walk(root);
  return { files, bytes };
}
const unsafeRel = (rel: string) => !rel || isAbsolute(rel) || rel.split(/[\\/]/).some((s) => s === ".." || s === "") || rel.includes("\0");

interface Ticket { kind: "download" | "upload"; path: string; name: string; expires: number; size?: number; deleteAfter?: boolean; claimed?: boolean; ready?: boolean; written?: number }
export interface AccountPlan { adoptSession?: boolean; src: string; dst: string; outcome: "restored" | "matched" | "added"; provider: string; label: string; hasSession: boolean }
export interface ImportResult {
  mode: "new-install" | "merge";
  accounts: AccountPlan[];
  messages: { added: number; existing: number };
  records: Record<string, number>;
  mediaFiles: number; sessionFiles: number;
  /** accounts that arrived as read-only archives and need the user to sign in again */
  needSignIn: number;
  /** accounts that arrived WITH their session: they start only after confirmMovedAccount */
  moved: string[];
  skippedJobs: number;
  warnings: string[];
}

export class BackupService {
  private job?: { kind: "export" | "import"; ctl: AbortController };
  private tickets = new Map<string, Ticket>();
  private sweep?: ReturnType<typeof setInterval>;
  constructor(private h: BackupHost) {
    try { this.cleanupStale(); } catch { /* best effort */ }
    this.sweep = setInterval(() => this.expire(), 60_000); this.sweep.unref?.();
  }
  dispose() { if (this.sweep) clearInterval(this.sweep); }

  // ------------------------------------------------------------------ RPC
  static readonly methods = new Set(["exportEstimate", "exportData", "importInspect", "importData", "backupCancel", "backupUploadStart", "backupUploadChunk", "backupUploadEnd",
    "backupDownloadChunk", "backupDiscard", "movedAccounts", "moveAwayAccount", "confirmMovedAccount", "dismissMovedAccount", "exportChat"]);
  async call(method: string, p: any = {}): Promise<unknown> {
    switch (method) {
      case "exportEstimate": return this.estimate();
      case "exportData": return this.exportData(p);
      case "importInspect": return this.importInspect(p);
      case "importData": return this.importData(p);
      case "backupCancel": this.job?.ctl.abort(); return { cancelled: !!this.job };
      case "backupUploadStart": return this.beginUpload(Number(p.size) || undefined, p.name);
      case "backupUploadChunk": return this.appendUpload(String(p.id), Buffer.from(String(p.dataBase64 ?? ""), "base64"));
      case "backupUploadEnd": return this.finishUpload(String(p.id));
      case "backupDownloadChunk": return this.downloadChunk(String(p.id), Number(p.offset) || 0, Math.min(Number(p.length) || 4 << 20, 8 << 20));
      case "backupDiscard": return this.discard(String(p.id));
      case "movedAccounts": return this.moved();
      case "moveAwayAccount": return this.moveAway(String(p.accountId), !!p.confirmedSaved);
      case "confirmMovedAccount": return this.confirmMoved(String(p.accountId));
      case "dismissMovedAccount": return this.dismissMoved(String(p.accountId));
      case "exportChat": return exportChatDocument(this.h, { ...p, chatId: p.chat ?? p.chatId } as ChatExportOptions) /* param is named `chat`: hub.call reroutes `chatId` of merged chats */;
    }
    throw new Error(`unknown backup method ${method}`);
  }

  // ------------------------------------------------------------------ paths and tickets
  managedDir(): string { const d = this.h.policy.dir ?? join(this.h.accountsDir, ".backup"); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }
  /** Resolve a caller-named path according to the policy. */
  private resolvePath(p: string, mustExist: boolean): string {
    const pol = this.h.policy.paths;
    if (pol === "none") throw new BackupError("invalid", "This backend does not accept file paths. Use the upload / download of the web app instead.");
    if (typeof p !== "string" || !p || p.includes("\0")) throw new BackupError("invalid", "Invalid file path.");
    if (pol === "any") return resolve(p);
    const root = realpathSync(this.managedDir()), full = isAbsolute(p) ? resolve(p) : resolve(root, p);
    let parent: string; try { parent = realpathSync(dirname(full)); } catch { throw new BackupError("invalid", "That folder does not exist."); }
    const real = join(parent, basename(full));
    if (relative(root, real).startsWith("..") || isAbsolute(relative(root, real))) throw new BackupError("invalid", `For safety, backup files must be inside ${root} on this backend.`);
    if (mustExist && !existsSync(real)) throw new BackupError("invalid", "That backup file does not exist.");
    return real;
  }
  private newId() { return randomBytes(24).toString("base64url"); }
  private expire() {
    const now = Date.now();
    for (const [id, t] of this.tickets) if (t.expires < now && !t.claimed) { this.drop(id); }
  }
  private drop(id: string) { const t = this.tickets.get(id); this.tickets.delete(id); if (t && (t.deleteAfter || t.kind === "upload")) { try { rmSync(t.path, { force: true }); rmSync(t.path + ".part", { force: true }); } catch { /* ignore */ } } }
  private cleanupStale() {
    const d = this.h.policy.dir ?? join(this.h.accountsDir, ".backup");
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) if (/^(upload-|download-|\.import-)/.test(n)) { try { rmSync(join(d, n), { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  private ticketOrThrow(id: string, kind: Ticket["kind"]): Ticket {
    const t = this.tickets.get(id);
    if (!t || t.kind !== kind || t.expires < Date.now()) throw new BackupError("invalid", kind === "upload" ? "The uploaded file is no longer available. Upload it again." : "This download link has expired.");
    return t;
  }
  /** HTTP/IPC upload (the file arrives in pieces; the final name is only known to the server). */
  beginUpload(size?: number, name?: string): { id: string } {
    const max = this.h.policy.maxUploadBytes ?? 16 * 1024 ** 3;
    if (size !== undefined && size > max) throw new BackupError("too-large", `This file is larger than the ${Math.round(max / 1024 ** 3)} GiB upload limit of this backend.`);
    const id = this.newId(), path = join(this.managedDir(), `upload-${id.slice(0, 16)}${BACKUP_EXT}`);
    this.tickets.set(id, { kind: "upload", path, name: String(name ?? "backup").slice(0, 200), expires: Date.now() + 3600_000, written: 0 });
    writeFileSync(path + ".part", "", { mode: 0o600 });
    return { id };
  }
  /** Path of the part file (the HTTP handler streams into it) and accounting for the size cap. */
  uploadTarget(id: string): { part: string; max: number; add(n: number): void; finish(): void; fail(): void } {
    const t = this.ticketOrThrow(id, "upload"), max = this.h.policy.maxUploadBytes ?? 16 * 1024 ** 3;
    return { part: t.path + ".part", max, add: (n) => { t.written = (t.written ?? 0) + n; if (t.written > max) throw new BackupError("too-large", "The uploaded file is larger than this backend allows."); },
      finish: () => { renameSync(t.path + ".part", t.path); t.ready = true; t.size = t.written; t.expires = Date.now() + 3600_000; }, fail: () => this.drop(id) };
  }
  appendUpload(id: string, data: Buffer) {
    const t = this.ticketOrThrow(id, "upload"), u = this.uploadTarget(id); u.add(data.length);
    writeFileSync(t.path + ".part", data, { flag: "a" }); return { written: t.written };
  }
  finishUpload(id: string) { this.uploadTarget(id).finish(); return { id, size: this.tickets.get(id)!.size }; }
  /** A one-time download of a finished export. `done(ok)` must be called when the response ended. */
  openDownload(id: string): { path: string; size: number; name: string; done(ok: boolean): void } {
    const t = this.ticketOrThrow(id, "download");
    if (t.claimed) throw new BackupError("invalid", "This download is already in progress or finished.");
    t.claimed = true;
    return { path: t.path, size: statSync(t.path).size, name: t.name, done: (ok) => { t.claimed = false; if (ok) this.drop(id); } };
  }
  private downloadChunk(id: string, offset: number, length: number) {
    const t = this.ticketOrThrow(id, "download"), size = statSync(t.path).size;
    const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
    const fd = openSync(t.path, "r"); try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
    const end = offset + buf.length >= size;
    return { dataBase64: buf.toString("base64"), size, end };
  }
  private discard(id: string) { this.drop(id); return {}; }
  /** Path of a ready upload, or a caller-named path. */
  source(p: { path?: string; uploadId?: string }): string {
    if (p.uploadId) { const t = this.ticketOrThrow(p.uploadId, "upload"); if (!t.ready) throw new BackupError("invalid", "The upload is not finished yet."); return t.path; }
    if (p.path) return this.resolvePath(p.path, true);
    throw new BackupError("invalid", "Choose a backup file first.");
  }

  // ------------------------------------------------------------------ export
  async estimate() {
    const counts = this.h.store.countRecords();
    const accs = this.h.store.listAccounts();
    const media = dirSize(join(this.h.accountsDir, "media"));
    const accounts = accs.map((a) => { const f = sessionFiles(join(this.h.accountsDir, a.id)); return { id: a.id, provider: a.provider, label: a.label, status: a.status ?? "active", sessionFiles: f.length, sessionBytes: f.reduce((n, x) => n + x.size, 0) }; });
    return {
      counts, accounts, zstd: zstdAvailable,
      media: { files: media.files, bytes: media.bytes },
      sessions: { files: accounts.reduce((n, a) => n + a.sessionFiles, 0), bytes: accounts.reduce((n, a) => n + a.sessionBytes, 0) },
      // rough: JSON rows are about 600 bytes per message before compression
      dataBytes: counts.message * 600 + 4096,
      managedDir: this.h.policy.paths === "none" ? undefined : this.managedDir(),
      canChoosePath: this.h.policy.paths !== "none",
    };
  }

  private begin(kind: "export" | "import") {
    if (this.job) throw new BackupError("invalid", `Another ${this.job.kind} is still running.`);
    const ctl = new AbortController(); this.job = { kind, ctl }; return ctl;
  }
  private progress(op: string, stage: string, done: number, total: number, last = { t: 0, s: "" }) {
    const now = Date.now();
    if (stage === last.s && now - last.t < 120 && done < total) return;
    last.t = now; last.s = stage; this.h.emit("backup-progress", { op, stage, done, total });
  }

  async exportData(p: { passphrase: string; parts?: Partial<Record<BackupPart, boolean>>; targetPath?: string; accountIds?: string[]; deliver?: "download"; comp?: "gzip" | "zstd"; kdfN?: number }) {
    if (typeof p.passphrase !== "string" || p.passphrase.length < 8) throw new BackupError("invalid", "Choose a passphrase of at least 8 characters.");
    const parts = { data: p.parts?.data !== false, media: !!p.parts?.media, sessions: !!p.parts?.sessions };
    if (!parts.data && !parts.sessions && !parts.media) throw new BackupError("invalid", "Select something to export.");
    const ctl = this.begin("export"), op = "export", pr = (s: string, d: number, t: number) => this.progress(op, s, d, t);
    const { store } = this.h;
    try {
      const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
      let target: string, ticketId: string | undefined;
      if (p.deliver === "download") { ticketId = this.newId(); target = join(this.managedDir(), `download-${ticketId.slice(0, 16)}${BACKUP_EXT}`); }
      else if (p.targetPath) {
        target = this.resolvePath(p.targetPath, false);
        if (this.h.policy.paths !== "any" && existsSync(target)) throw new BackupError("invalid", "That file already exists. Choose another name.");
      } else { let n = 0; do { target = join(this.managedDir(), `unimsg-${stamp}${n ? "-" + n : ""}${BACKUP_EXT}`); n++; } while (existsSync(target)); }
      if (!existsSync(dirname(target))) throw new BackupError("invalid", "That folder does not exist.");

      const counts = store.countRecords(), accounts = store.listAccounts().filter((a) => !p.accountIds || p.accountIds.includes(a.id));
      const warnings: string[] = [];
      const sess: { a: StoredAccount; files: { rel: string; abs?: string; data?: Uint8Array; size: number }[] }[] = [];
      if (parts.sessions) for (const a of accounts) {
        const dir = join(this.h.accountsDir, a.id); let files: { rel: string; abs?: string; data?: Uint8Array; size: number }[] = sessionFiles(dir);
        try {
          const b = files.length ? await this.h.provider?.(a.provider)?.exportSession?.(dir) : undefined;
          if (b) {
            const omit = new Set(b.omit ?? []), add = new Map((b.files ?? []).map((f) => [f.rel, f]));
            files = [...files.filter((f) => !omit.has(f.rel) && !add.has(f.rel)), ...[...add.values()].filter((f) => !unsafeRel(f.rel)).map((f) => ({ rel: f.rel, data: f.data, size: f.data.length }))];
          }
        } catch (e) { warnings.push(`${a.label}: the session could not be made portable (${(e as Error).message}); it is copied as it is and may not work elsewhere.`); }
        sess.push({ a, files });
      }
      const totalRows = STATE_RECORD_TYPES.reduce((n, k) => n + counts[k], 0), totalSess = sess.reduce((n, s) => n + s.files.length, 0);
      const manifest = {
        app: "unimsg", format: 1, appVersion: this.h.appVersion ?? "dev", createdAt: new Date().toISOString(),
        source: { name: hostname(), platform: platform() },
        parts, counts, comp: p.comp === "zstd" && zstdAvailable ? "zstd" : "gzip",
        accounts: accounts.map((a) => ({ id: a.id, provider: a.provider, label: a.label, status: a.status ?? "active", hasSession: sess.some((s) => s.a.id === a.id && s.files.length > 0) })),
        sessionFiles: totalSess,
        ...(parts.sessions ? { transferId: randomBytes(16).toString("hex") } : {}),
      };
      const self = this;
      async function* entries(): AsyncGenerator<EntryOut> {
        let n = 0;
        for (const s of sess) for (const f of s.files) {
          let body: Buffer; try { body = f.data ? Buffer.from(f.data) : readFileSync(f.abs!); } catch { warnings.push(`Could not read ${s.a.id}/${f.rel}`); continue; }
          yield { head: { kind: "session", accountId: s.a.id, rel: f.rel }, body }; pr("sessions", ++n, totalSess);
        }
        if (parts.media) {
          let scanned = 0, files = 0;
          for (const r of store.exportRecords()) {
            if (r.t !== "message") continue;
            if (++scanned % 200 === 0) { pr("media", scanned, counts.message); if (scanned % 2000 === 0) await new Promise((ok) => setImmediate(ok)); }
            const acc = r.v.accountId ?? accountOfChat(r.v.chatId); if (!acc) continue;
            for (const id of attachmentIds(r.v)) {
              const b = self.h.media.get(acc, mediaKey(r.v.chatId, r.v.id, id));
              if (b) { files++; yield { head: { kind: "media", accountId: acc, chatId: r.v.chatId, messageId: r.v.id, attachmentId: id, mime: b.mime, name: b.name }, body: b.data }; }
            }
          }
          pr("media", counts.message, counts.message);
          if (!files) warnings.push("No cached media found.");
        }
        let batch: string[] = [], size = 0, done = 0;
        const flush = (): EntryOut | undefined => { if (!batch.length) return; const body = Buffer.from(batch.join("\n"), "utf8"); const e = { head: { kind: "rows", n: batch.length }, body }; batch = []; size = 0; return e; };
        for (const r of store.exportRecords()) {
          if (r.t === "setting" && r.key.startsWith("backup.")) continue;
          if (!parts.data && r.t !== "account") continue; // session-only archive: just the account records
          if (p.accountIds && r.t === "account" && !p.accountIds.includes(r.v.id)) continue;
          const line = JSON.stringify(r); batch.push(line); size += line.length; done++;
          if (size > 256 * 1024) { yield flush()!; pr("data", done, totalRows); await new Promise((ok) => setImmediate(ok)); }
        }
        const last = flush(); if (last) yield last;
        pr("data", totalRows, totalRows);
      }
      pr("preparing", 0, 1);
      const res = await writeArchive(target, { passphrase: p.passphrase, manifest, entries: entries(), comp: manifest.comp as "gzip" | "zstd", signal: ctl.signal, kdfN: p.kdfN });
      pr("finished", 1, 1);
      if (ticketId) this.tickets.set(ticketId, { kind: "download", path: target, name: `unimsg-${stamp}${BACKUP_EXT}`, expires: Date.now() + 15 * 60_000, size: res.size, deleteAfter: true });
      return { path: ticketId ? undefined : target, downloadId: ticketId, name: basename(ticketId ? `unimsg-${stamp}${BACKUP_EXT}` : target), size: res.size, sha256: res.sha256, parts, counts: res.footer.kinds, manifest, warnings };
    } finally { this.job = undefined; }
  }

  // ------------------------------------------------------------------ import
  private plan(manifestAccounts: any[], mode: "new-install" | "merge", hasSessions: boolean): AccountPlan[] {
    const have = this.h.store.listAccounts(), used = new Set(have.map((a) => a.id)), claimed = new Set<string>();
    const out: AccountPlan[] = [];
    for (const a of manifestAccounts ?? []) {
      const base = { src: String(a.id), provider: String(a.provider), label: String(a.label), hasSession: !!a.hasSession && hasSessions };
      if (mode === "new-install") { out.push({ ...base, dst: base.src, outcome: "restored" }); continue; }
      const same = have.find((x) => x.id === base.src && x.provider === base.provider);
      const byName = same ?? have.find((x) => x.provider === base.provider && x.label.trim().toLowerCase() === base.label.trim().toLowerCase() && !claimed.has(x.id));
      if (byName) { claimed.add(byName.id); out.push({ ...base, dst: byName.id, outcome: "matched", adoptSession: byName.status === "archived" && base.hasSession }); continue; }
      let dst = base.src; if (used.has(dst) || out.some((o) => o.dst === dst)) dst = `${base.provider}-${randomBytes(4).toString("hex")}`;
      out.push({ ...base, dst, outcome: "added" });
    }
    return out;
  }
  private targetEmpty() { const c = this.h.store.countRecords(); return c.account === 0 && c.message === 0; }

  async importInspect(p: { path?: string; uploadId?: string; passphrase: string; verify?: boolean }) {
    const file = this.source(p);
    const { manifest, header } = await inspectArchive(file, p.passphrase);
    if (manifest.app !== "unimsg") throw new BackupError("not-a-backup", "This file is not an UniChat backup.");
    if (p.verify) await verifyArchive(file, p.passphrase);
    const empty = this.targetEmpty(), mode = empty ? "new-install" : "merge";
    return {
      manifest, size: statSync(file).size, comp: header.comp, targetEmpty: empty, suggestedMode: mode,
      accounts: this.plan(manifest.accounts, mode, !!manifest.parts?.sessions),
      appVersion: manifest.appVersion, createdAt: manifest.createdAt,
      alreadyImported: !!(manifest.parts?.sessions && typeof manifest.transferId === "string" && this.transfers().includes(manifest.transferId)),
    };
  }

  async importData(p: { path?: string; uploadId?: string; passphrase: string; mode: "new-install" | "merge"; parts?: Partial<Record<BackupPart, boolean>> }): Promise<ImportResult> {
    if (p.mode !== "new-install" && p.mode !== "merge") throw new BackupError("invalid", "Choose how to import: new install or merge.");
    const file = this.source(p), ctl = this.begin("import"), op = "import", size = statSync(file).size;
    const { store } = this.h;
    let staging: string | undefined;
    try {
      // Pass 1: authenticate the WHOLE archive before anything is touched.
      this.progress(op, "verifying", 0, size);
      const { manifest } = await verifyArchive(file, p.passphrase, { signal: ctl.signal, onProgress: (d) => this.progress(op, "verifying", d, size) });
      if (manifest.app !== "unimsg") throw new BackupError("not-a-backup", "This file is not an UniChat backup.");
      const tid = typeof manifest.transferId === "string" && manifest.parts?.sessions ? manifest.transferId : undefined;
      if (tid && this.transfers().includes(tid)) throw new BackupError("invalid", "This session package was already imported on this install. A package carries one login and can be used once; export it again from the device that holds the session.");
      if (p.mode === "new-install" && !this.targetEmpty()) throw new BackupError("not-empty", "This install already has accounts or messages. Use \"Merge\" to add the backup to them.");
      const want = { media: p.parts?.media !== false && !!manifest.parts?.media, sessions: p.parts?.sessions !== false && !!manifest.parts?.sessions };
      const plan = this.plan(manifest.accounts, p.mode, want.sessions);
      const bySrc = new Map(plan.map((a) => [a.src, a]));
      const rid = (id: string): string => { const i = id.indexOf(":"); if (i <= 0) return id; const a = bySrc.get(id.slice(0, i)); return a && a.dst !== a.src ? a.dst + id.slice(i) : id; };
      const warnings: string[] = [];

      staging = join(this.managedDir(), `.import-${randomBytes(6).toString("hex")}`);
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const stageMedia = new MediaCache(join(staging, "media"), this.h.dataKey);
      const result: ImportResult = { mode: p.mode, accounts: plan, messages: { added: 0, existing: 0 }, records: {}, mediaFiles: 0, sessionFiles: 0, needSignIn: 0, moved: [], skippedJobs: 0, warnings };
      const sessionAccounts = new Set<string>();

      const a = await openArchive(file, p.passphrase, ctl.signal);
      try {
        this.progress(op, "restoring", 0, size);
        const it = a.entries()[Symbol.asyncIterator]();
        let r = await it.next(), tick = 0;
        // Phase A: files go to a staging folder (cancel / failure just deletes it).
        for (; !r.done && r.value.head.kind !== "rows"; r = await it.next()) {
          const e = r.value, k = String(e.head.kind);
          if (k === "session") {
            const ap = bySrc.get(String(e.head.accountId)), rel = String(e.head.rel ?? "");
            if (!ap || !want.sessions || (ap.outcome === "matched" && !ap.adoptSession)) continue; // never touch the session of an account that is live here
            if (unsafeRel(rel)) throw new BackupError("corrupt", "This backup contains an unsafe file name.");
            const out = join(staging, "sessions", safeDir(ap.dst), ...rel.split("/")); mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
            writeFileSync(out, await collectBody(e.body), { mode: 0o600 }); try { chmodSync(out, 0o600); } catch { /* ignore */ }
            sessionAccounts.add(ap.dst); result.sessionFiles++;
          } else if (k === "media") {
            const ap = bySrc.get(String(e.head.accountId));
            if (!ap || !want.media) continue;
            const data = await collectBody(e.body);
            stageMedia.put(ap.dst, mediaKey(rid(String(e.head.chatId)), String(e.head.messageId), String(e.head.attachmentId)), { data, mime: String(e.head.mime ?? "application/octet-stream"), name: e.head.name as string | undefined });
            result.mediaFiles++;
          } else for await (const _ of e.body) { /* unknown entry kind of a newer minor version: skip */ }
          if (++tick % 20 === 0) { if (ctl.signal.aborted) throw new BackupError("cancelled", "Cancelled."); this.progress(op, "restoring", a.position(), size); }
        }
        // Phase B: the database, in ONE transaction that also covers the final footer check (a bad archive rolls everything back).
        if (!r.done) await store.inTransaction(async () => {
          const ex = {
            aliases: store.listAliases(), flags: store.listChatFlags(), chatFolders: store.listChatFolders(),
            folders: new Set(store.listFolders().map((f) => f.id)), merges: new Set(store.listMerges().map((m) => m.id)), mesh: new Set(store.listMeshGroups().map((m) => m.id)),
            settings: (k: string) => store.getSetting(k), jobs: new Set(store.listJobs().map((j) => j.id)),
          };
          const newAcc = new Set(plan.filter((x) => x.outcome !== "matched").map((x) => x.dst));
          const ev = new Map<string, string>(); // last event kind per new account
          const count = (t: string) => { result.records[t] = (result.records[t] ?? 0) + 1; };
          let pending: Message[] = [];
          const flushMsgs = () => { if (pending.length) { store.putMessages(pending); pending = []; } };
          const remapChat = (c: Chat): Chat => ({ ...c, id: rid(c.id), accountId: bySrc.get(c.accountId)?.dst ?? c.accountId,
            ...(c.spaceId ? { spaceId: rid(c.spaceId) } : {}), ...(c.networkSpaceId ? { networkSpaceId: rid(c.networkSpaceId) } : {}), ...(c.collapsedFrom ? { collapsedFrom: rid(c.collapsedFrom) } : {}),
            ...(c.folderId ? { folderId: rid(c.folderId) } : {}) });
          const remapSpace = (s: Space): Space => ({ ...s, id: rid(s.id), accountId: bySrc.get(s.accountId)?.dst ?? s.accountId });
          const apply = (rec: StateRecord) => {
            switch (rec.t) {
              case "account": {
                const ap = bySrc.get(rec.v.id); if (!ap || ap.outcome === "matched") return;
                // arrives as a read-only archive; with a session it still waits for the user's confirmation (see movedAccounts)
                store.putAccount({ id: ap.dst, provider: rec.v.provider, label: rec.v.label, status: "archived" } as StoredAccount); count("account"); return;
              }
              case "alias": { const id = rid(rec.chatId); if (!(id in ex.aliases)) { store.setAlias(id, rec.name); count("alias"); } return; }
              case "flags": { const id = rid(rec.chatId); if (!(id in ex.flags)) { store.setChatFlags(id, rec.v); count("flags"); } return; }
              case "folder": if (!ex.folders.has(rec.v.id)) { store.putFolder(rec.v); count("folder"); } return;
              case "chatFolder": { const id = rid(rec.chatId); if (!(id in ex.chatFolders)) { store.setChatFolder(id, rid(rec.folderId)); count("chatFolder"); } return; }
              case "mesh": if (!ex.mesh.has(rec.v.id)) { store.putMeshGroup({ ...rec.v, members: rec.v.members.map((m) => ({ ...m, chatId: rid(m.chatId) })) }); count("mesh"); } return;
              case "merge": if (!ex.merges.has(rec.v.id)) { store.putMerge({ ...rec.v, members: rec.v.members.map(rid), primary: rid(rec.v.primary), ...(rec.v.sendVia ? { sendVia: rid(rec.v.sendVia) } : {}) }); count("merge"); } return;
              case "chatCache": {
                const ap = bySrc.get(rec.accountId); if (!ap || ap.outcome === "matched") return;
                store.putChatCache(ap.dst, { chats: rec.v.chats.map(remapChat), spaces: rec.v.spaces.map(remapSpace) }); count("chatCache"); return;
              }
              case "event": { const ap = bySrc.get(rec.v.accountId); if (!ap || ap.outcome === "matched") return; store.addAccountEvent(ap.dst, rec.v.kind, rec.v.time); ev.set(ap.dst, rec.v.kind); count("event"); return; }
              case "setting": if (!rec.key.startsWith("backup.") && ex.settings(rec.key) === undefined) { store.setSetting(rec.key, rec.value); count("setting"); } return;
              case "job": {
                const ap = typeof (rec.v.payload as any)?.chatId === "string" ? bySrc.get(accountOfChat((rec.v.payload as any).chatId)) : undefined;
                if (rec.v.status !== "pending" || !ap || ap.outcome === "matched" || !ap.hasSession || ex.jobs.has(rec.v.id)) { result.skippedJobs++; return; }
                store.putJob({ ...rec.v, payload: { ...(rec.v.payload as object), chatId: rid((rec.v.payload as any).chatId) } }); count("job"); return;
              }
              case "message": {
                const m0 = rec.v, chatId = rid(m0.chatId), m: Message = { ...m0, chatId, ...(m0.accountId ? { accountId: bySrc.get(m0.accountId)?.dst ?? m0.accountId } : {}) };
                const old = store.getMessage(chatId, m.id);
                if (!old) { pending.push(m); result.messages.added++; if (pending.length >= 500) flushMsgs(); }
                else { // never overwrite: only fill what the existing copy lacks
                  result.messages.existing++;
                  const fill = Object.fromEntries(Object.entries(m).filter(([k, v]) => v !== undefined && (old as any)[k] === undefined));
                  if (Object.keys(fill).length) store.patchMessage(chatId, m.id, fill as Partial<Message>);
                }
                return;
              }
            }
          };
          void newAcc;
          for (; !r.done; r = await it.next()) {
            const e = r.value;
            if (e.head.kind !== "rows") { for await (const _ of e.body) { /* skip */ } continue; }
            const text = (await collectBody(e.body, 64 * 1024 * 1024)).toString("utf8");
            for (const line of text.split("\n")) {
              if (!line) continue;
              let rec: StateRecord; try { rec = JSON.parse(line); } catch { throw new BackupError("corrupt", "This backup is damaged."); }
              apply(rec);
            }
            flushMsgs();
            if (ctl.signal.aborted) throw new BackupError("cancelled", "Cancelled.");
            this.progress(op, "restoring", a.position(), size);
            await new Promise((ok) => setImmediate(ok));
          }
          flushMsgs();
          // an imported account is, from this install's point of view, signed out right now (a gap marker in the timeline)
          for (const ap of plan) if (ap.outcome !== "matched") store.addAccountEvent(ap.dst, "signed-out");
          if (sessionAccounts.size) {
            let moved: Record<string, unknown> = {}; try { moved = JSON.parse(store.getSetting(MOVED_KEY) ?? "{}"); } catch { /* reset */ }
            for (const id of sessionAccounts) moved[id] = { at: new Date().toISOString(), from: manifest.source?.name ?? "another install", exportedAt: manifest.createdAt, ...(tid ? { transfer: tid } : {}) };
            store.setSetting(MOVED_KEY, JSON.stringify(moved));
            if (tid) store.setSetting(TRANSFERS_KEY, JSON.stringify([...this.transfers(), tid].slice(-200)));
          }
        });
        else a.close();
      } finally { a.close(); }

      // Phase C: commit succeeded; move the staged files into place (never overwrite what exists).
      this.progress(op, "finishing", 0, 1);
      this.moveTree(join(staging, "media"), join(this.h.accountsDir, "media"));
      this.moveTree(join(staging, "sessions"), this.h.accountsDir);
      for (const ap of plan) if (sessionAccounts.has(ap.dst)) {
        try { await this.h.provider?.(ap.provider)?.importSession?.(join(this.h.accountsDir, safeDir(ap.dst))); }
        catch (e) { warnings.push(`${ap.label}: the session could not be prepared for this install (${(e as Error).message}). Sign in again if it does not start.`); }
      }
      result.moved = [...sessionAccounts];
      result.needSignIn = plan.filter((x) => x.outcome !== "matched").length;
      await this.h.reload();
      this.progress(op, "finished", 1, 1);
      return result;
    } finally {
      if (staging) { try { rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ } }
      if (p.uploadId) this.drop(p.uploadId);
      this.job = undefined;
    }
  }
  private moveTree(from: string, to: string) {
    if (!existsSync(from)) return;
    for (const n of readdirSync(from)) {
      const s = join(from, n), d = join(to, n);
      if (statSync(s).isDirectory()) { mkdirSync(d, { recursive: true, mode: 0o700 }); this.moveTree(s, d); }
      else if (!existsSync(d)) { mkdirSync(dirname(d), { recursive: true, mode: 0o700 }); renameSync(s, d); }
    }
  }

  /** The session of ONE account as portable files (provider hook applied), for the device-to-device move. Never touches the account. */
  async collectSession(accountId: string): Promise<{ provider: string; label: string; files: { rel: string; data: Buffer }[] }> {
    const a = this.h.store.listAccounts().find((x) => x.id === accountId);
    if (!a) throw new BackupError("invalid", "Unknown account.");
    const dir = join(this.h.accountsDir, a.id);
    let files: { rel: string; abs?: string; data?: Uint8Array }[] = sessionFiles(dir);
    const b = files.length ? await this.h.provider?.(a.provider)?.exportSession?.(dir) : undefined;
    if (b) {
      const omit = new Set(b.omit ?? []), add = new Map((b.files ?? []).map((f) => [f.rel, f]));
      files = [...files.filter((f) => !omit.has(f.rel) && !add.has(f.rel)), ...[...add.values()].filter((f) => !unsafeRel(f.rel)).map((f) => ({ rel: f.rel, data: f.data }))];
    }
    return { provider: a.provider, label: a.label, files: files.map((f) => ({ rel: f.rel, data: f.data ? Buffer.from(f.data) : readFileSync(f.abs!) })) };
  }

  // ------------------------------------------------------------------ accounts that arrived with their session
  moved(): { accountId: string; at: string; from: string }[] {
    let m: Record<string, { at: string; from: string }> = {}; try { m = JSON.parse(this.h.store.getSetting(MOVED_KEY) ?? "{}"); } catch { /* none */ }
    const have = new Set(this.h.store.listAccounts().map((a) => a.id));
    return Object.entries(m).filter(([id]) => have.has(id)).map(([accountId, v]) => ({ accountId, ...v }));
  }
  private transfers(): string[] { try { const t = JSON.parse(this.h.store.getSetting(TRANSFERS_KEY) ?? "[]"); return Array.isArray(t) ? t.filter((x) => typeof x === "string") : []; } catch { return []; } }
  private setMoved(id: string, on: false) {
    let m: Record<string, unknown> = {}; try { m = JSON.parse(this.h.store.getSetting(MOVED_KEY) ?? "{}"); } catch { /* none */ }
    if (on === false) delete m[id];
    this.h.store.setSetting(MOVED_KEY, JSON.stringify(m));
  }
  /**
   * Second half of a one-account transfer (export with accountIds:[id], parts {data:false, sessions:true}). Call it only after the user
   * confirmed the archive is safely saved: it stops the connector WITHOUT a remote logout (the session now lives in the archive and will
   * be used by the other device), wipes the local session material and leaves the account as a read-only archive on this install.
   */
  async moveAway(accountId: string, confirmedSaved: boolean) {
    if (!confirmedSaved) throw new BackupError("invalid", "Confirm that the backup file is saved first: after this the session exists only in that file.");
    if (!this.h.moveAway) throw new BackupError("invalid", "This install cannot move an account away.");
    await this.h.moveAway(accountId);
    let m: Record<string, unknown> = {}; try { m = JSON.parse(this.h.store.getSetting("backup.movedAway") ?? "{}"); } catch { /* none */ }
    m[accountId] = { at: new Date().toISOString() };
    this.h.store.setSetting("backup.movedAway", JSON.stringify(m));
    return { accountId };
  }
  /** The user confirmed the source install is signed out / stopped: start the account with the imported session. */
  async confirmMoved(accountId: string) {
    if (!this.moved().some((m) => m.accountId === accountId)) throw new BackupError("invalid", "This account was not moved from another install.");
    const r = await this.h.call("signIn", { accountId });
    this.setMoved(accountId, false);
    return r;
  }
  /** The user does not want to run the imported session: drop it, the account stays a read-only archive ("Sign in again"). */
  dismissMoved(accountId: string) {
    if (!this.moved().some((m) => m.accountId === accountId)) throw new BackupError("invalid", "This account was not moved from another install.");
    let tid: string | undefined; try { tid = (JSON.parse(this.h.store.getSetting(MOVED_KEY) ?? "{}") as Record<string, { transfer?: string }>)[accountId]?.transfer; } catch { /* none */ }
    try { rmSync(join(this.h.accountsDir, safeDir(accountId)), { recursive: true, force: true }); } catch { /* ignore */ }
    // this install gave the session up again, so the package is unused as far as it is concerned and may be imported again
    if (tid) this.h.store.setSetting(TRANSFERS_KEY, JSON.stringify(this.transfers().filter((x) => x !== tid)));
    this.setMoved(accountId, false);
    return {};
  }
}

