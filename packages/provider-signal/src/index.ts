// Signal provider (unofficial client): linked secondary device built on @signalapp/libsignal-client's
// native transport (Net) + protocol primitives, with the service layer implemented in ./service.
// Layout:  protocol/  wire formats (protobuf, padding, device-name crypto)
//          store/     sealed-at-rest persistence + libsignal store implementations
//          service/   linking, receive loop, decrypt, inbound mapping, sender, prekeys
// See README.md for design, limitations and TODOs.
import { NO_CAPABILITIES } from "@unimsg/core";
import type { Capabilities, Chat, Connector, Contact, CoreEvent, HistoryQuery, Message, OutgoingMessage, ProfilePatch, ProviderFactory, Space } from "@unimsg/core";
import { SignalClient } from "./service/client.js";
import { isGroupChatId } from "./service/groups.js";
import type { KeyProvider } from "./store/secureFile.js";

export type { KeyProvider } from "./store/secureFile.js";

/** What is truthfully implemented today: 1:1 chats and Groups v2 text/replies/reactions/edits/deletes/typing by fan-out (see README); attachments + voice notes (upload via CDN, 1:1 and groups), polls only 1:1. */
export const capabilities: Capabilities = {
  ...NO_CAPABILITIES,
  reactions: true, pinMessages: true, pinDurations: [86400, 604800, 2592000, 0 /* until removed */], edits: true, deletes: true, replies: true, typing: true, readReceipts: true, receiptDetails: true,
  contactCards: true, mentions: true, block: true, disappearing: true, disappearingDurations: [30, 300, 3600, 28800, 86400, 604800, 2419200], createGroup: true, manageMembers: true, renameChat: true, chatDescription: true, chatPicture: true, leaveChat: true, e2ee: true, startChat: true, sync: true, polls: true, attachments: true, voiceNotes: true, privacy: true, avatars: true, profile: { displayName: true, about: true, avatar: true },
  presence: false, // Signal has no presence (online / last seen) at all
  // location, backfill, spaces: false (not implemented / not offered by Signal)
};

class SignalConnector implements Connector {
  readonly capabilities = capabilities;
  private readonly client: SignalClient;
  constructor(private readonly accountId: string, dataDir: string, keyProvider?: KeyProvider) {
    this.client = new SignalClient({ accountId, dataDir, keyProvider });
  }

  start(emit: (e: CoreEvent) => void) { return this.client.start(emit); }
  stop() { return this.client.stop(); }
  logout() { return this.client.logout(); }
  async submitLogin(): Promise<void> {
    throw new Error("Signal uses QR linking; there is no form to submit");
  }

  async spaces(): Promise<Space[]> { return []; }
  async chats(): Promise<Chat[]> { return this.client.chats(); }

  /** Signal has no server-side history and this provider keeps no message log (the Hub does). */
  async history(_chatId: string, _q: HistoryQuery): Promise<Message[]> { return []; }

  currentNameOf(senderId: string): string | undefined { return this.client.nameOf(senderId); }

  async members(chatId: string): Promise<Contact[]> {
    if (isGroupChatId(chatId)) return this.client.members(chatId); // empty until the group state resolved
    const c = this.client.store.data?.contacts[chatId];
    return [{ id: chatId, name: c?.name || this.client.store.data?.names[chatId.toLowerCase()] || c?.number || chatId.slice(0, 8), handle: c?.number }];
  }

  avatar(target: { kind: "chat" | "space" | "contact" | "emoji"; id: string; full?: boolean }) { return this.client.avatar(target); }

  async downloadAttachment(_chatId: string, _messageId: string, attachmentId: string) {
    return this.client.downloadAttachment(attachmentId);
  }

  /** Signal history import (core signalimport/): who this account is, and phone number -> ACI for contacts we know. Read-only. */
  importIdentity() {
    const a = this.client.store.account; if (!a) return undefined;
    const contacts = this.client.store.data?.contacts ?? {};
    return { aci: a.aci, numberToAci: (n: string) => Object.values(contacts).find((c) => c.number === n)?.aci };
  }

  importContacts(list: { aci: string; profileKey?: string; name?: string; e164?: string; pni?: string }[]) { return this.client.importBackupContacts(list); }

  sync() { return this.client.sync(); }
  getProfile() { return this.client.getProfile(); }
  updateProfile(patch: ProfilePatch) { return this.client.updateProfile(patch); }
  async getPrivacy() { return this.client.getPrivacy(); }
  setPrivacy(id: string, value: string) { return this.client.setPrivacy(id, value); }
  vote(chatId: string, messageId: string, optionIds: string[]) { return this.client.vote(chatId, messageId, optionIds); }
  startChat(handle: string) { return this.client.startChat(handle); }
  blockChat(chatId: string, blocked: boolean) { return this.client.blockChat(chatId, blocked); }
  setDisappearing(chatId: string, seconds: number) { return this.client.setDisappearing(chatId, seconds); }

  send(chatId: string, msg: OutgoingMessage) { return this.client.send(chatId, msg); }
  react(chatId: string, messageId: string, emoji: string | null) { return this.client.react(chatId, messageId, emoji); }
  pin(chatId: string, messageId: string, pinned: boolean, opts?: { durationSec?: number }) { return this.client.pin(chatId, messageId, pinned, opts); }
  edit(chatId: string, messageId: string, newText: string) { return this.client.edit(chatId, messageId, newText); }
  delete(chatId: string, messageId: string) { return this.client.delete(chatId, messageId); }
  setTyping(chatId: string, typing: boolean) { return this.client.setTyping(chatId, typing); }
  markRead(chatId: string, upToMessageId: string) { return this.client.markRead(chatId, upToMessageId); }
  createGroup(name: string, memberHandles: string[]) { return this.client.createGroup(name, memberHandles); }
  addMembers(chatId: string, memberHandles: string[]) { return this.client.addMembers(chatId, memberHandles); }
  removeMember(chatId: string, memberId: string) { return this.client.removeMember(chatId, memberId); }
  renameChat(chatId: string, name: string) { return this.client.renameChat(chatId, name); }
  setChatDescription(chatId: string, text: string) { return this.client.setChatDescription(chatId, text); }
  setChatPicture(chatId: string, image: { data: Uint8Array; mime: string } | null) { return this.client.setChatPicture(chatId, image); }
  leaveChat(chatId: string) { return this.client.leaveChat(chatId); }
}

const factory: ProviderFactory & { createWithKeyProvider(opts: { accountId: string; dataDir: string; keyProvider: KeyProvider }): Connector } = {
  name: "signal",
  displayName: "Signal",
  login: "qr",
  capabilities,
  create: ({ accountId, dataDir }) => new SignalConnector(accountId, dataDir),
  /** Same as create() but keeps the store key outside dataDir (Electron safeStorage, Android Keystore...). */
  createWithKeyProvider: ({ accountId, dataDir, keyProvider }) => new SignalConnector(accountId, dataDir, keyProvider),
};
export default factory;
