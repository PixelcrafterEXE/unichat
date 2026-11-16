// The ONE place that decides which messengers + storage ship. Every shell
// (Electron, Android, standalone server) calls startBackend() and only bridges
// the returned Hub to the UI. Same backend, embedded or standalone.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hub, type BackupPolicy, type HubOptions, type ProviderFactory } from "@unimsg/core";
import { SqliteStore } from "@unimsg/store-sqlite";
import { attachSync, isWrongKey, SyncStore } from "@unimsg/sync"; // device sync hook
import signal from "@unimsg/provider-signal";
import matrix from "@unimsg/provider-matrix";
import mattermost from "@unimsg/provider-mattermost";
import instagram from "@unimsg/provider-instagram";
import discord from "@unimsg/provider-discord";
import threema from "@unimsg/provider-threema";
import threemaMd from "@unimsg/provider-threema-md";
import teams from "@unimsg/provider-teams";

/** WhatsApp is a normal workspace dependency; the import is a literal specifier so bundlers (Vite, esbuild) follow it. If loading it throws (e.g. a broken optional native peer) the other providers still start. */
async function loadWhatsapp(): Promise<ProviderFactory[]> {
  try { return [(await import("@unimsg/provider-whatsapp")).default as ProviderFactory]; }
  catch (e) { console.warn(`[unimsg] provider-whatsapp failed to load – skipping: ${(e as Error).message}`); return []; }
}

export interface KeyWrap {
  /** Protect the data key before it touches the disk (Electron: the OS keychain via safeStorage). */
  wrap(key: Uint8Array): Uint8Array | Promise<Uint8Array>;
  unwrap(blob: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /** Set by `unwrap` when the OS says the stored blob should be sealed again (rotated keychain key); the host then rewrites the file. */
  resealNeeded?: boolean;
}
/** The data folder holds data sealed with a different key than the one this process has (e.g. created by the web server with `unimsg.key` and opened by the desktop app with the OS keychain). Nothing was changed or deleted. */
export class DataKeyMismatchError extends Error {
  readonly code = "KEY_MISMATCH";
  constructor(readonly dataDir: string, readonly what: "archive" | "sync", readonly sealedBy?: string, readonly keySource?: string) {
    super(keyMismatchText(dataDir, what, sealedBy, keySource)); this.name = "DataKeyMismatchError";
  }
}
function keyMismatchText(dataDir: string, what: string, sealedBy?: string, keySource?: string): string {
  const who = sealedBy ? `by the ${sealedBy}${keySource ? ` (key from: ${keySource})` : ""}` : "by another UniChat process or install";
  return `The data folder ${dataDir} was last sealed ${who} with a different encryption key than this app is using, so the ${what === "sync" ? "device-sync state" : "message archive"} cannot be opened. Nothing was changed or deleted.`;
}
/** `key-source` (no secrets): which kind of key sealed this folder and which program used it last, so a mismatch can be explained. */
export function readKeySource(dataDir: string): { source?: string; by?: string } {
  try { return JSON.parse(readFileSync(join(dataDir, "key-source"), "utf8")); } catch { return {}; }
}
function writeKeySource(dataDir: string, source: string, by?: string) {
  try { const cur = readKeySource(dataDir), next = { source, by: by ?? cur.by }; if (cur.source !== next.source || cur.by !== next.by) writeFileSync(join(dataDir, "key-source"), JSON.stringify(next) + "\n", { mode: 0o600 }); } catch { /* informational only */ }
}

export interface BackendOptions { /** short name of this program for the `key-source` note and mismatch messages, e.g. "desktop app" or "web server" */ name?: string;
  /** a non-fatal problem the shell should tell the user about (the backend keeps running, e.g. without device sync) */ onProblem?: (e: DataKeyMismatchError) => void; keyWrap?: KeyWrap; /** where backup file paths are accepted: desktop passes { paths: "any" } (paths come from native dialogs) */ backup?: BackupPolicy; appVersion?: string;
  /** Return as soon as the Hub is constructed and run `hub.init()` (accounts, sync, ...) in the background: `backendReady(hub)` resolves when it is done. Android uses this to open its socket (and answer `$ping`) while a big archive loads. */ deferInit?: boolean;
  /** self-update: asset key of this platform (android | desktop-linux-appimage | desktop-linux-deb), platform installer, mode; see packages/core/src/updater.ts */ update?: Pick<NonNullable<HubOptions["update"]>, "platform" | "install" | "installMode" | "isMetered"> }

/**
 * The 32-byte key that encrypts the message archive and media cache at rest.
 *  1. UNIMSG_DB_KEY (base64 or hex): supplied by the operator, never written to disk by us.
 *  2. `unimsg.key.enc`: key sealed by the host's KeyWrap (OS keychain on desktop).
 *  3. `unimsg.key` (0600): random key file next to the data. This only protects against someone obtaining the
 *     database (or a backup of it) WITHOUT the key file; it does not protect against local access to both.
 */
export async function loadDataKey(dataDir: string, opts: BackendOptions = {}): Promise<{ key: Uint8Array; source: "env" | "keychain" | "file" }> {
  const env = process.env.UNIMSG_DB_KEY?.trim();
  if (env) {
    const k = /^[0-9a-f]{64}$/i.test(env) ? Buffer.from(env, "hex") : Buffer.from(env, "base64");
    if (k.length !== 32) throw new Error("UNIMSG_DB_KEY must be 32 bytes (64 hex characters or base64)");
    return { key: new Uint8Array(k), source: "env" };
  }
  const write = (path: string, data: Uint8Array) => { writeFileSync(path, data, { mode: 0o600 }); try { chmodSync(path, 0o600); } catch { /* ignore */ } };
  if (opts.keyWrap) {
    const f = join(dataDir, "unimsg.key.enc");
    if (existsSync(f)) {
      opts.keyWrap.resealNeeded = false;
      const key = await opts.keyWrap.unwrap(readFileSync(f));
      if (opts.keyWrap.resealNeeded) { try { write(f, await opts.keyWrap.wrap(key)); } catch { /* keep the old blob */ } }
      return { key, source: "keychain" };
    }
    // A folder made by the web server / dev backend has a plain `unimsg.key` and a database sealed with it: adopt that key (sealed by the keychain from now on; the old file stays, the server still needs it) instead of minting a second key that could not open the data.
    const old = join(dataDir, "unimsg.key");
    if (existsSync(old) && readFileSync(old).length === 32) { const key = new Uint8Array(readFileSync(old)); try { write(f, await opts.keyWrap.wrap(key)); } catch { /* keep using the file key this run */ } return { key, source: "keychain" }; }
    const key = randomBytes(32); write(f, await opts.keyWrap.wrap(key));
    return { key: new Uint8Array(key), source: "keychain" };
  }
  const f = join(dataDir, "unimsg.key");
  if (existsSync(f)) return { key: new Uint8Array(readFileSync(f)), source: "file" };
  const key = randomBytes(32); write(f, key);
  return { key: new Uint8Array(key), source: "file" };
}

/** Stage timing hook: the Android shell installs globalThis.__unimsgPlog (apps/android/src/perflog.ts); a no-op elsewhere. */
const plog: (stage: string, data?: Record<string, unknown>) => void = (...a) => (globalThis as any).__unimsgPlog?.(...a);
async function stage<T>(name: string, f: () => T | Promise<T>): Promise<T> { const t = Date.now(); try { return await f(); } finally { plog(name, { ms: Date.now() - t }); } }

export async function startBackend(dataDir: string, opts: BackendOptions = {}): Promise<Hub> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 }); // before the DB is opened
  const { key, source } = await stage("host.loadDataKey", () => loadDataKey(dataDir, opts));
  // Instagram is switched off for now (its login is refused with "needs_upgrade", see issue #44); UNIMSG_ENABLE_INSTAGRAM=1 brings it back.
  const providers = [signal, matrix, mattermost, ...(process.env.UNIMSG_ENABLE_INSTAGRAM === "1" ? [instagram] : []), discord, threema, threemaMd, teams, ...(await loadWhatsapp())];
  let syncStore: SyncStore, syncKeyBad = false; // device sync hook: wraps the store
  const t0 = Date.now();
  const sqlite = new SqliteStore(join(dataDir, "unimsg.db"), key); plog("host.SqliteStore", { ms: Date.now() - t0 });
  const prev = readKeySource(dataDir);
  if (!sqlite.keyMatches()) { sqlite.close(); throw new DataKeyMismatchError(dataDir, "archive", prev.by, prev.source); } // a handled condition, not an unhandled rejection from deep inside init()
  const hub = new Hub(join(dataDir, "accounts"), providers, syncStore = new SyncStore(sqlite), { dataKey: key, backup: opts.backup ?? { paths: "dir", dir: join(dataDir, "backups") }, appVersion: opts.appVersion, update: opts.update });
  console.log(`[unimsg] message archive is encrypted at rest (key from ${source})`);
  plog("host.Hub constructed", { ms: Date.now() - t0 });
  const t1 = Date.now();
  try { attachSync(hub, syncStore!, { dir: dataDir, dataKey: key, deviceName: process.env.UNIMSG_DEVICE_NAME || undefined, mdns: process.env.UNIMSG_SYNC_MDNS !== "0", wildcardLan: process.env.UNIMSG_PLATFORM === "android" }); } // device sync hook (idle: no listener until pairing is open or the user enables it; mDNS only runs while a listener is open)
  catch (e) {
    // sync.db sealed with another key: run WITHOUT device sync; sync.db is left untouched.
    if (!isWrongKey(e)) throw e;
    const err = new DataKeyMismatchError(dataDir, "sync", prev.by, prev.source);
    console.warn(`[unimsg] ${err.message} Device sync is disabled for this run.`);
    opts.onProblem?.(err);
    syncKeyBad = true;
  }
  plog("host.attachSync", { ms: Date.now() - t1 });
  if (!syncKeyBad) writeKeySource(dataDir, source, opts.name); // only record a key as "the" key of this folder when everything opened with it
  const init = async () => {
    await stage("host.hub.init", () => hub.init({ background: !!opts.deferInit })); // restores accounts, resumes pending jobs – no UI needed
    hub.updater.start(); // background "is there a newer release" (auto-check setting, every 6 h; never for dev builds)
  };
  if (opts.deferInit) { const p = init(); readiness.set(hub, p); p.catch(() => {}); return hub; }
  await init();
  return hub;
}
const readiness = new WeakMap<Hub, Promise<void>>();
/** Resolves when the Hub's init() has finished (immediately unless started with `deferInit`); rejects when it failed. */
export function backendReady(hub: Hub): Promise<void> { return readiness.get(hub) ?? Promise.resolve(); }
