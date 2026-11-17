#!/usr/bin/env node
// End-to-end check of the Android bridge protocol under plain Node, using a throwaway data dir (never ~/.config/unimsg,
// no TCP port, no network, no accounts). It plays the part of the Android native side and the WebView:
//   UI transport   the REAL apps/ui/src/api.ts (esbuild-bundled), constructed with only window.UnimsgNative present
//   WebView shim   the REAL android/app/src/main/assets/unimsg/shim.js
//   Java NodeBridge  re-implemented here (~20 lines): pipes shim <-> NDJSON Unix socket, as NodeBridge.java does
//   Backend        the REAL bundle nodejs-project/main.js, run in a child process with the sql.js engine (what nodejs-mobile
//                  falls back to) and again with the engine auto-selected.
// usage: node scripts/smoke-test.mjs [path/to/main.js]
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const main = resolve(process.argv[2] ?? join(root, "build/nodejs-project/main.js"));
const work = mkdtempSync(join(tmpdir(), "unimsg-android-smoke-"));
const results = [];
const ok = (name) => { results.push(name); console.log("  ok  " + name); };

// ---- the real UI transport ------------------------------------------------------------------------------------------
const apiOut = join(work, "ui-api.mjs");
await build({ entryPoints: [resolve(root, "../ui/src/api.ts")], outfile: apiOut, bundle: true, format: "esm", platform: "neutral",
  mainFields: ["module", "main"], define: { "import.meta.env": "{}" }, logLevel: "silent", loader: { ".svg": "dataurl", ".png": "dataurl" } });
const shimSrc = readFileSync(join(root, "android/app/src/main/assets/unimsg/shim.js"), "utf8");

// ---- fake native side (what NodeBridge.java does) -------------------------------------------------------------------
function connectNative(sockPath, window) {
  return new Promise((res, rej) => {
    const sock = net.connect(sockPath); sock.setEncoding("utf8");
    const state = { sock, ready: undefined, notifications: [], states: [], frames: 0 };
    let buf = "";
    const host = { onmessage: null, postMessage(line) { if (line.startsWith('{"id"')) sock.write(line + "\n"); } }; // like Java: {"hello":1} is not forwarded
    window.__UnimsgHost = host;
    sock.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); state.frames++;
        const f = JSON.parse(line);
        if (f.ctl === "ready") { state.ready = f; res(state); }
        else if (f.ctl === "notify") state.notifications.push(f);
        else if (f.ctl === "state") state.states.push(f);
        else if (f.id !== undefined && f.id < 0) state.control?.(f);
        else host.onmessage?.({ data: line });
      }
    });
    sock.on("error", rej);
    state.control$ = (method, params = {}) => new Promise((ok2) => { const id = -(++state.cid || (state.cid = 1)); state.control = (f) => f.id === id && ok2(f); sock.write(JSON.stringify({ id, method, params }) + "\n"); });
  });
}

async function runBackend(label, env) {
  const dataDir = join(work, label, "data"), sockPath = join(work, label, "bridge.sock");
  const key = env.key ?? randomBytes(32).toString("hex");
  const child = spawn(process.env.SMOKE_NODE || process.execPath, [main], { stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: join(work, label, "home"), UNIMSG_DATA: dataDir, UNIMSG_SOCKET: sockPath, UNIMSG_DB_KEY: key, UNIMSG_SQLITE: env.sqlite ?? "auto", UNIMSG_SQLJS_FLUSH_MS: "100" } });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const exited = new Promise((r) => child.on("exit", (code, sig) => r({ code, sig })));
  const t0 = Date.now();
  while (!existsSync(sockPath)) { if (Date.now() - t0 > 30_000) throw new Error("backend did not open its socket:\n" + log); await new Promise((r) => setTimeout(r, 50)); }
  const window = { dispatchEvent() {}, location: { search: "", href: "https://localhost/", hostname: "localhost" } };
  const native = await connectNative(sockPath, window);
  // the WebView side: shim first (document start), then the UI's api.ts
  new Function("window", shimSrc)(window);
  Object.assign(globalThis, { window, location: window.location });
  const { Core } = await import(pathToFileURL(apiOut).href + "?" + label + Math.random());
  const core = new Core();
  return { child, exited, native, core, dataDir, sockPath, key, log: () => log, window };
}

async function stop(b) {
  const r = await b.native.control$("$shutdown");
  assert.equal(r.result, null === undefined ? 0 : r.result); // {} result
  const { code } = await b.exited; assert.equal(code, 0, "backend exits 0 on $shutdown\n" + b.log());
  assert.ok(!existsSync(b.sockPath), "socket file removed on shutdown");
}

// nodejs-mobile has no ICU: regex Unicode property escapes in the bundle would be a SyntaxError on the device (found on the emulator)
assert.ok(!/(^|[^\\])\\[pP]\{[A-Za-z_=]+\}/m.test(readFileSync(main, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")), "bundle contains \\p{..} regex escapes");
ok("bundle has no \\p{..} regex property escapes (nodejs-mobile has no ICU)");

// ---- 1. protocol + UI transport against the sql.js engine ------------------------------------------------------------
console.log("bundle:", main);
let b = await runBackend("sqljs", { sqlite: "sqljs" });
try {
  assert.equal(b.native.ready.protocol, 1); assert.equal(b.native.ready.sqlite, "sqljs"); ok("ready handshake (protocol 1, engine sqljs, node " + b.native.ready.node + ")");
  assert.equal(typeof window.UnimsgNative.call, "function"); assert.equal(window.UnimsgNative.platform, "android"); ok("shim defines window.UnimsgNative");

  const ping = await b.native.control$("$ping"); assert.equal(ping.result.pong, true); ok("$ping control call");

  const providers = await b.core.call("providers");
  const names = providers.map((p) => p.name);
  for (const n of ["matrix", "mattermost", "discord", "signal", "whatsapp"]) /* instagram is switched off in packages/host (issue #44) */ assert.ok(names.includes(n), "provider " + n + " listed, got " + names);
  ok("UI Core.call('providers') over the Android transport -> " + names.join(", "));

  { const t = Date.now(); while (!b.native.states.length && Date.now() - t < 5000) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(b.native.states[0], { ctl: "state", accounts: 0, sync: false }); ok("backend reports the account count ({ctl:state}) after ready"); }
  assert.deepEqual((await b.native.control$("$config", { keepAlive: true, notifyContent: "sender" })).result, {}); ok("$config accepts keepAlive + notifyContent");
  // metered / battery saver / low battery pause the avatar warm-up (setAvatarWarmPaused): the Hub must accept every combination the host can report
  for (const p of [{ saver: true, low: false }, { saver: false, low: true }, {}]) {
    const r = await b.native.control$("$power", p); assert.deepEqual(r.result, {}, "$power " + JSON.stringify(p) + ": " + JSON.stringify(r)); }
  const nm = await b.native.control$("$network", { interfaces: [], metered: true });
  assert.ok(!nm.error, "$network with metered: " + JSON.stringify(nm));
  assert.deepEqual((await b.native.control$("$power", { saver: false, low: false })).result, {});
  ok("$power and $network {metered} accepted (avatar warm-up pause)");
  for (const [m, p] of [["$reply", { chatId: "x" }], ["$reply", { chatId: "x", text: "  " }], ["$markRead", { chatId: "x" }]]) {
    const r = await b.native.control$(m, p); assert.equal(typeof r.error, "string", m + " validates its params"); }
  const rr = await b.native.control$("$reply", { chatId: "nope:1", text: "hi" }); assert.ok(rr.error, "reply to an unknown chat is an error, not a crash");
  const mr = await b.native.control$("$markRead", { chatId: "nope:1", messageId: "m" }); assert.ok(mr.error);
  ok("$reply / $markRead: param validation and Hub errors propagate");

  const snap = await b.core.call("snapshot");
  assert.ok(Array.isArray(snap.chats) && Array.isArray(snap.spaces) && Array.isArray(snap.accounts)); assert.equal(snap.accounts.length, 0); ok("snapshot of an empty hub");

  await assert.rejects(b.core.call("definitelyNotAMethod"), (e) => e instanceof Error && e.message.length > 0); ok("unknown method rejects with the backend's error message");

  const events = []; const off = b.core.on((ev, data) => events.push([ev, data]));
  const folder = await b.core.call("createFolder", { name: "Smoke Folder ÄÖ 🙂" });
  assert.ok(String(folder.id).startsWith("folder:"));
  const t1 = Date.now(); while (!events.some(([e]) => e === "spaces-changed" || e === "chats-changed") && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 20));
  assert.ok(events.some(([e]) => e === "spaces-changed" || e === "chats-changed"), "event reached the UI listener: " + JSON.stringify(events)); off(); ok("hub events reach Core.on() listeners (" + events.map((e) => e[0]).join(",") + ")");

  // foreground toggle + big payload round trip (frame handling)
  await b.native.control$("$foreground", { value: false });
  const big = "x".repeat(3_000_000);
  const echo = await b.core.call("setAlias", { chatId: "smoke:chat", name: big }).then(() => b.core.call("snapshot"));
  assert.ok(echo); ok("3 MB request frame accepted");

  await new Promise((r) => setTimeout(r, 400)); // let the sql.js debounce flush
  const dbFile = join(b.dataDir, "unimsg.db"); assert.ok(existsSync(dbFile), "database file written");
  const raw = readFileSync(dbFile); assert.ok(!raw.includes(Buffer.from("Smoke Folder")), "folder name is not plaintext in the database file"); ok("sql.js database persisted and payload is encrypted at rest");
  assert.ok(!existsSync(join(process.env.HOME ?? "", ".config/unimsg/__never__")));
  await stop(b); ok("$shutdown exits 0 and removes the socket");

  // restart on the same data + key: the folder must still be there (persistence across process restarts = app restarts)
  b = await runBackend("sqljs", { sqlite: "sqljs", key: b.key });
  const folders = await b.core.call("snapshot");
  assert.ok(folders.spaces.some((s) => s.id === folder.id && s.name === "Smoke Folder ÄÖ 🙂"), "folder survived restart: " + JSON.stringify(folders.spaces)); ok("data survives a backend restart (same key)");
  await stop(b);

  // a wrong key must make the backend refuse to start (never read, never overwrite the archive)
  const bad = spawn(process.env.SMOKE_NODE || process.execPath, [main], { stdio: "ignore", env: { PATH: process.env.PATH, HOME: join(work, "sqljs", "home"), UNIMSG_DATA: join(work, "sqljs", "data"), UNIMSG_SOCKET: join(work, "sqljs", "bad.sock"), UNIMSG_DB_KEY: randomBytes(32).toString("hex"), UNIMSG_SQLITE: "sqljs" } });
  const code = await Promise.race([new Promise((r) => bad.on("exit", r)), new Promise((r) => setTimeout(() => r("timeout"), 20000))]);
  if (code === "timeout") bad.kill();
  assert.ok(code !== 0 && code !== "timeout", "backend with the wrong key exits non-zero, got " + code); ok("a different data key cannot open the archive (backend refuses to start)");
} catch (e) { console.error(b?.log?.()); b?.child.kill(); throw e; }

// ---- 2. same flow on the auto-selected engine (real node:sqlite on this machine) ---------------------------------------
{
  const b2 = await runBackend("auto", {});
  try {
    const p = await b2.core.call("providers"); assert.ok(p.length >= 5);
    ok("engine '" + b2.native.ready.sqlite + "' (auto) also serves providers");
    await stop(b2);
  } catch (e) { console.error(b2.log()); b2.child.kill(); throw e; }
}

// ---- 3. notification logic ------------------------------------------------------------------------------------------------
{
  const out = join(work, "notify.mjs");
  await build({ entryPoints: [join(root, "src/notify.ts")], outfile: out, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  const { buildNotification, summarize } = await import(pathToFileURL(out).href);
  const snap = { spaces: [{ id: "s1", muted: true }], chats: [{ id: "a:1", name: "Alice", kind: "dm" }, { id: "a:2", name: "Family", kind: "group" }, { id: "a:3", name: "Muted", kind: "dm", muted: true }, { id: "a:4", name: "InMutedSpace", kind: "group", spaceId: "s1" }] };
  assert.deepEqual(buildNotification({ id: "m", chatId: "a:1", sender: "Alice", text: "hi" }, snap, "full"), { chatId: "a:1", messageId: "m", title: "Alice", body: "hi" });
  assert.equal(buildNotification({ id: "m", chatId: "a:2", sender: "Bob", text: "yo" }, snap, "full").body, "Bob: yo");
  assert.equal(buildNotification({ id: "m", chatId: "a:3", sender: "X", text: "z" }, snap, "full"), undefined);
  assert.equal(buildNotification({ id: "m", chatId: "a:4", sender: "X", text: "z" }, snap, "full"), undefined);
  assert.equal(buildNotification({ id: "m", chatId: "a:1", fromMe: true, text: "z" }, snap, "full"), undefined);
  assert.equal(buildNotification({ id: "m", chatId: "a:1", historical: true, text: "z" }, snap, "full"), undefined);
  assert.deepEqual(buildNotification({ id: "m", chatId: "a:1", sender: "Alice", text: "secret" }, snap, "hidden"), { chatId: "a:1", messageId: "m", title: "UniChat", body: "New message" });
  assert.equal(summarize({ attachments: [{ kind: "voice" }] }), "Voice message");
  ok("notification rules (muted chat/space, own, historical, privacy modes)");
}

rmSync(work, { recursive: true, force: true });
console.log(`\nSMOKE TEST PASSED (${results.length} checks)`);
