// Encrypted on-disk cache for attachment bytes, so media that was opened keeps working after an account is
// signed out (the provider's download keys are gone then). One folder per account so it can be deleted with it.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MediaBlob { data: Uint8Array; mime: string; name?: string }

export class MediaCache {
  constructor(private root: string, private key?: Uint8Array) {}
  private dir(accountId: string) { return join(this.root, accountId.replace(/[^\w.-]/g, "_")); }
  private file(accountId: string, k: string) { return join(this.dir(accountId), createHash("sha256").update(k).digest("hex") + ".bin"); }

  /** Cheap presence check (no decryption). */
  has(accountId: string, k: string): boolean { return existsSync(this.file(accountId, k)); }

  /** On-disk size of one cached blob (0 when absent): for estimates, no decryption. */
  size(accountId: string, k: string): number { try { return statSync(this.file(accountId, k)).size; } catch { return 0; } }

  get(accountId: string, k: string): MediaBlob | undefined {
    const f = this.file(accountId, k);
    if (!existsSync(f)) return undefined;
    try {
      let b = readFileSync(f);
      if (this.key) {
        const d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
        b = Buffer.concat([d.update(b.subarray(28)), d.final()]);
      }
      const n = b.readUInt32BE(0), meta = JSON.parse(b.subarray(4, 4 + n).toString("utf8")) as { mime: string; name?: string };
      return { data: new Uint8Array(b.subarray(4 + n)), mime: meta.mime, name: meta.name };
    } catch { return undefined; } // corrupt or wrong key: treat as not cached
  }

  put(accountId: string, k: string, v: MediaBlob) {
    mkdirSync(this.dir(accountId), { recursive: true, mode: 0o700 });
    const meta = Buffer.from(JSON.stringify({ mime: v.mime, name: v.name }), "utf8"), head = Buffer.alloc(4); head.writeUInt32BE(meta.length);
    let out: Buffer = Buffer.concat([head, meta, Buffer.from(v.data)]);
    if (this.key) {
      const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", this.key, iv);
      const ct = Buffer.concat([c.update(out), c.final()]); out = Buffer.concat([iv, c.getAuthTag(), ct]);
    }
    writeFileSync(this.file(accountId, k), out, { mode: 0o600 });
  }

  /** Remove one cached blob (used to undo a failed history import). */
  remove(accountId: string, k: string) { rmSync(this.file(accountId, k), { force: true }); }

  removeAccount(accountId: string) { rmSync(this.dir(accountId), { recursive: true, force: true }); }

  /** Retention: delete cached files not touched since `before` (ms epoch). */
  purgeOlderThan(before: number) {
    if (!existsSync(this.root)) return;
    for (const acc of readdirSync(this.root)) {
      const d = join(this.root, acc);
      for (const f of readdirSync(d)) { const p = join(d, f); try { if (statSync(p).mtimeMs < before) rmSync(p); } catch { /* ignore */ } }
    }
  }
}
