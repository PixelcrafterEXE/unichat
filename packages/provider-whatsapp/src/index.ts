// WhatsApp provider via Baileys 6.x (WhatsApp-Web multi-device protocol). See README.md for design + limits.
// Unofficial: accounts can be banned and the protocol can break. Never log message text, keys or phone numbers.
import { mkdirSync, rmSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { inflate } from "node:zlib";
import { promisify } from "node:util";
import { join } from "node:path";
import makeWASocket, {
  ALL_WA_PATCH_NAMES, DisconnectReason, downloadHistory, S_WHATSAPP_NET, getHistoryMsg, processHistoryMessage, downloadContentFromMessage, generateMessageID, fetchLatestBaileysVersion, makeCacheableSignalKeyStore,
  normalizeMessageContent, proto, useMultiFileAuthState,
  type AnyMessageContent, type AuthenticationState, type Chat as WAChat, type Contact as WAContact,
  type GroupMetadata, type UserFacingSocketConfig, type WAMessage, type WAMessageKey, type WASocket,
} from "@whiskeysockets/baileys";
import {
  NO_CAPABILITIES,
  type Capabilities, type Chat, type Connector, type Contact, type CoreEvent, type HistoryQuery, type Message,
  type MessagePatch, type OutgoingMessage, type ProviderFactory, type Reaction, type Space,
} from "@unimsg/core";
import {
  betterStatus, canon, chatKindOf, extract, unwrap, handleOf, handleToJid, isGroupJid, isLidJid, isMuted,
  isSupportedChat, isUserJid, normJid, num, preview, statusFromAck, parseInviteCode, summarizeParticipantResults, textOf, toIso,
} from "./map.js";
import { Store, type AttDesc, type StoredChat, type StoredEvent, type StoredMsg } from "./store.js";
import { groupFallbackName, harvestHistorySync, isMaskedName, lidMigrationPairs, pickName, scanParticipants, senderNameStats, type NodeLike } from "./names.js";
import { NoiseCounter, classifyDecryptError, installConsoleFilter } from "./libnoise.js";
import { describeStub, stubName, stubParticipants } from "./system.js";
import { buildVcard, describeOther, topLevelField } from "./content.js";
import { counterparts, lookupName, mergeAllLids, mergeLid, visibleChatIds } from "./chatlist.js";
import { applyVote, buildPoll, encryptVote, tryDecryptVote, tryDecryptVoteEx } from "./poll.js";
import { encryptEventEdit, tryDecryptEventEdit } from "./eventcrypto.js";
import { aliasSessions, userMap } from "./sessionalias.js";
import { ResendQueue, type Pending } from "./resend.js";
import { buildPrivacy, friendlyWaError, resolvePrivacyChange, validateAbout, validateAvatar, validateName } from "./profile.js";
import type { PrivacySetting, Profile, ProfilePatch } from "@unimsg/core";
import { buildLinkPreview, firstUrl, LINK_PREVIEWS_ENABLED, type PreviewOptions } from "./linkpreview.js";
import { renderMentions, rewriteMentions } from "./mentions.js";
import { AvatarCache, classifyAvatarError, limiter, withTimeout } from "./avatar.js";

/** Top-level proto fields that legitimately produce no chat message. */
const BENIGN_DROPS = new Set(["protocolMessage", "reactionMessage", "encReactionMessage", "senderKeyDistributionMessage", "messageContextInfo", "keepInChatMessage", "albumMessage", "placeholderMessage"]);
const PROVIDER = "whatsapp";
const PROMPT_ID = "whatsapp-qr"; // stable: QR refreshes replace the same prompt
const STORE_FILE = "unimsg-whatsapp.json";
/** Text of messages stored by older versions for content we could not map. */
const PLACEHOLDER = /^(\[(unsupported message[^\]]*|poll|location|contact)\]|Waiting for this message\..*|This message couldn't be decrypted\..*)$/s;
const WAITING_TEXT = "Waiting for this message. Your phone is being asked to send it again.";
const GIVEUP_TEXT = "This message couldn't be decrypted. Open WhatsApp on your phone to read it.";
const WAITING_CARD = { kind: "other", title: "Waiting for this message", body: "Your phone is being asked to send it again." } as const;
const GIVEUP_CARD = { kind: "other", title: "Message not decrypted", body: "Open WhatsApp on your phone to read it." } as const;

/** An Error carrying a short stable `reason` (the Hub's media job counts failures per reason). */
export function reasoned(reason: string, message: string): Error { return Object.assign(new Error(message), { reason, ours: true }); } // `ours`: Node crypto errors also carry a `reason` ("bad decrypt"), which must not pass for one of these labels
/** Download failure -> reason: "expired" (CDN 404/410/403), "disk-full", "network", "bad-media" (MAC / decrypt), else "error". */
export function classifyMediaError(e: unknown): string {
  const x = e as { code?: string; statusCode?: number; response?: { status?: number }; message?: string; output?: { statusCode?: number }; reason?: string; ours?: boolean };
  if (x?.ours && x.reason) return x.reason;
  const st = x?.response?.status ?? x?.statusCode ?? x?.output?.statusCode;
  const msg = String(x?.message ?? "");
  if (x?.code === "ENOSPC" || /ENOSPC/.test(msg)) return "disk-full";
  if (st === 404 || st === 410 || st === 403 || /status code (404|410|403)/.test(msg)) return "expired";
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|timeout/i.test(msg) || ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(String(x?.code))) return "network";
  if (/hmac|mac|bad decrypt|wrong final block|unable to authenticate|invalid/i.test(msg)) return "bad-media";
  return "error";
}
function classifyReupload(e: unknown): string {
  const x = e as { message?: string; output?: { statusCode?: number } };
  return String(x?.message ?? "unknown").replace(/[0-9]{6,}/g, "#").slice(0, 80);
}
function mediaErrText(reason: string, e: unknown): string {
  const m = String((e as { message?: string })?.message ?? "").replace(/[0-9]{6,}/g, "#").slice(0, 80);
  return `${reason}: ${m}`;
}

/** Pin in chat lasts 24 hours, 7 days or 30 days (the WhatsApp apps' own choices). */
const PIN_DURATIONS = [86400, 604800, 2592000];
const CAPS: Capabilities = {
  ...NO_CAPABILITIES,
  spaces: true, reactions: true, pinMessages: true, pinDurations: PIN_DURATIONS, edits: true, deletes: true, replies: true, attachments: true, typing: true,
  readReceipts: true, voiceNotes: true, startChat: true, createGroup: true, location: true, contactCards: true, events: true, eventEdit: true, refreshChat: true, receiptDetails: true,
  createSpace: true, joinSpace: true,
  avatars: true, sync: true, profile: { displayName: true, about: true, avatar: true }, privacy: true, polls: true, leaveSpace: true,
  leaveChat: true, manageMembers: true, renameChat: true, chatPicture: true, chatDescription: true, block: true, disappearing: true, disappearingDurations: [86400, 604800, 7776000],
  backfill: true, // history() asks the primary phone for older messages (on-demand history sync)
  e2ee: true,
  mentions: true,
  fetchHistory: true, presence: true, // DM online / last seen (presenceSubscribe for recently active chats, max 30)
};

type Logger = NonNullable<UserFacingSocketConfig["logger"]>;
const silent: Logger = {
  level: "silent", child: () => silent,
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
};
const DEBUG = process.env.UNIMSG_DEBUG === "1";
/** Opt-in diagnostics on stderr. Callers pass COUNTS ONLY, never names/numbers/text. */
const dbg = (line: string) => { if (DEBUG) process.stderr.write(`[wa] ${line}\n`); };
/** Scrub a library log message: static text only, with anything jid/number-like removed. */
const scrub = (m: unknown): string => String(m).replace(/\S*@\S*/g, "<jid>").replace(/\d{6,}/g, "#").slice(0, 120);
const libMsg = (obj: unknown, msg?: string) => (typeof msg === "string" ? msg : typeof obj === "string" ? obj : (obj as Error | undefined)?.name ?? "");
/** First stack frames as file:line only (no paths, no message text) for crash diagnostics. */
const errInfo = (obj: unknown): string => {
  const e = (obj as { err?: unknown } | undefined)?.err;
  if (!(e instanceof Error)) return "";
  const frames = (e.stack ?? "").split("\n").slice(1, 3).map((f) => /([\w.-]+\.js:\d+)/.exec(f)?.[1] ?? "?").join(" < ");
  return ` [${e.name}: ${scrub(e.message).slice(0, 60)} @ ${frames}]`;
};
/** Library logger: silent unless UNIMSG_DEBUG=1, but always reports errors to `onError` (static message text only). */
const noise = new NoiseCounter();
const TRACE = process.env.UNICHAT_STANZA_TRACE === "1"; // TEMPORARY diagnostics for the poll problem: structure of poll stanzas / receipts, no content
const trace = (obj: unknown, msg?: string) => {
  const x = (obj as { xml?: string } | undefined)?.xml; if (!x) return;
  if (/^<message /.test(x)) { // incoming message envelope: attributes + the enc children's type/count only, never the payload
    const head = (/^<message [^>]*>/.exec(x)?.[0] ?? "").replace(/[0-9]{6,}(:\d+)?(@(s\.whatsapp\.net|lid|g\.us))/g, "<n>$2");
    const encs = [...x.matchAll(/<enc [^>]*?type=['"](\w+)['"][^>]*?v=['"](\d)['"]/g)].map((m) => `${m[1]}/v${m[2]}`).join(",");
    try { appendFileSync(join(homedir(), "unichat-build", "stanza.log"), `${new Date().toISOString()} MSG ${head.slice(0, 400)} enc=[${encs}]\n`); } catch { /* ignore */ }
    return;
  }
  if (!/type="poll"|polltype|<receipt|<ack/.test(x) && !/poll/.test(msg ?? "")) return;
  const t = x.replace(/[0-9]{6,}(:\d+)?(@(s\.whatsapp\.net|lid|g\.us))/g, "<n>$2").replace(/0x[0-9a-f]+|[0-9a-f]{40,}/gi, "<hex>").slice(0, 1800);
  try { appendFileSync(join(homedir(), "unichat-build", "stanza.log"), `${new Date().toISOString()} ${msg ?? ""} ${t}\n`); } catch { /* ignore */ }
};
const makeLogger = (onError: (msg: string) => void): Logger => {
  const l: Logger = {
    level: TRACE ? "trace" : "info", child: () => l,
    trace(obj, msg) { if (TRACE) trace(obj, libMsg(obj, msg)); }, debug() {},
    info(obj, msg) { if (!DEBUG) return; const m = libMsg(obj, msg); if (/sync|state|history|Online|Syncing|buffer/i.test(m)) dbg(`lib info: ${scrub(m)}`); },
    warn(obj, msg) { if (DEBUG) dbg(`lib warn: ${scrub(libMsg(obj, msg))}`); },
    error(obj, msg) {
      const m = libMsg(obj, msg);
      // a failed decrypt is expected after a relink (sessions are rebuilt; the sender retries, the placeholder queue covers the rest): count, don't dump
      const kind = classifyDecryptError(m, ((obj as { err?: unknown } | undefined)?.err as Error | undefined)?.message);
      if (kind) { if (TRACE) dbg(`decrypt-fail[${kind}]: ${scrub(m).slice(0, 160)}${errInfo(obj)} jid=${jidForm((obj as { key?: { remoteJid?: string } } | undefined)?.key?.remoteJid)}`); noise.bump(kind); return; }
      if (DEBUG) dbg(`lib error: ${scrub(m)}${errInfo(obj)}`);
      onError(m);
    },
  };
  return l;
};

/** Which addressing form a jid has: phone number, LID or unknown (for counts-only diagnostics). */
const jidForm = (j: string | null | undefined): "pn" | "lid" | "?" => (!j ? "?" : j.includes("@lid") ? "lid" : j.includes("@s.whatsapp.net") || j.includes("@c.us") ? "pn" : "?");
const statusCodeOf = (err: unknown): number | undefined =>
  (err as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

/** What the phone shows as the quoted part of a reply: the real content type where we can rebuild it, else text. */
export function quotedContent(m: Message): proto.IMessage {
  if (m.location && !m.deleted) {
    return { locationMessage: { degreesLatitude: m.location.lat, degreesLongitude: m.location.lng, ...(m.location.name ? { name: m.location.name } : {}), ...(m.location.address ? { address: m.location.address } : {}) } };
  }
  if (m.contacts?.length && !m.deleted) {
    const cs = m.contacts.map((c) => ({ displayName: c.name, vcard: buildVcard(c) }));
    return cs.length === 1 ? { contactMessage: cs[0]! } : { contactsArrayMessage: { displayName: `${cs.length} contacts`, contacts: cs } };
  }
  return { conversation: m.text || m.poll?.question || "[attachment]" };
}

class WhatsAppConnector implements Connector {
  readonly capabilities = CAPS;
  private readonly authDir: string;
  private readonly store: Store;
  private sock?: WASocket;
  private auth?: AuthenticationState;
  private emit: (e: CoreEvent) => void = () => {};
  private stopped = true;
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private opened = false;
  private groups = new Map<string, GroupMetadata>();
  private sent = new Map<string, proto.IMessage>(); // for Baileys' retry-on-failed-decrypt (getMessage)
  private presenceSubscribed = new Set<string>();
  private historySeen = new Set<string>();
  private historyWaiters = new Map<string, () => void>();
  private noMoreHistory = new Set<string>();
  private blocked = new Set<string>();
  private readonly avatars: AvatarCache;
  private readonly avatarSlots = limiter(2);
  private avatarInflight = new Map<string, Promise<{ data: Uint8Array; mime: string } | undefined>>();
  private metaQueue: string[] = [];
  private metaTried = new Set<string>();
  private metaRunning = false;
  private chatsTimer?: NodeJS.Timeout;
  private resyncTimer?: NodeJS.Timeout;
  private noiseTimer?: NodeJS.Timeout;

  constructor(private accountId: string, private dataDir: string) {
    this.authDir = join(dataDir, "auth");
    this.store = new Store(join(dataDir, STORE_FILE));
    this.avatars = new AvatarCache(join(dataDir, "avatars"));
  }

  // ------------------------------------------------------------------ lifecycle
  async start(emit: (e: CoreEvent) => void): Promise<void> {
    this.emit = emit;
    this.stopped = false;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.store.load();
    installConsoleFilter(noise);
    if (DEBUG && !this.noiseTimer) { this.noiseTimer = setInterval(() => { const l = noise.take(); if (l) dbg(`lib noise (counted, not shown): ${l} pending-resend=${this.resend?.size() ?? 0}`); const a = this.takeAvatarStats(); if (a) dbg(`avatars: ${a}`); }, 30_000); this.noiseTimer.unref?.(); }
    if (mergeAllLids(this.store.data)) this.store.touch();
    { // masked-number placeholders were briefly stored as push names: drop them so the real names / numbers show again
      const d = this.store.data; let n = 0;
      for (const [k, v] of Object.entries(d.push)) if (isMaskedName(v)) { delete d.push[k]; this.markNameDirty(k); n++; }
      for (const [k, v] of Object.entries(d.contacts ?? {})) if (isMaskedName(v as string)) { delete (d.contacts as Record<string, string>)[k]; n++; }
      for (const arr of Object.values(d.msgs)) for (const sm of arr) if (!sm.m.fromMe && isMaskedName(sm.m.sender)) { this.markNameDirty(sm.m.senderId); n++; } // earlier messages carry the masked text too: re-name them
      if (n) { this.store.touch(); dbg(`dropped masked placeholder names n=${n}`); }
    }
    this.initResend();
    this.fixActorNotices();
    for (const k of Object.keys(this.store.data.push)) this.markNameDirty(k); // push names now carry the "~": re-name earlier messages once
    try { await this.connect(); }
    catch (e) {
      this.err("connect-failed", e);
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    if (this.chatsTimer) clearTimeout(this.chatsTimer);
    if (this.liveSweepTimer) clearInterval(this.liveSweepTimer);
    this.liveSweepTimer = undefined;
    if (this.noiseTimer) clearInterval(this.noiseTimer);
    this.noiseTimer = undefined;
    const s = this.sock;
    this.sock = undefined; // handlers ignore events from stale sockets
    this.opened = false;
    try { s?.end(undefined); } catch { /* already closed */ }
    this.store.flush();
  }

  private loggingOut = false;
  private remoteGone = false;
  /** Test hooks (ms). */
  logoutWaitMs = 10_000;
  logoutQueryMs = 10_000;
  logoutSettleMs = 300;

  /**
   * Remove this companion device on WhatsApp's side and wait for the server's answer. Baileys' own logout() only fires the
   * IQ and closes the socket, so the frame can be lost and the device would stay in "Linked devices".
   */
  private async removeRemoteDevice(): Promise<boolean> {
    const me = this.auth?.creds.me?.id ?? (await this.loadMeId());
    if (!me) return true; // never linked: nothing to remove
    if (this.remoteGone) return true;
    // make sure there is an open connection (it may be reconnecting after a stall, or never started)
    if (!this.sock && !this.reconnectTimer) { try { await this.connect(); } catch { /* handled by the wait */ } }
    const deadline = Date.now() + this.logoutWaitMs;
    while (!this.remoteGone && !(this.sock && this.opened) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (this.remoteGone) return true;
    const sock = this.sock;
    if (!sock || !this.opened) return false;
    try {
      const q = sock.query({
        tag: "iq",
        attrs: { to: S_WHATSAPP_NET, type: "set", xmlns: "md" },
        content: [{ tag: "remove-companion-device", attrs: { jid: me, reason: "user_initiated" } }],
      }, this.logoutQueryMs);
      // Baileys' own timeout should fire; the extra race guarantees logout() can never hang
      const res = await withTimeout<{ attrs?: { type?: string } } | undefined>(this.logoutQueryMs + 1000, q, undefined);
      return !!res && res.attrs?.type !== "error"; // query() already throws on an <error> child
    } catch { return this.remoteGone; }
  }

  private async loadMeId(): Promise<string | undefined> {
    try {
      const { state } = await useMultiFileAuthState(this.authDir);
      this.auth = state;
      return state.creds.me?.id;
    } catch { return undefined; }
  }

  async logout(): Promise<void> {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    if (this.chatsTimer) clearTimeout(this.chatsTimer);
    // keep reconnecting while we try to reach WhatsApp, but a 401 during this time just means "already removed"
    this.stopped = false;
    this.loggingOut = true;
    this.remoteGone = false;
    let confirmed = false;
    try { confirmed = await this.removeRemoteDevice(); } catch { confirmed = false; }
    this.stopped = true;
    this.loggingOut = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const s = this.sock;
    this.sock = undefined;
    this.opened = false;
    if (confirmed && s) await new Promise((r) => setTimeout(r, this.logoutSettleMs)); // let the ack frame settle before closing
    try { s?.end(undefined); } catch { /* ignore */ }
    this.wipe();
    this.acct("needs-login", "logged out");
    if (!confirmed) {
      throw new Error("Couldn't reach WhatsApp to remove this device. Remove it manually on your phone: WhatsApp > Settings > Linked devices.");
    }
  }

  async submitLogin(): Promise<void> {
    throw new Error("WhatsApp links via QR code; there is no form login");
  }

  private wipe() {
    this.store.discard();
    this.store.data = new Store("").data;
    this.groups.clear(); this.sent.clear(); this.presenceSubscribed.clear(); this.historySeen.clear(); this.noMoreHistory.clear(); this.olderCooldown.clear();
    rmSync(this.authDir, { recursive: true, force: true });
    rmSync(join(this.dataDir, "avatars"), { recursive: true, force: true });
    rmSync(join(this.dataDir, STORE_FILE), { force: true });
  }

  private acct(state: "connecting" | "needs-login" | "connected" | "disconnected", detail?: string) {
    this.emit({ type: "account", data: { id: this.accountId, state, ...(detail ? { detail } : {}) } });
  }
  /** Report a problem without including payloads: only the error name/status code. */
  private err(code: string, e: unknown, fatal = false) {
    const sc = statusCodeOf(e);
    const what = e instanceof Error ? e.name : "error";
    this.emit({ type: "error", data: { id: this.accountId, code, message: `${code} (${what}${sc ? " " + sc : ""})`, ...(fatal ? { fatal } : {}) } });
  }
  /** Run an event handler; never let it throw into Baileys or the Hub. */
  private guard<A extends unknown[]>(code: string, fn: (...a: A) => void | Promise<void>) {
    return (...a: A) => {
      try { const r = fn(...a); if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch((e) => this.err(code, e)); }
      catch (e) { this.err(code, e); }
    };
  }

  // ------------------------------------------------------------------ connection
  private async connect() {
    mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this.auth = state;
    let version: UserFacingSocketConfig["version"];
    try { version = (await fetchLatestBaileysVersion()).version; } catch { /* use Baileys' bundled default */ }
    if (this.stopped) return;

    let sockRef: WASocket | undefined;
    const sock0 = () => sockRef;
    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(aliasSessions(state.keys, () => userMap({ lidToPn: this.store.data.lidToPn, own: { pn: this.selfPn, lid: this.selfLid } })), silent) },
      ...(version ? { version } : {}),
      // Name shown on the phone's "Linked devices" is browser[0]; browser[1] is the platform type ("Desktop" -> DESKTOP).
      browser: ["UniChat", "Desktop", "1.0.0"],
      // Ask the phone for as much history as it will give at link time. Verified (3x20s, throwaway dir): with this custom
      // browser name the socket stays open and the QR arrives (the earlier 1006 drop came from Browsers.macOS + this flag).
      syncFullHistory: true,
      logger: makeLogger((m) => this.onLibError(sock0(), m)),
      // Baileys 6.7.24 SKIPS ALL history/app-state sync (initial history, push names, contacts, on-demand) unless
      // this is provided or syncFullHistory is on, so it must be explicit.
      shouldSyncHistoryMessage: (n) => this.shouldSyncHistory(n),
      markOnlineOnConnect: false, // keep phone notifications working
      emitOwnEvents: false,       // we apply our own sends locally (see send/edit/delete/react)
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (j) => !!j && (j.endsWith("@broadcast") || j.endsWith("@newsletter")), // Baileys also calls this with undefined for some nodes
      getMessage: async (key) => (key.id ? this.sent.get(key.id) : undefined),
      cachedGroupMetadata: async (jid) => this.groups.get(jid),
    });
    sockRef = sock;
    this.sock = sock;
    this.opened = false;
    this.acct(state.creds.registered || state.creds.me ? "connecting" : "needs-login");

    sock.ev.on("creds.update", (u) => {
      saveCreds().catch((e) => this.err("creds-save", e));
      if (u.myAppStateKeyId && u.myAppStateKeyId !== this.lastAppStateKey) { this.lastAppStateKey = u.myAppStateKeyId; this.scheduleAppStateResync(3000); }
    });
    sock.ev.on("connection.update", this.guard("connection", (u) => {
      if (sock !== this.sock) return;
      if (u.qr || u.isNewLogin) { this.store.data.linkedAt = Date.now(); this.store.touch(); }
      if (u.qr) {
        this.emit({ type: "login", data: { accountId: this.accountId, promptId: PROMPT_ID, kind: "qr", payload: u.qr, hint: "WhatsApp > Linked devices > Link a device" } });
        this.acct("needs-login");
      }
      if (u.connection === "open") {
        this.attempt = 0; this.opened = true;
        this.presenceSubscribed.clear(); // WhatsApp forgets subscriptions with the connection
        this.resendSent = 0; this.resendDone = 0; // the resend circuit breaker starts over with each connection
        this.subscribeRecentPresence();
        this.acct("connected");
        void this.afterOpen(sock);
      } else if (u.connection === "close") {
        this.opened = false;
        this.onClose(sock, u.lastDisconnect?.error);
      }
    }));
    this.wire(sock);
  }

  private onClose(sock: WASocket, error: unknown) {
    if (sock !== this.sock || this.stopped) return;
    this.sock = undefined;
    try { sock.end(undefined); } catch { /* ignore */ }
    const code = statusCodeOf(error);
    if (this.loggingOut && code === DisconnectReason.loggedOut) { this.remoteGone = true; return; } // device already removed remotely
    switch (code) {
      case DisconnectReason.loggedOut: // credentials revoked (unlinked on phone)
        this.wipe();
        this.acct("needs-login", "session ended");
        this.scheduleReconnect(1000, true); // fresh connection => new QR
        return;
      case DisconnectReason.connectionReplaced:
        this.stopped = true;
        this.err("replaced", error, true);
        this.acct("disconnected", "replaced by another session");
        return;
      case DisconnectReason.forbidden:
        this.stopped = true;
        this.err("forbidden", error, true);
        this.acct("disconnected", "access forbidden");
        return;
      case DisconnectReason.restartRequired: // normal right after QR scan
        this.scheduleReconnect(0, true);
        return;
      default:
        this.lastClose = `${(error as Error | undefined)?.name ?? "closed"}${code ? " " + code : ""}${(error as Error | undefined)?.message ? ": " + (error as Error).message : ""}`.slice(0, 160);
        this.scheduleReconnect();
    }
  }
  private lastClose = ""; // status/error NAME only (no payloads) shown as the reconnect reason

  private lastOfflineRestart = 0;
  /**
   * Baileys 6.7.24's offline-node queue stops draining for the rest of the connection when one node's handler throws
   * ("unexpected error in processing offline nodes": `isProcessing` is never reset). Unprocessed nodes were not acked, so the
   * server redelivers them on reconnect: restart the socket once (at most every 10 min) instead of silently losing them.
   */
  private onLibError(sock: WASocket | undefined, msg: string) {
    if (!/processing offline nodes/.test(msg) || !sock || sock !== this.sock || this.stopped) return;
    this.emit({ type: "error", data: { id: this.accountId, code: "offline-queue", message: "offline queue stalled; reconnecting" } });
    if (Date.now() - this.lastOfflineRestart < 10 * 60_000) return;
    this.lastOfflineRestart = Date.now();
    dbg("offline queue stalled: restarting socket");
    this.sock = undefined; this.opened = false;
    try { sock.end(undefined); } catch { /* ignore */ }
    this.scheduleReconnect(1500, true);
  }

  private scheduleReconnect(delayMs?: number, quiet = false) {
    if (this.stopped || this.reconnectTimer) return;
    const d = delayMs ?? Math.min(60_000, 1000 * 2 ** Math.min(this.attempt, 6)) * (0.75 + Math.random() * 0.5);
    this.attempt++;
    if (!quiet) this.acct("connecting", `reconnecting in ${Math.round(d / 1000)}s${this.lastClose ? " (" + this.lastClose + ")" : ""}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      this.connect().catch((e) => { this.err("connect-failed", e); this.scheduleReconnect(); });
    }, d);
  }

  private async afterOpen(sock: WASocket) {
    try {
      // Note: in 6.7.24 the "participating" query returns communities inside the *groups* node (isCommunity=true);
      // communityFetchAllParticipating only reads a separate `communities` node and may legitimately be empty.
      let all: Record<string, GroupMetadata> | undefined;
      try { all = await sock.groupFetchAllParticipating(); } catch (e) { this.err("group-fetch", e); }
      let comm: Record<string, GroupMetadata> = {};
      try { comm = await sock.communityFetchAllParticipating(); } catch { /* optional */ }
      if (sock !== this.sock) return;
      try { this.setBlocklist(await sock.fetchBlocklist()); } catch { /* keep previous */ }
      if (all) {
        const d = this.store.data;
        const live = new Set<string>();
        const spaces: Record<string, string> = {};
        for (const g of [...Object.values(comm), ...Object.values(all)]) {
          this.applyGroup(g);
          live.add(normJid(g.id));
          if (g.isCommunity) spaces[normJid(g.id)] = g.subject;
        }
        d.spaces = spaces; // communities we left disappear
        for (const c of Object.values(d.chats)) if (c.kind === "group" && !live.has(c.id)) c.member = false;
        const vals = Object.values(all);
        dbg(`groups fetched groups=${vals.filter((g) => !g.isCommunity).length} communities=${vals.filter((g) => g.isCommunity).length} viaCommunityApi=${Object.keys(comm).length} subgroups=${vals.filter((g) => g.linkedParent).length} announce=${vals.filter((g) => g.isCommunityAnnounce).length}`);
        this.dbgNames();
        this.store.touch();
        this.emit({ type: "spaces-changed", data: {} });
        this.emit({ type: "chats-changed", data: {} });
        this.queueUnnamedGroups();
      }
    } catch (e) { this.err("group-sync", e); }
    this.resend?.kick();
    if (!this.liveSweepTimer) { this.liveSweepTimer = setInterval(() => this.sweepLiveLocations(), 5 * 60_000); this.liveSweepTimer.unref?.(); }
    this.sweepLiveLocations();
    // Pull saved contact names etc. Baileys only does this by itself right after linking.
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => { void this.resyncAppState(sock); }, 22_000); // after Baileys' own initial-sync window
    this.resyncTimer.unref?.();
  }

  private nameSources = new Map<string, number>();
  /** Counts-only: how many names / id pairs each source delivered this session. */
  private nameSrc(kind: string, n = 1) { this.nameSources.set(kind, (this.nameSources.get(kind) ?? 0) + n); }
  private participantAttrs = new Map<string, number>();

  /** Names from sources Baileys 6.7.24 drops: HistorySync.pushnames of non-PUSH_NAME chunks, phoneNumberToLidMappings, LID migration sync. */
  private applyHarvest(h: ReturnType<typeof harvestHistorySync>, src: string) {
    const d = this.store.data;
    for (const [lid, pn] of h.pairs) { if (d.lidToPn[lid] !== pn) this.nameSrc("lid-map-" + src); this.learn(lid, pn); }
    let n = 0;
    for (const [rawId, name] of h.pushnames) {
      const id = this.cj(rawId);
      if (!isUserJid(id) || d.push[id] === name || isMaskedName(name)) continue;
      d.push[id] = name; this.markNameDirty(id); n++;
    }
    if (n) { this.nameSrc("pushnames-" + src, n); this.store.touch(); this.notifyChats(); }
  }

  /** Every received iq/notification: participants of group info / change notices may carry names and lid+number pairs. */
  private tapFrame(node: unknown) {
    const n = node as NodeLike | undefined;
    if (!n || typeof n !== "object" || !n.tag) return;
    const found = scanParticipants(n, this.participantAttrs);
    if (!found.length) return;
    const d = this.store.data;
    let named = 0;
    for (const p of found) {
      if (p.lid && p.pn) this.learn(p.lid, p.pn);
      if (!p.name) continue;
      const id = this.cj(p.pn ?? p.lid!);
      if (!isUserJid(id) || d.push[id] === p.name) continue;
      if (d.push[id]?.trim() && !isMaskedName(d.push[id])) continue; // a push name the person chose beats a group-node display name
      d.push[id] = p.name; this.markNameDirty(id); named++;
    }
    if (named) { this.nameSrc("participant-node", named); this.store.touch(); this.notifyChats(); }
  }

  /** Counts-only: how the distinct senders of group messages end up named. */
  private dbgSenders() {
    if (!DEBUG) return;
    const d = this.store.data;
    const ids = new Set<string>();
    for (const [chatId, arr] of Object.entries(d.msgs)) {
      if (!isGroupJid(chatId)) continue;
      for (const s of arr) if (!s.m.fromMe && !s.m.system) ids.add(isLidJid(s.m.senderId) ? (d.lidToPn[s.m.senderId] ?? s.m.senderId) : s.m.senderId);
    }
    const st = senderNameStats(ids, (id) => ({ ...lookupName(d, id), known: !isLidJid(id) }));
    dbg(`names: group-senders=${st.total} named=${st.named} phone-fallback=${st.phone} unknown=${st.unknown}`);
    const src = [...this.nameSources].sort().map(([k, v]) => `${k}=${v}`).join(" ");
    const attrs = [...this.participantAttrs].sort().map(([k, v]) => `${k}:${v}`).join(",");
    dbg(`name-sources: ${src || "none"} push=${Object.keys(d.push).length} lidMap=${Object.keys(d.lidToPn).length} participant-attrs=${attrs || "none"}`);
  }

  /** Counts-only breakdown of how visible DM chats get their names. */
  private dbgNames() {
    if (!DEBUG) return;
    this.dbgSenders();
    const d = this.store.data;
    const n = { contact: 0, push: 0, verified: 0, phone: 0, anon: 0 };
    let dms = 0;
    for (const id of visibleChatIds(d)) {
      const c = d.chats[id]!;
      if (c.kind !== "dm") continue;
      dms++;
      const src = lookupName(d, id);
      if (src.contact?.trim()) n.contact++; else if (src.push?.trim()) n.push++; else if (src.verified?.trim()) n.verified++;
      else if (isLidJid(id)) n.anon++; else n.phone++;
    }
    dbg(`names dms=${dms} contact=${n.contact} push=${n.push} verified=${n.verified} phone=${n.phone} anon=${n.anon} contacts=${Object.keys(d.contacts).length} lidMap=${Object.keys(d.lidToPn).length}`);
  }

  private async resyncAppState(sock: WASocket) {
    if (sock !== this.sock || !this.opened) return;
    try {
      await sock.resyncAppState(ALL_WA_PATCH_NAMES, true);
      dbg(`app-state resync done collections=${ALL_WA_PATCH_NAMES.length} contacts=${Object.keys(this.store.data.contacts).length}`);
      this.dbgNames();
      this.notifyChats();
    } catch (e) { dbg(`app-state resync failed ${(e as Error)?.name ?? ""}`); }
  }

  async sync(): Promise<void> {
    const sock = this.live();
    await this.afterOpen(sock);
    await this.resyncAppState(sock);
  }

  // ------------------------------------------------------------------ identity helpers
  private get selfPn(): string | undefined { const id = this.auth?.creds.me?.id; return id ? normJid(id) : undefined; }
  private get selfLid(): string | undefined { const id = this.auth?.creds.me?.lid; return id ? normJid(id) : undefined; }
  private selfId(): string { return this.selfPn ?? this.selfLid ?? "me"; }
  private isMe(jid: string | null | undefined): boolean {
    if (!jid) return false;
    const j = normJid(jid);
    return j === this.selfPn || j === this.selfLid;
  }
  private learn(lid: string | null | undefined, pn: string | null | undefined) {
    if (!lid || !pn) return;
    const l = normJid(lid), p = normJid(pn);
    if (!isLidJid(l) || !p.endsWith("@s.whatsapp.net") || this.store.data.lidToPn[l] === p) return;
    // names, chat, messages and anchors keyed by the lid move to the phone-number id
    const merged = mergeLid(this.store.data, l, p);
    this.store.touch();
    this.markNameDirty(p); this.markNameDirty(l);
    if (merged) this.notifyChats(); else this.notifyChats();
  }
  private cj(jid: string, pnHint?: string | null): string {
    const j = normJid(jid);
    if (isLidJid(j) && pnHint) this.learn(j, pnHint);
    return canon(j, this.store.data.lidToPn, pnHint);
  }
  private nameOf(jid: string): string {
    const d = this.store.data;
    const pn = isLidJid(jid) ? d.lidToPn[jid] : undefined;
    return pickName(pn ?? jid, lookupName(d, pn ?? jid));
  }
  /** Debounced chats-changed so bursts of name/contact updates cause one UI refresh. */
  private notifyChats() {
    if (this.chatsTimer) return;
    this.chatsTimer = setTimeout(() => {
      this.chatsTimer = undefined;
      this.emit({ type: "chats-changed", data: {} });
      this.refreshSenderNames();
    }, 400);
    this.chatsTimer.unref?.();
  }
  private nameDirty = new Set<string>();
  /**
   * Earlier versions wrote "You added…" / "You left" for group notices someone else caused (WhatsApp marks them fromMe). The stored
   * participant tells who really acted: rewrite the leading "You" with that person's name (here and in the Hub's archive).
   */
  private fixActorNotices() {
    const d = this.store.data; let n = 0;
    for (const [chatId, arr] of Object.entries(d.msgs)) {
      for (const sm of arr) {
        const m = sm.m;
        if (!m.system || !sm.pj || !/^You (added|removed|left|joined|created|changed|promoted|demoted|turned|made|updated|set|pinned|unpinned|reset|deleted)\b/.test(m.text)) continue;
        if (this.isMe(sm.pj)) continue;
        const name = this.nameOf(this.cj(sm.pj));
        if (!name) continue;
        m.text = `${name}${m.text.slice(3)}`; n++;
        this.emit({ type: "message-update", data: { chatId, messageId: m.id, patch: { text: m.text } } });
      }
    }
    if (n) { this.store.touch(); dbg(`fixed group notices that wrongly said "You": n=${n}`); }
  }

  private markNameDirty(jid: string) { this.nameDirty.add(jid); }

  /** A better name arrived for some people: patch `sender` on their earlier stored messages (changed ones only). */
  private refreshSenderNames() {
    if (!this.nameDirty.size) return;
    const ids = new Set<string>();
    for (const j of this.nameDirty) { ids.add(j); for (const c of counterparts(this.store.data, j)) ids.add(c); const pn = this.store.data.lidToPn[j]; if (pn) ids.add(pn); }
    this.nameDirty.clear();
    let budget = 5000, patched = 0;
    for (const [chatId, arr] of Object.entries(this.store.data.msgs)) {
      for (const s of arr) {
        if (s.m.fromMe || !ids.has(s.m.senderId)) continue;
        const name = this.nameOf(s.m.senderId);
        if (name === s.m.sender) continue;
        if (budget-- <= 0) return;
        s.m.sender = name; patched++;
        this.emit({ type: "message-update", data: { chatId, messageId: s.m.id, patch: { sender: name } } });
      }
    }
    if (patched) { this.store.touch(); dbg(`sender names refreshed messages=${patched}`); }
  }
  private shouldSyncHistory(n: proto.Message.IHistorySyncNotification): boolean {
    // A real notification always carries the blob location; Baileys' own startup probe is a bare {syncType: RECENT}.
    if (n.initialHistBootstrapInlinePayload?.length && !n.directPath) return false; // handled by onHistoryNotification (Baileys cannot read inline payloads)
    if (n.directPath || n.mediaKey || n.fileSha256) return true; // every real chunk (bootstrap, recent, full, push names, on-demand, late chunks)
    // Probe: only "wait for initial history" shortly after linking, so ordinary reconnects aren't held up by the 20s buffering.
    const at = this.store.data.linkedAt;
    return !!at && Date.now() - at < 15 * 60_000;
  }
  /** Ask for group metadata of unnamed groups: max 2 concurrent, small delay, each tried once per session. */
  private queueUnnamedGroups() {
    for (const c of Object.values(this.store.data.chats)) {
      if (c.kind === "group" && !c.name && !this.metaTried.has(c.id)) { this.metaTried.add(c.id); this.metaQueue.push(c.id); }
    }
    if (this.metaRunning || !this.metaQueue.length) return;
    this.metaRunning = true;
    const worker = async () => {
      while (this.metaQueue.length && this.sock && this.opened) {
        const id = this.metaQueue.shift()!;
        try { this.applyGroup(await this.sock.groupMetadata(id)); this.notifyChats(); } catch { /* not a member / rate limited */ }
        await new Promise((r) => setTimeout(r, 700));
      }
    };
    Promise.all([worker(), worker()]).finally(() => { this.metaRunning = false; });
  }
  /** Chat id of a message key. */
  private chatIdOf(key: { remoteJid?: string | null; fromMe?: boolean | null; senderPn?: string }): string | undefined {
    if (!key.remoteJid) return undefined;
    const rj = normJid(key.remoteJid);
    if (!isSupportedChat(rj)) return undefined;
    return isGroupJid(rj) ? rj : this.cj(rj, key.fromMe ? undefined : key.senderPn);
  }

  // ------------------------------------------------------------------ chats / groups bookkeeping
  private ensureChat(id: string): StoredChat {
    const cs = this.store.data.chats;
    let c = cs[id];
    if (!c) { c = cs[id] = { id, kind: chatKindOf(id) }; this.store.touch(); }
    return c;
  }

  private applyGroup(g: GroupMetadata, authoritative = true) {
    const id = normJid(g.id);
    this.groups.set(id, g);
    if (g.isCommunity) {
      this.store.data.spaces[id] = g.subject;
      delete this.store.data.chats[id];
      return;
    }
    for (const p of g.participants) { if (p.lid && p.jid) this.learn(p.lid, p.jid); else if (isLidJid(p.id) && p.jid) this.learn(p.id, p.jid); }
    const c = this.ensureChat(id);
    c.kind = "group";
    c.member = true;
    c.name = g.subject;
    c.spaceId = g.linkedParent ? normJid(g.linkedParent) : undefined;
    const meAdmin = g.participants.some((p) => (this.isMe(p.jid) || this.isMe(p.lid) || this.isMe(p.id)) && !!(p.isAdmin || p.isSuperAdmin || p.admin));
    c.readOnly = !!(g.announce || g.isCommunityAnnounce) && !meAdmin;
    if (g.desc !== undefined) c.description = g.desc?.trim() || undefined; else if (authoritative) delete c.description;
    // a fetched group is authoritative: no `ephemeralDuration` means the timer is off (partial updates pass authoritative=false)
    if (authoritative || g.ephemeralDuration !== undefined) this.setEphemeral(id, g.ephemeralDuration ?? 0, authoritative ? Date.now() : undefined);
    this.store.touch();
  }

  // ---- disappearing messages (internal: the core model has no Chat.disappearing field yet)
  /** Seconds after which new messages in this chat disappear (0/undefined = off). */
  ephemeralOf(chatId: string): number { return this.store.data.chats[chatId]?.ephemeral ?? 0; }
  private setEphemeral(chatId: string, seconds: number, atMs?: number) {
    const c = this.ensureChat(chatId);
    if (!Number.isFinite(seconds) || seconds < 0) return;
    // an older setting never overrides a newer one
    if (atMs && c.ephemeralAt && atMs < c.ephemeralAt) return;
    if ((c.ephemeral ?? 0) !== seconds) { c.ephemeral = seconds || undefined; this.store.touch(); }
    if (atMs) c.ephemeralAt = atMs;
  }
  /** Learn the chat timer from a message: contextInfo.expiration (only positive values are evidence) or the "timer changed" stub. */
  private learnEphemeral(chatId: string, expiration: number | null | undefined, tsSec: number, stub: number | null | undefined, stubParams: (string | null | undefined)[] | null | undefined) {
    const at = tsSec > 0 ? tsSec * 1000 : undefined;
    if (stub === 72 || stub === 130) { const v = Number(stubParams?.[0] ?? 0); if (Number.isFinite(v)) this.setEphemeral(chatId, v, at); return; }
    if (expiration && expiration > 0) this.setEphemeral(chatId, expiration, at);
  }

  /** Text with "@<digits>" mention tokens shown as "@Name" (current display names). */
  private withMentions(text: string, ctx: proto.IContextInfo | null | undefined): string {
    const jids = ctx?.mentionedJid;
    if (!jids?.length || !text) return text;
    return renderMentions(text, jids.map((j) => normJid(j)), (j) => {
      const forms = counterparts(this.store.data, j);
      const name = this.isMe(j) ? "Me" : this.nameOf(this.cj(j));
      return { forms, name: name === "WhatsApp user" ? undefined : name };
    });
  }

  private applyChat(c: Partial<WAChat>) {
    if (!c.id) return;
    const id = normJid(c.id);
    if (!isSupportedChat(id)) return;
    if (isLidJid(id)) this.learn(id, c.pnJid); else if (id.endsWith("@s.whatsapp.net")) this.learn(c.lidJid, id);
    const sc = this.ensureChat(isGroupJid(id) ? id : this.cj(id));
    if (c.name) sc.name = c.name;
    if (c.unreadCount != null) sc.unread = Math.max(0, c.unreadCount);
    if (c.muteEndTime !== undefined) sc.muted = isMuted(c.muteEndTime);
    if (c.readOnly != null && !this.groups.has(id)) sc.readOnly = c.readOnly;
    if (c.archived != null) sc.archived = c.archived;
    if (c.ephemeralExpiration !== undefined) this.setEphemeral(sc.id, c.ephemeralExpiration ?? 0, num(c.ephemeralSettingTimestamp) * 1000 || undefined);
    const last = c.messages?.[0]?.message;
    if (last?.key?.id && last.key.remoteJid) {
      const lts = num(last.messageTimestamp) * 1000;
      const cur = this.store.data.anchors[sc.id];
      if (!cur || lts > cur.ts) {
        this.store.data.anchors[sc.id] = { id: last.key.id, fromMe: !!last.key.fromMe, rj: last.key.remoteJid, ...(last.key.participant ? { pj: last.key.participant } : {}), ts: lts };
      }
    }
    const ts = num(c.conversationTimestamp);
    if (ts > 0) { const iso = toIso(ts); if (!sc.lastMessageAt || iso > sc.lastMessageAt) sc.lastMessageAt = iso; }
    this.store.touch();
  }

  private applyContact(c: Partial<WAContact>) {
    if (!c.id) return;
    this.learn(c.lid ?? (isLidJid(c.id) ? c.id : undefined), c.jid ?? (c.id.endsWith("@s.whatsapp.net") ? c.id : undefined));
    const id = this.cj(c.id);
    if (!isUserJid(id)) return;
    if (c.name && !isMaskedName(c.name)) this.store.data.contacts[id] = c.name;
    if (c.verifiedName && !isMaskedName(c.verifiedName)) this.store.data.verified[id] = c.verifiedName;
    if (c.notify && !isMaskedName(c.notify)) { if (this.store.data.push[id] !== c.notify) this.nameSrc("contacts-notify"); this.store.data.push[id] = c.notify; }
    if (c.name || c.verifiedName || c.notify) this.markNameDirty(id);
    this.store.touch();
  }

  private groupName(sc: StoredChat): string {
    if (sc.name) return sc.name;
    const g = this.groups.get(sc.id);
    const names = (g?.participants ?? []).map((p) => this.cj(p.jid ?? p.id, p.jid)).filter((j) => !this.isMe(j)).map((j) => this.nameOf(j));
    return groupFallbackName(names, g?.participants.length ?? 0);
  }

  private toChat(sc: StoredChat): Chat {
    const spaceId = sc.spaceId && this.store.data.spaces[sc.spaceId] ? sc.spaceId : undefined;
    const chat: Chat = {
      id: sc.id, accountId: this.accountId, provider: PROVIDER,
      kind: spaceId ? "channel" : sc.kind,
      name: sc.kind === "group" ? this.groupName(sc) : this.nameOf(sc.id),
    };
    if (spaceId) chat.spaceId = spaceId;
    if (sc.unread) chat.unread = sc.unread;
    if (sc.lastMessageAt) chat.lastMessageAt = sc.lastMessageAt;
    if (sc.muted) chat.muted = true;
    if (sc.readOnly) chat.readOnly = true;
    if (sc.description) chat.description = sc.description;
    if (sc.kind === "dm" && this.blocked.has(sc.id)) chat.blocked = true;
    if (sc.ephemeral) chat.disappearing = sc.ephemeral;
    return chat;
  }

  // ------------------------------------------------------------------ message mapping
  /** Every key can carry both addressing forms of the same person (LID + phone number): record the pair. */
  private learnFromKey(key: WAMessageKey) {
    const part = key.participant ? normJid(key.participant) : undefined;
    if (part) {
      if (isLidJid(part)) this.learn(part, key.participantPn); else this.learn(key.participantLid, part);
    }
    const rj = key.remoteJid ? normJid(key.remoteJid) : undefined;
    if (rj && !isGroupJid(rj) && !key.fromMe) {
      if (isLidJid(rj)) this.learn(rj, key.senderPn); else this.learn(key.senderLid, rj);
    }
  }

  /** Map a Baileys message to a stored message; undefined if it is not a user-visible chat message. */
  private mapMessage(w: WAMessage): { chatId: string; s: StoredMsg } | undefined {
    const id = w.key.id;
    if (!id) return undefined;
    this.learnFromKey(w.key);
    const chatId = this.chatIdOf(w.key);
    if (!chatId) return undefined;
    const fromMe = !!w.key.fromMe;
    const rawPart = w.key.participant ?? w.participant ?? undefined;
    const senderId = fromMe ? this.selfId()
      : isGroupJid(chatId) ? (rawPart ? this.cj(rawPart, w.key.participantPn) : chatId)
      : chatId;
    let waiting = false;
    let ex = extract(normalizeMessageContent(w.message));
    if (!ex && w.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT) {
      // not decrypted (yet): keep a placeholder with the same id; the retried message replaces it
      ex = { text: WAITING_TEXT, card: { ...WAITING_CARD } };
      waiting = true;
      this.countUnsupported("stub CIPHERTEXT (placeholder)");
    }
    if (!ex && w.messageStubType) {
      // group / community / security notices arrive as "stub" messages without content
      // a participant may be me under any of my ids (phone number, LID, with or without device suffix)
      const targets = stubParticipants(w.messageStubParameters).map((ids) => {
        if (ids.some((j) => this.isMe(j))) return "You";
        for (const j of ids) { const n = this.nameOf(this.cj(j)); if (n && n !== "WhatsApp user" && !n.startsWith("+")) return n; }
        return this.nameOf(this.cj(ids[0]!));
      });
      // WhatsApp flags many notices someone ELSE caused as fromMe (history sync, server notices): the participant decides who acted
      const actor = rawPart ? (this.isMe(rawPart) ? "You" : this.nameOf(this.cj(rawPart, w.key.participantPn))) : fromMe ? "You" : "";
      const st = w.messageStubType === proto.WebMessageInfo.StubType.REVOKE ? { text: "", deleted: true } as const : describeStub(w.messageStubType, w.messageStubParameters, actor, targets);
      if (st && "deleted" in st) ex = { text: "", deleted: true };
      else if (st) ex = { text: st.text, system: true, ...(st.card ? { card: st.card } : {}) };
      else this.countUnsupported(`stub ${stubName(w.messageStubType)}`);
    }
    if (!ex) {
      const field = w.messageStubType ? undefined : topLevelField(unwrap(w.message) ?? {});
      if (field && !BENIGN_DROPS.has(field)) { const n = (this.dropped.get(field) ?? 0) + 1; this.dropped.set(field, n); dbg(`dropped: ${field} n=${n}`); }
      return undefined;
    }
    if (ex.unsupported) this.countUnsupported(`type ${ex.unsupported}`);
    if (!fromMe && w.pushName && isUserJid(senderId)) {
      const push = this.store.data.push;
      const keys = new Set([senderId, ...(rawPart ? [normJid(rawPart)] : [])]);
      let changed = false;
      for (const k of keys) if (isUserJid(k) && push[k] !== w.pushName) { push[k] = w.pushName; changed = true; }
      if (changed) {
        this.nameSrc("message-pushname"); for (const k of keys) this.markNameDirty(k); this.store.touch(); this.notifyChats(); }
    }
    if (!fromMe && w.verifiedBizName && isUserJid(senderId) && this.store.data.verified[senderId] !== w.verifiedBizName) {
      this.store.data.verified[senderId] = w.verifiedBizName; this.markNameDirty(senderId); this.store.touch(); this.notifyChats();
    }
    const tsSec = num(w.messageTimestamp);
    const m: Message = {
      id, chatId, senderId, fromMe,
      sender: fromMe ? "Me" : this.nameOf(senderId),
      text: this.withMentions(ex.text, ex.context), time: toIso(tsSec),
    };
    if (ex.context?.isForwarded) m.forwarded = true;
    if ((ex.context?.expiration ?? 0) > 0) m.expiresIn = ex.context!.expiration!;
    this.learnEphemeral(chatId, ex.context?.expiration, tsSec, w.messageStubType, w.messageStubParameters);
    if (fromMe) {
      m.status = statusFromAck(w.status) ?? "sent";
      const rc = this.receiptsOf(chatId, w.userReceipt); // per-recipient times a history sync carries
      if (rc.length) m.receipts = rc;
    }
    const ctx = ex.context;
    if (ctx?.stanzaId) {
      const q = textOf(normalizeMessageContent(ctx.quotedMessage));
      m.replyTo = {
        messageId: ctx.stanzaId,
        ...(ctx.participant ? { sender: this.nameOf(this.cj(ctx.participant)) } : {}),
        ...(q ? { textPreview: preview(q) } : {}),
      };
    }
    if (ex.attachment) m.attachments = [ex.attachment.att];
    if (ex.deleted) m.deleted = true;
    if (ex.card) m.card = ex.card;
    if (ex.location) { m.location = ex.location; if (m.location.live) m.location.updatedAt = m.time; }
    if (ex.contacts) m.contacts = ex.contacts;
    if (ex.system) m.system = { kind: "info" };
    let poll: StoredMsg["poll"];
    if (ex.poll) {
      // history keeps the secret on the WebMessageInfo itself, live messages in messageContextInfo
      const secret = w.messageSecret ?? w.message?.messageContextInfo?.messageSecret ?? normalizeMessageContent(w.message)?.messageContextInfo?.messageSecret;
      poll = { secret: secret?.length ? Buffer.from(secret).toString("base64") : "", question: ex.poll.question, multiple: ex.poll.multiple, options: ex.poll.options, votes: {} };
      this.applyPollUpdates(poll, w.pollUpdates); // history delivers already-decrypted tallies (including my own votes from the phone)
      m.poll = buildPoll(poll, this.selfId());
      { const u = unwrap(normalizeMessageContent(w.message)) ?? undefined; // counts-only: which creation version / selectable count WhatsApp used
        const pc = u?.pollCreationMessageV3 ?? u?.pollCreationMessage ?? u?.pollCreationMessageV2;
        dbg(`poll-create in: version=${u?.pollCreationMessageV3 ? "v3" : u?.pollCreationMessageV2 ? "v2" : "v1"} selectable=${pc?.selectableOptionsCount ?? "none"} options=${ex.poll.options.length} multiple=${ex.poll.multiple} secret=${secret?.length ? "have" : "missing"} msgKeys=${Object.keys(w.message ?? {}).join(",")} ctxKeys=${Object.keys(w.message?.messageContextInfo ?? {}).join(",")} pcKeys=${Object.keys((pc ?? {}) as object).join(",")} wmiKeys=${Object.keys(w as object).filter((k) => !/^(key|message)$/.test(k)).join(",")} fromMe=${!!w.key?.fromMe} part=${w.key?.participant ? "y" : "n"}`); }
    }
    const s: StoredMsg = { m, ts: (tsSec > 0 ? tsSec : Math.floor(Date.now() / 1000)) * 1000 };
    if (rawPart) s.pj = rawPart;
    if (w.key.remoteJid) s.rj = w.key.remoteJid;
    if (ex.attachment) s.att = { [ex.attachment.att.id]: ex.attachment.desc };
    if (waiting) s.waiting = true;
    if (poll) s.poll = poll;
    const em = unwrap(w.message)?.eventMessage;
    if (em) {
      const secret = w.messageSecret ?? w.message?.messageContextInfo?.messageSecret ?? normalizeMessageContent(w.message)?.messageContextInfo?.messageSecret;
      s.event = {
        secret: secret?.length ? Buffer.from(secret).toString("base64") : "", name: em.name ?? "", start: num(em.startTime),
        ...(em.description ? { description: em.description } : {}), ...(num(em.endTime) ? { end: num(em.endTime) } : {}),
        ...(em.location?.name ? { place: em.location.name } : {}), ...(em.isCanceled ? { canceled: true } : {}), ...(em.joinLink ? { joinLink: em.joinLink } : {}),
        ...(em.extraGuestsAllowed ? { extraGuests: true } : {}),
      };
      if (fromMe && s.event.secret && !s.event.canceled && m.card) m.card.editable = true;
    }
    if (ex.seq !== undefined) s.seq = ex.seq;
    return { chatId, s };
  }

  /** Mark a stored message as deleted for everyone (idempotent). Clears what a deleted message must not keep: text, media, reactions, a pending placeholder. */
  private markDeleted(chatId: string, s: StoredMsg, emit = true): boolean {
    if (s.m.deleted && !s.waiting) return false;
    const was = s.m.deleted;
    s.m.deleted = true; s.m.text = ""; delete s.m.attachments; delete s.att; delete s.m.reactions; delete s.m.card; delete s.m.cards;
    if (s.waiting) { delete s.waiting; this.resend?.remove(s.m.id); }
    this.store.touch();
    if (emit && !was) this.emit({ type: "message-update", data: { chatId, messageId: s.m.id, patch: { deleted: true, text: "", reactions: [] } } });
    else if (emit) this.emit({ type: "message-update", data: { chatId, messageId: s.m.id, patch: { text: "", reactions: [] } } });
    return true;
  }

  /**
   * protocolMessage REVOKE ("delete for everyone", also admin deletes). Marks the original deleted; when we never had it
   * (sent before linking, older than the history window) a deleted placeholder with the original id is stored so the gap is visible.
   */
  private handleRevokeMessage(w: WAMessage, orig: proto.IMessageKey, emit = true) {
    const chatId = this.chatIdOf(w.key);
    const id = orig.id;
    if (!chatId || !id) return;
    this.learnFromKey(w.key);
    const known = this.store.find(chatId, id);
    if (known) { this.markDeleted(chatId, known, emit); return; }
    const fromMe = w.key.fromMe ? !!orig.fromMe : (!orig.fromMe && this.isMe(orig.participant));
    const part = orig.participant ?? (orig.fromMe ? undefined : w.key.participant ?? undefined);
    const senderId = fromMe ? this.selfId() : isGroupJid(chatId) ? (part ? this.cj(part) : chatId) : chatId;
    const tsSec = num(w.messageTimestamp);
    const m: Message = { id, chatId, senderId, fromMe, sender: fromMe ? "Me" : this.nameOf(senderId), text: "", time: toIso(tsSec), deleted: true };
    if (fromMe) m.status = "sent";
    const s: StoredMsg = { m, ts: (tsSec > 0 ? tsSec : Math.floor(Date.now() / 1000)) * 1000 };
    if (part) s.pj = part;
    if (w.key.remoteJid) s.rj = w.key.remoteJid;
    if (!this.store.add(chatId, s)) return;
    this.ensureChat(chatId);
    dbg("revoke of unknown message: deleted placeholder stored");
    if (emit) this.emit({ type: "message", data: { ...m, historical: true } });
  }

  private inlineSeen = new Set<string>();

  /** Persist one history chunk (from Baileys' event or from an inline payload we decoded ourselves). */
  private applyHistory(h: { chats: WAChat[]; contacts: WAContact[]; messages: WAMessage[]; syncType?: proto.HistorySync.HistorySyncType | null; progress?: number | null; peerDataRequestSessionId?: string | null }) {
    for (const c of h.contacts) this.applyContact(c);
    for (const c of h.chats) this.applyChat(c);
    const sorted = [...h.messages].sort((a, b) => num(a.messageTimestamp) - num(b.messageTimestamp));
    let stored = 0;
    for (const w of sorted) this.guard("message-map", () => { if (this.intake(w, false)) stored++; })();
    const notify = h.contacts.filter((c) => c.notify).length, named = h.contacts.filter((c) => c.name).length;
    dbg(`history-set type=${h.syncType != null ? proto.HistorySync.HistorySyncType[h.syncType] : "?"} chats=${h.chats.length} contacts=${h.contacts.length} (notify=${notify} name=${named}) messages=${h.messages.length} stored=${stored} progress=${h.progress ?? "-"}`);
    this.store.flush(); // history arrives once: never risk losing it to the debounce
    this.dbgSenders();
    this.emit({ type: "chats-changed", data: {} });
    this.queueUnnamedGroups();
    this.scheduleUnreadScan();
    const sid = h.peerDataRequestSessionId;
    if (sid) { this.historySeen.add(sid); this.historyWaiters.get(sid)?.(); }
  }

  // ---- placeholder resend ----
  private resend?: ResendQueue;
  private activityWaiters = new Map<string, (() => void)[]>();
  private notifyActivity(chatId: string) {
    const w = this.activityWaiters.get(chatId);
    if (w) { this.activityWaiters.delete(chatId); for (const f of w) f(); }
  }
  private waitForActivity(chatId: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const ok = () => { clearTimeout(t); resolve(true); };
      const t = setTimeout(() => { const l = this.activityWaiters.get(chatId); if (l) this.activityWaiters.set(chatId, l.filter((f) => f !== ok)); resolve(false); }, ms);
      this.activityWaiters.set(chatId, [...(this.activityWaiters.get(chatId) ?? []), ok]);
    });
  }

  // Requests to the phone (history, media re-upload, placeholder resend) are serialised inside Baileys (~5 s each). The background
  // placeholder queue must never starve what the user is waiting for, and must stop when the phone does not answer it.
  private peerBusy = 0; private peerBusyUntil = 0; private resendSent = 0; private resendDone = 0;
  private peerIdle() { return this.peerBusy === 0 && Date.now() >= this.peerBusyUntil; }
  /** Circuit breaker: after 60 requests with under 3% answered, stop until the next reconnect (the placeholders stay, the user can retry). */
  private resendTripped() { return this.resendSent >= 60 && this.resendDone / this.resendSent < 0.03; }
  private async peerWork<T>(fn: () => Promise<T>): Promise<T> {
    this.peerBusy++;
    try { return await fn(); } finally { this.peerBusy--; this.peerBusyUntil = Date.now() + 15_000; }
  }
  private async requestResend(e: Pending) {
    const sock = this.sock;
    if (!sock || !this.opened) return;
    this.resendSent++;
    dbg(`placeholder resend requested attempt=${e.attempts} pending=${this.resend?.size() ?? 0}`);
    const r = await sock.requestPlaceholderResend({ remoteJid: e.rj ?? e.chatId, id: e.id, fromMe: e.fromMe, ...(e.pj ? { participant: e.pj } : {}) });
    // undefined = Baileys already has a request for this id in flight (e.g. its own for an 'unavailable' message): nothing was sent
    if (r === undefined) { this.resend?.skipped(e.id); dbg("placeholder resend skipped (already in flight)"); }
  }

  /** Called on start (after the cache is loaded): queue + migrate placeholders stored by earlier versions. */
  initResend() {
    const timers = { now: () => Date.now(), set: (fn: () => void, ms: number) => { const h = setTimeout(fn, ms); h.unref?.(); return h; }, clear: (h: unknown) => clearTimeout(h as NodeJS.Timeout) };
    this.resend = new ResendQueue(this.store.data.pending, {
      timers,
      request: (e) => this.requestResend(e),
      canRun: () => !!this.sock && this.opened && !this.stopped && this.peerIdle() && !this.resendTripped(),
      onChange: () => this.store.touch(),
      onGiveUp: (e) => {
        dbg("placeholder gave up");
        const s = this.store.find(e.chatId, e.id);
        if (!s) { this.resend?.remove(e.id); return; }
        if (!s.waiting) return;
        s.m.text = GIVEUP_TEXT; s.m.card = { ...GIVEUP_CARD };
        this.store.touch();
        this.emit({ type: "message-update", data: { chatId: e.chatId, messageId: e.id, patch: { text: GIVEUP_TEXT, card: s.m.card } } });
      },
    });
    // entries whose message is gone (store trimmed, chat deleted, deleted for everyone) can never be resolved
    for (const [id, e] of Object.entries(this.store.data.pending)) {
      const s = this.store.find(e.chatId, id);
      if (!s || s.m.deleted) { delete this.store.data.pending[id]; if (s) delete s.waiting; }
    }
    for (const [chatId, arr] of Object.entries(this.store.data.msgs)) {
      for (const s of arr) {
        if (s.waiting || !/^Waiting for this message\./.test(s.m.text)) continue;
        s.waiting = true; // placeholder written by an older version
        this.resend.add({ chatId, id: s.m.id, fromMe: s.m.fromMe, ...(s.rj ? { rj: s.rj } : {}), ...(s.pj ? { pj: s.pj } : {}) });
        s.m.text = WAITING_TEXT; s.m.card = { ...WAITING_CARD };
      }
    }
  }

  async refreshChat(chatId: string): Promise<string> {
    this.live();
    const pend = (this.resend?.list(chatId) ?? []).slice(0, 50);
    const gap = this.hasUnreadGap(chatId);
    if (!pend.length && !gap) return "Nothing to ask for: all messages are here.";
    const answered = this.waitForActivity(chatId, 8000);
    // not rate-limited like the background queue, but bounded (50) and gentle: 5 at a time, in the background
    void (async () => {
      for (let i = 0; i < pend.length; i += 5) {
        await Promise.allSettled(pend.slice(i, i + 5).map(async (e) => {
          if (e.gaveUp) { // a manual retry revives it
            e.gaveUp = false; e.final = false; e.attempts = 0;
            const s = this.store.find(chatId, e.id);
            if (s?.waiting) { s.m.text = WAITING_TEXT; s.m.card = { ...WAITING_CARD }; this.emit({ type: "message-update", data: { chatId, messageId: e.id, patch: { text: WAITING_TEXT, card: s.m.card } } }); }
          }
          e.attempts = Math.max(1, e.attempts); e.next = Date.now() + 30_000;
          await this.requestResend(e);
        }));
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    if (gap) void this.backfillUnread(chatId, true);
    const got = await answered;
    if (!got) return "Your phone didn't answer. Open WhatsApp on it and try again.";
    return pend.length ? `Asked your phone to resend ${pend.length} message${pend.length === 1 ? "" : "s"}.` : "Asked your phone for the newest messages.";
  }

  /**
   * History-sync notifications. Baileys 6.7.24 can only download blobs addressed by directPath+mediaKey, but the companion
   * registration asks for `inlineInitialPayloadInE2EeMsg`, so the phone may send the bootstrap chunk INLINE
   * (`initialHistBootstrapInlinePayload`), which Baileys ignores. Decode those ourselves; log (counts only) what arrives.
   */
  private onHistoryNotification(w: WAMessage) {
    const n = w.message ? getHistoryMsg(w.message) : undefined;
    if (!n) return;
    const id = w.key.id ?? "";
    if (this.inlineSeen.has(id)) return;
    this.inlineSeen.add(id);
    const type = n.syncType != null ? proto.Message.HistorySyncNotification.HistorySyncType[n.syncType] : "?";
    const inline = !!n.initialHistBootstrapInlinePayload?.length;
    dbg(`history notification type=${type} inline=${inline} direct=${!!n.directPath} handle=${!!n.encHandle} chunk=${n.chunkOrder ?? "-"} progress=${n.progress ?? "-"}`);
    if (!inline) { this.harvestChunk(n); return; }
    void (async () => {
      try {
        const raw = Buffer.from(n.initialHistBootstrapInlinePayload!);
        let buf: Buffer = raw;
        try { buf = await promisify(inflate)(raw); } catch { /* maybe not compressed */ }
        const hs = proto.HistorySync.decode(buf);
        this.applyHarvest(harvestHistorySync(hs), "history");
        this.applyHistory({ ...processHistoryMessage(hs), peerDataRequestSessionId: n.peerDataRequestSessionId });
        this.scheduleAppStateResync(2000);
      } catch (e) { this.err("history-inline", e); }
    })();
  }

  /**
   * Baileys only reads `pushnames` (and ignores `phoneNumberToLidMappings`) for PUSH_NAME chunks, but WhatsApp may put them in the
   * bootstrap chunk too. The bootstrap is small, so download that one a second time and read what Baileys drops.
   */
  private harvestChunk(n: proto.Message.IHistorySyncNotification) {
    const T = proto.Message.HistorySyncNotification.HistorySyncType;
    if (n.syncType !== T.INITIAL_BOOTSTRAP || !n.directPath || !n.mediaKey || num(n.fileLength) > 30_000_000) return;
    void (async () => {
      try {
        const hs = await downloadHistory(n, {});
        const h = harvestHistorySync(hs);
        dbg(`bootstrap harvest pushnames=${h.pushnames.length} lid-pairs=${h.pairs.length} conversations=${hs.conversations?.length ?? 0}`);
        this.applyHarvest(h, "bootstrap");
      } catch { dbg("bootstrap harvest failed"); }
    })();
  }

  private lastAppStateKey?: string;
  private appStateTimer?: NodeJS.Timeout;
  private scheduleAppStateResync(ms: number) {
    const sock = this.sock;
    if (!sock) return;
    if (this.appStateTimer) clearTimeout(this.appStateTimer);
    this.appStateTimer = setTimeout(() => { void this.resyncAppState(sock); }, ms);
    this.appStateTimer.unref?.();
  }

  private unsupported = new Map<string, number>();
  private dropped = new Map<string, number>();
  /** Counts only (never content): which message types we could not map. */
  private countUnsupported(what: string) {
    const n = (this.unsupported.get(what) ?? 0) + 1;
    this.unsupported.set(what, n);
    dbg(`unsupported ${what} n=${n}`);
  }

  private pendingVotes = new Map<string, WAMessage[]>();

  /** Entry for every inbound message (live or history): poll votes are decrypted, everything else is ingested. */
  private intake(w: WAMessage, live: boolean, emit = true, historical = !live): Message | undefined {
    const content = unwrap(normalizeMessageContent(w.message)) ?? undefined; // also device-sent / group-mentioned wrappers
    const proto0 = content?.protocolMessage;
    if (proto0?.type === proto.Message.ProtocolMessage.Type.REVOKE && proto0.key?.id) { this.handleRevokeMessage(w, proto0.key, emit); return undefined; }
    if (proto0?.lidMigrationMappingSyncMessage?.encodedMappingPayload?.length) {
      // Baileys 6.7.24 ignores it: the phone's complete phone-number <-> LID table. Only our own phone may send it.
      if (w.key.fromMe) this.guard("lid-migration", () => {
        const pairs = lidMigrationPairs(proto.LIDMigrationMappingSyncPayload.decode(proto0.lidMigrationMappingSyncMessage!.encodedMappingPayload!));
        this.applyHarvest({ pushnames: [], pairs }, "sync");
        dbg(`lid migration mapping sync pairs=${pairs.length}`);
      })();
      return undefined;
    }
    if (content?.pollUpdateMessage) { this.handleVote(w, content.pollUpdateMessage); return undefined; }
    if (content?.pinInChatMessage) { this.handlePin(w, content.pinInChatMessage, content.messageContextInfo ?? w.message?.messageContextInfo); return undefined; }
    if (content?.secretEncryptedMessage?.secretEncType === proto.Message.SecretEncryptedMessage.SecretEncType.EVENT_EDIT) { this.handleEventEdit(w, content.secretEncryptedMessage); return undefined; }
    const m = this.ingest(w, live, emit, historical);
    if (m?.poll && w.key.id) {
      const waiting = this.pendingVotes.get(w.key.id);
      if (waiting) { this.pendingVotes.delete(w.key.id); for (const v of waiting) this.guard("poll-vote", () => { this.intake(v, false); })(); }
    }
    return m;
  }

  /** Counts-only diagnostics for every poll vote (never ids, names or text). */
  private pollIn(f: { fromMe: boolean; chat: string; creator: string; voter: string; secret: string; known: string; decrypt: string; options: number }) {
    dbg(`poll-update in: fromMe=${f.fromMe} chat=${f.chat} creatorForm=${f.creator} voterForm=${f.voter} secret=${f.secret} pollKnown=${f.known} decrypt=${f.decrypt} options=${f.options}`);
  }

  /** An incoming pin / unpin (someone else, or one of my other devices): mark the target message. Older than what we hold = ignored. */
  private handlePin(w: WAMessage, pin: proto.Message.IPinInChatMessage, ctx?: proto.IMessageContextInfo | null) {
    const chatId = this.chatIdOf(w.key), id = pin.key?.id;
    if (!chatId || !id) return;
    const s = this.store.find(chatId, id);
    if (!s) return;
    const at = num(pin.senderTimestampMs) || num(w.messageTimestamp) * 1000 || Date.now();
    const pinned = pin.type === proto.Message.PinInChatMessage.Type.PIN_FOR_ALL;
    if (!pinned && pin.type !== proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL) return;
    if (s.m.pinnedAt && at < Date.parse(s.m.pinnedAt)) return; // a stale replay (history) of an older pin / unpin
    if (pinned) {
      const dur = num(ctx?.messageAddOnDurationInSecs);
      const raw = w.key.fromMe ? this.selfId() : isGroupJid(chatId) ? this.cj(w.key.participant ?? "", w.key.participantPn) : chatId;
      const patch: MessagePatch = { pinned: true, pinnedAt: new Date(at).toISOString(), pinnedBy: raw || undefined, pinnedUntil: dur > 0 ? new Date(at + dur * 1000).toISOString() : undefined };
      Object.assign(s.m, patch); if (!patch.pinnedUntil) delete s.m.pinnedUntil; if (!patch.pinnedBy) delete s.m.pinnedBy;
      this.store.touch(); this.emit({ type: "message-update", data: { chatId, messageId: id, patch } });
    } else {
      delete s.m.pinned; delete s.m.pinnedAt; delete s.m.pinnedBy; delete s.m.pinnedUntil;
      this.store.touch(); this.emit({ type: "message-update", data: { chatId, messageId: id, patch: { pinned: false } } });
    }
  }

  private handleVote(w: WAMessage, upd: proto.Message.IPollUpdateMessage) {
    const fromMe = !!w.key.fromMe;
    const ck = upd.pollCreationMessageKey, enc = upd.vote;
    dbg(`poll-update key: remoteJid=${jidForm(ck?.remoteJid)} fromMe=${ck?.fromMe} participant=${ck?.participant ? jidForm(ck.participant) : "none"} outerRemote=${jidForm(w.key.remoteJid)} outerFromMe=${!!w.key.fromMe} sts=${typeof upd.senderTimestampMs}`);
    const chatId = this.chatIdOf(w.key);
    const chat = chatId ? (isGroupJid(chatId) ? "group" : "dm") : "?";
    const raw = w.key.participant ?? w.key.remoteJid ?? chatId ?? "";
    const base = { fromMe, chat, creator: "?", voter: fromMe ? "?" : jidForm(raw), secret: "missing", known: "no", decrypt: "-", options: 0 };
    if (!ck?.id || !enc || !chatId) { this.pollIn({ ...base, decrypt: "fail:malformed" }); return; }
    const s = this.store.find(chatId, ck.id);
    if (!s?.poll) {
      this.pollIn({ ...base, decrypt: "deferred" });
      if (this.pendingVotes.size < 200) { const a = this.pendingVotes.get(ck.id) ?? []; a.push(w); this.pendingVotes.set(ck.id, a); }
      return;
    }
    const creatorRaw = s.m.fromMe ? (this.selfPn ?? this.selfLid) : (s.pj ?? s.rj);
    const known = { ...base, known: "yes", creator: jidForm(creatorRaw), secret: s.poll.secret ? "have" : "missing" };
    if (!s.poll.secret) { this.pollIn({ ...known, decrypt: "fail:no-secret" }); return; } // cannot be decrypted without the poll's secret
    const voterId = fromMe ? this.selfId() : this.cj(raw, w.key.participantPn ?? w.key.senderPn);
    const voters = fromMe ? [this.selfPn, this.selfLid] : [normJid(raw), voterId, ...counterparts(this.store.data, voterId), w.key.participantPn, w.key.senderPn];
    const creators = s.m.fromMe ? [this.selfPn, this.selfLid]
      : [s.pj, s.rj, s.m.senderId, ...counterparts(this.store.data, s.m.senderId)];
    const clean = (a: (string | null | undefined)[]) => a.filter((x): x is string => !!x).map(normJid);
    const cs = clean(creators), vs = clean(voters);
    const hit = tryDecryptVoteEx(enc, Buffer.from(s.poll.secret, "base64"), ck.id, cs, vs);
    if (!hit) { this.pollIn({ ...known, decrypt: `fail:no-key-match(c=${new Set(cs).size},v=${new Set(vs).size})` }); return; }
    this.pollIn({ ...known, creator: jidForm(hit.creator), voter: jidForm(hit.voter), decrypt: "ok", options: hit.options.length });
    const t = num(upd.senderTimestampMs) || num(w.messageTimestamp) * 1000;
    if (applyVote(s.poll, voterId, hit.options, t)) this.refreshPoll(chatId, s);
  }

  /** Tallies that Baileys/history already decrypted (WebMessageInfo.pollUpdates). Returns true when anything changed. */
  private applyPollUpdates(sp: NonNullable<StoredMsg["poll"]>, updates: proto.IPollUpdate[] | null | undefined): boolean {
    let changed = false;
    for (const u of updates ?? []) {
      const k = u.pollUpdateMessageKey;
      if (!k || !u.vote) continue;
      const voter = k.fromMe ? this.selfId() : this.cj(k.participant ?? k.remoteJid ?? "", (k as WAMessageKey).participantPn);
      if (!voter) continue;
      const opts = (u.vote.selectedOptions ?? []).map((b) => Buffer.from(b).toString("hex"));
      if (applyVote(sp, voter, opts, num(u.senderTimestampMs))) changed = true;
    }
    return changed;
  }

  private secretWaiters = new Map<string, () => void>();

  /** Replace the position of a stored location message and tell the Hub. */
  private setLocation(chatId: string, s: StoredMsg, loc: NonNullable<Message["location"]>, seq: number | undefined, ts: number) {
    const next = { ...loc };
    if (next.live) next.updatedAt = new Date(ts).toISOString();
    s.m.location = next; s.seq = seq ?? s.seq; s.ts = Math.max(s.ts, ts);
    this.store.touch();
    this.emit({ type: "message-update", data: { chatId, messageId: s.m.id, patch: { location: next } } });
  }

  /** WhatsApp sends no explicit "stopped sharing" we can see in 6.7.24: a share without updates for 30 min is treated as ended. */
  private sweepLiveLocations(now = Date.now()) {
    for (const [chatId, arr] of Object.entries(this.store.data.msgs)) {
      for (const s of arr) {
        const l = s.m.location;
        if (!l?.live) continue;
        const last = l.updatedAt ? Date.parse(l.updatedAt) : s.ts;
        if ((l.liveUntil && Date.parse(l.liveUntil) < now) || now - last > 30 * 60_000) this.setLocation(chatId, s, { ...l, live: false }, s.seq, s.ts);
      }
    }
  }
  private liveSweepTimer?: NodeJS.Timeout;

  private refreshPoll(chatId: string, s: StoredMsg) {
    if (!s.poll) return;
    s.m.poll = buildPoll(s.poll, this.selfId());
    this.store.touch();
    this.emit({ type: "message-update", data: { chatId, messageId: s.m.id, patch: { poll: s.m.poll } } });
  }

  /** Store a message and (optionally) emit it. Returns true when it was new. */
  /**
   * @param historical true for anything that is not a fresh arrival (history sync, backfill, 'append' upserts, re-deliveries):
   *   the emitted copy carries `historical: true` so the Hub/UI do not notify or bump unread. The stored copy stays unflagged.
   */
  private ingest(w: WAMessage, live: boolean, emit = true, historical = !live): Message | undefined {
    const r = this.mapMessage(w);
    if (!r) return undefined;
    if (!this.store.add(r.chatId, r.s)) {
      // A re-delivery (history / on-demand sync) of a message we once stored as a placeholder upgrades it in place.
      const old = this.store.find(r.chatId, r.s.m.id);
      if (old?.m.location && r.s.m.location && (old.m.location.live || r.s.m.location.live)) {
        // live location updates reuse the message id: newer position replaces the old one in place
        if ((r.s.seq ?? 0) >= (old.seq ?? 0) && r.s.ts >= old.ts - 1000) this.setLocation(r.chatId, old, r.s.m.location, r.s.seq, r.s.ts);
        return undefined;
      }
      if (old?.poll && r.s.poll) {
        // same poll delivered again (history, resend): learn a missing secret and merge tallies
        let changed = false;
        if (!old.poll.secret && r.s.poll.secret) { old.poll.secret = r.s.poll.secret; changed = true; }
        for (const [voter, v] of Object.entries(r.s.poll.votes)) if (applyVote(old.poll, voter, v.o, v.t)) changed = true;
        if (changed) this.refreshPoll(r.chatId, old);
        this.secretWaiters.get(old.m.id)?.();
        return undefined;
      }
      if (old && PLACEHOLDER.test(old.m.text) && !r.s.waiting && !old.m.editedAt && !old.m.deleted && r.s.m.text !== old.m.text) {
        if (old.waiting) { delete old.waiting; if (this.resend?.remove(old.m.id)) { this.resendDone++; dbg("placeholder resolved"); } }
        old.m = { ...r.s.m, status: old.m.status ?? r.s.m.status, reactions: old.m.reactions };
        delete old.att; if (r.s.att) old.att = r.s.att;
        if (r.s.poll) old.poll = r.s.poll;
        this.store.touch();
        if (emit) this.emit({ type: "message", data: { ...old.m, historical: true } }); // a re-delivery is never a fresh arrival
        this.notifyActivity(r.chatId);
        return old.m;
      }
      if (old && r.s.m.deleted && !old.m.deleted) this.markDeleted(r.chatId, old, emit);
      return undefined;
    }
    if (r.s.waiting) this.resend?.add({ chatId: r.chatId, id: r.s.m.id, fromMe: r.s.m.fromMe, ...(r.s.rj ? { rj: r.s.rj } : {}), ...(r.s.pj ? { pj: r.s.pj } : {}) });
    this.notifyActivity(r.chatId);
    const c = this.ensureChat(r.chatId);
    const isNew = !c.lastMessageAt && !c.name;
    if (!c.lastMessageAt || r.s.m.time > c.lastMessageAt) c.lastMessageAt = r.s.m.time;
    if (live && !r.s.m.fromMe && !r.s.m.system) c.unread = (c.unread ?? 0) + 1;
    if (emit) {
      this.emit({ type: "message", data: historical ? { ...r.s.m, historical: true } : r.s.m });
      if (isNew || live) this.emit({ type: "chats-changed", data: { chatId: r.chatId } });
    }
    return r.s.m;
  }

  private patch(chatId: string, messageId: string, fn: (s: StoredMsg) => MessagePatch | undefined) {
    const s = this.store.find(chatId, messageId);
    if (!s) return;
    const p = fn(s);
    if (!p) return;
    this.store.touch();
    this.emit({ type: "message-update", data: { chatId, messageId, patch: p } });
  }

  private setReaction(s: StoredMsg, senderId: string, emoji: string | null): MessagePatch {
    const next: Reaction[] = [];
    for (const r of s.m.reactions ?? []) {
      const ids = r.senderIds.filter((x) => x !== senderId);
      if (ids.length) next.push({ emoji: r.emoji, senderIds: ids, ...(ids.includes(this.selfId()) ? { mine: true } : {}) });
    }
    if (emoji) {
      const ex = next.find((r) => r.emoji === emoji);
      if (ex) ex.senderIds.push(senderId); else next.push({ emoji, senderIds: [senderId] });
      for (const r of next) if (r.senderIds.includes(this.selfId())) r.mine = true;
    }
    s.m.reactions = next;
    return { reactions: next };
  }

  // ------------------------------------------------------------------ Baileys events
  private wire(sock: WASocket) {
    const ev = sock.ev;
    // Group info / notices carry <participant> nodes: harvest names and lid<->number pairs Baileys' own parsers drop
    const ws = (sock as unknown as { ws?: { on?: (e: string, f: (n: unknown) => void) => void } }).ws;
    ws?.on?.("frame", (n) => { if (sock === this.sock) this.guard("frame-tap", () => this.tapFrame(n))(); });
    ev.on("messages.upsert", this.guard("messages-upsert", ({ messages, type, requestId }) => {
      if (sock !== this.sock) return;
      // a phone's answer to a resend request arrives as 'notify' with a requestId: it is a replay, not a new arrival
      if (requestId) dbg(`placeholder resend response messages=${messages.length}`);
      const live = type === "notify" && !requestId;
      for (const w of messages) this.guard("history-notification", () => this.onHistoryNotification(w))();
      for (const w of messages) this.guard("message-map", () => { this.intake(w, live); })();
    }));

    ev.on("messaging-history.set", this.guard("history-set", (h) => {
      if (sock !== this.sock) return;
      this.applyHistory(h);
    }));

    ev.on("chats.upsert", this.guard("chats-upsert", (cs) => { for (const c of cs) this.applyChat(c); this.emit({ type: "chats-changed", data: {} }); }));
    ev.on("chats.update", this.guard("chats-update", (cs) => { for (const c of cs) this.applyChat(c); this.emit({ type: "chats-changed", data: {} }); }));
    ev.on("chats.delete", this.guard("chats-delete", (ids) => {
      for (const id of ids) { const j = this.cj(id); delete this.store.data.chats[j]; delete this.store.data.msgs[j]; }
      this.store.touch(); this.emit({ type: "chats-changed", data: {} });
    }));
    ev.on("chats.phoneNumberShare", this.guard("lid-map", ({ lid, jid }) => this.learn(lid, jid)));
    ev.on("contacts.upsert", this.guard("contacts", (cs) => { for (const c of cs) this.applyContact(c); dbg(`contacts.upsert n=${cs.length}`); this.notifyChats(); }));
    ev.on("contacts.update", this.guard("contacts", (cs) => {
      let pics = 0;
      for (const c of cs) {
        this.applyContact(c);
        // 'picture' notifications (people and groups): the cached picture / "no picture" verdict is outdated
        if (c.id && (c.imgUrl === "changed" || c.imgUrl === "removed")) {
          const j = normJid(c.id);
          this.avatars.remove(j); this.avatarFailUntil.delete(j);
          const pn = isLidJid(j) ? this.store.data.lidToPn[j] : undefined; if (pn) this.avatars.remove(pn);
          pics++;
          this.emit({ type: "avatar-changed", data: { id: j } }); if (pn) this.emit({ type: "avatar-changed", data: { id: pn } }); // the Hub refreshes its stored copy
        }
      }
      dbg(`contacts.update n=${cs.length}${pics ? ` pictures-changed=${pics}` : ""}`); this.notifyChats();
    }));

    ev.on("groups.upsert", this.guard("groups", (gs) => {
      for (const g of gs) this.applyGroup(g);
      this.emit({ type: "spaces-changed", data: {} }); this.emit({ type: "chats-changed", data: {} });
    }));
    ev.on("groups.update", this.guard("groups", async (us) => {
      for (const u of us) {
        if (!u.id) continue;
        const id = normJid(u.id);
        const cur = this.groups.get(id);
        if (cur) this.applyGroup({ ...cur, ...u, id: cur.id }, false);
        else if (this.sock === sock) { try { this.applyGroup(await sock.groupMetadata(id)); } catch { /* not a member */ } }
      }
      this.emit({ type: "spaces-changed", data: {} }); this.emit({ type: "chats-changed", data: {} });
    }));
    ev.on("group-participants.update", this.guard("groups", async ({ id }) => {
      if (this.sock !== sock) return;
      try { this.applyGroup(await sock.groupMetadata(id)); }
      catch { const c = this.store.data.chats[normJid(id)]; if (c) c.member = false; this.store.touch(); } // no longer a member
      this.emit({ type: "chats-changed", data: { chatId: normJid(id) } });
    }));

    ev.on("messages.update", this.guard("messages-update", (updates) => {
      for (const { key, update } of updates) {
        const chatId = this.chatIdOf(key);
        if (!chatId || !key.id) continue;
        const id = key.id;
        if (update.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
          const sm = this.store.find(chatId, id);
          if (sm) this.markDeleted(chatId, sm); // unknown originals are handled by handleRevokeMessage (it has the original key)
          continue;
        }
        const lu = update.message?.liveLocationMessage ?? update.message?.locationMessage;
        if (lu) {
          const sm = this.store.find(chatId, id);
          const d = describeOther(update.message!);
          if (sm && d && d !== "skip" && d.location) this.setLocation(chatId, sm, d.location, d.seq, (num(update.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000);
          continue;
        }
        if (update.pollUpdates?.length) {
          const sm = this.store.find(chatId, id);
          if (sm?.poll && this.applyPollUpdates(sm.poll, update.pollUpdates)) this.refreshPoll(chatId, sm);
          continue;
        }
        const edited = update.message?.editedMessage?.message;
        if (edited) {
          const ed = extract(normalizeMessageContent(edited));
          const text = ed ? this.withMentions(ed.text, ed.context) : undefined;
          if (text !== undefined) {
            const at = toIso(num(update.messageTimestamp));
            this.patch(chatId, id, (s) => { s.m.text = text; s.m.editedAt = at; return { text, editedAt: at }; });
          }
          continue;
        }
        const st = statusFromAck(update.status);
        // 1:1 acks carry no timestamp and no jid: the only recipient is the chat's peer, the time is when the ack reached us
        if (st && key.fromMe) this.applyStatus(chatId, id, st, isGroupJid(chatId) || (st !== "delivered" && st !== "read") ? undefined : chatId);
      }
    }));

    ev.on("message-receipt.update", this.guard("receipt", (rs) => {
      for (const { key, receipt } of rs) {
        const chatId = this.chatIdOf(key);
        if (chatId && key.id && !key.fromMe && (this.isMe(receipt.userJid) || this.isMe(this.cj(receipt.userJid))) && (num(receipt.readTimestamp) || num(receipt.playedTimestamp))) { this.readElsewhere(chatId, key.id); continue; } // I read it on another device (phone): the chat is read here too
        if (!chatId || !key.id || !key.fromMe) continue;
        const who = this.cj(receipt.userJid);
        if (this.isMe(receipt.userJid) || this.isMe(who)) continue; // my own other device
        const dAt = num(receipt.receiptTimestamp), rAt = num(receipt.readTimestamp) || num(receipt.playedTimestamp); // "played" (voice/video) counts as read
        if (dAt) this.applyStatus(chatId, key.id, "delivered", who, toIso(dAt));
        if (rAt) this.applyStatus(chatId, key.id, "read", who, toIso(rAt));
      }
    }));

    ev.on("messages.reaction", this.guard("reaction", (rs) => {
      for (const { key, reaction } of rs) {
        const chatId = this.chatIdOf(key);
        if (!chatId || !key.id) continue;
        const rk = reaction.key;
        const sender = rk?.fromMe ? this.selfId() : this.cj(rk?.participant ?? rk?.remoteJid ?? chatId);
        const emoji = reaction.text || null;
        this.patch(chatId, key.id, (s) => (s.m.deleted ? undefined : this.setReaction(s, sender, emoji))); // a deleted message stays deleted
      }
    }));

    ev.on("messages.delete", this.guard("messages-delete", (d) => {
      if ("keys" in d) {
        for (const k of d.keys) {
          const chatId = this.chatIdOf(k);
          if (chatId && k.id) this.patch(chatId, k.id, (s) => { s.m.deleted = true; s.m.text = ""; delete s.m.reactions; return { deleted: true, text: "", reactions: [] }; });
        }
      } else {
        const j = this.cj(d.jid);
        delete this.store.data.msgs[j];
        this.store.touch();
        this.emit({ type: "chats-changed", data: { chatId: j } });
      }
    }));

    ev.on("blocklist.set", this.guard("blocklist", ({ blocklist }) => { this.setBlocklist(blocklist); this.emit({ type: "chats-changed", data: {} }); }));
    ev.on("blocklist.update", this.guard("blocklist", ({ blocklist, type }) => {
      for (const j of blocklist) { const c = this.cj(j); if (type === "add") this.blocked.add(c); else this.blocked.delete(c); }
      this.emit({ type: "chats-changed", data: {} });
    }));

    ev.on("presence.update", this.guard("presence", ({ id, presences }) => {
      const chatId = this.cj(id);
      for (const [who, p] of Object.entries(presences)) {
        if (this.isMe(who)) continue;
        const typing = p.lastKnownPresence === "composing" || p.lastKnownPresence === "recording";
        this.emit({ type: "typing", data: { chatId, senderId: this.cj(who), typing } });
        if (!isGroupJid(chatId) && p.lastKnownPresence) {
          // available/composing/recording = online; unavailable = offline (lastSeen in epoch seconds when the contact shares it)
          const online = p.lastKnownPresence !== "unavailable";
          const ls = typeof p.lastSeen === "number" && p.lastSeen > 0 ? new Date(p.lastSeen * 1000).toISOString() : undefined;
          this.emit({ type: "presence", data: { accountId: this.accountId, chatId, contactId: this.cj(who), online, ...(ls ? { lastSeen: ls } : {}) } });
        }
      }
    }));
  }

  private setBlocklist(list: (string | undefined)[]) {
    this.blocked = new Set(list.filter((j): j is string => !!j).map((j) => this.cj(j)));
  }

  /** Per-recipient receipts (`by` = canonical jid, `at` = when that person got/read it) are always reported; the aggregate status only moves forward. */
  private applyStatus(chatId: string, messageId: string, status: "sent" | "delivered" | "read" | "failed" | "sending", by?: string, at?: string) {
    const s = this.store.find(chatId, messageId);
    if (!s) return;
    const per = !!by && (status === "delivered" || status === "read");
    if (per) {
      const when = at ?? new Date().toISOString();
      const rc = (s.m.receipts ??= []); let r = rc.find((x) => x.id === by);
      if (!r) { if (rc.length >= 1000) return; r = { id: by! }; rc.push(r); }
      r[status === "read" ? "read" : "delivered"] = when;
      this.store.touch();
      if (betterStatus(s.m.status, status)) s.m.status = status;
      this.emit({ type: "receipt", data: { chatId, messageId, status, by: by!, at: when } });
      return;
    }
    if (!betterStatus(s.m.status, status)) return;
    s.m.status = status;
    this.store.touch();
    this.emit({ type: "receipt", data: { chatId, messageId, status } });
  }
  /** WebMessageInfo.userReceipt (history) -> receipts, canonical ids, bounded, my own devices left out. */
  private receiptsOf(chatId: string, list: { userJid?: string | null; receiptTimestamp?: unknown; readTimestamp?: unknown; playedTimestamp?: unknown }[] | null | undefined): { id: string; delivered?: string; read?: string }[] {
    const out: { id: string; delivered?: string; read?: string }[] = [];
    for (const u of (list ?? []).slice(0, 1000)) {
      if (!u.userJid || this.isMe(u.userJid)) continue;
      const id = this.cj(u.userJid), d = num(u.receiptTimestamp as never), r = num(u.readTimestamp as never) || num(u.playedTimestamp as never);
      if (!d && !r) continue;
      out.push({ id, ...(d || r ? { delivered: toIso(d || r) } : {}), ...(r ? { read: toIso(r) } : {}) });
    }
    return out;
  }

  // ------------------------------------------------------------------ read API
  async spaces(): Promise<Space[]> {
    return Object.entries(this.store.data.spaces).map(([id, name]) => ({ id, accountId: this.accountId, provider: PROVIDER, name }));
  }

  async chats(): Promise<Chat[]> {
    const d = this.store.data;
    return visibleChatIds(d).map((id) => this.toChat(d.chats[id]!));
  }

  async history(chatId: string, q: HistoryQuery): Promise<Message[]> {
    this.subscribePresence(chatId);
    const page = () => {
      const arr = this.store.data.msgs[chatId] ?? [];
      let end = arr.length;
      if (q.beforeMessageId) { end = arr.findIndex((s) => s.m.id === q.beforeMessageId); if (end < 0) return { arr, items: [] as StoredMsg[], end: 0 }; }
      return { arr, items: arr.slice(Math.max(0, end - q.limit), end), end };
    };
    // chat shows more unread than we hold: ask the phone for its newest messages once (flagged historical when they arrive)
    if (!q.beforeMessageId && this.opened) await this.backfillUnread(chatId);
    let p = page();
    if (p.items.length < q.limit && this.opened && !this.noMoreHistory.has(chatId) && Date.now() >= (this.olderCooldown.get(chatId) ?? 0) && this.anchorFor(chatId)) {
      const before = p.arr.length;
      const outcome = await this.fetchOlderOnce(chatId);
      p = page();
      // exhausted only when the phone ANSWERED with nothing new; a timeout (phone offline) just pauses requests for a minute
      if (outcome === "arrived" && p.arr.length === before) this.noMoreHistory.add(chatId);
      else if (outcome === "timeout") this.olderCooldown.set(chatId, Date.now() + 60_000);
    }
    return p.items.map((s) => s.m);
  }

  /**
   * Anchor for an on-demand history request ("messages older than this one"), best first: oldest stored message,
   * the chat's last message from the chat list, and finally a SYNTHETIC key (random id + time just after the chat's last
   * activity) for chats that never delivered any message. The synthetic case is a best-effort guess: the phone looks the
   * id up in its own database, so it may well answer with nothing (see README).
   */
  private anchorFor(chatId: string): { key: WAMessageKey; ts: number; synthetic: boolean } | undefined {
    const oldest = this.store.data.msgs[chatId]?.[0];
    if (oldest) return { key: this.keyOf(chatId, oldest), ts: oldest.ts, synthetic: false };
    const a = this.store.data.anchors[chatId];
    if (a) return { key: { remoteJid: a.rj, id: a.id, fromMe: a.fromMe, ...(a.pj ? { participant: a.pj } : {}) }, ts: a.ts, synthetic: false };
    const last = this.store.data.chats[chatId]?.lastMessageAt;
    if (last) {
      return { key: { remoteJid: chatId, id: randomBytes(16).toString("hex").toUpperCase(), fromMe: false }, ts: Date.parse(last) + 1000, synthetic: true };
    }
    return undefined;
  }

  private unreadTried = new Set<string>();
  private unreadScanTimer?: NodeJS.Timeout;
  private unreadScanned = 0;
  /** Chats with unread gaps are fetched in the background: sequential, 2s apart, at most 15 per session. */
  private scheduleUnreadScan() {
    if (this.unreadScanTimer || !this.opened) return;
    this.unreadScanTimer = setTimeout(async () => {
      this.unreadScanTimer = undefined;
      for (const id of visibleChatIds(this.store.data)) {
        if (!this.opened || this.unreadScanned >= 15) return;
        if (this.unreadTried.has(id) || !this.hasUnreadGap(id)) continue;
        this.unreadScanned++;
        await this.backfillUnread(id);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }, 5000);
    this.unreadScanTimer.unref?.();
  }

  /** True when the chat claims unread messages that are not (all) in our store. */
  private hasUnreadGap(chatId: string): boolean {
    const sc = this.store.data.chats[chatId];
    if (!sc || !sc.unread) return false;
    const arr = this.store.data.msgs[chatId] ?? [];
    const incoming = arr.filter((s) => !s.m.fromMe && !s.m.system).length;
    if (incoming < sc.unread) return true;
    const newest = arr[arr.length - 1];
    return !!(newest && sc.lastMessageAt && Date.parse(sc.lastMessageAt) - newest.ts > 2000);
  }
  /** Newest-first on-demand fetch, anchored just after the chat's last activity. Once per chat and session. */
  private backfillUnread(chatId: string, force = false) { return this.peerWork(() => this.backfillUnread0(chatId, force)); }
  private async backfillUnread0(chatId: string, force = false) {
    const sock = this.sock;
    if (!sock || !this.opened || (!force && this.unreadTried.has(chatId)) || !this.hasUnreadGap(chatId)) return;
    this.unreadTried.add(chatId);
    const sc = this.store.data.chats[chatId]!;
    const anchor = this.store.data.anchors[chatId];
    const last = sc.lastMessageAt ? Date.parse(sc.lastMessageAt) : Date.now();
    const key: WAMessageKey = anchor && anchor.ts >= last - 2000
      ? { remoteJid: anchor.rj, id: anchor.id, fromMe: anchor.fromMe, ...(anchor.pj ? { participant: anchor.pj } : {}) }
      : { remoteJid: chatId, id: randomBytes(16).toString("hex").toUpperCase(), fromMe: false };
    const held = (this.store.data.msgs[chatId] ?? []).length;
    let resend = 0;
    try {
      const sid = await sock.fetchMessageHistory(Math.min(50, (sc.unread ?? 1) + 5), key, anchor && anchor.ts >= last - 2000 ? anchor.ts + 1 : last + 1000);
      if (!this.historySeen.has(sid)) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { this.historyWaiters.delete(sid); resolve(); }, 8_000);
          this.historyWaiters.set(sid, () => { clearTimeout(t); this.historyWaiters.delete(sid); resolve(); });
        });
      }
      const fetched = (this.store.data.msgs[chatId] ?? []).length - held;
      // nothing came back: ask the phone to resend the chat's newest message by key (known from the chat list), if we don't hold it
      if (fetched <= 0 && anchor && !this.store.find(chatId, anchor.id)) {
        try {
          await sock.requestPlaceholderResend({ remoteJid: anchor.rj, id: anchor.id, fromMe: anchor.fromMe, ...(anchor.pj ? { participant: anchor.pj } : {}) });
          resend = 1;
        } catch { /* phone offline */ }
      }
      dbg(`unread gap chat unread=${sc.unread ?? 0} held=${held} fetched=${Math.max(0, fetched)} resend=${resend}`);
    } catch (e) { this.err("history-fetch", e); }
  }

  /** Concurrent history() calls for one chat share a single on-demand request. */
  private olderInflight = new Map<string, Promise<"arrived" | "timeout" | "error" | "skipped">>();
  private olderCooldown = new Map<string, number>();
  private fetchOlderOnce(chatId: string) {
    let p = this.olderInflight.get(chatId);
    if (!p) { p = this.peerWork(() => this.fetchOlder(chatId)).finally(() => this.olderInflight.delete(chatId)); this.olderInflight.set(chatId, p); }
    return p;
  }
  /** On-demand history wait (ms): the phone needs to be online and may take a while. */
  historyWaitMs = 15_000;

  /** Ask the primary phone for ~50 older messages (on-demand history sync, results arrive as messaging-history.set ON_DEMAND). */
  private async fetchOlder(chatId: string): Promise<"arrived" | "timeout" | "error" | "skipped"> {
    const sock = this.sock;
    const a = this.anchorFor(chatId);
    if (!sock || !a) return "skipped"; // nothing to anchor the request on
    try {
      const sid = await sock.fetchMessageHistory(50, a.key, a.ts);
      dbg(`on-demand history requested synthetic=${a.synthetic}`);
      if (this.historySeen.has(sid)) return "arrived";
      return await new Promise<"arrived" | "timeout">((resolve) => {
        const t = setTimeout(() => { this.historyWaiters.delete(sid); resolve("timeout"); }, a.synthetic ? Math.min(6_000, this.historyWaitMs) : this.historyWaitMs);
        this.historyWaiters.set(sid, () => { clearTimeout(t); this.historyWaiters.delete(sid); resolve("arrived"); });
      });
    } catch (e) { this.err("history-fetch", e); return "error"; }
  }

  /** Presence is only requested for DMs with recent activity or that the user opened; at most MAX_PRESENCE at a time (oldest dropped first). */
  static readonly MAX_PRESENCE = 30;
  private subscribePresence(chatId: string) {
    if (!this.sock || !this.opened || isGroupJid(chatId) || !isSupportedChat(chatId)) return;
    if (this.presenceSubscribed.has(chatId)) { this.presenceSubscribed.delete(chatId); this.presenceSubscribed.add(chatId); return; } // refresh recency
    while (this.presenceSubscribed.size >= WhatsAppConnector.MAX_PRESENCE) this.presenceSubscribed.delete(this.presenceSubscribed.values().next().value!);
    this.presenceSubscribed.add(chatId);
    this.sock.presenceSubscribe(chatId).catch(() => this.presenceSubscribed.delete(chatId));
  }
  /** After (re)connect: the newest DMs of the last 14 days. Never subscribes to everything. */
  private subscribeRecentPresence() {
    const cutoff = Date.now() - 14 * 86_400_000;
    const ids = Object.values(this.store.data.chats)
      .filter((c) => c.kind === "dm" && !c.archived && c.lastMessageAt && Date.parse(c.lastMessageAt) >= cutoff && !this.blocked.has(c.id))
      .sort((a, b) => Date.parse(a.lastMessageAt!) - Date.parse(b.lastMessageAt!)).slice(-WhatsAppConnector.MAX_PRESENCE).map((c) => c.id);
    for (const id of ids) this.subscribePresence(id);
  }

  async members(chatId: string): Promise<Contact[]> {
    const toContact = (jid: string): Contact => {
      const c: Contact = { id: jid, name: this.nameOf(jid) };
      const h = handleOf(jid); if (h) c.handle = h;
      return c;
    };
    if (!isGroupJid(chatId)) return [toContact(chatId), toContact(this.selfId())];
    let g = this.groups.get(chatId);
    if (!g && this.sock && this.opened) { g = await this.sock.groupMetadata(chatId); this.applyGroup(g); }
    if (!g) return [];
    // a person can be listed under both addressing forms (phone number and LID), and communities list entries twice: one row per person
    const seen = new Set<string>(); const out: Contact[] = [];
    for (const p of g.participants) {
      const id = this.cj(p.jid ?? p.id, p.jid);
      if (!id || seen.has(id)) continue; seen.add(id);
      const c = toContact(id);
      if (this.isMe(id) || this.isMe(p.jid) || this.isMe(p.lid) || this.isMe(p.id)) c.name = "You";
      out.push(c);
    }
    return out;
  }

  /** Media re-upload requests go to the phone one at a time (it has to find and upload each file). */
  private reuploadChain: Promise<unknown> = Promise.resolve();
  reuploadTimeoutMs = 30_000;
  /** Test hook: the CDN download (Baileys' downloadContentFromMessage by default). */
  downloader: typeof downloadContentFromMessage = downloadContentFromMessage;

  /** WhatsApp history import (core whatsappimport/): my own jids (phone number first) and the live LID -> phone-number map. Read-only. */
  importMaps() {
    const own = [this.selfPn, this.selfLid].filter((x): x is string => !!x);
    if (!own.length) return undefined;
    return { own, lidToPn: (lid: string) => this.store.data.lidToPn[normJid(lid)] };
  }

  async downloadAttachment(chatId: string, messageId: string, attachmentId: string) {
    const s = this.store.find(chatId, messageId);
    const d = s?.att?.[attachmentId];
    if (!s || !d) throw reasoned("not-cached", "attachment is not in the WhatsApp cache (message not seen by this session)");
    if (!d.mediaKey) throw reasoned("no-media-key", "WhatsApp gave no media key for this file (history placeholder); open it on the phone");
    if (!d.directPath && !d.url) throw reasoned("no-media-path", "WhatsApp gave no download path for this file; open it on the phone");
    const fetchIt = async () => {
      const stream = await this.downloader(
        { mediaKey: Buffer.from(d.mediaKey, "base64"), ...(d.directPath ? { directPath: d.directPath } : {}), ...(d.url ? { url: d.url } : {}) },
        d.type,
      );
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      return { data: new Uint8Array(Buffer.concat(chunks)), mime: d.mime, ...(d.name ? { name: d.name } : {}) };
    };
    try { return await fetchIt(); } catch (e) {
      const why = classifyMediaError(e);
      dbg(`media-dl first: why=${why} status=${statusCodeOf(e) ?? (e as { response?: { status?: number } })?.response?.status ?? "-"} type=${d.type}`);
      if (why !== "expired" && why !== "bad-media") throw reasoned(why, mediaErrText(why, e)); // a corrupt/undecryptable CDN copy: the phone may still hold the file
      // CDN copy is gone: ask the phone to upload it again (needs the phone online), then retry once with the fresh path
      const sock = this.sock;
      if (!sock || !this.opened) throw reasoned("offline", "media expired on WhatsApp's servers and the account is not connected to ask the phone for it again");
      try { await this.reuploadMedia(sock, chatId, s, d); } catch (e2) {
        const r = (e2 as { ours?: boolean }).ours ? (e2 as { reason?: string }).reason : undefined;
        dbg(`media-dl reupload failed: ${r ?? classifyReupload(e2)}`);
        if (r) throw e2;
        throw reasoned("expired", `media expired on WhatsApp's servers and the phone could not provide it again (${classifyReupload(e2)})`);
      }
      dbg("media-dl reupload ok, retrying");
      try { return await fetchIt(); } catch (e3) { const w = classifyMediaError(e3); dbg(`media-dl retry: why=${w}`); if (w === "bad-media") throw reasoned("expired", "WhatsApp no longer serves a usable copy of this file (older media is dropped from its servers) and the phone could not provide it again"); throw reasoned(w, mediaErrText(w, e3)); }
    }
  }

  /** sock.updateMediaMessage on a minimal message built from the cached descriptor; the fresh directPath/url is stored back. */
  private reuploadMedia(sock: WASocket, chatId: string, s: StoredMsg, d: AttDesc): Promise<void> {
    const run = () => this.peerWork(async () => {
      const content: Record<string, unknown> = { mediaKey: Buffer.from(d.mediaKey, "base64"), ...(d.directPath ? { directPath: d.directPath } : {}), ...(d.url ? { url: d.url } : {}) };
      const msg = { key: this.keyOf(chatId, s), message: { [`${d.type}Message`]: content } } as unknown as WAMessage;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(reasoned("phone-offline", "the phone did not answer the media re-upload request (offline or no longer has the file)")), this.reuploadTimeoutMs); timer.unref?.(); });
      try { await Promise.race([sock.updateMediaMessage(msg), timeout]); } finally { if (timer) clearTimeout(timer); }
      if (typeof content.directPath === "string" && content.directPath) d.directPath = content.directPath;
      if (typeof content.url === "string" && content.url) d.url = content.url; else delete d.url;
      this.store.touch();
    });
    const p = this.reuploadChain.then(run, run);
    this.reuploadChain = p.catch(() => undefined);
    return p;
  }

  // ------------------------------------------------------------------ avatars
  private avatarBackoffUntil = 0;

  private avatarPending = 0;
  private avatarFailUntil = new Map<string, number>(); // short in-memory memory of unreachable lookups (never persisted)
  private avatarStats = new Map<string, number>();
  /** Counts-only outcome of avatar lookups, split group / person (printed with the lib-noise summary). */
  private avatarStat(jid: string, what: string) {
    const k = `${isGroupJid(jid) ? "g" : this.store.data.spaces[jid] ? "c" : "p"}-${what}`;
    this.avatarStats.set(k, (this.avatarStats.get(k) ?? 0) + 1);
  }
  private takeAvatarStats(): string | undefined {
    if (!this.avatarStats.size) return undefined;
    const l = [...this.avatarStats].sort().map(([k, v]) => `${k}=${v}`).join(" ");
    this.avatarStats.clear();
    return l;
  }

  async avatar(target: { kind: "chat" | "space" | "contact" | "emoji"; id: string; full?: boolean }): Promise<{ data: Uint8Array; mime: string } | undefined> {
    if (!isSupportedChat(target.id)) return undefined;
    // chats, spaces and contacts all use WhatsApp jids; a LID maps to its phone number when known, so cache under that
    let jid = normJid(target.id);
    if (isLidJid(jid)) jid = this.store.data.lidToPn[jid] ?? jid;
    const full = !!target.full;
    const ck = full ? `${jid}#full` : jid; // the enlarged picture is cached separately from the small preview
    const cached = this.avatars.get(ck);
    if (cached.state === "hit" && cached.fresh) return { data: cached.data, mime: cached.mime };
    if (cached.state === "none" && cached.fresh && target.kind !== "space") return undefined; // communities are few: always re-ask
    const stale = cached.state === "hit" ? { data: cached.data, mime: cached.mime } : undefined;
    if (!this.sock || !this.opened) return stale;
    if (Date.now() < this.avatarBackoffUntil) { this.avatarStat(ck, "backoff"); return stale; }
    if ((this.avatarFailUntil.get(ck) ?? 0) > Date.now()) { this.avatarStat(ck, "failmemo"); return stale; }
    let p = this.avatarInflight.get(ck);
    if (!p) {
      // a big list (280 groups at once) must not lose its tail: waiting is cheap (2 lookups at a time, ~150ms apart => ~3 min for 600);
      // only beyond that bound answer "nothing yet" (counted as dropped, never cached as "no picture")
      if (this.avatarPending >= 600) { this.avatarStat(ck, "dropped"); return stale; }
      this.avatarPending++;
      p = this.avatarSlots(async () => {
        const r = await withTimeout<{ data: Uint8Array; mime: string } | undefined | "retry">(6000, this.fetchAvatar(jid, full), "retry");
        if (r === "retry") { this.avatarFailUntil.set(ck, Date.now() + 60_000); this.avatarStat(ck, "transient"); } // one unreachable picture must not stall the rest
        await new Promise((res) => setTimeout(res, 150)); // spread lookups to stay under WhatsApp's rate limit
        return r;
      }).then((r) => (r === "retry" ? stale : r)).finally(() => { this.avatarPending--; this.avatarInflight.delete(ck); });
      this.avatarInflight.set(ck, p);
    }
    return p;
  }

  private announceOf(communityJid: string): string | undefined {
    for (const g of this.groups.values()) if (g.isCommunityAnnounce && g.linkedParent && normJid(g.linkedParent) === communityJid) return normJid(g.id);
    return undefined;
  }

  /**
   * Community covers use a different request than other pictures (the plain one answers "not-authorized"): the w:g2 namespace, sent to the
   * community jid itself, with the picture wrapped in <pictures> and marked with parent_group_jid (same shape as whatsmeow's IsCommunity).
   */
  private async communityPictureUrl(jid: string, type: "preview" | "image"): Promise<string | undefined | "retry"> {
    const sock = this.sock; if (!sock) return "retry";
    try {
      const res: any = await (sock as any).query({
        tag: "iq", attrs: { to: jid, type: "get", xmlns: "w:g2" },
        content: [{ tag: "pictures", attrs: {}, content: [{ tag: "picture", attrs: { type, query: "url", parent_group_jid: jid } }] }],
      }, 6000);
      const pics = (res?.content as any[] | undefined)?.find((c) => c?.tag === "pictures");
      const pic = (pics?.content as any[] | undefined)?.find((c) => c?.tag === "picture");
      const url = pic?.attrs?.url as string | undefined;
      dbg(`avatar community: type=${type} answer=${url ? "url" : pic?.attrs?.status ? "status" + pic.attrs.status : pics ? "no-picture" : "no-pictures-node"}`);
      return url || undefined;
    } catch (e) {
      const f = classifyAvatarError(e);
      dbg(`avatar community: type=${type} error=${f} msg=${String((e as any)?.message ?? "").replace(/[\\d@.:]+\\w*/g, "#").slice(0, 40)}`);
      return f === "transient" || f === "ratelimit" ? "retry" : undefined;
    }
  }

  /** "retry" = transient failure (nothing cached); undefined = no picture (negative cached). */
  private async fetchAvatar(jid: string, full = false): Promise<{ data: Uint8Array; mime: string } | undefined | "retry"> {
    const ck = full ? `${jid}#full` : jid;
    const sock = this.sock;
    if (!sock) return "retry";
    const ids = [jid, ...counterparts(this.store.data, jid)];
    // a community's cover is its own picture; if that is empty/hidden fall back to its announcement group's picture
    const ann = this.store.data.spaces[jid] ? this.announceOf(jid) : undefined;
    if (ann) ids.push(ann);
    let ambiguous = false, sawTransient = false, sawHidden = false;
    if (this.store.data.spaces[jid]) {
      for (const type of (full ? ["image"] : ["image", "preview"]) as ("image" | "preview")[]) {
        const url = await this.communityPictureUrl(jid, type);
        if (url === "retry") { sawTransient = true; break; }
        if (!url) continue;
        const got = await this.downloadAvatar(url);
        if (got === "retry") { sawTransient = true; break; }
        if (got) { this.avatars.putPositive(ck, got.data, got.mime); this.avatarStat(ck, "ok"); return got; }
      }
    }
    for (const id of ids) {
      for (const type of (full ? ["image"] : ["preview", "image"]) as ("image" | "preview")[]) {
        let url: string | undefined;
        try { url = await sock.profilePictureUrl(id, type, 4000); }
        catch (e) {
          const f = classifyAvatarError(e);
          if (this.store.data.spaces[jid]) dbg(`avatar community: id=${id === jid ? "community" : id === ann ? "announce" : "other"} type=${type} error=${f} status=${(e as any)?.output?.statusCode ?? (e as any)?.data ?? "?"} msg=${String((e as any)?.message ?? "").replace(/[\d@.:]+\w*/g, "#").slice(0, 40)}`);
          if (f === "ratelimit") { this.avatarBackoffUntil = Date.now() + 30_000; this.avatarStat(jid, "ratelimit"); dbg("avatar rate limited"); return "retry"; }
          if (f === "transient") { sawTransient = true; break; } // this id is not answering (communities often time out): try the next id before giving up
          if (f === "hidden") sawHidden = true;
          if (f === "hidden" && !this.store.data.spaces[jid]) break; // privacy: the other size will not help (communities: try anyway)
          continue; // absent: try the full-size image once before concluding there is none
        }
        if (this.store.data.spaces[jid]) dbg(`avatar community: id=${id === jid ? "community" : id === ann ? "announce" : "other"} type=${type} url=${url ? "yes" : "empty"}`);
        if (!url) { ambiguous = true; continue; }
        const got = await this.downloadAvatar(url);
        if (got === "retry") return "retry";
        if (got) { this.avatars.putPositive(ck, got.data, got.mime); this.avatarStat(ck, "ok"); return got; }
      }
    }
    if (sawTransient) return "retry"; // nothing found and at least one lookup did not answer: do not cache "no picture"
    // Definitive "no picture" is cached for a day; an empty answer without an error is only cached briefly.
    const group = isGroupJid(jid);
    // groups: a picture can appear at any time and "hidden" (not-authorized) on a group usually means a membership race, not privacy: retry sooner
    const ttl = ambiguous ? 3600_000 : sawHidden && group ? 3600_000 : group ? 6 * 3600_000 : undefined;
    this.avatarStat(jid, sawHidden ? "hidden" : "absent");
    this.avatars.putNegative(ck, Date.now(), ttl);
    return undefined;
  }

  private async downloadAvatar(url: string): Promise<{ data: Uint8Array; mime: string } | undefined | "retry"> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (res.status === 404 || res.status === 410) return undefined;
      if (!res.ok) return "retry"; // 401/403 on a signed URL usually means it expired or was throttled
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > 2_000_000) return undefined;
      return { data: buf, mime: res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg" };
    } catch { return "retry"; }
  }

  // ------------------------------------------------------------------ write API
  private live(): WASocket {
    if (!this.sock || !this.opened) throw new Error("WhatsApp is not connected");
    return this.sock;
  }

  private keyOf(chatId: string, s: StoredMsg): WAMessageKey {
    const rj = s.rj ?? chatId;
    const participant = isGroupJid(chatId) ? (s.pj ?? (s.m.fromMe ? this.auth?.creds.me?.id : undefined)) : undefined;
    return { remoteJid: rj, id: s.m.id, fromMe: s.m.fromMe, ...(participant ? { participant } : {}) };
  }

  async send(chatId: string, msg: OutgoingMessage): Promise<Message> {
    const sock = this.live();
    if (!isSupportedChat(chatId)) throw new Error("unsupported chat");
    let quoted: WAMessage | undefined;
    if (msg.replyToMessageId) {
      const q = this.store.find(chatId, msg.replyToMessageId);
      if (q) quoted = { key: this.keyOf(chatId, q), message: quotedContent(q.m) };
    }
    const contents: AnyMessageContent[] = [];
    // @mentions (groups only): "@Name" spans become "@<user part>" tokens + contextInfo.mentionedJid
    let captionLeft = msg.text;
    let mentionedJids: string[] = [];
    if (msg.mentions?.length && isGroupJid(chatId)) {
      const r = rewriteMentions(msg.text, msg.mentions, (id) => this.mentionTarget(chatId, id));
      captionLeft = r.text; mentionedJids = r.jids;
      dbg(`mentions requested=${msg.mentions.length} sent=${r.jids.length} mode=${this.groups.get(chatId)?.addressingMode ?? "?"}`);
    }
    if (msg.location) {
      const l = msg.location;
      if (!Number.isFinite(l.lat) || !Number.isFinite(l.lng) || Math.abs(l.lat) > 90 || Math.abs(l.lng) > 180) throw new Error("invalid location");
      // Baileys 6.7.24 can only send a static position; a live share (live/liveUntil) is sent as the current position, not as a live location
      const name = l.name?.trim(), address = l.address?.trim();
      contents.push({ location: { degreesLatitude: l.lat, degreesLongitude: l.lng, ...(name ? { name } : {}), ...(address ? { address } : {}) } });
    }
    if (msg.contacts?.length) {
      const cards = msg.contacts.slice(0, 20).map((c) => {
        const name = c.name?.trim() || c.phones?.[0]?.trim() || c.handle?.trim();
        if (!name) throw new Error("invalid contact: a name or a phone number is required");
        return { displayName: name, vcard: buildVcard({ ...c, name }) };
      });
      contents.push({ contacts: { displayName: cards.length === 1 ? cards[0]!.displayName : `${cards.length} contacts`, contacts: cards } });
    }
    if (msg.poll) {
      const opts = [...new Set(msg.poll.options.map((o) => o.trim()).filter(Boolean))];
      if (!msg.poll.question.trim() || opts.length < 2 || opts.length > 12) throw new Error("a poll needs a question and 2-12 distinct options");
      // selectableCount 1 = single choice (-> pollCreationMessageV3); 0 = any number of options (-> pollCreationMessage).
      // The 32-byte messageSecret is generated HERE (not left to Baileys) so it is known before the send, rides in
      // messageContextInfo of the relayed message (checked after the send) and is kept for decrypting votes after a restart.
      contents.push({ poll: { name: msg.poll.question.trim(), values: opts, selectableCount: msg.poll.multiple ? 0 : 1, messageSecret: randomBytes(32) } });
    }
    for (const a of msg.attachments ?? []) {
      const data = Buffer.from(a.data);
      const cap = captionLeft ? { caption: captionLeft } : {};
      switch (a.kind) {
        case "image": contents.push({ image: data, mimetype: a.mime, ...cap }); captionLeft = ""; break;
        case "video": contents.push({ video: data, mimetype: a.mime, ...cap }); captionLeft = ""; break;
        case "audio": contents.push({ audio: data, mimetype: a.mime, ...(a.durationMs ? { seconds: Math.round(a.durationMs / 1000) } : {}) }); break;
        case "voice": contents.push({ audio: data, mimetype: /ogg/i.test(a.mime) ? "audio/ogg; codecs=opus" : a.mime, ptt: true,
          ...(a.durationMs ? { seconds: Math.max(1, Math.round(a.durationMs / 1000)) } : {}),
          ...(a.waveform?.length ? { waveform: Uint8Array.from(a.waveform.slice(0, 64).map((v) => Math.max(0, Math.min(100, Math.round(v))))) } : {}) }); break;
        case "sticker": contents.push({ sticker: data, mimetype: a.mime }); break;
        default: contents.push({ document: data, mimetype: a.mime, fileName: a.name ?? "file", ...cap }); captionLeft = "";
      }
    }
    let preview: Awaited<ReturnType<typeof buildLinkPreview>>;
    if (captionLeft || (contents.length === 0 && !msg.event)) {
      if (!captionLeft) throw new Error("empty message");
      const hasUrl = !!firstUrl(captionLeft);
      if (hasUrl && LINK_PREVIEWS_ENABLED) {
        preview = await buildLinkPreview(captionLeft, this.previewOpts);
        dbg(`link preview ${preview ? `ok thumb=${preview.jpegThumbnail ? "yes" : "no"}` : "none"}`);
      }
      // an explicit linkPreview (object or null) stops Baileys' own, unguarded URL fetch. 6.7.24's proto has no canonicalUrl field: matchedText/title/description/jpegThumbnail/previewType only.
      contents.push({ text: captionLeft, ...(!hasUrl ? {} : { linkPreview: preview ? { "canonical-url": preview.canonicalUrl, "matched-text": preview.matchedText, title: preview.title, ...(preview.description ? { description: preview.description } : {}), ...(preview.jpegThumbnail ? { jpegThumbnail: preview.jpegThumbnail } : {}) } : null }) });
    }
    // mentions ride on whatever carries the text (a caption or the text message); forwarded marks every part
    for (const c of contents) {
      const o = c as unknown as Record<string, unknown>;
      if (mentionedJids.length && ("text" in o || "caption" in o)) o.mentions = mentionedJids;
      if (msg.forwarded) o.contextInfo = { ...(o.contextInfo as object | undefined), isForwarded: true, forwardingScore: 1 };
    }
    const exp = this.ephemeralOf(chatId);
    let first: Message | undefined;
    if (msg.event) first = await this.sendEvent(chatId, msg.event);
    for (let i = 0; i < contents.length; i++) {
      const opts = { ...(i === 0 && quoted ? { quoted } : {}), ...(exp > 0 ? { ephemeralExpiration: exp } : {}) };
      const r = await sock.sendMessage(chatId, contents[i]!, Object.keys(opts).length ? opts : undefined);
      if (!r) throw new Error("send failed");
      if (r.key.id && r.message) { this.sent.set(r.key.id, r.message); if (this.sent.size > 300) this.sent.delete(this.sent.keys().next().value!); }
      r.key.fromMe = true;
      r.key.remoteJid = r.key.remoteJid ?? chatId;
      const pollOut = (contents[i] as { poll?: { messageSecret?: Uint8Array; selectableCount?: number } }).poll;
      if (pollOut) {
        // the creation message must carry its secret, otherwise other clients show "Waiting for this message" and nobody can vote
        const got = r.message?.messageContextInfo?.messageSecret;
        const pc = r.message?.pollCreationMessage ?? r.message?.pollCreationMessageV3 ?? r.message?.pollCreationMessageV2;
        dbg(`poll-create out: version=${r.message?.pollCreationMessageV3 ? "v3" : r.message?.pollCreationMessageV2 ? "v2" : r.message?.pollCreationMessage ? "v1" : "none"} selectable=${pc?.selectableOptionsCount ?? "?"} secret=${got?.length ?? 0}`);
        if (!got?.length && pollOut.messageSecret && r.message) {
          r.message.messageContextInfo = { ...(r.message.messageContextInfo ?? {}), messageSecret: pollOut.messageSecret };
          this.err("poll-secret", new Error("poll creation message carried no secret"));
        }
      }
      const m = this.ingest({ ...r, status: proto.WebMessageInfo.Status.SERVER_ACK }, false, i > 0, false);
      if (!m) throw new Error("sent message could not be mapped");
      if (m.chatId !== chatId) m.chatId = chatId;
      if (!first) first = m;
    }
    this.emit({ type: "chats-changed", data: { chatId } });
    return first!;
  }

  /** Test hook: overrides for the link-preview fetcher (resolver / thumbnailer). Never set in production. */
  previewOpts: PreviewOptions = { makeThumb: async (b) => { const { extractImageThumb } = await import("@whiskeysockets/baileys"); return (await extractImageThumb(b, 192)).buffer; } };

  /** The jid a group addresses this member by (LID groups: the LID, phone-number groups: the number). */
  private mentionTarget(chatId: string, id: string): { jid: string } | undefined {
    const g = this.groups.get(chatId);
    const j = normJid(id);
    const forms = new Set([j, ...counterparts(this.store.data, j)]);
    const p = g?.participants.find((x) => [x.id, x.jid, x.lid].some((f) => f && forms.has(normJid(f))));
    const lid = p ? [p.lid, p.id].find((f) => f && isLidJid(normJid(f))) : [...forms].find(isLidJid);
    const pn = p ? [p.jid, p.id].find((f) => f && normJid(f).endsWith("@s.whatsapp.net")) : [...forms].find((f) => f.endsWith("@s.whatsapp.net"));
    const pick = g?.addressingMode === "lid" ? (lid ?? pn) : (pn ?? lid);
    return pick ? { jid: normJid(pick) } : undefined;
  }

  async react(chatId: string, messageId: string, emoji: string | null): Promise<void> {
    const sock = this.live();
    const s = this.store.find(chatId, messageId);
    if (!s) throw new Error("message not found");
    if (s.m.deleted) throw new Error("This message was deleted for everyone, so it can't be reacted to.");
    await sock.sendMessage(chatId, { react: { text: emoji ?? "", key: this.keyOf(chatId, s) } });
    this.patch(chatId, messageId, (x) => this.setReaction(x, this.selfId(), emoji));
  }

  async pin(chatId: string, messageId: string, pinned: boolean, opts?: { durationSec?: number }): Promise<void> {
    const sock = this.live();
    const s = this.store.find(chatId, messageId);
    if (!s) throw new Error("message not found");
    if (s.m.deleted) throw new Error("This message was deleted for everyone, so it can't be pinned.");
    const dur = pinned ? (opts?.durationSec && PIN_DURATIONS.includes(opts.durationSec) ? opts.durationSec : 604800) : 0;
    await sock.sendMessage(chatId, { pin: this.keyOf(chatId, s), type: pinned ? proto.Message.PinInChatMessage.Type.PIN_FOR_ALL : proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL, time: pinned ? dur : undefined } as unknown as AnyMessageContent);
    const now = Date.now();
    if (pinned) {
      const patch: MessagePatch = { pinned: true, pinnedAt: new Date(now).toISOString(), pinnedBy: this.selfId(), pinnedUntil: new Date(now + dur * 1000).toISOString() };
      Object.assign(s.m, patch); this.store.touch(); this.emit({ type: "message-update", data: { chatId, messageId, patch } });
    } else {
      delete s.m.pinned; delete s.m.pinnedAt; delete s.m.pinnedBy; delete s.m.pinnedUntil;
      this.store.touch(); this.emit({ type: "message-update", data: { chatId, messageId, patch: { pinned: false } } });
    }
  }

  async edit(chatId: string, messageId: string, newText: string): Promise<void> {
    const sock = this.live();
    const s = this.store.find(chatId, messageId);
    if (!s || !s.m.fromMe) throw new Error("can only edit own messages");
    await sock.sendMessage(chatId, { text: newText, edit: this.keyOf(chatId, s) });
    const at = new Date().toISOString();
    this.patch(chatId, messageId, (x) => { x.m.text = newText; x.m.editedAt = at; return { text: newText, editedAt: at }; });
  }

  async delete(chatId: string, messageId: string): Promise<void> {
    const sock = this.live();
    const s = this.store.find(chatId, messageId);
    if (!s || !s.m.fromMe) throw new Error("can only delete own messages");
    await sock.sendMessage(chatId, { delete: this.keyOf(chatId, s) });
    this.patch(chatId, messageId, (x) => { x.m.deleted = true; x.m.text = ""; delete x.m.attachments; delete x.att; delete x.m.reactions; return { deleted: true, text: "", reactions: [] }; });
  }

  async setTyping(chatId: string, typing: boolean): Promise<void> {
    await this.live().sendPresenceUpdate(typing ? "composing" : "paused", chatId);
  }

  /** My own other device read up to `messageId`: everything incoming at or before it is read here too. */
  private readElsewhere(chatId: string, messageId: string) {
    const arr = this.store.data.msgs[chatId] ?? [], idx = arr.findIndex((s) => s.m.id === messageId), c = this.store.data.chats[chatId];
    if (idx < 0 || !c) return;
    const left = arr.slice(idx + 1).filter((s) => !s.m.fromMe && !s.m.system).length;
    if (c.unread === left || (c.unread ?? 0) < left) return;
    c.unread = left; this.store.touch();
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  async markRead(chatId: string, upToMessageId: string): Promise<void> {
    const sock = this.live();
    const arr = this.store.data.msgs[chatId] ?? [];
    const idx = arr.findIndex((s) => s.m.id === upToMessageId);
    const markChat = async (key: { remoteJid: string; id: string; fromMe: boolean; participant?: string }, atSec: number) => { // app-state "chat read": clears the unread mark on the phone and other devices (no receipt is sent by this)
      try { await (sock as { chatModify?: (m: unknown, jid: string) => Promise<void> }).chatModify?.({ markRead: true, lastMessages: [{ key, messageTimestamp: atSec }] }, chatId); } catch { /* best effort */ }
    };
    if (idx < 0) { // the message is not in the provider's own store (it came from a backup import / another device's history): still mark the chat read on WhatsApp
      await markChat({ remoteJid: chatId, id: upToMessageId, fromMe: false }, Math.floor(Date.now() / 1000));
      const c0 = this.store.data.chats[chatId]; if (c0 && c0.unread) { c0.unread = 0; this.store.touch(); this.emit({ type: "chats-changed", data: { chatId } }); }
      return;
    }
    const keys = arr.slice(Math.max(0, idx - 99), idx + 1).filter((s) => !s.m.fromMe).map((s) => this.keyOf(chatId, s));
    if (keys.length) await sock.readMessages(keys);
    await markChat(this.keyOf(chatId, arr[idx]!) as { remoteJid: string; id: string; fromMe: boolean; participant?: string }, Math.floor((Date.parse(arr[idx]!.m.time) || Date.now()) / 1000));
    const c = this.store.data.chats[chatId];
    if (c) {
      c.unread = arr.slice(idx + 1).filter((s) => !s.m.fromMe).length;
      this.store.touch();
      this.emit({ type: "chats-changed", data: { chatId } });
    }
  }

  async startChat(handle: string): Promise<Chat> {
    const sock = this.live();
    const jid = handleToJid(handle);
    if (!jid) throw new Error("invalid phone number");
    const res = await sock.onWhatsApp(jid);
    const hit = res?.[0];
    if (!hit || !hit.exists) throw new Error("number is not on WhatsApp");
    if (typeof hit.lid === "string") this.learn(hit.lid, hit.jid);
    const id = this.cj(hit.jid);
    const c = this.ensureChat(id);
    c.started = true; this.store.touch();
    this.emit({ type: "chats-changed", data: { chatId: id } });
    return this.toChat(c);
  }

  async createGroup(name: string, memberHandles: string[]): Promise<Chat> {
    const sock = this.live();
    const jids = memberHandles.map((h) => { const j = handleToJid(h); if (!j) throw new Error("invalid phone number"); return j; });
    const g = await sock.groupCreate(name, jids);
    this.applyGroup(g);
    const gc = this.ensureChat(normJid(g.id)); gc.started = true; this.store.touch();
    this.emit({ type: "chats-changed", data: { chatId: normJid(g.id) } });
    return this.toChat(gc);
  }

  // ------------------------------------------------------------------ own profile + privacy
  private ownJid(): string {
    const j = this.selfPn ?? this.selfLid;
    if (!j) throw new Error("Not logged in.");
    return j;
  }

  async getProfile(): Promise<Profile> {
    const sock = this.live();
    const own = this.ownJid();
    const out: Profile = {};
    const name = this.profileName ?? sock.user?.name ?? this.auth?.creds.me?.name;
    if (name) out.displayName = name;
    if (this.selfPn) out.handle = "+" + this.selfPn.slice(0, this.selfPn.indexOf("@"));
    try {
      const r = await sock.fetchStatus(own);
      const st = (r?.[0] as { status?: { status?: string | null } } | undefined)?.status?.status;
      if (typeof st === "string") out.about = st;
    } catch { /* about stays unknown */ }
    try {
      const url = await sock.profilePictureUrl(own, "image", 6000);
      if (url) { const got = await this.downloadAvatar(url); if (got && got !== "retry") out.avatar = got; }
    } catch { /* no picture / hidden */ }
    return out;
  }

  async updateProfile(patch: ProfilePatch): Promise<Profile> {
    const sock = this.live();
    const own = this.ownJid();
    // validate everything first so a bad field changes nothing
    const name = patch.displayName !== undefined ? validateName(patch.displayName) : undefined;
    const about = patch.about !== undefined ? validateAbout(patch.about) : undefined;
    if (patch.avatar) validateAvatar(patch.avatar);
    if (name !== undefined) {
      try { await sock.updateProfileName(name); this.profileName = name; } catch (e) { throw friendlyWaError(e, "Could not change the name"); }
    }
    if (about !== undefined) {
      try { await sock.updateProfileStatus(about); } catch (e) { throw friendlyWaError(e, "Could not change the about text"); }
    }
    if (patch.avatar !== undefined) {
      try {
        if (patch.avatar === null) await sock.removeProfilePicture(own);
        else await sock.updateProfilePicture(own, Buffer.from(patch.avatar.data), { width: 640, height: 640 });
      } catch (e) { throw friendlyWaError(e, "Could not change the profile picture"); }
      for (const j of [this.selfPn, this.selfLid]) if (j) this.avatars.remove(j);
    }
    return this.getProfile();
  }
  private profileName?: string;

  async getPrivacy(): Promise<PrivacySetting[]> {
    const sock = this.live();
    try { return buildPrivacy(await sock.fetchPrivacySettings(true)); }
    catch (e) { throw friendlyWaError(e, "Could not read the privacy settings"); }
  }

  async setPrivacy(id: string, value: string): Promise<PrivacySetting[]> {
    const sock = this.live();
    const def = resolvePrivacyChange(id, value);
    try {
      // the setter's parameter type is a per-setting string union; resolvePrivacyChange guarantees an allowed value
      await (sock[def.setter] as (v: string) => Promise<void>)(value);
    } catch (e) { throw friendlyWaError(e, `Could not change "${def.label}"`); }
    return this.getPrivacy();
  }

  // ------------------------------------------------------------------ events
  private eventProto(ev: StoredEvent): proto.Message.IEventMessage {
    return {
      name: ev.name, startTime: ev.start, isCanceled: !!ev.canceled, extraGuestsAllowed: !!ev.extraGuests,
      ...(ev.description ? { description: ev.description } : {}), ...(ev.end ? { endTime: ev.end } : {}),
      ...(ev.place ? { location: { name: ev.place } } : {}), ...(ev.joinLink ? { joinLink: ev.joinLink } : {}),
    };
  }

  /** Re-render a stored event into the message's text + card and tell the Hub. */
  private refreshEvent(chatId: string, s: StoredMsg) {
    if (!s.event) return;
    const d = describeOther({ eventMessage: this.eventProto(s.event) });
    if (!d || d === "skip" || !d.card) return;
    if (s.m.fromMe && s.event.secret && !s.event.canceled) d.card.editable = true;
    s.m.text = d.text; s.m.card = d.card;
    this.store.touch();
    this.emit({ type: "message-update", data: { chatId, messageId: s.m.id, patch: { text: d.text, card: d.card } } });
  }

  /** Incoming event edit (secretEncryptedMessage / EVENT_EDIT), also edits made on my own phone. */
  private handleEventEdit(w: WAMessage, sem: proto.Message.ISecretEncryptedMessage) {
    const tk = sem.targetMessageKey;
    if (!tk?.id) return;
    const chatId = this.chatIdOf(w.key);
    if (!chatId) return;
    const s = this.store.find(chatId, tk.id);
    if (!s?.event?.secret) return;
    const fromMe = !!w.key.fromMe;
    const raw = w.key.participant ?? w.key.remoteJid ?? chatId;
    const editors = fromMe ? [this.selfPn, this.selfLid] : [normJid(raw), this.cj(raw, w.key.participantPn ?? w.key.senderPn), w.key.participantPn, w.key.senderPn];
    const creators = s.m.fromMe ? [this.selfPn, this.selfLid] : [s.pj, s.rj, s.m.senderId, ...counterparts(this.store.data, s.m.senderId)];
    const clean = (a: (string | null | undefined)[]) => a.filter((x): x is string => !!x).map(normJid);
    const msg = tryDecryptEventEdit(sem, Buffer.from(s.event.secret, "base64"), tk.id, clean(creators), clean(editors));
    const em = msg?.eventMessage;
    if (!em) { dbg("event edit could not be decrypted"); return; }
    const ev = s.event;
    if (em.name != null) ev.name = em.name;
    ev.description = em.description ?? undefined;
    if (num(em.startTime)) ev.start = num(em.startTime);
    ev.end = num(em.endTime) || undefined;
    ev.place = em.location?.name ?? undefined;
    ev.canceled = !!em.isCanceled;
    if (em.joinLink) ev.joinLink = em.joinLink;
    this.refreshEvent(chatId, s);
  }

  private async sendEvent(chatId: string, e: NonNullable<OutgoingMessage["event"]>): Promise<Message> {
    const sock = this.live();
    const start = Math.floor(Date.parse(e.start) / 1000);
    const end = e.end ? Math.floor(Date.parse(e.end) / 1000) : 0;
    if (!e.name.trim() || !Number.isFinite(start)) throw new Error("An event needs a name and a start time.");
    if (end && (!Number.isFinite(end) || end < start)) throw new Error("The event's end must be after its start.");
    // recipe of Baileys 7 (eventMessage + messageSecret, stanza type "event", <meta event_type="creation"/>); 6.7.24 has no public API
    const secret = randomBytes(32);
    const message: proto.IMessage = {
      messageContextInfo: { messageSecret: secret },
      eventMessage: { name: e.name.trim(), startTime: start, isCanceled: false, extraGuestsAllowed: false, ...(e.description ? { description: e.description } : {}), ...(end ? { endTime: end } : {}), ...(e.place ? { location: { name: e.place } } : {}) },
    };
    const id = generateMessageID();
    await sock.relayMessage(chatId, message, { messageId: id, additionalAttributes: { type: "event" }, additionalNodes: [{ tag: "meta", attrs: { event_type: "creation" } }] });
    this.sent.set(id, message);
    const m = this.ingest({ key: { remoteJid: chatId, fromMe: true, id }, messageTimestamp: Math.floor(Date.now() / 1000), message, status: proto.WebMessageInfo.Status.SERVER_ACK }, false, false, false);
    if (!m) throw new Error("sent event could not be mapped");
    return m;
  }

  async editEvent(chatId: string, messageId: string, patch: { name?: string; description?: string; start?: string; end?: string; place?: string; canceled?: boolean }): Promise<void> {
    const sock = this.live();
    const s = this.store.find(chatId, messageId);
    if (!s?.event || !s.m.fromMe) throw new Error("Only events you created can be edited.");
    if (!s.event.secret) throw new Error("This event's encryption key is unknown, so it can't be edited from UniChat.");
    const next: StoredEvent = { ...s.event };
    if (patch.name !== undefined) { if (!patch.name.trim()) throw new Error("An event needs a name."); next.name = patch.name.trim(); }
    if (patch.description !== undefined) { if (patch.description) next.description = patch.description; else delete next.description; }
    if (patch.start !== undefined) { const t = Math.floor(Date.parse(patch.start) / 1000); if (!Number.isFinite(t)) throw new Error("Invalid start time."); next.start = t; }
    if (patch.end !== undefined) { if (patch.end) { const t = Math.floor(Date.parse(patch.end) / 1000); if (!Number.isFinite(t) || t < next.start) throw new Error("The event's end must be after its start."); next.end = t; } else delete next.end; }
    if (patch.place !== undefined) { if (patch.place) next.place = patch.place; else delete next.place; }
    if (patch.canceled !== undefined) next.canceled = patch.canceled;
    const lidMode = this.groups.get(chatId)?.addressingMode === "lid" || isLidJid(normJid(s.pj ?? s.rj ?? ""));
    const me = (lidMode ? this.selfLid ?? this.selfPn : this.selfPn) ?? this.selfId();
    const enc = encryptEventEdit(Buffer.from(s.event.secret, "base64"), messageId, me, me, this.eventProto(next));
    try {
      await sock.relayMessage(s.rj ?? chatId, {
        secretEncryptedMessage: { targetMessageKey: this.keyOf(chatId, s), encPayload: enc.encPayload, encIv: enc.encIv, secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.EVENT_EDIT },
      }, { messageId: generateMessageID(), additionalAttributes: { type: "event" }, additionalNodes: [{ tag: "meta", attrs: { event_type: "edit" } }] });
    } catch (e) { throw friendlyWaError(e, "Could not edit the event"); }
    s.event = next;
    this.refreshEvent(chatId, s);
  }

  // ------------------------------------------------------------------ polls
  async vote(chatId: string, messageId: string, optionIds: string[]): Promise<void> {
    const sock = this.live();
    const s = this.store.find(chatId, messageId);
    if (!s?.poll) throw new Error("not a poll");
    if (!s.poll.secret) await this.recoverPollSecret(chatId, s);
    if (!s.poll.secret) throw new Error("This poll can't be voted on from UniChat: WhatsApp did not share its encryption key. Vote on your phone instead.");
    const known = new Set(s.poll.options.map((o) => o.id));
    if (optionIds.some((o) => !known.has(o))) throw new Error("unknown poll option");
    if (!s.poll.multiple && optionIds.length > 1) throw new Error("this poll allows a single choice");
    // The key derivation uses the jid forms WhatsApp itself uses for this chat: LID in LID-addressed chats, else phone number.
    const lidMode = this.groups.get(chatId)?.addressingMode === "lid" || isLidJid(normJid(s.pj ?? s.rj ?? ""));
    // Observed live: votes cast on the phone in a DM decrypt only with the LID forms of both creator and voter, so DMs prefer LIDs too.
    const dm = !isGroupJid(chatId);
    const useLid = lidMode || (dm && !!this.selfLid);
    const me = (useLid ? this.selfLid ?? this.selfPn : this.selfPn) ?? this.selfId();
    let creator = s.m.fromMe ? me : normJid(s.pj ?? s.rj ?? chatId);
    if (useLid && !s.m.fromMe && !isLidJid(creator)) { const l = counterparts(this.store.data, creator).find(isLidJid); if (l) creator = l; }
    const enc = encryptVote(Buffer.from(s.poll.secret, "base64"), messageId, creator, me, optionIds);
    const chat = isGroupJid(chatId) ? "group" : "dm";
    // Observed live: the phone writes its own votes with the peer in LID form (remoteJid = peer LID); a PN key got no effect on the phone
    let voteRj = s.rj ?? chatId;
    if (dm && useLid && !isLidJid(normJid(voteRj))) { const l = counterparts(this.store.data, normJid(voteRj)).find(isLidJid); if (l) voteRj = l; }
    try {
      // Same shape as whatsmeow/Baileys 7: key = the poll's key as the voter sees it, stanza type "poll" (Baileys 6.7.24 would
      // label an unknown content type "text"), <meta polltype="vote"/>, selected options = sha256 BYTES of the option names.
      const voteId = generateMessageID();
      const ack = new Promise<string>((res) => { // what the server answers to this stanza: an error code here means WhatsApp rejected the vote
        const w = (sock as any).ws; if (typeof w?.once !== "function") return res("n/a");
        const t = setTimeout(() => res("timeout"), 8000); t.unref?.();
        w.once(`CB:ack,id:${voteId}`, (n: any) => { clearTimeout(t); res(n?.attrs?.error ? `error:${n.attrs.error}` : "ok"); });
      });
      { const k = this.pollKey(chatId, s, voteRj); dbg(`poll-vote key: to=${jidForm(voteRj)} remoteJid=${jidForm(k.remoteJid)} fromMe=${k.fromMe} participant=${k.participant ? jidForm(k.participant) : "none"}`); }
      await sock.relayMessage(voteRj, {
        pollUpdateMessage: { pollCreationMessageKey: this.pollKey(chatId, s, voteRj), vote: enc, senderTimestampMs: Date.now() },
      }, { messageId: voteId, additionalAttributes: { type: "poll" }, additionalNodes: [{ tag: "meta", attrs: { polltype: "vote", content_type: "add_on" } }] });
      this.sent.set(voteId, { pollUpdateMessage: { pollCreationMessageKey: this.pollKey(chatId, s, voteRj), vote: enc, senderTimestampMs: Date.now() } }); // the phone may ask for a resend (retry receipt)
      dbg(`poll-vote out: chat=${chat} creatorForm=${jidForm(creator)} voterForm=${jidForm(me)} secret=have options=${optionIds.length} relay=ok`);
      void ack.then((a) => dbg(`poll-vote ack: ${a}`));
    } catch (e) {
      dbg(`poll-vote out: chat=${chat} creatorForm=${jidForm(creator)} voterForm=${jidForm(me)} secret=have options=${optionIds.length} relay=error:${(e as Error)?.name ?? "error"}`);
      throw friendlyWaError(e, "Could not send the vote");
    }
    const cur = s.poll.votes[this.selfId()];
    if (applyVote(s.poll, this.selfId(), optionIds, Math.max(Date.now(), (cur?.t ?? 0) + 1))) this.refreshPoll(chatId, s);
  }

  /** The poll's key as a voter writes it: remoteJid = chat, fromMe = poll is mine, participant = creator only for others' polls in groups (non-AD). */
  private pollKey(chatId: string, s: StoredMsg, rj?: string): WAMessageKey {
    const participant = isGroupJid(chatId) && !s.m.fromMe && s.pj ? normJid(s.pj) : undefined;
    return { remoteJid: rj ?? s.rj ?? chatId, id: s.m.id, fromMe: s.m.fromMe, ...(participant ? { participant } : {}) };
  }

  /** Ask the phone to resend the poll's original message (it carries the secret); wait briefly for it. */
  private async recoverPollSecret(chatId: string, s: StoredMsg) {
    const sock = this.sock;
    if (!sock || !this.opened) return;
    try {
      await sock.requestPlaceholderResend(this.keyOf(chatId, s));
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { this.secretWaiters.delete(s.m.id); resolve(); }, 8000);
        this.secretWaiters.set(s.m.id, () => { clearTimeout(t); this.secretWaiters.delete(s.m.id); resolve(); });
      });
    } catch (e) { this.err("poll-secret", e); }
  }

  // ------------------------------------------------------------------ group management
  private groupOnly(chatId: string) {
    if (!isGroupJid(chatId)) throw new Error("this is a 1:1 chat; WhatsApp only supports this for groups");
  }

  async leaveSpace(spaceId: string): Promise<void> {
    const sock = this.live();
    const id = normJid(spaceId);
    if (!this.store.data.spaces[id]) throw new Error("unknown community");
    await sock.communityLeave(id);
    const d = this.store.data;
    delete d.spaces[id]; this.groups.delete(id);
    for (const c of Object.values(d.chats)) if (c.spaceId === id) { delete d.chats[c.id]; delete d.msgs[c.id]; delete d.anchors[c.id]; this.groups.delete(c.id); }
    this.store.touch();
    this.emit({ type: "spaces-changed", data: {} });
    this.emit({ type: "chats-changed", data: {} });
  }

  async leaveChat(chatId: string): Promise<void> {
    const sock = this.live();
    this.groupOnly(chatId);
    await sock.groupLeave(chatId);
    delete this.store.data.chats[chatId]; delete this.store.data.msgs[chatId]; this.groups.delete(chatId);
    this.store.touch();
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  async addMembers(chatId: string, memberHandles: string[]): Promise<void> {
    const sock = this.live();
    this.groupOnly(chatId);
    const jids = memberHandles.map((h) => { const j = handleToJid(h); if (!j) throw new Error(`"${h.replace(/[^\d+ ()-]/g, "").slice(0, 20) || "?"}" is not a valid phone number (use the international format, e.g. +49 151 1234567)`); return j; });
    const found = (await sock.onWhatsApp(...jids)) ?? [];
    const onWa = found.filter((f) => f.exists);
    const notOnWa = jids.length - onWa.length;
    const meta = this.groups.get(chatId) ?? (await sock.groupMetadata(chatId).catch(() => undefined));
    const lidGroup = meta?.addressingMode === "lid";
    // LID-addressed groups expect the member's LID when we know it; the number is the fallback (and the retry for a 400/401 answer)
    const forms = (pn: string): [string, string?] => {
      const lid = counterparts(this.store.data, normJid(pn)).find(isLidJid);
      return lidGroup && lid ? [lid, pn] : [pn, lid];
    };
    let ok = 0, invited = 0; const failed: string[] = []; const reasons = new Set<string>();
    for (const f of onWa) {
      const pn = normJid(f.jid); const [first, second] = forms(pn);
      let res = (await sock.groupParticipantsUpdate(chatId, [first], "add"))[0];
      if (res && (res.status === "400" || res.status === "401" || res.status === "500") && second) res = (await sock.groupParticipantsUpdate(chatId, [second], "add"))[0];
      const st = res?.status ?? "0";
      if (st === "200") { ok++; continue; }
      if (st === "409") { reasons.add("already in the group"); failed.push("409"); continue; }
      if (st === "403") {
        // the person only accepts invitations: WhatsApp hands out an invite code; send it to them in a private message, like the app does
        const node = (res?.content as { content?: unknown } | undefined)?.content;
        const req = Array.isArray(node) ? (node as { tag?: string; attrs?: Record<string, string> }[]).find((c) => c?.tag === "add_request") : undefined;
        if (req?.attrs?.code) {
          try {
            await sock.sendMessage(pn, { groupInvite: { jid: chatId, subject: meta?.subject ?? "", inviteCode: req.attrs.code, inviteExpiration: Number(req.attrs.expiration) || 0, text: "" } });
            invited++; continue;
          } catch (e) { this.err("group-invite-failed", e); }
        }
        reasons.add("their privacy settings only allow invitations"); failed.push("403"); continue;
      }
      reasons.add(st === "408" ? "left the group recently, they must rejoin themselves" : st === "401" ? "the group is full or you are not allowed to add people" : `WhatsApp refused (status ${st})`);
      failed.push(st);
    }
    dbg(`group add: requested=${jids.length} onWhatsApp=${onWa.length} added=${ok} invited=${invited} failed=${failed.length} mode=${lidGroup ? "lid" : "pn"}`);
    this.emit({ type: "chats-changed", data: { chatId } });
    void this.refreshGroup(chatId);
    if (invited) this.emit({ type: "error", data: { id: this.accountId, code: "group-invited", message: `${invited === 1 ? "One person only accepts" : `${invited} people only accept`} invitations: UniChat sent ${invited === 1 ? "them" : "them each"} the group invite link in a private message.` } });
    if (notOnWa || failed.length) {
      const parts: string[] = [];
      if (notOnWa) parts.push(`${notOnWa} not on WhatsApp`);
      if (failed.length) parts.push(`${failed.length} could not be added (${[...reasons].join("; ")})`);
      throw new Error(`Added ${ok}${invited ? `, invited ${invited}` : ""} of ${jids.length}: ${parts.join(", ")}`);
    }
  }

  async removeMember(chatId: string, memberId: string): Promise<void> {
    const sock = this.live();
    this.groupOnly(chatId);
    const g = this.groups.get(chatId) ?? (await sock.groupMetadata(chatId));
    // use the participant id exactly as the group addresses it (may be a LID)
    const p = g.participants.find((x) => this.cj(x.jid ?? x.id, x.jid) === memberId || normJid(x.id) === memberId);
    const sum = summarizeParticipantResults(await sock.groupParticipantsUpdate(chatId, [p?.id ?? memberId], "remove"));
    void this.refreshGroup(chatId);
    if (sum.failed) throw new Error(`could not remove member (${sum.reasons.join("; ")})`);
  }

  private async refreshGroup(chatId: string) {
    try { this.applyGroup(await this.live().groupMetadata(chatId)); this.emit({ type: "chats-changed", data: { chatId } }); } catch { /* best effort */ }
  }

  async setChatDescription(chatId: string, text: string): Promise<void> {
    const sock = this.live();
    this.groupOnly(chatId);
    const t = text.trim();
    try { await sock.groupUpdateDescription(chatId, t || undefined); }
    catch (e) { throw friendlyWaError(e, "Could not change the group description (only admins can, unless the group lets everyone)"); }
    const c = this.store.data.chats[chatId];
    if (c) { c.description = t || undefined; this.store.touch(); }
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  async setChatPicture(chatId: string, image: { data: Uint8Array; mime: string } | null): Promise<void> {
    const sock = this.live();
    this.groupOnly(chatId);
    try {
      if (image) await sock.updateProfilePicture(chatId, Buffer.from(image.data), { width: 640, height: 640 });
      else await sock.removeProfilePicture(chatId);
    } catch (e) { throw friendlyWaError(e, image ? "Could not change the group picture (only admins can, unless the group lets everyone)" : "Could not remove the group picture"); }
    this.avatars.remove(normJid(chatId));
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  async renameChat(chatId: string, name: string): Promise<void> {
    const sock = this.live();
    this.groupOnly(chatId);
    if (!name.trim()) throw new Error("name must not be empty");
    await sock.groupUpdateSubject(chatId, name);
    const c = this.store.data.chats[chatId];
    if (c) { c.name = name; this.store.touch(); }
    const g = this.groups.get(chatId); if (g) g.subject = name;
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  /** Disappearing-messages timer of a chat (0 = off). Groups use the group setting, 1:1 chats the chat setting; WhatsApp offers 24 h / 7 d / 90 d. */
  async setDisappearing(chatId: string, seconds: number): Promise<void> {
    const sock = this.live();
    if (![0, 86400, 604800, 7776000].includes(seconds)) throw new Error("WhatsApp only offers off, 24 hours, 7 days or 90 days");
    if (isGroupJid(chatId)) {
      try { await sock.groupToggleEphemeral(chatId, seconds); }
      catch (e) { throw friendlyWaError(e, "Could not change the disappearing-messages timer (only admins can, unless the group lets everyone)"); }
    } else await sock.sendMessage(chatId, { disappearingMessagesInChat: seconds === 0 ? false : seconds });
    this.setEphemeral(chatId, seconds, Date.now());
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  async blockChat(chatId: string, blocked: boolean): Promise<void> {
    const sock = this.live();
    if (isGroupJid(chatId)) throw new Error("only 1:1 chats can be blocked");
    await sock.updateBlockStatus(chatId, blocked ? "block" : "unblock");
    if (blocked) this.blocked.add(chatId); else this.blocked.delete(chatId);
    this.emit({ type: "chats-changed", data: { chatId } });
  }

  // ------------------------------------------------------------------ communities
  private async learnCommunities(sock: WASocket, known: GroupMetadata) {
    this.store.data.spaces[normJid(known.id)] = known.subject; delete this.store.data.chats[normJid(known.id)];
    this.groups.set(normJid(known.id), known);
    try { for (const g of Object.values(await sock.communityFetchAllParticipating())) this.applyGroup(g); } catch { /* sub-groups arrive later via events */ }
    try { for (const g of Object.values(await sock.groupFetchAllParticipating())) this.applyGroup(g); } catch { /* ditto */ }
    this.store.touch();
    this.emit({ type: "spaces-changed", data: {} });
    this.emit({ type: "chats-changed", data: {} });
  }
  private spaceOf(g: GroupMetadata): Space {
    return { id: normJid(g.id), accountId: this.accountId, provider: PROVIDER, name: this.store.data.spaces[normJid(g.id)] ?? g.subject };
  }

  async createSpace(name: string, description?: string): Promise<Space> {
    const sock = this.live();
    if (!name.trim()) throw new Error("name must not be empty");
    const created = await sock.communityCreate(name, description ?? "");
    if (!created) throw new Error("community could not be created");
    let meta = created;
    try { meta = await sock.communityMetadata(created.id); } catch { /* use the creation result */ }
    await this.learnCommunities(sock, { ...meta, subject: meta.subject || name });
    return this.spaceOf({ ...meta, subject: meta.subject || name });
  }

  async joinSpace(invite: string): Promise<Space> {
    const sock = this.live();
    const code = parseInviteCode(invite);
    if (!code) throw new Error("not a valid WhatsApp invite link or code");
    let info: GroupMetadata | undefined;
    try { info = await sock.communityGetInviteInfo(code); } catch { /* maybe a plain group invite */ }
    if (!info?.isCommunity) {
      let isGroup = false;
      try { await sock.groupGetInviteInfo(code); isGroup = true; } catch { /* neither */ }
      throw new Error(isGroup ? "this invite is a group, not a community" : "invite is invalid, expired or revoked");
    }
    const jid = await sock.communityAcceptInvite(code);
    if (!jid) throw new Error("join request sent; waiting for an admin to approve it");
    let meta: GroupMetadata = { ...info, id: jid };
    try { meta = await sock.communityMetadata(jid); } catch { /* keep invite info */ }
    await this.learnCommunities(sock, meta);
    return this.spaceOf(meta);
  }
}

const factory: ProviderFactory = {
  name: PROVIDER,
  displayName: "WhatsApp",
  login: "qr",
  capabilities: CAPS,
  create: ({ accountId, dataDir }) => new WhatsAppConnector(accountId, dataDir),
};
export default factory;
