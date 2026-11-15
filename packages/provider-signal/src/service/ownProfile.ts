// Own profile read/write against the profile service.
//   read : GET /v1/profile/<aci>/<profileKeyVersion>   (authenticated chat connection)  + avatar from cdn.signal.org
//   write: PUT /v1/profile  -> optional avatar upload form -> multipart POST to cdn.signal.org (S3 form, pinned root)
// Formats follow Signal-Desktop: ts/services/writeProfile.preload.ts, ts/util/encryptProfileData.preload.ts,
// ts/textsecure/WebAPI.preload.ts (putProfile, uploadAvatar, makePutParams, getAvatar).
import { randomUUID } from "node:crypto";
import { request } from "node:https";
import type { Profile, ProfilePatch } from "@unimsg/core";
import type { SignalStore } from "../store/signalStore.js";
import type { AuthChat } from "./chatTypes.js";
import { CDN_URLS, SIGNAL_TLS_ROOT_PEM } from "./constants.js";
import { fetchCdn } from "./attachments.js";
import {
  buildPutProfileBody, decryptProfile, decryptProfileName, decryptProfileText, encryptProfile, profileKeyVersion, type ServerProfile,
} from "./profileCrypto.js";

export class ProfileError extends Error { constructor(message: string) { super(message); this.name = "ProfileError"; } }

function profileKeyOf(store: SignalStore): Uint8Array {
  const k = store.requireAccount().profileKey;
  if (!k) throw new ProfileError("This linked device has no profile key (the phone did not provide one); the profile cannot be read or changed.");
  return new Uint8Array(Buffer.from(k, "base64"));
}

export function sniffImageMime(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  return "application/octet-stream";
}

interface Own { server: ServerProfile; given: string; family?: string; about?: string; aboutEmoji?: string; avatar?: { data: Uint8Array; mime: string } }

export async function readOwnProfile(chat: AuthChat, store: SignalStore, withAvatar = true): Promise<Own> {
  const key = profileKeyOf(store);
  const aci = store.requireAccount().aci;
  const res = await chat.fetch({ verb: "GET", path: `/v1/profile/${aci}/${profileKeyVersion(key, aci)}`, headers: [] });
  if (res.status === 404) return { server: {}, given: "" }; // no profile written yet
  if (res.status < 200 || res.status >= 300) throw new ProfileError(`profile fetch failed (HTTP ${res.status})`);
  const server = JSON.parse(Buffer.from(res.body ?? new Uint8Array()).toString("utf8")) as ServerProfile;
  const out: Own = { server, given: "" };
  if (server.name) { const n = decryptProfileName(server.name, key); out.given = n.given; out.family = n.family; }
  if (server.about) out.about = decryptProfileText(server.about, key);
  if (server.aboutEmoji) out.aboutEmoji = decryptProfileText(server.aboutEmoji, key);
  if (withAvatar && server.avatar) {
    const enc = await fetchCdn(new URL(`${CDN_URLS[0]}/${server.avatar.split("/").map(encodeURIComponent).join("/")}`));
    const data = decryptProfile(enc, key);
    out.avatar = { data, mime: sniffImageMime(data) };
  }
  return out;
}

const joinName = (given: string, family?: string) => [given, family].filter(Boolean).join(" ");

export async function getOwnProfile(chat: AuthChat, store: SignalStore): Promise<Profile> {
  const o = await readOwnProfile(chat, store);
  const about = [o.aboutEmoji, o.about].filter(Boolean).join(" ");
  return { displayName: joinName(o.given, o.family) || undefined, about: about || undefined, ...(o.avatar ? { avatar: o.avatar } : {}) };
}

/** Split a UI display name into Signal's given / family parts (first space). */
export function splitName(displayName: string): { given: string; family?: string } {
  const t = displayName.trim().replace(/\s+/g, " ");
  const i = t.indexOf(" ");
  return i < 0 ? { given: t } : { given: t.slice(0, i), family: t.slice(i + 1) };
}

interface UploadForm { acl: string; algorithm: string; credential: string; date: string; key: string; policy: string; signature: string }

/** Multipart POST exactly as Signal-Desktop `makePutParams` builds it. */
export function buildAvatarMultipart(f: UploadForm, encrypted: Uint8Array, boundaryId = randomUUID().replace(/-/g, "")) {
  const boundary = `----------------${boundaryId}`;
  const CRLF = "\r\n";
  const section = (name: string, value: string) => [`--${boundary}`, `Content-Disposition: form-data; name="${name}"${CRLF}`, value].join(CRLF);
  const start = [
    section("key", f.key), section("x-amz-credential", f.credential), section("acl", f.acl), section("x-amz-algorithm", f.algorithm),
    section("x-amz-date", f.date), section("policy", f.policy), section("x-amz-signature", f.signature),
    section("Content-Type", "application/octet-stream"),
    `--${boundary}`, 'Content-Disposition: form-data; name="file"', `Content-Type: application/octet-stream${CRLF}${CRLF}`,
  ].join(CRLF);
  const body = Buffer.concat([Buffer.from(start), Buffer.from(encrypted), Buffer.from(`${CRLF}--${boundary}--${CRLF}`)]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function postCdn(url: URL, contentType: string, body: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", ca: SIGNAL_TLS_ROOT_PEM, timeout: 90_000, headers: { "content-type": contentType, "content-length": body.length, "user-agent": "Unimsg-Signal/0.1" } }, (res) => {
      res.resume();
      res.on("end", () => (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) ? resolve() : reject(new ProfileError(`avatar upload failed (HTTP ${res.statusCode})`)));
    });
    req.on("timeout", () => req.destroy(new Error("avatar upload timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Change profile fields. PUT /v1/profile REPLACES the whole profile, so we first read the current one
 * and send every field again (unchanged ones re-encrypted; opaque server-held values carried over).
 */
export async function updateOwnProfile(chat: AuthChat, store: SignalStore, patch: ProfilePatch): Promise<void> {
  const key = profileKeyOf(store);
  const aci = store.requireAccount().aci;
  const cur = await readOwnProfile(chat, store, false);
  let { given, family } = cur;
  if (patch.displayName !== undefined) {
    const n = splitName(patch.displayName);
    if (!n.given) throw new ProfileError("The profile name cannot be empty.");
    ({ given, family } = n);
  }
  if (!given) throw new ProfileError("Set a profile name first (Signal requires one).");
  let about = cur.about, aboutEmoji = cur.aboutEmoji;
  if (patch.about !== undefined) {
    // "about" in UniChat is one string; a leading emoji is stored in Signal's separate emoji field.
    const m = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*(.*)$/su.exec(patch.about.trim());
    if (m) { aboutEmoji = m[1]; about = m[2] || undefined; } else { aboutEmoji = undefined; about = patch.about.trim() || undefined; }
  }
  const hadAvatar = !!cur.server.avatar;
  const newAvatar = patch.avatar === undefined ? undefined : patch.avatar;
  const hasAvatar = patch.avatar === undefined ? hadAvatar : patch.avatar !== null;
  const sameAvatar = patch.avatar === undefined && hadAvatar;
  const body = buildPutProfileBody(key, aci, {
    given, family, about, aboutEmoji, hasAvatar, sameAvatar,
    carry: { phoneNumberSharing: cur.server.phoneNumberSharing, paymentAddress: cur.server.paymentAddress, badges: cur.server.badges },
  });
  const res = await chat.fetch({
    verb: "PUT", path: "/v1/profile", headers: [["Content-Type", "application/json"]], body: Buffer.from(JSON.stringify(body)),
  });
  if (res.status < 200 || res.status >= 300) throw new ProfileError(`profile update failed (HTTP ${res.status})`);
  if (newAvatar) {
    // The response to a request with avatar:true is the upload form (a bare string/empty means nothing to upload).
    const text = Buffer.from(res.body ?? new Uint8Array()).toString("utf8").trim();
    let form: UploadForm | undefined;
    try { form = text.startsWith("{") ? JSON.parse(text) as UploadForm : undefined; } catch { form = undefined; }
    if (!form || !form.key || !form.policy) throw new ProfileError("profile saved, but the server returned no avatar upload form");
    const { body: mp, contentType } = buildAvatarMultipart(form, encryptProfile(newAvatar.data, key));
    await postCdn(new URL(`${CDN_URLS[0]}/`), contentType, mp);
  }
}
