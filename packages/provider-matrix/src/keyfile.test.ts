import test from "node:test";
import assert from "node:assert/strict";
import { decryptKeyFile, encryptKeyFile } from "./keyfile.js";

test("room-key file round trip, wrong passphrase and junk", () => {
  const json = JSON.stringify([{ algorithm: "m.megolm.v1.aes-sha2", room_id: "!r:x", session_id: "s", session_key: "k" }]);
  const f = encryptKeyFile(json, "hunter2");
  assert.equal(decryptKeyFile(f, "hunter2"), json);
  assert.throws(() => decryptKeyFile(f, "nope"), /Wrong passphrase/);
  assert.throws(() => decryptKeyFile("hello", "x"), /not an exported/);
});
