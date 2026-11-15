// Secondary-device linking (as Signal-Desktop does it):
//   1. open the provisioning websocket (via libsignal Net.connectProvisioning); the server sends an opaque
//      address -> we show  sgnl://linkdevice?uuid=<address>&pub_key=<b64 pubkey>&capabilities=...  as a QR.
//   2. the phone scans it and sends an encrypted ProvisionEnvelope through the server.
//   3. we decrypt it (libsignal RecvProvisionCiphertextState), obtaining ACI/PNI identity keys, profile key,
//      provisioning code, ...
//   4. we generate registration ids, a password, signed + last-resort Kyber prekeys and register with
//      PUT /v1/devices/link (basic auth aci:password) -> server assigns our deviceId.
//   5. one-time prekeys are uploaded once the authenticated socket is up (see keys.ts / SignalClient).
import { randomBytes } from "node:crypto";
import { IdentityKeyPair, Net, PrivateKey } from "@signalapp/libsignal-client";
import { RecvProvisionCiphertextState } from "@signalapp/libsignal-client/dist/Provisioning.js";
import { toBytes, type Bytes } from "../protocol/bytes.js";
import { deriveStorageKey } from "./storageCrypto.js";
import { ProvisionMessageCodec } from "../protocol/codec.js";
import { encryptDeviceName } from "../protocol/deviceName.js";
import type { SignalStore } from "../store/signalStore.js";
import type { AccountData } from "../store/types.js";
import { LINK_URL_CAPABILITIES, accountCapabilities } from "./constants.js";
import { newLastResortKyber, newSignedPreKey, toUploadJson } from "./keys.js";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

export function buildLinkUrl(address: string, publicKey: Uint8Array): string {
  const params = new URLSearchParams({ uuid: address, pub_key: b64(publicKey), capabilities: LINK_URL_CAPABILITIES.join(",") });
  return `sgnl://linkdevice?${params.toString()}`;
}

export class LinkAborted extends Error { constructor() { super("linking aborted"); } }

/**
 * Wait for the phone to deliver a ProvisionEnvelope. Provisioning sockets are short-lived (the server
 * closes them after about a minute), so we transparently reconnect and re-emit a fresh URL until
 * `signal` aborts.
 */
export async function waitForProvisionEnvelope(
  net: Net.Net, onUrl: (url: string) => void, signal: AbortSignal,
): Promise<{ envelope: Bytes; state: RecvProvisionCiphertextState }> {
  while (!signal.aborted) {
    const state = RecvProvisionCiphertextState.generate();
    type Outcome = { envelope: Bytes } | { closed: true };
    const outcome = await new Promise<Outcome>((resolve, reject) => {
      let conn: Net.ProvisioningConnection | undefined;
      const onAbort = () => { void conn?.disconnect(); reject(new LinkAborted()); };
      signal.addEventListener("abort", onAbort, { once: true });
      net.connectProvisioning({
        onReceivedAddress: (address, ack) => {
          ack.send(200);
          try { onUrl(buildLinkUrl(address, state.publicKey)); } catch { /* UI callback must not break linking */ }
        },
        onReceivedEnvelope: (envelope, ack) => { ack.send(200); signal.removeEventListener("abort", onAbort); resolve({ envelope }); },
        onConnectionInterrupted: () => { signal.removeEventListener("abort", onAbort); resolve({ closed: true }); },
      }, { abortSignal: undefined }).then((c) => { conn = c; if (signal.aborted) onAbort(); }, (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
    });
    if ("envelope" in outcome) return { envelope: outcome.envelope, state };
    await new Promise((r) => setTimeout(r, 500)); // brief pause before a fresh QR
  }
  throw new LinkAborted();
}

const randomRegistrationId = () => (randomBytes(2).readUInt16BE(0) % 16380) + 1;
const newPassword = () => randomBytes(16).toString("base64").replace(/=+$/, "");

/**
 * Complete linking from a decrypted provisioning envelope: generate keys, register the device and
 * persist everything. Returns the new account (also stored in `store`).
 */
export async function completeLinking(
  net: Net.Net, store: SignalStore, envelope: Bytes, state: RecvProvisionCiphertextState, deviceName: string,
): Promise<AccountData> {
  const msg = ProvisionMessageCodec.decode(state.decryptEnvelope(envelope));
  if (!msg.aciIdentityKeyPrivate || !msg.provisioningCode || !msg.aci) throw new Error("incomplete provisioning message");

  const aciPriv = PrivateKey.deserialize(toBytes(msg.aciIdentityKeyPrivate));
  const aciPair = new IdentityKeyPair(aciPriv.getPublicKey(), aciPriv);
  let pniPair: IdentityKeyPair | undefined;
  if (msg.pniIdentityKeyPrivate && msg.pni) {
    const pp = PrivateKey.deserialize(toBytes(msg.pniIdentityKeyPrivate));
    pniPair = new IdentityKeyPair(pp.getPublicKey(), pp);
  }

  const password = newPassword();
  const account: AccountData = {
    aci: msg.aci, pni: pniPair ? msg.pni : undefined, deviceId: 0, password,
    registrationId: randomRegistrationId(), pniRegistrationId: pniPair ? randomRegistrationId() : undefined,
    aciIdentity: b64(aciPair.serialize()), pniIdentity: pniPair ? b64(pniPair.serialize()) : undefined,
    profileKey: msg.profileKey ? b64(msg.profileKey) : undefined, readReceipts: msg.readReceipts ?? true, linkedAt: Date.now(),
  };
  store.setAccount({ ...account });
  // The provisioning message may already carry the account entropy pool / master key: keep only the derived storage key.
  const sk = deriveStorageKey({ accountEntropyPool: msg.accountEntropyPool || undefined, master: msg.masterKey });
  if (sk) store.data.storage.key = sk.toString("base64"); // identities must be readable by the key generators below

  const aciSigned = await newSignedPreKey(store, "aci");
  const aciLastResort = await newLastResortKyber(store, "aci");
  const pniSigned = pniPair ? await newSignedPreKey(store, "pni") : undefined;
  const pniLastResort = pniPair ? await newLastResortKyber(store, "pni") : undefined;

  const body = {
    verificationCode: msg.provisioningCode,
    accountAttributes: {
      fetchesMessages: true,
      name: encryptDeviceName(deviceName, aciPair.publicKey),
      registrationId: account.registrationId,
      pniRegistrationId: account.pniRegistrationId,
      capabilities: accountCapabilities(!pniPair),
    },
    aciSignedPreKey: toUploadJson(aciSigned),
    aciPqLastResortPreKey: toUploadJson(aciLastResort),
    pniSignedPreKey: pniSigned && toUploadJson(pniSigned),
    pniPqLastResortPreKey: pniLastResort && toUploadJson(pniLastResort),
  };

  // UNVERIFIED against the live service: Signal-Desktop performs this PUT over plain HTTPS with pinned CA;
  // here it goes over libsignal's unauthenticated websocket with an explicit Authorization header (which
  // the server's DeviceController reads as a normal header parameter). See README "Unverified".
  const chat = await net.connectUnauthenticatedChat({ onConnectionInterrupted: () => {} });
  try {
    const res = await chat.fetch({
      verb: "PUT", path: "/v1/devices/link",
      headers: [
        ["Authorization", `Basic ${Buffer.from(`${msg.aci}:${password}`).toString("base64")}`],
        ["Content-Type", "application/json"],
      ],
      body: Buffer.from(JSON.stringify(body)),
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`device link rejected (HTTP ${res.status})`);
    const json = JSON.parse(Buffer.from(res.body ?? new Uint8Array()).toString("utf8")) as { uuid?: string; pni?: string; deviceId?: number };
    if (json.uuid && json.uuid.toLowerCase() !== msg.aci.toLowerCase()) throw new Error("server returned unexpected ACI");
    account.deviceId = json.deviceId ?? 1;
  } finally {
    await chat.disconnect().catch(() => {});
  }
  store.setAccount(account);
  await store.flush();
  return account;
}
