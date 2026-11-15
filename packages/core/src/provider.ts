// ============================================================================
// PROVIDER CONTRACT  –  what every messenger integration implements.
//
// A provider package (packages/provider-<name>) default-exports a ProviderFactory.
// The Hub creates one Connector per logged-in account. Rules:
//
//  1. NATIVE IDS ONLY. Never prefix ids with the account id – the Hub does.
//  2. EVENTS, NOT POLLING. Push changes through the `emit` passed to start().
//  3. NEVER THROW FROM EVENT HANDLERS; report problems via {type:"error"}.
//  4. OPTIONAL FEATURES are optional *methods* gated by `capabilities`. The UI
//     only offers what capabilities declares; the Hub rejects calls to
//     undeclared features. Declaring a capability means implementing the method.
//  5. PERSISTENCE: providers keep only their own session/crypto state under
//     `dataDir` (private, 0700). Message history is the Hub's job; a provider
//     only has to deliver messages (live + whatever the network backfills).
//     A provider MAY keep a bounded local cache of messages/keys when its
//     protocol needs it (e.g. per-message media keys for downloadAttachment).
//     The Hub dedupes message events by (chat, id), so re-delivery is safe.
//  6. RECONNECT yourself on transient failures (emit account state changes);
//     only report "needs-login" when credentials are really gone.
//  7. SECRETS: never log message text, keys, tokens or phone numbers.
// ============================================================================
import type { AccountState, Attachment, Card, Chat, Contact, DeliveryStatus, Location, Message, MessageReceipt, Poll, Reaction, SharedContact, Space } from "./model.js";

// ---------- capabilities ----------
export interface Capabilities {
  /** Has a "community/server" level above chats (Space). */
  spaces: boolean;
  reactions: boolean;
  /** Pin / unpin messages in a chat: pin() (and optionally pins()) plus message-update patches {pinned,...} for pins made elsewhere. */
  pinMessages?: boolean;
  /** Networks whose pins expire: the offered durations in seconds (e.g. WhatsApp 86400, 604800, 2592000). Absent = pins stay until removed. */
  pinDurations?: number[];
  /** Edit own messages / delete own messages for everyone. */
  edits: boolean;
  deletes: boolean;
  replies: boolean;
  attachments: boolean;
  typing: boolean;
  readReceipts: boolean;
  /** The network reports delivered/read PER RECIPIENT for my messages (receipt events with `by`, Message.receipts): the UI offers "Message info" in groups too. 1:1 chats always get the popover. */
  receiptDetails?: boolean;
  /** Can mark a chat as read on the service even without per-message read receipts (e.g. Mattermost). Defaults to readReceipts. */
  markRead?: boolean;
  /** Messages/reactions may contain :name: custom emoji, resolvable through avatar({kind:"emoji"}). */
  customEmoji?: boolean;
  /** Can the user start a new 1:1 chat / create groups from inside UniChat. */
  startChat: boolean;
  createGroup: boolean;
  /** Network backfills older messages on request (history() can go further than the live stream). */
  backfill: boolean;
  /** history() can page back through a whole chat on request (not only what the live stream delivered): enables Settings > Storage > "Fetch chat history". Absent = false. */
  fetchHistory?: boolean;
  /** Provider-level E2EE (informational, shown in UI). */
  e2ee: boolean;
  // ---- additive, optional (absent = false) ----
  /** Send/receive static locations (Message.location). */
  location?: boolean;
  /** Send/receive contact cards (Message.contacts). */
  contactCards?: boolean;
  /** Voice notes (attachments of kind "voice"). */
  voiceNotes?: boolean;
  /** Group management (each implies the matching optional Connector method). */
  leaveChat?: boolean;
  manageMembers?: boolean;   // addMembers + removeMember
  chatDescription?: boolean; // change the group/channel description (setChatDescription)
  chatPicture?: boolean;     // change the group/channel picture on the network (setChatPicture)
  renameChat?: boolean;      // change the group/channel name on the network
  block?: boolean;           // blockChat
  /** Connector.setDisappearing(): the disappearing-messages timer of a chat can be changed from here (Chat.disappearing shows it). */
  disappearing?: boolean;
  /** The timers (seconds) setDisappearing() accepts besides 0 = off; the UI offers exactly these. Absent: 24 h / 7 d / 90 d. */
  disappearingDurations?: number[];
  /** Own profile (Connector.getProfile/updateProfile): which fields the network lets this client change. */
  profile?: { displayName?: boolean; about?: boolean; avatar?: boolean };
  /** Connector.getPrivacy/setPrivacy: the account has privacy settings UniChat can show and change. */
  privacy?: boolean;
  /** Connector.refreshChat(): ask the network / phone again for messages this chat is missing (undecryptable or never delivered). */
  refreshChat?: boolean;
  /** Events: create (OutgoingMessage.event) / edit (Connector.editEvent). Receiving event cards needs no capability. */
  events?: boolean;
  eventEdit?: boolean;
  /** Polls: send OutgoingMessage.poll, receive Message.poll (+ message-update patches), and vote(). */
  polls?: boolean;
  /** vote() is available. Absent = follows `polls`. (Discord bots can send polls but cannot vote.) */
  pollVote?: boolean;
  /** Connector.leaveSpace(): leave a community/space. */
  leaveSpace?: boolean;
  /** Connector.avatar(): can fetch profile pictures (chats, contacts, communities). */
  avatars?: boolean;
  /** createSpace / joinSpace: create a community/server/space, or join one by invite. */
  createSpace?: boolean;
  joinSpace?: boolean;
  /** The composer may offer @mention autocomplete in groups/channels and send OutgoingMessage.mentions. */
  mentions?: boolean;
  /** Message requests: Chat.request + Connector.acceptRequest / declineRequest. */
  requests?: boolean;
  /** Connector.sync(): ask the network / primary device to resend contacts + chat list (e.g. Signal linked devices). */
  sync?: boolean;
  /** The connector emits `presence` events (online / last seen) for 1:1 contacts. Absent = false. */
  presence?: boolean;
  /** Interactive identity verification (Matrix emoji / SAS): the connector emits `verification` events and implements verificationStart / verificationAction / verificationStatus (setup + recovery are optional). */
  verification?: boolean;
}
export const NO_CAPABILITIES: Capabilities = {
  spaces: false, reactions: false, edits: false, deletes: false, replies: false, attachments: false,
  typing: false, readReceipts: false, startChat: false, createGroup: false, backfill: false, e2ee: false,
};

// ---------- login ----------
/**
 * Login is a small state machine driven by events + answers, so every
 * provider fits it (QR scan, phone+SMS code, username+password, SSO link...):
 *
 *   connector emits {type:"login", data: LoginPrompt}   (UI renders it)
 *   UI answers via hub -> connector.submitLogin(promptId, values)   (for "form" prompts)
 *   "qr"/"link" prompts need no answer (user acts on another device/browser);
 *   connector emits account state "connected" when done, which closes the prompt.
 */
export type LoginPrompt =
  | { accountId: string; promptId: string; kind: "qr"; payload: string; hint?: string }     // render payload as QR
  | { accountId: string; promptId: string; kind: "link"; payload: string; hint?: string }   // open/show URL
  | { accountId: string; promptId: string; kind: "form"; title: string; fields: LoginField[]; error?: string; warning?: LoginWarning };
export interface LoginField {
  name: string; label: string; type: "text" | "password" | "phone" | "code" | "checkbox" | "select" | "file"; placeholder?: string;
  /** `select`: the choices, and the initially chosen one (`value`, default the first). */
  options?: { value: string; label: string }[]; value?: string;
  /** Step-by-step help shown under the field in a collapsible "How do I get this?" box; `link` lines are rendered as links. */
  help?: { title: string; steps: string[]; link?: { href: string; label: string } }[];
  /** `file`: the UI reads the chosen file as text and submits its contents as the value. */
  /** The UI refuses to submit while a required field is empty / (checkbox) unchecked. Checkbox values are submitted as the strings "true" / "false". */
  required?: boolean;
}
/** A prominent notice above a login form (styled box with icon). */
export interface LoginWarning { text: string; severity: "info" | "warning" | "danger" }

// ---------- interactive verification (Matrix emoji / SAS; generic so other networks can reuse it) ----------
/**
 * One verification of my own device or of another person, as the UI shows it. The connector emits {type:"verification"} on every change
 * and answers verificationAction(id, ...) calls. Phases:
 *   incoming    somebody asked me to verify (accept / decline)
 *   waiting     request sent / accepted, waiting for the other side (before the emojis exist)
 *   sas         the emojis are ready: compare with the other side (confirm / mismatch)
 *   confirming  I confirmed, waiting for the other side to confirm too
 *   done        verified            cancelled   ended without success (`reason` in plain English)
 */
export type VerificationPhaseName = "incoming" | "waiting" | "sas" | "confirming" | "done" | "cancelled";
export interface VerificationState {
  accountId: string; id: string; phase: VerificationPhaseName;
  /** I did not start it. */
  incoming: boolean;
  /** `device`: one of my own other devices; `user`: another person. `name` is what the UI calls them. */
  other: { kind: "device" | "user"; name: string; userId?: string; deviceId?: string };
  /** The 7 emojis as [emoji, name] (phase sas / confirming). */
  emoji?: [string, string][];
  /** Why it ended (phase cancelled), plain English. */
  reason?: string;
}
export type VerificationAction = "accept" | "decline" | "confirm" | "mismatch" | "cancel";
/** Verification state of an identity plus what this account has set up. */
export interface VerificationStatus {
  /** The device (no `userId`) or the person (`userId`) is verified / not / cannot be told. */
  state: "verified" | "unverified" | "unknown";
  /** Cross-signing keys exist on the account (needed before anyone can verify). */
  crossSigning?: "ready" | "missing" | "unknown";
  /** Message key backup on the server. */
  backup?: "enabled" | "none" | "unknown";
  /** Who `state` is about when asked for a person (the other side of a 1:1 chat). */
  userId?: string;
}

// ---------- events (connector -> hub -> UI) ----------
export type CoreEvent =
  | { type: "message"; data: Message }                                                   // new incoming OR own-from-other-device
  | { type: "message-update"; data: { chatId: string; messageId: string; patch: MessagePatch } }
  /** `by` (a sender id) + `at` (ISO time, default now) make it a PER-RECIPIENT receipt: "delivered" or "read" for that one person (read implies delivered). Without `by` it is the aggregate status. `byId` is the old name of `by`. */
  | { type: "receipt"; data: { chatId: string; messageId: string; status: DeliveryStatus; by?: string; at?: string; byId?: string } }
  | { type: "typing"; data: { chatId: string; senderId: string; typing: boolean } }
  /** Presence of a contact. `chatId` (native) = the 1:1 chat with that contact when the provider knows it. The Hub keeps it in memory only (never archived) and forwards it with global ids. */
  | { type: "presence"; data: { accountId: string; chatId?: string; contactId: string; online: boolean; lastSeen?: string } }
  | { type: "chats-changed"; data: { chatId?: string } }       // re-fetch chats() (or just that chat)
  | { type: "spaces-changed"; data: Record<string, never> }
  /** A profile picture changed: of chat/space/contact `id` (native; `kind` absent = chat and contact), or the account's own (`own`). The Hub refreshes the stored copies. */
  | { type: "avatar-changed"; data: { id?: string; kind?: "chat" | "space" | "contact"; own?: boolean } }
  | { type: "login"; data: LoginPrompt }
  /** State of one interactive verification (see VerificationState). Emitted on every change; the UI shows a dedicated dialog. Not forwarded to proxy devices. */
  | { type: "verification"; data: VerificationState }
  /** This device's / a person's verification status or the account's cross-signing / backup state changed: the UI re-reads verificationStatus. */
  | { type: "verification-changed"; data: Record<string, never> }
  | { type: "account"; data: { id: string; state: AccountState; detail?: string } }   // the Hub adds the connector's live `capabilities`
  | { type: "error"; data: { id?: string; code: string; message: string; fatal?: boolean } };

export interface MessagePatch { pinned?: boolean; pinnedAt?: string; pinnedBy?: string; pinnedUntil?: string; sender?: string; text?: string; editedAt?: string; deleted?: boolean; reactions?: Reaction[]; receipts?: MessageReceipt[]; attachments?: Attachment[]; location?: Location; poll?: Poll; card?: Card; cards?: Card[] }

// ---------- requests ----------
export interface OutgoingMessage {
  text: string;
  /** Stable id the app made up for THIS send (the same on every Retry). Connectors may ignore it; a relaying connector uses it so a repeated send is never executed twice. */
  clientId?: string;
  replyToMessageId?: string;
  attachments?: OutgoingAttachment[];
  location?: Location;
  contacts?: SharedContact[];
  /** Create an event (capabilities.events): times are ISO strings. */
  event?: { name: string; description?: string; start: string; end?: string; place?: string; videoCall?: boolean };
  /** Create a poll (capabilities.polls); `text` may be empty. */
  poll?: { question: string; options: string[]; multiple?: boolean };
  /** Mark as forwarded where the network supports it. */
  forwarded?: boolean;
  /** Structured mentions chosen in the composer (Capabilities.mentions). `start`/`length` are UTF-16 offsets into `text` (the `@Name` span); `id` is a Contact.id from members(). Providers that don't support them ignore the field and send the plain text. */
  mentions?: OutgoingMention[];
}
export interface OutgoingMention { id: string; name: string; start: number; length: number }
export interface OutgoingAttachment {
  kind: Attachment["kind"]; mime: string; name?: string; data: Uint8Array;
  durationMs?: number;     // voice notes / audio / video
  waveform?: number[];     // voice notes: ~64 bar heights, 0-100
  /** Optional hints from the UI (measured on the picked file). Providers may use them for previews/metadata and ignore them otherwise. */
  width?: number; height?: number;
  /** An animated GIF (sent as a looping video by most networks). */
  gif?: boolean;
  /** Caption shown with this attachment where the network has per-attachment captions. */
  caption?: string;
}

export interface HistoryQuery {
  limit: number;
  /** Return messages strictly older than this message id (paging backwards). Omit for newest. */
  beforeMessageId?: string;
}

// ---------- the connector ----------
export interface Connector {
  /** May be a getter: the Hub reads it live (on start, on every account event) and publishes it as Account.capabilities, so it can differ per instance (e.g. Discord bot vs user mode). */
  readonly capabilities: Capabilities;

  /** Connect/restore the session. Resolve once the connection attempt is underway
   *  (NOT when logged in – login can wait on the user). Report progress via emit. */
  /** Optional: the Hub tells the connector (before start() and whenever the user flips it) whether the privacy setting "Show who is online" is on. Off = do not subscribe to / poll presence at all. Default on. */
  setPresenceEnabled?(on: boolean): void;
  start(emit: (e: CoreEvent) => void): Promise<void>;
  /** Disconnect and release resources. Must be idempotent. Does NOT log out. */
  stop(): Promise<void>;
  /**
   * Log out and wipe session data in dataDir. Contract: wipe local state FIRST/ALWAYS, and only then throw if the REMOTE logout
   * (removing this device from the account) could not be confirmed. The error message is shown to the user as-is, so it must be
   * plain English telling them what to do (e.g. remove the device manually on their phone).
   */
  logout(): Promise<void>;
  /** Answer a "form" LoginPrompt. Rejecting shows the error to the user and re-prompts. */
  submitLogin(promptId: string, values: Record<string, string>): Promise<void>;

  // ----- read -----
  /** Communities/servers. Return [] if capabilities.spaces is false. */
  spaces(): Promise<Space[]>;
  /** All chats the account is in (including space channels). */
  chats(): Promise<Chat[]>;
  /** Messages the provider can supply for a chat, oldest->newest within the page. */
  history(chatId: string, q: HistoryQuery): Promise<Message[]>;
  members(chatId: string): Promise<Contact[]>;
  /** Fetch bytes of an attachment seen in a Message. */
  downloadAttachment(chatId: string, messageId: string, attachmentId: string): Promise<{ data: Uint8Array; mime: string; name?: string }>;

  // ----- write -----
  /** Send; resolve with the message as it will appear (id, time, status "sent"). For a chat returned by startChat with `provisional: true` the
   *  returned message carries the REAL native chatId (different from the one passed in): the Hub then replaces the provisional chat. */
  send(chatId: string, msg: OutgoingMessage): Promise<Message>;

  // ----- optional (implement iff the matching capability is true) -----
  react?(chatId: string, messageId: string, emoji: string | null /* null removes */): Promise<void>;
  edit?(chatId: string, messageId: string, newText: string): Promise<void>;
  /** Pin or unpin a message (Capabilities.pinMessages). `durationSec` only where Capabilities.pinDurations is set. The connector emits message-update {pinned,...} (own device included) once the network confirms. */
  pin?(chatId: string, messageId: string, pinned: boolean, opts?: { durationSec?: number }): Promise<void>;
  /** The messages currently pinned in the chat, when the network can list them (else the Hub derives them from the archive). */
  pins?(chatId: string): Promise<Message[]>;
  delete?(chatId: string, messageId: string): Promise<void>;
  setTyping?(chatId: string, typing: boolean): Promise<void>;
  markRead?(chatId: string, upToMessageId: string): Promise<void>;
  /** Accept / decline a pending message request (Chat.request, Capabilities.requests). Emit chats-changed afterwards; a declined chat disappears from chats(). */
  acceptRequest?(chatId: string): Promise<void>;
  declineRequest?(chatId: string): Promise<void>;
  /** Resolve a user-entered handle (phone number, @user:server...) to a chat, creating it if needed. May return `provisional: true` when the network creates the conversation only with the first message. */
  startChat?(handle: string): Promise<Chat>;
  createGroup?(name: string, memberHandles: string[]): Promise<Chat>;
  /** Leave a group/channel (for a DM: close/forget it where the network allows). */
  leaveChat?(chatId: string): Promise<void>;
  /** Invite/add people by handle (phone number, @user:server...). */
  addMembers?(chatId: string, memberHandles: string[]): Promise<void>;
  /** Remove/kick a member (memberId as returned by members()). */
  removeMember?(chatId: string, memberId: string): Promise<void>;
  /** Rename the group/channel on the network (not the local alias). */
  renameChat?(chatId: string, name: string): Promise<void>;
  /** Set (or with null remove) the picture of a group/channel. */
  /** Set the description (about/topic) of a group/channel; empty text removes it. */
  setChatDescription?(chatId: string, text: string): Promise<void>;
  /** The person's CURRENT best display name (names learned after a message arrived fix its stored sender text). Cheap, synchronous, no network. */
  currentNameOf?(senderId: string): string | undefined;
  setChatPicture?(chatId: string, image: { data: Uint8Array; mime: string } | null): Promise<void>;
  /** Create a community/space (the new Space appears in spaces(); also emit spaces-changed). */
  createSpace?(name: string, description?: string): Promise<Space>;
  /** Join a community/space from an invite link, invite code, alias or id. */
  joinSpace?(invite: string): Promise<Space>;
  /** Profile picture bytes for a chat (DM = the person, group = the group icon) or a space/community. Resolve undefined when there is
   *  none (or it is hidden by privacy settings). Called lazily by the UI as items scroll into view and cached by the Hub, so keep
   *  it cheap and rate-limit friendly; never throw for 'no picture'. */
  /** kind "emoji": a custom emoji image by name (Capabilities.customEmoji). */
  avatar?(target: { kind: "chat" | "space" | "contact" | "emoji"; id: string; /** the biggest available picture (for enlarging), not the small preview */ full?: boolean }): Promise<{ data: Uint8Array; mime: string } | undefined>;
  /** kind "contact": id is a Contact.id / Message.senderId (a person, e.g. a group member), not a chat. */
  /** Edit an event I created (capabilities.eventEdit); emit message-update {card}. */
  editEvent?(chatId: string, messageId: string, patch: { name?: string; description?: string; start?: string; end?: string; place?: string; canceled?: boolean }): Promise<void>;
  /** Ask the network / primary phone again for messages missing from a chat (placeholders, unread gap). Resolves with a short
   *  human-readable result such as "Asked your phone to resend 3 messages"; new messages arrive later as normal events. */
  refreshChat?(chatId: string): Promise<string>;
  /** Cast (or change) my vote: the full set of option ids I now pick; [] retracts. Emit message-update {poll} afterwards. */
  vote?(chatId: string, messageId: string, optionIds: string[]): Promise<void>;
  /** Leave a community/space (its channels disappear from chats()); emit spaces-changed + chats-changed. */
  leaveSpace?(spaceId: string): Promise<void>;
  /** The account's own profile (name / about / picture) as the network has it. */
  getProfile?(): Promise<Profile>;
  /** Change own profile fields (only those allowed by capabilities.profile); resolves with the new profile. */
  updateProfile?(patch: ProfilePatch): Promise<Profile>;
  /** Privacy settings of this account (last seen, read receipts, who can add me to groups, ...). */
  getPrivacy?(): Promise<PrivacySetting[]>;
  /** Change one privacy setting (value must be one of its options); resolves with the refreshed list. */
  setPrivacy?(id: string, value: string): Promise<PrivacySetting[]>;
  /** Ask the network/primary device to resend contacts and chats; results arrive as chats-changed events. */
  sync?(): Promise<void>;
  /**
   * Signal history import: who this linked account is and which phone numbers it knows, so an imported backup can be checked against
   * the account and its 1:1 chats can be keyed by the same ids the live connector uses. Absent / undefined = unknown (offline).
   */
  importIdentity?(): { aci: string; number?: string; numberToAci?(e164: string): string | undefined } | undefined;
  /**
   * Signal history import: contacts of a backup (ACI + profile key as base64, name, number). The connector merges what it lacks (never
   * overwrites an existing profile key), refreshes avatars and returns how many contacts gained a NEW profile key. Idempotent.
   */
  importContacts?(list: { aci: string; profileKey?: string; name?: string; e164?: string; pni?: string }[]): number;
  /** WhatsApp history import: this account's own jids (phone-number form first) and the live LID -> phone-number mapping. Read-only; undefined = unknown (offline). */
  importMaps?(): { own: string[]; lidToPn?(lid: string): string | undefined } | undefined;
  // ----- interactive verification (capabilities.verification) -----
  /** Ask to verify this device (no target: another device of mine) or a person (`userId`, with `chatId` = the native 1:1 chat they are in; `chatId` alone = the other person of that 1:1 chat). Resolves once the request is sent; progress arrives as `verification` events. */
  verificationStart?(target?: { userId?: string; chatId?: string }): Promise<{ id: string }>;
  /** accept/decline an incoming request; confirm/mismatch the emojis; cancel at any time. */
  verificationAction?(id: string, action: VerificationAction): Promise<void>;
  /** Is this device verified (no target) or the person (`userId`, or the other person of the 1:1 `chatId`), and what is set up on the account. */
  verificationStatus?(target?: { userId?: string; chatId?: string }): Promise<VerificationStatus>;
  /** Set up cross-signing + key backup for an account that has none. The password (if the server asks for it) is used once and never stored or logged. Resolves with the recovery key, which is shown once and never stored. */
  verificationSetup?(opts: { password?: string }): Promise<{ recoveryKey?: string }>;
  /** Verify this device without another device: unlock secret storage with the recovery key (or passphrase). */
  verificationRecover?(recoveryKey: string): Promise<void>;
  /** Block/unblock the person behind a 1:1 chat; emit chats-changed afterwards. */
  blockChat?(chatId: string, blocked: boolean): Promise<void>;
  /** Set the disappearing-messages timer of a chat in seconds (0 = off); emit chats-changed afterwards. */
  setDisappearing?(chatId: string, seconds: number): Promise<void>;
}

// ---------- own profile + privacy ----------
export interface Profile {
  displayName?: string;
  about?: string;
  /** The account's own address: phone number, @user:server, ... (read-only, shown for orientation). */
  handle?: string;
  avatar?: { data: Uint8Array; mime: string };
}
export interface ProfilePatch {
  displayName?: string;
  about?: string;
  /** New picture, or null to remove it. Omit to keep. The UI sends a square JPEG/PNG already scaled to <= 640px. */
  avatar?: { data: Uint8Array; mime: string } | null;
}
/** One privacy setting rendered by the UI as a labelled choice: providers decide ids, labels and options. */
export interface PrivacySetting {
  id: string;
  label: string;
  description?: string;
  value: string;
  options: { value: string; label: string }[];
}

// ---------- factory ----------
export interface ProviderInfo {
  name: string;          // stable id: "whatsapp" | "signal" | "matrix" | ...
  displayName: string;   // "WhatsApp"
  /** How the account gets linked; lets the UI show the right "Add account" affordance. */
  login: "qr" | "form" | "link";
  /** Still works for accounts that already exist, but is no longer offered under "Add account". */
  deprecated?: boolean;
}
export interface ProviderFactory extends ProviderInfo {
  capabilities: Capabilities;
  create(opts: { accountId: string; dataDir: string }): Connector;
  /**
   * OPTIONAL, backup / "move login to another device". For providers whose secret in `dir` cannot be copied as-is (the sealing key lives
   * outside the account dir: an environment variable, the OS keychain, a KeyProvider). Static (works for stopped accounts). Return the
   * session in a portable form: `files` are added to / replace same-named files of the copy, `omit` lists files of `dir` that must NOT
   * be exported (the unportable sealed file). The archive is passphrase-encrypted, so the files may hold the secret in plain form.
   * Return undefined to export the directory as it is.
   */
  exportSession?(dir: string): Promise<{ files?: { rel: string; data: Uint8Array }[]; omit?: string[] } | undefined>;
  /** OPTIONAL, counterpart of exportSession: called after the session files of an imported account were put into `dir` (re-seal them for THIS install, delete the portable file). */
  importSession?(dir: string): Promise<void>;
}
