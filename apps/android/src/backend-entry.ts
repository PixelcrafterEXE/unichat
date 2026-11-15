// Entry point of the Android backend bundle (-> nodejs-project/main.js), started inside the app by nodejs-mobile
// (or under plain Node by scripts/build-backend-bundle.mjs --smoke).
// It runs the same startBackend() as apps/server and apps/desktop and bridges the Hub to the native side over a
// Unix socket using the protocol in bridge-protocol.ts.
//   env  UNIMSG_DATA    data directory (Android: <filesDir>/unimsg-data)
//        UNIMSG_SOCKET  Unix socket path to listen on
//        UNIMSG_DB_KEY  32-byte archive key, hex; supplied by the Java side from the Android Keystore (replaces the
//                       KeyWrap hook, which is synchronous and so cannot call back into Java)
//        UNIMSG_SQLITE  auto|node|better|sqljs (see sqlite-shim.ts)
//   argv  [2]=data dir, [3]=socket path override the env (nodejs-mobile passes arguments, not env, on some builds)
import net from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { initPerfLog, plog, timed, startLagMonitor, maybeProfile } from "./perflog.js";
import "./libsignal-modules.js";
import { startBackend, backendReady } from "@unimsg/host";
import { prepareSqlite, flushSqlite } from "./sqlite-shim.js";
import { LineReader, encode, PROTOCOL_VERSION, type Frame, type NotifyContent, type Request } from "./bridge-protocol.js";
import { buildNotification, cachedSnapshot, type Snapshot } from "./notify.js";

declare const __UNICHAT_VERSION__: string; // esbuild define (scripts/build-backend-bundle.mjs)
const dataDir: string = process.argv[2] || process.env.UNIMSG_DATA || "";
const sockPath: string = process.argv[3] || process.env.UNIMSG_SOCKET || "";
if (!dataDir || !sockPath) { console.error("[unimsg] UNIMSG_DATA and UNIMSG_SOCKET are required"); process.exit(2); }

// A bug in one account/provider must not take the backend down (stack only: no message content).
process.on("uncaughtException", (e) => console.error("[unimsg] uncaught exception:", (e as Error)?.stack ?? e));
process.on("unhandledRejection", (e) => console.error("[unimsg] unhandled rejection:", (e as Error)?.stack ?? e));

// Start-up failures (wrong/lost data key, unreadable database) must END the process with a non-zero code: the global
// handlers above would otherwise swallow them and leave a backend that is neither running nor reporting an error.
initPerfLog(dataDir); startLagMonitor(); await maybeProfile(dataDir);
let hub: Awaited<ReturnType<typeof startBackend>>, engine: string;
try {
  engine = (await timed("prepareSqlite", () => prepareSqlite())).engine;
  hub = await timed("startBackend", () => startBackend(dataDir, { appVersion: __UNICHAT_VERSION__, update: { platform: "android" }, deferInit: true })); // deferInit: the socket opens (and $ping answers) while accounts/sync start in the background; hub calls wait for `up` below. updates: the Hub downloads + verifies the APK, the UI hands it to the system installer ($installApk)
} catch (e) { console.error("[unimsg] backend failed to start:", (e as Error)?.message ?? e); process.exit(3); }

let initDone = false;
const up = backendReady(hub).then(() => { initDone = true; plog("backend-ready"); });
up.catch((e) => { console.error("[unimsg] backend failed to start:", (e as Error)?.message ?? e); process.exit(3); });
let client: net.Socket | undefined;
let uiForeground = true, notifyContent: NotifyContent = "full", keepAlive = false, lastAccounts = -1, lastSync = false;
const send = (f: Frame) => { if (client && !client.destroyed) client.write(encode(f)); };
const snapshot = cachedSnapshot(() => hub.call("snapshot", {}) as Promise<Snapshot>);

hub.subscribe((event, data: any) => {
  send({ event, data });
  if (event === "message" && !uiForeground) {
    snapshot().then((snap) => {
      const n = buildNotification(data, snap, notifyContent);
      if (n) send({ ctl: "notify", ...n });
    }).catch(() => {});
  }
  if (event === "accounts-changed" || event === "account" || event === "sync-devices") reportState();
  if (event === "error") console.warn("[unimsg] error", JSON.stringify({ account: data?.id ?? data?.accountId, code: data?.code, message: data?.message, fatal: data?.fatal }));
  if (event === "account") console.log("[unimsg] account", data?.id, data?.state, data?.detail ?? "");
});

/** Tells the native side how many accounts exist (boot receiver: only restart the service when there is something to keep connected). */
let stateTimer: NodeJS.Timeout | undefined;
function reportState(now = false) {
  clearTimeout(stateTimer);
  const run = () => { up.then(() => hub.call("snapshot", {}) as Promise<Snapshot & { accounts?: unknown[] }>).then((s) => {
    const n = s.accounts?.length ?? 0;
    hub.call("syncStatus", {}).then((st: any) => !!st?.enabled && !st?.paused, () => lastSync).then((sy) => {
      if (n !== lastAccounts || sy !== lastSync) { lastAccounts = n; lastSync = sy; send({ ctl: "state", accounts: n, sync: sy }); }
    });
  }).catch(() => {}); };
  if (now) run(); else stateTimer = setTimeout(run, 500);
}

async function control(method: string, p: any): Promise<unknown> {
  switch (method) {
    case "$ping": return { pong: true, node: process.version, pid: process.pid, uptime: process.uptime(), ready: initDone };
    case "$foreground": uiForeground = !!p?.value; return {};
    case "$config":
      if (["full", "sender", "hidden"].includes(p?.notifyContent)) notifyContent = p.notifyContent;
      if (typeof p?.keepAlive === "boolean") keepAlive = p.keepAlive; // informational here; the native side acts on it
      return {};
    case "$reply": {
      if (typeof p?.chatId !== "string" || typeof p?.text !== "string" || !p.text.trim()) throw new Error("$reply needs chatId and a non-empty text");
      await up; await hub.call("send", { chatId: p.chatId, text: p.text }); return {};
    }
    case "$markRead": {
      if (typeof p?.chatId !== "string" || typeof p?.messageId !== "string") throw new Error("$markRead needs chatId and messageId");
      await up; await hub.call("markRead", { chatId: p.chatId, messageId: p.messageId }); return {};
    }
    case "$network": { // see bridge-protocol.ts
      if (typeof p?.metered === "boolean") hub.updater.setMetered(p.metered); // no background update check on a metered connection
      const list = Array.isArray(p?.interfaces) ? p.interfaces : [];
      await up; return await hub.call("syncNetworkChanged", { interfaces: list }).catch((e: any) => ({ error: String(e?.message ?? e) }));
    }
    case "$flush": flushSqlite(); return {};
    case "$shutdown": setImmediate(() => void shutdown()); return {};
    default: throw new Error("unknown control method " + method);
  }
}

async function handle(line: string) {
  let req: Request;
  try { req = JSON.parse(line); } catch { return; }
  if (typeof req.id !== "number" || typeof req.method !== "string") return;
  const t0 = Date.now(); res.pending++;
  try {
    const result = req.method.startsWith("$") ? await control(req.method, req.params) : await up.then(() => hub.call(req.method, req.params ?? {}));
    send({ id: req.id, result: result === undefined ? null : result });
  } catch (e: any) { send({ id: req.id, error: String(e?.message ?? e) }); }
  finally { res.pending--; const ms = Date.now() - t0; if (ms > 300 || req.method === "snapshot" || req.method === "$ping") plog("call", { method: req.method, ms, pending: res.pending }); }
}
const res = { pending: 0 };

mkdirSync(dirname(sockPath), { recursive: true });
rmSync(sockPath, { force: true }); // stale socket from a previous run
const server = net.createServer((sock) => {
  client?.destroy(); // one native peer at a time; a newer connection (service restart) wins
  client = sock; sock.setEncoding("utf8");
  const reader = new LineReader((l) => void handle(l));
  sock.on("data", (d) => { try { reader.push(String(d)); } catch { sock.destroy(); } });
  sock.on("close", () => { if (client === sock) client = undefined; });
  sock.on("error", () => {});
  send({ ctl: "ready", protocol: PROTOCOL_VERSION, node: process.version, sqlite: engine });
  lastAccounts = -1; reportState(true);
});
server.listen(sockPath, () => { try { chmodSync(sockPath, 0o600); } catch { /* ignore */ } console.log("[unimsg] backend ready on", sockPath, "(sqlite:", engine + ")"); });

let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  console.log("[unimsg] shutting down");
  try { await hub.shutdown(); } catch { /* ignore */ }
  try { flushSqlite(true); } catch { /* ignore */ }
  server.close(); rmSync(sockPath, { force: true });
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown());
