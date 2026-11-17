import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, WrongKeyError, isWrongKey } from "./ledger.js";

test("a ledger sealed with another key throws WrongKeyError and leaves the file untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "ucl-")), f = join(dir, "sync.db");
  try {
    const k1 = randomBytes(32), k2 = randomBytes(32);
    const a = new Ledger(f, k1); const id = a.id; a.kvSet("secret", { x: 1 }); a.close();
    const before = readFileSync(f);
    assert.throws(() => new Ledger(f, k2), (e) => e instanceof WrongKeyError && isWrongKey(e) && (e as WrongKeyError).code === "WRONG_KEY");
    assert.deepEqual(readFileSync(f), before, "no rewrite");
    const again = new Ledger(f, k1); // the right key still works afterwards
    assert.equal(again.id, id); assert.deepEqual(again.kvGet("secret"), { x: 1 }); again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("isWrongKey recognises the raw node:crypto message and ignores other errors", () => {
  assert.equal(isWrongKey(new Error("Unsupported state or unable to authenticate data")), true); // Node 22 and earlier
  assert.equal(isWrongKey(new Error("error:1C800064:Provider routines::bad decrypt")), true);    // Node 24 and later
  assert.equal(isWrongKey(Object.assign(new Error("whatever OpenSSL says next"), { code: "ERR_OSSL_BAD_DECRYPT" })), true);
  assert.equal(isWrongKey(new Error("disk full")), false);
  assert.equal(isWrongKey(undefined), false);
});
