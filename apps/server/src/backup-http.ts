// Streaming HTTP endpoints for backup archives (they can be many GB, so they never go through the JSON-RPC websocket):
//   POST /backup/upload            raw body = the archive           -> {id, size}   (then importData({uploadId: id, ...}) over the websocket)
//   GET  /backup/download/<id>     one-time id from exportData({deliver:"download"})  -> the archive as an attachment
// Same access rules as the websocket: Origin must be allowed, and when UNIMSG_TOKEN is set the token is required
// (Authorization: Bearer <token> or ?token=). Download ids are 192-bit random, single use and expire after 15 minutes;
// uploads are capped (BackupPolicy.maxUploadBytes) and counted while streaming.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { BackupService } from "@unimsg/core";

export interface BackupHttpOptions { token?: string; allowedOrigins: string[]; isLocalOrigin: (o: string) => boolean }
const digest = (v: string) => createHash("sha256").update(v).digest();

export function createBackupHandler(hub: { backup: BackupService }, o: BackupHttpOptions) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/backup/")) return false;
    const origin = req.headers.origin;
    const send = (code: number, body: object, extra: Record<string, string> = {}) => { if (!res.headersSent) res.writeHead(code, { "content-type": "application/json", ...cors, ...extra }); res.end(JSON.stringify(body)); };
    const cors: Record<string, string> = {};
    if (origin) {
      if (!(o.allowedOrigins.length ? o.allowedOrigins.includes(origin) : o.isLocalOrigin(origin))) { send(403, { error: "origin not allowed" }); return true; }
      Object.assign(cors, { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-headers": "authorization, content-type, x-backup-name", "access-control-allow-methods": "GET, POST, OPTIONS" });
    }
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return true; }
    if (o.token) {
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? url.searchParams.get("token") ?? "";
      if (!timingSafeEqual(digest(bearer), digest(o.token))) { send(401, { error: "access token required" }); return true; }
    }
    try {
      if (req.method === "POST" && url.pathname === "/backup/upload") {
        const len = Number(req.headers["content-length"] ?? NaN);
        const { id } = hub.backup.beginUpload(Number.isFinite(len) ? len : undefined, String(req.headers["x-backup-name"] ?? ""));
        const t = hub.backup.uploadTarget(id);
        try {
          const counter = new Transform({ transform(chunk, _e, cb) { try { t.add(chunk.length); cb(null, chunk); } catch (e) { cb(e as Error); } } });
          await pipeline(req, counter, createWriteStream(t.part, { mode: 0o600 }));
          t.finish();
        } catch (e) { t.fail(); throw e; }
        send(200, { id }); return true;
      }
      const m = /^\/backup\/download\/([\w-]+)$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const d = hub.backup.openDownload(m[1]);
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(d.size), "content-disposition": `attachment; filename="${d.name.replace(/[^\w.-]/g, "_")}"`, "cache-control": "no-store", ...cors });
        let ok = false;
        try { await pipeline(createReadStream(d.path), res); ok = true; } finally { d.done(ok); }
        return true;
      }
      send(404, { error: "not found" });
    } catch (e: any) {
      if (!res.headersSent) send(e?.code === "too-large" ? 413 : 400, { error: e?.message ?? "failed" }); else res.destroy();
      if (!req.complete) req.resume();
    }
    return true;
  };
}
