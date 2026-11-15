// Hub RPCs signalBackupInspect / signalBackupImport / signalBackupCancel: import the chat history of a Signal backup into the archive of
// an existing, linked Signal account. Reads are streamed and MAC-verified before anything is written; writes happen in ONE store
// transaction (cancel or any error rolls the archive back) and never overwrite or delete what the archive already holds.
import { BackupError } from "../container.js";
import type { MediaCache } from "../media.js";
import type { Chat, Message, Reaction } from "../model.js";
import type { Store } from "../store.js";
import { LegacySource, type HistorySource, type RunStats } from "./legacysource.js";
import { isUuid, normAci, type ImportChat, type ImportedMessage } from "./model.js";
import { stripPlaceholder } from "../placeholder.js";
import { SecureSource } from "./secure.js";

export interface ImportAccount { id: string; provider: string; label: string; identity?: () => { aci: string; number?: string; numberToAci?(e164: string): string | undefined } | undefined;
  /** hands the backup's contacts (profile keys) to the live connector; returns the number of new keys */
  importContacts?: (list: { aci: string; profileKey?: string; name?: string; e164?: string; pni?: string }[]) => number }
export interface SignalImportHost {
  store: Store; media: MediaCache; emit(event: string, data: unknown): void;
  /** Path of a chosen file / finished upload (BackupService.source: applies the host's path policy). */
  source(p: { path?: string; uploadId?: string }): string;
  /** Called after a successful import: re-read the archive (search index, chat lists). */
  reload(): Promise<void>;
  accounts(): ImportAccount[];
}
export interface ImportOptions { attachments?: boolean; since?: string | number; until?: string | number }
type Params = { path?: string; uploadId?: string; metadataBase64?: string; passphrase?: string; format?: "android-legacy" | "secure-backup"; aci?: string; accountId?: string; options?: ImportOptions; confirmUnverified?: boolean; confirmMismatch?: boolean };

const SETTING_CHATS = (a: string) => `signalImport.chats.${a}`;
const SETTING_IDENT = (a: string) => `signalImport.identity.${a}`;
const BATCH = 400;
type StoredChat = { kind: "dm" | "group"; name?: string; lastMessageAt?: string; preview?: string };

/** Chats created by an import, merged into the chat list of the account (the provider's own records win). Used by Hub.collect(). */
export function withImportedChats(store: Store, accountId: string, provider: string, got: { chats: Chat[]; spaces: any[] } | undefined): { chats: Chat[]; spaces: any[] } | undefined {
  const raw = store.getSetting(SETTING_CHATS(accountId)); if (!raw) return got;
  let rec: Record<string, StoredChat>; try { rec = JSON.parse(raw); } catch { return got; }
  const have = new Set((got?.chats ?? []).map((c) => c.id)), add: Chat[] = [];
  for (const [id, c] of Object.entries(rec)) {
    const gid = `${accountId}:${id}`; if (have.has(gid)) continue;
    add.push({ id: gid, accountId, provider, kind: c.kind, name: c.name || (c.kind === "group" ? "Group" : id.replace(/^e164:/, "")), ...(c.lastMessageAt ? { lastMessageAt: c.lastMessageAt } : {}), ...(c.preview ? { preview: c.preview } : {}) });
  }
  if (!add.length) return got;
  return { spaces: got?.spaces ?? [], chats: [...(got?.chats ?? []), ...add] };
}

const ms = (v: string | number | undefined): number | undefined => { if (v === undefined || v === "" || v === null) return undefined; const n = typeof v === "number" ? v : /^\d+$/.test(v) ? Number(v) : Date.parse(v); return Number.isFinite(n) ? n : undefined; };
const preview = (m: Message) => (m.text || (m.attachments?.[0] ? `[${m.attachments[0].kind}]` : "")).replace(/\s+/g, " ").slice(0, 120);

export class SignalImportService {
  static readonly methods = new Set(["signalBackupInspect", "signalBackupImport", "signalBackupCancel"]);
  private job?: AbortController;
  constructor(private h: SignalImportHost) {}

  async call(method: string, p: any = {}): Promise<unknown> {
    switch (method) {
      case "signalBackupInspect": return this.inspect(p);
      case "signalBackupImport": return this.importHistory(p);
      case "signalBackupCancel": this.job?.abort(); return { cancelled: !!this.job };
    }
    throw new Error(`unknown method ${method}`);
  }

  private begin() { if (this.job) throw new BackupError("invalid", "Another Signal import is still running."); this.job = new AbortController(); return this.job; }
  private progress(op: string, stage: string, done: number, total: number, last = { t: 0, s: "" }) {
    const now = Date.now(); if (stage === last.s && now - last.t < 120 && done < total) return;
    last.t = now; last.s = stage; this.h.emit("backup-progress", { op, stage, done, total });
  }
  private signalAccounts() { return this.h.accounts().filter((a) => a.provider === "signal"); }
  private identityOf(a: ImportAccount | undefined, remember = false) {
    if (!a) return undefined;
    let live: ReturnType<NonNullable<ImportAccount["identity"]>> | undefined; try { live = a.identity?.(); } catch { /* offline */ }
    if (live?.aci) { if (remember) { try { this.h.store.setSetting(SETTING_IDENT(a.id), JSON.stringify({ aci: normAci(live.aci), number: live.number })); } catch { /* best effort */ } } return { ...live, aci: normAci(live.aci)! }; }
    try { const s = JSON.parse(this.h.store.getSetting(SETTING_IDENT(a.id)) ?? "null"); if (s?.aci) return { aci: String(s.aci), number: s.number as string | undefined, numberToAci: undefined }; } catch { /* none */ }
    return undefined;
  }

  private async open(p: Params, op: string, signal: AbortSignal, total: { done: number }): Promise<HistorySource> {
    const file = this.h.source(p);
    const prog = (d: number, t: number) => this.progress(op, "verifying", d, t);
    const kind = p.format ?? await sniff(file);
    if (kind === "secure-backup") {
      // the account id is part of the key: take it from the chosen account (live, or remembered from when it was signed in) unless given
      const aci = p.aci ?? this.identityOf(this.signalAccounts().find((a) => a.id === p.accountId))?.aci;
      let metadata: Buffer | undefined;
      if (p.metadataBase64) metadata = Buffer.from(p.metadataBase64, "base64");
      else if (p.path) { try { metadata = await (await import("node:fs/promises")).readFile((await import("node:path")).join((await import("node:path")).dirname(file), "metadata")); if (metadata.length > 4096) metadata = undefined; } catch { /* a single-file backup */ } }
      return SecureSource.open(file, String(p.passphrase ?? ""), { signal, onProgress: prog, aci, metadata });
    }
    return LegacySource.open(file, String(p.passphrase ?? ""), { signal, onProgress: prog });
  }

  /** No writes. Authenticates the file (every MAC) and counts what an import would bring. */
  async inspect(p: Params) {
    const ctl = this.begin(), op = "signal-inspect", t = { done: 0 };
    try {
      this.progress(op, "verifying", 0, 1);
      const src = await this.open(p, op, ctl.signal, t);
      const ownAci = normAci(src.identity.aci) ?? "00000000-0000-0000-0000-000000000000";
      const stats = await src.run({ signal: ctl.signal, attachments: false, ownAci, onProgress: (d, tt) => this.progress(op, "counting", d, tt), onMessage() {}, onBlob() {} });
      this.progress(op, "finished", 1, 1);
      const accounts = this.signalAccounts().map((a) => {
        const id = this.identityOf(a), b = normAci(src.identity.aci);
        return { id: a.id, label: a.label, aci: id?.aci, match: !b ? "unknown" : !id ? "unknown" : id.aci === b ? "match" : "mismatch" } as const;
      });
      return {
        format: src.format, size: src.size, dbVersion: src.dbVersion, own: src.identity,
        messages: stats.messages, chats: { total: stats.chats.length, dms: stats.chats.filter((c) => c.kind === "dm").length, groups: stats.chats.filter((c) => c.kind === "group").length, unresolved: stats.unresolvedChats },
        attachments: { count: stats.attachments.listed, bytes: stats.attachments.bytes },
        firstAt: stats.first ? new Date(stats.first).toISOString() : undefined, lastAt: stats.last ? new Date(stats.last).toISOString() : undefined,
        skipped: stats.skipped, warnings: stats.warnings, accounts,
        topChats: [...stats.chats].sort((a, b) => b.count - a.count).slice(0, 12).map((c) => ({ name: c.name ?? c.id, kind: c.kind, messages: c.count, lastAt: c.last ? new Date(c.last).toISOString() : undefined })),
        canAttachments: src.format === "android-legacy" || src.hasMedia === true,
      };
    } finally { this.job = undefined; }
  }

  async importHistory(p: Params) {
    const accounts = this.signalAccounts(), acc = accounts.find((a) => a.id === p.accountId);
    if (!acc) throw new BackupError("invalid", "Choose the Signal account to import into.");
    const opt = p.options ?? {};
    const ctl = this.begin(), op = "signal-import", store = this.h.store, written: string[] = [];
    let ok = false;
    try {
      const t = { done: 0 };
      this.progress(op, "verifying", 0, 1);
      const src = await this.open(p, op, ctl.signal, t);
      // who are we? The account decides; the backup's own id (if it carries one) must agree.
      const mine = this.identityOf(acc, true), theirs = normAci(src.identity.aci);
      if (mine && theirs && mine.aci !== theirs && !p.confirmMismatch)
        throw new BackupError("invalid", "This backup belongs to a different Signal account than the one you chose. Nothing was imported. If you are sure, confirm and import anyway.");
      if (!mine && !p.confirmUnverified)
        throw new BackupError("invalid", `${acc.label} is not signed in right now, so UniChat cannot check that this backup is its own. Confirm that it is, or sign in first.`);
      const ownAci = mine?.aci ?? theirs;
      if (!ownAci || !isUuid(ownAci)) throw new BackupError("invalid", "The backup does not say which account it belongs to and this account is not signed in. Sign in with the account first so messages can be matched.");
      const wantAtt = opt.attachments !== false && (src.format === "android-legacy" || src.hasMedia === true);
      const since = ms(opt.since), until = ms(opt.until);
      const touched = new Map<string, StoredChat>();
      const known: Record<string, StoredChat> = (() => { try { return JSON.parse(store.getSetting(SETTING_CHATS(acc.id)) ?? "{}"); } catch { return {}; } })();
      const res = { added: 0, filled: 0, existing: 0, chatsNew: 0, chatsKnown: 0 };
      const gid = (chat: ImportChat) => `${acc.id}:${chat.id}`;

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
      this.progress(op, "importing", 0, src.size);
      let stats!: RunStats;
      await store.inTransaction(async () => {
        stats = await src.run({
          signal: ctl.signal, attachments: wantAtt, since, until, ownAci, resolveE164: mine?.numberToAci,
          onProgress: (d, tt) => this.progress(op, "importing", d, tt),
          onMessage: (im: ImportedMessage) => {
            const m: Message = { ...im.message, chatId: gid(im.chat), accountId: acc.id };
            if (m.attachments?.length && m.text) m.text = stripPlaceholder(m.text); // media stored: no "[Photo]" stand-in next to it
            batch.push(m);
            const e = touched.get(im.chat.id) ?? { kind: im.chat.kind, name: im.chat.name };
            if (!e.lastMessageAt || m.time > e.lastMessageAt) { e.lastMessageAt = m.time; e.preview = preview(m); }
            if (!e.name && im.chat.name) e.name = im.chat.name; touched.set(im.chat.id, e);
            if (batch.length >= BATCH) flush();
          },
          onBlob: (part, owner, data) => {
            const k = `${gid(owner.chat)}|${owner.message.id}|${part.att.id}`;
            if (store.getMessage(gid(owner.chat), owner.message.id)?.deleted) return;
            if (this.h.media.has(acc.id, k)) return; // never overwrite
            this.h.media.put(acc.id, k, { data, mime: part.att.mime, name: part.att.name }); written.push(k);
          },
        });
        flush();
        if (ctl.signal.aborted) throw new BackupError("cancelled", "Cancelled. Nothing was imported.");
        // chat list entries (kept in a setting: the provider only lists chats it has a record for)
        for (const [id, c] of touched) {
          const prev = known[id];
          if (!prev) res.chatsNew++; else res.chatsKnown++;
          known[id] = { kind: c.kind, name: prev?.name || c.name, ...pickNewest(prev, c) };
        }
        store.setSetting(SETTING_CHATS(acc.id), JSON.stringify(known));
      });
      ok = true;
      this.progress(op, "finishing", 0, 1);
      // profile keys of the backup's contacts (pictures + names of already imported chats): only ADDS keys, so re-running the import is safe
      let keys = 0, contacts = 0;
      try { const list = stats.contacts ?? []; contacts = list.length; if (list.length && acc.importContacts) keys = acc.importContacts(list) || 0; } catch { /* the keys are a bonus: never fail the import */ }
      await this.h.reload();
      this.h.emit("chats-changed", { accountId: acc.id });
      this.progress(op, "finished", 1, 1);
      const warnings = [...stats.warnings];
      if (!mine) warnings.push("The account was not signed in, so the match with the backup was not verified.");
      if (mine && theirs && mine.aci !== theirs) warnings.push("The backup belongs to a different account than the one it was imported into (you confirmed this).");
      return {
        messages: { added: res.added, filled: res.filled, existing: res.existing, total: stats.messages },
        chats: { created: res.chatsNew, merged: res.chatsKnown, total: touched.size },
        attachments: { stored: stats.attachments.stored, missing: wantAtt ? stats.attachments.missing : 0, skipped: wantAtt ? 0 : stats.attachments.listed },
        skipped: stats.skipped, firstAt: stats.first ? new Date(stats.first).toISOString() : undefined, lastAt: stats.last ? new Date(stats.last).toISOString() : undefined,
        contacts: { inBackup: contacts, newProfileKeys: keys },
        accountId: acc.id, warnings,
      };
    } finally {
      if (!ok) for (const k of written) { try { this.h.media.remove(acc.id, k); } catch { /* ignore */ } }
      this.job = undefined;
    }
  }
}

function pickNewest(prev: StoredChat | undefined, c: StoredChat) {
  if (!prev?.lastMessageAt || (c.lastMessageAt && c.lastMessageAt > prev.lastMessageAt)) return { lastMessageAt: c.lastMessageAt, preview: c.preview };
  return { lastMessageAt: prev.lastMessageAt, preview: prev.preview };
}

/** Existing messages are never overwritten: only fields the archive does not have are filled in. Returns the message to store, or undefined when nothing is missing. */
export function fillMissing(old: Message, inc: Message): Message | undefined {
  if (old.deleted) return undefined;
  const out: Message = { ...old }; let changed = false;
  const set = <K extends keyof Message>(k: K, v: Message[K] | undefined, empty: boolean) => { if (empty && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) { out[k] = v as Message[K]; changed = true; } };
  // the media arrived now: the "[Photo]" stand-in an earlier (media-less) import left in the text goes away
  const gainsMedia = !!inc.attachments?.length && !old.attachments?.length;
  const oldText = gainsMedia && old.text ? stripPlaceholder(old.text) : old.text;
  if (oldText !== old.text) { out.text = oldText; changed = true; }
  set("text", inc.text, !oldText);
  set("attachments", inc.attachments, !old.attachments?.length);
  set("replyTo", inc.replyTo, !old.replyTo);
  set("contacts", inc.contacts, !old.contacts?.length);
  set("card", inc.card, !old.card && !old.cards?.length);
  set("status", inc.status, !old.status);
  if (inc.reactions?.length) {
    const by = new Map<string, Reaction>((old.reactions ?? []).map((r) => [r.emoji, { ...r, senderIds: [...r.senderIds] }]));
    let add = false;
    for (const r of inc.reactions) {
      const e = by.get(r.emoji);
      if (!e) { by.set(r.emoji, { ...r, senderIds: [...r.senderIds] }); add = true; continue; }
      for (const s of r.senderIds) if (!e.senderIds.includes(s)) { e.senderIds.push(s); add = true; }
      if (r.mine && !e.mine) { e.mine = true; add = true; }
    }
    if (add) { out.reactions = [...by.values()]; changed = true; }
  }
  return changed ? out : undefined;
}

async function sniff(file: string): Promise<"android-legacy" | "secure-backup"> {
  const { open } = await import("node:fs/promises");
  const fh = await open(file, "r");
  try {
    const b = Buffer.alloc(8); const { bytesRead } = await fh.read(b, 0, 8, 0);
    // legacy: u32be header length (small) followed by a protobuf BackupFrame whose first field (header, tag 0x0a) comes first
    if (bytesRead >= 6 && b.readUInt32BE(0) < 1 << 16 && b[4] === 0x0a) return "android-legacy";
    return "secure-backup";
  } finally { await fh.close(); }
}
