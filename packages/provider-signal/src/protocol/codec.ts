// Protobuf codec for the subset of Signal's wire messages this provider uses.
// The .proto text (from Signal-Desktop, AGPL-3.0) is embedded in protos.ts and parsed once at load
// with protobufjs reflection, so no code generator is needed (important: no protoc in the build).
// Hand-written interfaces below only describe the fields we actually read/write; unknown fields
// are preserved by the decoder but ignored.
import protobuf from "protobufjs";
import { DEVICE_MESSAGES_PROTO, DEVICE_NAME_PROTO, GROUPS_PROTO, SIGNAL_SERVICE_PROTO, STORAGE_PROTO } from "./protos.js";

const service = new protobuf.Root();
protobuf.parse(SIGNAL_SERVICE_PROTO, service);
const provisioning = new protobuf.Root();
protobuf.parse(DEVICE_MESSAGES_PROTO, provisioning);
const groupsRoot = new protobuf.Root();
protobuf.parse(GROUPS_PROTO, groupsRoot);
const storageRoot = new protobuf.Root();
protobuf.parse(STORAGE_PROTO, storageRoot);
const deviceNameRoot = new protobuf.Root();
protobuf.parse(DEVICE_NAME_PROTO, deviceNameRoot);

const OPTS = { longs: Number, enums: Number, defaults: false, oneofs: true, arrays: true } as const;

class Codec<T> {
  constructor(private readonly type: protobuf.Type) {}
  encode(obj: Partial<T> | Record<string, unknown>): Uint8Array {
    const err = this.type.verify(obj as Record<string, unknown>);
    // verify() is strict about long/number mixing, so only fail on structural errors
    if (err && !/: (integer|integer\|Long) expected/.test(err)) throw new Error(`protobuf encode: ${err}`);
    return this.type.encode(this.type.fromObject(obj as Record<string, unknown>)).finish();
  }
  decode(buf: Uint8Array): T {
    return this.type.toObject(this.type.decode(buf), OPTS) as T;
  }
}

// ---- Envelope ----
export const EnvelopeType = {
  UNKNOWN: 0, DOUBLE_RATCHET: 1, PREKEY_MESSAGE: 3, SERVER_DELIVERY_RECEIPT: 5,
  UNIDENTIFIED_SENDER: 6, PLAINTEXT_CONTENT: 8,
} as const;
export interface Envelope {
  type?: number;
  sourceServiceId?: string;
  sourceServiceIdBinary?: Uint8Array;
  sourceDeviceId?: number;
  destinationServiceId?: string;
  destinationServiceIdBinary?: Uint8Array;
  clientTimestamp?: number;
  content?: Uint8Array;
  serverGuid?: string;
  serverTimestamp?: number;
  urgent?: boolean;
  story?: boolean;
}

// ---- Content & friends ----
export interface GroupContextV2 { masterKey?: Uint8Array; revision?: number; groupChange?: Uint8Array }
export interface Quote { id?: number; authorAci?: string; authorAciBinary?: Uint8Array; text?: string }
export interface Reaction { emoji?: string; remove?: boolean; targetAuthorAci?: string; targetAuthorAciBinary?: Uint8Array; targetSentTimestamp?: number }
export interface AttachmentPointer {
  cdnId?: number; cdnKey?: string; cdnNumber?: number; contentType?: string; key?: Uint8Array; size?: number;
  digest?: Uint8Array; fileName?: string; flags?: number; width?: number; height?: number; clientUuid?: Uint8Array;
  caption?: string; blurHash?: string; uploadTimestamp?: number; audioWaveform?: Uint8Array; audioDurationSeconds?: number;
}
export const DataMessageFlags = { END_SESSION: 1, EXPIRATION_TIMER_UPDATE: 2, PROFILE_KEY_UPDATE: 4, FORWARD: 8 } as const;
export interface ContactPb {
  name?: { givenName?: string; familyName?: string; prefix?: string; suffix?: string; middleName?: string; nickname?: string };
  number?: { value?: string; type?: number; label?: string }[];
  email?: { value?: string; type?: number; label?: string }[];
  organization?: string;
}
export interface BodyRange { start?: number; length?: number; mentionAci?: string; mentionAciBinary?: Uint8Array; style?: number }
export interface Preview { url?: string; title?: string; description?: string; date?: number; image?: AttachmentPointer }
export interface Sticker { packId?: Uint8Array; stickerId?: number; data?: AttachmentPointer; emoji?: string }
export interface Payment {
  notification?: { note?: string; mobileCoin?: { receipt?: Uint8Array } };
  activation?: { type?: number };
}
export interface CallMessagePb {
  offer?: { id?: number; type?: number };
  answer?: { id?: number };
  busy?: { id?: number };
  hangup?: { id?: number; type?: number };
  opaque?: { urgency?: number };
}
export interface CallEventPb { conversationId?: Uint8Array; callId?: number; timestamp?: number; type?: number; direction?: number; event?: number }
export interface DataMessage {
  body?: string;
  attachments?: AttachmentPointer[];
  groupV2?: GroupContextV2;
  flags?: number;
  expireTimer?: number;
  profileKey?: Uint8Array;
  timestamp?: number;
  quote?: Quote;
  reaction?: Reaction;
  contact?: ContactPb[];
  bodyRanges?: BodyRange[];
  preview?: Preview[];
  sticker?: Sticker;
  isViewOnce?: boolean;
  groupCallUpdate?: { eraId?: string };
  payment?: Payment;
  storyContext?: { authorAci?: string; authorAciBinary?: Uint8Array; sentTimestamp?: number };
  giftBadge?: { receiptCredentialPresentation?: Uint8Array };
  pinMessage?: { targetAuthorAciBinary?: Uint8Array; targetSentTimestamp?: number; pinDurationSeconds?: number; pinDurationForever?: boolean };
  unpinMessage?: { targetAuthorAciBinary?: Uint8Array; targetSentTimestamp?: number };
  adminDelete?: { targetAuthorAciBinary?: Uint8Array; targetSentTimestamp?: number };
  pollCreate?: { question?: string; allowMultiple?: boolean; options?: string[] };
  pollTerminate?: { targetSentTimestamp?: number };
  pollVote?: { targetAuthorAciBinary?: Uint8Array; targetSentTimestamp?: number; optionIndexes?: number[]; voteCount?: number };
  delete?: { targetSentTimestamp?: number };
  requiredProtocolVersion?: number;
}
export interface EditMessage { targetSentTimestamp?: number; dataMessage?: DataMessage }
export interface SyncSent {
  destinationE164?: string;
  destinationServiceId?: string;
  destinationServiceIdBinary?: Uint8Array;
  timestamp?: number;
  message?: DataMessage;
  editMessage?: EditMessage;
  expirationStartTimestamp?: number;
}
export interface SyncRead { senderAci?: string; senderAciBinary?: Uint8Array; timestamp?: number }
export interface SyncMessage {
  sent?: SyncSent;
  read?: SyncRead[];
  request?: { type?: number };
  blocked?: { acis?: string[]; acisBinary?: Uint8Array[]; blockedAcis?: { aciBinary?: Uint8Array }[] };
  configuration?: { readReceipts?: boolean; unidentifiedDeliveryIndicators?: boolean; typingIndicators?: boolean; linkPreviews?: boolean };
  fetchLatest?: { type?: number };
  callEvent?: CallEventPb;
  contacts?: { blob?: AttachmentPointer; complete?: boolean };
  keys?: { accountEntropyPool?: string; master?: Uint8Array };
}
export const SyncRequestType = { CONTACTS: 1, BLOCKED: 3, CONFIGURATION: 4, KEYS: 5 } as const;
export const FetchLatestType = { LOCAL_PROFILE: 1, STORAGE_MANIFEST: 2 } as const;
export const ReceiptType = { DELIVERY: 0, READ: 1, VIEWED: 2 } as const;
export interface ReceiptMessage { type?: number; timestamp?: number[] }
export const TypingAction = { STARTED: 0, STOPPED: 1 } as const;
export interface TypingMessage { timestamp?: number; action?: number; groupId?: Uint8Array }
export interface Content {
  dataMessage?: DataMessage;
  syncMessage?: SyncMessage;
  nullMessage?: { padding?: Uint8Array };
  receiptMessage?: ReceiptMessage;
  typingMessage?: TypingMessage;
  decryptionErrorMessage?: Uint8Array;
  editMessage?: EditMessage;
  callMessage?: CallMessagePb;
  storyMessage?: unknown;
  senderKeyDistributionMessage?: Uint8Array;
  /** sender's PNI + the PNI identity key's signature over the sender's ACI identity key */
  pniSignatureMessage?: { pni?: Uint8Array; signature?: Uint8Array };
  content?: string; // which oneof member is set
}

// ---- Provisioning ----
export interface ProvisionEnvelope { publicKey?: Uint8Array; body?: Uint8Array }
export interface ProvisionMessage {
  aciIdentityKeyPublic?: Uint8Array; aciIdentityKeyPrivate?: Uint8Array;
  pniIdentityKeyPublic?: Uint8Array; pniIdentityKeyPrivate?: Uint8Array;
  aci?: string; pni?: string; number?: string; provisioningCode?: string; userAgent?: string;
  profileKey?: Uint8Array; readReceipts?: boolean; provisioningVersion?: number; masterKey?: Uint8Array;
  accountEntropyPool?: string; aciBinary?: Uint8Array; pniBinary?: Uint8Array;
}
export interface ContactDetails {
  number?: string; aci?: string; aciBinary?: Uint8Array; name?: string; avatar?: { contentType?: string; length?: number }; expireTimer?: number;
}
export interface DeviceName { ephemeralPublic?: Uint8Array; syntheticIv?: Uint8Array; ciphertext?: Uint8Array }

export const EnvelopeCodec = new Codec<Envelope>(service.lookupType("signalservice.Envelope"));
export const ContentCodec = new Codec<Content>(service.lookupType("signalservice.Content"));
export const ProvisionEnvelopeCodec = new Codec<ProvisionEnvelope>(provisioning.lookupType("signalservice.ProvisionEnvelope"));
export const ProvisionMessageCodec = new Codec<ProvisionMessage>(provisioning.lookupType("signalservice.ProvisionMessage"));
export const DeviceNameCodec = new Codec<DeviceName>(deviceNameRoot.lookupType("signalservice.DeviceName"));
export const ContactDetailsCodec = new Codec<ContactDetails>(service.lookupType("signalservice.ContactDetails"));

// ---- Groups v2 state (all identifying fields are zkgroup ciphertexts) ----
export interface GroupMemberPb { userId?: Uint8Array; role?: number; joinedAtRevision?: number; profileKey?: Uint8Array; presentation?: Uint8Array }
export interface GroupPb {
  publicKey?: Uint8Array; title?: Uint8Array; avatar?: string; version?: number; members?: GroupMemberPb[];
  membersPendingProfileKey?: { member?: GroupMemberPb }[]; descriptionBytes?: Uint8Array; announcementsOnly?: boolean;
  disappearingMessagesTimer?: Uint8Array; accessControl?: { attributes?: number; members?: number; addFromInviteLink?: number };
}
export interface GroupResponsePb { group?: GroupPb; groupSendEndorsementsResponse?: Uint8Array }
export interface MemberPb { userId?: Uint8Array; role?: number; profileKey?: Uint8Array; presentation?: Uint8Array }
export interface GroupActionsPb {
  sourceUserId?: Uint8Array; version?: number; groupId?: Uint8Array;
  addMembers?: { added?: MemberPb }[];
  deleteMembers?: { deletedUserId?: Uint8Array }[];
  modifyMemberRoles?: { userId?: Uint8Array; role?: number }[];
  addPendingMembers?: { added?: { member?: MemberPb; addedByUserId?: Uint8Array; timestamp?: number } }[];
  deletePendingMembers?: { deletedUserId?: Uint8Array }[];
  modifyTitle?: { title?: Uint8Array };
  modifyAvatar?: { avatar?: string };
  modifyDescription?: { descriptionBytes?: Uint8Array };
}
export interface GroupChangePb { actions?: Uint8Array; serverSignature?: Uint8Array; changeEpoch?: number }
export interface GroupChangeResponsePb { groupChange?: GroupChangePb; groupSendEndorsementsResponse?: Uint8Array }
export interface AvatarUploadAttributesPb { key?: string; credential?: string; acl?: string; algorithm?: string; date?: string; policy?: string; signature?: string }
export interface GroupAttributeBlobPb { title?: string; avatar?: Uint8Array; descriptionText?: string; content?: string; disappearingMessagesDuration?: number }
export const GroupMemberRole = { DEFAULT: 1, ADMINISTRATOR: 2 } as const;
export const GroupCodec = new Codec<GroupPb>(groupsRoot.lookupType("signalservice.Group"));
export const GroupResponseCodec = new Codec<GroupResponsePb>(groupsRoot.lookupType("signalservice.GroupResponse"));
export const GroupAttributeBlobCodec = new Codec<GroupAttributeBlobPb>(groupsRoot.lookupType("signalservice.GroupAttributeBlob"));
export const GroupActionsCodec = new Codec<GroupActionsPb>(groupsRoot.lookupType("signalservice.GroupChange.Actions"));
export const GroupChangeCodec = new Codec<GroupChangePb>(groupsRoot.lookupType("signalservice.GroupChange"));
export const GroupChangeResponseCodec = new Codec<GroupChangeResponsePb>(groupsRoot.lookupType("signalservice.GroupChangeResponse"));
export const AvatarUploadAttributesCodec = new Codec<AvatarUploadAttributesPb>(groupsRoot.lookupType("signalservice.AvatarUploadAttributes"));

// ---- Storage Service (read-only; hypothesised wire format, see README) ----
export interface StorageManifestPb { version?: number; value?: Uint8Array }
export interface StorageItemPb { key?: Uint8Array; value?: Uint8Array }
export interface ManifestRecordPb { version?: number; sourceDevice?: number; identifiers?: { raw?: Uint8Array; type?: number }[]; recordIkm?: Uint8Array }
export const StorageIdType = { CONTACT: 1, GROUPV1: 2, GROUPV2: 3, ACCOUNT: 4 } as const;
export interface ContactRecordPb {
  aci?: string; e164?: string; profileKey?: Uint8Array; givenName?: string; familyName?: string; blocked?: boolean; whitelisted?: boolean; archived?: boolean;
  mutedUntilTimestamp?: number; unregisteredAtTimestamp?: number; systemGivenName?: string; systemFamilyName?: string; systemNickname?: string;
  hidden?: boolean; nickname?: { given?: string; family?: string };
  /** phone-number identity (UUID string) from the tolerant probe in StorageSync; may be absent */
  pni?: string;
}
export interface GroupV2RecordPb { masterKey?: Uint8Array; blocked?: boolean; archived?: boolean; mutedUntilTimestamp?: number }
export interface AccountRecordPb {
  profileKey?: Uint8Array; givenName?: string; familyName?: string; readReceipts?: boolean; typingIndicators?: boolean; linkPreviews?: boolean;
  pinnedConversations?: { contact?: { serviceId?: string; e164?: string }; groupMasterKey?: Uint8Array; legacyGroupId?: Uint8Array }[];
}
export interface StorageRecordPb { contact?: ContactRecordPb; groupV2?: GroupV2RecordPb; account?: AccountRecordPb; record?: string }
export const StorageManifestCodec = new Codec<StorageManifestPb>(storageRoot.lookupType("signalservice.StorageManifest"));
export const StorageItemsCodec = new Codec<{ items?: StorageItemPb[] }>(storageRoot.lookupType("signalservice.StorageItems"));
export const ReadOperationCodec = new Codec<{ readKey?: Uint8Array[] }>(storageRoot.lookupType("signalservice.ReadOperation"));
export const ManifestRecordCodec = new Codec<ManifestRecordPb>(storageRoot.lookupType("signalservice.ManifestRecord"));
export const StorageRecordPniProbe = new Codec<{ contact?: { pni?: string } }>(storageRoot.lookupType("signalservice.StorageRecordPniProbe"));
export const StorageRecordCodec = new Codec<StorageRecordPb>(storageRoot.lookupType("signalservice.StorageRecord"));
