import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@unimsg/store-sqlite";
import { Ledger } from "@unimsg/sync";
import { startBackend, DataKeyMismatchError, readKeySource } from "./index.js";

process.env.UNIMSG_SYNC_MDNS = "0";
const tmp = () => mkdtempSync(join(tmpdir(), "uch-"));

test("archive sealed with another key: DataKeyMismatchError naming who sealed it, nothing deleted", async () => {
  const dir = tmp();
  try {
    const old = randomBytes(32);
    writeFileSync(join(dir, "unimsg.key"), old, { mode: 0o600 });
    writeFileSync(join(dir, "key-source"), JSON.stringify({ source: "file", by: "web server" }));
    new SqliteStore(join(dir, "unimsg.db"), old).putAccount({ id: "a1", provider: "x", label: "Alice" });
    process.env.UNIMSG_DB_KEY = randomBytes(32).toString("hex");
    try {
      await assert.rejects(startBackend(dir), (e) => e instanceof DataKeyMismatchError && e.what === "archive" && /web server/.test(e.message));
    } finally { delete process.env.UNIMSG_DB_KEY; }
    assert.ok(existsSync(join(dir, "unimsg.db")) && existsSync(join(dir, "unimsg.key")));
    assert.equal(readKeySource(dir).by, "web server", "note not overwritten by a failed open");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only sync.db sealed with another key: backend starts without sync and reports it", async () => {
  const dir = tmp();
  try {
    new Ledger(join(dir, "sync.db"), randomBytes(32)).close();
    process.env.UNIMSG_DB_KEY = randomBytes(32).toString("hex");
    const problems: DataKeyMismatchError[] = [];
    try {
      const hub = await startBackend(dir, { name: "desktop app", onProblem: (e) => problems.push(e) });
      assert.ok(hub);
    } finally { delete process.env.UNIMSG_DB_KEY; }
    assert.equal(problems.length, 1); assert.equal(problems[0].what, "sync");
    assert.equal(readKeySource(dir).by, undefined, "key-source is not written while something is sealed differently");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a healthy start records key-source without any secret", async () => {
  const dir = tmp();
  try {
    process.env.UNIMSG_DB_KEY = randomBytes(32).toString("hex");
    try { await startBackend(dir, { name: "web server" }); } finally { delete process.env.UNIMSG_DB_KEY; }
    assert.deepEqual(readKeySource(dir), { source: "env", by: "web server" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
