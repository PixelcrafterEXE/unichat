// Persistence contract. The core only knows this interface; implementations
// (SQLite today) live in their own package so hosts can swap them.
import { cardsOf, type Chat, type ChatMerge, type Folder, type Message, type MessageReceipt, type Space } from "./model.js";
import type { MeshGroup } from "./mesh.js";

export interface ChatFlags { pinned?: boolean; muted?: boolean; archived?: boolean; unreadMark?: boolean; /** starred (prioritized): its notifications go to a channel of their own (Android), or are the only ones shown (desktop setting) */ starred?: boolean; /** ISO time: everything incoming up to here was read on some device (persists a read state the provider cannot store; syncs) */ readUpTo?: string }
export interface StoredAccount { id: string; provider: string; label: string; status?: "active" | "archived" }

/** Things that happened to an account's link; they become timeline markers (possible gaps in history). */
export type AccountEventKind = "linked" | "unlinked" | "signed-out";
export interface AccountEvent { id: number; accountId: string; kind: AccountEventKind; time: string }

export interface Job {
  id: string;
  kind: string;          // handler name, e.g. "send"
  payload: unknown;      // JSON
  runAt: number;         // epoch ms
  attempts: number;
  maxAttempts: number;
  status: "pending" | "done" | "failed";
  lastError?: string;
}

/**
 * A cached profile picture row (see avatarstore.ts). Three states: a picture; `empty` = the provider has none (negative result, short lived);
 * `gone` = a tombstone (the picture was deleted; `fetchedAt` is the deletion time, no data). `rev` = the provider's opaque change hint at fetch time.
 */
export interface StoredAvatar { key: string; mime: string; data: Uint8Array; fetchedAt: number; sha: string; rev?: string; empty?: boolean; gone?: boolean }
export type AvatarState = "pic" | "none" | "gone";
/** What a listing says about an avatar (delta sync compares `sha`; `state` none/gone rows carry no data). */
export interface AvatarMeta { key: string; sha: string; fetchedAt: number; size: number; state: AvatarState; rev?: string }
export const avatarState = (a: { empty?: boolean; gone?: boolean }): AvatarState => (a.gone ? "gone" : a.empty ? "none" : "pic");
export const avatarTomb = (key: string, at = Date.now()): StoredAvatar => ({ key, mime: "", data: new Uint8Array(), fetchedAt: at, sha: "", gone: true });
/**
 * Last-writer-wins between an incoming row and ours (used by sync). A tombstone beats an older (or equal-time) picture, a newer picture beats a
 * tombstone, a different picture needs a newer fetchedAt, and "no picture" never replaces a picture (a picture, even an older one, replaces "no picture").
 */
export function avatarWins(inc: { state: AvatarState; fetchedAt: number; sha: string }, cur: StoredAvatar | undefined): boolean {
  if (!cur) return true;
  const cs = avatarState(cur);
  if (inc.state === "none") return cs !== "pic" && inc.fetchedAt > cur.fetchedAt;
  if (inc.state === "gone") return cs === "gone" ? inc.fetchedAt > cur.fetchedAt : inc.fetchedAt >= cur.fetchedAt;
  return cs === "pic" ? inc.sha !== cur.sha && inc.fetchedAt > cur.fetchedAt : cs === "none" ? true : inc.fetchedAt > cur.fetchedAt; // any real picture beats "no picture"; only a newer one beats a tombstone
}

export interface Store {
  // accounts (restored on startup so the backend works without any UI)
  listAccounts(): StoredAccount[];
  putAccount(a: StoredAccount): void;
  deleteAccount(id: string): void;
  /** Device sync: a freshly added account is not announced to other devices until it signed in once (`releaseAccount`); cancelling the sign-in then leaves no trace there. */
  holdAccount?(id: string): void;
  releaseAccount?(id: string): void;
  /** Everything we hold for an account: messages, chat cache, link events, aliases and flags of its chats. */
  deleteAccountData(accountId: string): void;
  // avatars: durable picture cache so signed-out / offline / second devices still show pictures. Keys are `kind|<global id>[|full]`.
  getAvatar(key: string): StoredAvatar | undefined;
  /** Insert or replace one avatar (the caller decides about last-writer-wins). */
  putAvatar(a: StoredAvatar): void;
  /** Every row (pictures, "none" and tombstones) as metadata, in key order, `after` = last key of the previous page. */
  listAvatars(o: { after?: string; limit: number }): AvatarMeta[];
  /**
   * Delete the avatars of one account (`accountId`) or one chat/space/contact (`id`, a global id; its thumbnail and full variants): the rows become
   * TOMBSTONES at time `at` (default now) so sync can carry the deletion. For `id` the chat thumbnail/full tombstones are written even when no row existed.
   * Returns how many rows became tombstones.
   */
  deleteAvatars(o: { accountId?: string; id?: string; at?: number }): number;
  /** Keep pictures within `maxBytes` (oldest fetchedAt first out), drop rows older than `olderThan` and tombstones older than `tombOlderThan` (ms epoch); returns how many rows were removed. */
  pruneAvatars(o: { maxBytes: number; olderThan?: number; tombOlderThan?: number }): number;
  // contact/chat aliases: the user's own names for chats
  listAliases(): Record<string, string>;
  setAlias(chatId: string, name: string | null): void;
  // per-chat user flags (pin / mute / archive)
  listChatFlags(): Record<string, ChatFlags>;
  setChatFlags(chatId: string, flags: ChatFlags): void;
  // local folders and per-chat folder overrides (chat id -> "personal" | space id | folder id)
  listFolders(): Folder[];
  putFolder(f: Folder): void;
  deleteFolder(id: string): void;
  listChatFolders(): Record<string, string>;
  setChatFolder(chatId: string, folderId: string | null): void;
  // mesh groups
  listMeshGroups(): MeshGroup[];
  putMeshGroup(g: MeshGroup): void;
  // merged chats (local-only views over several 1:1 chats)
  listMerges(): ChatMerge[];
  putMerge(m: ChatMerge): void;
  deleteMerge(id: string): void;
  // message archive (chat ids are the Hub's GLOBAL ids)
  /** Insert or merge (see mergeMessage). */
  putMessages(msgs: Message[]): void;
  patchMessage(chatId: string, messageId: string, patch: Partial<Message>): void;
  getMessage(chatId: string, messageId: string): Message | undefined;
  /** Chronological (oldest first): the newest `limit` messages strictly older than `beforeTime` (default: now). */
  listMessages(chatId: string, o: { beforeTime?: string; limit: number }): Message[];
  searchMessages(chatId: string, query: string, limit: number): Message[];
  /**
   * Stream the archive in a stable key order (chat id, message id), `after` = the last key of the previous page. Optional `accountId`
   * restricts it to one account's chats. Used by the Hub's in-memory search index and the media walker; implementations should not
   * hold more than one page in memory. Absent = the Hub falls back to exportRecords().
   */
  scanMessages?(o: { after?: { chatId: string; id: string }; limit: number; accountId?: string }): Message[];
  /** Retention: drop messages older than `iso`; returns how many. */
  deleteMessagesBefore(iso: string): number;
  // chat/space list per account, so signed-out accounts still show their chats
  putChatCache(accountId: string, v: { chats: Chat[]; spaces: Space[] }): void;
  getChatCache(accountId: string): { chats: Chat[]; spaces: Space[] } | undefined;
  // link history
  addAccountEvent(accountId: string, kind: AccountEventKind, time?: string): AccountEvent;
  listAccountEvents(accountId: string): AccountEvent[];
  // small key/value settings (e.g. retention)
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  // jobs
  putJob(j: Job): void;
  getJob(id: string): Job | undefined;
  dueJobs(now: number): Job[];
  nextRunAt(): number | undefined;
  listJobs(status?: Job["status"]): Job[];
  // backup / migration (see backup.ts): DECRYPTED rows, so an archive never depends on this install's data key
  /** Every row of the state as plain records, streamed (messages can be millions). */
  exportRecords(): Iterable<StateRecord>;
  /** Row counts per record type (cheap), for the export estimate. */
  countRecords(): Record<StateRecord["t"], number>;
  /** Run `f` (may await) atomically: when it throws, everything written to this store meanwhile is rolled back. Re-entrant; keep it short. */
  inTransaction<T>(f: () => T | Promise<T>): Promise<T>;
}

/** One row of the exported state. Chat ids are the Hub's global ids ("<account>:<native>"). */
export type StateRecord =
  | { t: "account"; v: StoredAccount }
  | { t: "alias"; chatId: string; name: string }
  | { t: "flags"; chatId: string; v: ChatFlags }
  | { t: "folder"; v: Folder }
  | { t: "chatFolder"; chatId: string; folderId: string }
  | { t: "mesh"; v: MeshGroup }
  | { t: "merge"; v: ChatMerge }
  | { t: "message"; v: Message }
  | { t: "chatCache"; accountId: string; v: { chats: Chat[]; spaces: Space[] } }
  | { t: "event"; v: { accountId: string; kind: AccountEventKind; time: string } }
  | { t: "setting"; key: string; value: string }
  | { t: "job"; v: Job };
export const STATE_RECORD_TYPES: StateRecord["t"][] = ["account", "alias", "flags", "folder", "chatFolder", "mesh", "merge", "message", "chatCache", "event", "setting", "job"];

/** The global id inside an avatar key (`kind|id[|full]`; ":" separates the account). */
export function avatarKeyId(key: string): string { const i = key.indexOf("|"); return (i < 0 ? "" : key.slice(i + 1)).replace(/\|full$/, ""); }
const avatarKeyOf = (kind: string, id: string, full = false) => `${kind}|${id}${full ? "|full" : ""}`;
export function avatarKeyMatches(key: string, o: { accountId?: string; id?: string }): boolean {
  const id = avatarKeyId(key);
  return (o.accountId !== undefined && id.startsWith(o.accountId + ":")) || (o.id !== undefined && id === o.id);
}

/** Everything searchable in a message, lower-cased: text, file names, poll, location and contact cards. */
export function messageSearchText(m: Message): string { return messageSearchRaw(m).toLowerCase(); }
/** The same text with its original case (for snippets and highlights). */
export function messageSearchRaw(m: Message): string {
  return [
    m.text, ...(m.attachments ?? []).map((a) => a.name ?? ""),
    m.poll ? [m.poll.question, ...m.poll.options.map((o) => o.text)].join(" ") : "",
    m.location ? [m.location.name, m.location.address].filter(Boolean).join(" ") : "",
    ...(m.contacts ?? []).map((c) => [c.name, ...(c.phones ?? []), ...(c.emails ?? [])].join(" ")),
    ...cardsOf(m).map((c) => [c.title, c.subtitle, c.body, c.place].filter(Boolean).join(" ")),
  ].join("\n");
}

const laterIso = (a?: string, b?: string) => (a && b ? (Date.parse(b) > Date.parse(a) ? b : a) : a ?? b);
const MAX_RECEIPTS = 5000;
/** Merge per-recipient receipts per id: a field is never dropped and a time never moves backwards (the later one wins); anyone not mentioned stays. */
export function mergeReceipts(old: MessageReceipt[] | undefined, inc: MessageReceipt[] | undefined): MessageReceipt[] | undefined {
  if (!inc?.length) return old;
  if (!old?.length) return inc.length > MAX_RECEIPTS ? inc.slice(0, MAX_RECEIPTS) : inc.map((r) => ({ ...r }));
  const by = new Map(old.map((r) => [r.id, { ...r }]));
  for (const r of inc) {
    const o = by.get(r.id);
    if (!o) { if (by.size < MAX_RECEIPTS) by.set(r.id, { ...r }); continue; }
    const delivered = laterIso(o.delivered, r.delivered), read = laterIso(o.read, r.read);
    if (delivered) o.delivered = delivered; if (read) o.read = read;
  }
  return [...by.values()];
}
/** Apply a partial update to a stored message (shared by the stores): like a spread, but receipts merge per recipient. */
export function applyPatch(old: Message, patch: Partial<Message>): Message {
  const next = { ...old, ...patch };
  const r = mergeReceipts(old.receipts, patch.receipts); if (r) next.receipts = r;
  return next;
}

const RANK: Record<string, number> = { failed: 0, sending: 1, sent: 2, delivered: 3, read: 4 };
/**
 * Merge a re-delivered message into what we already hold, so a history replay never erases newer state
 * (edits, deletions, reactions, delivery progress).
 */
export function mergeMessage(old: Message | undefined, inc: Message): Message {
  if (!old) return inc;
  const m: Message = { ...old, ...inc };
  if (old.deleted || inc.deleted) { m.reactions = []; delete m.card; delete m.cards; delete m.poll; delete m.location; delete m.contacts; if (inc.deleted && !old.deleted) delete m.attachments; }
  if (old.deleted) { m.deleted = true; m.text = old.text; m.attachments = old.attachments; }
  else if (old.editedAt && !inc.editedAt) { m.text = old.text; m.editedAt = old.editedAt; }
  if (!m.deleted && !inc.reactions && old.reactions) m.reactions = old.reactions;
  const rc = mergeReceipts(old.receipts, inc.receipts); if (rc) m.receipts = rc;
  if (old.status && inc.status && (RANK[old.status] ?? 0) > (RANK[inc.status] ?? 0)) m.status = old.status;
  return m;
}

/** In-memory store for tests / ephemeral runs. */
export class MemoryStore implements Store {
  private acc = new Map<string, StoredAccount>();
  private mesh = new Map<string, MeshGroup>();
  private jobs = new Map<string, Job>();
  private aliases: Record<string, string> = {};
  private flags: Record<string, ChatFlags> = {};
  private msgs = new Map<string, Map<string, Message>>();
  private caches = new Map<string, { chats: Chat[]; spaces: Space[] }>();
  private merges = new Map<string, ChatMerge>();
  private folders = new Map<string, Folder>();
  private chatFolders: Record<string, string> = {};
  private events: AccountEvent[] = [];
  private eventSeq = 0;
  private settings = new Map<string, string>();
  private avatars = new Map<string, StoredAvatar>();
  getAvatar(key: string) { const a = this.avatars.get(key); return a && { ...a, data: new Uint8Array(a.data) }; }
  putAvatar(a: StoredAvatar) { this.avatars.set(a.key, { ...a, data: new Uint8Array(a.data) }); }
  listAvatars(o: { after?: string; limit: number }): AvatarMeta[] {
    return [...this.avatars.values()].filter((a) => o.after === undefined || a.key > o.after).sort((x, y) => (x.key < y.key ? -1 : 1)).slice(0, o.limit)
      .map((a) => ({ key: a.key, sha: a.sha, fetchedAt: a.fetchedAt, size: a.data.length, state: avatarState(a), ...(a.rev ? { rev: a.rev } : {}) }));
  }
  deleteAvatars(o: { accountId?: string; id?: string; at?: number }) {
    const at = o.at ?? Date.now(); let n = 0;
    for (const [k, a] of [...this.avatars]) if (!a.gone && avatarKeyMatches(k, o)) { this.avatars.set(k, avatarTomb(k, at)); n++; }
    if (o.id !== undefined) for (const k of [avatarKeyOf("chat", o.id), avatarKeyOf("chat", o.id, true)]) if (!this.avatars.get(k)?.gone) { this.avatars.set(k, avatarTomb(k, at)); n++; }
    return n;
  }
  pruneAvatars(o: { maxBytes: number; olderThan?: number; tombOlderThan?: number }) {
    let n = 0, total = 0;
    for (const [k, a] of [...this.avatars]) if ((a.gone && o.tombOlderThan !== undefined && a.fetchedAt < o.tombOlderThan) || (!a.gone && o.olderThan !== undefined && a.fetchedAt < o.olderThan)) { this.avatars.delete(k); n++; }
    const real = [...this.avatars.values()].filter((a) => !a.empty && !a.gone).sort((x, y) => y.fetchedAt - x.fetchedAt);
    for (const a of real) { total += a.data.length; if (total > o.maxBytes) { this.avatars.delete(a.key); n++; } }
    return n;
  }
  listAccounts() { return [...this.acc.values()]; }
  putAccount(a: StoredAccount) { this.acc.set(a.id, a); }
  deleteAccount(id: string) { this.acc.delete(id); }
  deleteAccountData(id: string) {
    for (const k of [...this.msgs.keys()]) if (k.startsWith(id + ":")) this.msgs.delete(k);
    for (const k of Object.keys(this.aliases)) if (k.startsWith(id + ":")) delete this.aliases[k];
    for (const k of Object.keys(this.flags)) if (k.startsWith(id + ":")) delete this.flags[k];
    for (const k of Object.keys(this.chatFolders)) if (k.startsWith(id + ":")) delete this.chatFolders[k];
    this.caches.delete(id); this.events = this.events.filter((e) => e.accountId !== id); this.deleteAvatars({ accountId: id }); // tombstones: sync tells the other devices
  }
  listAliases() { return { ...this.aliases }; }
  setAlias(chatId: string, name: string | null) { if (name) this.aliases[chatId] = name; else delete this.aliases[chatId]; }
  listChatFlags() { return { ...this.flags }; }
  setChatFlags(chatId: string, f: ChatFlags) { if (f.pinned || f.muted || f.archived || f.unreadMark || f.starred || f.readUpTo) this.flags[chatId] = f; else delete this.flags[chatId]; }
  listFolders() { return [...this.folders.values()].map((f) => ({ ...f })); }
  putFolder(f: Folder) { this.folders.set(f.id, { ...f }); }
  deleteFolder(id: string) { this.folders.delete(id); }
  listChatFolders() { return { ...this.chatFolders }; }
  setChatFolder(chatId: string, folderId: string | null) { if (folderId) this.chatFolders[chatId] = folderId; else delete this.chatFolders[chatId]; }
  listMeshGroups() { return [...this.mesh.values()]; }
  putMeshGroup(g: MeshGroup) { this.mesh.set(g.id, g); }
  listMerges() { return [...this.merges.values()].map((m) => ({ ...m, members: [...m.members] })); }
  putMerge(m: ChatMerge) { this.merges.set(m.id, { ...m, members: [...m.members] }); }
  deleteMerge(id: string) { this.merges.delete(id); }
  putMessages(ms: Message[]) { for (const m of ms) { const c = this.msgs.get(m.chatId) ?? new Map(); c.set(m.id, mergeMessage(c.get(m.id), m)); this.msgs.set(m.chatId, c); } }
  patchMessage(chatId: string, id: string, patch: Partial<Message>) { const c = this.msgs.get(chatId); const o = c?.get(id); if (c && o) c.set(id, applyPatch(o, patch)); }
  getMessage(chatId: string, id: string) { return this.msgs.get(chatId)?.get(id); }
  listMessages(chatId: string, o: { beforeTime?: string; limit: number }) {
    const all = [...(this.msgs.get(chatId)?.values() ?? [])].filter((m) => !o.beforeTime || m.time < o.beforeTime)
      .sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
    return all.slice(Math.max(0, all.length - o.limit));
  }
  searchMessages(chatId: string, q: string, limit: number) {
    const n = q.toLowerCase();
    return this.listMessages(chatId, { limit: 1e9 }).filter((m) => !m.deleted && messageSearchText(m).includes(n)).slice(-limit);
  }
  scanMessages(o: { after?: { chatId: string; id: string }; limit: number; accountId?: string }) {
    const pre = o.accountId ? o.accountId + ":" : "", out: Message[] = [];
    const keys = [...this.msgs.keys()].filter((k) => k.startsWith(pre)).sort();
    for (const k of keys) {
      if (o.after && k < o.after.chatId) continue;
      const ids = [...this.msgs.get(k)!.keys()].sort();
      for (const id of ids) { if (o.after && k === o.after.chatId && id <= o.after.id) continue; out.push(this.msgs.get(k)!.get(id)!); if (out.length >= o.limit) return out; }
    }
    return out;
  }
  deleteMessagesBefore(iso: string) { let n = 0; for (const c of this.msgs.values()) for (const [id, m] of c) if (m.time < iso) { c.delete(id); n++; } return n; }
  putChatCache(id: string, v: { chats: Chat[]; spaces: Space[] }) { this.caches.set(id, v); }
  getChatCache(id: string) { return this.caches.get(id); }
  addAccountEvent(accountId: string, kind: AccountEventKind, time = new Date().toISOString()) { const e = { id: ++this.eventSeq, accountId, kind, time }; this.events.push(e); return e; }
  listAccountEvents(accountId: string) { return this.events.filter((e) => e.accountId === accountId); }
  getSetting(k: string) { return this.settings.get(k); }
  setSetting(k: string, v: string) { this.settings.set(k, v); }
  putJob(j: Job) { this.jobs.set(j.id, { ...j }); }
  getJob(id: string) { return this.jobs.get(id); }
  dueJobs(now: number) { return [...this.jobs.values()].filter((j) => j.status === "pending" && j.runAt <= now).sort((a, b) => a.runAt - b.runAt); }
  nextRunAt() { const p = [...this.jobs.values()].filter((j) => j.status === "pending"); return p.length ? Math.min(...p.map((j) => j.runAt)) : undefined; }
  listJobs(status?: Job["status"]) { return [...this.jobs.values()].filter((j) => !status || j.status === status); }
  *exportRecords(): Generator<StateRecord> {
    for (const v of this.acc.values()) yield { t: "account", v: { ...v } };
    for (const [chatId, name] of Object.entries(this.aliases)) yield { t: "alias", chatId, name };
    for (const [chatId, v] of Object.entries(this.flags)) yield { t: "flags", chatId, v: { ...v } };
    for (const v of this.folders.values()) yield { t: "folder", v: { ...v } };
    for (const [chatId, folderId] of Object.entries(this.chatFolders)) yield { t: "chatFolder", chatId, folderId };
    for (const v of this.mesh.values()) yield { t: "mesh", v: structuredClone(v) };
    for (const v of this.merges.values()) yield { t: "merge", v: { ...v, members: [...v.members] } };
    for (const [accountId, v] of this.caches) yield { t: "chatCache", accountId, v: structuredClone(v) };
    for (const e of this.events) yield { t: "event", v: { accountId: e.accountId, kind: e.kind, time: e.time } };
    for (const [key, value] of this.settings) yield { t: "setting", key, value };
    for (const v of this.jobs.values()) yield { t: "job", v: structuredClone(v) };
    for (const c of this.msgs.values()) for (const v of c.values()) yield { t: "message", v: structuredClone(v) };
  }
  countRecords() {
    const n = (o: object) => Object.keys(o).length;
    let messages = 0; for (const c of this.msgs.values()) messages += c.size;
    return { account: this.acc.size, alias: n(this.aliases), flags: n(this.flags), folder: this.folders.size, chatFolder: n(this.chatFolders), mesh: this.mesh.size,
      merge: this.merges.size, message: messages, chatCache: this.caches.size, event: this.events.length, setting: this.settings.size, job: this.jobs.size };
  }
  /** Snapshot-and-restore transaction (fine for tests / ephemeral runs). */
  async inTransaction<T>(f: () => T | Promise<T>): Promise<T> {
    if (this.txDepth++) { try { return await f(); } finally { this.txDepth--; } }
    const snap = { acc: new Map(this.acc), mesh: new Map(this.mesh), jobs: new Map(this.jobs), aliases: { ...this.aliases }, flags: { ...this.flags },
      msgs: new Map([...this.msgs].map(([k, v]) => [k, new Map(v)])), caches: new Map(this.caches), merges: new Map(this.merges), folders: new Map(this.folders),
      chatFolders: { ...this.chatFolders }, events: [...this.events], eventSeq: this.eventSeq, settings: new Map(this.settings) };
    try { return await f(); }
    catch (e) { Object.assign(this, snap); throw e; }
    finally { this.txDepth--; }
  }
  private txDepth = 0;
}
