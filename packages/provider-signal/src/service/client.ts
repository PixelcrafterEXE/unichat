import { createHash } from "node:crypto";
// SignalClient: owns the libsignal Net, the authenticated chat connection (receive loop + reconnect),
// linking, and the 1:1 write operations. The Connector in ../index.ts is a thin adapter around it.
import { ErrorCode, LibSignalErrorBase, Net } from "@signalapp/libsignal-client";
import type { Chat, CoreEvent, Message, OutgoingMessage, PrivacySetting, Profile, ProfilePatch } from "@unimsg/core";
import { EnvelopeCodec, EnvelopeType, type BodyRange, DataMessageFlags, ReceiptType, FetchLatestType, SyncRequestType, TypingAction, type Content, type DataMessage, type EditMessage } from "../protocol/codec.js";
import { SignalStore } from "../store/signalStore.js";
import type { KeyProvider } from "../store/secureFile.js";
import type { AuthChat } from "./chatTypes.js";
import { DEFAULT_DEVICE_NAME, USER_AGENT } from "./constants.js";
import { EnvelopeError, decryptEnvelope, normalizeEnvelope } from "./decrypt.js";
import { Inbound, messageId, parseMessageId } from "./inbound.js";
import { refreshKeys, uploadOneTimeKeys } from "./keys.js";
import { LinkAborted, completeLinking, waitForProvisionEnvelope } from "./linking.js";
import { groupIdFromMasterKey, isGroupChatId } from "./groups.js";
import { GroupResolver, GroupsHttpError, groupsDebug, httpsTransport } from "./groupState.js";
import { Sender, SendError, type DeliverResult } from "./sender.js";
import { SealedAccess, isAci } from "./sealed.js";
import { GroupEditError, GroupEditor, type GroupChangeResult } from "./groupModify.js";
import { fetchPreview, firstUrl, previewDebug, PreviewError, type FetchedPreview, type PreviewDeps } from "./linkPreview.js";
import { GroupMasterKey, GroupSecretParams } from "@signalapp/libsignal-client/dist/zkgroup/index.js";
import type { UnauthChat } from "./chatTypes.js";
import { PeerProfiles } from "./peerProfiles.js";
import { cleanName } from "./profileCrypto.js";
import { PeerAvatars } from "./peerAvatars.js";
import { StorageSync, httpsStorageTransport, keysRequestDelayMs, storageAuthViaChat, type StorageTransport } from "./storageSync.js";
import { resolveContactName } from "./contacts.js";
import { getOwnProfile, updateOwnProfile } from "./ownProfile.js";
import { applyVote, pollView, registerPoll } from "./polls.js";
import { Aci } from "@signalapp/libsignal-client";
import { downloadAttachment } from "./attachments.js";
import { attachDebug, checkAttachments, pinnedHttp, uploadAttachment, type CdnHttp, type SignalOutgoingAttachment } from "./attachmentUpload.js";
import { parseContactStream } from "./contacts.js";
import { renderPreview } from "./richContent.js";
import { LookupError, lookupE164, lookupUsername, parseHandle } from "./lookup.js";

export class NotImplementedError extends Error {
  constructor(what: string) { super(`Signal: ${what} is not implemented yet (see packages/provider-signal/README.md, TODO)`); this.name = "NotImplementedError"; }
}

/** Max age of the cached group member list before a send refreshes it (removed members must not keep receiving). */
const GROUP_STATE_MAX_AGE_MS = 5 * 60_000;

interface Target { chatId: string; group?: { masterKey: Uint8Array; revision: number; members: string[]; state: string } }

export interface ClientOptions { accountId: string; dataDir: string; keyProvider?: KeyProvider; deviceName?: string }

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export class SignalClient {
  readonly store: SignalStore;
  private net = new Net.Net({ env: Net.Environment.Production, userAgent: USER_AGENT });
  private emit: (e: CoreEvent) => void = () => {};
  private inbound!: Inbound;
  private groups!: GroupResolver;
  private sender: Sender;
  private chatConn?: AuthChat;
  private peerProfiles?: PeerProfiles;
  private peerAvatars?: PeerAvatars;
  private storageSync?: StorageSync;
  private storageTimer?: NodeJS.Timeout;
  private keysTimer?: NodeJS.Timeout;
  /** TESTS ONLY: replaces the Storage Service transport. */
  storageTransportOverride?: StorageTransport;
  private abort = new AbortController();
  private stopped = true;
  private reconnectTimer?: NodeJS.Timeout;
  private backoff = RECONNECT_MIN_MS;
  private queue: Promise<void> = Promise.resolve();
  private lastTs = 0;
  /** CDN transport for uploads (tests replace it with a fake). */
  private cdnHttp: CdnHttp = pinnedHttp;
  /** Link-preview fetcher (tests replace it; the default is the SSRF-safe fetcher). */
  private previewFetcher: (url: string) => Promise<FetchedPreview> = (url) => fetchPreview(url, this.previewDeps);
  /** TESTS ONLY hook for the default fetcher (injected resolver/transport/allowPrivate). */
  previewDeps: PreviewDeps = {};
  /** Smallest group (other members) that uses one sender-key multi-recipient request; smaller groups are cheaper pairwise. Tests lower it. */
  multiRecipientMin = 2;
  private unauthConn?: UnauthChat;
  private unauthPending?: Promise<UnauthChat | undefined>;
  private editor?: GroupEditor;
  /** Test seam: replaces the Groups v2 editor. */
  groupEditor?: GroupEditor;

  constructor(private readonly opts: ClientOptions) {
    this.store = new SignalStore(opts.dataDir, opts.keyProvider);
    this.sender = new Sender(this.store, () => this.requireChat(), {
      unauth: () => this.unauthChat(), unauthBroken: () => { void this.dropUnauth(); },
      sealed: new SealedAccess(this.store, () => this.requireChat()),
    });
  }

  /** Lazily opened unauthenticated connection for sealed sends (and zkgroup credential requests). Undefined when it can't be opened. */
  private async unauthChat(): Promise<UnauthChat | undefined> {
    if (this.unauthConn) return this.unauthConn;
    if (this.stopped) return undefined;
    this.unauthPending ??= (async () => {
      try {
        const c = await this.net.connectUnauthenticatedChat({ onConnectionInterrupted: () => { this.unauthConn = undefined; } }) as UnauthChat;
        this.unauthConn = c;
        return c;
      } catch { return undefined; }
      finally { this.unauthPending = undefined; }
    })();
    return this.unauthPending;
  }
  private async dropUnauth(): Promise<void> {
    const c = this.unauthConn; this.unauthConn = undefined;
    await c?.disconnect().catch(() => {});
  }

  // ---------- lifecycle ----------
  async start(emit: (e: CoreEvent) => void): Promise<void> {
    this.emit = (e) => { try { emit(e); } catch { /* rule 3: never throw from handlers */ } };
    this.stopped = false;
    this.abort = new AbortController();
    await this.store.load();
    this.makeInbound();
    this.store.onIdentityChanged = (address) => this.inbound.safetyNumberChanged(address);
    this.emit({ type: "account", data: { id: this.opts.accountId, state: "connecting" } });
    if (this.store.account) void this.connect();
    else void this.linkLoop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.storageTimer) clearInterval(this.storageTimer);
    if (this.keysTimer) clearTimeout(this.keysTimer);
    this.storageTimer = this.keysTimer = undefined;
    const c = this.chatConn; this.chatConn = undefined;
    await c?.disconnect().catch(() => {});
    await this.dropUnauth();
    await this.queue.catch(() => {});
    await this.store.flush().catch(() => {});
  }

  /** Delay before verifying a failed device removal (lets the server finish closing the connection). */
  private verifyDelayMs = 500;
  private loggingOut = false;

  /**
   * Is this account's linked-device credential still valid? Opens (and immediately closes) an authenticated connection.
   * "gone" = server says unlinked/unauthorized; "linked" = connected fine; "unknown" = anything else (network down, ...).
   */
  private async checkStillLinked(): Promise<"gone" | "linked" | "unknown"> {
    const a = this.store.account;
    if (!a) return "gone";
    try {
      const c = await this.net.connectAuthenticatedChat(`${a.aci}.${a.deviceId}`, a.password, false, {
        onIncomingMessage: () => {}, // never acked: stays queued on the server (device is being removed anyway)
        onQueueEmpty: () => {},
        onConnectionInterrupted: () => {},
      });
      await c.disconnect().catch(() => {});
      return "linked";
    } catch (e) {
      if (LibSignalErrorBase.is(e, ErrorCode.DeviceDelinked) || LibSignalErrorBase.is(e, ErrorCode.RequestUnauthorized)) return "gone";
      return "unknown";
    }
  }

  async logout(): Promise<void> {
    if (!this.store.data) await this.store.load();
    const dev = this.store.account?.deviceId;
    this.loggingOut = true; // the connection will drop: don't reconnect or report needs-login meanwhile
    // A linked device removes itself from the account. Removing it usually makes the server close the connection, so an
    // error here proves nothing: verify the outcome by trying our credentials instead of guessing.
    let confirmed = dev === undefined;
    if (dev !== undefined) {
      let removalError = false;
      try {
        if (!this.chatConn) throw new Error("not connected");
        await this.chatConn.removeDevice({ deviceId: dev });
        confirmed = true;
      } catch (e) {
        removalError = true;
        if (LibSignalErrorBase.is(e, ErrorCode.DeviceDelinked)) confirmed = true; // already removed on the phone
      }
      if (removalError && !confirmed) {
        await this.stop();
        await new Promise((r) => setTimeout(r, this.verifyDelayMs));
        confirmed = (await this.checkStillLinked()) === "gone";
      }
    }
    await this.stop();
    await this.store.wipe();
    if (!confirmed) {
      throw new Error("Couldn't reach Signal to remove this device. Remove it manually on your phone: Signal > Settings > Linked devices.");
    }
  }

  /** Test seam: replaces the Groups v2 resolver. */
  groupResolver?: GroupResolver;
  /** TESTS ONLY: replaces the HTTPS groups transport. */
  transportOverride?: import("./groupState.js").GroupsTransport;
  private groupsTransport() {
    if (this.transportOverride) return this.transportOverride;
    return httpsTransport(async (start, end) => {
      const res = await this.requireChat().fetch({
        verb: "GET", path: `/v1/certificate/auth/group?redemptionStartSeconds=${start}&redemptionEndSeconds=${end}`, headers: [],
      });
      if (res.status < 200 || res.status >= 300) throw new GroupsHttpError(res.status);
      return JSON.parse(Buffer.from(res.body ?? new Uint8Array()).toString("utf8"));
    });
  }
  /** Resolve every known group whose state we have never fetched (e.g. groups seen before this feature existed). */
  private resolveUnresolvedGroups(): void {
    let n = 0;
    for (const id of Object.keys(this.store.data.chats)) if (this.groups.needs(id)) { n++; void this.groups.request(id); }
    if (n) groupsDebug(`startup: unresolved groups count=${n}`);
    this.peerProfiles?.scanAll(); // people without a saved name: look up their profile name in the background
  }

  /** Storage Service: ask the primary for the storage key when missing (with backoff), sync when present, re-check every 30 min. */
  private startStorage(): void {
    if (this.storageTimer) clearInterval(this.storageTimer);
    this.storageTimer = setInterval(() => { void this.storageSync?.sync(); }, 30 * 60_000);
    this.storageTimer.unref?.();
    if (this.store.data.storage.key) void this.storageSync?.sync(); else this.requestKeys();
  }

  private requestKeys(): void {
    const st = this.store.data.storage;
    if (st.key || this.stopped) return;
    if (this.keysTimer) clearTimeout(this.keysTimer);
    const attempts = st.keysAttempts ?? 0;
    const wait = Math.max(0, (st.keysRequestedAt ?? 0) + keysRequestDelayMs(attempts) - Date.now());
    this.keysTimer = setTimeout(async () => {
      if (this.store.data.storage.key || this.stopped || !this.chatConn) return;
      try {
        await this.sender.deliver(this.ours, { syncMessage: { request: { type: SyncRequestType.KEYS } } }, this.nextTimestamp(), "sync", { urgent: false });
        st.keysRequestedAt = Date.now(); st.keysAttempts = attempts + 1; this.store.touch();
        if (process.env.UNIMSG_DEBUG) process.stderr.write(`[signal] storage: keys requested attempt=${attempts + 1}\n`);
      } catch { if (process.env.UNIMSG_DEBUG) process.stderr.write("[signal] storage: keys request failed\n"); }
      this.requestKeys(); // schedules the next attempt (silently gives up to weekly retries)
    }, wait);
    this.keysTimer.unref?.();
  }

  private makeInbound(): void {
    this.inbound = new Inbound(this.opts.accountId, this.store, this.emit);
    this.inbound.hooks.onContactsBlob = (ref, complete) => { void this.importContacts(ref, complete); };
    this.groups = this.groupResolver ?? new GroupResolver(this.store, () => this.groupsTransport(), this.emit);
    this.inbound.hooks.onGroupSeen = (id, revision) => { void this.groups.request(id, revision); };
    this.peerProfiles?.stop();
    this.peerProfiles = new PeerProfiles(this.store, () => this.chatConn, () => this.emit({ type: "chats-changed", data: {} }));
    this.peerAvatars = new PeerAvatars(this.store, () => this.chatConn, (aci) => {
      this.emit({ type: "avatar-changed", data: { id: aci, kind: "contact" } });
      this.emit({ type: "avatar-changed", data: { id: aci, kind: "chat" } });
    });
    this.inbound.hooks.onProfileKey = (aci) => { this.peerProfiles?.enqueue(aci); this.peerAvatars?.keyChanged(aci); };
    this.storageSync = new StorageSync(
      this.store,
      () => this.storageTransportOverride ?? (this.chatConn ? httpsStorageTransport(storageAuthViaChat(() => this.requireChat())) : undefined),
      {
        onChanged: () => this.emit({ type: "chats-changed", data: {} }),
        onProfileKey: (aci) => { this.peerProfiles?.enqueue(aci); this.peerAvatars?.keyChanged(aci); },
        onPni: (pni, aci) => { this.inbound.learnPni(pni, aci, "storage-record"); },
        onPniNumber: (pni, e164) => { this.inbound.notePniNumber(pni, e164, "storage-record"); },
        onNumber: (aci, e164) => { this.inbound.linkByNumber(aci, e164, "storage-record"); },
        onNewGroups: (ids) => { for (const id of ids) void this.groups.request(id); },
      },
    );
    this.inbound.hooks.onStorageKey = () => { void this.storageSync?.sync(); };
    this.inbound.hooks.onStorageManifestChanged = () => { void this.storageSync?.sync(); };
    this.ensureSelfChat();
  }

  /** "Note to Self" always exists, so there is a working chat even before any contact sync. */
  private ensureSelfChat(): void {
    const a = this.store.account;
    if (a && !this.store.data.chats[a.aci]) this.store.upsertChat({ id: a.aci, kind: "dm" });
  }

  // ---------- contact sync ----------
  private contactsRequested = false;

  /**
   * Signal Secure Backup import: merge profile keys (and names / numbers if missing) of the backup's contacts. Never overwrites an existing
   * key (storage sync and messages are authoritative); blocked contacts are skipped. Returns how many contacts got a NEW key.
   */
  importBackupContacts(list: { aci: string; profileKey?: string; name?: string; e164?: string; pni?: string }[]): number {
    const known = this.store.data.contacts; let added = 0, dirty = false;
    for (const it of list) {
      const id = String(it.aci ?? "").toLowerCase();
      if (it.pni) { try { this.inbound.learnPni(it.pni, id, "backup"); } catch { /* best effort */ } } // the backup names both identifiers of one person
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) || id === this.ours.toLowerCase()) continue;
      if (known[id]?.blocked || known[id]?.localBlocked) continue;
      const key = typeof it.profileKey === "string" && Buffer.from(it.profileKey, "base64").length === 32 ? Buffer.from(it.profileKey, "base64").toString("base64") : undefined;
      const nm = cleanName(it.name);
      if (!key && !nm && !it.e164) continue;
      const c = known[id] ?? { aci: id }; const before = JSON.stringify(c);
      if (key && !c.profileKey) { c.profileKey = key; delete c.sealedRejectedAt; delete c.unrestricted; delete c.profileNameCheckedAt; added++; }
      if (nm && !c.name && !c.systemName && !c.nickName && !c.profileName && !c.syncName) { c.syncName = nm; resolveContactName(c); }
      if (it.e164 && !c.number && /^\+\d{6,15}$/.test(it.e164)) c.number = it.e164;
      if (JSON.stringify(c) === before) continue;
      known[id] = c; dirty = true;
      if (key && c.profileKey === key && !before.includes(key)) { this.inbound.hooks.onProfileKey?.(id); this.emit({ type: "avatar-changed", data: { id, kind: "contact" } }); this.emit({ type: "avatar-changed", data: { id, kind: "chat" } }); }
    }
    if (dirty) { this.store.touch(); void this.store.flush().catch(() => {}); this.emit({ type: "chats-changed", data: {} }); }
    return added;
  }

  /** Ask the primary phone to (re)send contacts, blocked list and configuration. Answers arrive as sync messages. */
  async sync(): Promise<void> {
    const ours = this.ours;
    for (const type of [SyncRequestType.CONTACTS, SyncRequestType.BLOCKED, SyncRequestType.CONFIGURATION]) {
      const ts = this.nextTimestamp();
      await this.sender.deliver(ours, { syncMessage: { request: { type } } }, ts, "sync", { urgent: false });
    }
    this.contactsRequested = true;
  }

  private async importContacts(ref: import("../store/types.js").AttachmentRef, complete: boolean): Promise<void> {
    try {
      const plain = await downloadAttachment(ref);
      const list = parseContactStream(plain);
      const me = this.ours.toLowerCase();
      const known = this.store.data.contacts;
      if (complete) for (const c of Object.values(known)) if (!list.some((x) => x.aci === c.aci) && !c.localBlocked && !c.profileKey && !c.systemName && !c.nickName && !c.profileName) delete known[c.aci];
      for (const c of list) {
        if (c.aci === me) continue;
        const { expireTimer, ...rec } = c;
        const merged = { ...known[c.aci], ...rec, name: c.name ?? known[c.aci]?.name, number: c.number ?? known[c.aci]?.number, syncName: c.name ?? known[c.aci]?.syncName };
        resolveContactName(merged);
        known[c.aci] = merged;
        if (!this.store.data.chats[c.aci]) this.store.upsertChat({ id: c.aci, kind: "dm" });
        this.inbound.linkByNumber(c.aci, c.number, "contact-sync"); // ContactDetails has no PNI field; the number ties it to a PNI chat our phone made
        if (expireTimer !== undefined) this.store.data.chats[c.aci]!.expireTimer = expireTimer;
      }
      this.store.touch();
      await this.store.flush();
      this.emit({ type: "chats-changed", data: {} });
    } catch (e) {
      this.emit({ type: "error", data: { id: this.opts.accountId, code: "contact-sync-failed", message: describe(e) } });
    }
  }

  // ---------- linking ----------
  private async linkLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        this.emit({ type: "account", data: { id: this.opts.accountId, state: "needs-login" } });
        const { envelope, state } = await waitForProvisionEnvelope(this.net, (url) => this.emit({
          type: "login", data: { accountId: this.opts.accountId, promptId: "signal-link", kind: "qr", payload: url,
            hint: "Signal on your phone: Settings > Linked devices > Link new device, then scan this code." },
        }), this.abort.signal);
        this.emit({ type: "account", data: { id: this.opts.accountId, state: "connecting" } });
        await completeLinking(this.net, this.store, envelope, state, this.opts.deviceName ?? DEFAULT_DEVICE_NAME);
        this.makeInbound();
        // First connection also uploads the initial one-time prekeys (see connect()).
        this.firstConnect = true;
        await this.connect();
        return;
      } catch (e) {
        if (e instanceof LinkAborted || this.stopped) return;
        this.emit({ type: "error", data: { id: this.opts.accountId, code: "link-failed", message: describe(e) } });
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  private firstConnect = false;

  // ---------- receive loop ----------
  private async connect(): Promise<void> {
    if (this.stopped) return;
    const a = this.store.requireAccount();
    this.emit({ type: "account", data: { id: this.opts.accountId, state: "connecting" } });
    try {
      const conn = await this.net.connectAuthenticatedChat(`${a.aci}.${a.deviceId}`, a.password, false, {
        onIncomingMessage: (envelope, timestamp, ack) => {
          this.queue = this.queue.then(async () => {
            try { await this.processEnvelope(envelope, timestamp); }
            catch (e) { this.emit({ type: "error", data: { id: this.opts.accountId, code: "decrypt-failed", message: describe(e) } }); }
            finally { try { ack.send(200); } catch { /* connection already gone */ } }
          });
        },
        onQueueEmpty: () => { /* all queued messages delivered; nothing to do (no history model here) */ },
        onConnectionInterrupted: (cause) => { void this.onInterrupted(cause); },
      }) as AuthChat;
      this.chatConn = conn;
      this.backoff = RECONNECT_MIN_MS;
      this.emit({ type: "account", data: { id: this.opts.accountId, state: "connected" } });
      this.emit({ type: "chats-changed", data: {} });
      this.resolveUnresolvedGroups();
      this.startStorage();
      if (!this.contactsRequested && Object.keys(this.store.data.contacts).length === 0) {
        void this.sync().catch((e) => this.emit({ type: "error", data: { id: this.opts.accountId, code: "sync-request-failed", message: describe(e) } }));
      }
      try {
        if (this.firstConnect) { this.firstConnect = false; await uploadOneTimeKeys(conn, this.store, "aci"); if (a.pniIdentity) await uploadOneTimeKeys(conn, this.store, "pni"); }
        await refreshKeys(conn, this.store);
      } catch (e) { this.emit({ type: "error", data: { id: this.opts.accountId, code: "prekey-refresh-failed", message: describe(e) } }); }
    } catch (e) {
      await this.handleConnectionFailure(e);
    }
  }

  private async onInterrupted(cause: unknown): Promise<void> {
    this.chatConn = undefined;
    if (this.stopped || this.loggingOut) return;
    await this.handleConnectionFailure(cause);
  }

  private async handleConnectionFailure(cause: unknown): Promise<void> {
    if (this.stopped || this.loggingOut) return;
    if (LibSignalErrorBase.is(cause, ErrorCode.DeviceDelinked)) {
      // Credentials are really gone: the phone removed this linked device.
      this.emit({ type: "account", data: { id: this.opts.accountId, state: "needs-login", detail: "This device was unlinked from the Signal account." } });
      this.emit({ type: "error", data: { id: this.opts.accountId, code: "unlinked", message: "Device unlinked; remove and re-add the account.", fatal: true } });
      return;
    }
    if (LibSignalErrorBase.is(cause, ErrorCode.AppExpired)) {
      this.emit({ type: "error", data: { id: this.opts.accountId, code: "app-expired", message: "Signal rejected this client version as too old.", fatal: true } });
      return;
    }
    if (LibSignalErrorBase.is(cause, ErrorCode.ConnectedElsewhere)) {
      // Another process uses the same linked-device credentials; reconnecting immediately would ping-pong.
      this.emit({ type: "error", data: { id: this.opts.accountId, code: "connected-elsewhere", message: "Another client is using this linked device. Retrying in a minute." } });
      this.backoff = RECONNECT_MAX_MS;
    }
    this.emit({ type: "account", data: { id: this.opts.accountId, state: "disconnected", detail: cause ? describe(cause) : undefined } });
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => { void this.connect(); }, delay);
    this.reconnectTimer.unref?.();
  }

  private async processEnvelope(raw: Uint8Array, serverTimestamp: number): Promise<void> {
    const env = normalizeEnvelope(EnvelopeCodec.decode(raw));
    if (env.type === EnvelopeType.SERVER_DELIVERY_RECEIPT) {
      if (env.sourceServiceId && env.clientTimestamp !== undefined) this.inbound.serverDeliveryReceipt(env.sourceServiceId.replace(/^PNI:/i, ""), env.clientTimestamp, serverTimestamp);
      return;
    }
    const d = await decryptEnvelope(this.store, { ...env, serverTimestamp: env.serverTimestamp ?? serverTimestamp });
    if (!d) return;
    await this.inbound.handle(d, env.clientTimestamp ?? serverTimestamp);
    await this.store.flush();
  }

  // ---------- helpers ----------
  private requireChat(): AuthChat {
    if (!this.chatConn) throw new Error("Signal is not connected");
    return this.chatConn;
  }
  private nextTimestamp(): number { this.lastTs = Math.max(Date.now(), this.lastTs + 1); return this.lastTs; }
  private get ours() { return this.store.requireAccount().aci; }
  private requireDm(chatId: string): string {
    if (isGroupChatId(chatId)) throw new NotImplementedError("this action in Signal groups");
    return chatId;
  }

  /**
   * Resolve where an operation goes. A DM is its peer; a group needs its (cached, recently refreshed) member list and
   * revision, otherwise the send is refused with a plain-language error.
   */
  private async target(chatId: string): Promise<Target> {
    if (!isGroupChatId(chatId)) return { chatId };
    this.requireChat(); // not connected: say so once instead of failing per member
    const state = await this.groups.ensure(chatId, GROUP_STATE_MAX_AGE_MS);
    const rec = this.store.data.chats[chatId];
    if (state === "missing" || !rec?.groupMasterKey || !rec.groupMembers) {
      groupsDebug("send state=missing");
      throw new Error("Couldn't load this group's details from Signal, so the message was not sent. Check your connection and try again in a minute.");
    }
    const me = this.ours.toLowerCase();
    if (!rec.groupMembers.some((m) => m.toLowerCase() === me)) {
      throw new Error("You are no longer a member of this group, so you can't send messages to it.");
    }
    const masterKey = new Uint8Array(Buffer.from(rec.groupMasterKey, "base64"));
    return { chatId, group: { masterKey, revision: rec.groupRevision ?? 0, members: rec.groupMembers.filter((m) => m.toLowerCase() !== me), state } };
  }
  /** Mark a DataMessage as belonging to the group (no-op for DMs). */
  private tag(t: Target, dm: DataMessage): DataMessage {
    if (t.group) dm.groupV2 = { masterKey: t.group.masterKey, revision: t.group.revision };
    return dm;
  }
  /** Deliver to the chat: DM -> peer + transcript; group -> every member + one transcript. */
  private dispatch(t: Target, content: Content, timestamp: number, transcript: { message?: DataMessage; editMessage?: EditMessage }): Promise<void> {
    return t.group ? this.sendGroup(t, content, timestamp, transcript) : this.sendAndSync(t.chatId, content, timestamp, transcript);
  }

  /**
   * Group fan-out: the same Content as an individual 1:1 envelope to each member (never to ourselves), then a transcript
   * (no destination: the group is identified by groupV2 inside the message) to our other devices.
   * Succeeds when at least one member accepted it; otherwise throws. Partial failure is reported as a warning with a count only.
   */
  private async sendGroup(t: Target, content: Content, timestamp: number, transcript: { message?: DataMessage; editMessage?: EditMessage }): Promise<void> {
    const members = t.group!.members;
    const groupId = groupIdFromMasterKey(t.group!.masterKey);
    let delivered = 0, failed = 0, lastError: unknown;
    let sealedCount = 0, fallback = 0, anyResult = false;
    let multi: Awaited<ReturnType<Sender["deliverGroup"]>>;
    if ((content.dataMessage || content.editMessage) && members.length >= this.multiRecipientMin) {
      try {
        multi = await this.sender.deliverGroup?.({
          chatId: t.chatId, members, content, timestamp, groupId,
          secret: GroupSecretParams.deriveFromMasterKey(new GroupMasterKey(new Uint8Array(t.group!.masterKey))),
        });
      } catch (e) { lastError = e; multi = { mode: "sealed", delivered: 0, failed: members.length, fallback: 0 }; }
    }
    if (multi) { delivered = multi.delivered; failed = multi.failed; fallback = multi.fallback; sealedCount = multi.delivered; anyResult = true; }
    else {
      for (const m of members) {
        try {
          const r: DeliverResult | void = await this.sender.deliver(m, content, timestamp, "message", { groupId });
          delivered++;
          if (r) { anyResult = true; if (r.mode === "sealed") sealedCount++; else if (r.fallback) fallback++; }
        } catch (e) { failed++; lastError = e; }
      }
    }
    let sync = "none";
    if (members.length === 0 || delivered > 0) {
      try { await this.sender.deliver(this.ours, { syncMessage: { sent: { timestamp, ...transcript } } }, timestamp, "sync"); sync = "ok"; }
      catch (e) {
        sync = "failed";
        if (members.length === 0) { groupsDebug(`send members=0 delivered=0 failed=0 sync=failed`); throw e; }
        this.emit({ type: "error", data: { id: this.opts.accountId, code: "sync-failed", message: `delivered, but syncing to other devices failed: ${describe(e)}` } });
      }
    }
    groupsDebug(`send state=${t.group!.state} members=${members.length} delivered=${delivered} failed=${failed} sync=${sync}`);
    if (anyResult) sendDebug(sealedCount > 0 ? "sealed" : "authenticated", members.length, delivered, failed, fallback);
    if (members.length > 0 && delivered === 0) {
      const reason = lastError instanceof SendError && lastError.retryable ? " Signal is busy or you are sending too fast; try again shortly." : "";
      throw new Error(`The message could not be delivered to anyone in this group.${reason}`);
    }
    if (failed > 0) {
      this.emit({ type: "error", data: { id: this.opts.accountId, code: "group-partial-send",
        message: `The message was not delivered to ${failed} ${failed === 1 ? "person" : "people"} in this group.` } });
    }
  }
  private profileKey(): Uint8Array | undefined {
    const k = this.store.account?.profileKey;
    return k ? new Uint8Array(Buffer.from(k, "base64")) : undefined;
  }

  /** Send `content` to the peer, then mirror it to our other devices as a sent-transcript. */
  private async sendAndSync(peer: string, content: Content, timestamp: number, transcript: { message?: DataMessage; editMessage?: EditMessage }): Promise<void> {
    const self = peer.toLowerCase() === this.ours.toLowerCase();
    if (!self) {
      try {
        const r: DeliverResult | void = await this.sender.deliver(peer, content, timestamp, "message");
        if (r) sendDebug(r.mode, 1, 1, 0, r.fallback ? 1 : 0);
      } catch (e) { if (this.sender.deps.sealed) sendDebug("authenticated", 1, 0, 1, 0); throw e; }
    }
    try {
      await this.sender.deliver(this.ours, { syncMessage: { sent: { destinationServiceId: peer, timestamp, ...transcript } } }, timestamp, "sync");
    } catch (e) {
      if (self) throw e; // note-to-self depends on the sync copy
      this.emit({ type: "error", data: { id: this.opts.accountId, code: "sync-failed", message: `delivered, but syncing to other devices failed: ${describe(e)}` } });
    }
  }

  // ---------- connector surface ----------
  chats(): Chat[] {
    if (!this.inbound || !this.store.account) return [];
    this.ensureSelfChat();
    return Object.keys(this.store.data.chats).map((id) => this.withAvatarRev(this.inbound.chatRecordToChat(id)))
      .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  }

  /** Best CURRENT name for a person, if we know any (never a made-up fallback). */
  nameOf(id: string): string | undefined {
    const k = id.toLowerCase(), c = this.store.data.contacts[k];
    return c?.name || this.store.data.names[k] || c?.number || undefined;
  }

  members(chatId: string): { id: string; name: string; handle?: string }[] {
    return this.inbound ? this.inbound.groupMembers(chatId) : [];
  }

  /** Change hint for the Hub: group = hash of the avatar path in the snapshot, DM = profile avatar path / profile key version. */
  private withAvatarRev(c: Chat): Chat {
    const r = c.kind === "group" ? this.store.data.chats[c.id]?.avatarPath : undefined;
    const rev = c.kind === "group" ? (r ? `g:${createHash("sha1").update(r).digest("hex").slice(0, 16)}` : undefined) : this.peerAvatars?.rev(c.id);
    return rev ? { ...c, avatarRev: rev } : c;
  }

  /** Picture of a chat or contact. Groups: the cached/decrypted group avatar. DMs/contacts/own chat: profile avatar via the profile key. Never throws. */
  async avatar(target: { kind: "chat" | "space" | "contact" | "emoji"; id: string }): Promise<{ data: Uint8Array; mime: string } | undefined> {
    try {
      if (target.kind === "chat" && isGroupChatId(target.id)) return this.groupAvatar(target.id);
      if (target.kind === "chat" || target.kind === "contact") return await this.peerAvatars?.get(target.id);
    } catch { /* a picture is optional */ }
    return undefined;
  }

  /** Cached group picture (decrypted at resolve time). Undefined for unresolved groups and groups without a picture. */
  groupAvatar(chatId: string): { data: Uint8Array; mime: string } | undefined {
    const r = this.store.data?.chats[chatId];
    if (!r || r.kind !== "group") return undefined;
    if (r.avatarB64) return { data: new Uint8Array(Buffer.from(r.avatarB64, "base64")), mime: r.avatarMime || "application/octet-stream" };
    return this.groups?.memoryAvatar(chatId);
  }

  // ---------- own profile + privacy ----------
  getProfile(): Promise<Profile> { return getOwnProfile(this.requireChat(), this.store); }

  async updateProfile(patch: ProfilePatch): Promise<Profile> {
    await updateOwnProfile(this.requireChat(), this.store, patch);
    // Tell our other devices to refetch the local profile (what Signal-Desktop does after writeProfile).
    const ts = this.nextTimestamp();
    await this.sender.deliver(this.ours, { syncMessage: { fetchLatest: { type: FetchLatestType.LOCAL_PROFILE } } }, ts, "sync", { urgent: false })
      .catch(() => { /* best effort */ });
    return this.getProfile();
  }

  getPrivacy(): PrivacySetting[] {
    const a = this.store.requireAccount();
    const onOff = [{ value: "on", label: "On" }, { value: "off", label: "Off" }];
    const out: PrivacySetting[] = [{
      id: "readReceipts", label: "Send read receipts",
      description: "If off, people you chat with no longer see when you read their messages (and you don't see theirs on your phone).",
      value: a.readReceipts ? "on" : "off", options: onOff,
    }];
    out.push({
      id: "linkPreviews", label: "Send link previews",
      description: "When you send a link, UniChat opens the page from your computer to fetch its title and picture (the website sees your IP address). Off = links are sent as plain text.",
      value: a.linkPreviews === false ? "off" : "on", options: onOff,
    });
    if (a.typingIndicators !== undefined) {
      out.push({
        id: "typingIndicators", label: "Typing indicators",
        description: "Send and show \"typing...\" indicators.", value: a.typingIndicators ? "on" : "off", options: onOff,
      });
    }
    return out;
  }

  async setPrivacy(id: string, value: string): Promise<PrivacySetting[]> {
    const a = this.store.requireAccount();
    if (value !== "on" && value !== "off") throw new Error("invalid value");
    const on = value === "on";
    if (id === "readReceipts") a.readReceipts = on;
    else if (id === "typingIndicators" && a.typingIndicators !== undefined) a.typingIndicators = on;
    else if (id === "linkPreviews") { a.linkPreviews = on; this.store.touch(); await this.store.flush(); return this.getPrivacy(); } // local only; not synced
    else throw new Error(`unknown privacy setting: ${id}`);
    this.store.touch();
    await this.store.flush();
    // Push the new configuration to the phone / other devices (SyncMessage.Configuration). Only fields we actually know are sent.
    const ts = this.nextTimestamp();
    const configuration = { readReceipts: a.readReceipts, ...(a.typingIndicators !== undefined ? { typingIndicators: a.typingIndicators } : {}), ...(a.linkPreviews !== undefined ? { linkPreviews: a.linkPreviews } : {}) };
    await this.sender.deliver(this.ours, { syncMessage: { configuration } }, ts, "sync", { urgent: false })
      .catch((e) => this.emit({ type: "error", data: { id: this.opts.accountId, code: "privacy-sync-failed", message: describe(e) } }));
    return this.getPrivacy();
  }

  /** Phone number / username / ACI -> ACI (remembering the number as a contact). */
  private async resolveHandle(handle: string): Promise<string> {
    let h;
    try { h = parseHandle(handle); } catch (e) { throw e instanceof LookupError ? e : new Error("invalid handle"); }
    let aci: string;
    if (h.kind === "aci") aci = h.aci;
    else if (h.kind === "e164") aci = await lookupE164(this.net, this.requireChat(), h.e164);
    else aci = await lookupUsername(this.net, h.username);
    if (h.kind === "e164" && !this.store.data.contacts[aci]) this.store.data.contacts[aci] = { aci, number: h.e164 };
    return aci;
  }

  async startChat(handle: string): Promise<Chat> {
    const aci = await this.resolveHandle(handle);
    if (!this.store.data.chats[aci]) this.store.upsertChat({ id: aci, kind: "dm" });
    await this.store.flush();
    this.emit({ type: "chats-changed", data: { chatId: aci } });
    return this.inbound.chatRecordToChat(aci);
  }

  async downloadAttachment(attachmentId: string): Promise<{ data: Uint8Array; mime: string; name?: string }> {
    const ref = this.store.data.attachments[attachmentId];
    if (!ref) throw new Error("unknown attachment (not received by this device)");
    return { data: await downloadAttachment(ref), mime: ref.contentType || "application/octet-stream", name: ref.fileName };
  }

  async send(chatId: string, msg: OutgoingMessage): Promise<Message> {
    if (msg.location) throw new NotImplementedError("sending locations (Signal has no location message type)");
    if (msg.poll && isGroupChatId(chatId)) throw new NotImplementedError("polls in Signal groups");
    const t = await this.target(chatId);
    const peer = chatId;
    const timestamp = this.nextTimestamp();
    const { body, ranges } = applyMentions(msg.text, msg.mentions);
    const dm: DataMessage = { body, timestamp, requiredProtocolVersion: 0 };
    this.refuseBlocked(chatId);
    const timer = this.store.data.chats[chatId]?.expireTimer;
    if (timer) dm.expireTimer = timer; // the chat's disappearing timer travels with every message
    if (ranges.length) dm.bodyRanges = ranges;
    const pk = this.profileKey(); if (pk) dm.profileKey = pk;
    if (msg.forwarded) dm.flags = DataMessageFlags.FORWARD;
    if (msg.replyToMessageId) {
      const q = parseMessageId(msg.replyToMessageId);
      dm.quote = { id: q.timestamp, authorAci: q.author, text: "" };
    }
    if (msg.poll) {
      const opts = msg.poll.options.map((o) => o.trim()).filter(Boolean);
      if (!msg.poll.question.trim() || opts.length < 2 || opts.length > 10) throw new Error("a poll needs a question and 2-10 options");
      dm.pollCreate = { question: msg.poll.question.trim(), allowMultiple: !!msg.poll.multiple, options: opts };
    }
    if (msg.contacts?.length) {
      dm.contact = msg.contacts.map((c) => {
        const [given, ...rest] = c.name.split(" ");
        return {
          name: { givenName: given, familyName: rest.join(" ") || undefined },
          number: c.phones?.map((value) => ({ value, type: 2 })), email: c.emails?.map((value) => ({ value, type: 1 })),
        };
      });
    }
    const outAtt = (msg.attachments ?? []) as SignalOutgoingAttachment[];
    if (outAtt.length) {
      checkAttachments(outAtt);
      this.requireChat();
      dm.attachments = [];
      for (const a of outAtt) dm.attachments.push(await uploadAttachment(this.requireChat(), this.cdnHttp, a, Date.now())); // upload ONCE, fan out the pointers
    }
    let previewImage: { data: Uint8Array; mime: string } | undefined;
    if (!outAtt.length && !msg.poll && !msg.contacts?.length) previewImage = await this.attachLinkPreview(dm, msg, timestamp);
    const attBytes = outAtt.reduce((n, a) => n + a.data.length, 0);
    this.tag(t, dm);
    try { await this.dispatch(t, { dataMessage: dm }, timestamp, { message: dm }); }
    catch (e) { if (outAtt.length) attachDebug("send", attBytes, 0, `error:${e instanceof Error ? e.name : "unknown"}`); throw e; }
    if (outAtt.length) attachDebug("send", attBytes, 0, "ok");
    const id = messageId(this.ours, timestamp);
    const sentAtt = (dm.attachments ?? []).map((p, i): import("@unimsg/core").Attachment => {
      const aid = `${id}#${i}`, o = outAtt[i]!;
      this.store.rememberAttachment(aid, { cdnNumber: p.cdnNumber, cdnKey: p.cdnKey, key: Buffer.from(p.key!).toString("base64"), digest: Buffer.from(p.digest!).toString("base64"), size: p.size, contentType: p.contentType, fileName: p.fileName });
      return { id: aid, kind: o.kind === "sticker" ? "image" : o.kind, mime: p.contentType!, name: p.fileName, size: p.size, width: p.width, height: p.height,
        ...(o.durationMs ? { durationMs: o.durationMs } : {}), ...(o.waveform?.length ? { waveform: o.waveform } : {}), ...(p.flags === 8 ? { gif: true } : {}) };
    });
    if (dm.pollCreate) registerPoll(this.store, id, dm.pollCreate);
    let card = dm.preview?.length ? renderPreview(dm) : undefined;
    const pimg = dm.preview?.[0]?.image;
    if (card && pimg?.key && previewImage) {
      const aid = `${id}#preview`;
      this.store.rememberAttachment(aid, { cdnNumber: pimg.cdnNumber, cdnKey: pimg.cdnKey, key: Buffer.from(pimg.key).toString("base64"), digest: pimg.digest ? Buffer.from(pimg.digest).toString("base64") : undefined, size: pimg.size, contentType: pimg.contentType });
      card = { ...card, image: { attachmentId: aid } };
    }
    this.store.indexSent(id, peer);
    this.store.upsertChat({ id: peer, kind: t.group ? "group" : "dm", lastMessageAt: new Date(timestamp).toISOString() });
    return {
      id, chatId: peer, sender: "Me", senderId: this.ours, text: msg.text, time: new Date(timestamp).toISOString(), fromMe: true,
      status: "sent", ...(msg.forwarded ? { forwarded: true } : {}), ...(timer ? { expiresIn: timer } : {}),
      ...(dm.quote ? { replyTo: { messageId: msg.replyToMessageId!, } } : {}),
      ...(msg.contacts?.length ? { contacts: msg.contacts } : {}),
      ...(sentAtt.length ? { attachments: sentAtt } : {}),
      ...(dm.pollCreate ? { poll: pollView(this.store, id, this.ours) } : {}),
      ...(card ? { card } : {}),
    };
  }

  /**
   * First https URL in the text -> fetch metadata (SSRF-safe) -> upload the image -> dm.preview. Best effort: any failure sends the
   * message without a preview. Off when OutgoingMessage.linkPreview === false or the account setting (synced from the phone) is off.
   */
  private async attachLinkPreview(dm: DataMessage, msg: OutgoingMessage, timestamp: number): Promise<{ data: Uint8Array; mime: string } | undefined> {
    if ((msg as { linkPreview?: boolean }).linkPreview === false || this.store.requireAccount().linkPreviews === false) return undefined;
    const found = firstUrl(msg.text);
    if (!found || !/^https:/i.test(found.url)) return undefined;
    try {
      const p = await this.previewFetcher(found.url);
      const preview: NonNullable<DataMessage["preview"]>[number] = { url: p.url, title: p.title || new URL(p.url).hostname, date: timestamp };
      if (p.description) preview.description = p.description;
      let uploaded = false;
      if (p.image) {
        try { preview.image = await uploadAttachment(this.requireChat(), this.cdnHttp, { kind: "image", mime: p.image.mime, data: p.image.data }, Date.now()); uploaded = true; }
        catch { /* send the preview without its picture */ }
      }
      dm.preview = [preview];
      previewDebug("ok", uploaded);
      return uploaded ? p.image : undefined;
    } catch (e) {
      previewDebug(e instanceof PreviewError ? e.reason : "error", false);
      return undefined;
    }
  }

  // ---------- Groups v2 management ----------
  private groupEditorFor(): GroupEditor {
    if (this.groupEditor) return this.groupEditor;
    return (this.editor ??= new GroupEditor({
      store: this.store, resolver: this.groups, transport: () => this.groupsTransport(), unauth: () => this.unauthChat(),
    }));
  }
  /** Disappearing-messages timer last seen for a chat, in seconds (undefined = unknown, 0 = off). The core Chat model has no field for it yet. */
  disappearing(chatId: string): number | undefined { return this.store.data.chats[chatId]?.expireTimer; }

  /** Set the disappearing timer of a 1:1 chat (seconds, 0 = off): a timer-update DataMessage to the peer + transcript. Groups keep the timer in their group state (needs a GroupChange; not implemented). */
  async setDisappearing(chatId: string, seconds: number): Promise<void> {
    if (isGroupChatId(chatId)) throw new NotImplementedError("changing the disappearing timer of a Signal group (change it in Signal on the phone)");
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 4 * 7 * 86400) throw new Error("the timer must be between 0 and 4 weeks");
    this.requireChat();
    const timestamp = this.nextTimestamp();
    const dm: DataMessage = { timestamp, requiredProtocolVersion: 0, flags: DataMessageFlags.EXPIRATION_TIMER_UPDATE, expireTimer: Math.round(seconds) };
    const pk = this.profileKey(); if (pk) dm.profileKey = pk;
    await this.sendAndSync(chatId, { dataMessage: dm }, timestamp, { message: dm });
    this.store.upsertChat({ id: chatId, kind: "dm" });
    this.store.data.chats[chatId]!.expireTimer = Math.round(seconds);
    this.store.touch();
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  /** Block / unblock a 1:1 contact inside UniChat (Signal's block list lives in the phone's Storage Service, which this linked device only reads). Incoming messages are dropped and sending is refused. */
  async blockChat(chatId: string, blocked: boolean): Promise<void> {
    const aci = this.requireDm(chatId).toLowerCase();
    if (aci === this.ours.toLowerCase()) throw new Error("you cannot block yourself");
    const c = (this.store.data.contacts[aci] ??= { aci });
    if (blocked) c.localBlocked = true; else delete c.localBlocked;
    this.store.touch();
    await this.store.flush();
    this.emit({ type: "chats-changed", data: { chatId } });
  }
  private refuseBlocked(chatId: string): void {
    if (isGroupChatId(chatId)) return;
    const c = this.store.data.contacts[chatId.toLowerCase()];
    if (c?.localBlocked) throw new Error("This contact is blocked in UniChat. Unblock them to send a message.");
  }

  private wrapEdit<T>(p: Promise<T>): Promise<T> {
    return p.catch((e) => { throw e instanceof GroupEditError || !(e instanceof Error) ? e : new GroupEditError(e.message, "network"); });
  }

  /**
   * Tell the members about a group change: a DataMessage carrying groupV2 {masterKey, revision, groupChange} to everybody
   * (current members, invitees and people just removed), plus a transcript to our own other devices.
   */
  private async announceGroup(chatId: string, res: { revision: number; groupChange: Uint8Array; notify: string[] }): Promise<void> {
    const rec = this.store.data.chats[chatId];
    if (!rec?.groupMasterKey) return;
    const masterKey = new Uint8Array(Buffer.from(rec.groupMasterKey, "base64"));
    const groupId = groupIdFromMasterKey(masterKey);
    const timestamp = this.nextTimestamp();
    const dm: DataMessage = { timestamp, requiredProtocolVersion: 0, groupV2: { masterKey, revision: res.revision, ...(res.groupChange.length ? { groupChange: res.groupChange } : {}) } };
    let ok = 0, bad = 0, sealedN = 0, fb = 0;
    for (const m of res.notify) {
      try {
        const r: DeliverResult | void = await this.sender.deliver(m, { dataMessage: dm }, timestamp, "message", { groupId, urgent: false });
        ok++; if (r) { if (r.mode === "sealed") sealedN++; else if (r.fallback) fb++; }
      } catch { bad++; }
    }
    await this.sender.deliver(this.ours, { syncMessage: { sent: { timestamp, message: dm } } }, timestamp, "sync").catch(() => {});
    groupsDebug(`announce recipients=${res.notify.length} delivered=${ok} failed=${bad}`);
    if (res.notify.length) sendDebug(sealedN > 0 ? "sealed" : "authenticated", res.notify.length, ok, bad, fb);
    if (bad > 0) this.emit({ type: "error", data: { id: this.opts.accountId, code: "group-partial-send", message: `The group change was not delivered to ${bad} ${bad === 1 ? "person" : "people"}; they will see it the next time they open the group.` } });
  }

  async createGroup(name: string, memberHandles: string[]): Promise<Chat> {
    this.requireChat();
    const acis: string[] = [];
    for (const h of memberHandles) acis.push(await this.resolveHandle(h));
    const r = await this.wrapEdit(this.groupEditorFor().create(name, acis));
    await this.store.flush();
    await this.announceGroup(r.chatId, { revision: r.revision, groupChange: new Uint8Array(), notify: r.notify });
    this.emit({ type: "chats-changed", data: { chatId: r.chatId } });
    if (r.invited.length) this.emit({ type: "error", data: { id: this.opts.accountId, code: "group-invited", message: `${r.invited.length} ${r.invited.length === 1 ? "person was" : "people were"} invited instead of added: they need to accept the invitation in Signal first.` } });
    return this.inbound.chatRecordToChat(r.chatId);
  }

  private async afterGroupChange(chatId: string, res: GroupChangeResult, invited = false): Promise<void> {
    await this.store.flush();
    await this.announceGroup(chatId, res);
    this.emit({ type: "chats-changed", data: { chatId } });
    if (invited && res.invited.length) this.emit({ type: "error", data: { id: this.opts.accountId, code: "group-invited", message: `${res.invited.length} ${res.invited.length === 1 ? "person was" : "people were"} invited instead of added: they need to accept the invitation in Signal first.` } });
  }
  private requireGroup(chatId: string): void { if (!isGroupChatId(chatId)) throw new NotImplementedError("this action in 1:1 chats"); }

  async addMembers(chatId: string, memberHandles: string[]): Promise<void> {
    this.requireGroup(chatId); this.requireChat();
    const acis: string[] = [];
    for (const h of memberHandles) acis.push(await this.resolveHandle(h));
    await this.afterGroupChange(chatId, await this.wrapEdit(this.groupEditorFor().addMembers(chatId, acis)), true);
  }
  async removeMember(chatId: string, memberId: string): Promise<void> {
    this.requireGroup(chatId); this.requireChat();
    if (memberId.toLowerCase() === this.ours.toLowerCase()) throw new GroupEditError("To remove yourself, leave the group instead.", "invalid");
    await this.afterGroupChange(chatId, await this.wrapEdit(this.groupEditorFor().removeMember(chatId, memberId)));
  }
  async renameChat(chatId: string, name: string): Promise<void> {
    this.requireGroup(chatId); this.requireChat();
    await this.afterGroupChange(chatId, await this.wrapEdit(this.groupEditorFor().rename(chatId, name)));
  }
  async setChatDescription(chatId: string, text: string): Promise<void> {
    this.requireGroup(chatId); this.requireChat();
    await this.afterGroupChange(chatId, await this.wrapEdit(this.groupEditorFor().setDescription(chatId, text)));
  }
  async setChatPicture(chatId: string, image: { data: Uint8Array; mime: string } | null): Promise<void> {
    this.requireGroup(chatId); this.requireChat();
    await this.afterGroupChange(chatId, await this.wrapEdit(this.groupEditorFor().setPicture(chatId, image ? image.data : null)));
  }
  async leaveChat(chatId: string): Promise<void> {
    if (!isGroupChatId(chatId)) throw new NotImplementedError("leaving a 1:1 chat");
    this.requireChat();
    const res = await this.wrapEdit(this.groupEditorFor().leave(chatId));
    await this.announceGroup(chatId, res);
    delete this.store.data.chats[chatId]; this.store.touch();
    await this.store.flush();
    this.emit({ type: "chats-changed", data: {} });
  }

  /** Cast/replace/retract my vote (1:1 only). The full set of option ids I now pick. */
  async vote(chatId: string, mId: string, optionIds: string[]): Promise<void> {
    const peer = this.requireDm(chatId);
    const t = parseMessageId(mId);
    const poll = this.store.data.polls[mId];
    if (!poll) throw new Error("unknown poll (not received by this device)");
    if (poll.closed) throw new Error("this poll is closed");
    const picks = [...new Set(optionIds.map((x) => Number(x)))];
    if (picks.some((i) => !Number.isInteger(i) || i < 0 || i >= poll.options.length)) throw new Error("unknown poll option");
    if (!poll.multiple && picks.length > 1) throw new Error("this poll allows a single choice");
    const count = (poll.votes[this.ours.toLowerCase()]?.count ?? 0) + 1;
    const timestamp = this.nextTimestamp();
    const dm: DataMessage = { timestamp, pollVote: {
      targetAuthorAciBinary: Aci.fromUuid(t.author).getRawUuidBytes(), targetSentTimestamp: t.timestamp, optionIndexes: picks, voteCount: count } };
    await this.sendAndSync(peer, { dataMessage: dm }, timestamp, { message: dm });
    if (applyVote(this.store, mId, this.ours, picks, count)) this.inbound.emitPollUpdate(peer, mId);
  }

  async react(chatId: string, mId: string, emoji: string | null): Promise<void> {
    const tg = await this.target(chatId);
    const peer = chatId;
    const t = parseMessageId(mId);
    let remove = emoji === null;
    let useEmoji = emoji ?? "";
    if (remove) {
      const prev = Object.entries(this.store.data.reactions[mId] ?? {}).find(([, ids]) => ids.includes(this.ours));
      if (!prev) return;
      useEmoji = prev[0];
    }
    const timestamp = this.nextTimestamp();
    const dm: DataMessage = { timestamp, reaction: { emoji: useEmoji, remove, targetAuthorAci: t.author, targetSentTimestamp: t.timestamp } };
    this.tag(tg, dm);
    await this.dispatch(tg, { dataMessage: dm }, timestamp, { message: dm });
    this.inbound.applyReaction(peer, mId, this.ours, useEmoji, remove);
  }

  /** Pin / unpin a message (DataMessage.pinMessage / unpinMessage). durationSec 0 or absent-with-forever = until removed; default 7 days. */
  async pin(chatId: string, mId: string, pinned: boolean, opts?: { durationSec?: number }): Promise<void> {
    const t = parseMessageId(mId);
    const tg = await this.target(chatId);
    const timestamp = this.nextTimestamp();
    const aci = Aci.fromUuid(t.author).getRawUuidBytes();
    const sec = opts?.durationSec === undefined ? 604800 : opts.durationSec;
    const dm: DataMessage = this.tag(tg, { timestamp, ...(pinned
      ? { pinMessage: { targetAuthorAciBinary: aci, targetSentTimestamp: t.timestamp, ...(sec > 0 ? { pinDurationSeconds: sec } : { pinDurationForever: true }) } }
      : { unpinMessage: { targetAuthorAciBinary: aci, targetSentTimestamp: t.timestamp } }) });
    await this.dispatch(tg, { dataMessage: dm }, timestamp, { message: dm });
    this.emit({ type: "message-update", data: { chatId, messageId: mId, patch: pinned
      ? { pinned: true, pinnedAt: new Date(timestamp).toISOString(), pinnedBy: this.ours, ...(sec > 0 ? { pinnedUntil: new Date(timestamp + sec * 1000).toISOString() } : {}) }
      : { pinned: false } } });
  }

  async edit(chatId: string, mId: string, newText: string): Promise<void> {
    const peer = chatId;
    const t = parseMessageId(mId);
    if (t.author.toLowerCase() !== this.ours.toLowerCase()) throw new Error("can only edit your own messages");
    const tg = await this.target(chatId);
    const timestamp = this.nextTimestamp();
    const edit: EditMessage = { targetSentTimestamp: t.timestamp, dataMessage: this.tag(tg, { body: newText, timestamp }) };
    await this.dispatch(tg, { editMessage: edit }, timestamp, { editMessage: edit });
    this.emit({ type: "message-update", data: { chatId: peer, messageId: mId, patch: { text: newText, editedAt: new Date(timestamp).toISOString() } } });
  }

  async delete(chatId: string, mId: string): Promise<void> {
    const peer = chatId;
    const t = parseMessageId(mId);
    if (t.author.toLowerCase() !== this.ours.toLowerCase()) throw new Error("can only delete your own messages for everyone");
    const tg = await this.target(chatId);
    const timestamp = this.nextTimestamp();
    const dm: DataMessage = this.tag(tg, { timestamp, delete: { targetSentTimestamp: t.timestamp } });
    await this.dispatch(tg, { dataMessage: dm }, timestamp, { message: dm });
    this.emit({ type: "message-update", data: { chatId: peer, messageId: mId, patch: { deleted: true } } });
  }

  async setTyping(chatId: string, typing: boolean): Promise<void> {
    if (this.store.requireAccount().typingIndicators === false) return;
    if (isGroupChatId(chatId)) {
      // Best effort and cached state only: never block or fail the UI for a typing indicator.
      const rec = this.store.data.chats[chatId];
      if (!rec?.groupMasterKey || !rec.groupMembers) return;
      const me = this.ours.toLowerCase();
      const groupId = groupIdFromMasterKey(new Uint8Array(Buffer.from(rec.groupMasterKey, "base64")));
      const ts = this.nextTimestamp();
      let ok = 0, bad = 0;
      for (const m of rec.groupMembers) {
        if (m.toLowerCase() === me) continue;
        try { await this.sender.deliver(m, { typingMessage: { timestamp: ts, action: typing ? TypingAction.STARTED : TypingAction.STOPPED, groupId } }, ts, "message", { onlineOnly: true, urgent: false }); ok++; }
        catch { bad++; }
      }
      groupsDebug(`typing members=${ok + bad} delivered=${ok} failed=${bad}`);
      return;
    }
    const peer = chatId;
    if (peer.toLowerCase() === this.ours.toLowerCase()) return;
    const timestamp = this.nextTimestamp();
    await this.sender.deliver(peer, { typingMessage: { timestamp, action: typing ? TypingAction.STARTED : TypingAction.STOPPED } }, timestamp, "message", { onlineOnly: true, urgent: false });
  }

  /**
   * Marks `upToMessageId` read. LIMITATION: the provider keeps no message log, so only that single
   * message's timestamp is acknowledged (not every older unread message).
   */
  async markRead(chatId: string, upToMessageId: string): Promise<void> {
    const t = parseMessageId(upToMessageId);
    const rec = this.store.data.chats[chatId]; if (rec) { rec.unread = 0; this.store.touch(); } // receipts go to the message author, also in groups
    if (t.author.toLowerCase() === this.ours.toLowerCase()) return; // own message: nothing to acknowledge
    const timestamp = this.nextTimestamp();
    if (this.store.account?.readReceipts) {
      await this.sender.deliver(t.author, { receiptMessage: { type: ReceiptType.READ, timestamp: [t.timestamp] } }, timestamp, "message", { urgent: false });
    }
    await this.sender.deliver(this.ours, { syncMessage: { read: [{ senderAci: t.author, timestamp: t.timestamp }] } }, timestamp, "sync").catch(() => {});
  }
}

/** `[signal] send: mode=<sealed|authenticated> recipients=N delivered=N failed=N fallback=N` (counts only). */
export const sendDebug = (mode: "sealed" | "authenticated", recipients: number, delivered: number, failed: number, fallback: number) => {
  if (process.env.UNIMSG_DEBUG === "1") console.debug(`[signal] send: mode=${mode} recipients=${recipients} delivered=${delivered} failed=${failed} fallback=${fallback}`);
};

/**
 * Mentions -> Signal wire form: each "@Name" span of `text` is replaced by one U+FFFC placeholder and described by a BodyRange
 * {start,length:1,mentionAci}. Invalid, overlapping or non-ACI mentions are dropped (the name stays as plain text).
 */
export function applyMentions(text: string, mentions: { id: string; start: number; length: number }[] | undefined): { body: string; ranges: BodyRange[] } {
  if (!mentions?.length) return { body: text, ranges: [] };
  const ok = mentions
    .filter((m) => Number.isInteger(m.start) && Number.isInteger(m.length) && m.start >= 0 && m.length > 0 && m.start + m.length <= text.length && isAci(m.id))
    .sort((a, b) => a.start - b.start);
  let body = "", pos = 0;
  const ranges: BodyRange[] = [];
  for (const m of ok) {
    if (m.start < pos) continue; // overlaps the previous mention
    body += text.slice(pos, m.start);
    ranges.push({ start: body.length, length: 1, mentionAci: m.id.toLowerCase() });
    body += "\uFFFC";
    pos = m.start + m.length;
  }
  return { body: body + text.slice(pos), ranges };
}

function describe(e: unknown): string {
  // Class/code only: error text can embed addresses or other identifiers, so it is never forwarded.
  if (e instanceof EnvelopeError) return `${e.name}: ${e.code}`;
  const code = (e as { code?: unknown } | null)?.code;
  return e instanceof Error ? `${e.name}${code !== undefined ? ` (code ${String(code)})` : ""}` : "unknown error";
}
