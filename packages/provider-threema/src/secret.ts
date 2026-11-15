// Sealed storage: AES-256-GCM files with mode 0600. Key = UNIMSG_THREEMA_KEY (hashed) or a random 0600 key file next to them.
// Honest scope: protects against plain-text grep / copying a single file, NOT against someone who can read the whole data directory.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

const KEY = "threema.key";
export const SESSION_FILE = "threema-session.json", STATE_FILE = "threema-state.json";
export interface Session { gatewayId: string; secret: string; privateKey: string; callbackPort: number }

function write0600(f: string, data: string) { writeFileSync(f, data, { mode: 0o600 }); chmodSync(f, 0o600); }
function keyFor(dir: string, create: boolean): Buffer | undefined {
  const env = process.env.UNIMSG_THREEMA_KEY;
  if (env) return createHash("sha256").update("unimsg-threema:" + env).digest();
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
export const loadSession = (dir: string) => { const s = loadSealed<Session>(dir, SESSION_FILE); return s?.gatewayId && s.secret && s.privateKey ? s : undefined; };
export const saveSession = (dir: string, s: Session) => saveSealed(dir, SESSION_FILE, s);
export function wipeAll(dir: string) { for (const n of [SESSION_FILE, STATE_FILE, KEY]) { try { rmSync(join(dir, n), { force: true }); } catch { /* ignore */ } } }
