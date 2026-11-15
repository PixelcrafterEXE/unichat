// Durable avatar (profile picture) cache helpers. The pictures live in the Store (SqliteStore seals them with the data key), so a device
// without a live connector (signed out, archived, a second paired device) still shows them. The Hub fills it, packages/sync replicates it.
import { createHash } from "node:crypto";
import type { Store, StoredAvatar } from "./store.js";

/** One picture (thumbnail or full variant) is never stored or synced above this size. */
export const AVATAR_MAX_BYTES = 256 * 1024;
/** All real avatars together stay below this (oldest fetched first out). */
export const AVATAR_TOTAL_BYTES = 64 * 1024 * 1024;
/** A stored picture older than this is refreshed from the live connector (the old one is served meanwhile and kept when the refresh fails). */
export const AVATAR_TTL_MS = 7 * 86_400_000;
/** "The provider has no picture" is remembered for this long. */
export const AVATAR_NEGATIVE_MS = 3600_000;
/** Pictures nobody asked for or refreshed in this long are dropped. */
export const AVATAR_MAX_AGE_MS = 120 * 86_400_000;

/** A stored picture whose provider hint still matches is trusted this long; with no hint available, chats the user opened lately use the short TTL. */
export const AVATAR_TTL_HINTED_MS = 30 * 86_400_000, AVATAR_TTL_OPEN_MS = 24 * 3600_000, AVATAR_OPEN_WINDOW_MS = 7 * 86_400_000;
/** Deletion tombstones are kept (and replicated) this long. */
export const AVATAR_TOMB_MS = 30 * 86_400_000;

export const avatarKey = (kind: string, id: string, full = false) => `${kind}|${id}${full ? "|full" : ""}`;
export const avatarSha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function makeAvatar(key: string, data: Uint8Array, mime: string, fetchedAt = Date.now(), rev?: string): StoredAvatar {
  return { key, mime: String(mime || "image/jpeg").slice(0, 100), data, fetchedAt, sha: avatarSha(data), ...(rev ? { rev: rev.slice(0, 200) } : {}) };
}
export const emptyAvatar = (key: string, fetchedAt = Date.now()): StoredAvatar => ({ key, mime: "", data: new Uint8Array(), fetchedAt, sha: "", empty: true });

/** Keep the store within its caps; cheap enough to call every few dozen writes. */
export function pruneAvatarStore(store: Store, now = Date.now()) { try { return store.pruneAvatars({ maxBytes: AVATAR_TOTAL_BYTES, olderThan: now - AVATAR_MAX_AGE_MS, tombOlderThan: now - AVATAR_TOMB_MS }); } catch { return 0; } }
