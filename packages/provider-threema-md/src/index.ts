// Threema "linked device" provider (multi-device protocol): UniChat becomes an additional device of the user's PERSONAL Threema ID.
// UNOFFICIAL. See README.md (risks, gaps, live test plan) and Threema-protocol-notes (https://github.com/PixelcrafterEXE/unichat/wiki/Threema-protocol-notes) (protocol facts and their sources).
import { randomBytes } from "node:crypto";
import type { AccountState, Attachment, Capabilities, Chat, Connector, Contact, CoreEvent, HistoryQuery, LoginPrompt, Message, OutgoingMessage, PrivacySetting, Profile, ProfilePatch, ProviderFactory } from "@unimsg/core";
import { APP_VERSION, DEVICE_LABEL, JOIN_TTL_MS, MAX_RETRIES, RETRY_BASE_MS, cspServerKeys, dbg, mediatorBase } from "./config.js";
import { CspSession, P, messageAck, openIncoming, parseWire, sealOutgoing, u64le } from "./csp.js";
import { Ty, FEATURE, deleteBody, deliveryBody, editBody, fileBody, groupChatId, hexId, idFromHex, locationBody, parseGroupChatId, parseInner, pollSetupBody, pollVoteBody, quoteText, randomId, reactionBody, split, textBody, typingBody, wrapGroup, QUOTE_RE, type GroupRef, type Parsed } from "./e2e.js";
import { joinAsNewDevice, registeredFrame } from "./join.js";
import { cat, deriveDeviceGroupKeys, type DeviceGroupKeys } from "./keys.js";
import { Mediator, MediatorClose, noAutoReconnect, type Reflected } from "./mediator.js";
import { publicKeyOf, secretbox, secretboxOpen } from "./nacl.js";
import { HttpError, Net } from "./net.js";
import type { Msg } from "./proto.js";
import { Enum } from "./schemas.js";
import { NonceStore, bound, emptyState, loadSession, loadState, saveSession, saveState, wipeAll, type ContactRec, type GroupRec, type MediaRef, type Session, type State } from "./store.js";

export const CAPABILITIES: Capabilities = {
  spaces: false, reactions: true, edits: true, deletes: true, replies: true, attachments: true, typing: true, readReceipts: true, receiptDetails: false, markRead: true,
  startChat: true, createGroup: true, backfill: false, e2ee: true, location: true, contactCards: false, voiceNotes: false, leaveChat: true, manageMembers: true,
  chatDescription: false, chatPicture: false, renameChat: true, block: true, profile: { displayName: true }, privacy: true, refreshChat: false, polls: true, pollVote: true,
  avatars: true, mentions: true, requests: false, sync: false, events: false,
};

const WARNING =
  "Unofficial, experimental client: UniChat links to your Threema ID as an extra device. Threema's terms don't allow third-party clients, and a bug could disturb your device group. Try a spare ID first and make a Threema Safe backup.";
export const isConsent = (v: string | undefined) => /^(true|yes|on|1)$/i.test((v ?? "").trim());
const ID_RE = /^[0-9A-Z*][0-9A-Z]{7}$/;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex"), unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const nonce1 = (n: number) => { const b = new Uint8Array(24); b[23] = n; return b; };
const iso = (ms: number | bigint) => new Date(Number(ms)).toISOString();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const contactName = (c?: ContactRec, id?: string) => (c && ([c.first, c.last].filter(Boolean).join(" ") || c.nick)) || id || "";
const mimeSniff = (b: Uint8Array) => (b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b[0] === 0x89 && b[1] === 0x50 ? "image/png" : b[8] === 0x57 && b[9] === 0x45 ? "image/webp" : "image/jpeg");
const IMG = /^image\/(jpeg|png|gif|webp)$/;
const RECEIPT_TYPES = new Set<number>([Ty.TEXT, Ty.FILE, Ty.LOCATION, Ty.IMAGE, Ty.POLL_SETUP]);

type Step = { kind: "consent" } | { kind: "qr" } | { kind: "emoji" } | { kind: "none" };

class ThreemaMdConnector implements Connector {
  get capabilities() { return CAPABILITIES; }
  private emit: (e: CoreEvent) => void = () => {};
  private session?: Session; private keys?: DeviceGroupKeys; private me = ""; private ck = new Uint8Array(0);
  private st: State = emptyState();
  private nonces!: NonceStore;
  private med?: Mediator; private csp?: CspSession; private net?: Net;
  private stopped = false; private runId = 0; private promptN = 0; private step: Step = { kind: "none" };
  private joinAbort?: AbortController; private ttlTimer?: NodeJS.Timeout; private stateTimer?: NodeJS.Timeout;
  private dry = false; private leader = false; private unblocked = false; private connectedAt = 0; private fsWarned = false;
  private queue: Promise<void> = Promise.resolve();
  private outAcks = new Map<string, () => void>();
  private seen = new Set<string>(); private typingTimers = new Map<string, NodeJS.Timeout>();
  private unread = new Map<string, bigint[]>(); private quoteOf = new Map<string, string>();
  private keepalive?: NodeJS.Timeout; private retry = 0; private dirLookups = new Map<string, Promise<void>>();

  private accountId: string; private dir: string;
  constructor(accountId: string, dir: string) { this.accountId = accountId; this.dir = dir; }

  // ---------------------------------------------------------------- lifecycle
  async start(emit: (e: CoreEvent) => void): Promise<void> {
    this.emit = emit; this.stopped = false; this.nonces = new NonceStore(this.dir);
    const s = loadSession(this.dir);
    if (!s) { this.setState("needs-login"); this.prompt(); return; }
    if (!s.registered) { this.wipe(); this.setState("needs-login", "A previous linking attempt did not finish. If \"UniChat\" is listed under Linked Devices on your phone, remove it there, then link again."); this.prompt(); return; }
    this.useSession(s); this.setState("connecting"); void this.loop(++this.runId);
  }
  async stop(): Promise<void> {
    this.stopped = true; this.runId++; this.disconnect(); this.joinAbort?.abort(); clearTimeout(this.ttlTimer);
    this.flushState(); this.nonces?.flush(); for (const t of this.typingTimers.values()) clearTimeout(t); this.typingTimers.clear();
  }
  async logout(): Promise<void> {
    const had = !!this.session && this.session.registered, session = this.session, keys = this.keys;
    this.stopped = true; this.runId++;
    const med = this.med; this.med = undefined; this.csp = undefined; clearInterval(this.keepalive);
    this.joinAbort?.abort(); clearTimeout(this.ttlTimer);
    this.wipe(); this.session = undefined; this.keys = undefined; this.st = emptyState(); this.setState("signed-out");
    if (!had || !session || !keys) { med?.close(); return; }
    let ok = false;
    try {
      let m = med && !med.isClosed ? med : undefined;
      if (!m) { m = new Mediator({ url: mediatorBase(keys.dgpkPublic), serverGroup: session.serverGroup, keys, deviceId: BigInt(session.deviceId), label: DEVICE_LABEL, platformDetails: "UniChat", appVersion: APP_VERSION, expectedSlot: Enum.slotState.EXISTING }); await m.connect(); }
      ok = await m.dropSelf(); m.close();
    } catch { /* reported below */ }
    if (!ok) throw new Error("You were signed out in UniChat, but Threema did not confirm that this device was removed. Open Threema on your phone > Settings > Linked Devices and remove \"UniChat\" there.");
  }
  private useSession(s: Session) {
    this.session = s; this.me = s.identity; this.ck = unhex(s.ck); this.keys = deriveDeviceGroupKeys(unhex(s.dgk));
    this.st = loadState(this.dir); this.net = new Net(this.keys.dgpkPublic, BigInt(s.deviceId));
  }
  private wipe() { try { wipeAll(this.dir); } catch { /* ignore */ } }
  private setState(state: AccountState, detail?: string) { this.emit({ type: "account", data: { id: this.accountId, state, ...(detail ? { detail } : {}) } }); }
  private err(code: string, message: string, fatal = false) { this.emit({ type: "error", data: { id: this.accountId, code, message, fatal } }); }
  private markDirty() { this.stateTimer ??= setTimeout(() => { this.stateTimer = undefined; this.flushState(); }, 1500); }
  private flushState() { if (this.stateTimer) { clearTimeout(this.stateTimer); this.stateTimer = undefined; } if (this.session) { try { bound(this.st.media, 3000); bound(this.st.recent, 20000); bound(this.st.reactions, 3000); bound(this.st.polls, 500); saveState(this.dir, this.st); } catch { /* ignore */ } } }
  private disconnect() {
    clearInterval(this.keepalive); const m = this.med; this.med = undefined; this.csp = undefined; this.dry = false; this.leader = false; this.unblocked = false;
    for (const f of this.outAcks.values()) f(); this.outAcks.clear(); m?.close();
  }

  // ---------------------------------------------------------------- login (linking) UX
  private prompt(error?: string) {
    const id = `${this.step.kind}-${++this.promptN}`;
    if (this.step.kind === "qr") return; // emitted by the join flow
    this.step = { kind: "consent" };
    const p: LoginPrompt = { accountId: this.accountId, promptId: id, kind: "form", title: "Link UniChat to your Threema account (as an additional device)", ...(error ? { error } : {}), warning: { severity: "danger", text: WARNING },
      fields: [{ name: "confirm", label: "I understand this is unofficial, may violate Threema's terms, uses one of my device slots and shares my Threema ID's key with this computer", type: "checkbox", required: true,
        help: [{ title: "How does linking work?", steps: ["Click Continue: UniChat shows a QR code.", "On your phone open Threema > Settings > Linked Devices (Desktop/Web) > Link Device and scan the QR code.", "Your phone shows three emoji. They must be identical to the three emoji shown here. Confirm on the phone only if they match.", "To remove UniChat later: Threema > Settings > Linked Devices > UniChat > Remove."] }] }] };
    this.emit({ type: "login", data: p });
  }
  async submitLogin(_promptId: string, v: Record<string, string>): Promise<void> {
    if (this.step.kind !== "consent") return;
    if (!isConsent(v.confirm)) throw new Error("Please tick the box to confirm that you understand the risks.");
    this.step = { kind: "none" }; void this.runJoin();
  }
  private async runJoin() {
    this.joinAbort?.abort(); const ac = this.joinAbort = new AbortController(); const rid = ++this.runId;
    this.setState("connecting", "Waiting for your phone");
    try {
      const out = await joinAsNewDevice({
        ttlMs: JOIN_TTL_MS(), signal: ac.signal,
        onQr: (url) => { this.step = { kind: "qr" }; this.emit({ type: "login", data: { accountId: this.accountId, promptId: `qr-${++this.promptN}`, kind: "qr", payload: url, hint: "Threema on your phone > Settings > Linked Devices > Link Device, then scan this code." } }); },
        onEmoji: (em) => { this.step = { kind: "emoji" }; this.emit({ type: "login", data: { accountId: this.accountId, promptId: `emoji-${++this.promptN}`, kind: "form", title: `Your phone must show exactly these three emoji: ${em.join(" ")}. Confirm on the phone only if they are identical. Do not continue if they differ.`, fields: [] } }); },
      });
      if (rid !== this.runId || this.stopped) { out.channel.close(); return; }
      await this.finishJoin(out);
    } catch (e) {
      if (ac.signal.aborted || this.stopped) return;
      dbg("join failed: " + (e instanceof Error ? e.message : "error"));
      this.step = { kind: "none" }; this.setState("needs-login", "Linking did not complete."); this.prompt("Linking did not complete. Check that your phone and this computer are online, then try again.");
    }
  }
  private async finishJoin(out: Awaited<ReturnType<typeof joinAsNewDevice>>) {
    const ed = out.essential, idd = ed.identityData, dgk = ed.deviceGroupData?.dgk;
    if (!idd || !ID_RE.test(idd.identity ?? "") || idd.ck?.length !== 32 || dgk?.length !== 32 || idd.cspDeviceCookie?.length !== 16 || !/^[0-9a-zA-Z]+$/.test(idd.cspServerGroup ?? "")) throw new Error("incomplete essential data");
    const session: Session = { identity: idd.identity, ck: hex(idd.ck), dgk: hex(dgk), serverGroup: idd.cspServerGroup, deviceId: randomId().toString(), cspDeviceId: randomId().toString(), cspCookie: hex(idd.cspDeviceCookie), registered: false, linkedAt: new Date().toISOString() };
    saveSession(this.dir, session); this.useSession(session);
    this.importEssential(ed, out.blobs);
    this.nonces.importHashed([...(ed.cspHashedNonces ?? []), ...(ed.d2dHashedNonces ?? [])]);
    this.flushState(); this.nonces.flush();
    const med = this.newMediator(Enum.slotState.NEW);
    let info;
    try { info = await med.connect(); } catch (e) { out.channel.close(4100); this.wipe(); throw e; }
    if (info.deviceSlotState !== Enum.slotState.NEW) { med.close(); out.channel.close(4100); this.wipe(); throw new Error("unexpected device slot state"); }
    out.channel.send(registeredFrame());
    session.registered = true; saveSession(this.dir, session);
    setTimeout(() => out.channel.close(1000), 500);
    dbg(`linked: ${Object.keys(this.st.contacts).length} contacts, ${Object.keys(this.st.groups).length} groups imported`);
    this.step = { kind: "none" };
    const rid = ++this.runId; this.attach(med, info, rid); this.setState("connecting", "Logging in"); void this.loop(rid, med);
  }
  private importEssential(ed: Msg, blobs: Map<string, Uint8Array>) {
    const up = ed.userProfile; if (up?.nickname !== undefined) this.st.nickname = up.nickname;
    const se = ed.settings; if (se) this.applySettings(se);
    const pic = (key: string, di?: Msg) => { const b = di?.updated?.blob; if (!b?.id) return; const id = hex(b.id), data = blobs.get(id); if (!b.key) return;
      if (data) { const p = secretboxOpen(data, b.nonce?.length === 24 ? b.nonce : nonce1(1), b.key); if (p) { this.st.avatars[key] = Buffer.from(p).toString("base64"); return; } }
      this.st.avatarRefs[key] = { blobId: id, key: hex(b.key), ...(b.nonce?.length === 24 ? { nonce: hex(b.nonce) } : {}) }; };
    pic("own", up?.profilePicture);
    for (const c of ed.contacts ?? []) { this.upsertContact(c.contact, c.lastUpdateAt); if (c.contact?.identity) pic(c.contact.identity, c.contact.contactDefinedProfilePicture); }
    for (const g of ed.groups ?? []) { const k = this.upsertGroup(g.group, g.lastUpdateAt); if (k) pic("g:" + k, g.group?.profilePicture); }
  }
  private applySettings(s: Msg) {
    if (s.blockedIdentities) this.st.blocked = s.blockedIdentities.identities ?? [];
    if (s.readReceiptPolicy !== undefined) this.st.readReceipts = s.readReceiptPolicy === 0;
    if (s.typingIndicatorPolicy !== undefined) this.st.typing = s.typingIndicatorPolicy === 0;
  }
  private upsertContact(c?: Msg, lastAt?: bigint): ContactRec | undefined {
    if (!c?.identity || !ID_RE.test(c.identity)) return undefined;
    const o = this.st.contacts[c.identity] ?? { identity: c.identity, acq: 0, feature: "0" };
    if (c.publicKey?.length === 32) o.pk = hex(c.publicKey);
    if (c.firstName !== undefined) o.first = c.firstName; if (c.lastName !== undefined) o.last = c.lastName; if (c.nickname !== undefined) o.nick = c.nickname;
    if (c.acquaintanceLevel !== undefined) o.acq = c.acquaintanceLevel; if (c.featureMask !== undefined) o.feature = c.featureMask.toString();
    if (c.conversationVisibility !== undefined) o.vis = c.conversationVisibility;
    if (lastAt !== undefined) o.lastAt = Number(lastAt);
    this.st.contacts[c.identity] = o; this.markDirty(); return o;
  }
  private upsertGroup(g?: Msg, lastAt?: bigint): string | undefined {
    const gi = g?.groupIdentity; if (!gi?.creatorIdentity) return undefined;
    const ref: GroupRef = { creator: gi.creatorIdentity, id: gi.groupId }; const key = groupChatId(ref);
    const o = this.st.groups[key] ?? { creator: ref.creator, id: hexId(ref.id), members: [], state: 0 };
    if (g!.name !== undefined) o.name = g!.name; if (g!.userState !== undefined) o.state = g!.userState;
    if (g!.memberIdentities) o.members = g!.memberIdentities.identities ?? [];
    if (g!.createdAt !== undefined) o.createdAt = Number(g!.createdAt); if (lastAt !== undefined) o.lastAt = Number(lastAt);
    this.st.groups[key] = o; this.markDirty(); return key;
  }

  // ---------------------------------------------------------------- connection loop
  private newMediator(expectedSlot: number): Mediator {
    const s = this.session!;
    return new Mediator({ url: mediatorBase(this.keys!.dgpkPublic), serverGroup: s.serverGroup, keys: this.keys!, deviceId: BigInt(s.deviceId), label: DEVICE_LABEL, platformDetails: `UniChat (${process.platform})`, appVersion: APP_VERSION, expectedSlot });
  }
  private async loop(id: number, existing?: Mediator) {
    let med = existing;
    while (!this.stopped && id === this.runId) {
      let closeCode = 1006;
      try {
        if (!med) {
          med = this.newMediator(Enum.slotState.EXISTING); const info = await med.connect();
          if (id !== this.runId) { med.close(); return; }
          if (info.deviceSlotState !== Enum.slotState.EXISTING) { med.close(); return this.revoked(); }
          this.retry = 0; this.attach(med, info, id);
        }
        const m = med; closeCode = m.closedWith ?? await new Promise<number>((ok) => m.once("close", ok));
        if (Date.now() - this.connectedAt > 30_000) this.retry = 0;
      } catch (e) { if (e instanceof MediatorClose) closeCode = e.code; dbg("connection attempt failed"); }
      med = undefined; this.disconnect();
      if (this.stopped || id !== this.runId) return;
      if (closeCode === 4113 || closeCode === 4115) return this.revoked();
      if (noAutoReconnect(closeCode)) { this.setState("disconnected", closeCode === 4111 ? "Threema has no free device slot for UniChat." : closeCode === 4112 ? "Another connection of this device is active." : "The multi-device server asked UniChat not to reconnect automatically."); return; }
      if (++this.retry > MAX_RETRIES()) { this.setState("disconnected", "Could not reach Threema. Restart UniChat to try again."); return; }
      this.setState("connecting", "Reconnecting"); await sleep(Math.min(60_000, RETRY_BASE_MS() * this.retry));
    }
  }
  private revoked() {
    this.disconnect(); this.wipe(); this.session = undefined; this.keys = undefined; this.st = emptyState(); this.step = { kind: "none" };
    this.setState("needs-login", "UniChat was removed from your Threema linked devices."); this.prompt("UniChat was removed from your Threema linked devices (or the link expired). Link it again to continue.");
  }
  private attach(med: Mediator, info: { maxDeviceSlots: number; sharedVersion?: number; currentTime: bigint }, id: number) {
    this.med = med; this.dry = false; this.leader = false; this.unblocked = false; this.connectedAt = Date.now();
    if (info.sharedVersion !== undefined && info.sharedVersion > Enum.d2dVersion) { this.err("protocol-too-new", "Your phone uses a newer Threema multi-device version than UniChat supports. UniChat stays disconnected to avoid damaging your device group.", true); this.stopped = true; this.setState("disconnected", "Protocol version not supported"); med.close(); return; }
    if (info.currentTime && Math.abs(Number(info.currentTime) - Date.now()) > 20 * 60_000) this.err("clock-skew", "This computer's clock differs from Threema's server by more than 20 minutes. Please correct it.");
    const csp = this.csp = new CspSession({ identity: this.me, ck: this.ck, serverKeys: cspServerKeys(), deviceId: BigInt(this.session!.cspDeviceId), deviceCookie: unhex(this.session!.cspCookie),
      clientInfo: `${APP_VERSION};Q;en/US;UniChat;1;${process.platform};x64`, send: (b) => { try { med.sendProxy(b); } catch { /* closed */ } } });
    csp.on("ready", () => { dbg("chat server login ok"); this.maybeUnblock(); this.setState("connected"); this.emit({ type: "chats-changed", data: {} }); });
    csp.on("fail", () => { dbg("chat server session failed"); med.close(4000); });
    csp.on("payload", (t: number, d: Uint8Array) => this.onCspPayload(t, d));
    med.on("proxy", (b: Uint8Array) => csp.feed(b));
    med.on("reflected", (r: Reflected) => { this.queue = this.queue.then(async () => { try { await this.onReflected(r); } catch (e) { this.err("handler", e instanceof Error && e.message.length < 80 ? "Could not process a message from your other devices." : "Could not process a message from your other devices."); } if (!(r.flags & 1) && !med.isClosed) { try { med.ackReflected(r.id); } catch { /* closed */ } } }); });
    med.on("dry", () => { this.dry = true; dbg("reflection queue dry"); this.maybeUnblock(); });
    med.on("leader", () => { this.leader = true; dbg("promoted to leader"); this.maybeUnblock(); });
    csp.start(); med.flow();
    clearInterval(this.keepalive); this.keepalive = setInterval(() => { try { if (csp.ready) csp.sendPayload(P.ECHO_REQ, new Uint8Array(8)); med.ping(); } catch { /* closing */ } }, 100_000);
    void id;
  }
  private maybeUnblock() {
    if (this.csp?.ready && this.dry && this.leader && !this.unblocked) { this.unblocked = true; this.csp.sendPayload(P.UNBLOCK, new Uint8Array(0)); dbg("incoming messages unblocked (this device leads)"); }
  }

  // ---------------------------------------------------------------- reflected messages (other devices)
  private async onReflected(r: Reflected) {
    const e = r.envelope, hist = !this.dry;
    if (e.incomingMessage) {
      const m = e.incomingMessage; if (m.nonce?.length === 24) { if (this.nonces.has(m.nonce, this.me)) return; this.nonces.add(m.nonce); }
      await this.ingest({ sender: m.senderIdentity, id: m.messageId, at: Number(m.createdAt), type: m.type, body: m.body ?? new Uint8Array(0), fromMe: false, hist, direct: false });
    } else if (e.outgoingMessage) {
      const m = e.outgoingMessage; for (const n of m.nonces ?? []) if (n.length === 24) this.nonces.add(n);
      const cv = m.conversation; const contact = cv?.contact as string | undefined;
      await this.ingest({ sender: this.me, contact, id: m.messageId, at: Number(m.createdAt), type: m.type, body: m.body ?? new Uint8Array(0), fromMe: true, hist, direct: false });
    } else if (e.contactSync) {
      const c = (e.contactSync.create ?? e.contactSync.update)?.contact; const rec = this.upsertContact(c);
      if (rec && c?.contactDefinedProfilePicture?.updated?.blob?.key) { const b = c.contactDefinedProfilePicture.updated.blob; this.st.avatarRefs[rec.identity] = { blobId: hex(b.id), key: hex(b.key), ...(b.nonce?.length === 24 ? { nonce: hex(b.nonce) } : {}) }; delete this.st.avatars[rec.identity]; }
      this.emit({ type: "chats-changed", data: {} });
    } else if (e.groupSync) {
      const gs = e.groupSync;
      if (gs.delete?.groupIdentity) { delete this.st.groups[groupChatId({ creator: gs.delete.groupIdentity.creatorIdentity, id: gs.delete.groupIdentity.groupId })]; this.markDirty(); }
      else { const k = this.upsertGroup((gs.create ?? gs.update)?.group); const b = (gs.create ?? gs.update)?.group?.profilePicture?.updated?.blob; if (k && b?.key) { this.st.avatarRefs["g:" + k] = { blobId: hex(b.id), key: hex(b.key), ...(b.nonce?.length === 24 ? { nonce: hex(b.nonce) } : {}) }; delete this.st.avatars["g:" + k]; } }
      this.emit({ type: "chats-changed", data: {} });
    } else if (e.userProfileSync?.update?.userProfile) {
      const up = e.userProfileSync.update.userProfile; if (up.nickname !== undefined) { this.st.nickname = up.nickname; this.markDirty(); }
    } else if (e.settingsSync?.update?.settings) { this.applySettings(e.settingsSync.update.settings); this.markDirty(); this.emit({ type: "chats-changed", data: {} }); }
    // outgoing/incoming message updates (sent / read) need no UniChat state
  }

  // ---------------------------------------------------------------- shared message ingestion (reflected or direct from the chat server)
  private nameOf(id: string) { return id === this.me ? (this.st.nickname || "Me") : contactName(this.st.contacts[id], id); }
  currentNameOf(id: string) { return this.nameOf(id); }
  private touchChat(chatId: string, at: number) {
    const g = this.st.groups[chatId], c = this.st.contacts[chatId];
    if (g) g.lastAt = Math.max(g.lastAt ?? 0, at); else if (c) c.lastAt = Math.max(c.lastAt ?? 0, at); else return; this.markDirty();
  }
  private emitMsg(m: Message) { this.emit({ type: "message", data: m }); }
  private patch(chatId: string, messageId: string, patch: Record<string, unknown>) { this.emit({ type: "message-update", data: { chatId, messageId, patch } }); }
  private pollOf(r: { question: string; multiple: boolean; closed: boolean; options: { id: number; text: string }[]; votes: Record<string, number[]> }) {
    return { question: r.question, multiple: r.multiple, closed: r.closed, options: r.options.map((o) => ({ id: String(o.id), text: o.text, voters: Object.entries(r.votes).filter(([, v]) => v.includes(o.id)).map(([k]) => k) })), mine: (r.votes[this.me] ?? []).map(String) };
  }
  private reactionsOf(key: string) { return Object.entries(this.st.reactions[key] ?? {}).filter(([, s]) => s.length).map(([emoji, s]) => ({ emoji, senderIds: s, ...(s.includes(this.me) ? { mine: true } : {}) })); }
  private react1(chatId: string, mid: string, sender: string, emoji: string | undefined, withdraw: boolean, replaceAll: boolean) {
    const key = `${chatId}|${mid}`, m = (this.st.reactions[key] ??= {});
    if (replaceAll) for (const e of Object.keys(m)) m[e] = m[e].filter((s) => s !== sender);
    if (emoji) { if (withdraw) m[emoji] = (m[emoji] ?? []).filter((s) => s !== sender); else if (!(m[emoji] ??= []).includes(sender)) m[emoji].push(sender); }
    for (const e of Object.keys(m)) if (!m[e].length) delete m[e];
    this.markDirty(); this.patch(chatId, mid, { reactions: this.reactionsOf(key) });
  }

  private async ingest(a: { sender: string; contact?: string; id: bigint; at: number; type: number; body: Uint8Array; fromMe: boolean; hist: boolean; direct: boolean }) {
    if (a.type === Ty.FS) { if (!this.fsWarned) { this.fsWarned = true; this.err("forward-security", "A contact's message used Threema forward security, which linked devices cannot read yet. It was skipped."); } return; }
    const sp = split(a.type, a.body, a.sender); if (!sp) return;
    const group = sp.group, chatId = group ? groupChatId(group) : a.fromMe ? a.contact ?? "" : a.sender;
    if (!chatId) return;
    const mid = hexId(a.id), sender = a.sender, p = parseInner(sp.type, sp.inner), fromMe = a.fromMe;
    const known = () => !!(group ? this.st.groups[chatId] : true);
    const key = `${chatId}|${mid}`, content = (): boolean => { if (this.seen.has(key)) return false; this.seen.add(key); while (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string); return true; };
    const base = (): Message => ({ id: mid, chatId, sender: this.nameOf(sender), senderId: sender, text: "", time: iso(a.at), fromMe, ...(fromMe ? { status: "sent" as const } : {}), ...(a.hist ? { historical: true } : {}) });
    const finish = (m: Message) => {
      const q = QUOTE_RE.exec(m.text); if (q) { m.text = q[2]; m.replyTo = { messageId: q[1] }; }
      if (m.text.includes("@[")) m.text = this.mentionText(m.text);
      this.st.recent[key] = sender; this.touchChat(chatId, a.at); if (!fromMe && !a.hist) { const u = this.unread.get(chatId) ?? []; u.push(a.id); this.unread.set(chatId, u.slice(-500)); }
      this.markDirty(); this.emitMsg(m);
    };
    if (group && !known() && !a.direct && p.k !== "other") dbg("message for an unknown group (waiting for group sync)");
    switch (p.k) {
      case "text": if (content()) finish({ ...base(), text: p.text }); break;
      case "file": {
        if (!content()) break; const f = p.f;
        const kind = f.kind === 2 ? "sticker" : f.kind === 1 && f.mime.startsWith("image/") ? "image" : f.kind === 1 && f.mime.startsWith("video/") ? "video" : f.kind === 1 && f.mime.startsWith("audio/") ? "voice" : f.mime.startsWith("image/") && f.kind === 1 ? "image" : "file";
        this.st.media[key] = { k: "file", blobId: f.blobId, key: f.key, mime: f.mime, name: f.name, thumbId: f.thumbBlobId, thumbMime: f.thumbMime, scope1to1: !group };
        const att: Attachment = { id: "file", kind, mime: f.mime, ...(f.name ? { name: f.name } : {}), ...(f.size ? { size: f.size } : {}), ...(f.w ? { width: f.w } : {}), ...(f.h ? { height: f.h } : {}), ...(f.durationS ? { durationMs: Math.round(f.durationS * 1000) } : {}), ...(f.animated ? { gif: true } : {}) };
        finish({ ...base(), text: f.caption ?? "", attachments: [att] }); break;
      }
      case "legacy-image": {
        if (!content()) break; this.st.media[key] = { k: "legacy-image", blobId: p.blobId, nonce: hex(p.nonce), senderPk: this.st.contacts[sender]?.pk, mime: "image/jpeg", scope1to1: !group };
        finish({ ...base(), attachments: [{ id: "file", kind: "image", mime: "image/jpeg", size: p.size }] }); break;
      }
      case "location": if (content()) finish({ ...base(), location: { lat: p.lat, lng: p.lng, ...(p.name ? { name: p.name } : {}), ...(p.address ? { address: p.address } : {}) } }); break;
      case "poll-setup": {
        const pk = `${chatId}|${sender}|${p.id}`; const prev = this.st.polls[pk];
        if (prev) { if (prev.closed || !p.closed) break; prev.closed = true; if (p.votes) prev.votes = p.votes; this.markDirty(); this.patch(chatId, prev.messageId, { poll: this.pollOf(prev) }); break; }
        if (!content()) break;
        const rec = { chatId, messageId: mid, creator: sender, pollId: String(p.id), question: p.d, multiple: p.multiple, closed: p.closed, options: p.choices.map((c) => ({ id: c.id, text: c.name })), votes: p.votes ?? {} };
        this.st.polls[pk] = rec; finish({ ...base(), text: p.d, poll: this.pollOf(rec) }); break;
      }
      case "poll-vote": {
        const rec = this.st.polls[`${chatId}|${p.creator}|${p.id}`]; if (!rec || rec.closed) break;
        const picked = p.choices.filter((c) => c[1] === 1).map((c) => c[0]).filter((id) => rec.options.some((o) => o.id === id));
        rec.votes[sender] = rec.multiple ? picked : picked.slice(0, 1); this.markDirty(); this.patch(chatId, rec.messageId, { poll: this.pollOf(rec) }); break;
      }
      case "receipt": {
        if (!fromMe && !group && (p.status === 1 || p.status === 2)) for (const id of p.ids) this.emit({ type: "receipt", data: { chatId, messageId: hexId(id), status: p.status === 2 ? "read" : "delivered", by: sender, at: iso(a.at) } });
        else if (p.status === 3 || p.status === 4) for (const id of p.ids) this.react1(chatId, hexId(id), sender, p.status === 3 ? "👍" : "👎", false, true);
        break;
      }
      case "typing": if (!fromMe && !group) { this.emit({ type: "typing", data: { chatId, senderId: sender, typing: p.on } }); clearTimeout(this.typingTimers.get(chatId)); if (p.on) this.typingTimers.set(chatId, setTimeout(() => this.emit({ type: "typing", data: { chatId, senderId: sender, typing: false } }), 15_000)); } break;
      case "reaction": this.react1(chatId, hexId(p.id), sender, p.emoji, p.withdraw, false); break;
      case "edit": { const orig = this.st.recent[`${chatId}|${hexId(p.id)}`]; if (orig === sender) this.patch(chatId, hexId(p.id), { text: p.text, editedAt: iso(a.at) }); break; }
      case "delete": { const orig = this.st.recent[`${chatId}|${hexId(p.id)}`]; if (orig === sender) this.patch(chatId, hexId(p.id), { deleted: true, text: "" }); break; }
      case "profile-picture": if (!fromMe) void this.fetchAvatar(group ? "g:" + chatId : sender, p.blobId, p.key, !group); break;
      case "profile-picture-delete": if (!fromMe) { delete this.st.avatars[group ? "g:" + chatId : sender]; delete this.st.avatarRefs[group ? "g:" + chatId : sender]; this.markDirty(); this.pictureChanged(group ? "g:" + chatId : sender); } break;
      case "group-setup": case "group-name": case "group-leave": case "group-sync-request": if (a.direct && !fromMe && group) await this.leaderGroupControl(p, group, sender); break;
      default: dbg(`ignored message type 0x${sp.type.toString(16)}`);
    }
  }
  /** tell the Hub a stored picture is outdated (chat id = the contact identity or the group key without "g:") */
  private pictureChanged(key: string) { this.emit({ type: "avatar-changed", data: key === "own" ? { own: true } : { id: key.startsWith("g:") ? key.slice(2) : key } }); }
  private async fetchAvatar(key: string, blobId: string, keyHex: string, done: boolean) {
    try {
      const data = await this.net!.download(blobId); const p = secretboxOpen(data, nonce1(1), unhex(keyHex));
      if (p) { this.st.avatars[key] = Buffer.from(p).toString("base64"); delete this.st.avatarRefs[key]; this.markDirty(); this.emit({ type: "chats-changed", data: {} }); this.pictureChanged(key); }
      if (done) void this.net!.done(blobId);
    } catch { dbg("profile picture download failed"); }
  }

  // ---------------------------------------------------------------- chat server payloads (we may be the leader)
  private onCspPayload(type: number, d: Uint8Array) {
    switch (type) {
      case P.IN_MSG: if (!this.leader) { dbg("incoming message while not leader: closing"); this.med?.close(4010); return; } this.queue = this.queue.then(() => this.onDirectMessage(d).catch((e) => { dbg("direct message handling failed"); void e; })); break;
      case P.OUT_ACK: { const id = hex(d.subarray(0, 16)); this.outAcks.get(id)?.(); break; }
      case P.ECHO_REQ: try { this.csp!.sendPayload(P.ECHO_RES, d); } catch { /* closing */ } break;
      case P.CLOSE_ERROR: dbg(`chat server closed the connection (reconnect ${d[0] ? "allowed" : "not allowed"})`); if (!d[0]) { this.stopped = true; this.err("chat-closed", "The Threema chat server closed the connection and asked UniChat not to reconnect.", true); this.setState("disconnected", "Closed by the chat server"); } this.med?.close(4000); break;
      case P.ALERT: this.err("server-alert", "Threema sent an alert for this account. Check the Threema app."); break;
      case P.COOKIE_CHANGED: this.err("device-cookie", "Threema reports that another device connected with this account's key. If that was not you, check your Linked Devices in Threema."); break;
      default: break;
    }
  }
  private async lookup(ids: string[]): Promise<void> {
    const need = ids.filter((i) => !this.st.contacts[i]?.pk && i !== this.me); if (!need.length) return;
    const k = need.sort().join(",");
    let p = this.dirLookups.get(k);
    if (!p) { p = (async () => { const m = await this.net!.fetchIdentities(need); for (const [id, e] of m) { const c = this.st.contacts[id] ?? { identity: id, acq: 1, feature: "0", tmp: true }; c.pk = hex(e.publicKey); c.feature = e.featureMask.toString(); this.st.contacts[id] = c; } this.markDirty(); })().finally(() => this.dirLookups.delete(k)); this.dirLookups.set(k, p); }
    await p;
  }
  /** Leader path: decrypt a message the chat server delivers, reflect it, then acknowledge it (PROTOCOL-NOTES 6). */
  private async onDirectMessage(raw: Uint8Array) {
    const csp = this.csp, med = this.med; if (!csp || !med) return;
    const w = parseWire(raw), ack = () => { if (!(w.flags & 4)) csp.sendPayload(P.IN_ACK, messageAck(w.sender, w.messageId)); };
    if (this.nonces.has(w.nonce, this.me) || w.receiver !== this.me || w.sender === this.me) return ack();
    if (w.sender.startsWith("*3MA")) return ack();
    try { await this.lookup([w.sender]); } catch { dbg("sender lookup failed; message left unacknowledged"); throw new Error("lookup"); }
    const pk = this.st.contacts[w.sender]?.pk; if (!pk) return ack(); // invalid / revoked sender
    const o = openIncoming(w, this.ck, unhex(pk)); if (!o) { dbg("undecryptable message dropped"); return ack(); }
    if (o.type === Ty.FS) { await this.ingest({ sender: w.sender, id: w.messageId, at: 0, type: Ty.FS, body: o.body, fromMe: false, hist: false, direct: true }); return ack(); }
    if (this.st.blocked.includes(w.sender)) { this.nonces.add(w.nonce); return ack(); }
    const sp = split(o.type, o.body, w.sender); const at = Number(o.metadata?.createdAt ?? BigInt(w.createdAtS) * 1000n);
    if (o.metadata?.nickname !== undefined && this.st.contacts[w.sender]) { this.st.contacts[w.sender].nick = o.metadata.nickname; this.markDirty(); }
    // implicit direct contact creation for conversation messages (transaction + ContactSync, csp.struct.yml)
    const creates = [Ty.TEXT, Ty.FILE, Ty.LOCATION, Ty.IMAGE, Ty.POLL_SETUP].includes(o.type as 1);
    if (creates && this.st.contacts[w.sender]?.acq !== Enum.acquaintance.DIRECT) await this.syncContact(w.sender, Enum.acquaintance.DIRECT, o.metadata?.nickname);
    const reflectIt = o.type !== Ty.TYPING && sp?.type !== Ty.GROUP_SYNC_REQ;
    await this.ingest({ sender: w.sender, id: w.messageId, at, type: o.type, body: o.body, fromMe: false, hist: false, direct: true });
    if (reflectIt) await med.reflect({ incomingMessage: { senderIdentity: w.sender, messageId: w.messageId, createdAt: BigInt(at), type: o.type, body: o.body, nonce: w.nonce } });
    else if (o.type === Ty.TYPING) void med.reflect({ incomingMessage: { senderIdentity: w.sender, messageId: w.messageId, createdAt: BigInt(at), type: o.type, body: o.body, nonce: w.nonce } }, true).catch(() => {});
    this.nonces.add(w.nonce);
    if (!sp?.group && RECEIPT_TYPES.has(o.type) && !(w.flags & 0x80)) void this.deliver({ contact: w.sender }, Ty.DELIVERY, deliveryBody(1, [w.messageId]), { flags: 0, sentUpdate: false }).catch(() => dbg("automatic receipt failed"));
    ack();
  }
  private async syncContact(id: string, acq: number, nick?: string) {
    const med = this.med!; const c = this.st.contacts[id] ?? { identity: id, acq: 1, feature: "0" }; const known = !!this.st.contacts[id] && !this.st.contacts[id].tmp;
    await med.transaction(Enum.scope.CONTACT_SYNC, async () => {
      const msg = { identity: id, publicKey: c.pk ? unhex(c.pk) : undefined, acquaintanceLevel: acq, nickname: nick, featureMask: BigInt(c.feature), ...(this.st.contacts[id] ? {} : { createdAt: BigInt(Date.now()) }) };
      await med.reflect(known ? { contactSync: { update: { contact: { identity: id, acquaintanceLevel: acq, ...(nick !== undefined ? { nickname: nick } : {}) } } } } : { contactSync: { create: { contact: { ...msg, verificationLevel: 0, identityType: 0, activityState: 0, syncState: 0, conversationCategory: 0, conversationVisibility: 0 } } } });
    });
    delete c.tmp; c.acq = acq; if (nick !== undefined) c.nick = nick; this.st.contacts[id] = c; this.markDirty(); this.emit({ type: "chats-changed", data: {} });
  }
  private async leaderGroupControl(p: Parsed, g: GroupRef, sender: string) {
    const key = groupChatId(g), med = this.med!, cur = this.st.groups[key];
    if (p.k === "group-sync-request") { // a member lacks the group: as its creator, answer with the setup + name. The request names the group by id only; its creator is the RECEIVER (us).
      const mine: GroupRef = { creator: this.me, id: g.id }, rec = this.st.groups[groupChatId(mine)];
      if (rec && rec.state === 0 && rec.members.includes(sender)) { await this.groupCtl(mine, Ty.GROUP_SETUP, this.idBytes(rec.members), [sender]); await this.groupCtl(mine, Ty.GROUP_NAME, textBody(rec.name ?? ""), [sender]); }
      return;
    }
    if (p.k === "group-setup") {
      if (sender !== g.creator) return;
      const members = p.members.filter((m) => ID_RE.test(m));
      if (!members.includes(this.me)) { if (cur && cur.state === 0) await med.transaction(Enum.scope.GROUP_SYNC, async () => { await med.reflect({ groupSync: { update: { group: { groupIdentity: { groupId: g.id, creatorIdentity: g.creator }, userState: Enum.userState.KICKED } } } }); }); if (cur) cur.state = 1; this.markDirty(); return; }
      await this.lookup(members.filter((m) => !this.st.contacts[m]?.pk)).catch(() => {});
      for (const m of [...members, g.creator]) if (m !== this.me && (!this.st.contacts[m] || this.st.contacts[m].tmp)) await this.syncContact(m, Enum.acquaintance.GROUP_OR_DELETED);
      const grp = { groupIdentity: { groupId: g.id, creatorIdentity: g.creator }, memberIdentities: { identities: members }, userState: 0, ...(cur ? {} : { name: "", createdAt: BigInt(Date.now()), conversationCategory: 0, conversationVisibility: 0 }) };
      await med.transaction(Enum.scope.GROUP_SYNC, async () => { await med.reflect(cur ? { groupSync: { update: { group: grp, memberStateChanges: new Map() } } } : { groupSync: { create: { group: grp } } }); });
      this.upsertGroup(grp); this.emit({ type: "chats-changed", data: {} });
    } else if (p.k === "group-name" && cur && sender === g.creator) {
      await med.transaction(Enum.scope.GROUP_SYNC, async () => { await med.reflect({ groupSync: { update: { group: { groupIdentity: { groupId: g.id, creatorIdentity: g.creator }, name: p.name }, memberStateChanges: new Map() } } }); });
      cur.name = p.name; this.markDirty(); this.emit({ type: "chats-changed", data: { chatId: key } });
    } else if (p.k === "group-leave" && cur && cur.members.includes(sender)) {
      const members = cur.members.filter((m) => m !== sender);
      await med.transaction(Enum.scope.GROUP_SYNC, async () => { await med.reflect({ groupSync: { update: { group: { groupIdentity: { groupId: g.id, creatorIdentity: g.creator }, memberIdentities: { identities: members } }, memberStateChanges: new Map([[sender, 2]]) } } }); });
      cur.members = members; this.markDirty(); this.emit({ type: "chats-changed", data: { chatId: key } });
    }
  }

  // ---------------------------------------------------------------- group management (creator duties; fixture-tested only, see README)
  private idBytes = (ids: string[]) => { const e = new TextEncoder(), out = new Uint8Array(ids.length * 8); ids.forEach((id, i) => out.set(e.encode(id), i * 8)); return out; };
  private async groupCtl(g: GroupRef, type: number, inner: Uint8Array, to: string[], creatorContainer = true) {
    for (const r of to) await this.deliver({ group: g }, type, inner, { flags: 0, sentUpdate: false, reflect: false, creatorContainer, to: [r] });
  }
  /** Reflect the group record (create or update) in a GROUP_SYNC transaction, like the phone does for its own groups. */
  private async reflectGroup(g: GroupRef, rec: GroupRec, created: boolean, changes?: Map<string, number>) {
    const med = this.med!;
    const group = { groupIdentity: { groupId: g.id, creatorIdentity: g.creator }, name: rec.name ?? "", memberIdentities: { identities: rec.members }, userState: rec.state,
      ...(created ? { createdAt: BigInt(rec.createdAt ?? Date.now()), conversationCategory: 0, conversationVisibility: 0 } : {}) };
    await med.transaction(Enum.scope.GROUP_SYNC, async () => { await med.reflect(created ? { groupSync: { create: { group } } } : { groupSync: { update: { group, memberStateChanges: changes ?? new Map() } } }); });
  }
  private async memberIds(handles: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const h of handles) {
      const id = h.trim().toUpperCase(); if (!ID_RE.test(id)) throw new Error(`"${h.trim()}" is not a Threema ID (8 letters and digits).`);
      if (id === this.me) continue; if (!ids.includes(id)) ids.push(id);
    }
    try { await this.lookup(ids); } catch (e) { throw new Error(e instanceof HttpError && e.status === 429 ? "Threema's directory is rate limiting requests. Try again in a minute." : "Could not look up the Threema IDs."); }
    for (const id of ids) {
      if (!this.st.contacts[id]?.pk) throw new Error(`The Threema ID ${id} does not exist.`);
      if (this.st.blocked.includes(id)) throw new Error(`${id} is blocked. Unblock the contact first.`);
      if (!this.st.contacts[id] || this.st.contacts[id].tmp) await this.syncContact(id, Enum.acquaintance.GROUP_OR_DELETED);
    }
    return ids;
  }
  async createGroup(name: string, memberHandles: string[]): Promise<Chat> {
    this.ready(); const n = name.trim().slice(0, 256); if (!n) throw new Error("Give the group a name.");
    const members = await this.memberIds(memberHandles); if (!members.length) throw new Error("Pick at least one other person.");
    if (members.length > 99) throw new Error("A Threema group holds at most 100 people.");
    const g: GroupRef = { creator: this.me, id: randomId() }, key = groupChatId(g);
    const rec: GroupRec = { creator: this.me, id: hexId(g.id), name: n, members, state: 0, createdAt: Date.now(), lastAt: Date.now() };
    await this.reflectGroup(g, rec, true);
    this.st.groups[key] = rec; this.markDirty();
    await this.groupCtl(g, Ty.GROUP_SETUP, this.idBytes(members), members); await this.groupCtl(g, Ty.GROUP_NAME, textBody(n), members);
    this.emit({ type: "chats-changed", data: {} });
    return this.chatOfGroup(key, rec);
  }
  private chatOfGroup(id: string, g: GroupRec): Chat {
    return { id, accountId: this.accountId, provider: "threema-md", kind: "group", name: g.name || "Group", ...(g.lastAt ? { lastMessageAt: iso(g.lastAt) } : {}), canManage: g.creator === this.me && g.state === 0, ...(g.state !== 0 ? { readOnly: true } : {}) };
  }
  private myGroup(chatId: string): { g: GroupRef; rec: GroupRec } {
    const g = parseGroupChatId(chatId), rec = this.st.groups[chatId]; if (!g || !rec) throw new Error("Only group chats can be managed.");
    if (rec.state !== 0) throw new Error("You are no longer a member of this group.");
    return { g, rec };
  }
  private myOwnGroup(chatId: string) { const r = this.myGroup(chatId); if (r.rec.creator !== this.me) throw new Error("Only the person who created this group can change it on Threema."); this.ready(); return r; }
  async renameChat(chatId: string, name: string): Promise<void> {
    const { g, rec } = this.myOwnGroup(chatId); const n = name.trim().slice(0, 256); if (!n) throw new Error("Give the group a name.");
    await this.med!.transaction(Enum.scope.GROUP_SYNC, async () => { await this.med!.reflect({ groupSync: { update: { group: { groupIdentity: { groupId: g.id, creatorIdentity: g.creator }, name: n }, memberStateChanges: new Map() } } }); });
    rec.name = n; this.markDirty();
    await this.groupCtl(g, Ty.GROUP_NAME, textBody(n), rec.members); this.emit({ type: "chats-changed", data: { chatId } });
  }
  async addMembers(chatId: string, handles: string[]): Promise<void> {
    const { g, rec } = this.myOwnGroup(chatId); const add = (await this.memberIds(handles)).filter((i) => !rec.members.includes(i));
    if (!add.length) return; const all = [...rec.members, ...add]; if (all.length > 99) throw new Error("A Threema group holds at most 100 people.");
    await this.reflectGroup(g, { ...rec, members: all }, false, new Map(add.map((i) => [i, 0] as [string, number])));
    rec.members = all; this.markDirty();
    await this.groupCtl(g, Ty.GROUP_SETUP, this.idBytes(all), all); await this.groupCtl(g, Ty.GROUP_NAME, textBody(rec.name ?? ""), add);
    this.emit({ type: "chats-changed", data: { chatId } });
  }
  async removeMember(chatId: string, memberId: string): Promise<void> {
    const { g, rec } = this.myOwnGroup(chatId);
    if (memberId === this.me) throw new Error("Use Leave group to leave."); if (!rec.members.includes(memberId)) throw new Error("That person is not in the group.");
    const rest = rec.members.filter((m) => m !== memberId);
    if (!rest.length) throw new Error("A group needs at least one other member. Leave the group to dissolve it.");
    await this.reflectGroup(g, { ...rec, members: rest }, false, new Map([[memberId, 1]]));
    rec.members = rest; this.markDirty();
    await this.groupCtl(g, Ty.GROUP_SETUP, this.idBytes(rest), rest); await this.groupCtl(g, Ty.GROUP_SETUP, new Uint8Array(0), [memberId]); // the removed person gets an empty list
    this.emit({ type: "chats-changed", data: { chatId } });
  }
  async leaveChat(chatId: string): Promise<void> {
    const { g, rec } = this.myGroup(chatId); this.ready();
    const to = [...new Set([...rec.members, rec.creator])].filter((m) => m !== this.me);
    if (rec.creator === this.me) await this.groupCtl(g, Ty.GROUP_SETUP, new Uint8Array(0), to); // the creator leaving dissolves the group
    else await this.groupCtl(g, Ty.GROUP_LEAVE, new Uint8Array(0), to, false);
    rec.state = Enum.userState.LEFT; this.markDirty();
    await this.reflectGroup(g, rec, false); this.emit({ type: "chats-changed", data: { chatId } });
  }

  // ---------------------------------------------------------------- privacy (synced settings of the device group)
  async getPrivacy(): Promise<PrivacySetting[]> {
    const yn = [{ value: "send", label: "Send" }, { value: "off", label: "Do not send" }];
    return [
      { id: "read_receipts", label: "Read receipts", description: "Tell people when you have read their message.", value: this.st.readReceipts ? "send" : "off", options: yn },
      { id: "typing", label: "Typing indicator", description: "Show people when you are typing.", value: this.st.typing ? "send" : "off", options: yn },
    ];
  }
  async setPrivacy(id: string, value: string): Promise<PrivacySetting[]> {
    if (!["read_receipts", "typing"].includes(id) || !["send", "off"].includes(value)) throw new Error("Unknown privacy setting or value.");
    this.ready(); const policy = value === "send" ? 0 : 1;
    await this.med!.transaction(Enum.scope.SETTINGS_SYNC, async () => { await this.med!.reflect({ settingsSync: { update: { settings: id === "typing" ? { typingIndicatorPolicy: policy } : { readReceiptPolicy: policy } } } }); });
    if (id === "typing") this.st.typing = policy === 0; else this.st.readReceipts = policy === 0; this.markDirty();
    return this.getPrivacy();
  }

  /** `@[IDENTITY]` is Threema's mention markup: show the name, and send our `@Name` spans in that form. */
  private sendMentions(msg: OutgoingMessage, group: boolean): string {
    if (!group || !msg.mentions?.length) return msg.text;
    let out = "", at = 0;
    for (const m of [...msg.mentions].sort((a, b) => a.start - b.start)) {
      if (!ID_RE.test(m.id) || m.start < at || msg.text[m.start] !== "@") continue;
      out += msg.text.slice(at, m.start) + `@[${m.id}]`; at = m.start + m.length;
    }
    return out + msg.text.slice(at);
  }
  private mentionText(text: string): string { return text.replace(/@\[([0-9A-Z*@]{8})\]/g, (_s, id: string) => (id === "@@@@@@@@" ? "@All" : "@" + this.nameOf(id))); }

  // ---------------------------------------------------------------- sending
  private ready() { if (!this.csp?.ready || !this.med || this.med.isClosed || !this.session?.registered) throw new Error("UniChat is not connected to Threema right now. Try again in a moment."); }
  private convOf(chatId: string): { contact?: string; group?: GroupRef } {
    const g = parseGroupChatId(chatId); if (g) { if (!this.st.groups[chatId]) throw new Error("Unknown group."); return { group: g }; }
    if (!ID_RE.test(chatId)) throw new Error("Unknown chat."); return { contact: chatId };
  }
  private receiversOf(conv: { contact?: string; group?: GroupRef }): string[] {
    if (conv.contact) return [conv.contact];
    const rec = this.st.groups[groupChatId(conv.group!)]; if (!rec) throw new Error("Unknown group.");
    if (rec.state !== 0) throw new Error("You are no longer a member of this group.");
    return [...new Set([...rec.members, rec.creator])].filter((m) => m !== this.me);
  }
  private featureOk(receivers: string[], bit: bigint) { return receivers.every((r) => (BigInt(this.st.contacts[r]?.feature ?? "0") & bit) !== 0n); }
  private async deliver(conv: { contact?: string; group?: GroupRef }, type: number, inner: Uint8Array, o: { flags: number; sentUpdate: boolean; reflect?: boolean; messageId?: bigint; at?: number; creatorContainer?: boolean; to?: string[] }): Promise<{ id: bigint; at: number }> {
    this.ready(); const csp = this.csp!, med = this.med!;
    const receivers = o.to ?? this.receiversOf(conv);
    if (conv.contact && this.st.blocked.includes(conv.contact)) throw new Error("This contact is blocked.");
    try { await this.lookup(receivers); } catch (e) { throw new Error(e instanceof HttpError && e.status === 429 ? "Threema's directory is rate limiting requests. Try again in a minute." : "Could not look up the recipient's key at Threema."); }
    for (const r of receivers) if (!this.st.contacts[r]?.pk) throw new Error("This Threema ID does not exist (anymore).");
    if (conv.contact && o.reflect !== false && this.st.contacts[conv.contact]?.acq !== Enum.acquaintance.DIRECT && type !== Ty.TYPING) await this.syncContact(conv.contact, Enum.acquaintance.DIRECT);
    const id = o.messageId ?? randomId(), at = o.at ?? Date.now();
    const w = conv.group ? wrapGroup(type, conv.group, inner, o.creatorContainer) : { type, body: inner };
    const nonces = receivers.map(() => new Uint8Array(randomBytes(24)));
    const cv = conv.group ? { group: { groupId: conv.group.id, creatorIdentity: conv.group.creator } } : { contact: conv.contact };
    if (o.reflect !== false) await med.reflect({ outgoingMessage: { conversation: cv, messageId: id, createdAt: BigInt(at), type: w.type, body: w.body, nonces } });
    const waits: Promise<void>[] = [];
    receivers.forEach((r, i) => {
      const wire = sealOutgoing({ identity: this.me, ck: this.ck, peer: r, peerPk: unhex(this.st.contacts[r].pk!), type: w.type, body: w.body, messageId: id, createdAtMs: at, nonce: nonces[i], flags: o.flags, nickname: this.st.nickname });
      if (!(o.flags & 4)) { const k = hex(cat(new TextEncoder().encode(r), u64le(id))); waits.push(new Promise<void>((ok, fail) => { const tm = setTimeout(() => { this.outAcks.delete(k); fail(new Error("Threema's chat server did not confirm the message in time. It may still be delivered.")); }, 30_000); this.outAcks.set(k, () => { clearTimeout(tm); this.outAcks.delete(k); ok(); }); })); }
      csp.sendPayload(P.OUT_MSG, wire);
    });
    await Promise.all(waits);
    if (o.sentUpdate && o.reflect !== false) await med.reflect({ outgoingMessageUpdate: { updates: [{ conversation: cv, messageId: id, sent: {} }] } });
    return { id, at };
  }
  private mine(chatId: string, id: bigint, at: number): Message {
    const mid = hexId(id); this.st.recent[`${chatId}|${mid}`] = this.me; this.seen.add(`${chatId}|${mid}`); this.touchChat(chatId, at);
    return { id: mid, chatId, sender: this.nameOf(this.me), senderId: this.me, text: "", time: iso(at), fromMe: true, status: "sent" };
  }
  async send(chatId: string, msg: OutgoingMessage): Promise<Message> {
    const conv = this.convOf(chatId), members = this.receiversOf(conv), isGroup = !!conv.group;
    const quote = msg.replyToMessageId ? (t: string) => quoteText(idFromHex(msg.replyToMessageId!), t) : (t: string) => t;
    const bytes = (t: string) => new TextEncoder().encode(t).length;
    if (msg.poll) {
      if (!this.featureOk(members, FEATURE.POLL)) throw new Error("A recipient's Threema app does not support polls.");
      const pid = randomId(); const body = pollSetupBody(pid, msg.poll.question, msg.poll.options, !!msg.poll.multiple);
      const r = await this.deliver(conv, Ty.POLL_SETUP, body, { flags: 1, sentUpdate: true });
      const rec = { chatId, messageId: hexId(r.id), creator: this.me, pollId: String(pid), question: msg.poll.question, multiple: !!msg.poll.multiple, closed: false, options: msg.poll.options.map((t, i) => ({ id: i, text: t })), votes: {} as Record<string, number[]> };
      this.st.polls[`${chatId}|${this.me}|${pid}`] = rec; this.markDirty();
      return { ...this.mine(chatId, r.id, r.at), text: msg.poll.question, poll: this.pollOf(rec) };
    }
    if (msg.location) {
      const r = await this.deliver(conv, Ty.LOCATION, locationBody(msg.location), { flags: 1, sentUpdate: true });
      return { ...this.mine(chatId, r.id, r.at), location: msg.location };
    }
    if (msg.attachments?.length) {
      let first: Message | undefined; const extra: Message[] = [];
      for (const [i, a] of msg.attachments.entries()) {
        if (a.data.length > 90 * 1048576) throw new Error("This file is too large for Threema (limit about 100 MB).");
        const k = new Uint8Array(randomBytes(32)), enc = secretbox(a.data, nonce1(1), k);
        let blobId: string;
        try { blobId = await this.net!.upload(enc, isGroup); } catch { throw new Error("Could not upload the file to Threema's blob server."); }
        const kind = a.kind === "file" ? 0 : a.kind === "sticker" ? 2 : 1;
        const media = a.mime.startsWith("image/") && !IMG.test(a.mime) ? 0 : kind;
        const cap = a.caption ?? (i === 0 ? msg.text : ""); const caption = cap ? (i === 0 ? quote(cap) : cap) : undefined;
        if (caption && bytes(caption) > 6000) throw new Error("The caption is too long for Threema.");
        const body = fileBody({ kind: media, mime: a.mime, name: a.name, size: a.data.length, blobId, key: hex(k), caption, w: a.width, h: a.height, animated: a.gif, durationS: a.durationMs ? a.durationMs / 1000 : undefined });
        const r = await this.deliver(conv, Ty.FILE, body, { flags: 1, sentUpdate: true });
        const m: Message = { ...this.mine(chatId, r.id, r.at), text: cap ?? "", attachments: [{ id: "file", kind: a.kind, mime: a.mime, ...(a.name ? { name: a.name } : {}), size: a.data.length }], ...(msg.replyToMessageId && i === 0 ? { replyTo: { messageId: msg.replyToMessageId } } : {}) };
        this.st.media[`${chatId}|${m.id}`] = { k: "file", blobId, key: hex(k), mime: a.mime, name: a.name, scope1to1: !isGroup }; this.markDirty();
        if (i === 0) first = m; else { extra.push(m); }
      }
      for (const m of extra) this.emitMsg(m);
      return first!;
    }
    const text = quote(this.sendMentions(msg, isGroup));
    if (!msg.text.trim()) throw new Error("Nothing to send.");
    if (bytes(text) > 6000) throw new Error("This message is too long for Threema (limit 6000 bytes). Please split it.");
    const r = await this.deliver(conv, Ty.TEXT, textBody(text), { flags: 1, sentUpdate: true });
    return { ...this.mine(chatId, r.id, r.at), text: msg.text, ...(msg.replyToMessageId ? { replyTo: { messageId: msg.replyToMessageId } } : {}) };
  }
  async setTyping(chatId: string, typing: boolean): Promise<void> {
    if (!this.st.typing || parseGroupChatId(chatId) || !ID_RE.test(chatId) || !this.csp?.ready) return;
    await this.deliver({ contact: chatId }, Ty.TYPING, typingBody(typing), { flags: 0x06, sentUpdate: false, reflect: false }).catch(() => undefined);
  }
  async markRead(chatId: string, upTo: string): Promise<void> {
    const ids = this.unread.get(chatId) ?? []; const last = idFromHex(upTo); const cut = ids.lastIndexOf(last);
    const take = cut >= 0 ? ids.slice(0, cut + 1) : ids; if (!take.length) return;
    this.unread.set(chatId, ids.slice(take.length)); const conv = this.convOf(chatId);
    if (!conv.group && this.st.readReceipts) { for (let i = 0; i < take.length; i += 875) await this.deliver(conv, Ty.DELIVERY, deliveryBody(2, take.slice(i, i + 875)), { flags: 0, sentUpdate: false }); }
    else { this.ready(); const cv = conv.group ? { group: { groupId: conv.group.id, creatorIdentity: conv.group.creator } } : { contact: conv.contact };
      await this.med!.reflect({ incomingMessageUpdate: { updates: take.slice(-200).map((id) => ({ conversation: cv, messageId: id, read: { at: BigInt(Date.now()) } })) } }); }
  }
  private ownRecent(chatId: string, messageId: string) { if (this.st.recent[`${chatId}|${messageId}`] !== this.me) throw new Error("Only your own messages can be changed."); }
  async react(chatId: string, messageId: string, emoji: string | null): Promise<void> {
    const conv = this.convOf(chatId), rcv = this.receiversOf(conv), id = idFromHex(messageId), key = `${chatId}|${messageId}`;
    const mineNow = Object.entries(this.st.reactions[key] ?? {}).filter(([, s]) => s.includes(this.me)).map(([e]) => e);
    if (this.featureOk(rcv, FEATURE.REACTION)) {
      for (const e of mineNow.filter((x) => x !== emoji)) { await this.deliver(conv, Ty.REACTION, reactionBody(id, e, true), { flags: 0, sentUpdate: true }); this.react1(chatId, messageId, this.me, e, true, false); }
      if (emoji && !mineNow.includes(emoji)) { await this.deliver(conv, Ty.REACTION, reactionBody(id, emoji, false), { flags: 0, sentUpdate: true }); this.react1(chatId, messageId, this.me, emoji, false, false); }
    } else if (!conv.group && (emoji === "👍" || emoji === "👎" || emoji === null)) {
      if (emoji) { await this.deliver(conv, Ty.DELIVERY, deliveryBody(emoji === "👍" ? 3 : 4, [id]), { flags: 0, sentUpdate: false }); this.react1(chatId, messageId, this.me, emoji, false, true); }
      else throw new Error("This contact's Threema app cannot withdraw reactions.");
    } else throw new Error("A recipient's Threema app does not support this reaction.");
  }
  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    this.ownRecent(chatId, messageId); const conv = this.convOf(chatId);
    if (!this.featureOk(this.receiversOf(conv), FEATURE.EDIT)) throw new Error("A recipient's Threema app does not support editing messages.");
    await this.deliver(conv, Ty.EDIT, editBody(idFromHex(messageId), text), { flags: 1, sentUpdate: true }); this.patch(chatId, messageId, { text, editedAt: new Date().toISOString() });
  }
  async delete(chatId: string, messageId: string): Promise<void> {
    this.ownRecent(chatId, messageId); const conv = this.convOf(chatId);
    if (!this.featureOk(this.receiversOf(conv), FEATURE.DELETE)) throw new Error("A recipient's Threema app does not support deleting messages.");
    await this.deliver(conv, Ty.DELETE, deleteBody(idFromHex(messageId)), { flags: 1, sentUpdate: true }); this.patch(chatId, messageId, { deleted: true, text: "" });
  }
  async vote(chatId: string, messageId: string, optionIds: string[]): Promise<void> {
    const rec = Object.values(this.st.polls).find((p) => p.chatId === chatId && p.messageId === messageId); if (!rec || rec.closed) throw new Error("This poll is closed or unknown.");
    const conv = this.convOf(chatId), picked = optionIds.map(Number);
    await this.deliver(conv, Ty.POLL_VOTE, pollVoteBody(rec.creator, BigInt(rec.pollId), rec.options.map((o) => [o.id, picked.includes(o.id) ? 1 : 0] as [number, number])), { flags: 1, sentUpdate: true });
    rec.votes[this.me] = picked; this.markDirty(); this.patch(chatId, messageId, { poll: this.pollOf(rec) });
  }

  // ---------------------------------------------------------------- read side
  async spaces() { return []; }
  async chats(): Promise<Chat[]> {
    const out: Chat[] = [];
    for (const c of Object.values(this.st.contacts)) {
      if (c.tmp) continue;
      if (c.acq !== Enum.acquaintance.DIRECT && !c.lastAt) continue;
      out.push({ id: c.identity, accountId: this.accountId, provider: "threema-md", kind: "dm", name: contactName(c, c.identity), ...(c.lastAt ? { lastMessageAt: iso(c.lastAt) } : {}), ...(this.st.blocked.includes(c.identity) ? { blocked: true } : {}), ...(c.vis === 1 ? { archived: true } : c.vis === 2 ? { pinned: true } : {}) });
    }
    for (const [id, g] of Object.entries(this.st.groups)) out.push({ id, accountId: this.accountId, provider: "threema-md", kind: "group", name: g.name || "Group", ...(g.lastAt ? { lastMessageAt: iso(g.lastAt) } : {}), canManage: g.creator === this.me && g.state === 0, ...(g.state !== 0 ? { readOnly: true } : {}) });
    return out;
  }
  async history(_chatId: string, _q: HistoryQuery): Promise<Message[]> { return []; } // Threema keeps no server-side history: UniChat's own archive only
  async members(chatId: string): Promise<Contact[]> {
    const g = this.st.groups[chatId]; const ids = g ? [...new Set([g.creator, ...g.members, this.me])] : [chatId];
    return ids.map((id) => ({ id, name: this.nameOf(id), handle: id }));
  }
  async downloadAttachment(chatId: string, messageId: string, _attachmentId: string) {
    const m = this.st.media[`${chatId}|${messageId}`]; if (!m) throw new Error("This attachment is no longer available.");
    this.ready0();
    let enc: Uint8Array; try { enc = await this.net!.download(m.blobId); } catch { throw new Error("Could not download the attachment from Threema."); }
    let plain: Uint8Array | undefined;
    if (m.k === "file") plain = secretboxOpen(enc, nonce1(1), unhex(m.key!));
    else if (m.senderPk) { const { boxOpen } = await import("./nacl.js"); plain = boxOpen(enc, unhex(m.nonce!), unhex(m.senderPk), this.ck); }
    if (!plain) throw new Error("The attachment could not be decrypted.");
    if (m.scope1to1) void this.net!.done(m.blobId);
    return { data: plain, mime: m.mime, ...(m.name ? { name: m.name } : {}) };
  }
  private ready0() { if (!this.net || !this.session) throw new Error("Not linked."); }
  async avatar(t: { kind: "chat" | "space" | "contact" | "emoji"; id: string }) {
    if (t.kind === "space" || t.kind === "emoji") return undefined;
    const key = parseGroupChatId(t.id) ? "g:" + t.id : t.id;
    let b64 = this.st.avatars[key];
    if (!b64 && this.st.avatarRefs[key] && this.net) { const r = this.st.avatarRefs[key]; try { const d = await this.net.download(r.blobId); const p = secretboxOpen(d, r.nonce ? unhex(r.nonce) : nonce1(1), unhex(r.key)); if (p) { b64 = this.st.avatars[key] = Buffer.from(p).toString("base64"); delete this.st.avatarRefs[key]; this.markDirty(); } } catch { return undefined; } }
    if (!b64) return undefined; const data = new Uint8Array(Buffer.from(b64, "base64")); return { data, mime: mimeSniff(data) };
  }
  async startChat(handle: string): Promise<Chat> {
    const id = handle.trim().toUpperCase(); if (!ID_RE.test(id)) throw new Error("A Threema ID has 8 characters (letters and digits).");
    if (id === this.me) throw new Error("That is your own Threema ID.");
    this.ready();
    if (!this.st.contacts[id]?.pk) { try { await this.lookup([id]); } catch (e) { throw new Error(e instanceof HttpError && e.status === 429 ? "Threema's directory is rate limiting requests. Try again in a minute." : "Could not look up that Threema ID."); } }
    if (!this.st.contacts[id]?.pk) throw new Error("No Threema user with that ID was found.");
    if (this.st.contacts[id].acq !== Enum.acquaintance.DIRECT) await this.syncContact(id, Enum.acquaintance.DIRECT);
    return (await this.chats()).find((c) => c.id === id)!;
  }
  async blockChat(chatId: string, blocked: boolean): Promise<void> {
    if (!ID_RE.test(chatId)) throw new Error("Only one-to-one chats can be blocked."); this.ready();
    const list = new Set(this.st.blocked); blocked ? list.add(chatId) : list.delete(chatId);
    await this.med!.transaction(Enum.scope.SETTINGS_SYNC, async () => { await this.med!.reflect({ settingsSync: { update: { settings: { blockedIdentities: { identities: [...list] } } } } }); });
    this.st.blocked = [...list]; this.markDirty(); this.emit({ type: "chats-changed", data: { chatId } });
  }
  async getProfile(): Promise<Profile> {
    const b64 = this.st.avatars.own; return { displayName: this.st.nickname ?? "", handle: this.me, ...(b64 ? { avatar: { data: new Uint8Array(Buffer.from(b64, "base64")), mime: "image/jpeg" } } : {}) };
  }
  async updateProfile(p: ProfilePatch): Promise<Profile> {
    if (p.displayName !== undefined) {
      this.ready(); const nick = p.displayName.slice(0, 32);
      await this.med!.transaction(Enum.scope.USER_PROFILE_SYNC, async () => { await this.med!.reflect({ userProfileSync: { update: { userProfile: { nickname: nick } } } }); });
      this.st.nickname = nick; this.markDirty();
    }
    return this.getProfile();
  }
}

const factory: ProviderFactory = {
  name: "threema-md", displayName: "Threema", login: "qr", capabilities: CAPABILITIES,
  create: ({ accountId, dataDir }) => new ThreemaMdConnector(accountId, dataDir),
};
export default factory;
void publicKeyOf;
