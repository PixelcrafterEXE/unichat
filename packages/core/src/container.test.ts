import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupError, collectBody, inspectArchive, openArchive, verifyArchive, writeArchive } from "./container.js";

const dir = mkdtempSync(join(tmpdir(), "container-"));
const opt = { passphrase: "correct horse", kdfN: 1 << 14 };
async function make(name: string, n = 5) {
  const f = join(dir, name);
  await writeArchive(f, { ...opt, manifest: { app: "unimsg", hello: "world" }, entries: (function* () { for (let i = 0; i < n; i++) yield { head: { kind: "rows", i }, body: Buffer.from(`row ${i} `.repeat(100)) }; })() });
  return f;
}
const expectCode = async (p: Promise<unknown>, code: string) => { try { await p; } catch (e) { assert.ok(e instanceof BackupError, String(e)); assert.equal(e.code, code, e.message); return; } assert.fail("expected " + code); };

test("round trip", async () => {
  const f = await make("a.unimsg-backup");
  assert.deepEqual((await inspectArchive(f, opt.passphrase)).manifest.hello, "world");
  const a = await openArchive(f, opt.passphrase); let i = 0;
  for await (const e of a.entries()) { assert.equal(e.head.i, i); assert.equal((await collectBody(e.body)).toString(), `row ${i} `.repeat(100)); i++; }
  assert.equal(i, 5); assert.equal(a.footer()!.kinds.rows, 5);
  assert.equal(existsSync(f + ".part"), false);
});
test("wrong passphrase / not a backup / unknown version", async () => {
  const f = await make("b.unimsg-backup");
  await expectCode(inspectArchive(f, "nope nope"), "bad-passphrase");
  const junk = join(dir, "junk"); writeFileSync(junk, "hello world, not a backup at all");
  await expectCode(inspectArchive(junk, "x"), "not-a-backup");
  const v = Buffer.from(readFileSync(f)); v.writeUInt16BE(9, 8); const vf = join(dir, "v"); writeFileSync(vf, v);
  await expectCode(inspectArchive(vf, opt.passphrase), "unsupported-version");
});
test("tampering at many offsets is detected", async () => {
  const f = await make("c.unimsg-backup", 40), raw = readFileSync(f);
  for (const off of [10, 14, 40, 200, Math.floor(raw.length / 2), raw.length - 40, raw.length - 1]) {
    const b = Buffer.from(raw); b[off] ^= 0x40; const tf = join(dir, "t" + off); writeFileSync(tf, b);
    await assert.rejects(verifyArchive(tf, opt.passphrase), (e: unknown) => e instanceof BackupError, `offset ${off}`);
  }
});
test("truncation and trailing data are detected", async () => {
  const f = await make("d.unimsg-backup", 40), raw = readFileSync(f);
  for (const cut of [raw.length - 1, raw.length - 30, Math.floor(raw.length / 2), 200]) {
    const tf = join(dir, "cut" + cut); writeFileSync(tf, raw.subarray(0, cut));
    await assert.rejects(verifyArchive(tf, opt.passphrase), (e: unknown) => e instanceof BackupError, `cut ${cut}`);
  }
  const ex = join(dir, "extra"); writeFileSync(ex, Buffer.concat([raw, Buffer.from("zz")]));
  await expectCode(verifyArchive(ex, opt.passphrase), "corrupt");
});
test("dropped or reordered frames are detected", async () => {
  // random data does not compress, so there are many frames
  const f = join(dir, "e"); const rnd = (await import("node:crypto")).randomBytes(600_000);
  await writeArchive(f, { ...opt, manifest: { app: "unimsg" }, entries: [{ head: { kind: "x" }, body: rnd }] });
  const raw = readFileSync(f); const hl = raw.readUInt32BE(10), start = 14 + hl;
  const frames: Buffer[] = []; for (let p = start; p < raw.length;) { const n = raw.readUInt32BE(p); frames.push(raw.subarray(p, p + 5 + n)); p += 5 + n; }
  assert.ok(frames.length > 6);
  const mk = (fs: Buffer[]) => { const o = join(dir, "re" + fs.length + Math.random()); writeFileSync(o, Buffer.concat([raw.subarray(0, start), ...fs])); return o; };
  const swapped = [...frames]; [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
  await assert.rejects(verifyArchive(mk(swapped), opt.passphrase), BackupError);
  await assert.rejects(verifyArchive(mk(frames.filter((_, i) => i !== 3)), opt.passphrase), BackupError);
  await assert.rejects(verifyArchive(mk(frames.slice(0, -1)), opt.passphrase), BackupError);
});
test("cancel leaves nothing behind", async () => {
  const ctl = new AbortController(); const f = join(dir, "cancel.unimsg-backup");
  const p = writeArchive(f, { ...opt, manifest: {}, signal: ctl.signal, entries: (async function* () { for (let i = 0; ; i++) { if (i === 3) ctl.abort(); yield { head: { kind: "r" }, body: Buffer.alloc(100_000, i) }; } })() });
  await expectCode(p, "cancelled");
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("cancel")), []);
});
test("large synthetic stream keeps memory bounded", async () => {
  const f = join(dir, "big.unimsg-backup"), piece = (await import("node:crypto")).randomBytes(1 << 20), MB = 160;
  const before = process.memoryUsage().rss; let peak = before;
  await writeArchive(f, { ...opt, manifest: { app: "unimsg" }, comp: "gzip", level: 1,
    entries: (async function* () { for (let i = 0; i < 4; i++) yield { head: { kind: "big", i }, size: (MB / 4) << 20, body: (async function* () { for (let k = 0; k < MB / 4; k++) { yield piece; peak = Math.max(peak, process.memoryUsage().rss); } })() }; })() });
  const v = await verifyArchive(f, opt.passphrase, { onProgress: () => { peak = Math.max(peak, process.memoryUsage().rss); } });
  assert.equal(v.footer.kinds.big, 4);
  assert.ok(peak - before < 120 * 1024 * 1024, `rss grew by ${((peak - before) / 1048576) | 0} MiB for ${MB} MiB of data`);
});
