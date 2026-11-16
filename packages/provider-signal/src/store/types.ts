// Persistent data model (JSON, base64 for binary). Private keys are stored as libsignal-serialized records.
export type IdKind = "aci" | "pni";

export interface AccountData {
  aci: string;                 // our ACI (UUID string)
  pni?: string;                // our PNI (UUID string), absent for number-less accounts
  deviceId: number;
  password: string;            // chat-service password for username `${aci}.${deviceId}`
  registrationId: number;
  pniRegistrationId?: number;
  aciIdentity: string;         // b64 IdentityKeyPair.serialize()
  pniIdentity?: string;
  profileKey?: string;         // b64 32 bytes (needed later for profiles / sealed-sender access keys)
  readReceipts: boolean;
  /** Send link previews (learned from the phone's Configuration sync; default on, like Signal). */
  linkPreviews?: boolean;
  typingIndicators?: boolean;  // learned from the phone's Configuration sync; unknown until then
  linkedAt: number;
}

export interface KeyCounters { nextPreKeyId: number; nextSignedPreKeyId: number; nextKyberPreKeyId: number }

export interface ChatRecord {
  id: string;                  // native chat id: ACI uuid (dm) or "g." + base64url(groupId) (group)
  kind: "dm" | "group";
  name?: string;
  groupMasterKey?: string;     // b64, groups only
  // Groups v2 state, filled by service/groupState.ts (absent until the group resolved; stored sealed like everything else)
  description?: string;
  groupFetchedAt?: number;     // ms epoch when the cached state was fetched
  groupRevision?: number;      // revision of the cached state
  groupMembers?: string[];     // member ACIs (decrypted)
  groupAdmins?: string[];
  avatarPath?: string;         // CDN path of the cached avatar (change detection)
  avatarB64?: string;          // decrypted avatar image
  avatarMime?: string;
  lastMessageAt?: string;
  unread?: number;
  /** From the Storage Service (groups): flags the user set in Signal on any device. */
  archived?: boolean; mutedUntil?: number; pinned?: boolean; blocked?: boolean;
  /** Disappearing-messages timer in seconds (0/absent = off). Received only; this provider never deletes anything itself. The core Chat model has no field for it yet. */
  expireTimer?: number;
  /** Blocked inside UniChat only (a linked device cannot write the phone's block list): incoming messages are dropped, sending is refused. Survives Storage Service syncs (they only set `blocked`). */
  localBlocked?: boolean;
  // ---- Groups v2 sending state ----
  /** Sender-key distribution id for our group sends (random UUID per group). */
  skDistributionId?: string;
  /** member ACI -> device ids that already got our sender-key distribution message for `skDistributionId`. */
  skSharedWith?: Record<string, number[]>;
  /** Group send endorsements from the last state fetch (zkgroup). Times are ms epoch. */
  endorsements?: { expiresAt: number; combined: string; members: Record<string, string> };
}

export interface ContactRecord {
  aci: string;
  number?: string;             // E.164; stored sealed at rest, never logged
  name?: string;
  blocked?: boolean;
  /** Blocked inside UniChat only; see ChatRecord.localBlocked. */
  localBlocked?: boolean;
  /** b64 32-byte profile key learned from the contact's messages (needed for their sealed-sender access key and group credentials). */
  profileKey?: string;
  /** When we last asked the server for this person's profile name (it is only fetched for people without a contact name). */
  profileNameCheckedAt?: number;
  /** CDN path of their profile picture as last seen (change hint only; never the image). */
  avatarPath?: string;
  /** Server said the profile accepts unrestricted unidentified access (checked at most once per 6 h). */
  unrestricted?: { value: boolean; checkedAt: number };
  /** Name parts kept separately for traceability; `name` is the resolved one (see service/contacts.ts resolveContactName). */
  nickName?: string; systemName?: string; profileName?: string; syncName?: string;
  /** From the Storage Service: flags the user set in Signal on any device (apply to the DM chat). */
  archived?: boolean; mutedUntil?: number; pinned?: boolean; hidden?: boolean; unregistered?: boolean;
  /** Last time a sealed send with their access key was rejected with 401 (then sealed is skipped for a while). */
  sealedRejectedAt?: number;
}
/** Read-only Storage Service sync state (service/storageSync.ts). */
export interface StorageState {
  /** b64 32-byte storage key, derived from the primary's keys sync (or provisioning). Never logged. */
  key?: string;
  keysRequestedAt?: number; keysAttempts?: number;
  manifestVersion?: number;
  /** b64 storage id -> record type + local key (aci / chat id) it was applied to; unchanged ids are not read again. */
  items?: Record<string, { t: number; k?: string }>;
  syncedAt?: number;
}
export interface AttachmentRef {
  cdnNumber?: number; cdnKey?: string; cdnId?: number; key: string /* b64, 64 bytes */; digest?: string /* b64 */;
  size?: number; contentType?: string; fileName?: string;
}

export interface PollRecord {
  question: string; options: string[]; multiple: boolean; closed?: boolean;
  /** voter ACI -> latest vote (highest voteCount wins); option ids are the option indexes as strings */
  votes: Record<string, { count: number; picks: number[] }>;
}

export interface StoreShape {
  version: 1;
  account: AccountData | null;
  /** key: `${kind}:${address}` -> b64 serialized record */
  sessions: Record<string, string>;
  /** trusted identity keys of peers: address -> b64 PublicKey.serialize() */
  identities: Record<string, string>;
  /** PNI (phone-number identity UUID) -> ACI of the same person, from storage records or a verified PniSignatureMessage. Optional: absent in older stores. */
  pnis?: Record<string, string>;
  /** PNI -> E.164 the phone itself told us belongs to that PNI (sent-message transcript, storage record without ACI). Used to link a PNI chat to the ACI that later shows up with the same number. */
  pniNumbers?: Record<string, string>;
  senderKeys: Record<string, string>;
  preKeys: Record<string, string>;
  signedPreKeys: Record<string, string>;
  kyberPreKeys: Record<string, string>;
  /** `${kind}:${id}` of last-resort kyber keys (never deleted) */
  lastResortKyber: string[];
  /** replay guard for last-resort kyber keys: `${kind}:${id}:${signedPreKeyId}:${baseKeyB64}` */
  kyberUsed: string[];
  counters: Record<IdKind, KeyCounters>;
  lastSignedPreKeyRotation: Record<IdKind, number>;
  chats: Record<string, ChatRecord>;
  /** messageId -> chatId for our own sent messages (receipt routing), bounded */
  sentIndex: Record<string, string>;
  /** chatId -> ids of incoming messages not yet acknowledged as read (here or on another device), bounded. Absent in older stores. */
  unreadIds?: Record<string, string[]>;
  /** messageId -> reactions: emoji -> sender ids */
  reactions: Record<string, Record<string, string[]>>;
  /** peer ACI -> display name learned from nothing yet (profiles TODO); kept for forward compat */
  names: Record<string, string>;
  /** contacts learned from the primary device's contact sync or from lookups, by ACI */
  contacts: Record<string, ContactRecord>;
  /** attachment id -> download info (bounded) */
  attachments: Record<string, AttachmentRef>;
  /** messageId -> poll state (1:1 chats only for now) */
  polls: Record<string, PollRecord>;
  /** Storage Service sync state (absent in stores written by earlier versions). */
  storage: StorageState;
}

export function freshStore(): StoreShape {
  const c = (): KeyCounters => ({ nextPreKeyId: 1, nextSignedPreKeyId: 1, nextKyberPreKeyId: 1 });
  return {
    version: 1, account: null, sessions: {}, identities: {}, senderKeys: {}, preKeys: {}, signedPreKeys: {},
    kyberPreKeys: {}, lastResortKyber: [], kyberUsed: [], counters: { aci: c(), pni: c() },
    lastSignedPreKeyRotation: { aci: 0, pni: 0 }, chats: {}, sentIndex: {}, reactions: {}, names: {}, contacts: {}, attachments: {}, polls: {}, storage: {},
  };
}
