// Element's "Export E2E room keys" file (-----BEGIN MEGOLM SESSION DATA-----): base64 of
//   0x01 | salt(16) | iv(16) | rounds(4, BE) | AES-256-CTR ciphertext (JSON array of sessions) | HMAC-SHA256(32)
// with key = PBKDF2-HMAC-SHA512(passphrase, salt, rounds, 64 bytes): first 32 bytes AES key, last 32 bytes HMAC key.
import { createDecipheriv, createCipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";

const HEAD = "-----BEGIN MEGOLM SESSION DATA-----", TAIL = "-----END MEGOLM SESSION DATA-----";

export function decryptKeyFile(file: string, passphrase: string): string {
  const a = file.indexOf(HEAD), b = file.indexOf(TAIL);
  if (a < 0 || b < a) throw new Error("This is not an exported Matrix room-key file (it should start with -----BEGIN MEGOLM SESSION DATA-----).");
  const raw = Buffer.from(file.slice(a + HEAD.length, b).replace(/\s+/g, ""), "base64");
  if (raw.length < 1 + 16 + 16 + 4 + 32 || raw[0] !== 1) throw new Error("The room-key file is damaged or has an unsupported version.");
  const salt = raw.subarray(1, 17), iv = raw.subarray(17, 33), rounds = raw.readUInt32BE(33), body = raw.subarray(37, raw.length - 32), mac = raw.subarray(raw.length - 32);
  if (rounds < 1 || rounds > 50_000_000) throw new Error("The room-key file is damaged.");
  const k = pbkdf2Sync(passphrase, salt, rounds, 64, "sha512");
  const want = createHmac("sha256", k.subarray(32)).update(raw.subarray(0, raw.length - 32)).digest();
  if (!timingSafeEqual(want, mac)) throw new Error("Wrong passphrase for this room-key file (or the file is damaged).");
  const d = createDecipheriv("aes-256-ctr", k.subarray(0, 32), iv);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}

/** Only used by tests (same format Element writes). */
export function encryptKeyFile(json: string, passphrase: string, rounds = 1000): string {
  const salt = Buffer.alloc(16, 7), iv = Buffer.alloc(16, 9); iv[8] &= 0x7f;
  const k = pbkdf2Sync(passphrase, salt, rounds, 64, "sha512");
  const c = createCipheriv("aes-256-ctr", k.subarray(0, 32), iv);
  const r = Buffer.alloc(4); r.writeUInt32BE(rounds);
  const head = Buffer.concat([Buffer.from([1]), salt, iv, r, c.update(Buffer.from(json)), c.final()]);
  return `${HEAD}\n${Buffer.concat([head, createHmac("sha256", k.subarray(32)).update(head).digest()]).toString("base64")}\n${TAIL}\n`;
}
