// Envelope -> plaintext Content. Mirrors Signal-Desktop's MessageReceiver.decrypt():
//   type 1  DOUBLE_RATCHET      signalDecrypt
//   type 3  PREKEY_MESSAGE      signalDecryptPreKey (consumes one-time EC/Kyber prekeys)
//   type 6  UNIDENTIFIED_SENDER sealed sender: outer layer -> USMC -> (1:1 ratchet | sender key)
//   type 5  SERVER_DELIVERY_RECEIPT carries no content (handled by caller)
//   type 8  PLAINTEXT_CONTENT   decryption-error receipts only (ignored; TODO resend/session reset)
import {
  Aci, CiphertextMessageType, Pni, PreKeySignalMessage, ProtocolAddress, SenderKeyDistributionMessage, SignalMessage,
  groupDecrypt, processSenderKeyDistributionMessage, sealedSenderDecryptMessage, sealedSenderDecryptToUsmc,
  signalDecrypt, signalDecryptPreKey, type ServiceId,
} from "@signalapp/libsignal-client";
import { toBytes } from "../protocol/bytes.js";
import { ContentCodec, EnvelopeType, type Content, type Envelope } from "../protocol/codec.js";
import { serviceIdFromBinary } from "../protocol/ids.js";
import { unpadContent } from "../protocol/padding.js";
import type { SignalStore } from "../store/signalStore.js";
import type { IdKind } from "../store/types.js";
import { trustRoots } from "./constants.js";

export interface Decrypted {
  senderAci: string;       // UUID string of the sender account
  senderDevice: number;
  content: Content;
  sealed: boolean;
  /** Phone number in the server-signed sealed-sender certificate (absent for unsealed / number-hidden senders). */
  senderE164?: string;
}

/** Thrown for envelopes we cannot process; `code` is safe to surface (no content). */
export class EnvelopeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "EnvelopeError"; }
}

/** Fill legacy string fields from the *Binary variants (servers may send only the binary form). */
export function normalizeEnvelope(env: Envelope): Envelope {
  const out = { ...env };
  out.sourceServiceId ||= serviceIdFromBinary(env.sourceServiceIdBinary);
  out.destinationServiceId ||= serviceIdFromBinary(env.destinationServiceIdBinary);
  return out;
}

export function parseServiceId(s: string): ServiceId {
  return s.toUpperCase().startsWith("PNI:") ? Pni.parseFromServiceIdString(s) : Aci.parseFromServiceIdString(s);
}

/** Which of our identities the envelope was addressed to. */
export function destinationKind(store: SignalStore, env: Envelope): IdKind {
  const a = store.requireAccount();
  const d = env.destinationServiceId?.replace(/^PNI:/i, "").toLowerCase();
  return a.pni && d === a.pni.toLowerCase() && env.destinationServiceId?.toUpperCase().startsWith("PNI:") ? "pni" : "aci";
}

export async function decryptEnvelope(store: SignalStore, rawEnv: Envelope): Promise<Decrypted | null> {
  const env = normalizeEnvelope(rawEnv);
  const a = store.requireAccount();
  const kind = destinationKind(store, env);
  const st = store.stores(kind);
  const localId: ServiceId = kind === "pni" ? Pni.fromUuid(a.pni!) : Aci.fromUuid(a.aci);
  const local = ProtocolAddress.new(localId, a.deviceId);
  const body = env.content ? toBytes(env.content) : undefined;

  const finish = async (plain: Uint8Array, senderAci: string, senderDevice: number, sealed: boolean, senderE164?: string | null): Promise<Decrypted> => {
    const content = ContentCodec.decode(unpadContent(plain));
    if (content.senderKeyDistributionMessage && content.senderKeyDistributionMessage.length > 0) {
      const sender = ProtocolAddress.new(Aci.fromUuid(senderAci), senderDevice);
      await processSenderKeyDistributionMessage(sender, SenderKeyDistributionMessage.deserialize(toBytes(content.senderKeyDistributionMessage)), store.senderKeys);
    }
    return { senderAci, senderDevice, content, sealed, ...(senderE164 ? { senderE164 } : {}) };
  };

  switch (env.type ?? EnvelopeType.UNKNOWN) {
    case EnvelopeType.DOUBLE_RATCHET:
    case EnvelopeType.PREKEY_MESSAGE: {
      if (!body) throw new EnvelopeError("envelope-no-content");
      if (!env.sourceServiceId || env.sourceDeviceId === undefined) throw new EnvelopeError("envelope-no-source");
      const srcId = parseServiceId(env.sourceServiceId);
      const src = ProtocolAddress.new(srcId, env.sourceDeviceId);
      const plain = env.type === EnvelopeType.DOUBLE_RATCHET
        ? await signalDecrypt(SignalMessage.deserialize(body), src, local, st.sessions, st.identities)
        : await signalDecryptPreKey(PreKeySignalMessage.deserialize(body), src, local, st.sessions, st.identities, st.preKeys, st.signedPreKeys, st.kyber);
      return finish(plain, srcId.getRawUuid(), env.sourceDeviceId, false);
    }
    case EnvelopeType.UNIDENTIFIED_SENDER: {
      if (!body) throw new EnvelopeError("envelope-no-content");
      const usmc = await sealedSenderDecryptToUsmc(body, st.identities);
      const cert = usmc.senderCertificate();
      const now = env.serverTimestamp ?? Date.now();
      const root = trustRoots().find((r) => cert.validate(r, now));
      if (!root) throw new Error("sealed sender certificate not signed by a trusted root");
      if (usmc.msgType() === CiphertextMessageType.SenderKey) {
        const sender = ProtocolAddress.new(cert.senderUuid(), cert.senderDeviceId());
        const plain = await groupDecrypt(sender, store.senderKeys, usmc.contents());
        return finish(plain, cert.senderUuid(), cert.senderDeviceId(), true, cert.senderE164());
      }
      const res = await sealedSenderDecryptMessage(body, root, now, null, kind === "pni" ? a.pni! : a.aci, a.deviceId,
        st.sessions, st.identities, st.preKeys, st.signedPreKeys, st.kyber);
      return finish(res.message(), res.senderUuid(), res.deviceId(), true, res.senderE164());
    }
    case EnvelopeType.PLAINTEXT_CONTENT:
    case EnvelopeType.SERVER_DELIVERY_RECEIPT:
    case EnvelopeType.UNKNOWN:
      return null; // nothing to display
    default:
      throw new EnvelopeError(`envelope-type-${env.type}`);
  }
}
