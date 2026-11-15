// Sealed-sender (unidentified delivery) building blocks for SENDING.
//   * sender certificate:  GET /v1/certificate/delivery?includeE164=false  (authenticated chat connection) -> { certificate: b64 }
//     Cached until shortly before it expires (they are valid ~24 h). Validated against Signal's production trust roots and
//     checked to be OUR aci/device before use.
//   * access key of a recipient: ProfileKey.deriveAccessKey() of the profile key learned from their messages. Accounts that
//     allow "unrestricted" unidentified access (profile flag) are addressed with auth "unrestricted" instead.
//     When the server answers 401 to a sealed send the key was wrong/stale: we ask the profile endpoint whether the account
//     is unrestricted, otherwise fall back to an authenticated (unsealed) send and avoid sealing to that contact for an hour.
// UNVERIFIED against the live service (see README): endpoint query strings, the profile JSON field names
// (`unrestrictedUnidentifiedAccess`) and that the server accepts our (linked-device) certificate for sealed sends.
import { Aci, PublicKey, SenderCertificate } from "@signalapp/libsignal-client";
import { ProfileKey } from "@signalapp/libsignal-client/dist/zkgroup/index.js";
import { toBytes } from "../protocol/bytes.js";
import type { SignalStore } from "../store/signalStore.js";
import type { AuthChat } from "./chatTypes.js";
import { trustRoots as productionRoots } from "./constants.js";
import { profileKeyVersion } from "./profileCrypto.js";

export type Access = { kind: "key"; key: Uint8Array } | { kind: "unrestricted" };

const CERT_REFRESH_MARGIN_MS = 60 * 60_000;     // refetch an hour before expiry
const CERT_FAIL_COOLDOWN_MS = 5 * 60_000;
const UNRESTRICTED_TTL_MS = 6 * 60 * 60_000;
const REJECT_COOLDOWN_MS = 60 * 60_000;

export interface SealedOptions { now?: () => number; trustRoots?: () => PublicKey[] }

const text = (b: Uint8Array | undefined) => Buffer.from(b ?? new Uint8Array()).toString("utf8");

export class SealedAccess {
  private certCache?: SenderCertificate;
  private certFailedAt = 0;
  private readonly now: () => number;
  private readonly roots: () => PublicKey[];
  constructor(private readonly store: SignalStore, private readonly chat: () => AuthChat, opts: SealedOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.roots = opts.trustRoots ?? productionRoots;
  }

  /** A valid sender certificate for this device, or undefined (cooldown after a failure). */
  async cert(): Promise<SenderCertificate | undefined> {
    const c = this.certCache;
    if (c && c.expiration() - this.now() > CERT_REFRESH_MARGIN_MS) return c;
    if (this.now() - this.certFailedAt < CERT_FAIL_COOLDOWN_MS) return c && c.expiration() > this.now() ? c : undefined;
    try {
      const a = this.store.requireAccount();
      let res = await this.chat().fetch({ verb: "GET", path: "/v1/certificate/delivery?includeE164=false", headers: [] });
      if (res.status === 400 || res.status === 404) res = await this.chat().fetch({ verb: "GET", path: "/v1/certificate/delivery", headers: [] });
      if (res.status < 200 || res.status >= 300) throw new Error(`certificate http ${res.status}`);
      const json = JSON.parse(text(res.body)) as { certificate?: string };
      if (!json.certificate) throw new Error("no certificate");
      const cert = SenderCertificate.deserialize(toBytes(Buffer.from(json.certificate, "base64")));
      if (!cert.validateWithTrustRoots(this.roots(), this.now())) throw new Error("certificate not signed by a trusted root");
      if (cert.senderUuid().toLowerCase() !== a.aci.toLowerCase() || cert.senderDeviceId() !== a.deviceId) throw new Error("certificate is not ours");
      this.certCache = cert;
      return cert;
    } catch {
      this.certFailedAt = this.now();
      return undefined;
    }
  }

  private contact(aci: string) { return this.store.data.contacts[aci.toLowerCase()]; }

  /** How to authorize a sealed send to `aci`, or undefined when sealing is not possible (unknown key etc.). */
  async access(aci: string): Promise<Access | undefined> {
    const c = this.contact(aci);
    if (c?.unrestricted?.value && this.now() - c.unrestricted.checkedAt < UNRESTRICTED_TTL_MS) return { kind: "unrestricted" };
    if (c?.sealedRejectedAt && this.now() - c.sealedRejectedAt < REJECT_COOLDOWN_MS) return undefined;
    if (c?.profileKey) return { kind: "key", key: new ProfileKey(toBytes(Buffer.from(c.profileKey, "base64"))).deriveAccessKey() };
    if (await this.checkUnrestricted(aci)) return { kind: "unrestricted" };
    return undefined;
  }

  /** The server rejected our access for `aci` (401). Returns a replacement access (unrestricted) or undefined. */
  async rejected(aci: string): Promise<Access | undefined> {
    if (await this.checkUnrestricted(aci, true)) return { kind: "unrestricted" };
    const c = this.contact(aci);
    if (c) { c.sealedRejectedAt = this.now(); this.store.touch(); }
    else { this.store.data.contacts[aci.toLowerCase()] = { aci: aci.toLowerCase(), sealedRejectedAt: this.now() }; this.store.touch(); }
    return undefined;
  }

  /** Does the account's profile allow unrestricted unidentified access? Cached 6 h (also negative answers). */
  private async checkUnrestricted(aci: string, force = false): Promise<boolean> {
    const key = aci.toLowerCase();
    const known = this.contact(key);
    if (!force && known?.unrestricted && this.now() - known.unrestricted.checkedAt < UNRESTRICTED_TTL_MS) return known.unrestricted.value;
    let value = false;
    try {
      const pk = known?.profileKey ? Buffer.from(known.profileKey, "base64") : undefined;
      const path = pk ? `/v1/profile/${key}/${profileKeyVersion(pk, key)}` : `/v1/profile/${key}`;
      const res = await this.chat().fetch({ verb: "GET", path, headers: [] });
      if (res.status >= 200 && res.status < 300) value = (JSON.parse(text(res.body)) as { unrestrictedUnidentifiedAccess?: boolean }).unrestrictedUnidentifiedAccess === true;
    } catch { value = false; }
    const rec = this.store.data.contacts[key] ?? (this.store.data.contacts[key] = { aci: key });
    rec.unrestricted = { value, checkedAt: this.now() };
    this.store.touch();
    return value;
  }
}

/** Access keys are only meaningful for real ACIs. */
export const isAci = (s: string) => { try { Aci.fromUuid(s); return true; } catch { return false; } };
