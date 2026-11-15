// Storage Service key handling (read side only). HYPOTHESES, written from memory of Signal-Desktop / Signal-Android:
//   storageKey  = SvrKey(master).deriveStorageServiceKey()   (= HMAC-SHA256(master, "Storage Service Encryption"));
//                 master = AccountEntropyPool.deriveSvrKey(aep) for AEP-based accounts, or SyncMessage.Keys.master.
//   manifestKey = HMAC-SHA256(storageKey, "Manifest_" + version)
//   itemKey     = HKDF-SHA256(ikm = manifest.recordIkm, salt = none, info = "20240801_SIGNAL_STORAGE_SERVICE_ITEM_" + rawId, 32)   (new)
//               | HMAC-SHA256(storageKey, "Item_" + base64(rawId))                                                                   (legacy)
//   blob        = iv(12) || AES-256-GCM(ciphertext || tag(16))
import { createDecipheriv, createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { AccountEntropyPool, SvrKey } from "@signalapp/libsignal-client/dist/AccountKeys.js";
import { toBytes } from "../protocol/bytes.js";

const ITEM_INFO = Buffer.from("20240801_SIGNAL_STORAGE_SERVICE_ITEM_", "utf8");

/** Storage key from what the primary sent: an account entropy pool (string) or the legacy 32-byte master key. Undefined if neither is usable. */
export function deriveStorageKey(src: { accountEntropyPool?: string; master?: Uint8Array }): Buffer | undefined {
  try {
    if (src.accountEntropyPool && AccountEntropyPool.isValid(src.accountEntropyPool)) {
      return Buffer.from(new SvrKey(AccountEntropyPool.deriveSvrKey(src.accountEntropyPool)).deriveStorageServiceKey());
    }
    if (src.master && src.master.length === 32) return Buffer.from(new SvrKey(toBytes(src.master)).deriveStorageServiceKey());
  } catch { /* fall through */ }
  return undefined;
}

export const manifestKey = (storageKey: Uint8Array, version: number): Buffer =>
  createHmac("sha256", storageKey).update(`Manifest_${version}`).digest();

/** Candidate item keys, most likely first. */
export function itemKeys(storageKey: Uint8Array, raw: Uint8Array, recordIkm?: Uint8Array): Buffer[] {
  const out: Buffer[] = [];
  if (recordIkm?.length) out.push(Buffer.from(hkdfSync("sha256", recordIkm, Buffer.alloc(0), Buffer.concat([ITEM_INFO, raw]), 32)));
  out.push(createHmac("sha256", storageKey).update(`Item_${Buffer.from(raw).toString("base64")}`).digest());
  return out;
}

export function gcmDecrypt(key: Uint8Array, blob: Uint8Array): Buffer {
  if (blob.length < 12 + 16) throw new Error("storage blob too short");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAuthTag(Buffer.from(blob.subarray(blob.length - 16)));
  return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
}

/** Used by tests (fake storage server) only; this provider never uploads anything. */
export function gcmEncrypt(key: Uint8Array, plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
}
