import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.js";
import { loadSession, saveSession } from "./secret.js";

test("portable session: exported with an env key, re-sealed on import under another key; sealed file and key are not exported", async () => {
  const a = mkdtempSync(join(tmpdir(), "dc-a-")), b = mkdtempSync(join(tmpdir(), "dc-b-"));
  process.env.UNIMSG_DISCORD_KEY = "source-key";
  try {
    saveSession(a, { mode: "user", token: "tok-123" });
    const ex = await factory.exportSession!(a);
    assert.deepEqual(ex!.omit!.sort(), ["discord-session.json", "discord-session.key"]);
    const file = ex!.files![0]!; assert.match(Buffer.from(file.data).toString(), /tok-123/);
    writeFileSync(join(b, file.rel), file.data);
    process.env.UNIMSG_DISCORD_KEY = "target-key";
    await factory.importSession!(b);
    assert.equal(loadSession(b)?.token, "tok-123");
    assert.ok(!readdirSync(b).some((n) => n.includes("portable")));
    process.env.UNIMSG_DISCORD_KEY = "source-key"; assert.equal(loadSession(b), undefined);
    assert.equal(await factory.exportSession!(mkdtempSync(join(tmpdir(), "dc-c-"))), undefined);
  } finally { delete process.env.UNIMSG_DISCORD_KEY; }
});
