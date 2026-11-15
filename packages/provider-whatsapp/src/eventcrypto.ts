// Event edits: WhatsApp sends them as secretEncryptedMessage(EVENT_EDIT) whose payload is a Message{eventMessage} encrypted
// with a key derived from the event's messageSecret (same scheme as poll votes with the use case "Event Edit" and no AAD).
// Baileys 6.7.24 has no helper for this; derived from Baileys 7's decryptEventResponse/decryptPollVote and whatsmeow.
import { randomBytes } from "node:crypto";
import { aesDecryptGCM, aesEncryptGCM, hmacSign, proto } from "@whiskeysockets/baileys";

function key(secret: Uint8Array, msgId: string, creatorJid: string, editorJid: string): Buffer {
  const sign = Buffer.concat([Buffer.from(msgId), Buffer.from(creatorJid), Buffer.from(editorJid), Buffer.from("Event Edit"), new Uint8Array([1])]);
  return hmacSign(sign, hmacSign(secret, new Uint8Array(32), "sha256"), "sha256");
}

export function encryptEventEdit(secret: Uint8Array, msgId: string, creatorJid: string, editorJid: string, eventMessage: proto.Message.IEventMessage) {
  const plain = proto.Message.encode({ eventMessage }).finish();
  const encIv = randomBytes(12);
  return { encPayload: aesEncryptGCM(plain, key(secret, msgId, creatorJid, editorJid), encIv, Buffer.alloc(0)), encIv };
}

export function tryDecryptEventEdit(enc: { encPayload?: Uint8Array | null; encIv?: Uint8Array | null }, secret: Uint8Array, msgId: string, creators: string[], editors: string[]): proto.Message | undefined {
  if (!enc.encPayload || !enc.encIv) return undefined;
  for (const c of new Set(creators)) for (const e of new Set(editors)) {
    try { return proto.Message.decode(aesDecryptGCM(enc.encPayload, key(secret, msgId, c, e), enc.encIv, Buffer.alloc(0))); } catch { /* wrong candidate */ }
  }
  return undefined;
}
