// Threema E2E message framing for the Gateway (type byte + payload, PKCS#7-style random padding), delivery receipts, file messages, callback MAC.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const T = { TEXT: 0x01, LOCATION: 0x10, POLL_SETUP: 0x15, POLL_VOTE: 0x16, FILE: 0x17, GROUP_TEXT: 0x41, RECEIPT: 0x80 } as const;
export const RECEIPT = { RECEIVED: 1, READ: 2, ACK: 3, DECLINE: 4 } as const;
export const MAX_TEXT_BYTES = 3500;

export const ID_RE = /^[0-9A-Z*][0-9A-Z]{7}$/;
export const normaliseId = (s: string) => s.trim().toUpperCase();
export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const unhex = (s: string) => { if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error("bad hex"); return new Uint8Array(Buffer.from(s, "hex")); };

/** Padded plaintext: random 1..255 pad bytes (each = pad length), total at least 32 bytes. */
export function frame(type: number, payload: Uint8Array): Uint8Array {
  const len = 1 + payload.length;
  let pad = 1 + (randomBytes(1)[0] % 255);
  if (len + pad < 32) pad = 32 - len;
  const out = new Uint8Array(len + pad);
  out[0] = type; out.set(payload, 1); out.fill(pad, len);
  return out;
}
export function unframe(p: Uint8Array): { type: number; data: Uint8Array } | undefined {
  if (p.length < 2) return undefined;
  const pad = p[p.length - 1];
  if (pad < 1 || pad >= p.length) return undefined;
  return { type: p[0], data: p.subarray(1, p.length - pad) };
}

export const textPayload = (s: string) => new TextEncoder().encode(s);
export const receiptPayload = (status: number, ids: Uint8Array[]) => { const o = new Uint8Array(1 + 8 * ids.length); o[0] = status; ids.forEach((id, i) => o.set(id, 1 + 8 * i)); return o; };
export function parseReceipt(d: Uint8Array): { status: number; ids: string[] } | undefined {
  if (d.length < 9 || (d.length - 1) % 8) return undefined;
  const ids: string[] = []; for (let o = 1; o < d.length; o += 8) ids.push(hex(d.subarray(o, o + 8)));
  return { status: d[0], ids };
}
/** Group text (0x41): creator Threema ID (8 ASCII bytes) + group id (8 bytes) + UTF-8 text. */
export function parseGroupText(d: Uint8Array): { creator: string; groupId: string; text: string } | undefined {
  if (d.length < 16) return undefined;
  const creator = new TextDecoder().decode(d.subarray(0, 8));
  if (!ID_RE.test(creator)) return undefined;
  return { creator, groupId: hex(d.subarray(8, 16)), text: new TextDecoder().decode(d.subarray(16)) };
}

export interface FileJson { b: string; k: string; m: string; s: number; n?: string; t?: string; p?: string; d?: string; j?: number; i?: number }
export function parseFileJson(d: Uint8Array): FileJson | undefined {
  try {
    const j = JSON.parse(new TextDecoder().decode(d)) as FileJson;
    return typeof j.b === "string" && /^[0-9a-f]+$/i.test(j.b) && typeof j.k === "string" && /^[0-9a-f]{64}$/i.test(j.k) && typeof j.m === "string" ? j : undefined;
  } catch { return undefined; }
}
/** Blob nonces: file = 0...01, thumbnail = 0...02. */
export const blobNonce = (n: 1 | 2) => { const o = new Uint8Array(24); o[23] = n; return o; };

/** Callback MAC = HMAC-SHA256(secret, from||to||messageId||date||nonce||box) over the fields exactly as posted. */
export function callbackMac(secret: string, f: Record<"from" | "to" | "messageId" | "date" | "nonce" | "box", string>) {
  return createHmac("sha256", secret).update(f.from + f.to + f.messageId + f.date + f.nonce + f.box).digest("hex");
}
export function macOk(secret: string, f: Record<"from" | "to" | "messageId" | "date" | "nonce" | "box", string>, mac: string) {
  const want = Buffer.from(callbackMac(secret, f), "hex"), got = /^[0-9a-fA-F]{64}$/.test(mac) ? Buffer.from(mac, "hex") : Buffer.alloc(0);
  return got.length === want.length && timingSafeEqual(got, want);
}
