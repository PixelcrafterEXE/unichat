// At-rest protection for the Signal store.
//
// The whole store is one AES-256-GCM sealed blob (`signal-store.bin`, mode 0600) written atomically
// (tmp file + rename). The 32-byte data key lives in `signal-store.key` (mode 0600) UNLESS the host
// passes a `KeyProvider` (e.g. Electron safeStorage / Android Keystore) - then the key never touches
// the disk next to the data. With the default file key, encryption only protects against casual
// disclosure (backups of the data file alone, accidental sharing); an attacker who can read the whole
// dataDir can read both. This is stated in the README.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface KeyProvider {
  /** Return the 32-byte data key, creating and persisting it somewhere safe on first use. */
  getKey(): Uint8Array | Promise<Uint8Array>;
}

const MAGIC = Buffer.from("USIG1"); // format marker + version

export class FileKeyProvider implements KeyProvider {
  constructor(private readonly path: string) {}
  getKey(): Uint8Array {
    if (existsSync(this.path)) {
      const k = readFileSync(this.path);
      if (k.length !== 32) throw new Error("signal store key file is corrupt");
      return k;
    }
    const k = randomBytes(32);
    writeFileSync(this.path, k, { mode: 0o600 });
    chmodSync(this.path, 0o600);
    return k;
  }
}

export function seal(key: Uint8Array, plaintext: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(MAGIC);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

export function open(key: Uint8Array, blob: Uint8Array): Buffer {
  const b = Buffer.from(blob);
  if (b.length < MAGIC.length + 28 || !b.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("signal store: bad format");
  const iv = b.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = b.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(b.subarray(MAGIC.length + 28)), d.final()]);
}

/** A JSON document persisted sealed + atomically, with debounced writes. */
export class SealedJsonFile<T extends object> {
  private data!: T;
  private timer?: NodeJS.Timeout;
  private key!: Uint8Array;
  private writing: Promise<void> = Promise.resolve();
  readonly path: string;

  constructor(private readonly dir: string, private readonly fresh: () => T, private readonly keys?: KeyProvider,
              name = "signal-store") {
    this.path = join(dir, `${name}.bin`);
    this.keyProvider = keys ?? new FileKeyProvider(join(dir, `${name}.key`));
  }
  private keyProvider: KeyProvider;

  async load(): Promise<T> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.key = await this.keyProvider.getKey();
    if (existsSync(this.path)) this.data = JSON.parse(open(this.key, readFileSync(this.path)).toString("utf8")) as T;
    else this.data = this.fresh();
    return this.data;
  }

  get value(): T { return this.data; }

  /** Mark dirty; flushes shortly after (coalesces bursts of ratchet updates). */
  touch(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 250);
    this.timer.unref?.();
  }

  private destroyed = false;

  /** Remove the data + key files and make all further writes no-ops. */
  destroy(): void {
    this.destroyed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    for (const p of [this.path, `${this.path}.tmp`, this.path.replace(/\.bin$/, ".key")]) rmSync(p, { force: true });
  }

  flush(): Promise<void> {
    if (this.destroyed) return this.writing;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const snapshot = seal(this.key, Buffer.from(JSON.stringify(this.data), "utf8"));
    this.writing = this.writing.then(() => {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, snapshot, { mode: 0o600 });
      renameSync(tmp, this.path);
      chmodSync(this.path, 0o600);
    });
    return this.writing;
  }
}
