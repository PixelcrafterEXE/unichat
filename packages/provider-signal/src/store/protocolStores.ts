// libsignal-client store implementations backed by SignalStore data (see ./signalStore.ts).
import {
  Direction, IdentityChange, IdentityKeyPair, IdentityKeyStore, KyberPreKeyRecord, KyberPreKeyStore, PreKeyRecord,
  PreKeyStore, PrivateKey, ProtocolAddress, PublicKey, SenderKeyRecord, SenderKeyStore, SessionRecord, SessionStore,
  SignedPreKeyRecord, SignedPreKeyStore,
} from "@signalapp/libsignal-client";
import type { SignalStore } from "./signalStore.js";
import type { IdKind } from "./types.js";

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** Sessions for one local identity (ACI or PNI). */
export class Sessions extends SessionStore {
  constructor(private readonly s: SignalStore, private readonly kind: IdKind) { super(); }
  private k(a: ProtocolAddress) { return `${this.kind}:${a.toString()}`; }
  async saveSession(name: ProtocolAddress, record: SessionRecord): Promise<void> {
    this.s.data.sessions[this.k(name)] = b64(record.serialize()); this.s.touch();
  }
  async getSession(name: ProtocolAddress): Promise<SessionRecord | null> {
    const v = this.s.data.sessions[this.k(name)];
    return v ? SessionRecord.deserialize(unb64(v)) : null;
  }
  async getExistingSessions(addresses: ProtocolAddress[]): Promise<SessionRecord[]> {
    return addresses.map((a) => {
      const v = this.s.data.sessions[this.k(a)];
      if (!v) throw new Error("no session for requested address");
      return SessionRecord.deserialize(unb64(v));
    });
  }
}

/**
 * Identity store with trust-on-first-use. A changed peer identity is ACCEPTED and replaced
 * (like Signal's default "non-blocking" safety-number change) but reported through `onIdentityChanged`
 * so the connector can surface it. TODO: optional strict mode that blocks until the user verifies.
 */
export class Identities extends IdentityKeyStore {
  constructor(private readonly s: SignalStore, private readonly kind: IdKind,
              private readonly onIdentityChanged?: (address: string) => void) { super(); }
  private pair(): IdentityKeyPair {
    const a = this.s.requireAccount();
    const raw = this.kind === "aci" ? a.aciIdentity : a.pniIdentity;
    if (!raw) throw new Error(`no ${this.kind} identity`);
    return IdentityKeyPair.deserialize(unb64(raw));
  }
  async getIdentityKey(): Promise<PrivateKey> { return this.pair().privateKey; }
  async getLocalRegistrationId(): Promise<number> {
    const a = this.s.requireAccount();
    const id = this.kind === "aci" ? a.registrationId : a.pniRegistrationId;
    if (id === undefined) throw new Error(`no ${this.kind} registration id`);
    return id;
  }
  async saveIdentity(name: ProtocolAddress, key: PublicKey): Promise<IdentityChange> {
    const k = name.toString();
    const old = this.s.data.identities[k];
    const now = b64(key.serialize());
    if (old === now) return IdentityChange.NewOrUnchanged;
    this.s.data.identities[k] = now; this.s.touch();
    if (old === undefined) return IdentityChange.NewOrUnchanged;
    this.onIdentityChanged?.(k);
    return IdentityChange.ReplacedExisting;
  }
  async isTrustedIdentity(_name: ProtocolAddress, _key: PublicKey, _direction: Direction): Promise<boolean> {
    return true; // TOFU, see class comment
  }
  async getIdentity(name: ProtocolAddress): Promise<PublicKey | null> {
    const v = this.s.data.identities[name.toString()];
    return v ? PublicKey.deserialize(unb64(v)) : null;
  }
}

export class PreKeys extends PreKeyStore {
  constructor(private readonly s: SignalStore, private readonly kind: IdKind) { super(); }
  async savePreKey(id: number, record: PreKeyRecord): Promise<void> {
    this.s.data.preKeys[`${this.kind}:${id}`] = b64(record.serialize()); this.s.touch();
  }
  async getPreKey(id: number): Promise<PreKeyRecord> {
    const v = this.s.data.preKeys[`${this.kind}:${id}`];
    if (!v) throw new Error("unknown one-time prekey");
    return PreKeyRecord.deserialize(unb64(v));
  }
  async removePreKey(id: number): Promise<void> {
    delete this.s.data.preKeys[`${this.kind}:${id}`]; this.s.touch();
  }
}

export class SignedPreKeys extends SignedPreKeyStore {
  constructor(private readonly s: SignalStore, private readonly kind: IdKind) { super(); }
  async saveSignedPreKey(id: number, record: SignedPreKeyRecord): Promise<void> {
    this.s.data.signedPreKeys[`${this.kind}:${id}`] = b64(record.serialize()); this.s.touch();
  }
  async getSignedPreKey(id: number): Promise<SignedPreKeyRecord> {
    const v = this.s.data.signedPreKeys[`${this.kind}:${id}`];
    if (!v) throw new Error("unknown signed prekey");
    return SignedPreKeyRecord.deserialize(unb64(v));
  }
}

export class KyberPreKeys extends KyberPreKeyStore {
  constructor(private readonly s: SignalStore, private readonly kind: IdKind) { super(); }
  async saveKyberPreKey(id: number, record: KyberPreKeyRecord): Promise<void> {
    this.s.data.kyberPreKeys[`${this.kind}:${id}`] = b64(record.serialize()); this.s.touch();
  }
  async getKyberPreKey(id: number): Promise<KyberPreKeyRecord> {
    const v = this.s.data.kyberPreKeys[`${this.kind}:${id}`];
    if (!v) throw new Error("unknown kyber prekey");
    return KyberPreKeyRecord.deserialize(unb64(v));
  }
  async markKyberPreKeyUsed(id: number, signedPreKeyId: number, baseKey: PublicKey): Promise<void> {
    const key = `${this.kind}:${id}`;
    const d = this.s.data;
    if (d.lastResortKyber.includes(key)) {
      const use = `${key}:${signedPreKeyId}:${b64(baseKey.serialize())}`;
      if (d.kyberUsed.includes(use)) throw new Error("last-resort kyber prekey replay");
      d.kyberUsed.push(use);
      if (d.kyberUsed.length > 5000) d.kyberUsed.splice(0, d.kyberUsed.length - 5000);
    } else {
      delete d.kyberPreKeys[key];
    }
    this.s.touch();
  }
}

export class SenderKeys extends SenderKeyStore {
  constructor(private readonly s: SignalStore) { super(); }
  private k(sender: ProtocolAddress, dist: string) { return `${sender.toString()}|${dist}`; }
  async saveSenderKey(sender: ProtocolAddress, distributionId: string, record: SenderKeyRecord): Promise<void> {
    this.s.data.senderKeys[this.k(sender, distributionId)] = b64(record.serialize()); this.s.touch();
  }
  async getSenderKey(sender: ProtocolAddress, distributionId: string): Promise<SenderKeyRecord | null> {
    const v = this.s.data.senderKeys[this.k(sender, distributionId)];
    return v ? SenderKeyRecord.deserialize(unb64(v)) : null;
  }
}

export interface KindStores {
  sessions: Sessions; identities: Identities; preKeys: PreKeys; signedPreKeys: SignedPreKeys; kyber: KyberPreKeys;
}
