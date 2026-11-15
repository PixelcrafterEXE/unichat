// Linked-device name encryption (so the server only sees ciphertext). Port of Signal-Desktop
// Crypto.node.ts encryptDeviceName(): ephemeral ECDH to the account identity key, synthetic IV,
// AES-256-CTR with zero counter.
import { createCipheriv, createHmac } from "node:crypto";
import { PrivateKey, type PublicKey } from "@signalapp/libsignal-client";
import { DeviceNameCodec } from "./codec.js";

const hmac = (key: Uint8Array, data: Uint8Array | string) => createHmac("sha256", key).update(data).digest();

/** Returns base64 of the DeviceName protobuf, as expected in accountAttributes.name. */
export function encryptDeviceName(name: string, identityPublic: PublicKey): string {
  const plaintext = Buffer.from(name, "utf8");
  const eph = PrivateKey.generate();
  const master = eph.agree(identityPublic);
  const key1 = hmac(master, "auth");
  const syntheticIv = hmac(key1, plaintext).subarray(0, 16);
  const key2 = hmac(master, "cipher");
  const cipherKey = hmac(key2, syntheticIv);
  const c = createCipheriv("aes-256-ctr", cipherKey, Buffer.alloc(16));
  const ciphertext = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.from(DeviceNameCodec.encode({
    ephemeralPublic: eph.getPublicKey().serialize(), syntheticIv, ciphertext,
  })).toString("base64");
}
