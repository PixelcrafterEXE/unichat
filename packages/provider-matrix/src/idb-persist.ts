// Node has no IndexedDB, but the Rust crypto store (matrix-sdk-crypto-wasm) only supports IndexedDB or memory.
// We run it on `fake-indexeddb` (pure JS, in-memory) and persist the databases ourselves: snapshot all databases
// whose name starts with `prefix` to one file in dataDir (atomically, mode 0600) and restore them on start.
// Contents are additionally encrypted by the crypto store itself (storeKey), see index.ts.
import { deserialize, serialize } from "node:v8";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

type Idx = { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean };
type Store = { name: string; keyPath: string | string[] | null; autoIncrement: boolean; indexes: Idx[]; records: [IDBValidKey, unknown][] };
type Db = { name: string; version: number; stores: Store[] };
type Dump = { v: 1; dbs: Db[] };

const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });

export async function installFakeIndexedDB(): Promise<IDBFactory> {
  const fake = await import("fake-indexeddb");
  const g = globalThis as any;
  // Never clobber a real IndexedDB (browser/Electron renderer); the rust-crypto wasm reads these globals.
  if (!g.indexedDB) {
    g.indexedDB = fake.indexedDB; g.IDBKeyRange = fake.IDBKeyRange; g.IDBRequest = fake.IDBRequest;
    g.IDBDatabase = fake.IDBDatabase; g.IDBTransaction = fake.IDBTransaction; g.IDBObjectStore = fake.IDBObjectStore;
    g.IDBIndex = fake.IDBIndex; g.IDBCursor = fake.IDBCursor; g.IDBCursorWithValue = fake.IDBCursorWithValue;
    g.IDBFactory = fake.IDBFactory; g.IDBOpenDBRequest = fake.IDBOpenDBRequest; g.IDBVersionChangeEvent = fake.IDBVersionChangeEvent;
  }
  return g.indexedDB as IDBFactory;
}

export async function dumpDatabases(idb: IDBFactory, prefix: string): Promise<Buffer> {
  const dbs: Db[] = [];
  for (const info of await idb.databases()) {
    if (!info.name || !info.name.startsWith(prefix)) continue;
    const db = await req(Object.assign(idb.open(info.name), {}) as IDBRequest<IDBDatabase>);
    try {
      const stores: Store[] = [];
      const names = [...db.objectStoreNames];
      if (names.length) {
        const tx = db.transaction(names, "readonly");
        for (const n of names) {
          const os = tx.objectStore(n);
          const records: [IDBValidKey, unknown][] = [];
          await new Promise<void>((ok, ko) => {
            const c = os.openCursor();
            c.onerror = () => ko(c.error);
            c.onsuccess = () => { const cur = c.result; if (!cur) return ok(); records.push([cur.primaryKey, cur.value]); cur.continue(); };
          });
          stores.push({
            name: n, keyPath: os.keyPath as any, autoIncrement: os.autoIncrement, records,
            indexes: [...os.indexNames].map((i) => { const ix = os.index(i); return { name: i, keyPath: ix.keyPath as any, unique: ix.unique, multiEntry: ix.multiEntry }; }),
          });
        }
      }
      dbs.push({ name: info.name, version: db.version, stores });
    } finally { db.close(); }
  }
  return serialize({ v: 1, dbs } satisfies Dump);
}

export async function restoreDatabases(idb: IDBFactory, data: Buffer): Promise<void> {
  const dump = deserialize(data) as Dump;
  if (dump?.v !== 1) throw new Error("unsupported crypto snapshot");
  for (const d of dump.dbs) {
    const open = idb.open(d.name, d.version);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const s of d.stores) {
        const os = db.createObjectStore(s.name, s.keyPath === null ? { autoIncrement: s.autoIncrement } : { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
        for (const i of s.indexes) os.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
      }
    };
    const db = await req(open as IDBRequest<IDBDatabase>);
    try {
      const names = d.stores.filter((s) => s.records.length).map((s) => s.name);
      if (!names.length) continue;
      const tx = db.transaction(names, "readwrite");
      const done = new Promise<void>((ok, ko) => { tx.oncomplete = () => ok(); tx.onerror = () => ko(tx.error); tx.onabort = () => ko(tx.error); });
      for (const s of d.stores.filter((x) => x.records.length)) {
        const os = tx.objectStore(s.name);
        for (const [k, v] of s.records) { if (s.keyPath === null) os.put(v, k); else os.put(v); }
      }
      await done;
    } finally { db.close(); }
  }
}

/** Periodically snapshots the databases to `file` when they changed. */
export class IdbPersister {
  private timer?: ReturnType<typeof setInterval>;
  private lastHash = "";
  private busy: Promise<void> = Promise.resolve();
  private idb: IDBFactory; private prefix: string; private file: string; private onError: (e: unknown) => void;
  constructor(idb: IDBFactory, prefix: string, file: string, onError: (e: unknown) => void) {
    this.idb = idb; this.prefix = prefix; this.file = file; this.onError = onError;
  }

  async restore(): Promise<boolean> {
    if (!existsSync(this.file)) return false;
    const buf = readFileSync(this.file);
    await restoreDatabases(this.idb, buf);
    this.lastHash = createHash("sha256").update(buf).digest("hex");
    return true;
  }
  start(everyMs = 10_000) { this.timer ??= setInterval(() => { void this.flush(); }, everyMs); this.timer.unref?.(); }
  private dropped = false;
  flush(): Promise<void> {
    this.busy = this.busy.then(async () => {
      if (this.dropped) return;
      try {
        const buf = await dumpDatabases(this.idb, this.prefix);
        const h = createHash("sha256").update(buf).digest("hex");
        if (h === this.lastHash) return;
        writeFileSync(this.file + ".tmp", buf, { mode: 0o600 });
        renameSync(this.file + ".tmp", this.file);
        this.lastHash = h;
      } catch (e) { this.onError(e); }
    });
    return this.busy;
  }
  /** Logout / revoked session: forget everything. Deletes the in-memory databases too (fake-indexeddb is process-global: a later login
   *  with the same account id would otherwise find the old device's crypto store and fail) and never writes the snapshot again. */
  async drop(rmFiles: () => void) {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.dropped = true;
    await this.busy.catch(() => undefined);
    rmFiles();
    try {
      for (const info of await this.idb.databases()) {
        if (!info.name || !info.name.startsWith(this.prefix)) continue;
        const r = this.idb.deleteDatabase(info.name);
        await Promise.race([req(r as IDBRequest<unknown>).catch(() => undefined), new Promise((ok) => setTimeout(ok, 2000))]);
      }
    } catch { /* best effort */ }
  }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.flush(); }
}
