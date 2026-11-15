// Sealed token storage. Tokens are AES-256-GCM encrypted into `teams-session.json` (mode 0600). The key is `UNIMSG_TEAMS_KEY`
// (any string, hashed) when set, otherwise a random key in `teams-session.key` (mode 0600) next to it.
// Honest scope: this keeps tokens out of plain-text grep / backups of the single file; it does NOT protect against someone who can
// read the whole data directory (the key file sits next to it) - use UNIMSG_TEAMS_KEY or full-disk encryption for that.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

export interface Session {
  clientId: string; tenant: string; scope: string;
  refreshToken: string; accessToken?: string; expiresAt?: number; /** scopes the token response says were granted (space separated) */ granted?: string;
  userId?: string; tenantId?: string;
}
const FILE = "teams-session.json", KEY = "teams-session.key", STATE = "teams-state.json";

function write0600(f: string, data: string) { writeFileSync(f, data, { mode: 0o600 }); chmodSync(f, 0o600); }
function keyFor(dir: string, create: boolean): Buffer | undefined {
  const env = process.env.UNIMSG_TEAMS_KEY;
  if (env) return createHash("sha256").update("unimsg-teams:" + env).digest();
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
    return s.refreshToken && s.clientId && s.tenant ? s : undefined;
  } catch { return undefined; }
}
export function wipeSession(dir: string) { for (const n of [FILE, KEY, STATE]) { try { rmSync(join(dir, n), { force: true }); } catch { /* ignore */ } } }

/** Non-secret poll state: the time up to which messages were seen, so a restart can catch up (as `historical`). */
export function loadSince(dir: string): string | undefined {
  try { const j = JSON.parse(readFileSync(join(dir, STATE), "utf8")) as { since?: string }; return j.since && !isNaN(Date.parse(j.since)) ? j.since : undefined; } catch { return undefined; }
}
export function saveSince(dir: string, since: string) { try { mkdirSync(dir, { recursive: true, mode: 0o700 }); write0600(join(dir, STATE), JSON.stringify({ since })); } catch { /* best effort */ } }
