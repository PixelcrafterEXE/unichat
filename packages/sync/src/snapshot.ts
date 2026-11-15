// Initial transfer ("snapshot"): the whole current state of the ledger as ONE encrypted archive in the backup container format
// (packages/core/src/container.ts: chunked AES-GCM frames, gzip, authenticated footer), keyed by the device group key instead of a passphrase.
// The sender writes it to a file (so it can be offered again after an interruption); the receiver stores the encrypted bytes as they arrive
// (a resumable ".part"), verifies the hash, and only then reads entries out of it and applies them through the normal join (SyncStore.applyRemote).
// The archive's cursor is the sender's ledger sequence number when the snapshot started; incremental ledger sync continues from there.
import { createHash, hkdfSync } from "node:crypto";
import { collectBody, openArchive, writeArchive } from "@unimsg/core";
import type { Ledger } from "./ledger.js";
import { accountOfKey, parseKey } from "./crdt.js";
import type { ApplyResult, SyncMode, SyncStore, WireEntry } from "./syncstore.js";

export const SNAPSHOT_KIND = "unichat-sync-snapshot";
/** Passphrase for the container: derived from the group key and the snapshot id (a fresh id = a fresh key). */
export const snapshotPassphrase = (groupKeyB64: string, id: string) =>
  Buffer.from(hkdfSync("sha256", Buffer.from(groupKeyB64, "base64"), Buffer.from(id, "utf8"), "unichat-sync-snapshot-v1", 32)).toString("hex");

export interface BuiltSnapshot { cursor: number; entries: number; size: number; sha256: string }
export async function buildSnapshot(file: string, o: { ledger: Ledger; store: SyncStore; passphrase: string; modeOf(acct: string): SyncMode; signal?: AbortSignal; lineBytes?: number }): Promise<BuiltSnapshot> {
  const { ledger, store } = o, cursor = ledger.maxSeq(), mp = store.maps(), lineBytes = o.lineBytes ?? 256 * 1024;
  let count = 0;
  async function* entries() {
    let from = 0, buf: string[] = [], bytes = 0;
    const flush = () => { const b = Buffer.from(buf.join("\n") + "\n", "utf8"); buf = []; bytes = 0; return { head: { kind: "entries" }, body: b }; };
    for (;;) {
      const rows = ledger.since(from, 500); if (!rows.length) break;
      for (const e of rows) {
        from = e.seq; if (e.seq > cursor) break;
        const acct = accountOfKey(e.key);
        if ((acct && o.modeOf(acct) === "none") || parseKey(e.key).kind === "cr") continue; // credentials never ride in a snapshot: they are re-sent after it, still needing confirmation
        const w = store.entry(e, mp); if (!w) continue;
        const line = JSON.stringify(w); if (line.length > 4_000_000) continue; // an absurdly large single entity is left to the (also bounded) ledger path
        buf.push(line); bytes += line.length + 1; count++;
        if (bytes >= lineBytes) yield flush();
      }
      if (from >= cursor) break;
      await new Promise((ok) => setImmediate(ok));
    }
    if (buf.length) yield flush();
  }
  const r = await writeArchive(file, { passphrase: o.passphrase, kdfN: 1 << 14, comp: "gzip", level: 6, signal: o.signal, manifest: { kind: SNAPSHOT_KIND, v: 1, ledger: ledger.id, cursor, createdAt: new Date().toISOString() }, entries: entries() });
  return { cursor, entries: count, size: r.size, sha256: r.sha256 };
}

export async function sha256File(file: string): Promise<string> {
  const { createReadStream } = await import("node:fs"); const h = createHash("sha256");
  for await (const b of createReadStream(file)) h.update(b as Buffer);
  return h.digest("hex");
}

export interface AppliedSnapshot { cursor: number; ledger: string; entries: number; applied: number }
/** Read a verified snapshot and apply every entry. `batch` entries per transaction; `onProgress(applied, total?)` after each. */
export async function applySnapshot(file: string, passphrase: string, o: { apply(e: WireEntry[]): Promise<ApplyResult>; batch?: number; expectLedger?: string; onProgress?(n: number): void; signal?: AbortSignal }): Promise<AppliedSnapshot> {
  const a = await openArchive(file, passphrase, o.signal);
  try {
    const m = a.manifest;
    if (m.kind !== SNAPSHOT_KIND || m.v !== 1 || typeof m.cursor !== "number" || typeof m.ledger !== "string") throw new Error("This is not a sync snapshot.");
    if (o.expectLedger && m.ledger !== o.expectLedger) throw new Error("The snapshot belongs to a different device history.");
    let n = 0, applied = 0, pend: WireEntry[] = []; const per = o.batch ?? 1000;
    const go = async () => { if (!pend.length) return; const r = await o.apply(pend); applied += r.applied; n += pend.length; pend = []; o.onProgress?.(n); await new Promise((ok) => setImmediate(ok)); };
    for await (const e of a.entries()) {
      if (e.head.kind !== "entries") { for await (const _ of e.body) { /* skip unknown parts */ } continue; }
      const text = (await collectBody(e.body, 64 * 1024 * 1024)).toString("utf8");
      for (const line of text.split("\n")) { if (!line) continue; let w: WireEntry; try { w = JSON.parse(line); } catch { throw new Error("The snapshot is damaged."); } pend.push(w); if (pend.length >= per) await go(); }
    }
    await go(); // reaching here also verified the archive footer (hash, size, entry count): a damaged file threw above
    return { cursor: m.cursor, ledger: m.ledger, entries: n, applied };
  } finally { a.close(); }
}
