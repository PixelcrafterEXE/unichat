// Groups v2 identity helpers. The *identifier* is derived locally (pure zkgroup math). Group STATE
// (title, avatar, members) is fetched and decrypted by ./groupState.ts.
import { GroupMasterKey, GroupSecretParams } from "@signalapp/libsignal-client/dist/zkgroup/index.js";
import { toBytes } from "../protocol/bytes.js";

export function groupIdFromMasterKey(masterKey: Uint8Array): Uint8Array {
  const secret = GroupSecretParams.deriveFromMasterKey(new GroupMasterKey(toBytes(masterKey)));
  return secret.getPublicParams().getGroupIdentifier().serialize();
}
export const groupChatId = (groupId: Uint8Array) => `g.${Buffer.from(groupId).toString("base64url")}`;
export const isGroupChatId = (id: string) => id.startsWith("g.");
