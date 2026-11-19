// Application layer: accounts, id namespacing, routing, mesh. Transport-agnostic:
// Electron IPC, the Android bridge and the web WebSocket server all call hub.call().
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { isFolderId, isMergeId, PERSONAL, type Account, type AccountVia, type Chat, type ChatMerge, type Folder, type Message, type Space } from "./model.js";
import { applyFolders } from "./folders.js";
import type { Connector, CoreEvent, OutgoingMention, OutgoingMessage, Profile, ProfilePatch, ProviderFactory } from "./provider.js";
import { MeshRelay } from "./mesh.js";
import { JobAbort, JobWaiting, Scheduler } from "./scheduler.js";
import { avatarKeyId, MemoryStore, type Store } from "./store.js";
import { AVATAR_MAX_BYTES, AVATAR_NEGATIVE_MS, AVATAR_OPEN_WINDOW_MS, AVATAR_TTL_HINTED_MS, AVATAR_TTL_MS, AVATAR_TTL_OPEN_MS, avatarKey, avatarSha, emptyAvatar, makeAvatar, pruneAvatarStore } from "./avatarstore.js";
import { MediaCache } from "./media.js";
import { BackupService, type BackupPolicy } from "./backup.js";
import { applyHistoryMedia, applyHistoryRows, historyEstimate, historyPieces, removeHistory, type HistoryEstimate, type HistoryPiece, type HistoryRow } from "./history.js";
import { SignalImportService, withImportedChats } from "./signalimport/index.js";
import { WhatsAppImportService, withWhatsAppImportedChats } from "./whatsappimport/index.js";
import { type SearchIndex, type SearchOptions } from "./search.js";
import { createSearchIndex } from "./search-fts.js";
import { withSearchIndex } from "./search-store.js";
import { HubExtras, type ExtrasOptions } from "./hub-extras.js";
import { RailGroups } from "./railgroups.js";
import { stripPlaceholder } from "./placeholder.js";
import { Categories, applyCategories, type CategoryWorld } from "./categories.js";
import { Updater, type UpdaterOptions } from "./updater.js";

/** What the device-sync service offers the Hub (see attachSync). `fetchMedia`: ask paired devices for an attachment this device lacks; `hubReady`: called at the end of init(). */
export interface SyncHandler { handles(m: string): boolean; call(m: string, p?: any): Promise<unknown>; dispose?(): Promise<void> | void; fetchMedia?(accountId: string, chatId: string, messageId: string, attachmentId: string): Promise<{ data: Uint8Array; mime: string; name?: string } | undefined>; hubReady?(): Promise<void> | void }
/** Callbacks the Hub hands to the sync service. `adopt`/`release` let sync attach a connector that is NOT created by a provider factory (proxy accounts, packages/provider-remote). */
export interface SyncHostApi {
  emit(event: string, data: unknown): void; /** pick up what sync wrote; `search: false` keeps the search index (sync keeps it current through indexMessage: a full rebuild per batch of a big backlog pegged the CPU) */ reload(o?: { search?: boolean }): Promise<void>; /** a message written by replication: keep the search index current */ indexMessage?(m: Message): void; call(method: string, p?: any): Promise<unknown>; accountsDir: string;
  subscribe(l: (event: string, data: unknown) => void): () => void;
  /** the connector of an account that is signed in and usable (undefined for archives / needs-login) */
  connector(accountId: string): Connector | undefined;
  /** does the account have ANY connector here (own login or proxy)? Then its chat list is authoritative on this device */
  isLive(accountId: string): boolean;
  accountInfo(accountId: string): Account | undefined;
  adopt(accountId: string, conn: Connector): Promise<void>;
  /** device sync: say which other device this account is used through (or clear it); shown next to the account state */
  annotate(accountId: string, via: AccountVia | undefined): void;
  release(accountId: string): Promise<void>;
  media: { get(accountId: string, key: string): { data: Uint8Array; mime: string; name?: string } | undefined; put(accountId: string, key: string, v: { data: Uint8Array; mime: string; name?: string }): void; has(accountId: string, key: string): boolean };
  provider(name: string): Pick<ProviderFactory, "exportSession" | "importSession" | "name" | "displayName" | "capabilities"> | undefined;
  /** Device-to-device move, source side: the account's session as portable files (does not change anything). */
  moveCollect(accountId: string): Promise<{ provider: string; label: string; files: { rel: string; data: Buffer }[] }>;
  /** Device-to-device move, target side: install the files, start the account. All or nothing: on any failure the previous state is restored and this throws. */
  moveInstall(accountId: string, provider: string, label: string, files: { rel: string; data: Uint8Array }[], o?: { settleMs?: number }): Promise<void>;
  /** The account's archive (see history.ts): estimate, stream, apply (merge), and remove locally. */
  history: { ensureAccount(acct: string, provider: string, label: string): void; estimate(acct: string, media: boolean): HistoryEstimate; pieces(acct: string, media: boolean): AsyncGenerator<HistoryPiece>; applyRows(acct: string, rows: HistoryRow[]): Promise<number>; applyMedia(acct: string, p: { chatId: string; messageId: string; attId: string; mime: string; name?: string; data: Buffer }): void; remove(acct: string): void };
}
/** `conn` is absent while an account is signed out: its chats are then a read-only archive. */
interface Acc { info: Account; conn?: Connector }
interface ScheduledSend { chatId: string; text: string; clientId?: string; due?: number }
export interface HubOptions { /** global search index bounds (see search.ts) */ search?: SearchOptions; /** pacing of "mark all read" / "download all media" (tests use 0) */ extras?: ExtrasOptions; /** 32-byte key for the on-disk media cache (the SQLite store gets its own key from the host). */ dataKey?: Uint8Array; /** backup / migration: where file paths are accepted (default: only inside "<accounts dir>/.backup") */ backup?: BackupPolicy; appVersion?: string; /** self-update (updater.ts): platform asset key, installer, test hooks; the data dir, version and event sink are the Hub's */ update?: Partial<Omit<UpdaterOptions, "dataDir" | "emit">>; /** a scheduled message that is more than this late is not sent any more (default: setting `scheduleLateHours`, 24 h) */ scheduleLateMs?: number }
/** Some provider calls wait for a server echo (e.g. Matrix account data over sync): never let the UI hang on them. */
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((ok, fail) => { const t = setTimeout(() => fail(new Error(`${what} didn't confirm in time. Check your connection and try again.`)), ms); p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); fail(e); }); });
const fmtDate = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
type Listener = (event: string, data: unknown) => void;
/** What a deleted message no longer carries. */
const DELETED_STRIPS = ["attachments", "card", "cards", "poll", "location", "contacts"] as const;
/** Optional attachment hints from the UI (measured size, GIF flag, caption): only sane values reach the providers. */
const outgoingHints = (a: any) => ({
  ...(Number.isFinite(a.width) && a.width > 0 && a.width < 1e5 ? { width: Math.round(a.width) } : {}), ...(Number.isFinite(a.height) && a.height > 0 && a.height < 1e5 ? { height: Math.round(a.height) } : {}),
  ...(a.gif === true ? { gif: true } : {}), ...(typeof a.caption === "string" && a.caption ? { caption: a.caption.slice(0, 4096) } : {}),
});
/** Mentions from the UI are untrusted input: keep only well-formed, non-overlapping spans that lie inside the text. */
export function sanitizeMentions(text: string, raw: unknown): OutgoingMention[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: OutgoingMention[] = [];
  for (const m of raw.slice(0, 50)) {
    if (!m || typeof m.id !== "string" || !m.id || typeof m.name !== "string" || !Number.isInteger(m.start) || !Number.isInteger(m.length)) continue;
    if (m.start < 0 || m.length <= 0 || m.start + m.length > text.length) continue;
    if (out.some((o) => m.start < o.start + o.length && o.start < m.start + m.length)) continue;
    out.push({ id: m.id, name: m.name, start: m.start, length: m.length });
  }
  return out.length ? out.sort((a, b) => a.start - b.start) : undefined;
}

export class Hub {
  private accounts = new Map<string, Acc>();
  private listeners = new Set<Listener>();
  private factories = new Map<string, ProviderFactory>();
  readonly mesh: MeshRelay;
  readonly scheduler: Scheduler;
  private verifs = new Map<string, unknown>(); // open verifications by `${accountId}|${id}`, so a UI that connects later still sees them
  private prompts = new Map<string, unknown>(); // latest login prompt per account, so a UI that connects later still sees it
  private avatarCache = new Map<string, { at: number; v: { dataBase64: string; mime: string } | null }>();
  /** keys whose picture the provider says changed: refreshed on next use even when the stored one is young */
  private avatarStale = new Set<string>(); private avatarHints = new Map<string, string>(); private avatarWrites = 0;
  /** account -> time: every stored picture of that account fetched before it is stale (an own-picture change whose old picture we cannot identify) */
  private avatarStaleBefore = new Map<string, number>(); private recentChats = new Map<string, number>();
  /** warm-up job state (see warmAvatars) */
  private avatarWarmPaused = false; private avatarWarmRunning = false; private avatarWarmT?: ReturnType<typeof setTimeout>; private avatarWarmTimer?: ReturnType<typeof setInterval>;
  private avatarFetches = 0; private avatarLastFailed = false; private closing = false;
  /** pause between two provider requests of the warm-up, and how long it waits after a connect / start (tests shorten both) */
  avatarWarmGapMs = 400; avatarWarmDelayMs = 30_000;
  private avatarActive = 0; private avatarQueue: (() => void)[] = [];
  private seenMsgs = new Set<string>(); // bounded dedupe of delivered message ids
  private aliasCache = new Map<string, string>(); // "<account>:<native id>" -> the user's own name for that person/chat
  private cacheSig = new Map<string, string>(); // last chat-list snapshot written per account (skip identical writes)
  private media: MediaCache;
  private searchIndex!: SearchIndex;
  private extras!: HubExtras;
  readonly backup: BackupService;
  readonly updater: Updater; // "is there a newer release" + download / verify / install (updater.ts)
  private whatsappImport!: WhatsAppImportService; // WhatsApp backup history import (whatsappimport/)
  private signalImport!: SignalImportService; // Signal backup history import (signalimport/)
  // --- device sync hook (packages/sync): set via attachSync, routes the sync* RPCs ---
  private sync?: SyncHandler;
  private purgeTimer?: ReturnType<typeof setInterval>;
  private merges = new Map<string, ChatMerge>();   // merged chats (local-only views over several 1:1 chats), id "merge:<uuid>"
  private dismissedMerges = new Set<string>();
  private mergeOf = new Map<string, string>();     // member chat id -> merge id
  private categories = new Categories(() => this.store, (e, d) => this.emit(e, d), async (): Promise<CategoryWorld> => { const s = await this.snapshot(); return { spaces: s.spaces.map((x) => x.id), chats: s.chats }; }); // user categories inside a view (categories.ts)
  private railGroups = new RailGroups(() => this.store, (e, d) => this.emit(e, d), async () => (await this.snapshot()).spaces.map((s) => s.id)); // local rail groups (railgroups.ts)
  private provisional = new Map<string, Chat>();   // startChat results that exist only here until the first send() creates the real chat (global ids)

  constructor(private dataDir: string, factories: ProviderFactory[], private store: Store = new MemoryStore(), opts: HubOptions = {}) {
    for (const f of factories) this.factories.set(f.name, f);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.media = new MediaCache(join(dataDir, "media"), opts.dataKey);
    // global search: an in-memory index kept current from every write that goes through this.store (see search.ts)
    this.searchIndex = createSearchIndex(store, opts.search);
    this.store = withSearchIndex(store, this.searchIndex);
    this.extras = new HubExtras({
      store: this.store, media: this.media, index: this.searchIndex, snapshot: () => this.snapshot(), emit: (e, d) => this.emit(e, d),
      account: (id) => { try { const [a, native] = this.resolve(id); const live = !!a.conn && !this.offlineKind(a); return { accountId: a.info.id, native, provider: a.info.provider, conn: live ? a.conn : undefined, caps: a.info.capabilities ?? this.factories.get(a.info.provider)?.capabilities }; } catch { return undefined; } },
      liveConn: (id) => { const a = this.accounts.get(id); return a && a.conn && !this.offlineKind(a) ? a.conn : undefined; },
      provisional: (id) => this.provisional.has(id), merge: (id) => this.merges.get(id), noteRead: (id) => this.noteRead(id),
    }, opts.extras);
    this.backup = new BackupService({ store, media: this.media, accountsDir: dataDir, dataKey: opts.dataKey, policy: opts.backup ?? { paths: "dir" }, appVersion: opts.appVersion,
      emit: (e, d) => this.emit(e, d), call: (m, p) => this.call(m, p), reload: () => this.reloadFromStore(), moveAway: (id) => this.moveAwayAccount(id), provider: (n) => this.factories.get(n) });
    this.signalImport = new SignalImportService({ store, media: this.media, emit: (e, d) => this.emit(e, d), source: (p) => this.backup.source(p), reload: () => this.reloadFromStore(),
      accounts: () => [...this.accounts.values()].map((a) => ({ id: a.info.id, provider: a.info.provider, label: a.info.label, identity: () => (a.conn && !this.offlineKind(a) ? a.conn.importIdentity?.() : undefined),
        importContacts: (l) => (a.conn && !this.offlineKind(a) ? a.conn.importContacts?.(l) ?? 0 : 0) })) });
    this.whatsappImport = new WhatsAppImportService({ store, media: this.media, emit: (e, d) => this.emit(e, d), source: (p) => this.backup.source(p), tempDir: () => this.backup.managedDir(), reload: () => this.reloadFromStore(),
      accounts: () => [...this.accounts.values()].map((a) => ({ id: a.info.id, provider: a.info.provider, label: a.info.label, maps: () => (a.conn && !this.offlineKind(a) ? a.conn.importMaps?.() : undefined) })) });
    this.updater = new Updater({ version: opts.appVersion ?? "dev", dataKey: opts.dataKey, ...opts.update, dataDir, emit: (e, d) => this.emit(e, d) });
    this.loadMerges();
    this.scheduler = new Scheduler(store, (j) => this.emit("job", j));
    this.lateMs = opts.scheduleLateMs;
    this.scheduler.register("send", (p: ScheduledSend) => this.runScheduledSend(p));
    this.mesh = new MeshRelay(
      (chatId, text) => this.scheduler.enqueue({ kind: "send", payload: { chatId, text } }),
      (m) => { this.store.putMessages([m]); this.activity.delete(m.chatId); this.emit("message", m); },
      (g) => store.putMeshGroup(g));
  }

  /** Bring the backend up WITHOUT any UI: restore accounts + mesh groups, resume jobs. */
  async init(o: { background?: boolean } = {}) {
    const pl = (stage: string, data?: Record<string, unknown>) => (globalThis as any).__unimsgPlog?.("hub." + stage, data); // Android stage log (no-op elsewhere)
    let t = Date.now(); const lap = (stage: string, data?: Record<string, unknown>) => { pl(stage, { ms: Date.now() - t, ...(data ?? {}) }); t = Date.now(); };
    this.mesh.load(this.store.listMeshGroups());
    this.loadMerges();
    this.reloadAliases();
    lap("init.load");
    for (const a of this.store.listAccounts()) {
      try {
        if (a.status === "archived") this.accounts.set(a.id, { info: this.infoFor(a.id, a.provider, a.label, "signed-out") }); // read-only archive, no connector
        else { await this.startAccount(a.id, a.provider, a.label); lap("init.startAccount", { provider: a.provider, id: a.id.slice(0, 12) }); }
      } catch (e) { console.error(`account ${a.id} failed to start:`, e); }
    }
    lap("init.accounts");
    void this.searchIndex.rebuild().then(() => pl("search.index.done", { size: this.searchIndex.size }));
    void this.cleanPlaceholdersOnce().then(() => pl("cleanPlaceholders.done"));
    if (o.background) { const t = setTimeout(() => { try { this.purge(); } catch (e) { console.error("purge failed:", (e as Error)?.message); } pl("purge.done"); }, 45_000); t.unref?.(); } // retention purge scans the whole archive: not while the first chat list is being served
    else this.purge();
    lap("init.purge");
    this.purgeTimer = setInterval(() => this.purge(), 6 * 3600_000); this.purgeTimer.unref?.();
    this.avatarWarmTimer = setInterval(() => this.scheduleWarm(1000), 6 * 3600_000); this.avatarWarmTimer.unref?.(); this.scheduleWarm();
    this.scheduler.start();
    lap("init.timers");
    await this.sync?.hubReady?.(); // device sync hook: proxy accounts attach here
    lap("init.sync.hubReady");
  }
  /**
   * Imported/restored messages once carried "[Photo]" / "[File: name]" stand-in text even when the real attachment was stored.
   * Scan one account's archive (or all) and clear that text through patchMessage, so device sync carries the fix. Idempotent.
   */
  async cleanPlaceholders(p: { accountId?: string } = {}): Promise<{ scanned: number; cleaned: number }> {
    const scan = this.store.scanMessages?.bind(this.store); let scanned = 0, cleaned = 0;
    if (!scan) return { scanned, cleaned };
    let after: { chatId: string; id: string } | undefined;
    for (;;) {
      const page = scan({ ...(after ? { after } : {}), limit: 500, ...(p.accountId ? { accountId: p.accountId } : {}) });
      if (!page.length) break;
      for (const m of page) {
        scanned++;
        if (m.deleted || !m.text || !(m.attachments?.length || m.card || m.cards?.length)) continue;
        const t = stripPlaceholder(m.text);
        if (t !== m.text) { try { this.store.patchMessage(m.chatId, m.id, { text: t }); cleaned++; } catch { /* best effort */ } }
      }
      const last = page[page.length - 1]!; after = { chatId: last.chatId, id: last.id };
      if (page.length < 500) break;
      await new Promise((r) => setImmediate(r)); // yield between pages
    }
    return { scanned, cleaned };
  }
  /** Once per account (flag in the store's settings): clean the stand-in texts of its imported history. */
  private async cleanPlaceholdersOnce() {
    try {
      for (const a of this.store.listAccounts()) {
        const key = `placeholders-clean-v1:${a.id}`; if (this.store.getSetting(key)) continue;
        await this.cleanPlaceholders({ accountId: a.id }); this.store.setSetting(key, "1");
      }
    } catch (e) { console.error("placeholder cleanup failed:", e); }
  }
  async shutdown() {
    this.backup.dispose(); this.updater.dispose();
    await this.sync?.dispose?.(); // device sync hook
    this.scheduler.stop();
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.closing = true; clearInterval(this.avatarWarmTimer); clearTimeout(this.avatarWarmT);
    await Promise.allSettled([...this.accounts.values()].map((a) => a.conn?.stop()));
  }

  /** After a backup import: pick up what the import wrote (new archived accounts, merges, aliases, mesh groups). */
  /** device sync hook: `make` receives the host callbacks and returns the handler for the sync* RPCs. */
  attachSync<T extends SyncHandler>(make: (h: SyncHostApi) => T): T {
    return (this.sync = make({
      emit: (e, d) => this.emit(e, d), reload: (o) => this.reloadFromStore(o), indexMessage: (m) => { this.activity.delete(m.chatId); try { this.searchIndex.upsert(m); } catch { /* index is best effort */ } }, call: (m, p) => this.call(m, p), accountsDir: this.dataDir, subscribe: (l) => this.subscribe(l),
      connector: (id) => { const a = this.accounts.get(id); return a && a.conn && !this.offlineKind(a) ? a.conn : undefined; },
      isLive: (id) => !!this.accounts.get(id)?.conn, accountInfo: (id) => this.accounts.get(id)?.info,
      adopt: (id, conn) => this.adoptConnector(id, conn), annotate: (id, via) => this.annotateAccount(id, via), release: (id) => this.releaseConnector(id),
      media: { get: (a, k) => this.media.get(a, k), put: (a, k, v) => this.media.put(a, k, v), has: (a, k) => this.media.has(a, k) },
      provider: (n) => this.factories.get(n),
      history: { ensureAccount: (a, p, l) => { if (!this.store.listAccounts().some((x) => x.id === a)) { this.store.putAccount({ id: a, provider: p, label: l, status: "archived" }); void this.reloadFromStore(); } }, estimate: (a, m) => historyEstimate({ store: this.store, media: this.media }, a, m), pieces: (a, m) => historyPieces({ store: this.store, media: this.media }, a, m), applyRows: (a, r) => applyHistoryRows({ store: this.store, media: this.media }, a, r), applyMedia: (a, p) => applyHistoryMedia({ store: this.store, media: this.media }, a, p), remove: (a) => { removeHistory({ store: this.store, media: this.media }, a); this.cacheSig.delete(a); this.emit("chats-changed", { accountId: a }); } },
      moveCollect: (id) => this.backup.collectSession(id), moveInstall: (id, p, l, f, o) => this.moveInstall(id, p, l, f, o),
    }));
  }
  /** Device sync "proxy account": attach a connector that forwards to another device. The account must exist here (as an archive) and must not be linked locally. */
  private async adoptConnector(id: string, conn: Connector) {
    const [a] = this.resolveAccount(id);
    if (a.conn) throw new Error(`${a.info.label} is linked on this device already.`);
    a.conn = conn; a.info.state = "connecting"; this.refreshCaps(a);
    try { await conn.start((e) => this.onEvent(id, e)); } catch (e) { a.conn = undefined; a.info.state = "signed-out"; this.refreshCaps(a); throw e; }
    this.refreshCaps(a); this.emit("account", { id, state: a.info.state, ...(a.info.capabilities ? { capabilities: a.info.capabilities } : {}) }); this.emit("chats-changed", { accountId: id });
  }
  private annotateAccount(id: string, via: AccountVia | undefined) {
    const a = this.accounts.get(id); if (!a || JSON.stringify(a.info.via ?? null) === JSON.stringify(via ?? null)) return;
    if (via) a.info.via = via; else delete a.info.via;
    this.emit("account", { id, state: a.info.state, via: via ?? null });
  }
  private async releaseConnector(id: string) {
    const a = this.accounts.get(id); if (!a?.conn) return;
    await a.conn.stop().catch(() => {}); a.conn = undefined; a.info.state = "signed-out"; this.refreshCaps(a);
    this.emit("account", { id, state: "signed-out" }); this.emit("chats-changed", { accountId: id });
  }
  async reloadFromStore(o: { search?: boolean } = {}) {
    for (const a of this.store.listAccounts()) if (!this.accounts.has(a.id)) this.accounts.set(a.id, { info: this.infoFor(a.id, a.provider, a.label, "signed-out") });
    this.mesh.load(this.store.listMeshGroups()); this.loadMerges(); this.reloadAliases(); this.cacheSig.clear(); if (o.search !== false) { this.activity.clear(); void this.searchIndex.rebuild(); }
    this.changed(); this.emit("accounts-changed", {});
  }
  /** One-account transfer: stop WITHOUT remote logout (the session now lives elsewhere), wipe local session material, keep the archive. */
  private async moveAwayAccount(id: string) {
    const [a] = this.resolveAccount(id);
    if (a.conn) { await a.conn.stop().catch(() => {}); a.conn = undefined; }
    a.info.state = "signed-out"; this.refreshCaps(a); this.prompts.delete(id);
    this.store.putAccount({ id, provider: a.info.provider, label: a.info.label, status: "archived" });
    this.logEvent(a, "signed-out");
    let wipeErr: Error | undefined; try { rmSync(join(this.dataDir, id), { recursive: true, force: true }); } catch (e) { wipeErr = e as Error; }
    if (!wipeErr && existsSync(join(this.dataDir, id))) wipeErr = new Error("files remain");
    this.emit("account", { id, state: "signed-out" });
    // the session must not stay on this device once it was handed over: say so instead of pretending the move is complete
    if (wipeErr) throw new Error(`The login was stopped here, but its session files could not be deleted (${wipeErr.message}). Delete the folder of this account by hand before using the other device.`);
  }
  /**
   * Target half of a device-to-device move: put the session files in place, re-seal them for this install, start the account.
   * Atomic: if anything fails (bad files, the connector does not start, the login is refused) the account is back to what it was before.
   */
  private async moveInstall(id: string, provider: string, label: string, files: { rel: string; data: Uint8Array }[], o: { settleMs?: number } = {}) {
    const f = this.factories.get(provider);
    if (!f) throw new Error(`This device cannot run ${provider} accounts.`);
    if (this.accounts.get(id)?.conn) throw new Error(`${label} is already signed in on this device.`);
    const dir = join(this.dataDir, id), aside = join(this.dataDir, `.move-old-${randomUUID().slice(0, 8)}`), prev = this.store.listAccounts().find((a) => a.id === id);
    const hadDir = existsSync(dir);
    if (hadDir) renameSync(dir, aside);
    const undo = async () => {
      const a = this.accounts.get(id); if (a?.conn) { await a.conn.stop().catch(() => {}); a.conn = undefined; }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      if (hadDir) { try { renameSync(aside, dir); } catch { /* best effort */ } }
      if (prev) this.store.putAccount(prev); else { this.store.deleteAccount(id); this.accounts.delete(id); }
      if (a && prev) { a.info.state = "signed-out"; this.refreshCaps(a); }
      this.emit("account", { id, state: "signed-out" }); this.emit("accounts-changed", {});
    };
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const x of files) {
        if (!x.rel || isAbsolute(x.rel) || x.rel.split(/[\\/]/).some((p) => p === ".." || p === "") || x.rel.includes("\0")) throw new Error("The session contains an unsafe file name.");
        const dst = join(dir, x.rel); mkdirSync(dirname(dst), { recursive: true, mode: 0o700 }); writeFileSync(dst, x.data, { mode: 0o600 });
      }
      await f.importSession?.(dir);
      if (!prev) this.store.putAccount({ id, provider, label, status: "archived" });
      await this.reloadFromStore();
      await this.signIn(id);
      const t0 = Date.now(), lim = o.settleMs ?? 6000;
      while (this.accounts.get(id)?.info.state === "connecting" && Date.now() - t0 < lim) await new Promise((r) => setTimeout(r, 25));
      const st = this.accounts.get(id)?.info.state;
      if (!this.accounts.get(id)?.conn || st === "needs-login") throw new Error(`${label} did not accept the login on this device.`);
    } catch (e) { await undo(); throw e; }
    if (hadDir) try { rmSync(aside, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  private reloadAliases() { this.aliasCache = new Map(Object.entries(this.store.listAliases())); }
  /** A name the user gave a person (via their 1:1 chat) also applies wherever that person shows up, e.g. as a group sender. */
  private named(accountId: string, m: Message): Message {
    if (m.fromMe) return m;
    const a = this.aliasCache.get(`${accountId}:${m.senderId}`);
    if (a) return a !== m.sender ? { ...m, sender: a } : m;
    let cur: string | undefined; try { cur = this.accounts.get(accountId)?.conn?.currentNameOf?.(m.senderId); } catch { /* best effort */ }
    return cur && cur !== m.sender ? { ...m, sender: cur } : m;
  }
  /** Retention: the user can limit how long history is kept (0 / unset = forever). */
  private purge() {
    const days = Number(this.store.getSetting("retentionDays") ?? 0);
    if (!(days > 0)) return;
    const cutoff = Date.now() - days * 864e5;
    this.store.deleteMessagesBefore(new Date(cutoff).toISOString());
    this.media.purgeOlderThan(cutoff);
  }

  /** Effective capabilities are read LIVE from the connector (they may differ per instance); archived accounts have none (the UI falls back to the provider's). */
  private refreshCaps(a: Acc): Account {
    let caps: Account["capabilities"];
    try { caps = a.conn?.capabilities; } catch { caps = undefined; }
    if (caps) a.info.capabilities = caps; else delete a.info.capabilities;
    return a.info;
  }
  private accountList(): Account[] { return [...this.accounts.values()].map((a) => this.refreshCaps(a)); }
  /** Build the public Account record, including what we know about its link history. */
  private infoFor(id: string, provider: string, label: string, state: Account["state"]): Account {
    const ev = this.store.listAccountEvents(id), last = ev.at(-1);
    return { id, provider, label, state, everLinked: ev.length > 0,
      ...(last?.kind === "linked" ? { linkedAt: last.time } : {}), ...(last && last.kind !== "linked" ? { signedOutAt: last.time } : {}) };
  }
  private logEvent(a: Acc, kind: "linked" | "unlinked" | "signed-out") {
    const e = this.store.addAccountEvent(a.info.id, kind);
    a.info.everLinked = true;
    if (kind === "linked") { a.info.linkedAt = e.time; delete a.info.signedOutAt; } else { a.info.signedOutAt = e.time; delete a.info.linkedAt; }
    this.emit("chats-changed", { accountId: a.info.id });
  }
  /** Friendly guard: writes need a live connection. */
  private need(a: Acc): Connector {
    if (!a.conn || (a.info.state === "needs-login" && a.info.everLinked))
      throw new Error(`${a.info.label} is signed out, so this chat is read-only. Sign in again from Settings to continue.`);
    return a.conn;
  }
  private offlineKind(a: Acc): "signed-out" | "needs-login" | undefined {
    return !a.conn ? "signed-out" : a.info.state === "needs-login" && a.info.everLinked ? "needs-login" : undefined;
  }

  subscribe(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit(event: string, data: unknown) {
    this.snapGen++;
    if (event === "avatars-changed") for (const k of (data as { keys?: string[] })?.keys ?? []) this.avatarCache.delete(k); // sync delivered / a refresh replaced pictures: forget memory misses
    this.listeners.forEach((l) => l(event, data));
    if (event === "account" && (data as any)?.state === "connected") this.scheduler?.wake(); // e.g. the device that holds the account came back: waiting scheduled messages go now
  }
  /** Emit a chat-scoped event; when the chat is part of a merge the event also carries `mergeId` (chatId stays the real chat). */
  private emitC(event: string, data: { chatId: string; messageId?: string; patch?: unknown }) { const mergeId = this.mergeOf.get(data.chatId); this.emit(event, mergeId ? { ...data, mergeId } : data); }

  /** Single RPC entry point used by every host. */
  async call(method: string, p: any = {}): Promise<unknown> {
    if (p && typeof p.chatId === "string" && isMergeId(p.chatId)) p = this.redirectMerged(method, p);
    if (BackupService.methods.has(method)) return this.backup.call(method, p);
    if (SignalImportService.methods.has(method)) return this.signalImport.call(method, p);
    if (WhatsAppImportService.methods.has(method)) return this.whatsappImport.call(method, p);
    if (this.sync?.handles(method)) return this.sync.call(method, p); // device sync hook
    if (Updater.handles(method)) return this.updater.call(method, p);
    switch (method) {
      case "avatar": return this.avatar(p.kind, p.id, !!p.full);
      case "cleanPlaceholders": return this.cleanPlaceholders(p);
      case "avatarWarm": return this.warmAvatars(); // run the warm-up now (hosts / tests)
      case "avatarForgetMisses": return this.forgetAvatarMisses(p?.accountId); // "no picture" answers are re-asked (a provider gained picture support, or the user wants a fresh look)
      case "setAvatarWarmPaused": this.avatarWarmPaused = !!p.paused; return {}; // hosts pause it on a metered connection / low battery
      case "getProfile": { const c = this.need(this.resolveAccount(p.accountId)[0]); if (!c.getProfile) throw new Error("This messenger has no profile settings in UniChat"); return this.profileOut(await c.getProfile()); }
      case "updateProfile": {
        const [a] = this.resolveAccount(p.accountId); const c = this.need(a); if (!c.updateProfile) throw new Error("This messenger can't change its profile from UniChat");
        const patch: ProfilePatch = {};
        if (p.displayName !== undefined) patch.displayName = String(p.displayName);
        if (p.about !== undefined) patch.about = String(p.about);
        if (p.avatar === null) patch.avatar = null;
        else if (p.avatar) patch.avatar = { data: new Uint8Array(Buffer.from(p.avatar.dataBase64, "base64")), mime: p.avatar.mime };
        let oldSha: string | undefined; // own picture may appear elsewhere (e.g. the note-to-self chat): find those copies by hash
        if (patch.avatar !== undefined && c.getProfile) { try { const o = (await c.getProfile()).avatar; if (o?.data.length) oldSha = avatarSha(o.data); } catch { /* unknown: refresh the whole account lazily */ } }
        const out = this.profileOut(await c.updateProfile(patch));
        this.avatarCache.clear();
        if (patch.avatar !== undefined) await this.ownAvatarChanged(a.info.id, oldSha);
        this.emit("chats-changed", { accountId: a.info.id });
        return out;
      }
      case "getPrivacy": { const c = this.need(this.resolveAccount(p.accountId)[0]); if (!c.getPrivacy) throw new Error("This messenger has no privacy settings in UniChat"); return c.getPrivacy(); }
      case "setPrivacy": { const c = this.need(this.resolveAccount(p.accountId)[0]); if (!c.setPrivacy) throw new Error("This messenger can't change privacy settings from UniChat"); return c.setPrivacy(String(p.id), String(p.value)); }
      case "pendingLogins": return [...this.prompts.values()].filter((p: any) => !(p.kind === "captcha" && p.expiresAt && p.expiresAt < Date.now()));
      case "pendingVerifications": return [...this.verifs.values()];
      case "verificationStart": {
        const [a] = this.resolveAccount(p.accountId); const c = this.need(a); if (!c.verificationStart) throw new Error("This messenger has no verification in UniChat");
        const native = typeof p.chatId === "string" && p.chatId ? this.resolve(p.chatId)[1] : undefined;
        return withTimeout(c.verificationStart(p.userId || native ? { userId: p.userId ? String(p.userId) : undefined, chatId: native } : undefined), 30_000, "The messenger");
      }
      case "verificationAction": { const c = this.need(this.resolveAccount(p.accountId)[0]); if (!c.verificationAction) throw new Error("This messenger has no verification in UniChat"); return c.verificationAction(String(p.id), p.action); }
      case "verificationStatus": { const c = this.need(this.resolveAccount(p.accountId)[0]); if (!c.verificationStatus) throw new Error("This messenger has no verification in UniChat"); const native = typeof p.chatId === "string" && p.chatId ? this.resolve(p.chatId)[1] : undefined; return c.verificationStatus(p.userId || native ? { userId: p.userId ? String(p.userId) : undefined, chatId: native } : undefined); }
      case "verificationSetup": { const c = this.need(this.resolveAccount(p.accountId)[0]); if (!c.verificationSetup) throw new Error("This messenger can't set up verification from UniChat"); return withTimeout(c.verificationSetup({ password: typeof p.password === "string" ? p.password : undefined }), 120_000, "The messenger"); }
      case "verificationRecover": { const c = this.need(this.resolveAccount(p.accountId)[0]); if (!c.verificationRecover) throw new Error("This messenger can't verify with a recovery key"); return withTimeout(c.verificationRecover(String(p.recoveryKey ?? "")), 120_000, "The messenger"); }
      case "providers": return [...this.factories.values()].map((f) => ({ name: f.name, displayName: f.displayName, login: f.login, deprecated: f.deprecated, capabilities: f.capabilities }));
      case "accounts": return this.accountList();
      case "addAccount": return this.addAccount(p.provider, p.label);
      case "snapshot": { // calls that arrive while one is being built (and before any event was emitted) share it: a start-up UI asks 5-8 times in a row, each build ~0.2-1 s of the single thread
        const t0 = Date.now(), cur = this.snapShared;
        if (cur && cur.gen === this.snapGen) return cur.p;
        const gen = this.snapGen, p = this.snapshot(); this.snapShared = { gen, p }; const clear = () => { if (this.snapShared?.p === p) this.snapShared = undefined; }; p.then(clear, clear);
        const r = await p; (globalThis as any).__unimsgPlog?.("hub.snapshot", { ms: Date.now() - t0, chats: r.chats.length, accounts: r.accounts.length }); return r; }
      case "history": { this.noteOpened(p.chatId); const l = await (isMergeId(p.chatId) ? this.mergedHistory(p.chatId, p.limit ?? 100, p.beforeMessageId, p.beforeChatId, p.local === true) : this.history(p.chatId, p.limit ?? 100, p.beforeMessageId, p.local === true)); return this.nameSenders(l); }
      case "search": return isMergeId(p.chatId) ? this.searchMerged(p.chatId, String(p.q ?? ""), p.limit ?? 50) : this.store.searchMessages(p.chatId, String(p.q ?? ""), p.limit ?? 50);
      case "searchAll": return this.extras.searchAll(p);
      case "chatMedia": return this.extras.chatMedia(p);
      case "markChatRead": this.clearUnreadMark(p.chatId); this.noteRead(p.chatId); return this.extras.markChatRead(p);
      case "markAllRead": return this.extras.markAllRead(p);
      case "cancelMarkRead": return { cancelled: this.extras.reads.cancel(String(p.jobId)) };
      case "estimateMedia": return this.extras.estimateMedia(p);
      case "downloadAllMedia": return this.extras.downloadAllMedia(p);
      case "cancelMediaDownload": return this.extras.cancelMediaDownload(p);
      case "mediaJobs": return this.extras.mediaJobs();
      case "fetchHistory": return this.extras.fetchHistory(p);
      case "cancelFetchHistory": return this.extras.cancelFetchHistory(p);
      case "fetchHistoryJobs": return this.extras.fetchHistoryJobs();
      case "archiveMedia": return this.extras.archiveMedia(p);
      case "merges": return [...this.merges.values()];
      case "mergeChats": return this.mergeChats(p.chatIds ?? [], p.name);
      case "unmergeChat": return this.unmergeChat(p.mergeId);
      case "addMergeMember": return this.mergeChats([p.mergeId, p.chatId]);
      case "removeMergeMember": return this.removeMergeMember(p.mergeId, p.chatId);
      case "setMergePrimary": return this.editMerge(p.mergeId, (mg) => { if (!mg.members.includes(p.chatId)) throw new Error("That chat is not part of this merge."); mg.primary = p.chatId; });
      case "setMergeVia": return this.editMerge(p.mergeId, (mg) => { if (p.chatId && !mg.members.includes(p.chatId)) throw new Error("That chat is not part of this merge."); if (p.chatId) mg.sendVia = p.chatId; else delete mg.sendVia; }, true);
      case "mergeSuggestions": return this.mergeSuggestions(p.chatId);
      case "getSettings": return { retentionDays: Number(this.store.getSetting("retentionDays") ?? 0), collapseSingleChatCommunities: this.collapseSingle(), showPresence: this.showPresence(), scheduleLateHours: Math.round(this.scheduleLateMs() / 3600_000) };
      case "setSetting":
        if (p.key === "collapseSingleChatCommunities") { this.store.setSetting(p.key, p.value ? "1" : "0"); this.emit("chats-changed", {}); this.emit("spaces-changed", {}); return; }
        if (p.key === "showPresence") {
          this.store.setSetting(p.key, p.value ? "1" : "0");
          if (!p.value) { this.presence.clear(); this.emit("presence-reset", {}); }
          for (const a of this.accounts.values()) a.conn?.setPresenceEnabled?.(!!p.value);
          this.emit("chats-changed", {}); return;
        }
        if (p.key === "scheduleLateHours") { this.store.setSetting(p.key, String(Math.min(720, Math.max(1, Math.floor(Number(p.value) || 24))))); return; }
        if (p.key !== "retentionDays") throw new Error("unknown setting");
        this.store.setSetting("retentionDays", String(Math.max(0, Math.floor(Number(p.value) || 0)))); this.purge(); return;
      case "folders": return this.store.listFolders();
      case "createFolder": return this.createFolder(p);
      case "updateFolder": return this.updateFolder(p);
      case "deleteFolder": return this.deleteFolder(p.id);
      case "moveChat": return this.moveChat(p.chatId, p.folderId ?? null);
      case "categories": return this.categories.get();
      case "createCategory": return this.categories.create(p);
      case "updateCategory": return this.categories.update(p);
      case "deleteCategory": return this.categories.delete(p.id);
      case "setChatCategory": return this.categories.setChat({ chatIds: p.chatIds ?? (p.chatId ? [p.chatId] : []), categoryId: p.categoryId ?? null });
      case "setCategoryOrder": return this.categories.setOrder(p);
      case "railGroups": return this.railGroups.get();
      case "setRailGroups": return this.railGroups.set(p.groups);
      case "setRailOrder": this.store.setSetting("railOrder", JSON.stringify((p.ids ?? []).map(String))); this.emit("spaces-changed", {}); return;
      case "signOut": return this.signOut(p.accountId);
      case "signIn": return this.signIn(p.accountId);
      case "cancelSignIn": return this.cancelSignIn(p.accountId);
      case "send":
        if (MeshRelay.isMesh(p.chatId)) return this.mesh.post(p.chatId, p.text);
        return this.sendTo(this.sendTarget(p.chatId, p.via), {
          text: p.text ?? "", replyToMessageId: p.replyToMessageId, location: p.location, contacts: p.contacts, poll: p.poll, event: p.event,
          mentions: sanitizeMentions(p.text ?? "", p.mentions), clientId: typeof p.clientId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(p.clientId) ? p.clientId : undefined,
          attachments: p.attachments?.map((a: any) => ({ kind: a.kind, mime: a.mime, name: a.name, durationMs: a.durationMs, waveform: a.waveform, ...outgoingHints(a), data: new Uint8Array(Buffer.from(a.dataBase64, "base64")) })),
        });
      case "commonChats": return this.commonChats(String(p.chatId));
      case "members": {
        if (isMergeId(p.chatId)) { const mg = this.merges.get(p.chatId); const all = await Promise.all((mg?.members ?? []).map((cid) => this.call("members", { chatId: cid }).then((l) => (l as any[]).map((c) => ({ ...c, chatId: cid })), () => []))); return all.flat(); }
        const [a, native] = this.resolve(p.chatId); const list = a.conn && !this.offlineKind(a) ? await a.conn.members(native) : []; return list.map((c) => { const n = this.aliasCache.get(`${a.info.id}:${c.id}`), pr = this.presence.get(`${a.info.id}:${c.id}`); const o = pr && c.online === undefined ? { ...c, online: pr.online, ...(pr.lastSeen ? { lastSeen: pr.lastSeen } : {}) } : c; return n ? { ...o, name: n } : o; }); }
      case "attachment": {
        const [a, native] = this.resolve(p.chatId);
        const k = `${p.chatId}|${p.messageId}|${p.attachmentId}`;
        let r = this.media.get(a.info.id, k);
        if (!r) {
          const fromPeer = async () => { try { return await this.sync?.fetchMedia?.(a.info.id, p.chatId, p.messageId, p.attachmentId); } catch { return undefined; } }; // device sync: another paired device may hold the bytes
          if (!a.conn || this.offlineKind(a)) {
            r = await fromPeer();
            if (!r) throw new Error("This file isn't available offline: it was never opened before the account was signed out.");
          } else {
            try { r = await a.conn.downloadAttachment(native, p.messageId, p.attachmentId, p.urgent === true ? { urgent: true } : undefined); }
            catch (e) { r = await fromPeer(); if (!r) throw e; }
          }
          try { this.media.put(a.info.id, k, r); } catch { /* cache is best effort */ }
        }
        return { dataBase64: Buffer.from(r.data).toString("base64"), mime: r.mime, name: r.name };
      }
      case "startChat": case "createGroup": return this.chatOp(method, p);
      case "createSpace": case "joinSpace": return this.spaceOp(method, p);
      case "leaveSpace": return this.leaveSpace(p.spaceId);
      case "forward": return this.forward(p.message as Message, this.sendTarget(p.toChatId, p.via));
      case "removeAccount": return this.removeAccount(p.accountId, p.deleteData !== false);
      case "renameAccount": {
        const [a] = this.resolveAccount(p.accountId); a.info.label = p.label;
        this.store.putAccount({ id: a.info.id, provider: a.info.provider, label: p.label, status: a.conn ? "active" : "archived" }); return a.info;
      }
      case "submitLogin": {
        const [a] = this.resolveAccount(p.accountId);
        const pr = this.prompts.get(a.info.id) as { kind?: string; promptId?: string } | undefined;
        if (pr?.kind === "captcha" && pr.promptId === p.promptId) this.prompts.delete(a.info.id); // answered (or cancelled): do not offer it again after a reload
        return this.need0(a).submitLogin(p.promptId, p.values);
      }
      case "markRead": this.clearUnreadMark(p.chatId); this.noteRead(p.chatId); if (isMergeId(p.chatId)) { const mg = this.merges.get(p.chatId); if (!mg) throw new Error("This merged chat no longer exists."); return this.markReadMerged(mg, p); }
        return this.optional(p.chatId, method, p);
      case "pins": return this.nameSenders(await this.pinsOf(p.chatId));
      case "react": case "pin": case "edit": case "delete": case "setTyping": case "vote": case "editEvent": case "refreshChat":
      case "acceptRequest": case "declineRequest":
      case "leaveChat": case "addMembers": case "removeMember": case "renameChat": case "blockChat": case "setChatPicture": case "setChatDescription": case "setDisappearing":
        return this.optional(p.chatId, method, p);
      case "meshCreate": return this.mesh.create(p.name, p.members);
      case "meshGroups": return this.mesh.list();
      case "syncAccount": { const [a] = this.resolveAccount(p.accountId); const c = this.need(a); if (!c.sync) throw new Error(`${a.info.provider} has nothing to sync`); await c.sync(); return; }
      case "setChatFlags": { const prev = this.store.listChatFlags()[p.chatId]; this.store.setChatFlags(p.chatId, { pinned: !!p.pinned, muted: !!p.muted, archived: !!p.archived, unreadMark: !!p.unreadMark, ...(prev?.readUpTo && !p.unreadMark ? { readUpTo: prev.readUpTo } : {}) }); } this.emit("chats-changed", { chatId: p.chatId }); return;
      case "setAlias": this.store.setAlias(p.chatId, (p.name ?? "").trim() || null); this.reloadAliases(); this.emit("chats-changed", { chatId: p.chatId }); return;
      case "scheduleMessage": { // p: { chatId, text, at: epoch ms }. The schedule lives on THIS device; `clientId` makes a send through another device happen once.
        const at = Number(p.at) || Date.now();
        return this.scheduler.enqueue({ kind: "send", payload: { chatId: this.sendTarget(p.chatId, p.via), text: p.text, clientId: randomUUID().replace(/-/g, ""), due: at } satisfies ScheduledSend, runAt: at });
      }
      case "sendJobNow": return this.sendJobNow(String(p.id));
      case "discardJob": return this.scheduler.discard(String(p.id));
      case "jobs": return this.store.listJobs(p?.status);
      case "cancelJob": return this.scheduler.cancel(p.id);
    }
    throw new Error(`unknown method ${method}`);
  }

  private async addAccount(provider: string, label?: string): Promise<Account> {
    if (!this.factories.has(provider)) throw new Error(`unknown provider ${provider}`);
    const id = `${provider}-${randomUUID().slice(0, 8)}`;
    this.store.holdAccount?.(id); // other devices hear about it only after the first successful sign-in
    this.store.putAccount({ id, provider, label: label || id, status: "active" });
    return this.startAccount(id, provider, label || id);
  }

  private makeConn(id: string, provider: string): Connector {
    const f = this.factories.get(provider);
    if (!f) throw new Error(`unknown provider ${provider}`);
    const dataDir = join(this.dataDir, id);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return f.create({ accountId: id, dataDir });
  }

  private async startAccount(id: string, provider: string, label: string): Promise<Account> {
    const info = this.infoFor(id, provider, label, "connecting");
    const acc: Acc = { info, conn: this.makeConn(id, provider) };
    this.accounts.set(id, acc);
    try { acc.conn!.setPresenceEnabled?.(this.showPresence()); await acc.conn!.start((e) => this.onEvent(id, e)); }
    catch (e) { info.state = "disconnected"; throw e; }
    return this.refreshCaps(acc);
  }

  private onEvent(accountId: string, e: CoreEvent) {
    const g = (chatId: string) => `${accountId}:${chatId}`;
    switch (e.type) {
      case "message": {
        const m: Message = this.named(accountId, { ...e.data, chatId: g(e.data.chatId), accountId });
        const key = `${m.chatId}|${m.id}`; // history-sync replays may re-deliver messages
        if (this.seenMsgs.has(key)) return;
        this.seenMsgs.add(key);
        if (this.seenMsgs.size > 20000) this.seenMsgs.delete(this.seenMsgs.values().next().value!);
        const { historical, ...stored } = m; // the flag is about HOW it arrived, it is not part of the message
        try { this.store.putMessages([stored]); this.activity.delete(stored.chatId); this.senderNameMaps.delete(stored.chatId); } catch (err) { console.error("archive failed:", (err as Error).name); }
        this.emitC("message", this.nameSenders([m])[0]!);
        if (!historical) this.mesh.handleIncoming(m); // never relay a history flood into other chats
        return;
      }
      case "avatar-changed": { // the provider says a picture changed: refresh stored copies now
        if (e.data.own) { void this.ownAvatarChanged(accountId); return; }
        const kinds = e.data.kind ? [e.data.kind] : (["chat", "contact"] as const), keys = kinds.flatMap((k) => [avatarKey(k, g(e.data.id!)), avatarKey(k, g(e.data.id!), true)]);
        void this.refreshAvatars(keys, true); return;
      }
      case "message-update": {
        const chatId = g(e.data.chatId), patch = e.data.patch as Partial<Message>;
        if (patch.deleted) { patch.reactions = []; } // a deleted message loses its reactions (WhatsApp does the same)
        const stored: Record<string, unknown> = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        if (patch.pinned === false || patch.deleted) { stored.pinned = false; for (const k of ["pinnedAt", "pinnedBy", "pinnedUntil"]) stored[k] = undefined; } // an unpin / a deleted message carries no pin details
        if (patch.deleted) { for (const k of DELETED_STRIPS) stored[k] = undefined; } // ...and everything rich it carried (the patch can't clear a card, so clear it here)
        try { this.store.patchMessage(chatId, e.data.messageId, stored as Partial<Message>); } catch { /* archive is best effort here */ }
        // receipts merge per recipient: the UI gets the merged list, never a partial one
        const merged = patch.receipts ? this.store.getMessage(chatId, e.data.messageId)?.receipts : undefined;
        return this.emitC(e.type, { ...e.data, chatId, ...(patch.deleted ? { patch: { ...e.data.patch, attachments: [], cards: [] } } : merged ? { patch: { ...e.data.patch, receipts: merged } } : {}) });
      }
      case "receipt": {
        const chatId = g(e.data.chatId), old = this.store.getMessage(chatId, e.data.messageId);
        const rank = ["failed", "sending", "sent", "delivered", "read"];
        if (old && rank.indexOf(e.data.status) >= rank.indexOf(old.status ?? "sending")) this.store.patchMessage(chatId, e.data.messageId, { status: e.data.status });
        const by = e.data.by ?? "";
        if (old && by && (e.data.status === "delivered" || e.data.status === "read")) { // per-recipient receipt (read implies delivered; both keep the time they were told)
          const t = Date.parse(e.data.at ?? ""), at = new Date(Number.isFinite(t) ? t : Date.now()).toISOString();
          this.store.patchMessage(chatId, e.data.messageId, { receipts: [{ id: by, ...(e.data.status === "read" ? { read: at } : { delivered: at }) }] });
          const receipts = this.store.getMessage(chatId, e.data.messageId)?.receipts;
          if (receipts) this.emitC("message-update", { chatId, messageId: e.data.messageId, patch: { receipts } });
        }
        return this.emitC(e.type, { ...e.data, chatId });
      }
      case "typing": return this.emitC(e.type, { ...e.data, chatId: g(e.data.chatId) });
      case "presence": {
        if (this.showPresence() && this.setPresence(accountId, e.data)) this.emit("presence", { ...e.data, accountId, ...(e.data.chatId ? { chatId: g(e.data.chatId) } : {}) });
        return;
      }
      case "chats-changed": return this.emit(e.type, { accountId, chatId: e.data.chatId && g(e.data.chatId) });
      case "account": {
        const a = this.accounts.get(accountId);
        if (a) {
          a.info.state = e.data.state;
          this.refreshCaps(a);
          const last = this.store.listAccountEvents(accountId).at(-1)?.kind;
          if (e.data.state === "connected") { this.store.releaseAccount?.(accountId); this.scheduleWarm(); this.prompts.delete(accountId); if (last !== "linked") this.logEvent(a, "linked"); }
          else if (e.data.state === "needs-login" && last === "linked") this.logEvent(a, "unlinked"); // the phone removed this device
        }
        return this.emit("account", { ...e.data, id: accountId, ...(a?.info.capabilities ? { capabilities: a.info.capabilities } : {}) });
      }
      case "verification": {
        const k = `${accountId}|${e.data.id}`;
        if (e.data.phase === "done" || e.data.phase === "cancelled") this.verifs.delete(k); else this.verifs.set(k, { ...e.data, accountId });
        return this.emit("verification", { ...e.data, accountId });
      }
      case "login": this.prompts.set(accountId, { ...e.data, accountId }); return this.emit("login", { ...e.data, accountId });
      default: return this.emit(e.type, { ...(e.data as object), accountId });
    }
  }

  /** Presence by GLOBAL chat id and by `<accountId>:<contactId>` (memory only, never archived). Returns false when nothing changed. */
  private presence = new Map<string, { online: boolean; lastSeen?: string }>();
  private setPresence(accountId: string, d: { chatId?: string; contactId: string; online: boolean; lastSeen?: string }): boolean {
    const v = { online: !!d.online, ...(d.lastSeen ? { lastSeen: d.lastSeen } : {}) };
    const keys = [`${accountId}:${d.contactId}`, ...(d.chatId ? [`${accountId}:${d.chatId}`] : [])];
    const old = this.presence.get(keys[0]);
    for (const k of keys) this.presence.set(k, v);
    return !old || old.online !== v.online || old.lastSeen !== v.lastSeen;
  }
  /** Privacy setting "Show who is online" (default on). Off: connectors are told to stop watching presence, events are dropped, nothing is shown. */
  private showPresence() { return this.store.getSetting("showPresence") !== "0"; }
  private withPresence(c: Chat): Chat {
    if (c.kind !== "dm" || !this.showPresence()) return c;
    const p = this.presence.get(c.id);
    return p ? { ...c, online: p.online, ...(p.lastSeen ? { lastSeen: p.lastSeen } : {}) } : c;
  }

  /** All spaces + chats. Live accounts are asked (and cached); signed-out or unreachable accounts come from the cache, read-only. */
  /** Newest archived message per chat (time + preview text), for chats whose provider gave no last-activity (imported history, backups). Entries live 5 min and are dropped when a message is stored. */
  private activity = new Map<string, { at: number; time?: string; preview?: string }>();
  private archivedActivity(chatId: string): { time?: string; preview?: string } {
    const hit = this.activity.get(chatId);
    if (hit && Date.now() - hit.at < 300_000) return hit; // dropped when a message is stored here or by sync (indexMessage), and on reloadFromStore: building it costs 8 decrypts per chat per snapshot
    let time: string | undefined, preview: string | undefined;
    try {
      const m = this.store.listMessages(chatId, { limit: 8 }).reverse().find((x) => !x.system && !x.deleted);
      if (m) { time = m.time; preview = (m.text || "").replace(/\s+/g, " ").trim().slice(0, 120) || (m.attachments?.[0] ? ({ image: "📷 Photo", video: "🎬 Video", voice: "🎤 Voice message", audio: "🎵 Audio", sticker: "Sticker", gif: "GIF", file: "📎 File" } as Record<string, string>)[m.attachments[0].kind] ?? "📎 Attachment" : m.poll ? "📊 Poll" : m.location ? "📍 Location" : ""); }
    } catch { /* archive unreadable: no activity info */ }
    const e = { at: Date.now(), time, preview }; this.activity.set(chatId, e); return e;
  }
  /** A DM titled by a bare id (e.g. the first 8 characters of a Signal account id, a bare phone number or a uuid) gets the sender name of the newest incoming message that has a real one. Derived from the local archive, so every synced device shows the same name. A name the user set (alias) still wins. */
  private peerNames = new Map<string, { at: number; name?: string }>();
  private static idLike(n: string) { const t = n.trim(); return !t || /^[0-9a-f]{8}$/i.test(t) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t) || /^\+?[\d\s()-]{5,}$/.test(t); }
  private peerName(chatId: string): string | undefined {
    const hit = this.peerNames.get(chatId);
    if (hit && Date.now() - hit.at < 300_000) return hit.name;
    let name: string | undefined;
    try {
      for (const m of this.store.listMessages(chatId, { limit: 60 }).reverse()) {
        if (m.fromMe || m.system || m.deleted) continue;
        const n = (m.sender ?? "").trim();
        if (n && !Hub.idLike(n)) { name = n; break; }
      }
    } catch { /* archive unreadable: keep the id */ }
    this.peerNames.set(chatId, { at: Date.now(), name }); return name;
  }
  /** Group messages whose sender label is a bare id (e.g. the first 8 characters of a Signal account id) get the real name the same sender has elsewhere in the chat (profile name seen on another message). Display only; the archive keeps what the provider gave. */
  private senderNameMaps = new Map<string, { at: number; names: Map<string, string> }>();
  private senderNames(chatId: string): Map<string, string> {
    const hit = this.senderNameMaps.get(chatId);
    if (hit && Date.now() - hit.at < 120_000) return hit.names;
    const names = new Map<string, string>();
    try { for (const m of this.store.listMessages(chatId, { limit: 600 })) { const n = (m.sender ?? "").trim(); if (m.senderId && n && !Hub.idLike(n) && !m.fromMe) names.set(m.senderId, n); } } catch { /* archive unreadable */ }
    this.senderNameMaps.set(chatId, { at: Date.now(), names }); return names;
  }
  private nameSenders(list: Message[]): Message[] {
    const badReply = (m: Message) => !!m.replyTo?.sender && Hub.idLike(m.replyTo.sender);
    if (!list.some((m) => (!m.fromMe && m.sender && m.senderId && Hub.idLike(m.sender)) || badReply(m))) return list;
    const maps = new Map<string, Map<string, string>>();
    return list.map((m0) => {
      let m = m0;
      if (badReply(m)) { // a quote labelled by a bare id: the quoted message is mine ("You") or has a real name in the archive
        const orig = this.store.getMessage(m.chatId, m.replyTo!.messageId);
        const label = orig ? (orig.fromMe ? "You" : orig.sender && !Hub.idLike(orig.sender) ? orig.sender : undefined) : undefined;
        if (label) m = { ...m, replyTo: { ...m.replyTo!, sender: label } };
      }
      if (m.fromMe || !m.sender || !m.senderId || !Hub.idLike(m.sender)) return m;
      let mp = maps.get(m.chatId); if (!mp) { mp = this.senderNames(m.chatId); maps.set(m.chatId, mp); }
      const n = mp.get(m.senderId); return n ? { ...m, sender: n } : m;
    });
  }
  private snapGen = 0; private snapShared?: { gen: number; p: Promise<ReturnType<Hub["snapshot"]> extends Promise<infer R> ? R : never> };
  private async snapshot() {
    const { spaces, chats } = await this.collect();
    for (const c of chats) if (c.kind === "dm" && Hub.idLike(c.name ?? "")) { const n = this.peerName(c.id); if (n) c.name = n; }
    for (const c of chats) { // fill missing activity from the archive (sorting + preview of chats the provider knows nothing about)
      if (c.lastMessageAt && c.preview) continue;
      const a = this.archivedActivity(c.id);
      if (!c.lastMessageAt && a.time) c.lastMessageAt = a.time;
      if (!c.preview && a.preview && (!c.lastMessageAt || !a.time || a.time >= c.lastMessageAt)) c.preview = a.preview;
    }
    for (const g of this.mesh.list()) chats.push({ id: g.id, accountId: "", provider: "mesh", kind: "group", name: g.name });
    this.ensureAutoMerges(chats);
    const alias = this.store.listAliases(), flags = this.store.listChatFlags();
    const spaceOut = spaces.map((s) => ({ ...s, ...(alias[s.id] ? { name: alias[s.id], originalName: s.name } : {}), ...(flags[s.id]?.muted ? { muted: true } : {}), ...(flags[s.id]?.archived ? { archived: true } : {}) }));
    const chatOut = chats.map((c0) => { const c = this.withPresence(c0); return { ...c, ...(alias[c.id] ? { name: alias[c.id], originalName: c.name } : {}), ...(flags[c.id] ? { pinned: flags[c.id].pinned, archived: flags[c.id].archived, muted: flags[c.id].muted || c.muted } : {}), ...(flags[c.id]?.unreadMark ? { unreadMark: true, ...(c.unread ? {} : { unread: 1, unreadApprox: true }) } : {}) }; });
    for (const c of chatOut) { // the persistent read mark (see noteRead): an unread count the provider keeps reporting although the user has read the chat
      const f = flags[c.id]; if (!f?.readUpTo || f.unreadMark || !c.unread) continue;
      if (c.lastMessageAt && c.lastMessageAt <= f.readUpTo) { c.unread = 0; delete c.unreadApprox; continue; }
      const n = this.store.listMessages(c.id, { limit: 300 }).filter((m) => !m.fromMe && !m.system && m.time > f.readUpTo!).length;
      if (n < c.unread) { c.unread = n; if (!n) delete c.unreadApprox; }
    }
    const withMerged = this.withMerges(chatOut, alias, flags);
    const { spaces: sp, chats: ch } = applyFolders({ spaces: spaceOut, chats: withMerged, folders: this.store.listFolders(), overrides: this.store.listChatFolders(), order: this.railOrder(), collapseSingle: this.collapseSingle(), flags });
    const cst = this.categories.state(), have = new Set(sp.map((x) => x.id)).add(PERSONAL);
    const categories = Object.fromEntries(Object.entries(cst.categories).filter(([k]) => have.has(k)));
    return { spaces: sp, chats: applyCategories(ch, { categories, chatCategory: cst.chatCategory }), categories, merges: [...this.merges.values()], accounts: this.accountList() };
  }

  // ---------------------------------------------------------------- folders (local only)
  private collapseSingle() { return this.store.getSetting("collapseSingleChatCommunities") !== "0"; }
  private railOrder(): string[] { try { const v = JSON.parse(this.store.getSetting("railOrder") ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } }
  private changed() { this.emit("spaces-changed", {}); this.emit("chats-changed", {}); }
  /** A folder icon is an emoji (short text) or an uploaded picture as a small data URL. */
  private folderIcon(v: unknown): string {
    const s = String(v ?? "");
    if (s.startsWith("data:")) {
      if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) throw new Error("That icon is not a usable picture (PNG, JPEG, WebP or GIF).");
      if (s.length > 150_000) throw new Error("That icon picture is too large.");
      return s;
    }
    if ([...s].length > 16) throw new Error("An icon is one emoji or one small picture.");
    return s;
  }
  private async createFolder(p: { name: string; color?: string; icon?: string }): Promise<Folder> {
    const name = String(p.name ?? "").trim(); if (!name) throw new Error("Give the folder a name.");
    const f: Folder = { id: "folder:" + randomUUID(), name, ...(p.color ? { color: String(p.color) } : {}), ...(p.icon ? { icon: this.folderIcon(p.icon) } : {}) };
    this.store.putFolder(f);
    const have = (await this.snapshot()).spaces.map((x) => x.id).filter((x) => x !== f.id); // new folders go to the end of the rail
    this.store.setSetting("railOrder", JSON.stringify([...new Set([...this.railOrder(), ...have]), f.id]));
    this.changed(); return f;
  }
  private updateFolder(p: { id: string; name?: string; color?: string | null; icon?: string | null }): Folder {
    const f = this.store.listFolders().find((x) => x.id === p.id); if (!f) throw new Error("That folder no longer exists.");
    const next: Folder = { ...f };
    if (p.name !== undefined) { const n = String(p.name).trim(); if (!n) throw new Error("Give the folder a name."); next.name = n; }
    if (p.color !== undefined) { if (p.color) next.color = p.color; else delete next.color; }
    if (p.icon !== undefined) { if (p.icon) next.icon = this.folderIcon(p.icon); else delete next.icon; }
    this.store.putFolder(next); this.changed(); return next;
  }
  /** Deleting a folder sends its chats back to where they were (override removed; they follow their network community again). */
  private async deleteFolder(id: string) {
    if (!isFolderId(id) || !this.store.listFolders().some((f) => f.id === id)) throw new Error("That folder no longer exists.");
    for (const [chat, f] of Object.entries(this.store.listChatFolders())) if (f === id) this.store.setChatFolder(chat, null);
    this.store.deleteFolder(id); this.store.setChatFlags(id, {});
    this.store.setSetting("railOrder", JSON.stringify(this.railOrder().filter((x) => x !== id)));
    await this.categories.reconcile().catch(() => {}); // its categories go with it; chats that return home drop their overrides
    this.changed();
  }
  /** Move a chat (DM, group, channel, merged chat, mesh group) to Personal (`"personal"`), a folder or any community; `null` resets to the network's own place. */
  private async moveChat(chatId: string, folderId: string | null) {
    if (!chatId) throw new Error("No chat given.");
    const target = this.mergeOf.get(chatId) ?? chatId; // a member of a merged chat moves with its merged row
    if (folderId !== null && folderId !== PERSONAL) {
      const ok = isFolderId(folderId) ? this.store.listFolders().some((f) => f.id === folderId) : (await this.collect()).spaces.some((s) => s.id === folderId);
      if (!ok) throw new Error("That folder or community no longer exists.");
    }
    this.store.setChatFolder(target, folderId);
    await this.categories.reconcile([target]).catch(() => {}); // a category override only holds inside its own view
    this.emit("chats-changed", { chatId: target }); this.emit("spaces-changed", {});
  }

  /** Raw spaces + chats of every account (live ones asked and cached, offline ones from the cache), without user names/flags. */
  private async collect() {
    const spaces: Space[] = [], chats: Chat[] = [];
    for (const [id, a] of this.accounts) {
      const offline = this.offlineKind(a);
      let got: { spaces: Space[]; chats: Chat[] } | undefined;
      if (!offline && a.conn) {
        try {
          const s = (await a.conn.spaces()).map((x) => ({ ...x, id: `${id}:${x.id}` }));
          const c = (await a.conn.chats()).map((x) => ({ ...x, id: `${id}:${x.id}`, spaceId: x.spaceId && `${id}:${x.spaceId}`, ...(x.sameAs ? { sameAs: `${id}:${x.sameAs}` } : {}) }));
          got = { spaces: s, chats: c };
          this.noteAvatarHints(c, s);
          const sig = JSON.stringify(got);
          if (this.cacheSig.get(id) !== sig && (c.length || s.length)) { this.cacheSig.set(id, sig); this.store.putChatCache(id, got); }
        } catch { /* provider not ready yet: fall back to the cache */ }
      }
      got ??= this.store.getChatCache(id);
      got = withImportedChats(this.store, id, a.info.provider, got); // chats created by a Signal history import
      got = withWhatsAppImportedChats(this.store, id, a.info.provider, got); // ... or a WhatsApp one
      if (!got) continue;
      spaces.push(...got.spaces);
      for (const c of got.chats) chats.push(offline ? { ...c, offline, readOnly: true } : c);
    }
    for (const [pid, pc] of this.provisional) { if (!chats.some((c) => c.id === pid)) chats.push(pc); } // not on the network yet
    return { spaces, chats };
  }

  /**
   * Message history = our archive, topped up from the provider when it can know more (so history fetched from a
   * server is kept) and interleaved with timeline markers for sign-outs / unlinks / re-links (possible gaps).
   */
  /** `local`: archive only, never wait for (or ask) the provider, e.g. when the source device does not answer. */
  private async history(chatId: string, limit: number, beforeId?: string, local = false): Promise<Message[]> {
    const beforeTime = beforeId ? this.store.getMessage(chatId, beforeId)?.time : undefined;
    let page = this.store.listMessages(chatId, { beforeTime, limit });
    if (MeshRelay.isMesh(chatId) || this.provisional.has(chatId)) return page;
    let acc: Acc | undefined, native = "";
    try { [acc, native] = this.resolve(chatId); } catch { return page; }
    const a = acc;
    const caps = this.factories.get(a.info.provider)?.capabilities;
    const live = !local && !!a.conn && !this.offlineKind(a);
    const again = () => this.store.listMessages(chatId, { beforeTime, limit });
    if (live && (!beforeId || beforeTime) && (page.length < limit || caps?.backfill)) {
      if (page.length > 0 && !beforeId) {
        // We can already show something: answer from the archive NOW and top up in the background (the provider may have to
        // ask the phone, which takes seconds). The UI reloads when `history-updated` arrives.
        void this.topUp(a, chatId, native, limit, beforeId).then((changed) => { if (changed) this.emitC("history-updated", { chatId }); });
      } else {
        // Nothing to show yet (or the user is paging back): wait for the provider, but not forever.
        const p = this.topUp(a, chatId, native, limit, beforeId);
        const done = await Promise.race([p.then((c) => ({ c })), new Promise<{ c: boolean; late: true }>((r) => setTimeout(() => r({ c: false, late: true }), 8000))]);
        if ("late" in done) void p.then((changed) => { if (changed) this.emitC("history-updated", { chatId }); });
        else if (done.c) page = again();
      }
    } else if (beforeId && !beforeTime && live) {
      // the anchor isn't archived (e.g. a provider-cache message): trust the provider for this page
      try { const l = (await a.conn!.history(native, { limit, beforeMessageId: beforeId })).map((m) => ({ ...m, chatId, accountId: a.info.id })); this.store.putMessages(l); return l; } catch { return page; }
    }
    return this.withMarkers(a, chatId, page.map((m) => this.named(a.info.id, m)), limit, beforeTime);
  }

  private topping = new Map<string, Promise<boolean>>(); // one provider top-up per chat page at a time
  /** Ask the provider for messages and archive the ones we didn't have. Resolves true if something new arrived. */
  private topUp(a: Acc, chatId: string, native: string, limit: number, beforeId?: string): Promise<boolean> {
    const key = `${chatId}|${beforeId ?? ""}|${limit}`;
    let p = this.topping.get(key);
    if (!p) {
      p = (async () => {
        try {
          const l = (await a.conn!.history(native, { limit, beforeMessageId: beforeId })).map((m) => ({ ...m, chatId, accountId: a.info.id }));
          const fresh = l.filter((m) => !this.store.getMessage(chatId, m.id));
          if (l.length) this.store.putMessages(l);
          return fresh.length > 0;
        } catch { return false; } // offline or rate limited: the archive is all we have
      })().finally(() => this.topping.delete(key));
      this.topping.set(key, p);
    }
    return p;
  }

  private withMarkers(a: Acc, chatId: string, page: Message[], limit: number, beforeTime?: string): Message[] {
    const lo = page.length >= limit ? page[0].time : "", hi = beforeTime ?? "9999";
    const marks = this.markersFor(a, chatId, lo, hi);
    return marks.length ? [...page, ...marks].sort((x, y) => x.time.localeCompare(y.time) || Number(!!x.system) - Number(!!y.system) || x.id.localeCompare(y.id)) : page;
  }
  /** Timeline markers (linked / signed out / unlinked) of an account that fall into [lo, hi). */
  private markersFor(a: Acc, chatId: string, lo: string, hi: string, prefix = ""): Message[] {
    const events = this.store.listAccountEvents(a.info.id);
    if (!events.length) return [];
    const caps = this.factories.get(a.info.provider)?.capabilities;
    const name = this.factories.get(a.info.provider)?.displayName ?? a.info.provider;
    const marks: Message[] = [];
    events.forEach((e, i) => {
      if (e.time < lo || e.time >= hi) return;
      const prev = events[i - 1];
      let text: string | undefined;
      if (e.kind === "signed-out") text = "You signed out. Your chats stay here as a read-only archive.";
      else if (e.kind === "unlinked") text = `This device was unlinked from ${name}. Your chats stay here as a read-only archive until you sign in again.`;
      else if (prev) text = `Signed in again. Messages from ${fmtDate(prev.time)} to ${fmtDate(e.time)} may be missing${caps?.backfill ? ", unless they can be restored from the server" : ""}.`;
      else if (!caps?.backfill) text = `Linked on ${fmtDate(e.time)}. Earlier messages aren't available: ${name} doesn't keep your history on its servers.`;
      if (text) marks.push({ id: `sys-${e.id}`, chatId, sender: "", senderId: "", text: prefix + text, time: e.time, fromMe: false, system: { kind: e.kind } });
    });
    return marks;
  }

  private resolve(globalId: string): [Acc, string] {
    for (const [id, a] of this.accounts) if (globalId.startsWith(id + ":")) return [a, globalId.slice(id.length + 1)];
    throw new Error(`no account for chat ${globalId}`);
  }
  private need0(a: Acc): Connector {
    if (!a.conn) throw new Error(`${a.info.label} is signed out.`);
    return a.conn;
  }
  private lateMs?: number;
  private scheduleLateMs() { const h = Number(this.store.getSetting("scheduleLateHours")); return this.lateMs ?? (h > 0 ? h : 24) * 3600_000; }
  /** The job handler of scheduled messages. Waiting (holder offline) is not a failure; too late or not allowed any more is final, with a plain sentence. */
  private async runScheduledSend(p: ScheduledSend, force = false) {
    const late = this.scheduleLateMs();
    if (!force && p.due && Date.now() - p.due > late) throw new JobAbort(`This message was due on ${fmtDate(new Date(p.due).toISOString())} but could not be sent within ${Math.round(late / 3600_000)} hours, so it was not sent. Send it now or delete it.`, true);
    if (!MeshRelay.isMesh(p.chatId)) {
      let a: Acc | undefined; try { [a] = this.resolve(p.chatId); } catch { /* unknown chat: sendTo says so */ }
      const via = a?.info.via;
      if (a && via?.kind === "offline") throw new JobWaiting(`Waiting for ${via.device} to come online`);
      if (a && via && via.kind !== "relay") throw new JobAbort(`${via.device} doesn't allow sending as ${a.info.label}. Nothing was sent.`);
      if (a && !a.conn && !via) throw new JobAbort(`${a.info.label} is not connected on this device, and no other of your devices sends for it any more. Nothing was sent.`);
    }
    try { await this.sendTo(p.chatId, { text: p.text, clientId: p.clientId }); }
    catch (e: any) { if (e?.code === "unreachable") { const v = this.resolve(p.chatId)[0].info.via; throw new JobWaiting(`Waiting for ${v?.device ?? "the other device"} to come online`); } throw e; }
  }
  /** "Send now" on a message that was too late: the user decided, so the cutoff does not apply; it still uses its client id, so it is never sent twice. */
  private async sendJobNow(id: string) {
    const j = this.store.getJob(id); if (!j || j.kind !== "send" || j.status !== "failed") throw new Error("That message is not waiting for a decision.");
    await this.runScheduledSend(j.payload as ScheduledSend, true).catch((e) => { throw e instanceof JobWaiting ? new Error(e.message) : e; });
    j.status = "done"; j.lastError = "sent"; this.store.putJob(j); this.emit("job", j); return true;
  }
  private async sendTo(globalId: string, out: OutgoingMessage) {
    const [a, native] = this.resolve(globalId);
    const m = await this.need(a).send(native, out);
    // A provisional chat (startChat before the first message) is resolved by the first send: the connector answers with the real chat id.
    const realId = m.chatId && m.chatId !== native ? `${a.info.id}:${m.chatId}` : globalId;
    if (realId !== globalId) {
      this.provisional.delete(globalId);
      this.emit("chat-resolved", { from: globalId, to: realId, accountId: a.info.id });
      this.emit("chats-changed", { accountId: a.info.id, chatId: realId });
    }
    const full = { ...m, chatId: realId, accountId: a.info.id };
    try { this.store.putMessages([full]); } catch { /* archive best effort */ }
    this.emitC("message", full); // every connected UI sees it (other windows, scheduled sends, mesh relays), not only the one that asked
    return full;
  }
  private async chatOp(method: "startChat" | "createGroup", p: any) {
    const [a] = this.resolveAccount(p.accountId);
    const conn = this.need(a);
    const fn = (conn as any)[method];
    if (typeof fn !== "function") throw new Error(`${a.info.provider} does not support ${method}`);
    const c = await withTimeout<Chat>(method === "startChat" ? fn.call(conn, p.handle) : fn.call(conn, p.name, p.handles), 45_000, "The messenger");
    const chat = { ...c, id: `${a.info.id}:${c.id}`, accountId: a.info.id, spaceId: c.spaceId && `${a.info.id}:${c.spaceId}` };
    if (chat.provisional) this.provisional.set(chat.id, chat);
    this.emit("chats-changed", { accountId: a.info.id, chatId: chat.id });
    return chat;
  }
  /**
   * Profile picture. Order: memory cache (hits 6h, misses 10min) -> the durable store (see avatarstore.ts; works signed out / offline / on a paired
   * device that never had the account live) -> the live connector (at most 3 at a time), which also refreshes a stored picture older than the TTL
   * or one the provider reported as changed. A failed refresh keeps the old picture. Merged chats resolve through their members.
   */
  private async avatar(kind: "chat" | "space" | "contact" | "emoji", id: string, full = false): Promise<{ dataBase64: string; mime: string } | null> {
    const mg = this.merges.get(id);
    if (mg) { for (const c of [mg.primary, ...mg.members.filter((x) => x !== mg.primary)]) { const r = await this.avatar(kind, c, full); if (r) return r; } return null; }
    const key = avatarKey(kind, id, full), hit = this.avatarCache.get(key);
    if (hit && Date.now() - hit.at < (hit.v ? 6 * 3600_000 : 600_000)) return hit.v;
    const out = (s?: { data: Uint8Array; mime: string }) => (s?.data.length ? { dataBase64: Buffer.from(s.data).toString("base64"), mime: s.mime } : null);
    const remember = (v: { dataBase64: string; mime: string } | null) => { if (this.avatarCache.size > 600) this.avatarCache.delete(this.avatarCache.keys().next().value!); this.avatarCache.set(key, { at: Date.now(), v }); return v; };
    let stored: ReturnType<Store["getAvatar"]>; try { stored = this.store.getAvatar(key); } catch { stored = undefined; }
    const real = stored && !stored.empty && !stored.gone && stored.data.length ? stored : undefined, now = Date.now();
    let a: Acc | undefined, native = "";
    try { [a, native] = this.resolve(id); } catch { a = undefined; }
    const live = !!(a?.conn && !this.offlineKind(a) && a.conn.avatar);
    const hint = this.avatarHints.get(`${kind}|${id}`), sb = a ? this.avatarStaleBefore.get(a.info.id) : undefined;
    const stale = this.avatarStale.has(key) || (!!real && sb !== undefined && real.fetchedAt <= sb) || (!!real && hint !== undefined && real.rev !== hint);
    const recent = kind === "chat" && now - (this.recentChats.get(id) ?? 0) < AVATAR_OPEN_WINDOW_MS;
    const ttl = hint !== undefined ? AVATAR_TTL_HINTED_MS : recent ? AVATAR_TTL_OPEN_MS : AVATAR_TTL_MS; // a matching provider hint is trusted longer; no hint + recently opened chat = shorter
    if (real && !stale && (now - real.fetchedAt < ttl || !live)) return remember(out(real));
    if (!live) return real ? remember(out(real)) : (hit?.v ?? null); // nothing to ask: whatever we have (a miss is not remembered: sync may deliver it)
    if (!real && !stale && stored?.empty && now - stored.fetchedAt < AVATAR_NEGATIVE_MS) return remember(null);
    while (this.avatarActive >= 3) await new Promise<void>((r) => this.avatarQueue.push(r));
    this.avatarActive++; this.avatarFetches++;
    let got: { data: Uint8Array; mime: string } | undefined, failed = false;
    try { const r = await a!.conn!.avatar!({ kind, id: native, ...(full ? { full: true } : {}) }); if (r?.data?.length) got = r; }
    catch { failed = true; /* rate limited / offline: treat as none for now, keep what we have */ }
    finally { this.avatarActive--; this.avatarQueue.shift()?.(); }
    this.avatarStale.delete(key); this.avatarLastFailed = failed;
    if (got) {
      const v = out(got);
      if (got.data.length <= AVATAR_MAX_BYTES) {
        const sha = avatarSha(got.data);
        try {
          if (real && real.sha === sha) this.store.putAvatar({ ...real, fetchedAt: Date.now(), ...(hint !== undefined ? { rev: hint } : {}) }); // unchanged: just younger
          else { this.store.putAvatar(makeAvatar(key, got.data, got.mime, Date.now(), hint)); if (real) this.emit("avatars-changed", { keys: [key] }); }
          if (++this.avatarWrites % 50 === 0) pruneAvatarStore(this.store);
        } catch { /* a full disk must not break showing the picture */ }
      }
      return remember(v);
    }
    if (real) return remember(out(real)); // refresh failed or the provider returned nothing: keep the old picture, retry later
    if (!failed) { try { this.store.putAvatar({ ...emptyAvatar(key), ...(hint !== undefined ? { rev: hint } : {}) }); } catch { /* ignore */ } }
    return remember(null);
  }
  /** Make every remembered "no picture" (optionally only of one account) stale, so the next ask goes to the provider again. Pictures are untouched. */
  forgetAvatarMisses(accountId?: string): { forgotten: number } {
    let n = 0, after: string | undefined;
    for (;;) {
      const page = this.store.listAvatars({ ...(after ? { after } : {}), limit: 500 }); if (!page.length) break;
      for (const m of page) {
        after = m.key; if (m.state !== "none" || (accountId && !m.key.includes(`|${accountId}:`))) continue;
        const row = this.store.getAvatar(m.key); if (row && row.empty) { this.store.putAvatar({ ...row, fetchedAt: 1 }); n++; }
      }
      if (page.length < 500) break;
    }
    for (const [k, v] of [...this.avatarCache]) if (!v.v && (!accountId || k.includes(`|${accountId}:`))) this.avatarCache.delete(k);
    this.emit("avatars-changed", { keys: [] });
    return { forgotten: n };
  }
  private scheduleWarm(delayMs = this.avatarWarmDelayMs) {
    if (this.avatarWarmT || this.closing) return;
    this.avatarWarmT = setTimeout(() => { this.avatarWarmT = undefined; void this.warmAvatars().catch(() => {}); }, delayMs); this.avatarWarmT.unref?.();
  }
  /**
   * Background warm-up of the durable avatar store on a device with live connectors, so the store (and through it the device sync) holds pictures nobody
   * scrolled to: all spaces/communities, then chats in local folders, then the 300 most recently active chats. Only what is missing or stale is fetched
   * (avatar() applies the TTL / hint / negative-cache rules and the 3-at-a-time queue), one provider request per `avatarWarmGapMs`; errors back off
   * exponentially and five in a row end the run (the next connect or the 6-hourly repeat tries again). Paused by `setAvatarWarmPaused`.
   */
  async warmAvatars(): Promise<{ asked: number; fetched: number }> {
    if (this.avatarWarmRunning || this.avatarWarmPaused || this.closing) return { asked: 0, fetched: 0 };
    this.avatarWarmRunning = true; let asked = 0; const f0 = this.avatarFetches;
    try {
      const live = new Set([...this.accounts].filter(([, a]) => a.conn && !this.offlineKind(a) && a.conn.avatar).map(([id]) => id));
      if (!live.size) return { asked: 0, fetched: 0 };
      const { spaces, chats } = await this.collect(), acctOf = (id: string) => id.slice(0, id.indexOf(":")), mine = chats.filter((c) => live.has(acctOf(c.id)));
      const inFolders = new Set(Object.keys(this.store.listChatFolders()));
      const recent = [...mine].sort((x, y) => (y.lastMessageAt ?? "").localeCompare(x.lastMessageAt ?? "")).slice(0, 300);
      const todo: ["chat" | "space", string][] = [];
      const seen = new Set<string>(), add = (k: "chat" | "space", id: string) => { if (!seen.has(k + id)) { seen.add(k + id); todo.push([k, id]); } };
      for (const sp of spaces) if (live.has(acctOf(sp.id)) && !sp.local) add("space", sp.id);
      for (const c of mine) if (inFolders.has(c.id)) add("chat", c.id);
      for (const c of recent) add("chat", c.id);
      let fails = 0, backoff = this.avatarWarmGapMs;
      for (const [kind, id] of todo) {
        if (this.avatarWarmPaused || this.closing) break;
        const before = this.avatarFetches; asked++;
        await this.avatar(kind, id, false).catch(() => null);
        if (this.avatarFetches === before) continue; // answered from the store: no provider traffic
        if (this.avatarLastFailed) { if (++fails >= 5) break; backoff = Math.min(60_000, backoff * 2); await new Promise((r) => setTimeout(r, backoff)); }
        else { fails = 0; backoff = this.avatarWarmGapMs; await new Promise((r) => setTimeout(r, this.avatarWarmGapMs)); }
      }
    } finally { this.avatarWarmRunning = false; }
    return { asked, fetched: this.avatarFetches - f0 };
  }
  /** Mark pictures stale (and forget memory copies); `refresh` also re-fetches them right now where a connector is live. Emits avatars-changed for the keys. */
  private async refreshAvatars(keys: string[], refresh: boolean) {
    for (const k of keys) { this.avatarStale.add(k); this.avatarCache.delete(k); }
    if (refresh) for (const k of keys.slice(0, 40)) { const m = /^(chat|space|contact|emoji)\|(.+?)(\|full)?$/.exec(k); if (m) await this.avatar(m[1] as "chat", m[2], !!m[3]).catch(() => null); }
    if (keys.length) this.emit("avatars-changed", { keys });
  }
  /** Pictures of an account whose bytes equal `sha` (= the user's own old picture, shown in several places) as store keys. */
  private avatarKeysWithSha(accountId: string, sha: string): string[] {
    const out: string[] = []; let after: string | undefined;
    for (let g = 0; g < 100; g++) {
      const page = this.store.listAvatars({ after, limit: 500 }); if (!page.length) break;
      for (const m of page) if (m.state === "pic" && m.sha === sha && avatarKeyId(m.key).startsWith(accountId + ":")) out.push(m.key);
      after = page[page.length - 1].key; if (page.length < 500) break;
    }
    return out;
  }
  /** The user's own picture changed (profile UI) or the provider says so: refresh the stored copies now (they sync to the paired devices from there). */
  private async ownAvatarChanged(accountId: string, oldSha?: string) {
    const keys = oldSha ? this.avatarKeysWithSha(accountId, oldSha) : [];
    if (keys.length) return this.refreshAvatars(keys, true);
    this.avatarStaleBefore.set(accountId, Date.now()); this.avatarCache.clear(); // old picture unknown: every picture of the account refreshes on next use
    this.emit("avatars-changed", { keys: [], account: accountId });
  }
  /** The provider's chat/space lists carry a picture hint (a changing value = a changed picture): mark those pictures for refresh. */
  private noteOpened(chatId: unknown) {
    if (typeof chatId !== "string") return;
    const mg = this.merges.get(chatId), ids = mg ? mg.members : [chatId];
    for (const c of ids) { this.recentChats.delete(c); this.recentChats.set(c, Date.now()); }
    while (this.recentChats.size > 500) this.recentChats.delete(this.recentChats.keys().next().value!);
  }
  private noteAvatarHints(chats: { id: string; avatarUrl?: string; avatarRev?: string }[], spaces: { id: string; iconUrl?: string; avatarRev?: string }[]) {
    const changed: string[] = [];
    for (const [kind, list] of [["chat", chats], ["space", spaces]] as const) for (const x of list as { id: string; avatarUrl?: string; iconUrl?: string; avatarRev?: string }[]) {
      const raw = x.avatarRev ?? x.avatarUrl ?? x.iconUrl; if (!raw) continue;
      const h = x.avatarRev ? x.avatarRev.slice(0, 200) : createHash("sha1").update(raw).digest("hex"), hk = `${kind}|${x.id}`, old = this.avatarHints.get(hk); this.avatarHints.set(hk, h);
      if (old !== undefined && old !== h) for (const k of [hk, hk + "|full"]) { this.avatarStale.add(k); this.avatarCache.delete(k); changed.push(k); }
    }
    if (changed.length) this.emit("avatars-changed", { keys: changed });
  }
  private async spaceOp(method: "createSpace" | "joinSpace", p: any) {
    const [a] = this.resolveAccount(p.accountId);
    const conn = this.need(a);
    const fn = (conn as any)[method];
    if (typeof fn !== "function") throw new Error(`${a.info.provider} does not support ${method === "createSpace" ? "creating" : "joining"} communities`);
    const s = method === "createSpace" ? await fn.call(conn, p.name, p.description) : await fn.call(conn, p.invite);
    this.emit("spaces-changed", { accountId: a.info.id });
    return { ...s, id: `${a.info.id}:${s.id}`, accountId: a.info.id };
  }
  private profileOut(pr: Profile) { return { displayName: pr.displayName, about: pr.about, handle: pr.handle, avatar: pr.avatar ? { dataBase64: Buffer.from(pr.avatar.data).toString("base64"), mime: pr.avatar.mime } : null }; }
  private async leaveSpace(globalSpaceId: string) {
    const [a, native] = this.resolve(globalSpaceId);
    const conn = this.need(a);
    if (!conn.leaveSpace) throw new Error(`${a.info.provider} can't leave communities from UniChat`);
    await conn.leaveSpace(native);
    this.emit("spaces-changed", { accountId: a.info.id }); this.emit("chats-changed", { accountId: a.info.id });
  }
  /** Re-send a message into another chat, re-uploading attachments (from the media cache or the source connector). */
  private async forward(m: Message, toChatId: string) {
    const [src, native] = this.resolve(m.chatId);
    const attachments = await Promise.all((m.attachments ?? []).map(async (att) => {
      const cached = this.media.get(src.info.id, `${m.chatId}|${m.id}|${att.id}`);
      const r = cached ?? await this.need(src).downloadAttachment(native, m.id, att.id);
      return { kind: att.kind, mime: r.mime, name: r.name ?? att.name, data: r.data };
    }));
    return this.sendTo(toChatId, { text: m.text, attachments, location: m.location, contacts: m.contacts, forwarded: true });
  }

  // ---------------------------------------------------------------- merged chats
  // A merge is a LOCAL view over several 1:1 chats of the same person (other accounts / apps). Messages are never copied or moved:
  // every message keeps its real `chatId` (so attachments, react, edit, delete, vote, forward, markRead and replies keep routing to the
  // owning provider) and events/history rows additionally carry `mergeId` = the merged chat they belong to.
  private loadMerges() {
    const all = this.store.listMerges();
    this.dismissedMerges = new Set(all.filter((m) => m.dismissed).map((m) => m.id));
    this.merges = new Map(all.filter((m) => !m.dismissed).map((m) => [m.id, m]));
    this.reindexMerges();
  }
  /**
   * Provider-declared duplicates (Chat.sameAs, e.g. Signal PNI + ACI chat of one person) become ONE merged row, using the ordinary merge
   * machinery (unified timeline, unread sum, send routing, sync kind "me"): id = hash of the pair, so every device derives the same record.
   * The target (sameAs) is primary and the send target. A pair the user unmerged stays unmerged (tombstone). Idempotent.
   */
  private ensureAutoMerges(chats: Chat[]) {
    const byId = new Map(chats.map((c) => [c.id, c])); let changed = "";
    for (const c of chats) {
      const t = c.sameAs && c.sameAs !== c.id ? byId.get(c.sameAs) : undefined;
      if (!t || c.kind !== "dm" || t.kind !== "dm" || c.accountId !== t.accountId) continue;
      const id = "merge:auto:" + createHash("sha1").update([c.id, t.id].sort().join("\n")).digest("hex").slice(0, 24);
      if (this.dismissedMerges.has(id)) continue;
      const mc = this.mergeOf.get(c.id), mt = this.mergeOf.get(t.id);
      if (mc && mc === mt) continue; // already together
      if (mc && !(mt)) continue; // the duplicate is in a merge of the user's: leave it
      if (mt) { const mg = this.merges.get(mt)!; this.saveMerge({ ...mg, members: [...mg.members, c.id] }); changed = mt; continue; }
      this.saveMerge({ id, members: [t.id, c.id], primary: t.id, sendVia: t.id, createdAt: new Date().toISOString(), auto: true }); changed = id;
    }
    if (changed) this.emit("chats-changed", { mergeId: changed });
  }
  private reindexMerges() {
    this.mergeOf = new Map();
    for (const m of this.merges.values()) for (const c of m.members) this.mergeOf.set(c, m.id);
  }
  private saveMerge(mg: ChatMerge) { this.merges.set(mg.id, mg); this.store.putMerge(mg); this.reindexMerges(); }
  private dropMerge(id: string, hard = false) {
    const mg = this.merges.get(id);
    this.merges.delete(id); this.reindexMerges();
    if (mg?.auto && !hard) { this.dismissedMerges.add(id); this.store.putMerge({ ...mg, dismissed: true }); } else this.store.deleteMerge(id);
    this.store.setChatFlags(id, {}); this.store.setAlias(id, null); this.store.setChatFolder(id, null); this.reloadAliases();
  }
  private accountIdOf(chatId: string): string | undefined { try { return this.resolve(chatId)[0].info.id; } catch { return undefined; } }
  private static cmp = (a: Message, b: Message) =>
    (Date.parse(a.time) - Date.parse(b.time)) || a.time.localeCompare(b.time) || Number(!!a.system) - Number(!!b.system) || a.id.localeCompare(b.id) || a.chatId.localeCompare(b.chatId);

  /** The member chat a message of a merged chat belongs to. */
  private ownerOf(mg: ChatMerge, messageId: string): string | undefined { return mg.members.find((c) => !!this.store.getMessage(c, messageId)); }
  /** Which member holds the newest message (incoming or outgoing); undefined if there are no messages. */
  private lastVia(mg: ChatMerge): string | undefined {
    let best: Message | undefined;
    for (const c of mg.members) { const m = this.store.listMessages(c, { limit: 1 })[0]; if (m && (!best || Hub.cmp(m, best) > 0)) best = m; }
    return best?.chatId;
  }
  /** The member chat a send through a merged chat goes to: explicit `via`, else the user's saved choice, else where the last message was. */
  private sendTarget(chatId: string, via?: string): string {
    if (!isMergeId(chatId)) return chatId;
    const mg = this.merges.get(chatId); if (!mg) throw new Error("This merged chat no longer exists.");
    const t = via ?? (mg.sendVia && mg.members.includes(mg.sendVia) ? mg.sendVia : undefined) ?? this.lastVia(mg) ?? (mg.members.includes(mg.primary) ? mg.primary : mg.members[0]);
    if (!t || !mg.members.includes(t)) throw new Error("That chat is not part of this merge.");
    return t;
  }
  /** Rewrite a call addressed to a merged chat into one addressed to the member chat that owns the target. */
  private redirectMerged(method: string, p: any) {
    const mg = this.merges.get(p.chatId);
    switch (method) {
      case "history": case "search": case "send": case "scheduleMessage": case "forward": case "members": case "setChatFlags": case "setAlias": case "markRead": case "chatMedia": case "markChatRead": case "pins": return p;
      case "attachment": case "react": case "pin": case "edit": case "delete": case "vote": case "editEvent": {
        if (!mg) throw new Error("This merged chat no longer exists.");
        const owner = (p.messageId && this.ownerOf(mg, p.messageId)) || undefined;
        if (!owner) throw new Error("That message is not part of this merged chat.");
        return { ...p, chatId: owner };
      }
      default: return { ...p, chatId: this.sendTarget(p.chatId, p.via) };
    }
  }

  private async mergedRow(mg: ChatMerge): Promise<Chat | undefined> {
    const snap = await this.snapshot();
    return snap.chats.find((c) => c.id === mg.id);
  }
  /** Raw chats by id (all accounts). */
  private async chatIndex() { const { chats } = await this.collect(); return new Map(chats.map((c) => [c.id, c])); }

  /**
   * Merge 1:1 chats into one. `chatIds` may contain ids of existing merges (they are extended / combined into the first one).
   * Only DMs can be merged (never groups, channels or mesh groups); a chat can belong to at most one merge.
   */
  private async mergeChats(chatIds: string[], name?: string): Promise<Chat> {
    const ids = [...new Set(chatIds.filter(Boolean))];
    const mergeIds = ids.filter(isMergeId), plain = ids.filter((i) => !isMergeId(i));
    for (const id of mergeIds) if (!this.merges.has(id)) throw new Error("This merged chat no longer exists.");
    const index = await this.chatIndex();
    for (const id of plain) {
      if (MeshRelay.isMesh(id)) throw new Error("Mesh groups can't be merged.");
      const c = index.get(id);
      if (!c) throw new Error("One of these chats doesn't exist (any more).");
      if (c.kind !== "dm") throw new Error(`“${c.name}” isn't a 1:1 chat. Only direct messages can be merged.`);
      const other = this.mergeOf.get(id);
      if (other && !mergeIds.includes(other)) throw new Error(`“${c.name}” is already part of a merged chat. Unmerge it first.`);
    }
    const members = [...mergeIds.flatMap((m) => this.merges.get(m)!.members), ...plain];
    if (new Set(members).size < 2) throw new Error("Pick at least two different chats to merge.");
    const base = mergeIds.length ? this.merges.get(mergeIds[0])! : undefined;
    const mg: ChatMerge = base ?? { id: `merge:${randomUUID()}`, members: [], primary: plain[0], createdAt: new Date().toISOString() };
    mg.members = [...new Set(members)];
    if (name !== undefined && name.trim()) mg.name = name.trim();
    for (const extra of mergeIds.slice(1)) this.dropMerge(extra);
    this.saveMerge(mg);
    this.emit("chats-changed", { mergeId: mg.id });
    const row = await this.mergedRow(mg);
    if (!row) throw new Error("Couldn't build the merged chat.");
    return row;
  }
  private unmergeChat(mergeId: string) {
    if (!this.merges.has(mergeId)) throw new Error("This merged chat no longer exists.");
    this.dropMerge(mergeId);
    this.emit("chats-changed", { mergeId });
    return {};
  }
  private removeMergeMember(mergeId: string, chatId: string) {
    const mg = this.merges.get(mergeId); if (!mg) throw new Error("This merged chat no longer exists.");
    if (!mg.members.includes(chatId)) throw new Error("That chat is not part of this merge.");
    const rest = mg.members.filter((c) => c !== chatId);
    if (rest.length < 2) this.unmergeChat(mergeId); // a merge of one chat is pointless: dissolve it
    else {
      const next: ChatMerge = { ...mg, members: rest, primary: mg.primary === chatId ? rest[0] : mg.primary };
      if (next.sendVia === chatId) delete next.sendVia;
      this.saveMerge(next); this.emit("chats-changed", { mergeId });
    }
    return {};
  }
  /** `quiet`: a change that only affects the list row (e.g. the remembered send-via), so open timelines must not reload. */
  private editMerge(mergeId: string, f: (mg: ChatMerge) => void, quiet = false) {
    const cur = this.merges.get(mergeId); if (!cur) throw new Error("This merged chat no longer exists.");
    const mg = { ...cur, members: [...cur.members] }; f(mg); this.saveMerge(mg);
    this.emit("chats-changed", quiet ? { mergeId, quiet: true } : { mergeId }); return {};
  }
  /** After an account is gone: its chats leave every merge. A merge keeps living (showing what remains) until no member is left. */
  private pruneMerges(accountId: string) {
    const prefix = accountId + ":";
    for (const mg of [...this.merges.values()]) {
      if (!mg.members.some((c) => c.startsWith(prefix))) continue;
      const rest = mg.members.filter((c) => !c.startsWith(prefix));
      if (!rest.length) { this.dropMerge(mg.id, true); continue; }
      const next: ChatMerge = { ...mg, members: rest, primary: rest.includes(mg.primary) ? mg.primary : rest[0] };
      if (next.sendVia && !rest.includes(next.sendVia)) delete next.sendVia;
      this.saveMerge(next);
      this.emit("history-updated", { chatId: mg.id, mergeId: mg.id }); // the unified timeline lost a source: UIs reload it
    }
  }

  /** The merged rows (one per merge), with the member chats flagged `mergedInto` so UIs can hide them. */
  /** Reading a chat (any way) remembers WHERE the user has read up to (the newest incoming message), so a reload / restart / another device does not bring the unread count back for providers that cannot store a read state themselves. */
  /** Groups (and the communities they belong to) that you share with the person of a direct chat: the person must be listed among the group's members. Cached for a few minutes. */
  private commonCache = new Map<string, { at: number; v: { groups: Chat[]; communities: { id: string; name: string }[] } }>();
  private async commonChats(chatId: string) {
    const hit = this.commonCache.get(chatId); if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
    const { chats, spaces } = await this.collect();
    const dms = isMergeId(chatId) ? (this.merges.get(chatId)?.members ?? []) : [chatId], groups: Chat[] = [];
    const mutual = new Set<string>(); // communities the network itself reports as shared (Connector.mutualSpaces)
    for (const dm of dms) {
      const [a] = (() => { try { return this.resolve(dm); } catch { return [undefined] as const; } })(); if (!a) continue;
      const live = !!a.conn && !this.offlineKind(a), peers = new Set<string>([dm.slice(a.info.id.length + 1)]);
      // who is "the person": whoever writes in the DM (never you); a DM's member list contains you as well, which would match EVERY group
      const own = new Set<string>(), theirs = new Set<string>();
      try { for (const m of this.store.listMessages(dm, { limit: 300 })) { if (m.system) continue; (m.fromMe ? own : theirs).add(m.senderId); } } catch { /* none stored */ }
      for (const t of theirs) peers.add(t);
      if (live && (own.size || theirs.size)) { try { for (const c of (await this.call("members", { chatId: dm })) as { id: string }[]) if (!own.has(c.id)) peers.add(c.id); } catch { /* the chat id alone then */ } }
      for (const o of own) peers.delete(o);
      if (live && a.conn!.mutualSpaces) await Promise.all([...peers].slice(0, 3).map(async (peer) => {
        try { for (const sid of await Promise.race([a.conn!.mutualSpaces!(peer), new Promise<never>((_, no) => setTimeout(() => no(new Error("slow")), 8000))])) mutual.add(`${a.info.id}:${sid}`); } catch { /* the shared groups' communities then */ }
      }));
      const mine = chats.filter((c) => c.id.startsWith(a.info.id + ":") && (c.kind === "group" || c.kind === "channel") && !c.mergedInto);
      const inArchive = (g: Chat) => { try { return this.store.listMessages(g.id, { limit: 400 }).some((m) => !m.fromMe && peers.has(m.senderId)); } catch { return false; } }; // signed-out / relayed accounts: whoever wrote in the group
      let i = 0;
      await Promise.all(Array.from({ length: 4 }, async () => { // a few groups at a time: asking a messenger for every member list is slow
        while (i < mine.length) {
          const g = mine[i++]!; let hit = false;
          if (live) { try { const m = await Promise.race([a.conn!.members(g.id.slice(a.info.id.length + 1)), new Promise<never>((_, no) => setTimeout(() => no(new Error("slow")), 8000))]); hit = m.some((x) => peers.has(x.id)); } catch { hit = inArchive(g); } }
          else hit = inArchive(g);
          if (hit) groups.push(g);
        }
      }));
    }
    // shared communities: the ones the network names, plus those of the shared groups (signed-out / relayed accounts: where the person wrote)
    const ids = new Set([...groups.map((g) => g.spaceId).filter((x): x is string => !!x), ...mutual]);
    const v = { groups: groups.sort((x, y) => (y.lastMessageAt ?? "").localeCompare(x.lastMessageAt ?? "")), communities: spaces.filter((sp) => ids.has(sp.id)).map((sp) => ({ id: sp.id, name: sp.name, accountId: sp.accountId, provider: sp.provider, ...(sp.iconUrl ? { iconUrl: sp.iconUrl } : {}), ...(sp.avatarRev ? { avatarRev: sp.avatarRev } : {}) })) };
    this.commonCache.set(chatId, { at: Date.now(), v }); return v;
  }
  noteRead(chatId: string): void {
    if (isMergeId(chatId)) { for (const m of this.merges.get(chatId)?.members ?? []) this.noteRead(m); return; }
    try {
      const m = this.store.listMessages(chatId, { limit: 20 }).reverse().find((x) => !x.fromMe && !x.system); if (!m) return;
      const f = this.store.listChatFlags()[chatId] ?? {};
      if (f.readUpTo && f.readUpTo >= m.time && !f.unreadMark) return;
      this.store.setChatFlags(chatId, { ...f, unreadMark: false, readUpTo: m.time });
    } catch { /* best effort */ }
  }
  /** Reading a chat (any way) drops a manual "mark as unread". */
  private clearUnreadMark(chatId: string) { const f = this.store.listChatFlags()[chatId]; if (f?.unreadMark) { this.store.setChatFlags(chatId, { ...f, unreadMark: false }); this.emit("chats-changed", { chatId }); } }
  private withMerges(chats: Chat[], alias: Record<string, string>, flags: Record<string, { pinned?: boolean; muted?: boolean; archived?: boolean; unreadMark?: boolean }>): Chat[] {
    if (!this.merges.size) return chats;
    const byId = new Map(chats.map((c) => [c.id, c]));
    const rows: Chat[] = [];
    for (const mg of this.merges.values()) {
      const have = mg.members.map((id) => byId.get(id)).filter((c): c is Chat => !!c);
      if (!have.length) continue; // every member chat is gone from the lists: keep the merge stored, show nothing
      const primary = byId.get(mg.primary) ?? have[0];
      const ordered = [primary, ...have.filter((c) => c !== primary)];
      for (const c of have) byId.set(c.id, Object.assign(c, { mergedInto: mg.id }));
      const newest = have.reduce((a, b) => ((b.lastMessageAt ?? "") > (a.lastMessageAt ?? "") ? b : a));
      const f = flags[mg.id], unread = have.reduce((n, c) => n + (c.unread ?? 0), 0) || (f?.unreadMark ? 1 : 0), def = mg.name ?? primary.name;
      const off = have.every((c) => c.offline) ? have[0].offline : undefined;
      rows.push({
        id: mg.id, accountId: "", provider: "merged", kind: "dm", name: alias[mg.id] ?? def, ...(alias[mg.id] ? { originalName: def } : {}),
        avatarUrl: primary.avatarUrl, ...(unread ? { unread } : {}), ...(unread && (!have.some((c) => c.unread) || have.some((c) => c.unread && c.unreadApprox)) ? { unreadApprox: true } : {}), lastMessageAt: newest.lastMessageAt, preview: newest.preview,
        ...(f ? { pinned: f.pinned, muted: f.muted, archived: f.archived, ...(f.unreadMark ? { unreadMark: true } : {}) } : {}),
        ...(off ? { offline: off, readOnly: true } : {}),
        mergeMembers: ordered.map((c) => c.id), ...(mg.sendVia && mg.members.includes(mg.sendVia) ? { mergeSendVia: mg.sendVia } : {}), mergeLastVia: this.lastVia(mg) ?? newest.id,
      });
    }
    return [...chats, ...rows];
  }

  /** Unified timeline: the members' archives interleaved by time, paged by (time, id); each member is topped up from its provider like a normal chat. */
  private async mergedHistory(mergeId: string, limit: number, beforeId?: string, beforeChatId?: string, local = false): Promise<Message[]> {
    const mg = this.merges.get(mergeId); if (!mg) throw new Error("This merged chat no longer exists.");
    let anchor: Message | undefined;
    if (beforeId) for (const c of beforeChatId ? [beforeChatId] : mg.members) { anchor = this.store.getMessage(c, beforeId); if (anchor) break; }
    if (beforeId && !anchor) return [];
    const beforeTime = anchor?.time;
    const memberPage = (c: string) => this.store.listMessages(c, { beforeTime, limit });
    const combine = () => mg.members.flatMap(memberPage).sort(Hub.cmp).slice(-limit);
    let page = combine();
    const jobs: Promise<boolean>[] = [];
    for (const cid of mg.members) {
      let a: Acc, native: string;
      try { [a, native] = this.resolve(cid); } catch { continue; }
      if (local || !a.conn || this.offlineKind(a)) continue;
      const caps = this.factories.get(a.info.provider)?.capabilities;
      if (!(memberPage(cid).length < limit || caps?.backfill)) continue;
      const anchorId = beforeId ? (page.find((m) => m.chatId === cid)?.id ?? (anchor!.chatId === cid ? beforeId : undefined)) : undefined;
      if (beforeId && !anchorId) continue;
      jobs.push(this.topUp(a, cid, native, limit, anchorId));
    }
    if (jobs.length) {
      const all = Promise.all(jobs).then((r) => r.some(Boolean));
      const later = () => void all.then((changed) => { if (changed) this.emit("history-updated", { chatId: mergeId, mergeId }); });
      if (page.length > 0 && !beforeId) later();
      else {
        const done = await Promise.race([all.then((c) => ({ c })), new Promise<{ c: boolean; late: true }>((r) => setTimeout(() => r({ c: false, late: true }), 8000))]);
        if ("late" in done) later(); else if (done.c) page = combine();
      }
    }
    const lo = page.length >= limit ? page[0].time : "", hi = beforeTime ?? "9999";
    const accs = new Map<string, { a: Acc; cid: string }>();
    for (const cid of mg.members) { try { const [a] = this.resolve(cid); if (!accs.has(a.info.id)) accs.set(a.info.id, { a, cid }); } catch { /* account removed */ } }
    const marks = [...accs.values()].flatMap(({ a, cid }) => this.markersFor(a, cid, lo, hi, `${a.info.label}: `));
    return [...page.map((m) => this.named(this.accountIdOf(m.chatId) ?? "", m)), ...marks].sort(Hub.cmp).map((m) => ({ ...m, mergeId }));
  }
  private searchMerged(mergeId: string, q: string, limit: number): Message[] {
    const mg = this.merges.get(mergeId); if (!mg) throw new Error("This merged chat no longer exists.");
    return mg.members.flatMap((c) => this.store.searchMessages(c, q, limit)).sort(Hub.cmp).slice(-limit).map((m) => ({ ...this.named(this.accountIdOf(m.chatId) ?? "", m), mergeId }));
  }
  /** Mark every member read (each through its own provider, only where it supports it). */
  private async markReadMerged(mg: ChatMerge, p: any) {
    await Promise.allSettled(mg.members.map(async (cid) => {
      const [a, native] = this.resolve(cid);
      if (!a.conn || this.offlineKind(a)) return;
      const fn = (a.conn as any).markRead; if (typeof fn !== "function") return;
      const id = p.messageId && this.store.getMessage(cid, p.messageId) ? p.messageId : this.store.listMessages(cid, { limit: 30 }).reverse().find((m) => !m.fromMe)?.id;
      if (id) await fn.call(a.conn, native, id);
    }));
  }

  /** Likely other chats of the same person: same name (alias / provider name, ignoring case and accents), phone number or handle. */
  private async mergeSuggestions(chatId: string): Promise<{ chatId: string; reason: string }[]> {
    const index = await this.chatIndex();
    const base = isMergeId(chatId) ? (this.merges.get(chatId)?.members ?? []) : [chatId];
    const alias = this.store.listAliases();
    const norm = (s?: string) => (s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const digits = (s?: string) => { const d = (s ?? "").replace(/\D/g, "").replace(/^00/, ""); return d.length >= 7 && d.length / Math.max(1, (s ?? "").length) > 0.6 ? d : ""; };
    const local = (s?: string) => { if (!s || digits(s)) return ""; const l = s.replace(/^@/, "").split(":")[0].toLowerCase(); return l.length >= 3 ? l : ""; };
    interface Sig { names: Set<string>; phones: string[]; handles: Set<string> }
    const sig = async (c: Chat): Promise<Sig> => {
      const g: Sig = { names: new Set([norm(c.name), norm(c.originalName), norm(alias[c.id])].filter(Boolean)), phones: [], handles: new Set() };
      let acc: Acc | undefined, native = "";
      try { [acc, native] = this.resolve(c.id); } catch { return g; }
      const idPhone = /^\+?\d{7,}(@|$)/.test(native) ? digits(native.split("@")[0]) : ""; if (idPhone) g.phones.push(idPhone);
      try {
        const a = acc;
        if (a.conn && !this.offlineKind(a)) {
          const list = await Promise.race([a.conn.members(native), new Promise<never>((_, no) => setTimeout(() => no(new Error("slow")), 2500))]);
          for (const m of list.slice(0, 2)) { const ph = digits(m.handle); if (ph) g.phones.push(ph); const h = local(m.handle); if (h) g.handles.add(h); const n = norm(m.name); if (n) g.names.add(n); }
        }
      } catch { /* members unavailable: names and ids only */ }
      return g;
    };
    const baseSigs = await Promise.all(base.map((id) => index.get(id)).filter((c): c is Chat => !!c).map(sig));
    if (!baseSigs.length) return [];
    const samePhone = (a: string, b: string) => (a.length >= 9 && b.length >= 9 ? a.slice(-9) === b.slice(-9) : a === b);
    const cands = [...index.values()].filter((c) => c.kind === "dm" && !base.includes(c.id) && !this.mergeOf.has(c.id) && !MeshRelay.isMesh(c.id));
    const out: { chatId: string; reason: string; rank: number }[] = [];
    await Promise.all(cands.map(async (c) => {
      const s = await sig(c); let reason = "", rank = 9;
      for (const b of baseSigs) {
        if (rank > 0 && b.phones.some((x) => s.phones.some((y) => samePhone(x, y)))) { reason = "same phone number"; rank = 0; }
        else if (rank > 1 && [...b.handles].some((h) => s.handles.has(h))) { reason = "same handle"; rank = 1; }
        else if (rank > 2 && [...b.names].some((n) => s.names.has(n))) { reason = "same name"; rank = 2; }
      }
      if (reason) out.push({ chatId: c.id, reason, rank });
    }));
    return out.sort((x, y) => x.rank - y.rank || x.chatId.localeCompare(y.chatId)).map(({ chatId: id, reason }) => ({ chatId: id, reason }));
  }

  // ---------------------------------------------------------------- account lifecycle
  /** Sign out but keep everything we have: chats become a read-only archive. */
  private async signOut(id: string) {
    const [a] = this.resolveAccount(id);
    this.extras.media.cancel(id); // a running "download all media" must not race the logout
    if (!a.conn) return a.info; // already signed out
    // make sure the chat list is cached BEFORE the provider wipes its own state
    try { await this.snapshot(); } catch { /* cache may already be fresh */ }
    let warning: string | undefined;
    try { await a.conn.logout(); } catch (e) { warning = (e as Error).message || "Couldn't confirm that the device was removed from the account."; }
    await a.conn.stop().catch(() => {});
    a.conn = undefined; a.info.state = "signed-out"; this.refreshCaps(a);
    this.prompts.delete(id);
    this.store.putAccount({ id, provider: a.info.provider, label: a.info.label, status: "archived" });
    this.logEvent(a, "signed-out");
    try { rmSync(join(this.dataDir, id), { recursive: true, force: true }); } catch { /* provider session already wiped */ }
    this.emit("account", { id, state: "signed-out" });
    return { ...a.info, ...(warning ? { warning } : {}) };
  }

  /** Link the SAME account again (after a sign-out or an unlink); the archive is kept and continues. */
  private async signIn(id: string) {
    const [a] = this.resolveAccount(id);
    if (a.conn) { await a.conn.logout().catch(() => {}); await a.conn.stop().catch(() => {}); a.conn = undefined; } // unlinked-by-phone leftovers
    this.prompts.delete(id);
    a.info.state = "connecting";
    this.store.putAccount({ id, provider: a.info.provider, label: a.info.label, status: "active" });
    a.conn = this.makeConn(id, a.info.provider);
    try { a.conn.setPresenceEnabled?.(this.showPresence()); await a.conn.start((e) => this.onEvent(id, e)); }
    catch (e) { a.conn = undefined; a.info.state = "signed-out"; this.store.putAccount({ id, provider: a.info.provider, label: a.info.label, status: "archived" }); throw e; }
    this.refreshCaps(a);
    this.emit("account", { id, state: "connecting", ...(a.info.capabilities ? { capabilities: a.info.capabilities } : {}) });
    return a.info;
  }
  /** The user closed the link dialog of a re-sign-in: back to the read-only archive. */
  private async cancelSignIn(id: string) {
    const [a] = this.resolveAccount(id);
    if (a.conn) { await a.conn.stop().catch(() => {}); a.conn = undefined; }
    this.prompts.delete(id);
    a.info.state = "signed-out"; this.refreshCaps(a);
    this.store.putAccount({ id, provider: a.info.provider, label: a.info.label, status: "archived" });
    try { rmSync(join(this.dataDir, id), { recursive: true, force: true }); } catch { /* ignore */ }
    this.emit("account", { id, state: "signed-out" });
    return a.info;
  }

  /** `deleteData` = false is reserved for internal use; the UI offers "Sign out" (keep) and "Remove" (delete everything). */
  private async removeAccount(id: string, deleteData = true) {
    const [a] = this.resolveAccount(id);
    this.extras.media.cancel(id); // a running "download all media" must not race the logout
    let warning: string | undefined;
    if (a.conn) {
      try { await a.conn.logout(); } catch (e) { warning = (e as Error).message || "Couldn't confirm that the device was removed from the account."; }
      await a.conn.stop().catch(() => {});
    }
    this.accounts.delete(id);
    this.prompts.delete(id);
    for (const pid of [...this.provisional.keys()]) if (pid.startsWith(id + ":")) this.provisional.delete(pid);
    this.store.deleteAccount(id);
    this.pruneMerges(id);
    if (deleteData) { this.store.deleteAccountData(id); this.media.removeAccount(id); this.cacheSig.delete(id); }
    try { rmSync(join(this.dataDir, id), { recursive: true, force: true }); } catch { /* best effort: provider already wiped its session */ }
    this.emit("chats-changed", { accountId: id });
    return warning ? { warning } : {};
  }
  private resolveAccount(id: string): [Acc] {
    const a = this.accounts.get(id); if (!a) throw new Error(`unknown account ${id}`); return [a];
  }
  /** Pinned messages of a chat (or of every member of a merge, newest pin first). A connector that can list pins is asked (its answer fixes the archive flags); otherwise the archive decides. */
  private async pinsOf(chatId: string): Promise<Message[]> {
    const now = Date.now(), live = (m: Message) => m.pinned && !m.deleted && !(m.pinnedUntil && Date.parse(m.pinnedUntil) <= now);
    const one = async (cid: string): Promise<Message[]> => {
      try {
        const [a, native] = this.resolve(cid);
        const conn = a.conn && !this.offlineKind(a) ? a.conn : undefined;
        if (conn && typeof conn.pins === "function" && conn.capabilities?.pinMessages) {
          const listed = await withTimeout(conn.pins(native), 20_000, "The messenger");
          const ids = new Set<string>();
          for (const raw of listed) {
            const m = { ...raw, chatId: cid, accountId: a.info.id, pinned: true }; ids.add(m.id);
            if (this.store.getMessage(cid, m.id)) this.store.patchMessage(cid, m.id, { pinned: true, ...(m.pinnedAt ? { pinnedAt: m.pinnedAt } : {}), ...(m.pinnedBy ? { pinnedBy: m.pinnedBy } : {}), ...(m.pinnedUntil ? { pinnedUntil: m.pinnedUntil } : {}) });
            else this.store.putMessages([m]);
          }
          for (const m of this.store.listMessages(cid, { limit: 1e9 })) if (m.pinned && !ids.has(m.id)) this.store.patchMessage(cid, m.id, { pinned: false, pinnedAt: undefined, pinnedBy: undefined, pinnedUntil: undefined });
        }
      } catch { /* provider could not list: the archive answers */ }
      return this.store.listMessages(cid, { limit: 1e9 }).filter(live);
    };
    const mg = isMergeId(chatId) ? this.merges.get(chatId) : undefined;
    if (isMergeId(chatId) && !mg) throw new Error("This merged chat no longer exists.");
    const all = (await Promise.all((mg ? mg.members : [chatId]).map(one))).flat();
    const at = (m: Message) => m.pinnedAt ?? m.time;
    return all.sort((x, y) => (at(x) < at(y) ? 1 : at(x) > at(y) ? -1 : 0)).map((m) => (mg ? { ...m, mergeId: mg.id } : m));
  }
  /** Capability-gated optional calls (react/edit/delete/markRead/setTyping). */
  private async optional(globalId: string, method: string, p: any) {
    const [a, native] = this.resolve(globalId);
    if (this.provisional.has(globalId) && method === "leaveChat") { this.provisional.delete(globalId); this.emit("chats-changed", { accountId: a.info.id }); return; } // nothing exists on the network yet
    const conn = this.need(a);
    const fn = (conn as any)[method];
    if (typeof fn !== "function") throw new Error(`${a.info.provider} does not support ${method}`);
    switch (method) {
      case "acceptRequest": case "declineRequest": {
        await withTimeout(fn.call(conn, native), 30_000, "The messenger");
        this.emit("chats-changed", { accountId: a.info.id, chatId: globalId }); return;
      }
      case "react": {
        if (this.store.getMessage(globalId, p.messageId)?.deleted) throw new Error("This message was deleted, so it can no longer be reacted to.");
        return fn.call(conn, native, p.messageId, p.emoji ?? null);
      }
      case "pin": {
        const caps = (() => { try { return conn.capabilities; } catch { return undefined; } })();
        if (!caps?.pinMessages) throw new Error(`${a.info.provider} does not support pinning messages`);
        const old = this.store.getMessage(globalId, p.messageId);
        if (!old) throw new Error("That message is not in the archive.");
        if (old.deleted) throw new Error("This message was deleted, so it can no longer be pinned.");
        const pinned = p.pinned !== false, ds = caps.pinDurations;
        const dur = pinned && ds?.length ? (p.durationSec != null && ds.includes(Number(p.durationSec)) ? Number(p.durationSec) : ds.includes(604800) ? 604800 : ds[0]) : undefined;
        await withTimeout(fn.call(conn, native, p.messageId, pinned, dur !== undefined ? { durationSec: dur } : undefined), 30_000, "The messenger");
        const now = new Date();
        const patch: Partial<Message> = pinned ? { pinned: true, pinnedAt: now.toISOString(), pinnedUntil: dur ? new Date(now.getTime() + dur * 1000).toISOString() : undefined } : { pinned: false, pinnedAt: undefined, pinnedBy: undefined, pinnedUntil: undefined };
        // the network's own echo (message-update) may already have set richer fields: keep those
        const cur = this.store.getMessage(globalId, p.messageId);
        if (!!cur?.pinned !== pinned || (pinned && !cur?.pinnedAt)) { try { this.store.patchMessage(globalId, p.messageId, patch); } catch { /* best effort */ } this.emitC("message-update", { chatId: globalId, messageId: p.messageId, patch }); }
        return;
      }
      case "edit": return fn.call(conn, native, p.messageId, p.text);
      case "delete": return fn.call(conn, native, p.messageId);
      case "markRead": return fn.call(conn, native, p.messageId);
      case "setTyping": return fn.call(conn, native, !!p.typing);
      case "vote": { await fn.call(conn, native, p.messageId, p.optionIds ?? []); return; }
      case "editEvent": { await fn.call(conn, native, p.messageId, p.patch ?? {}); return; }
      case "refreshChat": return { message: await fn.call(conn, native) };
      case "leaveChat": { await fn.call(conn, native); this.store.deleteAvatars({ id: globalId }); this.emit("chats-changed", { accountId: a.info.id }); return; }
      case "addMembers": case "removeMember": {
        try { await (method === "addMembers" ? fn.call(conn, native, p.handles) : fn.call(conn, native, p.memberId)); }
        finally { this.emit("chats-changed", { accountId: a.info.id, chatId: globalId }); } // membership may have partly changed
        return;
      }
      case "setChatDescription": {
        const text = String(p.text ?? "").slice(0, 2048);
        await fn.call(conn, native, text);
        this.emit("chats-changed", { accountId: a.info.id, chatId: globalId }); return;
      }
      case "setChatPicture": {
        const img = p.dataBase64 ? { data: new Uint8Array(Buffer.from(String(p.dataBase64), "base64")), mime: String(p.mime || "image/jpeg") } : null;
        if (img && img.data.length > 5_000_000) throw new Error("That picture is too large.");
        await fn.call(conn, native, img);
        this.avatarCache.delete(`chat|${globalId}`); this.avatarCache.delete(`chat|${globalId}|full`); this.store.deleteAvatars({ id: globalId });
        this.emit("chats-changed", { accountId: a.info.id, chatId: globalId }); return;
      }
      case "renameChat": { await fn.call(conn, native, p.name); this.emit("chats-changed", { accountId: a.info.id, chatId: globalId }); return; }
      case "setDisappearing": {
        const secs = Math.round(Number(p.seconds));
        if (!Number.isFinite(secs) || secs < 0 || secs > 365 * 86400) throw new Error("That timer is not valid.");
        if (!(() => { try { return conn.capabilities.disappearing; } catch { return false; } })()) throw new Error(`${a.info.provider} cannot change the disappearing-messages timer from here`);
        await withTimeout(fn.call(conn, native, secs), 30_000, "The messenger");
        this.emit("chats-changed", { accountId: a.info.id, chatId: globalId }); return;
      }
      case "blockChat": { await withTimeout(fn.call(conn, native, !!p.blocked), 25_000, "The messenger"); this.emit("chats-changed", { accountId: a.info.id, chatId: globalId }); return; }
    }
  }
}
