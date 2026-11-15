// Prekey generation, persistence and upload (EC one-time, signed EC, Kyber one-time, Kyber last-resort).
import {
  IdentityKeyPair, KEMKeyPair, KyberPreKeyRecord, PreKeyRecord, PrivateKey, ServiceIdKind, SignedPreKeyRecord,
} from "@signalapp/libsignal-client";
import type { AuthChat } from "./chatTypes.js";
import type { SignalStore } from "../store/signalStore.js";
import type { IdKind } from "../store/types.js";
import { PREKEY_BATCH, PREKEY_LOW_WATERMARK, SIGNED_PREKEY_ROTATION_MS } from "./constants.js";

const MAX_ID = 0x7fffffff;
const kindOf = (k: IdKind) => (k === "aci" ? ServiceIdKind.Aci : ServiceIdKind.Pni);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

function nextId(store: SignalStore, kind: IdKind, field: "nextPreKeyId" | "nextSignedPreKeyId" | "nextKyberPreKeyId"): number {
  const c = store.data.counters[kind];
  const id = c[field];
  c[field] = id >= MAX_ID - 1 ? 1 : id + 1;
  return id;
}

export function identityOf(store: SignalStore, kind: IdKind): IdentityKeyPair {
  const a = store.requireAccount();
  const raw = kind === "aci" ? a.aciIdentity : a.pniIdentity;
  if (!raw) throw new Error(`no ${kind} identity`);
  return IdentityKeyPair.deserialize(new Uint8Array(Buffer.from(raw, "base64")));
}

export async function newSignedPreKey(store: SignalStore, kind: IdKind): Promise<SignedPreKeyRecord> {
  const id = nextId(store, kind, "nextSignedPreKeyId");
  const priv = PrivateKey.generate();
  const pub = priv.getPublicKey();
  const sig = identityOf(store, kind).privateKey.sign(pub.serialize());
  const rec = SignedPreKeyRecord.new(id, Date.now(), pub, priv, sig);
  await store.stores(kind).signedPreKeys.saveSignedPreKey(id, rec);
  store.data.lastSignedPreKeyRotation[kind] = Date.now();
  return rec;
}

export async function newLastResortKyber(store: SignalStore, kind: IdKind): Promise<KyberPreKeyRecord> {
  const rec = await newKyber(store, kind);
  store.data.lastResortKyber.push(`${kind}:${rec.id()}`);
  return rec;
}

async function newKyber(store: SignalStore, kind: IdKind): Promise<KyberPreKeyRecord> {
  const id = nextId(store, kind, "nextKyberPreKeyId");
  const kp = KEMKeyPair.generate();
  const sig = identityOf(store, kind).privateKey.sign(kp.getPublicKey().serialize());
  const rec = KyberPreKeyRecord.new(id, Date.now(), kp, sig);
  await store.stores(kind).kyber.saveKyberPreKey(id, rec);
  return rec;
}

export async function newOneTimePreKeys(store: SignalStore, kind: IdKind, n = PREKEY_BATCH): Promise<PreKeyRecord[]> {
  const out: PreKeyRecord[] = [];
  for (let i = 0; i < n; i++) {
    const id = nextId(store, kind, "nextPreKeyId");
    const priv = PrivateKey.generate();
    const rec = PreKeyRecord.new(id, priv.getPublicKey(), priv);
    await store.stores(kind).preKeys.savePreKey(id, rec);
    out.push(rec);
  }
  return out;
}

export async function newOneTimeKyberKeys(store: SignalStore, kind: IdKind, n = PREKEY_BATCH): Promise<KyberPreKeyRecord[]> {
  const out: KyberPreKeyRecord[] = [];
  for (let i = 0; i < n; i++) out.push(await newKyber(store, kind));
  return out;
}

/** JSON shape the server expects for signed EC and Kyber keys in PUT /v1/devices/link. */
export function toUploadJson(rec: SignedPreKeyRecord | KyberPreKeyRecord) {
  return { keyId: rec.id(), publicKey: b64(rec.publicKey().serialize()), signature: b64(rec.signature()) };
}

/** Upload a fresh batch of one-time keys for one identity (replaces the server-side stock). */
export async function uploadOneTimeKeys(chat: AuthChat, store: SignalStore, kind: IdKind): Promise<void> {
  const ec = await newOneTimePreKeys(store, kind);
  const kem = await newOneTimeKyberKeys(store, kind);
  await chat.setOneTimeEcPreKeys({ identity: kindOf(kind), preKeys: ec.map((r) => ({ keyId: r.id(), publicKey: r.publicKey() })) });
  await chat.setOneTimeKemPreKeys({
    identity: kindOf(kind),
    preKeys: kem.map((r) => ({ keyId: r.id(), publicKey: r.publicKey(), signature: r.signature() })),
  });
  await store.flush();
}

/** Called after every (re)connect: top up one-time keys, rotate the signed + last-resort keys when stale. */
export async function refreshKeys(chat: AuthChat, store: SignalStore): Promise<void> {
  const counts = await chat.getPreKeyCount();
  const a = store.requireAccount();
  const kinds: IdKind[] = a.pniIdentity ? ["aci", "pni"] : ["aci"];
  for (const kind of kinds) {
    const ec = kind === "aci" ? counts.aciEcPreKeyCount : counts.pniEcPreKeyCount;
    const kem = kind === "aci" ? counts.aciKemPreKeyCount : counts.pniKemPreKeyCount;
    if (ec < PREKEY_LOW_WATERMARK || kem < PREKEY_LOW_WATERMARK) await uploadOneTimeKeys(chat, store, kind);
    if (Date.now() - store.data.lastSignedPreKeyRotation[kind] > SIGNED_PREKEY_ROTATION_MS) {
      const spk = await newSignedPreKey(store, kind);
      const lr = await newLastResortKyber(store, kind);
      await chat.setSignedEcPreKey({ identity: kindOf(kind), preKey: { keyId: spk.id(), publicKey: spk.publicKey(), signature: spk.signature() } });
      await chat.setLastResortKemPreKey({ identity: kindOf(kind), preKey: { keyId: lr.id(), publicKey: lr.publicKey(), signature: lr.signature() } });
      await store.flush();
    }
  }
}
