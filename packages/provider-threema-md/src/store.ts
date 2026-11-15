// Sealed storage (AES-256-GCM, files 0600; key = UNIMSG_THREEMA_MD_KEY or a random 0600 key file). Honest scope: protects against grepping or copying a single
// file, NOT against someone who can read the whole data directory. The session holds the Threema identity secret key: treat the directory like a password.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";

const KEY = "threema-md.key";
export const SESSION_FILE = "threema-md-session.json", STATE_FILE = "threema-md-state.json", NONCE_FILE = "threema-md-nonces.json";
export interface Session {
  identity: string; ck: string; dgk: string; serverGroup: string; deviceId: string; cspDeviceId: string; cspCookie: string;
  /** false until the mediator confirmed the new slot (a crash in between leaves an unregistered session that is not reused blindly) */
  registered: boolean; linkedAt: string;
}
function write0600(f: string, data: string) { const t = f + ".tmp"; writeFileSync(t, data, { mode: 0o600 }); chmodSync(t, 0o600); renameSync(t, f); }
function keyFor(dir: string, create: boolean): Buffer | undefined {
  const env = process.env.UNIMSG_THREEMA_MD_KEY;
  if (env) return createHash("sha256").update("unimsg-threema-md:" + env).digest();
  const f = join(dir, KEY);
  if (existsSync(f)) { const b = Buffer.from(readFileSync(f, "utf8").trim(), "hex"); return b.length === 32 ? b : undefined; }
  if (!create) return undefined;
  const k = randomBytes(32); write0600(f, k.toString("hex")); return k;
}
export function saveSealed(dir: string, file: string, value: unknown) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = keyFor(dir, true)!, iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  write0600(join(dir, file), JSON.stringify({ v: 1, sealed: Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64") }));
}
export function loadSealed<T>(dir: string, file: string): T | undefined {
  try {
    const f = join(dir, file); if (!existsSync(f)) return undefined;
    const j = JSON.parse(readFileSync(f, "utf8")) as { sealed?: string };
    const key = keyFor(dir, false); if (!key || !j.sealed) return undefined;
    const b = Buffer.from(j.sealed, "base64");
    const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")) as T;
  } catch { return undefined; }
}
export const loadSession = (dir: string) => { const s = loadSealed<Session>(dir, SESSION_FILE); return s?.identity && s.ck && s.dgk ? s : undefined; };
export const saveSession = (dir: string, s: Session) => saveSealed(dir, SESSION_FILE, s);
export function wipeAll(dir: string) { for (const n of [SESSION_FILE, STATE_FILE, NONCE_FILE, KEY]) { try { rmSync(join(dir, n), { force: true }); } catch { /* ignore */ } } }

// ---- application state (contacts, groups, settings, bounded caches) ----
export interface ContactRec { identity: string; pk?: string; first?: string; last?: string; nick?: string; acq: number; feature: string; lastAt?: number; cat?: number; vis?: number; /** looked up in the directory but not (yet) a contact of the device group */ tmp?: boolean }
export interface GroupRec { creator: string; id: string; name?: string; members: string[]; state: number; lastAt?: number; createdAt?: number }
export interface MediaRef { k: "file" | "legacy-image"; blobId: string; key?: string; nonce?: string; senderPk?: string; mime: string; name?: string; thumbId?: string; thumbMime?: string; scope1to1: boolean }
export interface PollRec { chatId: string; messageId: string; creator: string; pollId: string; question: string; multiple: boolean; closed: boolean; options: { id: number; text: string }[]; votes: Record<string, number[]> }
export interface State {
  v: 1; nickname?: string; blocked: string[]; readReceipts: boolean; typing: boolean; d2dVersion?: number;
  contacts: Record<string, ContactRec>; groups: Record<string, GroupRec>;
  media: Record<string, MediaRef>; polls: Record<string, PollRec>; avatars: Record<string, string>; avatarRefs: Record<string, { blobId: string; key: string; nonce?: string }>;
  /** `<chat>|<message id>` -> emoji -> sender ids (bounded) */
  reactions: Record<string, Record<string, string[]>>; ownAvatar?: string;
  /** message id (wire hex) -> chat for messages we know: lets receipts/reactions find their conversation cheaply (bounded) */
  recent: Record<string, string>;
}
export const emptyState = (): State => ({ v: 1, blocked: [], readReceipts: true, typing: true, contacts: {}, groups: {}, media: {}, polls: {}, avatars: {}, avatarRefs: {}, reactions: {}, recent: {} });
export const loadState = (dir: string): State => ({ ...emptyState(), ...(loadSealed<State>(dir, STATE_FILE) ?? {}) });
export const saveState = (dir: string, s: State) => saveSealed(dir, STATE_FILE, s);
export function bound<T>(o: Record<string, T>, max: number) { const k = Object.keys(o); for (let i = 0; i < k.length - max; i++) delete o[k[i]]; }

/** Permanent-ish nonce store (replay protection, PROTOCOL-NOTES 7): 16-byte prefixes, FIFO-bounded. Nonces imported from the phone at join time
 *  are HMAC-SHA256(identity, nonce) hashes (md-d2d-join.proto) and can only be matched, not read back. */
export class NonceStore {
  private set = new Set<string>(); private hashed = new Set<string>(); private dirty = false; private timer?: NodeJS.Timeout;
  private dir: string; private max: number;
  constructor(dir: string, max = 100_000) {
    this.dir = dir; this.max = max;
    const j = loadSealed<{ raw?: string[]; hashed?: string[] }>(dir, NONCE_FILE);
    for (const n of j?.raw ?? []) this.set.add(n); for (const n of j?.hashed ?? []) this.hashed.add(n);
  }
  private k = (n: Uint8Array) => Buffer.from(n.subarray(0, 16)).toString("base64");
  has(n: Uint8Array, identity?: string) {
    if (this.set.has(this.k(n))) return true;
    return !!identity && this.hashed.size > 0 && this.hashed.has(createHmac("sha256", identity).update(n).digest("base64"));
  }
  importHashed(list: Uint8Array[]) { for (const h of list) this.hashed.add(Buffer.from(h).toString("base64")); this.touch(); }
  add(n: Uint8Array) { this.set.add(this.k(n)); while (this.set.size > this.max) this.set.delete(this.set.values().next().value as string); this.touch(); }
  private touch() { this.dirty = true; this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, 2000); }
  flush() { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } if (this.dirty) { this.dirty = false; try { saveSealed(this.dir, NONCE_FILE, { raw: [...this.set], hashed: [...this.hashed] }); } catch { /* ignore */ } } }
}
