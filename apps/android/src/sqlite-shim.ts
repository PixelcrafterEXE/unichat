// Drop-in replacement for `node:sqlite` (DatabaseSync) used ONLY in the Android backend bundle: the build script aliases
// `node:sqlite` to this file, so packages/store-sqlite stays untouched.
//
// Why: nodejs-mobile ships Node 18.x, which has no `node:sqlite` (added in Node 22.5). Engines, tried in this order
// (override with UNIMSG_SQLITE=node|better|sqljs):
//   1. node    – the real `node:sqlite`, if the runtime has it (a future nodejs-mobile based on Node >= 22.13).
//   2. better  – `better-sqlite3`, a native add-on. Requires cross-compiling it for android with nodejs-mobile-gyp
//                (see README). Not bundled; resolved at run time from nodejs-project/node_modules.
//   3. sqljs   – sql.js (SQLite compiled to WebAssembly). No native build step. The whole database lives in memory and is
//                written to disk (tmp+fsync+rename, previous image kept as .bak, corruption fallback: sqljs-persist.ts) shortly after every change, on pause / low memory and on shutdown. Fine for a first bring-up;
//                the cost is RAM = database size and up to FLUSH_MS of changes lost on a hard kill.
import { createRequire } from "node:module";
import { readFileSync, existsSync, chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHUNK, chunkHashes, diffChunks, loadImage, recoverJournal, refreshBackup, saveIncremental, writeImage, writeImageAsync } from "./sqljs-persist.js";
import { plog } from "./perflog.js";

type SqlValue = string | number | bigint | null | Uint8Array;
interface Statement { all(...p: SqlValue[]): unknown[]; get(...p: SqlValue[]): unknown; run(...p: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }; iterate(...p: SqlValue[]): Iterable<unknown>; }
interface Engine { exec(sql: string): void; prepare(sql: string): Statement; close(): void; flush?(): void; }

const FLUSH_MS = Number(process.env.UNIMSG_SQLJS_FLUSH_MS ?? 1500);
const req = createRequire(import.meta.url);
let sqlJs: any;
const openSqlJs = new Set<SqlJsEngine>();

/** Must be awaited once before the first `new DatabaseSync` when the sql.js engine may be used. Cheap no-op otherwise. */
export async function prepareSqlite(): Promise<{ engine: string }> {
  const want = (process.env.UNIMSG_SQLITE ?? "auto").toLowerCase();
  const engine = pick(want);
  if (engine === "sqljs" && !sqlJs) {
    const here = dirname(fileURLToPath(import.meta.url));
    const exists = (p: string) => { try { return existsSync(p); } catch { return false; } };
    // next to main.js first (the Android bundle ships it there); resolve() is only a fallback and throws when sql.js is absent, so it must stay lazy
    const near = join(here, "sql-wasm.wasm");
    let wasm: string | undefined = exists(near) ? near : undefined;
    if (!wasm) try { const p = req.resolve("sql.js/dist/sql-wasm.wasm"); if (exists(p)) wasm = p; } catch { /* not installed */ }
    if (!wasm) throw new Error("sql-wasm.wasm not found next to main.js");
    const init = (await import("sql.js")).default as (c: object) => Promise<any>;
    sqlJs = await init({ wasmBinary: readFileSync(wasm) });
  }
  chosen = engine;
  return { engine };
}

let chosen: string | undefined;
function pick(want: string): string {
  if (want !== "auto") return want;
  if (process.getBuiltinModule?.("node:sqlite")) return "node";
  try { req("better-sqlite3"); return "better"; } catch { return "sqljs"; }
}

class SqlJsEngine implements Engine {
  private db: any; private dirty = false; private lastFlush = 0; private inTx = false; private hashes?: Buffer; private backingUp = false; private timer?: NodeJS.Timeout;
  constructor(private file: string) {
    // corruption-aware load: main file, then an interrupted write's .tmp, then the .bak copy (see sqljs-persist.ts). Throws when files
    // exist but none is usable, so the backend refuses to start instead of silently opening an empty archive.
    const t0 = Date.now();
    recoverJournal(file, (m) => console.warn("[unimsg] sqlite:", m));
    let kept: any; // the validated database is kept: opening a second copy of a 160 MB image only to run quick_check cost 160 MB of RAM for good (wasm memory never shrinks)
    const loaded = loadImage(file, (data) => {
      const t = new sqlJs.Database(data);
      try { const r = t.exec("PRAGMA quick_check")[0]?.values[0][0]; if (r !== "ok") throw new Error("quick_check: " + r); } catch (e) { t.close(); throw e; }
      kept?.close(); kept = t;
    }, (m) => console.warn("[unimsg] sqlite:", m));
    this.db = kept ?? new sqlJs.Database(loaded?.data);
    plog("sqljs-open", { file: basename(file), bytes: loaded?.data.length ?? 0, source: loaded?.source ?? "new", ms: Date.now() - t0 });
    this.dirty = !!loaded && loaded.source !== "main"; // re-materialise the main file from the backup
    if (this.dirty) this.touch();
    else if (loaded) { this.hashes = chunkHashes(loaded.data); this.backingUp = true; void refreshBackup(file).finally(() => { this.backingUp = false; if (this.dirty && !this.timer) this.touch(); }); } // baseline for incremental saves + fresh .bak
    openSqlJs.add(this);
  }
  exec(sql: string) {
    this.db.exec(sql);
    if (/^\s*BEGIN/i.test(sql)) this.inTx = true; else if (/^\s*(COMMIT|END|ROLLBACK)/i.test(sql)) { this.inTx = false; if (this.dirty) this.touch(); }
    if (!/^\s*(BEGIN|SELECT|PRAGMA\s+\w+\s*(\(|;|$))/i.test(sql)) this.touch();
  }
  prepare(sql: string): Statement {
    const self = this, db = this.db;
    const norm = (p: SqlValue[]) => p.map((v) => (typeof v === "bigint" ? Number(v) : v === undefined ? null : v));
    const rows = (p: SqlValue[]) => { const s = db.prepare(sql); try { s.bind(norm(p)); const out: unknown[] = []; while (s.step()) out.push(s.getAsObject()); return out; } finally { s.free(); } };
    return {
      all: (...p) => rows(p),
      get: (...p) => rows(p)[0],
      iterate: (...p) => rows(p),
      run: (...p) => {
        const s = db.prepare(sql); try { s.bind(norm(p)); s.step(); } finally { s.free(); }
        self.touch();
        const changes = db.getRowsModified();
        const id = db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] ?? 0;
        return { changes, lastInsertRowid: id as number };
      },
    };
  }
  /**
   * Saving a sql.js image means export() (a synchronous copy of the whole database, ~0.6 s per 160 MB, ~2x RAM while it lives) + writing it.
   * So saves are rare and cheap for the event loop:
   *  - the delay after a change adapts to the cost of the last save (>= 12x its duration, 1.5 s .. 2 min): a big archive that is being
   *    written to continuously (sync apply, import) is saved every ~30 s instead of every 1.5 s, which kept the single thread busy forever;
   *  - the file write + fsync runs on the thread pool in pieces (writeImageAsync), only export() blocks;
   *  - never while a BEGIN is open (export() would end it); a hard kill loses at most the delay of changes (sync re-fetches them);
   *  - flushSqlite() (background / low memory / shutdown) still saves at once and synchronously.
   */
  private touch() {
    this.dirty = true; if (this.timer) return;
    const delay = Math.min(120_000, Math.max(FLUSH_MS, this.lastCost * 20));
    this.timer = setTimeout(() => { this.timer = undefined; this.save(); }, delay); this.timer.unref();
  }
  private lastCost = 0; private gen = 0; private saving = false;
  private save() {
    if (!this.dirty) return;
    if (this.saving || this.backingUp) { this.touch(); return; } // previous write / the .bak copy still going: try again later
    if (this.inTx) { this.timer = setTimeout(() => { this.timer = undefined; this.save(); }, 500); this.timer.unref(); return; }
    const t0 = Date.now(), gen = ++this.gen;
    let data: Uint8Array;
    try { data = this.db.export(); } catch (e) { console.error("[unimsg] sqlite export failed:", (e as Error)?.message); this.touch(); return; }
    this.dirty = false;
    const t1 = Date.now(), done = (kind: string, extra: Record<string, unknown>) => {
      this.lastCost = Date.now() - t0;
      plog(kind, { file: basename(this.file), bytes: data.length, exportMs: t1 - t0, ...extra, totalMs: this.lastCost, sinceLastS: this.lastFlush ? ((t0 - this.lastFlush) / 1000).toFixed(1) : "-", nextInS: (Math.min(120_000, Math.max(FLUSH_MS, this.lastCost * 20)) / 1000).toFixed(1) });
      this.lastFlush = t0;
    };
    try {
      if (this.hashes && existsSync(this.file)) {
        const d = diffChunks(data, this.hashes), t2 = Date.now();
        if (d.changed.length * CHUNK < data.length * 0.4) { // the usual case: a sync batch / a few messages
          saveIncremental(this.file, data, d.changed); this.hashes = d.hashes;
          done("sqljs-save", { chunks: d.changed.length, kb: Math.round(d.changed.length * CHUNK / 1024), hashMs: t2 - t1, writeMs: Date.now() - t2 });
          if (this.dirty && !this.timer) this.touch(); return;
        }
      }
    } catch (e) { console.error("[unimsg] incremental save failed, writing the whole image:", (e as Error)?.message); }
    this.saving = true; // most of the file changed (or no baseline): whole image, written on the thread pool
    void writeImageAsync(this.file, data, () => gen === this.gen).then((ok) => {
      this.saving = false; if (ok) this.hashes = chunkHashes(data);
      done(ok ? "sqljs-save-full" : "sqljs-save-superseded", { writeMs: Date.now() - t1 });
      if (this.dirty && !this.timer) this.touch();
    }, (e) => { this.saving = false; this.dirty = true; console.error("[unimsg] sqlite save failed:", (e as Error)?.message); this.touch(); });
  }
  /** Synchronous save now (shutdown, app to background, low memory). Supersedes a save that is still being written. */
  flush(force = false) {
    if (!this.dirty && !(force && this.saving)) return; // nothing new (an in-flight save already holds the current image; on shutdown it might not finish, so write again)
    if (this.inTx && !force) return; // a transaction spans awaits (an import): its COMMIT re-arms the timer
    const t0 = Date.now(); this.gen++;
    const data = this.db.export(); // callers are synchronous, so no transaction is open here (sql.js export() would end one)
    const t1 = Date.now();
    let kind = "full";
    try {
      const d = this.hashes && existsSync(this.file) && !this.backingUp ? diffChunks(data, this.hashes) : undefined;
      if (d && d.changed.length * CHUNK < data.length * 0.4) { saveIncremental(this.file, data, d.changed); this.hashes = d.hashes; kind = "incremental " + d.changed.length + " chunks"; }
    } catch (e) { console.error("[unimsg] incremental flush failed:", (e as Error)?.message); kind = "full"; }
    if (kind === "full") { writeImage(this.file, data); this.hashes = chunkHashes(data); }
    this.dirty = false; this.saving = false; this.gen++;
    plog("sqljs-flush", { file: basename(this.file), kind, bytes: data.length, exportMs: t1 - t0, writeMs: Date.now() - t1 });
    this.lastFlush = t0; this.lastCost = Date.now() - t0;
  }
  close() { clearTimeout(this.timer); this.flush(true); this.db.close(); openSqlJs.delete(this); }
}

/** Flush every sql.js database to disk (call on shutdown / when the app goes to the background). */
export function flushSqlite(force = false) { for (const e of openSqlJs) e.flush(force); }

export class DatabaseSync {
  private e: Engine;
  constructor(file: string) {
    const kind = chosen ?? pick((process.env.UNIMSG_SQLITE ?? "auto").toLowerCase());
    if (kind === "node") this.e = new (process.getBuiltinModule("node:sqlite") as any).DatabaseSync(file);
    else if (kind === "better") { const D = req("better-sqlite3"); this.e = new D(file) as Engine; }
    else if (kind === "sqljs") { if (!sqlJs) throw new Error("call prepareSqlite() before opening a database (sql.js needs async init)"); this.e = new SqlJsEngine(file); }
    else throw new Error(`unknown UNIMSG_SQLITE engine: ${kind}`);
    if (kind === "sqljs") try { chmodSync(file, 0o600); } catch { /* not written yet */ }
  }
  exec(sql: string) { this.e.exec(sql); }
  prepare(sql: string) { return this.e.prepare(sql); }
  close() { this.e.close(); }
}
