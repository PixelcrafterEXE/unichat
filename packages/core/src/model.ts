// Provider-neutral data types shared by core, providers and UI.
// IDs: providers use NATIVE ids; the Hub namespaces them as "<accountId>:<native>".
// Timestamps are ISO-8601 strings (UTC) so they survive JSON/IPC unchanged.
import type { Capabilities } from "./provider.js";

export type ChatKind = "dm" | "group" | "channel";

/** A "community"/"server"/"team"/"room-space": an entry in the UI's left tab bar. DMs have no space. */
export interface Space {
  id: string; accountId: string; provider: string; name: string; iconUrl?: string; /** like Chat.avatarRev */ avatarRev?: string; originalName?: string; muted?: boolean; archived?: boolean;
  /** A user-made local folder (id "folder:<uuid>", provider "folder", accountId ""). Nothing about it exists on any network. */
  local?: boolean; color?: string; icon?: string;
  /** Network community that effectively holds a single chat: the UI gives it no rail entry, its chat is listed under Personal (`Chat.collapsedFrom`). */
  collapsed?: boolean;
}
/** A user-made folder as stored. Folders and network communities share the left rail; any chat can be moved into either. */
export interface Folder { id: string; name: string; color?: string; icon?: string }
export const isFolderId = (id: string) => id.startsWith("folder:");
/** `folderId` of a chat that was moved to Personal on purpose (a chat without override follows its network community). */
export const PERSONAL = "personal";

export interface Chat {
  id: string; accountId: string; provider: string;
  spaceId?: string;             // EFFECTIVE folder: set => shown inside that space/folder (user moves applied, single-chat communities collapsed)
  networkSpaceId?: string;      // the space the network itself put this chat into (kept when the user moved it; "Reset to original place")
  folderId?: string;            // the user's local override: "personal" or a space / folder id (absent = follow the network)
  collapsedFrom?: string;       // the single-chat community this chat belongs to but is shown without (see Space.collapsed)
  kind: ChatKind;
  name: string;                 // display name (a user alias wins over the provider's name)
  originalName?: string;        // provider-supplied name when an alias overrides it
  avatarUrl?: string;
  /** Opaque provider hint that changes whenever this chat's picture does (a URL, hash, timestamp ...): the Hub refreshes a stored picture whose hint differs. */
  avatarRev?: string;
  unread?: number;
  /** DM only, derived by the Hub from presence events (Capabilities.presence): the other person is online right now. Absent = unknown. */
  online?: boolean;
  /** DM only: ISO time the other person was last seen (when known). */
  lastSeen?: string;
  lastMessageAt?: string;       // for sorting
  preview?: string;             // last message text/summary for the chat list
  description?: string;         // group/channel topic
  /** Grouping label INSIDE a community/space (Discord channel category, a Mattermost sidebar category ...). The UI lists chats with a category under collapsible headings; chats without one stay on top. */
  category?: string;
  /** The user's own category (local, see categories.ts) this chat is listed under; then `category` is its name. Absent: the provider's category (or none). */
  categoryId?: string;
  /** The provider's original category when the user's override changed or hid `category` (UI: "Provider category: X"). */
  providerCategory?: string;
  /** `false`: group management (add/remove members, rename, picture) is impossible for THIS chat although the account's capabilities allow it for others (e.g. a Discord server channel vs a group DM). Absent = follows the capabilities. */
  canManage?: boolean;
  /** A pending message request (Instagram): the other side wrote first and you have not accepted yet. Needs Capabilities.requests; Connector.acceptRequest/declineRequest answer it, replying also accepts. */
  request?: boolean;
  /** `unread` is only an approximation (0 or 1 = "something new", no real count): the UI shows a dot instead of a number. */
  unreadApprox?: boolean;
  /** Returned by startChat when the network creates the conversation only with the first message. `id` is a placeholder the connector accepts in send(); the message returned by send() carries the REAL chatId and the Hub re-keys the chat (event "chat-resolved"). */
  provisional?: boolean;
  muted?: boolean;
  pinned?: boolean;             // user flags (stored in the backend, apply on every device)
  archived?: boolean;
  unreadMark?: boolean;
  starred?: boolean;            // prioritized by the user: notifications of their own (Android channel "Starred chats"; desktop: "only starred" mode)         // user marked the chat unread by hand (shows as an unread dot until opened / marked read)
  blocked?: boolean;            // 1:1 chat with a blocked contact
  /** Disappearing-messages timer of the chat in seconds (absent / 0 = off). Needs Capabilities.disappearing to be changeable. */
  disappearing?: number;
  offline?: "signed-out" | "needs-login"; // the account is not connected: this chat is a read-only archive
  readOnly?: boolean;           // e.g. announcement channels
  /**
   * Provider-neutral duplicate hint: this chat is known to be the same conversation as chat `sameAs` of the same account (native id in a
   * connector, global id in the Hub), e.g. Signal's PNI chat vs the ACI chat of the same person. The Hub folds the pair into ONE row
   * (an auto merge; the `sameAs` target is primary and the default send target).
   */
  sameAs?: string;
  /** Member chat of a merge: the Hub hides it behind the merged row (`mergedInto` = that row's id). */
  mergedInto?: string;
  /** Only on a merged row (provider "merged", id "merge:<uuid>"): the member chat ids, primary first. */
  mergeMembers?: string[];
  mergeSendVia?: string;        // merged row: the member the user chose to send through (absent = follow the newest message)
  mergeLastVia?: string;        // merged row: the member holding the newest message
}

/**
 * A local-only merge of several 1:1 chats (same person on different accounts/apps) into one chat with one timeline.
 * Nothing is sent to the networks and no message is copied: messages keep their real `chatId`; the merge id is only a view key.
 */
export interface ChatMerge { id: string; name?: string; members: string[]; primary: string; sendVia?: string; createdAt: string;
  /** created by the Hub itself from a provider's `Chat.sameAs` (id "merge:auto:<hash of the pair>"); unmerging it keeps the record as `dismissed` so it is not re-created */
  auto?: boolean;
  /** an auto merge the user unmerged: tombstone (replicates through sync), never active */
  dismissed?: boolean }
export const isMergeId = (id: string) => id.startsWith("merge:");

export interface Contact { id: string; name: string; avatarUrl?: string; /** like Chat.avatarRev */ avatarRev?: string; handle?: string /* phone, @user:server, ... */;
  /** Presence (Capabilities.presence): live, never archived. `lastSeen` is an ISO time when the network tells it. */
  online?: boolean; lastSeen?: string }

export type AttachmentKind = "image" | "video" | "audio" | "voice" | "file" | "sticker";
export interface Attachment {
  id: string;                   // opaque provider handle, passed back to downloadAttachment()
  kind: AttachmentKind;
  mime: string;
  name?: string;
  size?: number;
  width?: number; height?: number; durationMs?: number;
  thumbnailDataUrl?: string;    // small inline preview, optional
  waveform?: number[];          // voice notes: ~64 bar heights, 0-100, for the player
  gif?: boolean;                // an animated GIF delivered as a (muted, looping) video: the UI plays it inline
}

export interface Reaction {
  emoji: string; senderIds: string[]; mine?: boolean /* I reacted with this emoji */;
  /** Total number of reactors when `senderIds` is incomplete (the network only reports a count). The UI shows `count ?? senderIds.length`; `senderIds` then lists only the known ones. */
  count?: number;
}

/** A poll in a message. `voters` are sender ids (same id space as Message.senderId); `mine` = option ids I voted for. */
export interface Poll {
  question: string;
  options: { id: string; text: string; voters: string[]; /** total votes when `voters` is incomplete (UI: `count ?? voters.length`) */ count?: number }[];
  multiple: boolean;   // may pick several options
  closed?: boolean;
  mine?: string[];
}

/**
 * Rich content that is not text/media/location/poll/contact: events, group invites, calls, products, lists, buttons, ...
 * Providers fill what the network gives them; the UI renders one generic card. `Message.text` should still carry a short
 * plain-text summary (used for previews, search and as the fallback).
 */
export interface Card {
  /** Preview image. Loaded through the normal attachment path (`attachment` call with chatId, messageId and `image.attachmentId`), so the UI never hot-links remote hosts. The id need NOT be listed in Message.attachments: the connector's downloadAttachment() just has to resolve it. */
  image?: CardImage;
  kind: "event" | "invite" | "call" | "product" | "order" | "list" | "buttons" | "template" | "link" | "payment" | "other";
  title: string;
  subtitle?: string;
  body?: string;
  footer?: string;
  when?: string;        // ISO time (event start, call time, ...)
  until?: string;       // ISO end time, if any
  place?: string;       // event location / address text
  rows?: { label: string; value: string }[];
  buttons?: string[];   // shown as inert chips: UniChat can't press network buttons
  url?: string;         // join link / product page / invite link
  canceled?: boolean;   // events
  editable?: boolean;   // events: the user may edit it (created by this account and the provider supports editEvent)
}

export interface CardImage {
  attachmentId: string;
  width?: number; height?: number;
  thumbnailDataUrl?: string;   // tiny inline placeholder shown until the image is loaded
  alt?: string;
  /** "thumb": small square beside the text (default is a wide banner above/below it) */
  layout?: "banner" | "thumb";
}
/** All cards of a message in display order. `Message.card` is the legacy single-card alias of `cards[0]` (when `cards` is present it wins). */
export const cardsOf = (m: { card?: Card; cards?: Card[] }): Card[] => (m.cards?.length ? m.cards : m.card ? [m.card] : []);

export interface Location {
  lat: number; lng: number; name?: string; address?: string;
  live?: boolean;          // a live location share
  liveUntil?: string;      // ISO: when the share ends (absent = unknown)
  updatedAt?: string;      // ISO: time of the latest position (live shares move: update via message-update {location})
}
/** A contact card shared inside a message (vCard-like). */
export interface SharedContact { name: string; phones?: string[]; emails?: string[]; handle?: string }

/** Per-recipient delivery state of one of MY messages (ISO times). `id` is in the sender-id space of Message.senderId / Reaction.senderIds. */
export interface MessageReceipt { id: string; delivered?: string; read?: string }

export type DeliveryStatus = "sending" | "sent" | "delivered" | "read" | "failed";

export interface Message {
  id: string; chatId: string; accountId?: string;
  /** Set by the Hub on messages/events of a chat that belongs to a merge: the merged chat they show up in. `chatId` stays the real chat. Never stored. */
  mergeId?: string;
  sender: string;               // display name
  senderId: string;
  text: string;                 // plain text; "" for attachment-only
  time: string;
  fromMe: boolean;
  /** This message started a thread, or announces one ("X started a thread"): `id` is the thread's chat (native id, same account), opened with the `openThread` call. `count`: replies, when the network says. */
  thread?: { id: string; name?: string; count?: number };
  replyTo?: { messageId: string; sender?: string; textPreview?: string; /** the reply belongs to a thread (Matrix m.thread); shown flat */ thread?: boolean };
  attachments?: Attachment[];
  location?: Location;
  contacts?: SharedContact[];
  poll?: Poll;
  card?: Card;
  /** Several cards (e.g. Discord embeds). `card` stays supported and counts as cards[0]; use cardsOf(). */
  cards?: Card[];
  forwarded?: boolean;
  /** The message disappears this many seconds after it was read/sent (disappearing timer in force when it was sent). Informational: the Hub never deletes by it. */
  expiresIn?: number;
  /** Opened once, then gone (view-once media). The content is not available in UniChat. */
  viewOnce?: boolean;
  reactions?: Reaction[];
  editedAt?: string;
  deleted?: boolean;
  /** Pinned in its chat (Capabilities.pinMessages). The Hub keeps the flag in the archive; pins sync between devices (last writer wins). */
  pinned?: boolean;
  /** When it was pinned (ISO), by whom (Contact id / sender id), and when the pin lapses (ISO; networks with expiring pins, see Capabilities.pinDurations). */
  pinnedAt?: string; pinnedBy?: string; pinnedUntil?: string;
  status?: DeliveryStatus;      // only for fromMe (aggregate: the furthest state reached)
  /** Per-recipient delivered/read times of my message (only where the network tells; see Capabilities.receiptDetails). Merged per id, times never move backwards. */
  receipts?: MessageReceipt[];
  /** Delivered by a history sync / backfill, not a fresh arrival: no notification, no unread bump, never relayed by mesh groups. Not stored. */
  historical?: boolean;
  /** Not a real message: a timeline marker (account linked / signed out / unlinked), added by the Hub when reading history. */
  system?: { kind: "linked" | "unlinked" | "signed-out" | "info" };  // "info": a notice from the network (joined, renamed, timer changed...)
}

export interface Account {
  id: string; provider: string; label: string; state: AccountState;
  linkedAt?: string;     // when the current link started
  signedOutAt?: string;  // when the user signed out / the device was unlinked
  everLinked?: boolean;  // false while the very first link is still in progress
  /** EFFECTIVE capabilities of this account's connector (read live from Connector.capabilities by the Hub; may differ per instance, e.g. Discord bot vs user mode). Absent for a signed-out archive: the UI then falls back to the provider-level capabilities. */
  capabilities?: Capabilities;
  /** Set by device sync while another of the user's devices holds this account's login (see docs: "Sending through another device"). `device` is that device's name. */
  via?: AccountVia;
}
/** relay: this device sends through `device` (the account shows as connected); offline: `device` is off, archive only; ask: `device` holds the login but has not allowed sending yet; denied: it said no. */
export interface AccountVia { kind: "relay" | "offline" | "ask" | "denied"; device: string; deviceId: string }
/** "signed-out": the user signed out on purpose; chats stay as a read-only archive. */
export type AccountState = "connecting" | "needs-login" | "connected" | "disconnected" | "signed-out";
