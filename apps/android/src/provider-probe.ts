// On-device provider probe (NOT part of the shipped backend): bundled by `node scripts/build-backend-bundle.mjs --probe`
// into build/nodejs-probe/main.js and run inside nodejs-mobile (emulator) instead of the real backend, see README "Provider probe".
// For every provider: load the module, create() a connector and start() it against in-process FAKE servers on 127.0.0.1 (the fake
// servers of the packages' own offline tests) or fully offline. Non-loopback DNS/fetch is refused below, so nothing can reach a
// real service. Results: one `PROBE <name> PASS|FAIL <ms> <detail>` line each on stdout (logcat) and <dir>/probe-results.json.
import "./probe-env.ts";
import dns from "node:dns";
import net from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// ---- hard guard: only loopback ----------------------------------------------------------------------------------------
const loop = (h: unknown) => typeof h === "string" && (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0");
const blocked: string[] = [];
const origLookup = dns.lookup as any;
(dns as any).lookup = function (host: string, ...rest: any[]) {
  if (!loop(host)) { blocked.push(host); const cb = rest[rest.length - 1]; const err = Object.assign(new Error("probe: non-loopback lookup refused: " + host), { code: "ENOTFOUND" }); if (typeof cb === "function") return void process.nextTick(cb, err); throw err; }
  return origLookup.call(dns, host, ...rest);
};
const origFetch = globalThis.fetch;
globalThis.fetch = ((u: any, ...r: any[]) => { const h = new URL(typeof u === "string" ? u : u.url ?? String(u)).hostname; if (!loop(h)) { blocked.push(h); return Promise.reject(new Error("probe: non-loopback fetch refused: " + h)); } return (origFetch as any)(u, ...r); }) as typeof fetch;
void net;

type Res = { name: string; ok: boolean; ms: number; detail: string };
const results: Res[] = [];
const dataRoot = process.env.UNIMSG_DATA || tmpdir();
mkdirSync(dataRoot, { recursive: true });
async function probe(name: string, fn: () => Promise<string>, timeoutMs = 60_000) {
  const t = Date.now();
  let r: Res;
  try {
    const detail = await Promise.race([fn(), new Promise<string>((_, ko) => setTimeout(() => ko(new Error("timeout " + timeoutMs + " ms")), timeoutMs))]);
    r = { name, ok: true, ms: Date.now() - t, detail };
  } catch (e) { r = { name, ok: false, ms: Date.now() - t, detail: ((e as Error)?.stack ?? String(e)).split("\n").slice(0, 4).join(" | ") }; }
  results.push(r);
  console.log(`PROBE ${r.name} ${r.ok ? "PASS" : "FAIL"} ${r.ms}ms ${r.detail}`);
}
const ok = (c: boolean, m: string) => { if (!c) throw new Error(m); };
const tmp = (p: string) => mkdtempSync(join(dataRoot, p + "-"));

console.log(`PROBE-START node=${process.version} platform=${process.platform} arch=${process.arch} icu=${(process.versions as any).icu ?? "none"}`);

// ---- generic: create() + start() with no session (offline): must reach a login prompt / needs-login without throwing ----
async function offlineStart(name: string, factory: any) {
  await probe(`${name}:create+start(no session, offline)`, async () => {
    const ev: any[] = [];
    const c = factory.create({ accountId: "probe", dataDir: tmp(name) });
    await c.start((e: any) => ev.push(e));
    await new Promise((r) => setTimeout(r, 400));
    const login = ev.some((e) => e.type === "login"), nl = ev.some((e) => e.type === "account" && e.data.state === "needs-login");
    const errs = ev.filter((e) => e.type === "error").map((e) => e.data?.message ?? e.data?.code);
    await c.stop();
    ok(login || nl, `no login prompt/needs-login (events: ${ev.map((e) => e.type + ":" + (e.data?.state ?? "")).join(",")}; errors: ${errs.join(";")})`);
    return `login=${login} needs-login=${nl} caps=${Object.keys(c.capabilities ?? factory.capabilities ?? {}).length}`;
  });
}

// ---- providers that have an in-process fake server: full session against the fake ------------------------------------
await probe("mattermost:load", async () => { const f = (await import("../../../packages/provider-mattermost/src/index.ts")).default; ok(typeof f.create === "function", "no create"); return `name=${f.name}`; });
await probe("mattermost:fake-login+connected", async () => {
  const f = (await import("../../../packages/provider-mattermost/src/index.ts")).default; const h = await import("../../../packages/provider-mattermost/src/helpers.ts");
  const s = await h.setup(f); try { await h.waitFor(s.connected, 8000, "connected"); const chats = await s.conn.chats(); return `connected, chats=${chats.length}, ws+http via fake`; } finally { await s.close(); }
});
await offlineStart("mattermost", (await import("../../../packages/provider-mattermost/src/index.ts")).default);

await probe("discord:load", async () => { const f = (await import("../../../packages/provider-discord/src/index.ts")).default; ok(typeof f.create === "function", "no create"); return `name=${f.name}`; });
for (const mode of ["bot", "user"] as const) await probe(`discord:fake-gateway(${mode})+connected`, async () => {
  const f = (await import("../../../packages/provider-discord/src/index.ts")).default; const h = await import("../../../packages/provider-discord/src/helpers.ts");
  const s = await h.setup(f, { mode }); try { await s.loaded(); const chats = await s.conn.chats(); return `connected+loaded, chats=${chats.length}`; } finally { await s.close(); }
});
await offlineStart("discord", (await import("../../../packages/provider-discord/src/index.ts")).default);

await probe("instagram:load", async () => { const f = (await import("../../../packages/provider-instagram/src/index.ts")).default; ok(typeof f.create === "function", "no create"); return `name=${f.name}`; });
await probe("instagram:fake-session+connected (REST + MQTT/ws)", async () => {
  const f = (await import("../../../packages/provider-instagram/src/index.ts")).default; const h = await import("../../../packages/provider-instagram/src/helpers.ts");
  const s = await h.setup(f); try { await h.waitFor(s.connected, 8000, "connected"); const chats = await s.conn.chats(); return `connected, chats=${chats.length}`; } finally { await s.close(); }
});
await offlineStart("instagram", (await import("../../../packages/provider-instagram/src/index.ts")).default);

await probe("teams:load", async () => { const f = (await import("../../../packages/provider-teams/src/index.ts")).default; ok(typeof f.create === "function", "no create"); return `name=${f.name}`; });
await probe("teams:fake-session+connected", async () => {
  const f = (await import("../../../packages/provider-teams/src/index.ts")).default; const h = await import("../../../packages/provider-teams/src/helpers.ts");
  const s = await h.setup(f); try { await h.waitFor(s.connected, 8000, "connected"); const chats = await s.conn.chats(); return `connected, chats=${chats.length}`; } finally { await s.close(); }
});

await probe("threema(gateway, deprecated):load", async () => { const f = (await import("../../../packages/provider-threema/src/index.ts")).default; ok(typeof f.create === "function", "no create"); return `name=${f.name}`; });
await probe("threema(gateway):fake-session+connected (HTTP callback listener, NaCl)", async () => {
  const f = (await import("../../../packages/provider-threema/src/index.ts")).default; const h = await import("../../../packages/provider-threema/src/helpers.ts");
  const s = await h.setup(f); try { await h.waitFor(s.connected, 8000, "connected"); return `connected, callback port ${s.port}`; } finally { await s.close(); }
});

await probe("threema-md:load", async () => { const f = (await import("../../../packages/provider-threema-md/src/index.ts")).default; ok(typeof f.create === "function", "no create"); return `name=${f.name}`; });
await probe("threema-md:full link flow vs fake phone/mediator (QR, CSP, blake2b, NaCl)", async () => {
  const f = (await import("../../../packages/provider-threema-md/src/index.ts")).default; const h = await import("../../../packages/provider-threema-md/src/helpers.ts");
  const w = await h.world(); try { const l = await h.linked(f, w); try { return `linked + connected (${l.stateOf()})`; } finally { await l.stop(); } } finally { await w.close(); }
}, 90_000);
await offlineStart("threema-md", (await import("../../../packages/provider-threema-md/src/index.ts")).default);

// ---- matrix: provider offline start + the Rust-crypto WASM on fake-indexeddb (the part that can fail on Android) ----------
await offlineStart("matrix", (await import("../../../packages/provider-matrix/src/index.ts")).default);
await probe("matrix:load", async () => { const f = (await import("../../../packages/provider-matrix/src/index.ts")).default; ok(typeof f.create === "function", "no create"); return `name=${f.name}`; });
await probe("matrix:rust-crypto WASM init on fake-indexeddb + key generation + persist/restore", async () => {
  const { createClient } = await import("matrix-js-sdk");
  const idbm = await import("../../../packages/provider-matrix/src/idb-persist.ts");
  const idb = await idbm.installFakeIndexedDB();
  const prefix = "probe-" + randomBytes(3).toString("hex"), file = join(tmp("matrix-crypto"), "matrix-crypto.bin");
  const persister = new idbm.IdbPersister(idb, prefix, file, (e: unknown) => { throw e; });
  await persister.restore();
  const client = createClient({ baseUrl: "http://127.0.0.1:9", userId: "@probe:example.invalid", deviceId: "PROBEDEV", accessToken: "none" });
  await client.initRustCrypto({ cryptoDatabasePrefix: prefix, storageKey: randomBytes(32) });
  const crypto = client.getCrypto()!; const keys = await crypto.getOwnDeviceKeys();
  ok(!!keys.ed25519 && !!keys.curve25519, "no device keys");
  persister.start(); await persister.flush();
  client.stopClient();
  const { statSync } = await import("node:fs"); ok(statSync(file).size > 1000, "crypto store snapshot not written");
  return `rust-crypto ready, ed25519=${keys.ed25519.slice(0, 6)}.., snapshot ${statSync(file).size} bytes`;
}, 90_000);

// ---- whatsapp / Baileys: never start() (would dial web.whatsapp.com). Load + offline crypto + local-socket construction ----
await probe("whatsapp:load+create", async () => { const f = (await import("../../../packages/provider-whatsapp/src/index.ts")).default; const c = f.create({ accountId: "probe", dataDir: tmp("wa") }); ok(typeof c.start === "function", "no start"); return `name=${f.name}`; });
await probe("whatsapp:Baileys sockets+crypto offline (keys, noise handshake object, makeWASocket on a closed loopback port)", async () => {
  const b: any = await import("@whiskeysockets/baileys");
  const initAuthCreds = b.initAuthCreds ?? b.default?.initAuthCreds; const creds = initAuthCreds();
  ok(!!creds.noiseKey?.public && !!creds.signedIdentityKey?.public, "no creds");
  const make = b.default?.default ?? b.default ?? b.makeWASocket;
  const state: any = { creds, keys: { get: async () => ({}), set: async () => {} } };
  const pino = { level: "silent", trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return pino; } };
  const sock = make({ auth: state, waWebSocketUrl: "ws://127.0.0.1:9/", logger: pino, printQRInTerminal: false, connectTimeoutMs: 1500, version: [2, 3000, 0] });
  ok(typeof sock.sendMessage === "function", "no socket api");
  await new Promise((r) => setTimeout(r, 800)); try { sock.end(undefined); } catch { /* ignore */ }
  return `makeWASocket constructed; registrationId=${creds.registrationId}`;
});

// ---- the real Hub-less storage dependency used by every provider: node:crypto features Baileys/Signal rely on ---------------
await probe("platform:crypto (x25519/ed25519/aes-gcm/hkdf/webcrypto global)", async () => {
  const c = await import("node:crypto");
  const a = c.generateKeyPairSync("x25519"), b = c.generateKeyPairSync("x25519");
  const s1 = c.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey }), s2 = c.diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey });
  ok(s1.equals(s2), "x25519 mismatch");
  const k = Buffer.from(c.hkdfSync("sha256", s1, Buffer.alloc(0), "probe", 32));
  const iv = randomBytes(12), ci = c.createCipheriv("aes-256-gcm", k, iv); const ct = Buffer.concat([ci.update("hello"), ci.final()]); const tag = ci.getAuthTag();
  const de = c.createDecipheriv("aes-256-gcm", k, iv); de.setAuthTag(tag); ok(Buffer.concat([de.update(ct), de.final()]).toString() === "hello", "gcm");
  const sig = c.sign(null, Buffer.from("m"), c.generateKeyPairSync("ed25519").privateKey); ok(sig.length === 64, "ed25519");
  ok(!!globalThis.crypto?.subtle, "no webcrypto");
  return "ok";
});

console.log(`PROBE-BLOCKED non-loopback hosts refused: ${[...new Set(blocked)].join(",") || "none"}`);
const pass = results.filter((r) => r.ok).length;
console.log(`PROBE-DONE ${pass}/${results.length} passed`);
writeFileSync(join(dataRoot, "probe-results.json"), JSON.stringify({ node: process.version, arch: process.arch, blocked: [...new Set(blocked)], results }, null, 1));
setInterval(() => {}, 1 << 30); // keep the process alive; exit() inside nodejs-mobile crashes the app process
