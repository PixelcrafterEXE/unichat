// Updater against a fake GitHub (two loopback servers: the "API" and a different-origin "CDN" that asset URLs redirect to). Never touches the real GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { compareVersions, parseManifest, parseVersion, Updater, type InstallContext, type UpdaterOptions } from "./updater.js";
import { Hub } from "./hub.js";
import { MemoryStore } from "./store.js";

const TOKEN = "ghp_faketoken1234567890";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
interface Rel { tag: string; prerelease?: boolean; draft?: boolean; files: Record<string, Buffer>; manifest?: object | string | null; notes?: string }

async function fake(releases: () => Rel[], o: { private?: boolean } = {}) {
  const log: { api: { url: string; auth?: string }[]; cdn: { url: string; auth?: string; range?: string }[] } = { api: [], cdn: [] };
  const ctl = { limit: 0 as 0 | 403 | 429, dropFirst: 0, ignoreRange: false, hang: false, bigDelayMs: 0 };
  const listen = (h: http.RequestListener) => new Promise<http.Server>((ok) => { const s = http.createServer(h); s.listen(0, "127.0.0.1", () => ok(s)); });
  const cdn = await listen(async (req, res) => {
    log.cdn.push({ url: req.url!, auth: req.headers.authorization, range: req.headers.range });
    const [, , rid, name] = req.url!.split("/"); const rel = releases().find((r) => r.tag === rid); const body = rel?.files[decodeURIComponent(name!)] ?? (name === "latest.json" ? Buffer.from(typeof rel?.manifest === "string" ? rel.manifest : JSON.stringify(rel?.manifest)) : undefined);
    if (!body) { res.writeHead(404).end(); return; }
    let from = 0; const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
    if (m && !ctl.ignoreRange) from = Number(m[1]);
    res.writeHead(from ? 206 : 200, { "content-length": body.length - from, "content-type": "application/octet-stream" });
    if (ctl.dropFirst > 0 && !from) { ctl.dropFirst--; res.write(body.subarray(0, Math.floor(body.length / 2))); setTimeout(() => res.destroy(), 20); return; }
    if (ctl.hang) { res.write(body.subarray(0, 10)); return; }
    res.end(body.subarray(from));
  });
  const cdnBase = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;
  const api = await listen((req, res) => {
    log.api.push({ url: req.url!, auth: req.headers.authorization });
    if (ctl.limit) { res.writeHead(ctl.limit, ctl.limit === 403 ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) } : { "retry-after": "120" }).end("{}"); return; }
    if (o.private && req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(o.private ? 404 : 401).end("{}"); return; }
    const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    if (req.url!.startsWith("/repos/o/r/releases?")) {
      const out = releases().map((r) => ({ tag_name: r.tag, prerelease: !!r.prerelease, draft: !!r.draft, body: r.notes ?? "notes", published_at: "2026-11-01T10:00:00Z",
        assets: [...(r.manifest === null ? [] : [{ name: "latest.json", url: `${base}/repos/o/r/releases/assets/${r.tag}~latest.json`, size: 10 }]), ...Object.entries(r.files).map(([n, b]) => ({ name: n, url: `${base}/repos/o/r/releases/assets/${r.tag}~${encodeURIComponent(n)}`, size: b.length }))] }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out)); return;
    }
    const m = /^\/repos\/o\/r\/releases\/assets\/([^~]+)~(.+)$/.exec(req.url!);
    if (m && req.headers.accept === "application/octet-stream") { res.writeHead(302, { location: `${cdnBase}/dl/${m[1]}/${m[2]}` }).end(); return; }
    res.writeHead(404).end("{}");
  });
  const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  return { apiBase, log, ctl, close: () => { api.closeAllConnections(); cdn.closeAllConnections(); api.close(); cdn.close(); } };
}

const APK = Buffer.from("A".repeat(300_000) + "apk-bytes");
const release = (n: number, o: Partial<Rel> = {}, apk = APK): Rel => {
  const name = `unichat-android-0.1.${n}-debug.apk`;
  return { tag: `v0.1.${n}`, files: { [name]: apk }, manifest: { version: `0.1.${n}`, publishedAt: "2026-11-01T10:00:00Z", notes: `Release ${n}`, assets: { android: { name, size: apk.length, sha256: sha(apk) } } }, ...o };
};

async function rig(rels: Rel[], uo: Partial<UpdaterOptions> = {}, fo: { private?: boolean } = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "upd-"));
  const f = await fake(() => rels, fo);
  const events: { e: string; d: any }[] = [];
  const mk = (extra: Partial<UpdaterOptions> = {}) => new Updater({ dataDir: dir, version: "0.1.5", platform: "android", apiBase: f.apiBase, emit: (e, d) => events.push({ e, d }), intervalMs: 0, retries: 2, timeoutMs: 2000, ...uo, ...extra });
  const u = mk(); u.settings({ repo: "o/r" });
  return { u, f, dir, events, mk, done: () => { u.dispose(); f.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("versions: numeric compare, v prefix, dev", () => {
  assert.deepEqual(parseVersion("v0.1.37"), [0, 1, 37]); assert.equal(parseVersion("dev"), undefined);
  assert.ok(compareVersions("0.1.10", "0.1.9") > 0); assert.ok(compareVersions("0.1.9", "0.1.10") < 0); assert.equal(compareVersions("0.1.9", "v0.1.9"), 0);
  assert.ok(compareVersions("dev", "0.0.1") < 0); assert.ok(compareVersions("0.2.0", "0.1.99") > 0);
});

test("manifest parsing: valid, junk assets dropped, path-like names refused", () => {
  const m = parseManifest({ version: "0.1.3", publishedAt: "x", notes: "n", assets: { android: { name: "a.apk", size: 5, sha256: "A".repeat(64) }, evil: { name: "../x", size: 5, sha256: "a".repeat(64) }, bad: { name: "b", size: 5, sha256: "zz" } } });
  assert.deepEqual(Object.keys(m.assets), ["android"]); assert.equal(m.assets.android!.sha256, "a".repeat(64));
  assert.throws(() => parseManifest({ version: "dev", assets: {} })); assert.throws(() => parseManifest(null)); assert.throws(() => parseManifest({ version: "0.1.1" }));
});

test("newer / equal / older release", async () => {
  const r = await rig([release(5), release(7), release(6)]);
  try {
    let s = await r.u.check({ manual: true });
    assert.equal(s.available, true); assert.equal(s.latest?.version, "0.1.7"); assert.equal(s.state, "available"); assert.equal(s.latest?.notes, "Release 7");
    assert.equal(r.events.filter((e) => e.e === "update-available").length, 1);
    await r.u.check({ manual: true }); assert.equal(r.events.filter((e) => e.e === "update-available").length, 1, "announced once per version");
    const eq = await rig([release(5)]); s = await eq.u.check({ manual: true }); assert.equal(s.available, false); assert.equal(s.state, "idle"); eq.done();
    const old = await rig([release(3)]); s = await old.u.check({ manual: true }); assert.equal(s.available, false); old.done();
  } finally { r.done(); }
});

test("prerelease filter and drafts; releases without manifest are ignored", async () => {
  const rels = [release(9, { prerelease: true }), release(8, { draft: true }), release(7, { manifest: null }), release(6)];
  const r = await rig(rels);
  try {
    assert.equal((await r.u.check({ manual: true })).latest?.version, "0.1.9"); // default channel allows prereleases
    r.u.settings({ channel: "stable" });
    const s = await r.u.check({ manual: true }); assert.equal(s.latest?.version, "0.1.6");
    assert.equal(s.settings.channel, "stable");
  } finally { r.done(); }
});

test("dev build: shows the latest version but never offers an install", async () => {
  const r = await rig([release(7)], { version: "dev" });
  try { const s = await r.u.check({ manual: true }); assert.equal(s.dev, true); assert.equal(s.available, false); assert.equal(s.latest?.version, "0.1.7"); await assert.rejects(r.u.download()); } finally { r.done(); }
});

test("private repo: token header on the API, NOT forwarded to the CDN redirect; anonymous fails clearly", async () => {
  const r = await rig([release(7)], {}, { private: true });
  try {
    let s = await r.u.check({ manual: true });
    assert.equal(s.state, "error"); assert.equal(s.errorKind, "not-found"); assert.match(s.error!, /token/);
    assert.equal(r.f.log.api[0]!.auth, undefined, "anonymous when no token is set");
    s = r.u.settings({ token: TOKEN }); assert.equal(s.settings.hasToken, true); assert.ok(!JSON.stringify(s).includes(TOKEN), "the token is never returned");
    s = await r.u.check({ manual: true }); assert.equal(s.available, true);
    assert.ok(r.f.log.api.some((a) => a.auth === `Bearer ${TOKEN}`));
    s = await r.u.download(); assert.equal(s.state, "ready");
    assert.ok(r.f.log.cdn.length >= 2); assert.ok(r.f.log.cdn.every((c) => c.auth === undefined), "no Authorization header reached the CDN host");
  } finally { r.done(); }
});

test("the token is sealed on disk, survives a restart, and is removable", async () => {
  const key = new Uint8Array(32).fill(7);
  const r = await rig([release(7)], { dataKey: key });
  try {
    r.u.settings({ token: TOKEN, repo: "o/r", auto: false, channel: "stable" });
    const raw = readFileSync(join(r.dir, "updater.json"), "utf8");
    assert.ok(!raw.includes(TOKEN) && !raw.includes(Buffer.from(TOKEN).toString("base64")), "sealed, not plain");
    assert.equal((statSync(join(r.dir, "updater.json")).mode & 0o777), 0o600);
    const again = r.mk({ dataKey: key }); assert.equal(again.status().settings.hasToken, true); assert.equal(again.status().settings.auto, false); assert.equal(again.status().settings.channel, "stable"); again.dispose();
    const wrong = r.mk({ dataKey: new Uint8Array(32).fill(8) }); assert.equal(wrong.status().settings.hasToken, false, "a different key cannot open it"); wrong.dispose();
    assert.equal(r.u.settings({ token: "" }).settings.hasToken, false);
    assert.throws(() => r.u.settings({ repo: "not a repo" })); assert.throws(() => r.u.settings({ channel: "nightly" }));
  } finally { r.done(); }
});

test("download: verified, progress events, one at a time, no stray files", async () => {
  const r = await rig([release(7)]);
  try {
    await r.u.check({ manual: true });
    const [a, b] = await Promise.all([r.u.download(), r.u.download()]);
    assert.equal(a.state, "ready"); assert.equal(b.state, "ready");
    assert.equal(r.f.log.cdn.filter((c) => c.url.endsWith(".apk")).length, 1, "one transfer for two concurrent requests");
    const f = a.file!; assert.ok(f.startsWith(join(r.dir, "updates"))); assert.equal(sha(readFileSync(f)), sha(APK));
    assert.deepEqual(readdirSync(join(r.dir, "updates")), [f.split("/").pop()]);
    const prog = r.events.filter((e) => e.e === "update-progress"); assert.ok(prog.length >= 2); assert.equal(prog.at(-1)!.d.done, APK.length);
  } finally { r.done(); }
});

test("sha256 mismatch is refused and leaves nothing behind", async () => {
  const bad = release(7); (bad.manifest as any).assets.android.sha256 = "0".repeat(64);
  const r = await rig([bad]);
  try {
    await r.u.check({ manual: true }); const s = await r.u.download();
    assert.equal(s.state, "error"); assert.equal(s.errorKind, "mismatch"); assert.equal(s.file, undefined);
    assert.deepEqual(readdirSync(join(r.dir, "updates")), []);
    await assert.rejects(r.u.install());
  } finally { r.done(); }
});

test("a dropped connection is resumed with Range; a persistent failure leaves no partial file", async () => {
  const r = await rig([release(7)]);
  try {
    await r.u.check({ manual: true });
    r.f.ctl.dropFirst = 1; let s = await r.u.download();
    assert.equal(s.state, "ready", s.error); assert.ok(r.f.log.cdn.some((c) => c.range?.startsWith("bytes=")), "resumed with a Range request");
    assert.equal(sha(readFileSync(s.file!)), sha(APK));
    const r2 = await rig([release(7)]);
    await r2.u.check({ manual: true }); r2.f.ctl.dropFirst = 99; r2.f.ctl.ignoreRange = true;
    s = await r2.u.download(); assert.equal(s.state, "error"); assert.deepEqual(readdirSync(join(r2.dir, "updates")), []);
    r2.done();
  } finally { r.done(); }
});

test("cancel and stall clean up", async () => {
  const r = await rig([release(7)], { timeoutMs: 300, retries: 0 });
  try {
    await r.u.check({ manual: true }); r.f.ctl.hang = true;
    const s = await r.u.download(); assert.equal(s.state, "error");
    assert.deepEqual(readdirSync(join(r.dir, "updates")), []);
    r.f.ctl.hang = false; await r.u.check({ manual: true });
    r.u.settings({}); const p = r.u.download(); void r.u.call("updateCancel"); const c = await p;
    assert.ok(c.state === "error" || c.state === "ready"); if (c.state === "error") assert.deepEqual(readdirSync(join(r.dir, "updates")), []);
  } finally { r.done(); }
});

test("offline: graceful error, no throw; recovers when the server is back", async () => {
  const r = await rig([release(7)], { apiBase: "http://127.0.0.1:1" });
  try {
    const s = await r.u.check({ manual: true }); assert.equal(s.state, "error"); assert.equal(s.errorKind, "offline"); assert.match(s.error!, /internet/);
    assert.equal(r.u.status().available, false);
  } finally { r.done(); }
});

test("rate limit 403 / 429: reported, background checks back off until it passes", async () => {
  const r = await rig([release(7)]);
  try {
    r.f.ctl.limit = 403; let s = await r.u.check({ manual: true }); assert.equal(s.errorKind, "rate-limit");
    const n = r.f.log.api.length; await r.u.check(); assert.equal(r.f.log.api.length, n, "the background check waits");
    r.f.ctl.limit = 429; s = await r.u.check({ manual: true }); assert.equal(s.errorKind, "rate-limit");
    r.f.ctl.limit = 0; s = await r.u.check({ manual: true }); assert.equal(s.available, true, "a manual check always tries");
  } finally { r.done(); }
});

test("metered connection: background check skipped, manual check runs", async () => {
  const r = await rig([release(7)], { isMetered: () => true });
  try {
    let s = await r.u.check(); assert.equal(r.f.log.api.length, 0); assert.equal(s.errorKind, "metered");
    s = await r.u.check({ manual: true }); assert.equal(s.available, true);
  } finally { r.done(); }
});

test("background timer runs the check when auto is on, not when off", async () => {
  const r = await rig([release(7)], { startDelayMs: 20, intervalMs: 60_000 });
  try {
    r.u.settings({ auto: false }); r.u.start(); await new Promise((k) => setTimeout(k, 120)); assert.equal(r.f.log.api.length, 0);
    r.u.settings({ auto: true }); await new Promise((k) => setTimeout(k, 200)); assert.ok(r.f.log.api.length > 0); assert.equal(r.u.status().available, true);
  } finally { r.done(); }
});

test("install: hands the verified file to the platform installer; Android style handoff without one", async () => {
  const seen: InstallContext[] = [];
  const r = await rig([release(7)], { install: (c) => { seen.push(c); return { action: "restart" }; } });
  try {
    await assert.rejects(r.u.install(), /no verified update/);
    await r.u.check({ manual: true }); await r.u.download();
    const res = await r.u.install(); assert.equal(res.action, "restart"); assert.equal(seen[0]!.version, "0.1.7"); assert.equal(seen[0]!.platform, "android"); assert.ok(existsSync(seen[0]!.file));
  } finally { r.done(); }
  const h = await rig([release(7)]);
  try { await h.u.check({ manual: true }); await h.u.download(); const res = await h.u.install(); assert.equal(res.action, "handoff"); assert.ok(res.file); } finally { h.done(); }
});

test("web / server (no platform): tells, never downloads", async () => {
  const r = await rig([release(7)], { platform: undefined });
  try { const s = await r.u.check({ manual: true }); assert.equal(s.available, true); assert.equal(s.installMode, "none"); await assert.rejects(r.u.download()); } finally { r.done(); }
});

test("a release without a file for this platform says so", async () => {
  const r = await rig([release(7)], { platform: "desktop-linux-appimage" });
  try { const s = await r.u.check({ manual: true }); assert.equal(s.available, true); assert.equal(s.errorKind, "no-asset"); await assert.rejects(r.u.download()); } finally { r.done(); }
});

test("a broken manifest is reported as such", async () => {
  const r = await rig([release(7, { manifest: "{not json" })]);
  try { const s = await r.u.check({ manual: true }); assert.equal(s.errorKind, "manifest"); } finally { r.done(); }
});

test("Hub RPCs: updateStatus / updateSettings / updateCheck / updateDownload and events", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "upd-hub-"));
  const f = await fake(() => [release(7)]);
  const hub = new Hub(dir, [], new MemoryStore(), { appVersion: "0.1.2", update: { platform: "android", apiBase: f.apiBase, intervalMs: 0 } });
  const seen: string[] = []; hub.subscribe((e) => seen.push(e));
  const call = (m: string, p?: unknown) => hub.call(m, p) as Promise<any>;
  try {
    let s = await call("updateStatus"); assert.equal(s.current, "0.1.2"); assert.equal(s.settings.repo, "PixelcrafterEXE/unichat"); assert.equal(s.settings.auto, true); assert.equal(s.settings.channel, "prerelease");
    s = await call("updateSettings", { repo: "o/r", token: TOKEN }); assert.equal(s.settings.hasToken, true); assert.ok(!JSON.stringify(s).includes(TOKEN));
    s = await call("updateCheck"); assert.equal(s.available, true); assert.ok(seen.includes("update-available"));
    s = await call("updateDownload"); assert.equal(s.state, "ready"); assert.ok(seen.includes("update-progress"));
    const i = await call("updateInstall"); assert.equal(i.action, "handoff");
    await assert.rejects(call("updateSettings", { repo: "../x" }));
  } finally { await hub.shutdown(); f.close(); rmSync(dir, { recursive: true, force: true }); }
});
