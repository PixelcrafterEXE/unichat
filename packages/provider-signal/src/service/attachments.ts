// Attachment transport + crypto.
//   blob  = IV(16) | AES-256-CBC/PKCS7(plaintext, padded by sender) | HMAC-SHA256(macKey, IV|ciphertext)(32)
//   key   = aesKey(32) | macKey(32)  (AttachmentPointer.key);  digest = SHA-256(blob);  size = plaintext length
// Download: GET https://cdn{N}.signal.org/attachments/<cdnKey|cdnId>, TLS pinned to Signal's private root.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request } from "node:https";
import type { AttachmentRef } from "../store/types.js";
import { CDN_URLS, SIGNAL_TLS_ROOT_PEM } from "./constants.js";

const MAX_BYTES = 200 * 1024 * 1024;

/** Verify + decrypt a downloaded blob. Throws on any integrity failure. */
export function decryptAttachmentBlob(blob: Uint8Array, key: Uint8Array, opts: { digest?: Uint8Array; size?: number } = {}): Buffer {
  if (key.length !== 64) throw new Error("attachment key must be 64 bytes");
  if (blob.length < 16 + 16 + 32) throw new Error("attachment blob too short");
  const b = Buffer.from(blob);
  if (opts.digest && opts.digest.length) {
    const d = createHash("sha256").update(b).digest();
    if (d.length !== opts.digest.length || !timingSafeEqual(d, Buffer.from(opts.digest))) throw new Error("attachment digest mismatch");
  }
  const aes = Buffer.from(key.subarray(0, 32)), mac = Buffer.from(key.subarray(32));
  const body = b.subarray(0, b.length - 32), tag = b.subarray(b.length - 32);
  const expect = createHmac("sha256", mac).update(body).digest();
  if (!timingSafeEqual(expect, tag)) throw new Error("attachment MAC mismatch");
  const d = createDecipheriv("aes-256-cbc", aes, body.subarray(0, 16));
  const plain = Buffer.concat([d.update(body.subarray(16)), d.final()]);
  return opts.size !== undefined && opts.size <= plain.length ? plain.subarray(0, opts.size) : plain;
}

/** Inverse of the above (used by tests now, by attachment upload later). Returns blob + its SHA-256 digest. */
export function encryptAttachmentBlob(plain: Uint8Array, key: Uint8Array = randomBytes(64), iv: Uint8Array = randomBytes(16)) {
  const c = createCipheriv("aes-256-cbc", Buffer.from(key.subarray(0, 32)), Buffer.from(iv));
  const body = Buffer.concat([Buffer.from(iv), c.update(plain), c.final()]);
  const tag = createHmac("sha256", Buffer.from(key.subarray(32))).update(body).digest();
  const blob = Buffer.concat([body, tag]);
  return { blob, key: Buffer.from(key), digest: createHash("sha256").update(blob).digest() };
}

export function attachmentUrl(ref: Pick<AttachmentRef, "cdnNumber" | "cdnKey" | "cdnId">): URL {
  const base = CDN_URLS[ref.cdnNumber ?? 0];
  if (!base) throw new Error(`unknown CDN number ${ref.cdnNumber}`);
  const id = ref.cdnKey ?? (ref.cdnId !== undefined ? String(ref.cdnId) : undefined);
  if (!id) throw new Error("attachment has no CDN id");
  return new URL(`${base}/attachments/${encodeURIComponent(id)}`);
}

/** Plain HTTPS GET with only Signal's root trusted (no credentials are sent). */
export function fetchCdn(url: URL, extraCa?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", ca: extraCa ?? SIGNAL_TLS_ROOT_PEM, timeout: 60_000, headers: { "user-agent": "Unimsg-Signal/0.1" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`CDN download failed (HTTP ${res.statusCode})`)); return; }
      const parts: Buffer[] = []; let n = 0;
      res.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BYTES) req.destroy(new Error("attachment too large")); else parts.push(c); });
      res.on("end", () => resolve(Buffer.concat(parts)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("CDN timeout")));
    req.on("error", reject);
    req.end();
  });
}

export async function downloadAttachment(ref: AttachmentRef): Promise<Buffer> {
  const blob = await fetchCdn(attachmentUrl(ref));
  return decryptAttachmentBlob(blob, Buffer.from(ref.key, "base64"), {
    digest: ref.digest ? Buffer.from(ref.digest, "base64") : undefined, size: ref.size,
  });
}
