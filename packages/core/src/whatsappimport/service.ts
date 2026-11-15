// Hub RPCs whatsappBackupInspect / whatsappBackupImport / whatsappBackupCancel: import the chat history of a WhatsApp Android local backup
// (msgstore.db.crypt15 / .crypt14 + the plain Media folder) into the archive of an existing WhatsApp account. Same rules as the Signal import:
// authenticate before writing, ONE store transaction (cancel or any error rolls back), never overwrite or delete what the archive has.
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BackupError } from "../container.js";
import type { MediaCache } from "../media.js";
import type { Chat, Message } from "../model.js";
import type { Store } from "../store.js";
import { fillMissing } from "../signalimport/service.js";
import { stripPlaceholder } from "../placeholder.js";
import { decryptToFile, deriveBackupEncryptionKey, keyFromCrypt14KeyFile, normalizeKey, HEX_KEY, readHeader, type WaHeader } from "./crypt.js";
import { WaReader, normJid, type RunStats, type WaMsg } from "./reader.js";

export interface WaMaps { own: string[]; lidToPn?(lid: string): string | undefined }
export interface WaImportAccount { id: string; provider: string; label: string; maps?: () => WaMaps | undefined }
export interface WhatsAppImportHost {
  store: Store; media: MediaCache; emit(event: string, data: unknown): void;
  /** Path of a chosen file / finished upload / folder (BackupService.source: applies the host's path policy). */
  source(p: { path?: string; uploadId?: string }): string;
  /** A private folder for the short-lived decrypted copy (swept at startup: names start with ".import-"). */
  tempDir(): string;
  reload(): Promise<void>;
  accounts(): WaImportAccount[];
}
export interface ImportOptions { attachments?: boolean; since?: string | number; until?: string | number }
type Params = { path?: string; uploadId?: string; key?: string; keyFileBase64?: string; accountId?: string; mediaPath?: string; options?: ImportOptions; confirmUnverified?: boolean; confirmMismatch?: boolean };

const SETTING_CHATS = (a: string) => `whatsappImport.chats.${a}`;
const SETTING_IDENT = (a: string) => `whatsappImport.identity.${a}`;
const BATCH = 400;
type StoredChat = { kind: "dm" | "group"; name?: string; lastMessageAt?: string; preview?: string; disappearing?: number };

/** Chats created by an import, merged into the chat list of the account (the provider's own records win). Used by Hub.collect(). */
export function withWhatsAppImportedChats(store: Store, accountId: string, provider: string, got: { chats: Chat[]; spaces: any[] } | undefined): { chats: Chat[]; spaces: any[] } | undefined {
  const raw = store.getSetting(SETTING_CHATS(accountId)); if (!raw) return got;
  let rec: Record<string, StoredChat>; try { rec = JSON.parse(raw); } catch { return got; }
  const have = new Set((got?.chats ?? []).map((c) => c.id)), add: Chat[] = [];
  for (const [id, c] of Object.entries(rec)) {
    const gid = `${accountId}:${id}`; if (have.has(gid)) continue;
    const handle = id.endsWith("@s.whatsapp.net") ? "+" + id.slice(0, id.indexOf("@")) : id.endsWith("@lid") ? "WhatsApp user" : id;
    add.push({ id: gid, accountId, provider, kind: c.kind, name: c.name || (c.kind === "group" ? "Group" : handle), ...(c.lastMessageAt ? { lastMessageAt: c.lastMessageAt } : {}), ...(c.preview ? { preview: c.preview } : {}), ...(c.disappearing ? { disappearing: c.disappearing } : {}) });
  }
  if (!add.length) return got;
  return { spaces: got?.spaces ?? [], chats: [...(got?.chats ?? []), ...add] };
}

const ms = (v: string | number | undefined): number | undefined => { if (v === undefined || v === "" || v === null) return undefined; const n = typeof v === "number" ? v : /^\d+$/.test(v) ? Number(v) : Date.parse(v); return Number.isFinite(n) ? n : undefined; };
const preview = (m: Message) => (m.text || (m.attachments?.[0] ? `[${m.attachments[0].kind}]` : "")).replace(/\s+/g, " ").slice(0, 120);

interface Opened { reader: WaReader; header: WaHeader; size: number; plain: number; multifile: boolean; cleanup(): Promise<void> }

export class WhatsAppImportService {
  static readonly methods = new Set(["whatsappBackupInspect", "whatsappBackupImport", "whatsappBackupCancel"]);
  private job?: AbortController;
  constructor(private h: WhatsAppImportHost) {}

  async call(method: string, p: any = {}): Promise<unknown> {
    switch (method) {
      case "whatsappBackupInspect": return this.inspect(p);
      case "whatsappBackupImport": return this.importHistory(p);
      case "whatsappBackupCancel": this.job?.abort(); return { cancelled: !!this.job };
    }
    throw new Error(`unknown method ${method}`);
  }
  private begin() { if (this.job) throw new BackupError("invalid", "Another WhatsApp import is still running."); this.job = new AbortController(); return this.job; }
  private progress(op: string, stage: string, done: number, total: number, last = { t: 0, s: "" }) {
    const now = Date.now(); if (stage === last.s && now - last.t < 120 && done < total) return;
    last.t = now; last.s = stage; this.h.emit("backup-progress", { op, stage, done, total });
  }
  private waAccounts() { return this.h.accounts().filter((a) => a.provider === "whatsapp"); }
  private mapsOf(a: WaImportAccount | undefined, remember = false): WaMaps | undefined {
    if (!a) return undefined;
    let live: WaMaps | undefined; try { live = a.maps?.(); } catch { /* offline */ }
    if (live?.own?.length) { if (remember) { try { this.h.store.setSetting(SETTING_IDENT(a.id), JSON.stringify({ own: live.own })); } catch { /* best effort */ } } return live; }
    try { const s = JSON.parse(this.h.store.getSetting(SETTING_IDENT(a.id)) ?? "null"); if (Array.isArray(s?.own) && s.own.length) return { own: s.own.map(String) }; } catch { /* none */ }
    return undefined;
  }

  /** Folder that holds `Media/`: chosen explicitly, or found next to the backup file (…/WhatsApp/Databases/msgstore… -> …/WhatsApp). Every candidate goes through the host's path policy. */
  private mediaRootFor(p: Params, file: string): string | undefined {
    const hasMedia = (d: string) => { try { return statSync(join(d, "Media")).isDirectory(); } catch { return false; } };
    const pick = (d: string) => { for (const c of [d, join(d, "WhatsApp"), basename(d).toLowerCase() === "media" ? dirname(d) : undefined]) if (c && hasMedia(c)) return c; return undefined; };
    if (p.mediaPath) {
      const dir = this.h.source({ path: p.mediaPath }), r = pick(dir);
      if (!r) throw new BackupError("invalid", "That folder has no Media folder. Choose the WhatsApp folder that contains Databases and Media.");
      return r;
    }
    if (!p.path) return undefined;
    for (const c of [dirname(file), dirname(dirname(file))]) { let ok: string | undefined; try { ok = this.h.source({ path: c }); } catch { continue; } const r = ok && pick(ok); if (r) return r; }
    return undefined;
  }

  private async open(p: Params, op: string, signal: AbortSignal): Promise<Opened> {
    const file = this.h.source(p);
    const prog = (d: number, t: number) => this.progress(op, "verifying", d, t);
    const { header } = await readHeader(file);
    let key: Buffer;
    if (header.crypt === 14) {
      if (!p.keyFileBase64) throw new BackupError("bad-passphrase", "This is an older crypt14 backup. It can only be opened with the 158-byte `key` file from the phone (/data/data/com.whatsapp/files/key), which needs a rooted phone. Without it: switch on end-to-end encrypted backup in WhatsApp, make a new backup (crypt15) and import that one.");
      key = keyFromCrypt14KeyFile(Buffer.from(p.keyFileBase64, "base64"));
    } else {
      const hex = normalizeKey(String(p.key ?? ""));
      if (!HEX_KEY.test(hex)) throw new BackupError("bad-passphrase", "Enter the 64-digit encryption key (0-9 and a-f) that WhatsApp showed when you switched on end-to-end encrypted backup.");
      const root = Buffer.from(hex, "hex"); key = deriveBackupEncryptionKey(root); root.fill(0);
    }
    const dst = join(this.h.tempDir(), `.import-wa-${randomBytes(6).toString("hex")}.db`);
    const cleanup = async () => { for (const x of ["", "-wal", "-shm", "-journal"]) await rm(dst + x, { force: true }).catch(() => {}); };
    try {
      const r = await decryptToFile(file, dst, key, { signal, onProgress: prog });
      const reader = await WaReader.open(dst);
      return { reader, header, size: r.size, plain: r.plainBytes, multifile: r.multifile, cleanup: async () => { reader.close(); await cleanup(); } };
    } catch (e) { await cleanup(); throw e; } finally { key.fill(0); }
  }

  private matchOf(a: WaImportAccount, header: WaHeader): "match" | "mismatch" | "unknown" {
    const own = this.mapsOf(a)?.own.map(normJid).find((j) => j.endsWith("@s.whatsapp.net"));
    if (!own || !header.jidSuffix || header.jidSuffix.length !== 2) return "unknown";
    return own.slice(0, own.indexOf("@")).endsWith(header.jidSuffix) ? "match" : "mismatch";
  }

  /** No writes (apart from the short-lived decrypted copy, removed before returning). Authenticates the file and counts what an import would bring. */
  async inspect(p: Params) {
    const ctl = this.begin(), op = "whatsapp-inspect"; let o: Opened | undefined;
    try {
      this.progress(op, "verifying", 0, 1);
      const file = this.h.source(p);
      o = await this.open(p, op, ctl.signal);
      const root = this.mediaRootFor(p, file);
      const maps = this.mapsOf(this.waAccounts().find((a) => a.id === p.accountId));
      const stats = await o.reader.run({ signal: ctl.signal, attachments: false, mediaRoot: root, ownId: maps?.own[0] ?? "me", lidToPn: maps?.lidToPn, onProgress: (d, t) => this.progress(op, "counting", d, t), onMessage() {}, onBlob() {} });
      this.progress(op, "finished", 1, 1);
      const a = stats.attachments;
      return {
        format: o.header.crypt === 15 ? "crypt15" : "crypt14", size: o.size, whatsappVersion: o.header.appVersion, dbVersion: o.reader.dbVersion, multifile: o.multifile,
        messages: stats.messages, chats: { total: stats.chats.length, dms: stats.chats.filter((c) => c.kind === "dm").length, groups: stats.chats.filter((c) => c.kind === "group").length, unresolved: stats.unresolvedChats },
        attachments: { count: a.listed, bytes: a.bytes, present: a.present, missing: a.missing },
        firstAt: stats.first ? new Date(stats.first).toISOString() : undefined, lastAt: stats.last ? new Date(stats.last).toISOString() : undefined,
        skipped: stats.skipped, warnings: stats.warnings,
        accounts: this.waAccounts().map((x) => ({ id: x.id, label: x.label, match: this.matchOf(x, o!.header) })),
        topChats: [...stats.chats].sort((x, y) => y.count - x.count).slice(0, 12).map((c) => ({ name: c.name ?? (c.kind === "group" ? "Group" : c.id.replace(/@.*/, "")), kind: c.kind, messages: c.count, lastAt: c.last ? new Date(c.last).toISOString() : undefined })),
        mediaFolder: !!root, canAttachments: !!root,
      };
    } finally { await o?.cleanup(); this.job = undefined; }
  }

  async importHistory(p: Params) {
    const acc = this.waAccounts().find((a) => a.id === p.accountId);
    if (!acc) throw new BackupError("invalid", "Choose the WhatsApp account to import into.");
    const opt = p.options ?? {}, ctl = this.begin(), op = "whatsapp-import", store = this.h.store, written: string[] = [];
    let ok = false, o: Opened | undefined;
    try {
      this.progress(op, "verifying", 0, 1);
      const file = this.h.source(p);
      o = await this.open(p, op, ctl.signal);
      const mine = this.mapsOf(acc, true), match = this.matchOf(acc, o.header);
      if (match === "mismatch" && !p.confirmMismatch) throw new BackupError("invalid", "This backup seems to belong to a different WhatsApp number than the account you chose (the last two digits differ). Nothing was imported. If you are sure, confirm and import anyway.");
      if (match === "unknown" && !p.confirmUnverified) throw new BackupError("invalid", `UniChat cannot check that this backup belongs to ${acc.label} (the account is signed out, or the backup does not say). Confirm that it does, or sign in first.`);
      const root = this.mediaRootFor(p, file), wantAtt = opt.attachments !== false && !!root;
      const since = ms(opt.since), until = ms(opt.until), ownId = mine?.own[0] ?? "me";
      const touched = new Map<string, StoredChat>();
      const known: Record<string, StoredChat> = (() => { try { return JSON.parse(store.getSetting(SETTING_CHATS(acc.id)) ?? "{}"); } catch { return {}; } })();
      const res = { added: 0, filled: 0, existing: 0, chatsNew: 0, chatsKnown: 0 };
      const gid = (jid: string) => `${acc.id}:${jid}`;
      let batch: Message[] = [];
      const flush = () => {
        if (!batch.length) return;
        const put: Message[] = [];
        for (const m of batch) {
          const old = store.getMessage(m.chatId, m.id);
          if (!old) { put.push(m); res.added++; continue; }
          const fill = fillMissing(old, m);
          if (fill) { put.push(fill); res.filled++; } else res.existing++;
        }
        if (put.length) store.putMessages(put);
        batch = [];
      };
      this.progress(op, "importing", 0, 1);
      let stats!: RunStats;
      await store.inTransaction(async () => {
        stats = await o!.reader.run({
          signal: ctl.signal, attachments: wantAtt, mediaRoot: root, since, until, ownId, lidToPn: mine?.lidToPn,
          onProgress: (d, t) => this.progress(op, "importing", d, t),
          onMessage: (im: WaMsg) => {
            const m: Message = { ...im.message, chatId: gid(im.chat.id), accountId: acc.id };
            if (m.attachments?.length && m.text) m.text = stripPlaceholder(m.text); // media stored: no "[Photo]" stand-in next to it
            batch.push(m);
            const e = touched.get(im.chat.id) ?? { kind: im.chat.kind, name: im.chat.name, ...(im.chat.disappearing ? { disappearing: im.chat.disappearing } : {}) };
            if (!e.lastMessageAt || m.time > e.lastMessageAt) { e.lastMessageAt = m.time; e.preview = preview(m); }
            touched.set(im.chat.id, e);
            if (batch.length >= BATCH) flush();
          },
          onBlob: (att, owner, data) => {
            const k = `${gid(owner.chat.id)}|${owner.message.id}|${att.id}`;
            if (store.getMessage(gid(owner.chat.id), owner.message.id)?.deleted) return;
            if (this.h.media.has(acc.id, k)) return; // never overwrite
            this.h.media.put(acc.id, k, { data, mime: att.mime, name: att.name }); written.push(k);
          },
        });
        flush();
        if (ctl.signal.aborted) throw new BackupError("cancelled", "Cancelled. Nothing was imported.");
        for (const [id, c] of touched) {
          const prev = known[id]; if (!prev) res.chatsNew++; else res.chatsKnown++;
          const newer = !prev?.lastMessageAt || (c.lastMessageAt && c.lastMessageAt > prev.lastMessageAt);
          known[id] = { kind: c.kind, name: prev?.name || c.name, ...(c.disappearing || prev?.disappearing ? { disappearing: prev?.disappearing ?? c.disappearing } : {}),
            lastMessageAt: newer ? c.lastMessageAt : prev?.lastMessageAt, preview: newer ? c.preview : prev?.preview };
        }
        store.setSetting(SETTING_CHATS(acc.id), JSON.stringify(known));
      });
      ok = true;
      this.progress(op, "finishing", 0, 1);
      await o.cleanup(); o = undefined; // plaintext copy gone before the (slow) reload
      await this.h.reload();
      this.h.emit("chats-changed", { accountId: acc.id });
      this.progress(op, "finished", 1, 1);
      const warnings = [...stats.warnings];
      if (match === "unknown") warnings.push("The match between the backup and the account could not be verified (you confirmed it).");
      if (match === "mismatch") warnings.push("The backup seems to belong to a different number than the account it was imported into (you confirmed this).");
      if (!mine) warnings.push("The account is not signed in: your own messages were attributed to a placeholder id and may not line up with live messages.");
      const a = stats.attachments;
      return {
        messages: { added: res.added, filled: res.filled, existing: res.existing, total: stats.messages },
        chats: { created: res.chatsNew, merged: res.chatsKnown, total: touched.size },
        attachments: { stored: a.stored, missing: wantAtt ? a.missing : 0, mismatch: a.mismatch, skipped: wantAtt ? 0 : a.listed },
        skipped: stats.skipped, firstAt: stats.first ? new Date(stats.first).toISOString() : undefined, lastAt: stats.last ? new Date(stats.last).toISOString() : undefined,
        accountId: acc.id, warnings,
      };
    } finally {
      if (!ok) for (const k of written) { try { this.h.media.remove(acc.id, k); } catch { /* ignore */ } }
      await o?.cleanup(); this.job = undefined;
    }
  }
}
