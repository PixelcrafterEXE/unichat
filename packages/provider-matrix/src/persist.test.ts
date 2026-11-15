// Offline: Rust crypto on fake-indexeddb survives a snapshot/restore cycle (same device identity keys).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "matrix-js-sdk";
import { IdbPersister, installFakeIndexedDB } from "./idb-persist.js";

async function boot(file: string, prefix: string) {
  const idb = await installFakeIndexedDB();
  const p = new IdbPersister(idb, prefix, file, (e) => { throw e; });
  const had = await p.restore();
  const c = createClient({ baseUrl: "http://127.0.0.1:9", userId: "@t:x", deviceId: "DEV", accessToken: "t", fetchFn: (async () => { throw new Error("offline"); }) as typeof fetch });
  await c.initRustCrypto({ cryptoDatabasePrefix: prefix, storageKey: new Uint8Array(32).fill(7) });
  const keys = await c.getCrypto()!.getOwnDeviceKeys();
  await p.flush();
  return { had, keys, idb, p, c };
}

test("crypto store persists across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-"));
  try {
    const file = join(dir, "c.bin");
    const a = await boot(file, "t1");
    assert.equal(a.had, false);
    a.c.stopClient(); await a.p.stop();
    // wipe in-memory DBs to simulate a fresh process
    for (const d of await a.idb.databases()) a.idb.deleteDatabase(d.name!);
    const b = await boot(file, "t1");
    assert.equal(b.had, true);
    assert.deepEqual(b.keys, a.keys);
    b.c.stopClient(); await b.p.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("drop(): databases deleted, snapshot never written again, re-login with a new device gets a clean store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-"));
  try {
    const file = join(dir, "c.bin");
    const a = await boot(file, "t2");
    a.c.stopClient();
    await a.p.drop(() => rmSync(file, { force: true }));
    await a.p.flush(); await a.p.stop();
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(file), false, "no snapshot written after drop (regression: invalidated session left matrix-crypto.bin behind)");
    assert.equal((await a.idb.databases()).filter((d) => d.name!.startsWith("t2")).length, 0, "in-memory crypto DBs removed (regression: re-login in the same process reused them)");
    const b = await boot(file, "t2");
    assert.equal(b.had, false);
    assert.notDeepEqual(b.keys, a.keys);
    b.c.stopClient(); await b.p.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SDK module-level logger is silent (regression: it printed HTTP traces with room ids to the Hub's stdout)", async () => {
  await import("./index.js");
  const { logger } = await import("matrix-js-sdk/lib/logger.js");
  const out: string[] = [];
  const o = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error, trace: console.trace };
  for (const k of Object.keys(o) as (keyof typeof o)[]) (console as any)[k] = (...a: unknown[]) => out.push(a.join(" "));
  try { const child = logger.getChild("Probe"); child.info("hello"); child.debug("x"); child.warn("w"); logger.info("root"); }
  finally { Object.assign(console, o); }
  assert.deepEqual(out, []);
});
