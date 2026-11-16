// Hosted web deployment: same Hub, exposed over WebSocket. Only the web build
// needs this; desktop and Android run the Hub in-process.
// Protocol: -> {id,method,params}   <- {id,result|error}   <- {event,data}
// Meant for ONE client on the same machine: it listens on 127.0.0.1 only. HOST=<address> opens it to another interface; that
// then REQUIRES UNIMSG_TOKEN (and TLS in front). There is no multi-device access management on purpose.
// SECURITY (read this before exposing it):
//  - Browsers attach an Origin header to WebSocket connections, so by default only pages served from localhost /
//    127.0.0.1 may connect. Without this ANY website open in your browser could read your messages through the
//    local backend (cross-site WebSocket hijacking). For a hosted deployment list the UI's origin(s) in
//    UNIMSG_ALLOWED_ORIGINS (comma separated, e.g. https://chat.example.org).
//  - UNIMSG_TOKEN requires clients to present ?token=... (compared in constant time). It is MANDATORY when HOST is not a
//    loopback address; the server refuses to start otherwise. Always put TLS (wss://) in front of a non-local deployment,
//    because the token travels in the URL.
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { createBackupHandler } from "./backup-http.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { startBackend } from "@unimsg/host";

// UNIMSG_RELAY=1: run ONLY the optional device-sync relay (no Hub, no data directory). Same as `pnpm relay`.
if (process.env.UNIMSG_RELAY === "1") { await import("./relay-main.js"); await new Promise(() => {}); }
const host = process.env.HOST ?? "127.0.0.1", port = Number(process.env.PORT ?? 8765);
const token = process.env.UNIMSG_TOKEN?.trim() || undefined;
const allowedOrigins = (process.env.UNIMSG_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
if (!loopback && !token) {
  console.error(`[unimsg] refusing to listen on ${host} without UNIMSG_TOKEN: that would expose your messages to the network.`);
  process.exit(1);
}
const isLocalOrigin = (o: string) => { try { const h = new URL(o).hostname; return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"; } catch { return false; } };
const digest = (v: string) => createHash("sha256").update(v).digest();

// Backups: archives are exchanged over streaming HTTP on the same port (see backup-http.ts), file paths only on loopback and only inside UNIMSG_BACKUP_DIR.
const dataDir = process.env.UNIMSG_DATA ?? join(homedir(), ".config", "unimsg");
const hub = await startBackend(dataDir, { name: "web server", backup: { paths: loopback ? "dir" : "none", dir: process.env.UNIMSG_BACKUP_DIR || join(dataDir, "backups"), maxUploadBytes: Number(process.env.UNIMSG_BACKUP_MAX_BYTES) || undefined } })
  .catch((e) => { if ((e as { code?: string }).code !== "KEY_MISMATCH") throw e; console.error(`[unimsg] ${(e as Error).message}\nSet UNIMSG_DB_KEY to the key that sealed it, or point UNIMSG_DATA at another folder.`); process.exit(1); });
const backupHttp = createBackupHandler(hub, { token, allowedOrigins, isLocalOrigin });
const http = createServer((req, res) => { backupHttp(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }, () => { res.destroy(); }); });
http.listen(port, host);
const wss = new WebSocketServer({
  server: http, path: "/ws",
  verifyClient: ({ origin, req }, done) => {
    if (origin && !(allowedOrigins.length ? allowedOrigins.includes(origin) : isLocalOrigin(origin))) return done(false, 403, "origin not allowed");
    if (token) {
      const given = new URL(req.url ?? "", "http://x").searchParams.get("token") ?? "";
      if (!timingSafeEqual(digest(given), digest(token))) return done(false, 401, "access token required");
    }
    done(true);
  },
});

wss.on("connection", (ws) => {
  const off = hub.subscribe((event, data) => ws.send(JSON.stringify({ event, data })));
  ws.on("close", off);
  ws.on("message", async (raw) => {
    const { id, method, params } = JSON.parse(String(raw));
    try { ws.send(JSON.stringify({ id, result: await hub.call(method, params) })); }
    catch (e: any) { ws.send(JSON.stringify({ id, error: e.message })); }
  });
});
console.log("unimsg server on ws://%s:%s/ws%s", host, port, token ? " (token required)" : "");

// Operational log (no message content: providers only emit codes / error class names).
hub.subscribe((event, data: any) => {
  if (event === "error") console.warn("[unimsg] error", JSON.stringify({ account: data.id ?? data.accountId, code: data.code, message: data.message, fatal: data.fatal }));
  if (event === "account") console.log("[unimsg] account", data.id, data.state, data.detail ?? "");
});
// Flush provider caches / stop sockets cleanly (a plain kill would lose recently learned chats and keys).
// A bug in one account/provider must not take the whole backend down: log it (stack only, no message content) and keep serving.
process.on("uncaughtException", (e) => console.error("[unimsg] uncaught exception:", (e as Error)?.stack ?? e));
process.on("unhandledRejection", (e) => console.error("[unimsg] unhandled rejection:", (e as Error)?.stack ?? e));
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => { console.log(`[unimsg] ${sig}: shutting down`); hub.shutdown().catch(() => {}).finally(() => process.exit(0)); });
