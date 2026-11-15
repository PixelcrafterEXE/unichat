// Hand-written message layouts (field numbers = wire facts from the public protocol docs, PROTOCOL-NOTES.md). Names are ours.
import type { Schema } from "./proto.js";
const u32 = (n: number, rep = false) => ({ n, t: "u32" as const, rep });
const u64 = (n: number) => ({ n, t: "u64" as const });
const fx = (n: number) => ({ n, t: "f64" as const });
const str = (n: number, rep = false) => ({ n, t: "string" as const, rep });
const byt = (n: number, rep = false) => ({ n, t: "bytes" as const, rep });
const bool = (n: number) => ({ n, t: "bool" as const });
const msg = (n: number, s: Schema, rep = false) => ({ n, t: s, rep });

export const Unit: Schema = {};
export const Blob: Schema = { id: byt(1), nonce: byt(2), key: byt(3), uploadedAt: u64(4) };
export const BlobData: Schema = { id: byt(1), data: byt(2) };
export const Image: Schema = { type: u32(1), blob: msg(2, Blob) };
export const DeltaImage: Schema = { removed: msg(1, Unit), updated: msg(2, Image) };
export const GroupIdentity: Schema = { groupId: fx(1), creatorIdentity: str(2) };
export const Identities: Schema = { identities: str(1, true) };

// ---- rendezvous / join / url ----
export const RendezvousInit: Schema = {
  version: u32(1), ak: byt(2),
  relayedWebSocket: msg(3, { pathId: u32(1), networkCost: u32(2), url: str(3) }),
  directTcpServer: msg(4, { port: u32(1), ipAddresses: msg(2, { pathId: u32(1), networkCost: u32(2), ip: str(3) }, true) }),
};
export const HsHello: Schema = { challenge: byt(1), etk: byt(2) };        // RRD -> RID
export const HsAuth: Schema = { response: byt(1) };                         // RRD -> RID
export const HsAuthHello: Schema = { response: byt(1), challenge: byt(2), etk: byt(3) }; // RID -> RRD
export const Nominate: Schema = {};
export const DeviceGroupJoinRequestOrOffer: Schema = {
  version: u32(1), variant: msg(2, { requestToJoin: msg(1, Unit), offerToJoin: msg(2, Unit) }), d2dProtocolVersion: u32(4), rendezvousInit: msg(3, RendezvousInit),
};

// ---- d2d sync data ----
export const WorkAvailability: Schema = { category: u32(1), description: str(2) };
export const UserProfile: Schema = {
  nickname: str(1), profilePicture: msg(2, DeltaImage),
  profilePictureShareWith: msg(3, { nobody: msg(1, Unit), everyone: msg(2, Unit), allowList: msg(3, Identities) }),
};
export const Contact: Schema = {
  identity: str(1), publicKey: byt(2), createdAt: u64(3), firstName: str(4), lastName: str(5), nickname: str(6), verificationLevel: u32(7),
  identityType: u32(8), acquaintanceLevel: u32(9), activityState: u32(10), conversationCategory: u32(11), conversationVisibility: u32(12),
  syncState: u32(13), contactDefinedProfilePicture: msg(14, DeltaImage), userDefinedProfilePicture: msg(15, DeltaImage), featureMask: u64(18),
};
export const Group: Schema = {
  groupIdentity: msg(1, GroupIdentity), name: str(2), createdAt: u64(3), conversationCategory: u32(4), conversationVisibility: u32(5), userState: u32(6),
  profilePicture: msg(7, DeltaImage), memberIdentities: msg(8, Identities),
};
export const Settings: Schema = {
  contactSyncPolicy: u32(1), unknownContactPolicy: u32(2), readReceiptPolicy: u32(3), typingIndicatorPolicy: u32(4),
  blockedIdentities: msg(9, Identities), excludeFromSyncIdentities: msg(10, Identities),
};

// ---- join ----
export const EssentialData: Schema = {
  identityData: msg(2, { identity: str(1), ck: byt(2), cspDeviceCookie: byt(3), cspServerGroup: str(4) }),
  deviceGroupData: msg(3, { dgk: byt(1) }),
  userProfile: msg(4, UserProfile), settings: msg(5, Settings),
  contacts: msg(7, { contact: msg(1, Contact), lastUpdateAt: u64(2) }, true),
  groups: msg(8, { group: msg(1, Group), lastUpdateAt: u64(2) }, true),
  cspHashedNonces: byt(10, true), d2dHashedNonces: byt(11, true),
};
export const EdToNd: Schema = { begin: msg(1, Unit), blobData: msg(2, BlobData), essentialData: msg(3, EssentialData) };
export const NdToEd: Schema = { registered: msg(1, Unit) };

// ---- d2m ----
export const ClientUrlInfo: Schema = { deviceGroupId: byt(1), serverGroup: str(3) };
export const D2mServerHello: Schema = { version: u32(1), esk: byt(2), challenge: byt(3) };
export const D2mClientHello: Schema = {
  version: u32(1), response: byt(2), deviceId: fx(3), deviceSlotsExhaustedPolicy: u32(4), deviceSlotExpirationPolicy: u32(5),
  encryptedDeviceInfo: byt(6), expectedDeviceSlotState: u32(7),
};
export const D2mServerInfo: Schema = { currentTime: u64(4), maxDeviceSlots: u32(1), deviceSlotState: u32(2), encryptedSharedDeviceData: byt(3), reflectionQueueLength: u32(5) };
export const DevicesInfo: Schema = {
  augmentedDeviceInfo: { n: 1, t: { map: ["f64" as const, { encryptedDeviceInfo: byt(1), connectedSince: u64(2), deviceSlotExpirationPolicy: u32(3), lastDisconnectAt: u64(4) }] } },
};
export const DropDevice: Schema = { deviceId: fx(1) };
export const BeginTransaction: Schema = { encryptedScope: byt(1), ttl: u32(2) };
export const TransactionInfo: Schema = { deviceId: fx(1), encryptedScope: byt(2) };

// ---- d2d ----
export const DeviceInfo: Schema = { padding: byt(1), platform: u32(2), platformDetails: str(3), appVersion: str(4), label: str(5) };
export const SharedDeviceData: Schema = { padding: byt(1), version: u32(2) };
export const TransactionScope: Schema = { scope: u32(1) };
export const ConversationId: Schema = { contact: str(1), distributionList: fx(2), group: msg(3, GroupIdentity) };
export const OutgoingMessage: Schema = { conversation: msg(1, ConversationId), messageId: fx(2), createdAt: u64(3), type: u32(4), body: byt(5), nonces: byt(7, true), threadMessageId: fx(6) };
const MsgUpdateKey = { conversation: msg(1, ConversationId), messageId: fx(2) };
export const OutgoingMessageUpdate: Schema = { updates: msg(1, { ...MsgUpdateKey, sent: msg(3, Unit) }, true) };
export const IncomingMessage: Schema = { senderIdentity: str(1), messageId: fx(2), createdAt: u64(3), type: u32(5), body: byt(6), nonce: byt(7) };
export const IncomingMessageUpdate: Schema = { updates: msg(1, { ...MsgUpdateKey, read: msg(3, { at: u64(1) }) }, true) };
export const ContactSync: Schema = { create: msg(1, { contact: msg(1, Contact) }), update: msg(2, { contact: msg(1, Contact) }) };
export const GroupSync: Schema = {
  create: msg(1, { group: msg(1, Group) }),
  update: msg(2, { group: msg(1, Group), memberStateChanges: { n: 2, t: { map: ["string" as const, "u32" as const] } } }),
  delete: msg(3, { groupIdentity: msg(1, GroupIdentity) }),
};
export const UserProfileSync: Schema = { update: msg(1, { userProfile: msg(1, UserProfile) }) };
export const SettingsSync: Schema = { update: msg(1, { settings: msg(1, Settings) }) };
export const Envelope: Schema = {
  padding: byt(1), deviceId: fx(13), protocolVersion: u32(3),
  outgoingMessage: msg(2, OutgoingMessage), outgoingMessageUpdate: msg(10, OutgoingMessageUpdate),
  incomingMessage: msg(4, IncomingMessage), incomingMessageUpdate: msg(11, IncomingMessageUpdate),
  userProfileSync: msg(5, UserProfileSync), contactSync: msg(6, ContactSync), groupSync: msg(7, GroupSync),
  distributionListSync: byt(8), settingsSync: msg(9, SettingsSync), mdmParameterSync: byt(12),
};

// ---- csp e2e protobuf bodies ----
export const MessageMetadata: Schema = { padding: byt(1), nickname: str(2), messageId: fx(3), createdAt: u64(4) };
export const Reaction: Schema = { messageId: fx(1), apply: byt(2), withdraw: byt(3) };
export const EditMessage: Schema = { messageId: fx(1), text: str(2) };
export const DeleteMessage: Schema = { messageId: fx(1) };

export const Enum = {
  scope: { USER_PROFILE_SYNC: 0, CONTACT_SYNC: 1, GROUP_SYNC: 2, DISTRIBUTION_LIST_SYNC: 3, SETTINGS_SYNC: 4, MDM_PARAMETER_SYNC: 5, NEW_DEVICE_SYNC: 6, DROP_DEVICE: 7, WORK_SYNC_DELTA: 8 },
  acquaintance: { DIRECT: 0, GROUP_OR_DELETED: 1 },
  userState: { MEMBER: 0, KICKED: 1, LEFT: 2 },
  slotState: { NEW: 0, EXISTING: 1 },
  platformDesktop: 3,
  d2dVersion: 0x0003,
} as const;
