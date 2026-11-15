// Sealed token storage. The token is AES-256-GCM encrypted into `discord-session.json` (mode 0600). The key is `UNIMSG_DISCORD_KEY`
// (any string, hashed) when set, otherwise a random key in `discord-session.key` (mode 0600) next to it.
// Honest scope: this keeps the token out of plain-text grep / backups of the single file; it does NOT protect against someone who can
// read the whole data directory (the key file sits next to it) – use UNIMSG_DISCORD_KEY or a full-disk encryption for that.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Identity, Mode } from "./api.js";

export interface Session { mode: Mode; token: string; userId?: string }
const FILE = "discord-session.json", KEY = "discord-session.key", IDENT = "discord-identity.json";

function write0600(f: string, data: string) { writeFileSync(f, data, { mode: 0o600 }); chmodSync(f, 0o600); }
function keyFor(dir: string, create: boolean): Buffer | undefined {
  const env = process.env.UNIMSG_DISCORD_KEY;
  if (env) return createHash("sha256").update("unimsg-discord:" + env).digest();
  const f = join(dir, KEY);
  if (existsSync(f)) { const b = Buffer.from(readFileSync(f, "utf8").trim(), "hex"); return b.length === 32 ? b : undefined; }
  if (!create) return undefined;
  const k = randomBytes(32); write0600(f, k.toString("hex")); return k;
}

export function saveSession(dir: string, s: Session) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = keyFor(dir, true)!, iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(s), "utf8"), c.final()]);
  write0600(join(dir, FILE), JSON.stringify({ v: 1, sealed: Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64") }));
}
export function loadSession(dir: string): Session | undefined {
  try {
    const f = join(dir, FILE); if (!existsSync(f)) return undefined;
    const j = JSON.parse(readFileSync(f, "utf8")) as { v: number; sealed?: string };
    const key = keyFor(dir, false); if (!key || !j.sealed) return undefined;
    const b = Buffer.from(j.sealed, "base64");
    const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
    const s = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")) as Session;
    return s.token && (s.mode === "bot" || s.mode === "user") ? s : undefined;
  } catch { return undefined; }
}
export function wipeSession(dir: string) { for (const n of [FILE, KEY]) { try { rmSync(join(dir, n), { force: true }); } catch { /* ignore */ } } }

/** User-mode client identity is generated once and then never changed, so the account always looks like the same client. */
export function loadIdentity(dir: string, make: () => Identity, persist = true): Identity {
  const f = join(dir, IDENT);
  try { if (existsSync(f)) { const i = JSON.parse(readFileSync(f, "utf8")) as Identity; if (i.userAgent && i.superProps) return i; } } catch { /* regenerate */ }
  const i = make();
  if (persist) saveIdentity(dir, i);
  return i;
}
export function saveIdentity(dir: string, i: Identity) { try { mkdirSync(dir, { recursive: true, mode: 0o700 }); write0600(join(dir, IDENT), JSON.stringify(i)); } catch { /* best effort */ } }

// ---- portable form for backup / "move login to another device" ----
// The sealing key may live outside the account dir (UNIMSG_DISCORD_KEY), so the sealed file alone is useless elsewhere. The backup archive is
// passphrase-encrypted anyway: export the session in plain JSON next to the other files and re-seal it on import with THIS install's key.
const PORTABLE = "discord-session.portable.json";
export function exportPortableSession(dir: string): { files?: { rel: string; data: Uint8Array }[]; omit?: string[] } | undefined {
  const s = loadSession(dir); if (!s) return undefined; // nothing readable: export the directory as it is
  return { files: [{ rel: PORTABLE, data: Buffer.from(JSON.stringify(s), "utf8") }], omit: [FILE, KEY] };
}
export function importPortableSession(dir: string) {
  const f = join(dir, PORTABLE); if (!existsSync(f)) return;
  try { const s = JSON.parse(readFileSync(f, "utf8")) as Session; if (s.token && (s.mode === "bot" || s.mode === "user")) saveSession(dir, s); } finally { rmSync(f, { force: true }); }
}
