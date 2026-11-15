// Matrix encrypted attachments (spec: "Sending encrypted attachments"): AES-256-CTR + SHA-256 over the ciphertext.
// matrix-js-sdk does not ship this (Element uses matrix-encrypt-attachment), so it is implemented with node:crypto.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface EncryptedFile {
  url: string;
  key: { kty: "oct"; key_ops: string[]; alg: "A256CTR"; k: string; ext: true };
  iv: string;
  hashes: { sha256: string };
  v: "v2";
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/=+$/, "");
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const fromB64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

export function encryptAttachment(data: Uint8Array): { ciphertext: Uint8Array; info: Omit<EncryptedFile, "url"> } {
  const key = randomBytes(32);
  const iv = Buffer.concat([randomBytes(8), Buffer.alloc(8)]); // low 64 bits (counter) zero, per spec
  const c = createCipheriv("aes-256-ctr", key, iv);
  const ciphertext = Buffer.concat([c.update(data), c.final()]);
  return {
    ciphertext,
    info: {
      v: "v2", iv: b64(iv), hashes: { sha256: b64(createHash("sha256").update(ciphertext).digest()) },
      key: { kty: "oct", key_ops: ["encrypt", "decrypt"], alg: "A256CTR", k: b64url(key), ext: true },
    },
  };
}

export function decryptAttachment(ciphertext: Uint8Array, f: Pick<EncryptedFile, "key" | "iv" | "hashes">): Uint8Array {
  const want = f.hashes?.sha256;
  if (!want) throw new Error("encrypted attachment has no sha256 hash");
  const got = createHash("sha256").update(ciphertext).digest();
  if (!got.equals(fromB64(want))) throw new Error("encrypted attachment hash mismatch");
  const d = createDecipheriv("aes-256-ctr", fromB64(f.key.k), fromB64(f.iv));
  return Buffer.concat([d.update(ciphertext), d.final()]);
}
