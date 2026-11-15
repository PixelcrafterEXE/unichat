// Newer servers/clients populate the *Binary variants of service-id fields (16-byte ACI UUID, or 0x01 + 16 bytes
// for a PNI) and may leave the legacy string fields empty. These helpers accept both.
import { Aci, Pni } from "@signalapp/libsignal-client";

/** ACI -> "uuid"; PNI -> "PNI:uuid"; anything else -> undefined. */
export function serviceIdFromBinary(b: Uint8Array | undefined | null): string | undefined {
  if (!b) return undefined;
  const u = Uint8Array.from(b);
  if (u.length === 16) return Aci.fromUuidBytes(u).getRawUuid();
  if (u.length === 17 && u[0] === 0x01) return Pni.fromUuidBytes(u.subarray(1)).getServiceIdString();
  return undefined;
}

export const stripPni = (s: string) => s.replace(/^PNI:/i, "");
