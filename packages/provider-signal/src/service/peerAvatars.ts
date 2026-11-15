// Profile pictures of people (and our own): the profile service keeps the avatar encrypted with the person's profile key.
//   GET /v1/profile/<aci>/<profileKeyVersion>  (authenticated chat connection)  ->  { avatar: "<cdn path>" }
//   GET <cdn>/<path>  (no credentials)  ->  AES-GCM blob, decrypted with the profile key.
// Lookups are serialized with a small gap, cached for 6 h (misses 1 h), and back off on 429/401. Never logs ids, keys or paths.
import { createHash } from "node:crypto";
import type { SignalStore } from "../store/signalStore.js";
import type { AuthChat } from "./chatTypes.js";
import { CDN_URLS } from "./constants.js";
import { fetchCdn } from "./attachments.js";
import { decryptProfile, profileKeyVersion, type ServerProfile } from "./profileCrypto.js";
import { sniffImageMime } from "./ownProfile.js";

export const AVATAR_TTL_MS = 6 * 3600_000;
export const AVATAR_NEGATIVE_MS = 3600_000;
export const AVATAR_GAP_MS = 250;
export const AVATAR_BACKOFF_MS = 10 * 60_000;

type Image = { data: Uint8Array; mime: string };
interface Entry { at: number; version: string; path?: string; image?: Image }

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const cdnUrl = (path: string) => new URL(`${CDN_URLS[0]}/${path.split("/").map(encodeURIComponent).join("/")}`);

/** Counts only (never ids, keys or names): why a picture did or did not resolve. */
const avDebug = (line: string) => { if (process.env.UNIMSG_DEBUG === "1") process.stderr.write(`[signal] avatar: ${line}\n`); };
export class PeerAvatars {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Image | undefined>>();
  private chain: Promise<unknown> = Promise.resolve();
  private pausedUntil = 0;
  private lastRequestAt = 0;
  constructor(
    private readonly store: SignalStore,
    private readonly chat: () => AuthChat | undefined,
    private readonly onChanged: (aci: string) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly fetchBlob: (path: string) => Promise<Uint8Array> = (p) => fetchCdn(cdnUrl(p)),
  ) {}

  private keyOf(aci: string): Uint8Array | undefined {
    const own = this.store.account?.aci.toLowerCase() === aci;
    const k = own ? this.store.account?.profileKey : this.store.data.contacts[aci]?.profileKey;
    return k ? new Uint8Array(Buffer.from(k, "base64")) : undefined;
  }

  /** Cheap change hint for Chat.avatarRev / Contact.avatarRev: the avatar path once known, else the profile key version. */
  rev(aciIn: string): string | undefined {
    const aci = aciIn.toLowerCase(); const key = this.keyOf(aci); if (!key) return undefined;
    const e = this.cache.get(aci);
    if (e?.path) return `p:${sha(e.path)}`;
    const known = this.store.data.contacts[aci]?.avatarPath;
    if (known) return `p:${sha(known)}`;
    return `k:${sha(profileKeyVersion(key, aci))}`;
  }

  /** The profile key of this person changed: forget what we cached and tell the Hub. */
  keyChanged(aciIn: string) {
    const aci = aciIn.toLowerCase();
    if (this.cache.delete(aci)) this.onChanged(aci);
    else if (this.store.data.contacts[aci]?.avatarPath) { delete this.store.data.contacts[aci]!.avatarPath; this.onChanged(aci); }
  }

  get(aciIn: string): Promise<Image | undefined> {
    const aci = aciIn.toLowerCase(); const key = this.keyOf(aci);
    if (!key) { avDebug("no-profile-key"); return Promise.resolve(undefined); }
    const version = profileKeyVersion(key, aci);
    const e = this.cache.get(aci);
    if (e && e.version === version && this.now() - e.at < (e.image ? AVATAR_TTL_MS : AVATAR_NEGATIVE_MS)) return Promise.resolve(e.image);
    const cur = this.inflight.get(aci); if (cur) return cur;
    // serialized: one lookup at a time with a gap, so the receive loop and the rest of the chat connection are never starved
    const p = this.chain.then(() => this.lookup(aci, key, version)).catch(() => undefined);
    this.chain = p;
    this.inflight.set(aci, p);
    void p.finally(() => this.inflight.delete(aci));
    return p;
  }

  private async lookup(aci: string, key: Uint8Array, version: string): Promise<Image | undefined> {
    const prev = this.cache.get(aci);
    if (this.now() < this.pausedUntil) return prev?.version === version ? prev.image : undefined;
    const conn = this.chat(); if (!conn) { avDebug("no-chat-connection"); return undefined; }
    const wait = this.lastRequestAt + AVATAR_GAP_MS - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
    try {
      const res = await conn.fetch({ verb: "GET", path: `/v1/profile/${aci}/${version}`, headers: [] });
      avDebug(`profile-http-${res.status}`);
      if (res.status === 429 || res.status === 401 || res.status === 503) { this.pausedUntil = this.now() + AVATAR_BACKOFF_MS; return undefined; }
      if (res.status < 200 || res.status >= 300) return this.remember(aci, { at: this.now(), version }, prev); // 404 / 403: no profile / stale key
      const server = JSON.parse(Buffer.from(res.body ?? new Uint8Array()).toString("utf8")) as ServerProfile;
      if (!server.avatar) { avDebug("profile-has-no-avatar"); return this.remember(aci, { at: this.now(), version }, prev); }
      if (prev?.version === version && prev.path === server.avatar && prev.image) { prev.at = this.now(); return prev.image; } // unchanged
      const data = decryptProfile(await this.fetchBlob(server.avatar), key);
      avDebug("avatar-ok");
      return this.remember(aci, { at: this.now(), version, path: server.avatar, image: { data, mime: sniffImageMime(data) } }, prev);
    } catch (e) {
      avDebug("lookup-error:" + (e instanceof Error ? e.name : "unknown"));
      return prev?.version === version ? prev.image : undefined; // not cached: a transient failure is retried on the next ask
    }
  }

  private remember(aci: string, e: Entry, prev: Entry | undefined): Image | undefined {
    this.cache.set(aci, e);
    const c = this.store.data.contacts[aci];
    const was = prev?.path ?? c?.avatarPath;
    if (c && c.avatarPath !== e.path) { if (e.path) c.avatarPath = e.path; else delete c.avatarPath; this.store.touch(); }
    if (was !== e.path && (was || prev)) this.onChanged(aci); // a picture appeared / changed / went away since we last looked
    return e.image;
  }
}
