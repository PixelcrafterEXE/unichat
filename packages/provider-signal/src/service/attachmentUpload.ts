// Attachment UPLOAD (send side). Everything about the wire protocol here is built from knowledge of the official clients and
// has NOT been verified against the live service (see README "Unverified"):
//   1. GET /v4/attachments/form/upload (authenticated chat connection) -> { cdn, key, headers, signedUploadLocation }
//   2. plaintext -> zero-padded to a size bucket -> IV | AES-256-CBC | HMAC-SHA256 (see ./attachments.ts), random 64-byte key
//   3. resumable upload to signedUploadLocation on the CDN, TLS pinned to Signal's private root:
//        cdn3 (TUS 1.0):   POST (Upload-Length, Upload-Metadata) -> Location;  PATCH Location (Upload-Offset: 0)
//        cdn2 (GCS):       POST (form headers, "x-goog-resumable: start") -> Location;  PUT Location with the body
//   4. AttachmentPointer { cdnKey = form.key, cdnNumber = form.cdn, digest = SHA-256(blob), size = real plaintext size, ... }
// incrementalMac is omitted (receivers treat it as optional; it is only used for progressive video playback).
import { randomBytes } from "node:crypto";
import { request } from "node:https";
import type { OutgoingAttachment } from "@unimsg/core";
import type { AttachmentPointer } from "../protocol/codec.js";
import type { AuthChat } from "./chatTypes.js";
import { CDN_URLS, SERVICE_URL, SIGNAL_TLS_ROOT_PEM, USER_AGENT } from "./constants.js";
import { encryptAttachmentBlob } from "./attachments.js";

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 32;

/** Optional extras the UI may attach to an OutgoingAttachment (core's type does not declare them yet). */
export type SignalOutgoingAttachment = OutgoingAttachment & { width?: number; height?: number; gif?: boolean; caption?: string; blurHash?: string };

export const VOICE_MESSAGE_FLAG = 1;
export const BORDERLESS_FLAG = 2;
export const GIF_FLAG = 8;

export const attachDebug = (step: "form" | "encrypt" | "upload" | "send", bytes: number, cdn: number, result: string) => {
  if (process.env.UNIMSG_DEBUG === "1") console.debug(`[signal] attachment upload: step=${step} bytes=${bytes} cdn=${cdn} result=${result}`);
};

export class AttachmentUploadError extends Error {
  constructor(message: string, readonly step: "form" | "encrypt" | "upload" | "send", readonly errClass: string, readonly transient = false) { super(message); this.name = "AttachmentUploadError"; }
}

/** Signal's size buckets (Android PaddingInputStream / Desktop logPadSize): max(541, floor(1.05^ceil(log1.05(size)))). */
export function paddedSize(size: number): number {
  if (size <= 0) return 541;
  return Math.max(541, Math.floor(Math.pow(1.05, Math.ceil(Math.log(size) / Math.log(1.05)))));
}
export function padToBucket(plain: Uint8Array): Buffer {
  const out = Buffer.alloc(Math.max(paddedSize(plain.length), plain.length));
  out.set(plain);
  return out;
}

export interface HttpReq { method: string; url: URL; headers: Record<string, string>; body?: Buffer }
export interface HttpRes { status: number; headers: Record<string, string | string[] | undefined>; body?: Buffer }
export type CdnHttp = (r: HttpReq) => Promise<HttpRes>;
/** Credentials of this linked device for the service itself (same pair the authenticated chat connection uses). */
export interface ServiceAuth { username: string; password: string }

const MAX_RESPONSE_BODY = 256 * 1024; // answers we read are small (an upload form, an error); anything larger is cut off
/** Default transport: HTTPS with only Signal's root trusted. */
export const pinnedHttp: CdnHttp = (r) => new Promise((resolve, reject) => {
  const headers = { "user-agent": USER_AGENT, ...r.headers, "content-length": String(r.body?.length ?? 0) };
  const req = request(r.url, { method: r.method, ca: SIGNAL_TLS_ROOT_PEM, timeout: 120_000, headers }, (res) => {
    const chunks: Buffer[] = []; let n = 0;
    res.on("data", (c: Buffer) => { if (n < MAX_RESPONSE_BODY) { chunks.push(c); n += c.length; } });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on("error", reject);
  });
  req.on("timeout", () => req.destroy(new Error("CDN timeout")));
  req.on("error", reject);
  req.end(r.body);
});

interface UploadForm { cdn: number; key: string; headers: Record<string, string>; signedUploadLocation: string }

const first = (v: string | string[] | undefined) => Array.isArray(v) ? v[0] : v;
const errClassOf = (e: unknown) => e instanceof AttachmentUploadError ? e.errClass : e instanceof Error ? e.name : "unknown";

function safeCdnUrl(raw: string, base?: URL): URL {
  const u = new URL(raw, base);
  if (u.protocol !== "https:" || !(u.hostname === "signal.org" || u.hostname.endsWith(".signal.org"))) throw new Error("unexpected upload address");
  return u;
}

/** Retry policy for transient upload failures (5xx / 429 / 408 / network). Exported so tests can zero the delays. */
export const uploadRetry: { delaysMs: number[]; sleep: (ms: number) => Promise<void> } = {
  delaysMs: [400, 1500, 4000],
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
const transientStatus = (s: number) => s === 429 || s === 408 || s >= 500;

/** Run `fn`, retrying with backoff while it throws a transient AttachmentUploadError. `retries` caps the retries. */
async function withRetry<T>(fn: () => Promise<T>, retries = uploadRetry.delaysMs.length): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const transient = e instanceof AttachmentUploadError ? e.transient : !(e instanceof Error && e.name === "AbortError");
      const delay = uploadRetry.delaysMs[i];
      if (!transient || i >= retries || delay === undefined) throw e;
      await uploadRetry.sleep(delay);
    }
  }
}

const FORM_PATH = "/v4/attachments/form/upload";
/** The service refuses the form unless it is told how many bytes will be uploaded (the ENCRYPTED size, which is what goes to the CDN). */
const formPath = (uploadLength: number) => `${FORM_PATH}?uploadLength=${Math.max(1, Math.round(uploadLength))}`;
const parseForm = (body?: Uint8Array): UploadForm | undefined => {
  try { return JSON.parse(Buffer.from(body ?? new Uint8Array()).toString("utf8")) as UploadForm; } catch { return undefined; }
};
/** A form we can actually upload with: a key, a location and a CDN we know. */
const usable = (f?: UploadForm): f is UploadForm =>
  !!f && typeof f.key === "string" && !!f.key && typeof f.signedUploadLocation === "string" && !!CDN_URLS[f.cdn] && f.cdn !== 0;
/**
 * The same request as over the chat connection, but as an ordinary HTTPS call to the service with this device's
 * credentials. Signal's own clients fetch the upload form this way; the chat connection answers 400 for this path on
 * some accounts/servers (issue #85), and then this is what gets the attachment sent.
 */
async function fetchFormOverHttps(http: CdnHttp, auth: ServiceAuth, uploadLength: number): Promise<{ status: number; body?: Buffer }> {
  const r = await http({
    method: "GET", url: new URL(formPath(uploadLength), SERVICE_URL),
    headers: { authorization: "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64"), accept: "application/json" },
  });
  return { status: r.status, body: r.body };
}

/** Set once the HTTPS route has produced a form: the chat connection is then not asked again, so later attachments do not
 *  pay for a round trip that is known to fail here. Reset only by restarting the backend. */
let httpsFormWorks = false;
/** TESTS: forget what the last account learned about the two routes. */
export const resetFormRoute = () => { httpsFormWorks = false; };

async function fetchForm(chat: AuthChat, bytes: number, https?: { http: CdnHttp; auth: ServiceAuth }): Promise<UploadForm> {
  const stage = "form";
  const tooBig = () => new AttachmentUploadError("This file is too large for Signal (the limit is 100 MB).", stage, "http-413");
  let res: { status: number; body?: Uint8Array; headers?: ReadonlyArray<readonly [string, string]>; message?: string };
  let triedHttps = false; // one HTTPS attempt per upload, whichever route was tried first
  if (https && httpsFormWorks) { // this account already needed HTTPS; the chat connection stays the fallback
    triedHttps = true;
    try {
      const r = await fetchFormOverHttps(https.http, https.auth, bytes);
      if (r.status >= 200 && r.status < 300 && usable(parseForm(r.body))) { attachDebug("form", bytes, 0, "https:ok"); return form(parseForm(r.body)!, bytes); }
      attachDebug("form", bytes, 0, `https:http-${r.status}:back-to-chat`);
    } catch (e) { attachDebug("form", bytes, 0, `https:${errClassOf(e)}:back-to-chat`); }
  }
  try { res = await chat.fetch({ verb: "GET", path: formPath(bytes), headers: [] }); }
  catch (e) { attachDebug("form", bytes, 0, `error:${errClassOf(e)}`); throw new AttachmentUploadError("Couldn't reach Signal to send the attachment. Check your connection and try again.", stage, errClassOf(e), true); }
  // A 4xx that is not about this file (400 "the chat connection does not serve this path", 401/403/404) is retried over
  // HTTPS. Only a usable form counts: anything else leaves the original answer in place, so the error still names it.
  if (https && !triedHttps && res.status >= 400 && res.status < 500 && res.status !== 413 && res.status !== 429) {
    attachDebug("form", bytes, 0, `chat-${res.status}:retry-https`);
    try {
      const r = await fetchFormOverHttps(https.http, https.auth, bytes);
      if (r.status >= 200 && r.status < 300 && usable(parseForm(r.body))) { attachDebug("form", bytes, 0, "https:ok"); httpsFormWorks = true; res = r; }
      else attachDebug("form", bytes, 0, `https:http-${r.status}`);
    } catch (e) { attachDebug("form", bytes, 0, `https:${errClassOf(e)}`); }
  }
  if (res.status === 413) { attachDebug("form", bytes, 0, "error:http-413"); throw tooBig(); }
  if (res.status === 429) { attachDebug("form", bytes, 0, "error:http-429"); throw new AttachmentUploadError("Signal is busy or you are sending too fast (upload form, HTTP 429); try again shortly.", stage, "http-429", true); }
  const ok = res.status >= 200 && res.status < 300;
  const parsed = ok ? parseForm(res.body) : undefined;
  if (!usable(parsed)) {
    const cls = ok ? "bad-form" : `http-${res.status}`;
    attachDebug("form", bytes, 0, `error:${cls}`);
    if (ok) throw new AttachmentUploadError("Signal didn't accept the attachment upload: its reply to the upload request was malformed or named an unsupported CDN. Try again later.", stage, cls);
    const hdrs = ok ? "" : (res.headers ?? []).map((h) => h.join("=")).filter((h) => !/authorization|cookie/i.test(h)).join(" ").slice(0, 160);
    const why = ok ? "" : [res.message, Buffer.from(res.body ?? new Uint8Array()).toString("utf8").replace(/\s+/g, " ").trim(), hdrs].filter(Boolean).join(" | ").slice(0, 240); // the server's reason (never the request: no secrets in it)
    throw new AttachmentUploadError(`Signal refused the attachment upload request (upload form, HTTP ${res.status}${why ? ": " + why : ""}). Try again later.`, stage, cls, transientStatus(res.status));
  }
  return form(parsed, bytes);
}
/** The form as the uploader wants it (and the one debug line that says which CDN it names). */
function form(f: UploadForm, bytes: number): UploadForm {
  attachDebug("form", bytes, f.cdn, "ok");
  return { cdn: f.cdn, key: f.key, headers: f.headers && typeof f.headers === "object" ? f.headers : {}, signedUploadLocation: f.signedUploadLocation };
}

const uploadErr = (stage: string, status: number) => new AttachmentUploadError(uploadMsg(status, stage), "upload", `http-${status}`, transientStatus(status));

async function upload(http: CdnHttp, form: UploadForm, blob: Buffer): Promise<void> {
  const base = safeCdnUrl(form.signedUploadLocation);
  const tus = form.cdn === 3;
  // cdn2 = Google Cloud Storage resumable upload: the form's attributes (policy/signature headers) go on the session-start POST,
  // which must carry "x-goog-resumable: start"; the server normally includes it but a form without it is completed here.
  const gcsHeaders: Record<string, string> = { ...form.headers };
  if (!tus && !Object.keys(gcsHeaders).some((k) => k.toLowerCase() === "x-goog-resumable")) gcsHeaders["x-goog-resumable"] = "start";
  const create: HttpReq = tus
    ? { method: "POST", url: base, headers: { ...form.headers, "Tus-Resumable": "1.0.0", "Upload-Length": String(blob.length), "Upload-Metadata": `filename ${Buffer.from(form.key).toString("base64")}`, "Content-Type": "application/offset+octet-stream" } }
    : { method: "POST", url: base, headers: { ...gcsHeaders, "Content-Type": "application/octet-stream" } };
  const r1 = await http(create);
  if (r1.status < 200 || r1.status >= 300) { attachDebug("upload", blob.length, form.cdn, `session:http-${r1.status}`); throw uploadErr("session (attributes rejected)", r1.status); }
  const loc = first(r1.headers["location"]);
  if (!loc) throw new AttachmentUploadError("The attachment could not be uploaded to Signal (the CDN gave no upload location).", "upload", "no-location");
  const target = safeCdnUrl(loc, base);
  const r2 = await http(tus
    // cdn3 (Signal's own TUS endpoint) authorises every request of the session, not just the one that opens it: without the
    // form's headers the PATCH is refused with 401 and nothing is uploaded.
    ? { method: "PATCH", url: target, headers: { ...form.headers, "Tus-Resumable": "1.0.0", "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" }, body: blob }
    : { method: "PUT", url: target, headers: { "Content-Type": "application/octet-stream" }, body: blob });
  if (r2.status < 200 || r2.status >= 300) { attachDebug("upload", blob.length, form.cdn, `data:http-${r2.status}`); throw uploadErr("data transfer", r2.status); }
}
const uploadMsg = (status: number, stage: string) => status === 413
  ? "This file is too large for Signal (the limit is 100 MB)."
  : status === 429 || status >= 500 ? `Signal is busy; the attachment was not sent (upload ${stage}, HTTP ${status}). Try again shortly.`
  : `The attachment could not be uploaded to Signal (upload ${stage}, HTTP ${status}). Try again later.`;

/** Content type without parameters ("audio/ogg; codecs=opus" -> "audio/ogg"). */
export const baseMime = (mime: string) => (mime.split(";")[0] ?? "").trim().toLowerCase() || "application/octet-stream";

function voiceFileName(ts: number): string {
  const d = new Date(ts).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `signal-voice-note-${d}.ogg`;
}

/** Waveform 0-100 (<=~64 bars) -> Signal's bytes, 0..255, at most 100 bars. */
function waveformBytes(w: number[]): Uint8Array {
  const src = w.slice(0, 100).map((v) => Math.max(0, Math.min(255, Math.round((Number.isFinite(v) ? v : 0) * 2.55))));
  return Uint8Array.from(src);
}

/** Validate before any network use. */
export function checkAttachments(list: OutgoingAttachment[]): void {
  if (list.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new AttachmentUploadError(`Signal allows at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`, "encrypt", "too-many");
  for (const a of list) {
    if (!a.data || a.data.length === 0) throw new AttachmentUploadError("An attachment is empty, so nothing was sent.", "encrypt", "empty");
    if (a.data.length > MAX_ATTACHMENT_BYTES) throw new AttachmentUploadError("This file is too large for Signal (the limit is 100 MB).", "encrypt", "too-large");
  }
}

/** Encrypt + upload one attachment and return its pointer. */
export async function uploadAttachment(chat: AuthChat, http: CdnHttp, a: SignalOutgoingAttachment, now: number, opts: { retries?: number; auth?: ServiceAuth } = {}): Promise<AttachmentPointer> {
  const size = a.data.length;
  let enc: ReturnType<typeof encryptAttachmentBlob>;
  try {
    enc = encryptAttachmentBlob(padToBucket(a.data), randomBytes(64));
    attachDebug("encrypt", size, 0, "ok");
  } catch (e) {
    attachDebug("encrypt", size, 0, `error:${errClassOf(e)}`);
    throw new AttachmentUploadError("The attachment could not be prepared for sending.", "encrypt", errClassOf(e));
  }
  const form = await withRetry(() => fetchForm(chat, enc.blob.length, opts.auth ? { http, auth: opts.auth } : undefined), opts.retries);
  try {
    await withRetry(() => upload(http, form, enc.blob), opts.retries);
    attachDebug("upload", enc.blob.length, form.cdn, "ok");
  } catch (e) {
    attachDebug("upload", enc.blob.length, form.cdn, `error:${errClassOf(e)}`);
    if (e instanceof AttachmentUploadError) throw e;
    throw new AttachmentUploadError("The attachment could not be uploaded to Signal. Check your connection and try again.", "upload", errClassOf(e), true);
  }
  const voice = a.kind === "voice";
  const contentType = baseMime(a.mime);
  const ptr: AttachmentPointer = {
    cdnKey: form.key, cdnNumber: form.cdn, contentType, key: enc.key, size, digest: enc.digest,
    flags: voice ? VOICE_MESSAGE_FLAG : (a.gif && (contentType === "image/gif" || contentType.startsWith("video/")) ? GIF_FLAG : 0),
    uploadTimestamp: now, clientUuid: randomBytes(16),
  };
  const name = voice ? voiceFileName(now) : a.name;
  if (name) ptr.fileName = name;
  if (a.width && a.height) { ptr.width = Math.round(a.width); ptr.height = Math.round(a.height); }
  if (a.caption) ptr.caption = a.caption;
  if (a.blurHash) ptr.blurHash = a.blurHash;
  if (a.durationMs && (voice || a.kind === "audio")) ptr.audioDurationSeconds = a.durationMs / 1000;
  if (voice && a.waveform?.length) ptr.audioWaveform = waveformBytes(a.waveform);
  return ptr;
}
