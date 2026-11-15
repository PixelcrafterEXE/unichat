// Shared fixtures for the sealed-sender / group-modify tests: generated keys only, fake servers, no network.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IdentityKeyPair, PrivateKey, SenderCertificate, ServerCertificate, sealedSenderDecryptMessage, type PublicKey,
} from "@signalapp/libsignal-client";
import { ContentCodec, type Content } from "../protocol/codec.js";
import { unpadContent } from "../protocol/padding.js";
import { SignalStore } from "../store/signalStore.js";
import { identityOf, newLastResortKyber, newSignedPreKey } from "../service/keys.js";

export const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
export const ME = "22222222-2222-4222-8222-222222222222";
export const A = "11111111-1111-4111-8111-111111111111";
export const B = "44444444-4444-4444-8444-444444444444";
export const C = "55555555-5555-4555-8555-555555555555";

export async function makeStore(aci: string, deviceId: number, profileKey?: Uint8Array): Promise<SignalStore> {
  const s = new SignalStore(mkdtempSync(join(tmpdir(), "unimsg-signal-fx-")));
  await s.load();
  s.setAccount({
    aci, deviceId, password: "pw", registrationId: 100 + deviceId + (aci.charCodeAt(0) % 50), aciIdentity: b64(IdentityKeyPair.generate().serialize()),
    readReceipts: true, linkedAt: 0, ...(profileKey ? { profileKey: b64(profileKey) } : {}),
  });
  return s;
}

export interface Peer { aci: string; deviceId: number; store: SignalStore; profileKey: Uint8Array; bundle: object }

export async function makePeer(aci: string, profileKey: Uint8Array, deviceId = 1): Promise<Peer> {
  const store = await makeStore(aci, deviceId, profileKey);
  const spk = await newSignedPreKey(store, "aci");
  const kyber = await newLastResortKyber(store, "aci");
  const a = store.requireAccount();
  const bundle = {
    identityKey: b64(identityOf(store, "aci").publicKey.serialize()),
    devices: [{
      deviceId, registrationId: a.registrationId,
      signedPreKey: { keyId: spk.id(), publicKey: b64(spk.publicKey().serialize()), signature: b64(spk.signature()) },
      pqPreKey: { keyId: kyber.id(), publicKey: b64(kyber.publicKey().serialize()), signature: b64(kyber.signature()) },
    }],
  };
  return { aci, deviceId, store, profileKey, bundle };
}

/** Test PKI: a trust root, and a sender certificate for `store`'s device signed by it. */
export function makePki(me: SignalStore) {
  const root = PrivateKey.generate();
  const serverKey = PrivateKey.generate();
  const serverCert = ServerCertificate.new(1, serverKey.getPublicKey(), root);
  const a = me.requireAccount();
  const cert = SenderCertificate.new(a.aci, null, a.deviceId, identityOf(me, "aci").publicKey, Date.now() + 24 * 3600_000, serverCert, serverKey);
  return { rootPublic: root.getPublicKey() as PublicKey, certB64: b64(cert.serialize()) };
}

/** Sealed-sender decrypt as the recipient; returns the Content. */
export async function peerDecrypt(peer: Peer, payload: Uint8Array, root: PublicKey): Promise<{ content: Content; sender: string }> {
  const st = peer.store.stores("aci");
  const res = await sealedSenderDecryptMessage(new Uint8Array(payload), root, Date.now(), null, peer.aci, peer.deviceId, st.sessions, st.identities, st.preKeys, st.signedPreKeys, st.kyber);
  return { content: ContentCodec.decode(unpadContent(res.message())), sender: res.senderUuid() };
}

export const json = (o: unknown) => ({ status: 200, body: Buffer.from(JSON.stringify(o)) });
