import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, MemoryStore } from "@unimsg/core";
import { createBackupHandler } from "./backup-http.js";

const local = (o: string) => o.startsWith("http://localhost");
async function boot(token?: string, maxUploadBytes = 1 << 20, seed = true) {
  const dir = mkdtempSync(join(tmpdir(), "bkhttp-")), store = new MemoryStore();
  if (seed) store.putMessages([{ id: "m", chatId: "a-1:c", sender: "S", senderId: "s", text: "via http", time: "2026-01-01T00:00:00Z", fromMe: false }]);
  const hub = new Hub(dir, [], store, { backup: { paths: "none", maxUploadBytes } });
  const h = createBackupHandler(hub, { token, allowedOrigins: [], isLocalOrigin: local });
  const srv = createServer((q, s) => { h(q, s).then((ok) => { if (!ok) { s.writeHead(404); s.end(); } }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  return { hub, store, base, close: () => { srv.close(); hub.backup.dispose(); } };
}

test("download is one-time, upload feeds import, token and origin are enforced", async () => {
  const t = await boot("sekret");
  try {
    const ex = await t.hub.call("exportData", { passphrase: "long enough pass", deliver: "download", kdfN: 1 << 14 }) as any;
    assert.equal((await fetch(`${t.base}/backup/download/${ex.downloadId}`)).status, 401);
    assert.equal((await fetch(`${t.base}/backup/download/${ex.downloadId}`, { headers: { authorization: "Bearer sekret", origin: "https://evil.example" } })).status, 403);
    const r = await fetch(`${t.base}/backup/download/${ex.downloadId}`, { headers: { authorization: "Bearer sekret" } });
    assert.equal(r.status, 200); const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString(), "UNIMSGBK"); assert.equal(bytes.length, ex.size);
    assert.equal((await fetch(`${t.base}/backup/download/${ex.downloadId}?token=sekret`)).status, 400); // single use
    // upload it to a second, empty backend
    const t2 = await boot("sekret2", 1 << 20, false);
    try {
      assert.equal((await fetch(`${t2.base}/backup/upload`, { method: "POST", body: bytes })).status, 401);
      const up = await fetch(`${t2.base}/backup/upload?token=sekret2`, { method: "POST", body: bytes, headers: { origin: "http://localhost:5173" } });
      assert.equal(up.status, 200); assert.equal(up.headers.get("access-control-allow-origin"), "http://localhost:5173");
      const { id } = await up.json() as { id: string };
      const res = await t2.hub.call("importData", { uploadId: id, passphrase: "long enough pass", mode: "new-install" }) as any;
      assert.equal(res.messages.added, 1); assert.equal(t2.store.getMessage("a-1:c", "m")!.text, "via http");
      await assert.rejects(t2.hub.call("importData", { uploadId: id, passphrase: "long enough pass", mode: "merge" })); // upload consumed
    } finally { t2.close(); }
  } finally { t.close(); }
});

test("upload size cap is enforced while streaming and leaves no file", async () => {
  const t = await boot(undefined, 1000);
  try {
    const r = await fetch(`${t.base}/backup/upload`, { method: "POST", body: Buffer.alloc(5000) });
    assert.equal(r.status, 413);
    const dir = join((t.hub as any).dataDir, ".backup");
    assert.deepEqual(existsSync(dir) ? (await import("node:fs")).readdirSync(dir).filter((n) => n.startsWith("upload-")) : [], []);
    assert.equal((await fetch(`${t.base}/backup/nope`)).status, 404);
  } finally { t.close(); }
});
