// Content -> UniChat events. Pure w.r.t. the network: takes decrypted Content, updates the local store
// (chat index, reactions, sent index) and emits CoreEvents. Never logs message content.
import type { Attachment, Card, Chat, CoreEvent, Message, Reaction as UiReaction, SharedContact } from "@unimsg/core";
import {
  DataMessageFlags, FetchLatestType, ReceiptType, TypingAction, type AttachmentPointer, type Content, type DataMessage,
} from "../protocol/codec.js";
import { Aci, PublicKey } from "@signalapp/libsignal-client";
import { serviceIdFromBinary, stripPni } from "../protocol/ids.js";
import type { SignalStore } from "../store/signalStore.js";
import type { AttachmentRef } from "../store/types.js";
import { applyVote, pollView, registerPoll, terminatePoll } from "./polls.js";
import {
  KNOWN_CONTENT_FIELDS, KNOWN_DATA_FIELDS, renderCallEvent, renderCallMessage, renderDataExtras, renderMentions, renderPreview,
  renderStoryReply, timerNotice, unsupportedFields,
} from "./richContent.js";
import { groupChatId, groupIdFromMasterKey, isGroupChatId } from "./groups.js";
import type { Decrypted } from "./decrypt.js";
import { deriveStorageKey } from "./storageCrypto.js";
import { cleanName } from "./profileCrypto.js";

export const messageId = (authorAci: string, ts: number) => `${authorAci}.${ts}`;
export function parseMessageId(id: string): { author: string; timestamp: number } {
  const i = id.lastIndexOf(".");
  const timestamp = Number(id.slice(i + 1));
  if (i < 0 || !Number.isFinite(timestamp)) throw new Error("not a Signal message id");
  return { author: id.slice(0, i), timestamp };
}

const shortName = (aci: string) => aci.slice(0, 8);

function kindOfAttachment(mime: string, flags?: number): Attachment["kind"] {
  if (flags && (flags & 1)) return "voice";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

export interface InboundHooks {
  /** The primary device sent a contacts blob (download + parse is the client's job). */
  onContactsBlob?(ref: AttachmentRef, complete: boolean): void;
  /** A message announced this group at `revision` (state refresh is the client's job). */
  onGroupSeen?(chatId: string, revision?: number): void;
  /** A profile key for this person was learned or changed (their profile name can now be fetched). */
  onProfileKey?(aci: string): void;
  /** The primary answered our KEYS request (a storage key is now stored): a Storage Service sync can run. */
  onStorageKey?(): void;
  /** The phone says its storage manifest changed (SyncMessage.FetchLatest STORAGE_MANIFEST). */
  onStorageManifestChanged?(): void;
}

const validTime = (t: unknown): t is number => typeof t === "number" && Number.isFinite(t) && t > 1e12 && t < 4e12; // epoch ms (not a counter)
export class Inbound {
  hooks: InboundHooks = {};
  constructor(
    private readonly accountId: string, private readonly store: SignalStore,
    private readonly emit: (e: CoreEvent) => void, private readonly provider = "signal",
  ) {}

  /** Display name for a peer: resolved contact name (nickname > address book > storage profile name), else learned profile name, else phone number, else short ACI. */
  displayName(aci: string): string {
    try { if (aci.toLowerCase() === this.ourAci.toLowerCase()) return "You"; } catch { /* not linked yet */ } // our own account is never shown by its id (a reply to my own message, a quote, a pin notice)
    const c = this.store.data.contacts[aci];
    return cleanName(c?.name) || cleanName(this.store.data.names[aci]) || cleanName(this.store.data.names[aci.toLowerCase()]) || c?.number || shortName(aci);
  }

  private get ourAci() { return this.store.requireAccount().aci; }

  chatRecordToChat(id: string): Chat {
    const c = this.store.data.chats[id] ?? { id, kind: "dm" as const };
    const self = c.kind === "dm" && c.id.toLowerCase() === this.ourAci.toLowerCase();
    return {
      id: c.id, accountId: this.accountId, provider: this.provider, kind: c.kind,
      name: self ? "Note to Self" : c.kind === "group" ? (c.name ?? "Signal group") : this.displayName(c.id),
      lastMessageAt: c.lastMessageAt, unread: c.unread,
      ...(c.expireTimer ? { disappearing: c.expireTimer } : {}),
      ...(c.kind === "dm" && this.aciOfPni(c.id) ? { sameAs: this.aciOfPni(c.id)! } : {}),
      ...(c.kind === "group" && c.description ? { description: c.description } : {}),
      ...this.flags(c),
    };
  }

  /** archived / muted / pinned / blocked as set in Signal (Storage Service); DMs keep them on the contact. */
  private flags(c: { id: string; kind: "dm" | "group" }): Partial<Chat> {
    const src = c.kind === "group" ? this.store.data.chats[c.id] : this.store.data.contacts[c.id.toLowerCase()];
    if (!src) return {};
    return {
      ...(src.archived ? { archived: true } : {}), ...(src.pinned ? { pinned: true } : {}),
      ...(src.mutedUntil && src.mutedUntil > Date.now() ? { muted: true } : {}),
      ...(c.kind === "dm" && ((src as { blocked?: boolean }).blocked || (src as { localBlocked?: boolean }).localBlocked) ? { blocked: true } : {}),
    };
  }

  /** The person's ACI when `id` is a known PNI whose ACI chat exists too (then the Hub folds both chats into one row, see Chat.sameAs). */
  private aciOfPni(id: string): string | undefined {
    const aci = this.store.data.pnis?.[id.toLowerCase()];
    return aci && aci !== id.toLowerCase() && this.store.data.chats[aci] ? aci : undefined;
  }

  /**
   * Remember that PNI `pniIn` and ACI `aciIn` are the same person. Only fed from sources that name both: storage contact records and a
   * PniSignatureMessage whose signature verified. NEVER from a phone number alone (a number can belong to another account later).
   * Creates the (empty) ACI chat when only the PNI chat exists, so the Hub can merge the pair. Returns true when something changed.
   */
  learnPni(pniIn: string, aciIn: string, source = "unknown"): boolean {
    const pni = String(pniIn).trim().toLowerCase().replace(/^pni:/, ""), aci = String(aciIn).toLowerCase(), ours = this.store.account;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!uuid.test(pni) || !uuid.test(aci) || pni === aci || (ours && (aci === ours.aci.toLowerCase() || pni === ours.aci.toLowerCase() || pni === ours.pni?.toLowerCase()))) return false;
    const map = (this.store.data.pnis ??= {});
    let changed = map[pni] !== aci;
    map[pni] = aci;
    if (this.store.data.chats[pni] && !this.store.data.chats[aci]) { this.store.upsertChat({ id: aci, kind: "dm" }); changed = true; }
    if (changed) {
      this.store.touch(); this.emit({ type: "chats-changed", data: {} });
      if (process.env.UNIMSG_DEBUG) console.debug(`[signal] pni link learned source=${source} links=${Object.keys(map).length} pniChat=${this.store.data.chats[pni] ? 1 : 0} aciChat=${this.store.data.chats[aci] ? 1 : 0}`); // counts only, never ids
    }
    return changed;
  }

  private static readonly E164 = /^\+[1-9]\d{5,14}$/;

  /**
   * The phone told us that PNI `pniIn` is the person with number `e164` (our own sent-message transcript / a storage record that holds a PNI
   * but no ACI yet). Remembered, and linked right away to a known contact (phone-supplied record) with that number.
   */
  notePniNumber(pniIn: string, e164: string, source: string): void {
    const pni = String(pniIn).trim().toLowerCase().replace(/^pni:/, "");
    if (!Inbound.E164.test(e164) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pni)) return;
    const ours = this.store.account; if (ours && (pni === ours.aci.toLowerCase() || pni === ours.pni?.toLowerCase())) return;
    const map = (this.store.data.pniNumbers ??= {});
    if (map[pni] !== e164) { map[pni] = e164; this.store.touch(); }
    for (const c of Object.values(this.store.data.contacts)) if (c.number === e164 && c.aci.toLowerCase() !== pni) this.learnPni(pni, c.aci, `${source}+contact-number`);
  }

  /**
   * A trusted source (server-signed sender certificate, phone's contact record / contact sync) says ACI `aci` has number `e164`. Links it to
   * every PNI chat the phone created for that same number. A number with no phone-created PNI chat links nothing.
   */
  linkByNumber(aci: string, e164: string | undefined | null, source: string): void {
    if (!e164) return;
    for (const [pni, num] of Object.entries(this.store.data.pniNumbers ?? {})) if (num === e164) this.learnPni(pni, aci, `${source}+number`);
  }

  /** PniSignatureMessage from `senderAci`: trusted only if the PNI identity key we hold for that PNI signed the sender's ACI identity key. */
  private pniSignature(m: NonNullable<Content["pniSignatureMessage"]>, senderAci: string): void {
    try {
      if (m.pni?.length !== 16 && m.pni?.length !== 17) return;
      const pni0 = serviceIdFromBinary(m.pni), pni = pni0 && stripPni(pni0); if (!pni || !m.signature?.length) return;
      const ids = this.store.data.identities, find = (id: string) => Object.entries(ids).find(([k]) => k.toLowerCase().startsWith(`${id.toLowerCase()}.`))?.[1];
      const pk = find(pni), ak = find(senderAci); if (!pk || !ak) return; // no identity key of that PNI known: nothing to verify against
      const ok = PublicKey.deserialize(Buffer.from(pk, "base64")).verifyAlternateIdentity(PublicKey.deserialize(Buffer.from(ak, "base64")), Buffer.from(m.signature));
      if (ok) this.learnPni(pni, senderAci, "pni-signature");
    } catch { /* malformed: ignore */ }
  }

  /** Group members as Contacts (names from contact/profile data where known). */
  groupMembers(chatId: string): { id: string; name: string; handle?: string }[] {
    const rec = this.store.data.chats[chatId];
    const ours = this.ourAci.toLowerCase();
    return (rec?.groupMembers ?? []).map((aci) => {
      const c = this.store.data.contacts[aci];
      return { id: aci, name: aci.toLowerCase() === ours ? "You" : this.displayName(aci), ...(c?.number ? { handle: c.number } : {}) };
    });
  }

  /** Resolve (and register) the chat a data message belongs to. */
  private chatFor(dm: DataMessage, peerAci: string): string {
    if (dm.groupV2?.masterKey && dm.groupV2.masterKey.length > 0) {
      const id = groupChatId(groupIdFromMasterKey(dm.groupV2.masterKey));
      if (!this.store.data.chats[id]) {
        this.store.upsertChat({ id, kind: "group", groupMasterKey: Buffer.from(dm.groupV2.masterKey).toString("base64") });
        this.emit({ type: "chats-changed", data: { chatId: id } });
      }
      this.hooks.onGroupSeen?.(id, dm.groupV2.revision);
      return id;
    }
    if (!this.store.data.chats[peerAci]) {
      this.store.upsertChat({ id: peerAci, kind: "dm" });
      this.emit({ type: "chats-changed", data: { chatId: peerAci } });
    }
    return peerAci;
  }

  async handle(d: Decrypted, envelopeTimestamp: number): Promise<void> {
    const c = d.content;
    const ours = this.ourAci;
    if (d.senderAci.toLowerCase() !== ours.toLowerCase() && (this.store.data.contacts[d.senderAci]?.blocked || this.store.data.contacts[d.senderAci]?.localBlocked)) return; // blocked on the phone / in UniChat
    if (d.senderE164 && d.senderAci.toLowerCase() !== ours.toLowerCase()) this.linkByNumber(d.senderAci, d.senderE164, "sender-cert");
    if (c.pniSignatureMessage && d.senderAci.toLowerCase() !== ours.toLowerCase()) this.pniSignature(c.pniSignatureMessage, d.senderAci);
    if (c.dataMessage) this.data(c.dataMessage, d.senderAci, d.senderAci, false, envelopeTimestamp);
    if (c.callMessage) this.callMessage(c.callMessage, d.senderAci, envelopeTimestamp);
    if (c.content && !KNOWN_CONTENT_FIELDS.has(c.content)) this.unsupported(c.content, d.senderAci, d.senderAci, envelopeTimestamp);
    if (c.editMessage) this.edit(c.editMessage, d.senderAci, d.senderAci, envelopeTimestamp);
    if (c.receiptMessage) this.receipt(c, d.senderAci, envelopeTimestamp);
    if (c.typingMessage) this.typing(c, d.senderAci);
    if (c.syncMessage) {
      // Sync messages are only trusted from our own account.
      if (d.senderAci.toLowerCase() !== ours.toLowerCase()) return;
      const sent = c.syncMessage.sent;
      if (sent) {
        const dest = stripPni(sent.destinationServiceId || serviceIdFromBinary(sent.destinationServiceIdBinary) || "");
        const ts = sent.timestamp ?? envelopeTimestamp;
        if (sent.message) this.data(sent.message, ours, dest, true, ts);
        else if (sent.editMessage) this.edit(sent.editMessage, ours, dest, ts);
        // after the chat exists, so a link to an already known ACI (same number) can create the ACI side and declare the pair
        if (sent.destinationE164 && /^pni:/i.test(sent.destinationServiceId || serviceIdFromBinary(sent.destinationServiceIdBinary) || "")) this.notePniNumber(dest, sent.destinationE164, "sent-transcript");
      }
      const sm = c.syncMessage;
      if (sm.contacts?.blob) this.hooks.onContactsBlob?.(this.toRef(sm.contacts.blob), !!sm.contacts.complete);
      if (sm.blocked) this.applyBlocked(sm.blocked);
      if (sm.configuration) {
        const acct = this.store.requireAccount();
        if (sm.configuration.readReceipts !== undefined) acct.readReceipts = sm.configuration.readReceipts;
        if (sm.configuration.typingIndicators !== undefined) acct.typingIndicators = sm.configuration.typingIndicators;
        if (sm.configuration.linkPreviews !== undefined) acct.linkPreviews = sm.configuration.linkPreviews;
        this.store.touch();
      }
      if (sm.callEvent) this.callEvent(sm.callEvent);
      if (sm.keys) this.applyKeys(sm.keys);
      if (sm.fetchLatest?.type === FetchLatestType.STORAGE_MANIFEST) this.hooks.onStorageManifestChanged?.();
      if (sm.read?.length) this.syncRead(sm.read);
      // sync.viewed: TODO (see README)
    }
  }

  /** The primary's answer to our KEYS request: derive and keep ONLY the storage key (never the pool / master key itself). */
  private applyKeys(k: NonNullable<NonNullable<Content["syncMessage"]>["keys"]>): void {
    const key = deriveStorageKey({ accountEntropyPool: k.accountEntropyPool || undefined, master: k.master });
    if (!key) { if (process.env.UNIMSG_DEBUG) process.stderr.write("[signal] storage: keys message without a usable key\n"); return; }
    const st = this.store.data.storage;
    const changed = st.key !== key.toString("base64");
    st.key = key.toString("base64"); this.store.touch();
    if (process.env.UNIMSG_DEBUG) process.stderr.write(`[signal] storage: keys received (${k.accountEntropyPool ? "aep" : "master"})${changed ? "" : " unchanged"}\n`);
    this.hooks.onStorageKey?.();
  }

  private data(dm: DataMessage, author: string, peer: string, fromMe: boolean, ts: number): void {
    const timestamp = dm.timestamp ?? ts;
    const hasGroup = !!dm.groupV2?.masterKey?.length;
    if (!hasGroup && !peer) return; // own sync without a destination: cannot route
    if (hasGroup && !fromMe) {
      const gid = groupChatId(groupIdFromMasterKey(dm.groupV2!.masterKey!));
      if (this.store.data.chats[gid]?.blocked) return; // group blocked on the phone
    }
    const chatId = this.chatFor(dm, peer);
    const ourMsgId = (a: string, t: number) => messageId(a, t);
    // Profile keys arrive with the sender's messages: needed for their sealed-sender access key and group credentials.
    if (!fromMe && dm.profileKey?.length === 32 && author.toLowerCase() !== this.ourAci.toLowerCase()) this.learnProfileKey(author, dm.profileKey);

    if (dm.adminDelete?.targetSentTimestamp !== undefined) {
      const victim = serviceIdFromBinary(dm.adminDelete.targetAuthorAciBinary);
      if (victim) this.emit({ type: "message-update", data: { chatId, messageId: ourMsgId(victim, dm.adminDelete.targetSentTimestamp), patch: { deleted: true } } });
      return;
    }
    if (dm.pinMessage || dm.unpinMessage) {
      const pm = dm.pinMessage ?? dm.unpinMessage!, victim = serviceIdFromBinary(pm.targetAuthorAciBinary);
      if (victim && pm.targetSentTimestamp !== undefined) { // mark / unmark the target (the notice below stays as the visible trace)
        const sec = dm.pinMessage?.pinDurationSeconds;
        this.emit({ type: "message-update", data: { chatId, messageId: ourMsgId(victim, pm.targetSentTimestamp), patch: dm.pinMessage
          ? { pinned: true, pinnedAt: new Date(timestamp).toISOString(), pinnedBy: author, ...(sec && !dm.pinMessage.pinDurationForever ? { pinnedUntil: new Date(timestamp + sec * 1000).toISOString() } : {}) }
          : { pinned: false } } });
      }
      this.info(chatId, ourMsgId(author, timestamp), `${fromMe ? "You" : this.displayName(author)} ${dm.pinMessage ? "pinned" : "unpinned"} a message`, timestamp, author, fromMe);
      return;
    }
    if (dm.flags && (dm.flags & DataMessageFlags.EXPIRATION_TIMER_UPDATE)) {
      this.noteTimer(chatId, dm.expireTimer);
      this.info(chatId, ourMsgId(author, timestamp), timerNotice(dm.expireTimer), timestamp, author, fromMe);
      return;
    }
    const nameOf = (a: string) => (a.toLowerCase() === this.ourAci.toLowerCase() ? "You" : this.displayName(a));
    const storyAuthor = dm.storyContext && (dm.storyContext.authorAci || serviceIdFromBinary(dm.storyContext.authorAciBinary));
    const story = dm.storyContext ? renderStoryReply(dm, storyAuthor ? nameOf(storyAuthor) : "a contact") : undefined;
    const reactionTarget = !story && dm.reaction && (dm.reaction.targetAuthorAci || serviceIdFromBinary(dm.reaction.targetAuthorAciBinary));
    if (!story && dm.reaction && reactionTarget && dm.reaction.targetSentTimestamp !== undefined) {
      const target = ourMsgId(reactionTarget, dm.reaction.targetSentTimestamp);
      this.applyReaction(chatId, target, author, dm.reaction.emoji ?? "", !!dm.reaction.remove);
      return;
    }
    if (dm.pollVote?.targetSentTimestamp !== undefined) {
      const pollAuthor = serviceIdFromBinary(dm.pollVote.targetAuthorAciBinary);
      if (!pollAuthor || hasGroup) return; // group polls: not supported yet
      const target = ourMsgId(pollAuthor, dm.pollVote.targetSentTimestamp);
      if (applyVote(this.store, target, author, dm.pollVote.optionIndexes ?? [], dm.pollVote.voteCount ?? 0)) this.pollUpdated(chatId, target);
      return;
    }
    if (dm.pollTerminate?.targetSentTimestamp !== undefined) {
      const target = ourMsgId(author, dm.pollTerminate.targetSentTimestamp);
      if (!hasGroup && terminatePoll(this.store, target, author)) this.pollUpdated(chatId, target);
      return;
    }
    if (dm.delete?.targetSentTimestamp !== undefined) {
      this.emit({ type: "message-update", data: { chatId, messageId: ourMsgId(author, dm.delete.targetSentTimestamp), patch: { deleted: true } } });
      return;
    }
    const msgId = ourMsgId(author, timestamp);
    if (dm.body || dm.attachments?.length) this.noteTimer(chatId, dm.expireTimer); // every real message carries the chat's current timer
    const attachments = (dm.attachments ?? []).map((a, i) => this.attachment(a, `${msgId}#${i}`, !!dm.isViewOnce));
    if (dm.sticker?.data) attachments.push({ ...this.attachment(dm.sticker.data, `${msgId}#sticker`, false), kind: "sticker" });
    const contacts = (dm.contact ?? []).map((k): SharedContact => ({
      name: [k.name?.givenName, k.name?.familyName].filter(Boolean).join(" ") || k.name?.nickname || k.organization || "Contact",
      phones: k.number?.map((n) => n.value).filter((v): v is string => !!v),
      emails: k.email?.map((n) => n.value).filter((v): v is string => !!v),
    }));
    let text = renderMentions(dm.body ?? "", dm.bodyRanges, nameOf);
    let card: Card | undefined;
    if (dm.sticker?.data && !text) text = dm.sticker.emoji ? `Sticker ${dm.sticker.emoji}` : "Sticker";
    if (dm.isViewOnce && !text) text = "[View-once media - open it in Signal on your phone]";
    if (story) { card = story.card; if (!text) text = story.text; }
    const extras = renderDataExtras(dm, nameOf, new Date(timestamp).toISOString());
    if (extras) { card ??= extras.card; if (!text) text = extras.text; }
    card ??= renderPreview(dm);
    const pv = dm.preview?.find((x) => x.url);
    if (card && card.kind === "link" && !card.image && pv?.image?.key?.length === 64 && (pv.image.cdnKey || pv.image.cdnId)) {
      const aid = `${msgId}#preview`;
      this.store.rememberAttachment(aid, this.toRef(pv.image));
      card = { ...card, image: { attachmentId: aid, ...(pv.image.width ? { width: pv.image.width } : {}), ...(pv.image.height ? { height: pv.image.height } : {}) } };
    }
    const unknown = unsupportedFields(dm, KNOWN_DATA_FIELDS);
    for (const f of unknown) this.noteUnsupported(f);
    const pollRec = dm.pollCreate && !hasGroup ? registerPoll(this.store, msgId, dm.pollCreate) : undefined;
    if (!text && attachments.length === 0 && contacts.length === 0 && !pollRec && !card) {
      if (unknown.length === 0) return; // flags-only (profile-key update / session reset): nothing to show
      text = `[unsupported message: ${unknown[0]}]`;
      card = { kind: "other", title: unknown[0]! };
    }

    const quoteAuthor = dm.quote && (dm.quote.authorAci || serviceIdFromBinary(dm.quote.authorAciBinary));
    const m: Message = {
      id: msgId, chatId, sender: fromMe ? "Me" : this.displayName(author),
      senderId: author, text, time: new Date(timestamp).toISOString(), fromMe,
      ...(attachments.length ? { attachments } : {}),
      ...(contacts.length ? { contacts } : {}),
      ...(card ? { card } : {}),
      ...(pollRec ? { poll: pollView(this.store, msgId, this.ourAci) } : {}),
      ...(dm.flags && (dm.flags & DataMessageFlags.FORWARD) ? { forwarded: true } : {}),
      ...(dm.expireTimer ? { expiresIn: dm.expireTimer } : {}),
      ...(dm.isViewOnce ? { viewOnce: true } : {}),
      ...(quoteAuthor && dm.quote?.id !== undefined ? {
        replyTo: { messageId: ourMsgId(quoteAuthor, dm.quote.id), sender: this.displayName(quoteAuthor), textPreview: dm.quote.text },
      } : {}),
      ...(fromMe ? { status: "sent" as const } : {}),
    };
    if (fromMe) this.store.indexSent(m.id, chatId);
    const rec = this.store.data.chats[chatId]!;
    rec.lastMessageAt = m.time;
    if (!fromMe) { rec.unread = (rec.unread ?? 0) + 1; this.store.noteUnread(chatId, m.id); }
    this.store.touch();
    this.emit({ type: "message", data: m });
    if (fromMe) this.replayReceipts(m.id); // a receipt that overtook the sync transcript
  }

  /** Disappearing-messages timer seen on a message / update (seconds, 0 = off). We only record it; nothing is ever deleted here. */
  private noteTimer(chatId: string, seconds: number | undefined): void {
    const rec = this.store.data.chats[chatId];
    if (!rec) return;
    const v = seconds ?? 0;
    if (rec.expireTimer !== v) { rec.expireTimer = v; this.store.touch(); }
  }

  private learnProfileKey(aci: string, key: Uint8Array): void {
    const id = aci.toLowerCase();
    const b64 = Buffer.from(key).toString("base64");
    const c = (this.store.data.contacts[id] ??= { aci: id });
    if (c.profileKey !== b64) { c.profileKey = b64; delete c.sealedRejectedAt; delete c.unrestricted; delete c.profileNameCheckedAt; this.store.touch(); this.hooks.onProfileKey?.(id); }
  }

  private edit(e: NonNullable<Content["editMessage"]>, author: string, peer: string, ts: number): void {
    if (e.targetSentTimestamp === undefined || !e.dataMessage) return;
    const chatId = this.chatFor(e.dataMessage, peer);
    this.emit({ type: "message-update", data: {
      chatId, messageId: messageId(author, e.targetSentTimestamp),
      patch: { text: renderMentions(e.dataMessage.body ?? "", e.dataMessage.bodyRanges, (a) => this.displayName(a)), editedAt: new Date(e.dataMessage.timestamp ?? ts).toISOString() },
    } });
  }

  private pollUpdated(chatId: string, msgId: string): void {
    const poll = pollView(this.store, msgId, this.ourAci);
    if (poll) this.emit({ type: "message-update", data: { chatId, messageId: msgId, patch: { poll } } });
  }

  /** Called by the client after it applied/sent a vote locally. */
  emitPollUpdate(chatId: string, msgId: string): void { this.pollUpdated(chatId, msgId); }

  uiReactions(msgId: string): UiReaction[] {
    const r = this.store.data.reactions[msgId] ?? {};
    const ours = this.ourAci;
    return Object.entries(r).map(([emoji, senderIds]) => ({ emoji, senderIds: [...senderIds], mine: senderIds.includes(ours) }));
  }

  applyReaction(chatId: string, msgId: string, sender: string, emoji: string, remove: boolean): void {
    const all = this.store.data.reactions;
    const per = (all[msgId] ??= {});
    // one reaction per sender per message: drop previous emoji of this sender first
    for (const [e, ids] of Object.entries(per)) {
      per[e] = ids.filter((s) => s !== sender);
      if (per[e]!.length === 0) delete per[e];
    }
    if (!remove && emoji) (per[emoji] ??= []).push(sender);
    if (Object.keys(per).length === 0) delete all[msgId];
    this.store.touch();
    this.emit({ type: "message-update", data: { chatId, messageId: msgId, patch: { reactions: this.uiReactions(msgId) } } });
  }

  /** One recipient's receipt (also in groups: every member answers the fan-out copy it got). The envelope timestamp is when THEY sent it; VIEWED (view-once opened) counts as read. */
  private receipt(c: Content, sender: string, at: number): void {
    const r = c.receiptMessage!;
    if (sender.toLowerCase() === this.ourAci.toLowerCase()) return; // never a receipt about my own devices
    // proto2 default of ReceiptMessage.type is DELIVERY: an absent type is a delivery receipt, not a read receipt
    const status = r.type === undefined || r.type === ReceiptType.DELIVERY ? "delivered" : "read";
    for (const ts of r.timestamp ?? []) this.applyReceipt(messageId(this.ourAci, ts), status, sender, at);
  }

  /** Route a receipt to the sent message. Receipts for messages not (yet) known, or still being sent, are kept and replayed when the message shows up. */
  private applyReceipt(id: string, status: "delivered" | "read", by: string, at?: number): void {
    const chatId = this.store.data.sentIndex[id];
    if (!chatId || this.held.has(id)) {
      const list = this.earlyReceipts.get(id) ?? [];
      list.push({ status, by, at, seen: Date.now() });
      this.earlyReceipts.set(id, list.slice(-50));
      for (const k of this.earlyReceipts.keys()) { if (this.earlyReceipts.size <= 500) break; this.earlyReceipts.delete(k); }
      return;
    }
    this.emit({ type: "receipt", data: { chatId, messageId: id, status, by, ...(validTime(at) ? { at: new Date(at).toISOString() } : {}) } });
  }
  private earlyReceipts = new Map<string, { status: "delivered" | "read"; by: string; at?: number; seen: number }[]>();
  private held = new Set<string>();

  private replayReceipts(id: string): void {
    const list = this.earlyReceipts.get(id);
    if (!list || this.held.has(id)) return;
    this.earlyReceipts.delete(id);
    for (const r of list) if (Date.now() - r.seen < 24 * 3600_000) this.applyReceipt(id, r.status, r.by, r.at);
  }

  /** A message of ours is being sent: index it now and hold receipts for it until the Hub has the message (see releaseSent). */
  holdSent(id: string, chatId: string): void { this.store.indexSent(id, chatId); this.held.add(id); }
  /** The send failed: forget it. */
  abortSent(id: string): void { this.held.delete(id); this.earlyReceipts.delete(id); delete this.store.data.sentIndex[id]; this.store.touch(); }
  /** The send succeeded and the caller is about to get the Message: deliver receipts that raced ahead of it shortly after. */
  releaseSent(id: string): void {
    const t = setTimeout(() => { this.held.delete(id); this.replayReceipts(id); }, this.releaseDelayMs);
    t.unref?.();
  }
  releaseDelayMs = 150;

  /** Server-generated delivery receipt (envelope type 5, unsealed senders only). */
  serverDeliveryReceipt(fromAci: string, originalTimestamp: number, at?: number): void {
    this.applyReceipt(messageId(this.ourAci, originalTimestamp), "delivered", fromAci, at);
  }

  /** SyncMessage.Read: another device of ours read these incoming messages. Clears them from the unread count of their chats. */
  private syncRead(list: NonNullable<NonNullable<Content["syncMessage"]>["read"]>): void {
    const changed = new Set<string>();
    for (const r of list) {
      const sender = r.senderAci || serviceIdFromBinary(r.senderAciBinary);
      if (!sender || r.timestamp === undefined) continue;
      const chatId = this.store.dropUnread(messageId(sender, r.timestamp));
      const rec = chatId ? this.store.data.chats[chatId] : undefined;
      if (!chatId || !rec) continue;
      rec.unread = Math.max(0, (rec.unread ?? 0) - 1); changed.add(chatId);
    }
    if (changed.size) { this.store.touch(); for (const chatId of changed) this.emit({ type: "chats-changed", data: { chatId } }); }
  }

  private typing(c: Content, sender: string): void {
    if (this.store.requireAccount().typingIndicators === false) return; // user turned typing indicators off
    const t = c.typingMessage!;
    const chatId = t.groupId && t.groupId.length ? groupChatId(t.groupId) : sender;
    if (isGroupChatId(chatId) && !this.store.data.chats[chatId]) return; // unknown group
    this.emit({ type: "typing", data: { chatId, senderId: sender, typing: t.action === TypingAction.STARTED } });
  }

  // ---------- notices, calls, unsupported ----------
  private unsupportedCounts: Record<string, number> = {};
  private noteUnsupported(field: string): void {
    const n = (this.unsupportedCounts[field] = (this.unsupportedCounts[field] ?? 0) + 1);
    console.debug(`[signal] unsupported content field=${field} count=${n}`); // counts only, never content
  }

  private push(m: Message): void {
    const rec = this.store.data.chats[m.chatId];
    if (rec) { rec.lastMessageAt = m.time; if (!m.fromMe && !m.system) rec.unread = (rec.unread ?? 0) + 1; this.store.touch(); }
    this.emit({ type: "message", data: m });
  }

  /** Network notice shown inline in the chat (message.system.kind = "info"). */
  private info(chatId: string, id: string, text: string, ts: number, author: string, fromMe: boolean): void {
    this.push({ id, chatId, sender: fromMe ? "Me" : this.displayName(author), senderId: author, text, time: new Date(ts).toISOString(), fromMe, system: { kind: "info" } });
  }

  /** Identity key of a peer changed (reported by the identity store). */
  safetyNumberChanged(address: string): void {
    const aci = address.slice(0, address.lastIndexOf(".")).toLowerCase();
    if (!aci || aci === this.ourAci.toLowerCase()) return;
    if (!this.store.data.chats[aci]) { this.store.upsertChat({ id: aci, kind: "dm" }); this.emit({ type: "chats-changed", data: { chatId: aci } }); }
    this.info(aci, `safety.${aci}.${Date.now()}`, `Your safety number with ${this.displayName(aci)} has changed.`, Date.now(), aci, false);
  }

  private callMessage(c: NonNullable<Content["callMessage"]>, peer: string, ts: number): void {
    const r = renderCallMessage(c, new Date(ts).toISOString());
    if (!r) return;
    const chatId = this.chatFor({}, peer);
    this.push({ id: messageId(peer, ts), chatId, sender: this.displayName(peer), senderId: peer, text: r.text, time: new Date(ts).toISOString(), fromMe: false, card: r.card });
  }

  private callEvent(e: NonNullable<NonNullable<Content["syncMessage"]>["callEvent"]>): void {
    const r = renderCallEvent(e);
    if (!r || !e.conversationId || e.timestamp === undefined) return;
    const ours = this.ourAci;
    let chatId: string | undefined, peer: string | undefined;
    if (e.conversationId.length === 16) { peer = serviceIdFromBinary(e.conversationId); chatId = peer; }
    else if (e.conversationId.length === 32) { chatId = groupChatId(e.conversationId); if (!this.store.data.chats[chatId]) return; }
    if (!chatId) return;
    if (!this.store.data.chats[chatId]) { this.store.upsertChat({ id: chatId, kind: "dm" }); this.emit({ type: "chats-changed", data: { chatId } }); }
    const author = r.incoming && peer ? peer : ours;
    this.push({
      id: `${author}.${e.timestamp}`, chatId, sender: author === ours ? "Me" : this.displayName(author), senderId: author, text: r.text,
      time: new Date(e.timestamp).toISOString(), fromMe: author === ours, card: r.card, system: { kind: "info" },
    });
  }

  private unsupported(field: string, author: string, peer: string, ts: number): void {
    this.noteUnsupported(field);
    const chatId = this.chatFor({}, peer);
    this.push({
      id: messageId(author, ts), chatId, sender: this.displayName(author), senderId: author, text: `[unsupported message: ${field}]`,
      time: new Date(ts).toISOString(), fromMe: false, card: { kind: "other", title: field },
    });
  }

  toRef(a: AttachmentPointer): AttachmentRef {
    return {
      cdnNumber: a.cdnNumber, cdnKey: a.cdnKey || undefined, cdnId: a.cdnId || undefined,
      key: Buffer.from(a.key ?? new Uint8Array()).toString("base64"),
      digest: a.digest?.length ? Buffer.from(a.digest).toString("base64") : undefined,
      size: a.size, contentType: a.contentType, fileName: a.fileName,
    };
  }

  private attachment(a: AttachmentPointer, id: string, viewOnce: boolean): Attachment {
    const mime = a.contentType || "application/octet-stream";
    // View-once media is deliberately not downloadable here: the sender asked for it to be seen once, on the phone.
    if (!viewOnce && a.key?.length === 64 && (a.cdnKey || a.cdnId)) this.store.rememberAttachment(id, this.toRef(a));
    // AttachmentPointer.Flags.GIF = 8: an animated GIF delivered as a (muted, looping) mp4 or as image/gif
    const gif = !!(a.flags && (a.flags & 8)) && (mime === "image/gif" || mime.startsWith("video/"));
    return { id, kind: kindOfAttachment(mime, a.flags), mime, name: a.fileName, size: a.size, width: a.width, height: a.height, ...(gif ? { gif: true } : {}) };
  }

  private applyBlocked(b: NonNullable<NonNullable<Content["syncMessage"]>["blocked"]>): void {
    const ids = new Set<string>((b.acis ?? []).map((x) => x.toLowerCase()));
    for (const bin of [...(b.acisBinary ?? []), ...(b.blockedAcis ?? []).map((x) => x.aciBinary).filter((x): x is Uint8Array => !!x)]) {
      if (bin.length === 16) ids.add(Aci.fromUuidBytes(Uint8Array.from(bin)).getRawUuid());
    }
    for (const c of Object.values(this.store.data.contacts)) c.blocked = ids.has(c.aci);
    for (const id of ids) if (!this.store.data.contacts[id]) this.store.data.contacts[id] = { aci: id, blocked: true };
    this.store.touch();
  }
}
