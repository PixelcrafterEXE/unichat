// SQLite-backed Store on Node's built-in `node:sqlite` (Node >= 22.13): no native add-on to build.
// (Android/nodejs-mobile runs an older Node and will need a different driver.)
//
// Encryption at rest: when a 32-byte key is supplied, every payload column that can reveal content or
// contacts (messages, chat lists, aliases, mesh groups, account labels) is sealed with AES-256-GCM.
// NOT encrypted: ids, message timestamps and account/provider names (needed for ordering, paging and retention),
// so someone with the file alone can still see roughly WHEN conversations happened, not WHAT was said or with whom.
import { chmodSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AvatarMeta, AvatarState, StoredAvatar, StateRecord, AccountEvent, AccountEventKind, Chat, ChatFlags, ChatMerge, Folder, Job, MeshGroup, Message, Space, Store, StoredAccount } from "@unimsg/core";
import { applyPatch, avatarKeyId, mergeMessage, messageSearchText } from "@unimsg/core/store";

const PREFIX = "e1:";
export class Vault {
  constructor(private key?: Uint8Array) {
    if (key && key.length !== 32) throw new Error("data key must be 32 bytes");
  }
  enc(s: string): string {
    if (!this.key) return s;
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(s, "utf8"), c.final()]);
    return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  }
  dec(s: string): string {
    if (!s.startsWith(PREFIX)) return s; // rows written before a key was configured stay readable
    if (!this.key) throw new Error("the database is encrypted but no data key was supplied");
    const b = Buffer.from(s.slice(PREFIX.length), "base64");
    const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  }
}

export class SqliteStore implements Store {
  private db: DatabaseSync;
  private v: Vault;
  constructor(file: string, key?: Uint8Array) {
    this.v = new Vault(key);
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    try { chmodSync(file, 0o600); } catch { /* best effort, e.g. unsupported filesystem */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE IF NOT EXISTS aliases (chat_id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_flags (chat_id TEXT PRIMARY KEY, pinned INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, unread_mark INTEGER NOT NULL DEFAULT 0, read_up_to TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS mesh_groups (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_folder (chat_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_merges (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (chat_id TEXT NOT NULL, msg_id TEXT NOT NULL, account_id TEXT NOT NULL, time TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (chat_id, msg_id));
      CREATE INDEX IF NOT EXISTS messages_by_time ON messages(chat_id, time);
      CREATE INDEX IF NOT EXISTS messages_by_account ON messages(account_id);
      CREATE TABLE IF NOT EXISTS chat_cache (account_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_events (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, kind TEXT NOT NULL, time TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, run_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, status TEXT NOT NULL, last_error TEXT);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);
      -- avatars (migration: new table): mime + sha + bytes are sealed; the account, time and size stay readable for deletion, LRU and caps
      CREATE TABLE IF NOT EXISTS avatars (key TEXT PRIMARY KEY, account_id TEXT NOT NULL, fetched_at INTEGER NOT NULL, size INTEGER NOT NULL, empty INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS avatars_by_account ON avatars(account_id);
      CREATE INDEX IF NOT EXISTS avatars_by_time ON avatars(fetched_at);`);
    // migration: databases created before archiving existed have no accounts.status
    const cols = this.db.prepare("PRAGMA table_info(accounts)").all() as unknown as { name: string }[];
    if (!cols.some((c) => c.name === "status")) this.db.exec("ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    // migration: chat_flags gained unread_mark (the manual "mark as unread" flag used to be lost on restart)
    // migration: avatars gained tombstones (tomb) for deletions that sync carries
    if (!(this.db.prepare("PRAGMA table_info(avatars)").all() as unknown as { name: string }[]).some((c) => c.name === "tomb")) this.db.exec("ALTER TABLE avatars ADD COLUMN tomb INTEGER NOT NULL DEFAULT 0");
    if (!(this.db.prepare("PRAGMA table_info(chat_flags)").all() as unknown as { name: string }[]).some((c) => c.name === "unread_mark")) this.db.exec("ALTER TABLE chat_flags ADD COLUMN unread_mark INTEGER NOT NULL DEFAULT 0");
    if (!(this.db.prepare("PRAGMA table_info(chat_flags)").all() as unknown as { name: string }[]).some((c) => c.name === "read_up_to")) this.db.exec("ALTER TABLE chat_flags ADD COLUMN read_up_to TEXT NOT NULL DEFAULT ''"); // migration: the persistent read mark
  }
  /** False when sealed rows exist that the supplied key cannot open (the database was sealed with a different key). Reads only; changes nothing. */
  keyMatches(): boolean {
    try {
      for (const sql of ["SELECT label v FROM accounts LIMIT 3", "SELECT json v FROM messages LIMIT 3", "SELECT json v FROM chat_cache LIMIT 3"])
        for (const r of this.db.prepare(sql).all() as unknown as { v: string }[]) this.v.dec(r.v);
      return true;
    } catch { return false; }
  }
  close() { try { this.db.close(); } catch { /* closed */ } }
  private txDepth = 0; private txBad = false;
  private begin() { if (this.txDepth++ === 0) { this.db.exec("BEGIN"); this.txBad = false; } }
  private end(ok: boolean) {
    if (!ok) this.txBad = true;
    if (--this.txDepth === 0) { try { this.db.exec(this.txBad ? "ROLLBACK" : "COMMIT"); } catch (e) { try { this.db.exec("ROLLBACK"); } catch { /* gone */ } throw e; } }
  }
  /** Synchronous, re-entrant: nested calls join the outer transaction. A failure anywhere rolls the whole outer transaction back. */
  private tx(f: () => void) { this.begin(); try { f(); } catch (e) { this.end(false); throw e; } this.end(true); }
  /** May span awaits (one import = one transaction). Writes made by the app in the meantime join it: keep the window short. */
  async inTransaction<T>(f: () => T | Promise<T>): Promise<T> {
    this.begin();
    let r: T; try { r = await f(); } catch (e) { this.end(false); throw e; }
    this.end(true); return r;
  }

  // ---- accounts ----
  listAccounts(): StoredAccount[] {
    return (this.db.prepare("SELECT id, provider, label, status FROM accounts").all() as unknown as (StoredAccount & { status: string })[])
      .map((r) => ({ id: r.id, provider: r.provider, label: this.v.dec(r.label), status: r.status === "archived" ? "archived" : "active" }));
  }
  putAccount(a: StoredAccount) {
    this.db.prepare("INSERT OR REPLACE INTO accounts (id, provider, label, status) VALUES (?,?,?,?)").run(a.id, a.provider, this.v.enc(a.label), a.status ?? "active");
  }
  deleteAccount(id: string) { this.db.prepare("DELETE FROM accounts WHERE id=?").run(id); }
  deleteAccountData(id: string) {
    const prefix = id + ":";
    this.tx(() => {
      this.db.prepare("DELETE FROM messages WHERE account_id=?").run(id);
      this.db.prepare("DELETE FROM chat_cache WHERE account_id=?").run(id);
      this.db.prepare("DELETE FROM account_events WHERE account_id=?").run(id);
      this.deleteAvatars({ accountId: id }); // tombstones: the deletion reaches the paired devices
      this.db.prepare("DELETE FROM aliases WHERE substr(chat_id,1,?)=?").run(prefix.length, prefix);
      this.db.prepare("DELETE FROM chat_flags WHERE substr(chat_id,1,?)=?").run(prefix.length, prefix);
      this.db.prepare("DELETE FROM chat_folder WHERE substr(chat_id,1,?)=?").run(prefix.length, prefix);
    });
  }

  // ---- avatars (durable picture cache; sealed like everything that can reveal contacts) ----
  private avAccount(key: string) { const id = avatarKeyId(key), i = id.indexOf(":"); return i < 0 ? "" : id.slice(0, i); }
  getAvatar(key: string): StoredAvatar | undefined {
    const r = this.db.prepare("SELECT fetched_at, empty, tomb, meta, data FROM avatars WHERE key=?").get(key) as { fetched_at: number; empty: number; tomb: number; meta: string; data: string } | undefined;
    if (!r) return undefined;
    try {
      const m = JSON.parse(this.v.dec(r.meta)) as { mime: string; sha: string; rev?: string };
      return { key, mime: m.mime, sha: m.sha, fetchedAt: r.fetched_at, data: new Uint8Array(Buffer.from(this.v.dec(r.data), "base64")), ...(m.rev ? { rev: m.rev } : {}), ...(r.empty ? { empty: true } : {}), ...(r.tomb ? { gone: true } : {}) };
    } catch { return undefined; } // corrupt / wrong key: treat as not cached
  }
  putAvatar(a: StoredAvatar) {
    this.db.prepare("INSERT OR REPLACE INTO avatars (key, account_id, fetched_at, size, empty, tomb, meta, data) VALUES (?,?,?,?,?,?,?,?)")
      .run(a.key, this.avAccount(a.key), Math.round(a.fetchedAt), a.data.length, a.empty ? 1 : 0, a.gone ? 1 : 0, this.v.enc(JSON.stringify({ mime: a.mime, sha: a.sha, ...(a.rev ? { rev: a.rev } : {}) })), this.v.enc(Buffer.from(a.data).toString("base64")));
  }
  listAvatars(o: { after?: string; limit: number }): AvatarMeta[] {
    const rows = (o.after === undefined
      ? this.db.prepare("SELECT key, fetched_at, size, empty, tomb, meta FROM avatars ORDER BY key LIMIT ?").all(o.limit)
      : this.db.prepare("SELECT key, fetched_at, size, empty, tomb, meta FROM avatars WHERE key>? ORDER BY key LIMIT ?").all(o.after, o.limit)) as unknown as { key: string; fetched_at: number; size: number; empty: number; tomb: number; meta: string }[];
    const out: AvatarMeta[] = [];
    for (const r of rows) {
      try { const m = JSON.parse(this.v.dec(r.meta)) as { sha: string; rev?: string }; out.push({ key: r.key, sha: m.sha, fetchedAt: r.fetched_at, size: r.size, state: (r.tomb ? "gone" : r.empty ? "none" : "pic") as AvatarState, ...(m.rev ? { rev: m.rev } : {}) }); }
      catch { /* unreadable row: skip */ }
    }
    return out;
  }
  /** Rows become tombstones (sealed empty payload), so sync can carry the deletion. */
  deleteAvatars(o: { accountId?: string; id?: string; at?: number }) {
    const at = Math.round(o.at ?? Date.now()); let n = 0;
    const tomb = (key: string, acct: string) => this.db.prepare("INSERT OR REPLACE INTO avatars (key, account_id, fetched_at, size, empty, tomb, meta, data) VALUES (?,?,?,0,0,1,?,?)").run(key, acct, at, this.v.enc('{"mime":"","sha":""}'), this.v.enc(""));
    this.tx(() => {
      if (o.accountId !== undefined) for (const r of this.db.prepare("SELECT key FROM avatars WHERE account_id=? AND tomb=0").all(o.accountId) as unknown as { key: string }[]) { tomb(r.key, o.accountId); n++; }
      if (o.id !== undefined) {
        const acct = this.avAccount(`chat|${o.id}`), keys = new Set<string>();
        for (const kd of ["chat", "space", "contact", "emoji"]) for (const f of ["", "|full"]) keys.add(`${kd}|${o.id}${f}`);
        for (const k of keys) { const isChat = k.startsWith("chat|"), cur = this.db.prepare("SELECT tomb FROM avatars WHERE key=?").get(k) as { tomb: number } | undefined; if ((cur && !cur.tomb) || (isChat && !cur?.tomb)) { tomb(k, acct); n++; } }
      }
    });
    return n;
  }
  pruneAvatars(o: { maxBytes: number; olderThan?: number; tombOlderThan?: number }) {
    let n = 0;
    this.tx(() => {
      if (o.olderThan !== undefined) n += Number(this.db.prepare("DELETE FROM avatars WHERE tomb=0 AND fetched_at<?").run(o.olderThan).changes);
      if (o.tombOlderThan !== undefined) n += Number(this.db.prepare("DELETE FROM avatars WHERE tomb=1 AND fetched_at<?").run(o.tombOlderThan).changes);
      let total = 0;
      for (const r of this.db.prepare("SELECT key, size FROM avatars WHERE empty=0 AND tomb=0 ORDER BY fetched_at DESC").all() as unknown as { key: string; size: number }[]) {
        total += r.size; if (total > o.maxBytes) n += Number(this.db.prepare("DELETE FROM avatars WHERE key=?").run(r.key).changes);
      }
    });
    return n;
  }

  // ---- aliases / flags / mesh ----
  listAliases() {
    const out: Record<string, string> = {};
    for (const r of this.db.prepare("SELECT chat_id, name FROM aliases").all() as unknown as { chat_id: string; name: string }[]) out[r.chat_id] = this.v.dec(r.name);
    return out;
  }
  setAlias(chatId: string, name: string | null) {
    if (name) this.db.prepare("INSERT OR REPLACE INTO aliases VALUES (?,?)").run(chatId, this.v.enc(name));
    else this.db.prepare("DELETE FROM aliases WHERE chat_id=?").run(chatId);
  }
  listChatFlags() {
    const out: Record<string, ChatFlags> = {};
    for (const r of this.db.prepare("SELECT * FROM chat_flags").all() as unknown as { chat_id: string; pinned: number; muted: number; archived: number; unread_mark: number; read_up_to?: string }[])
      out[r.chat_id] = { pinned: !!r.pinned, muted: !!r.muted, archived: !!r.archived, ...(r.unread_mark ? { unreadMark: true } : {}), ...(r.read_up_to ? { readUpTo: r.read_up_to } : {}) };
    return out;
  }
  setChatFlags(chatId: string, f: ChatFlags) {
    if (f.pinned || f.muted || f.archived || f.unreadMark || f.readUpTo) this.db.prepare("INSERT OR REPLACE INTO chat_flags VALUES (?,?,?,?,?,?)").run(chatId, f.pinned ? 1 : 0, f.muted ? 1 : 0, f.archived ? 1 : 0, f.unreadMark ? 1 : 0, f.readUpTo ?? "");
    else this.db.prepare("DELETE FROM chat_flags WHERE chat_id=?").run(chatId);
  }
  // ---- local folders (names are user text => sealed) and per-chat folder overrides ----
  listFolders() {
    return (this.db.prepare("SELECT json FROM folders ORDER BY rowid").all() as unknown as { json: string }[]).map((r) => JSON.parse(this.v.dec(r.json)) as Folder);
  }
  putFolder(f: Folder) { this.db.prepare("INSERT OR REPLACE INTO folders VALUES (?,?)").run(f.id, this.v.enc(JSON.stringify(f))); }
  deleteFolder(id: string) { this.tx(() => { this.db.prepare("DELETE FROM folders WHERE id=?").run(id); this.db.prepare("DELETE FROM chat_folder WHERE folder_id=?").run(id); }); }
  listChatFolders() {
    const out: Record<string, string> = {};
    for (const r of this.db.prepare("SELECT chat_id, folder_id FROM chat_folder").all() as unknown as { chat_id: string; folder_id: string }[]) out[r.chat_id] = r.folder_id;
    return out;
  }
  setChatFolder(chatId: string, folderId: string | null) {
    if (folderId) this.db.prepare("INSERT OR REPLACE INTO chat_folder VALUES (?,?)").run(chatId, folderId);
    else this.db.prepare("DELETE FROM chat_folder WHERE chat_id=?").run(chatId);
  }
  listMeshGroups() {
    return (this.db.prepare("SELECT json FROM mesh_groups").all() as unknown as { json: string }[]).map((r) => JSON.parse(this.v.dec(r.json)) as MeshGroup);
  }
  putMeshGroup(g: MeshGroup) { this.db.prepare("INSERT OR REPLACE INTO mesh_groups VALUES (?,?)").run(g.id, this.v.enc(JSON.stringify(g))); }

  // ---- merged chats (local-only; members are chat ids, names are user text => sealed like aliases) ----
  listMerges() {
    return (this.db.prepare("SELECT json FROM chat_merges ORDER BY rowid").all() as unknown as { json: string }[]).map((r) => JSON.parse(this.v.dec(r.json)) as ChatMerge);
  }
  putMerge(m: ChatMerge) { this.db.prepare("INSERT OR REPLACE INTO chat_merges VALUES (?,?)").run(m.id, this.v.enc(JSON.stringify(m))); }
  deleteMerge(id: string) { this.db.prepare("DELETE FROM chat_merges WHERE id=?").run(id); }

  // ---- message archive ----
  private accountOf(m: Message) { return m.accountId ?? (m.chatId.startsWith("mesh:") ? "" : m.chatId.split(":")[0]); }
  private row(r: unknown): Message { return JSON.parse(this.v.dec((r as { json: string }).json)) as Message; }
  putMessages(ms: Message[]) {
    if (!ms.length) return;
    const get = this.db.prepare("SELECT json FROM messages WHERE chat_id=? AND msg_id=?");
    const put = this.db.prepare("INSERT OR REPLACE INTO messages (chat_id, msg_id, account_id, time, json) VALUES (?,?,?,?,?)");
    this.tx(() => {
      for (const m of ms) {
        const old = get.get(m.chatId, m.id); const merged = mergeMessage(old ? this.row(old) : undefined, m);
        put.run(m.chatId, m.id, this.accountOf(merged), merged.time, this.v.enc(JSON.stringify(merged)));
      }
    });
  }
  getMessage(chatId: string, id: string) {
    const r = this.db.prepare("SELECT json FROM messages WHERE chat_id=? AND msg_id=?").get(chatId, id);
    return r ? this.row(r) : undefined;
  }
  patchMessage(chatId: string, id: string, patch: Partial<Message>) {
    const old = this.getMessage(chatId, id); if (!old) return;
    const next = applyPatch(old, patch);
    this.db.prepare("UPDATE messages SET json=?, time=? WHERE chat_id=? AND msg_id=?").run(this.v.enc(JSON.stringify(next)), next.time, chatId, id);
  }
  listMessages(chatId: string, o: { beforeTime?: string; limit: number }) {
    const rows = o.beforeTime
      ? this.db.prepare("SELECT json FROM messages WHERE chat_id=? AND time<? ORDER BY time DESC, msg_id DESC LIMIT ?").all(chatId, o.beforeTime, o.limit)
      : this.db.prepare("SELECT json FROM messages WHERE chat_id=? ORDER BY time DESC, msg_id DESC LIMIT ?").all(chatId, o.limit);
    return rows.map((r) => this.row(r)).reverse();
  }
  searchMessages(chatId: string, q: string, limit: number) {
    const n = q.toLowerCase(), out: Message[] = [];
    for (const r of this.db.prepare("SELECT json FROM messages WHERE chat_id=? ORDER BY time DESC").iterate(chatId)) { // content is encrypted: scan + decrypt
      const m = this.row(r);
      if (!m.deleted && messageSearchText(m).includes(n)) { out.push(m); if (out.length >= limit) break; }
    }
    return out.reverse();
  }
  /** Keyset scan in primary-key order (cheap per page, no sort): `after` is the last (chat id, message id) of the previous page. */
  scanMessages(o: { after?: { chatId: string; id: string }; limit: number; accountId?: string }) {
    const lo = o.accountId ? o.accountId + ":" : "", hi = o.accountId ? o.accountId + ";" : "\uffff"; // ';' sorts right after ':'
    // keyset paging with a ROW VALUE: "(chat_id,msg_id) > (?,?)" is a plain range on the primary key, while the old "chat_id>? OR (chat_id=? AND msg_id>?)" made SQLite scan the table from the start for every page (quadratic: the search index fill of a big archive took minutes)
    const rows = o.after
      ? this.db.prepare("SELECT json FROM messages WHERE (chat_id, msg_id) > (?, ?) AND chat_id<? ORDER BY chat_id, msg_id LIMIT ?").all(o.after.chatId, o.after.id, hi, o.limit)
      : this.db.prepare("SELECT json FROM messages WHERE chat_id>=? AND chat_id<? ORDER BY chat_id, msg_id LIMIT ?").all(lo, hi, o.limit);
    return rows.map((r) => this.row(r));
  }
  deleteMessagesBefore(iso: string) { return Number(this.db.prepare("DELETE FROM messages WHERE time<?").run(iso).changes); }

  // ---- chat cache / events / settings ----
  putChatCache(id: string, v: { chats: Chat[]; spaces: Space[] }) { this.db.prepare("INSERT OR REPLACE INTO chat_cache VALUES (?,?)").run(id, this.v.enc(JSON.stringify(v))); }
  getChatCache(id: string) {
    const r = this.db.prepare("SELECT json FROM chat_cache WHERE account_id=?").get(id);
    return r ? (JSON.parse(this.v.dec((r as { json: string }).json)) as { chats: Chat[]; spaces: Space[] }) : undefined;
  }
  addAccountEvent(accountId: string, kind: AccountEventKind, time = new Date().toISOString()): AccountEvent {
    const r = this.db.prepare("INSERT INTO account_events (account_id, kind, time) VALUES (?,?,?)").run(accountId, kind, time);
    return { id: Number(r.lastInsertRowid), accountId, kind, time };
  }
  listAccountEvents(accountId: string): AccountEvent[] {
    return (this.db.prepare("SELECT id, account_id, kind, time FROM account_events WHERE account_id=? ORDER BY id").all(accountId) as unknown as { id: number; account_id: string; kind: AccountEventKind; time: string }[])
      .map((r) => ({ id: r.id, accountId: r.account_id, kind: r.kind, time: r.time }));
  }
  getSetting(key: string) { const r = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined; return r?.value; }
  setSetting(key: string, value: string) { this.db.prepare("INSERT OR REPLACE INTO settings VALUES (?,?)").run(key, value); }

  // ---- jobs ----
  putJob(j: Job) {
    this.db.prepare("INSERT OR REPLACE INTO jobs VALUES (?,?,?,?,?,?,?,?)")
      .run(j.id, j.kind, JSON.stringify(j.payload), j.runAt, j.attempts, j.maxAttempts, j.status, j.lastError ?? null);
  }
  getJob(id: string) { const r = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as any; return r ? toJob(r) : undefined; }
  dueJobs(now: number) { return this.db.prepare("SELECT * FROM jobs WHERE status='pending' AND run_at<=? ORDER BY run_at").all(now).map(toJob); }
  nextRunAt() { return (this.db.prepare("SELECT MIN(run_at) AS t FROM jobs WHERE status='pending'").get() as { t: number | null }).t ?? undefined; }
  // ---- backup / migration: decrypted records, streamed ----
  *exportRecords(): Generator<StateRecord> {
    for (const v of this.listAccounts()) yield { t: "account", v };
    for (const [chatId, name] of Object.entries(this.listAliases())) yield { t: "alias", chatId, name };
    for (const [chatId, v] of Object.entries(this.listChatFlags())) yield { t: "flags", chatId, v };
    for (const v of this.listFolders()) yield { t: "folder", v };
    for (const [chatId, folderId] of Object.entries(this.listChatFolders())) yield { t: "chatFolder", chatId, folderId };
    for (const v of this.listMeshGroups()) yield { t: "mesh", v };
    for (const v of this.listMerges()) yield { t: "merge", v };
    for (const r of this.db.prepare("SELECT account_id, json FROM chat_cache").all() as unknown as { account_id: string; json: string }[])
      yield { t: "chatCache", accountId: r.account_id, v: JSON.parse(this.v.dec(r.json)) };
    for (const r of this.db.prepare("SELECT account_id, kind, time FROM account_events ORDER BY id").all() as unknown as { account_id: string; kind: AccountEventKind; time: string }[])
      yield { t: "event", v: { accountId: r.account_id, kind: r.kind, time: r.time } };
    for (const r of this.db.prepare("SELECT key, value FROM settings").all() as unknown as { key: string; value: string }[]) yield { t: "setting", key: r.key, value: r.value };
    for (const v of this.listJobs()) yield { t: "job", v };
    for (const r of this.db.prepare("SELECT json FROM messages ORDER BY chat_id, time, msg_id").iterate()) yield { t: "message", v: this.row(r) };
  }
  countRecords() {
    const c = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return { account: c("SELECT COUNT(*) n FROM accounts"), alias: c("SELECT COUNT(*) n FROM aliases"), flags: c("SELECT COUNT(*) n FROM chat_flags"), folder: c("SELECT COUNT(*) n FROM folders"),
      chatFolder: c("SELECT COUNT(*) n FROM chat_folder"), mesh: c("SELECT COUNT(*) n FROM mesh_groups"), merge: c("SELECT COUNT(*) n FROM chat_merges"), message: c("SELECT COUNT(*) n FROM messages"),
      chatCache: c("SELECT COUNT(*) n FROM chat_cache"), event: c("SELECT COUNT(*) n FROM account_events"), setting: c("SELECT COUNT(*) n FROM settings"), job: c("SELECT COUNT(*) n FROM jobs") };
  }

  listJobs(status?: Job["status"]) {
    const q = status ? this.db.prepare("SELECT * FROM jobs WHERE status=? ORDER BY run_at").all(status)
                      : this.db.prepare("SELECT * FROM jobs ORDER BY run_at").all();
    return q.map(toJob);
  }
}

function toJob(r: any): Job {
  return { id: r.id, kind: r.kind, payload: JSON.parse(r.payload), runAt: r.run_at, attempts: r.attempts,
    maxAttempts: r.max_attempts, status: r.status, lastError: r.last_error ?? undefined };
}
