// OPTIONAL dumb relay for UniChat device sync across networks (see https://github.com/PixelcrafterEXE/unichat/wiki/Architecture > Device sync > Beyond the local network).
// Two paired devices that cannot reach each other directly (both behind NAT) each open a WebSocket to  wss://<relay>/relay/<rendezvous id>.
// The relay pairs the first two connections that name the same room and then copies binary messages from one to the other. That is ALL it does:
//   - no accounts, no passwords, no database, no files: rooms live in memory and vanish when the second device leaves;
//   - it never sees plaintext: the devices run their Noise handshake and AEAD end to end THROUGH it (only the 1 KiB plaintext prologue
//     {v, mode, key tag} is visible). It could drop or delay traffic, never read or alter it undetected;
//   - the room name is HMAC(group key, both device ids): only group members can compute it and it changes when a device is removed;
//   - limits: rooms, connections per address, connection rate, message size, bandwidth, idle time. Text frames from clients are ignored.
// Run:  UNIMSG_RELAY=1 PORT=8780 HOST=0.0.0.0 pnpm --filter @unimsg/server relay     (put TLS in front for wss://, e.g. Caddy / nginx)
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

export interface RelayOptions {
  maxRooms?: number; maxPerIp?: number; perIpPerMinute?: number; maxMessageBytes?: number; bytesPerSecond?: number;
  /** how long one side may wait for the other (ms) */ waitMs?: number; /** idle limit once paired (ms) */ idleMs?: number;
  /** trust X-Forwarded-For from a reverse proxy on loopback */ trustProxy?: boolean;
  now?: () => number;
  /** TESTS: sees every forwarded binary frame (to prove no plaintext passes) */
  tap?: (d: Buffer) => void;
  /** TESTS (hostile relay): may replace a forwarded frame; returning null drops the frame and cuts both sides */
  mangle?: (d: Buffer) => Buffer | null;
}
interface Room { a?: WebSocket; b?: WebSocket; paired: boolean; created: number }
const RID = /^\/relay\/([0-9a-f]{64})$/;

export function createRelay(o: RelayOptions = {}) {
  const maxRooms = o.maxRooms ?? 2000, maxPerIp = o.maxPerIp ?? 24, perMin = o.perIpPerMinute ?? 120, maxMsg = o.maxMessageBytes ?? 1 << 20, bps = o.bytesPerSecond ?? 8 << 20;
  const waitMs = o.waitMs ?? 10 * 60_000, idleMs = o.idleMs ?? 10 * 60_000, now = o.now ?? Date.now;
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxMsg, perMessageDeflate: false });
  const rooms = new Map<string, Room>(), perIp = new Map<string, { open: number; hits: number[] }>();
  const stats = { rooms: 0, paired: 0, refused: 0, bytes: 0, messages: 0 };
  const ipOf = (req: IncomingMessage) => (o.trustProxy && req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : req.socket.remoteAddress ?? "?");
  const deny = (s: Duplex, code: number, why: string) => { stats.refused++; try { s.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ } s.destroy(); };

  /** Hand an HTTP upgrade request to the relay. Returns false when the path is not a relay path (the caller may route it elsewhere). */
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const m = RID.exec((req.url ?? "").split("?")[0]); if (!m) return false;
    const rid = m[1], ip = ipOf(req), t = now(); let st = perIp.get(ip);
    if (!st) { st = { open: 0, hits: [] }; perIp.set(ip, st); }
    st.hits = st.hits.filter((x) => t - x < 60_000); st.hits.push(t);
    if (st.hits.length > perMin || st.open >= maxPerIp) { deny(socket, 429, "Too Many Requests"); return true; }
    let room = rooms.get(rid);
    if (!room && rooms.size >= maxRooms) { deny(socket, 503, "Busy"); return true; }
    if (room?.a && room.b) { deny(socket, 409, "Room Full"); return true; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      st!.open++;
      room = rooms.get(rid); if (!room) { room = { paired: false, created: now() }; rooms.set(rid, room); stats.rooms++; }
      if (room.a && room.b) { ws.close(1013, "full"); st!.open--; return; }
      if (!room.a) room.a = ws; else room.b = ws;
      const other = () => (room!.a === ws ? room!.b : room!.a);
      let tokens = bps * 2, last = now(), seen = now(), alive = true;
      const killer = setInterval(() => { const idle = room!.paired ? idleMs : waitMs; if (now() - seen > idle || !alive) return ws.terminate(); alive = false; try { ws.ping(); } catch { /* gone */ } }, 30_000); killer.unref?.();
      ws.on("pong", () => { alive = true; });
      ws.on("message", (d: Buffer, isBinary: boolean) => {
        seen = now(); if (!isBinary) return; // control text is ours alone; clients cannot inject it
        const n = now(); tokens = Math.min(bps * 2, tokens + ((n - last) / 1000) * bps); last = n; tokens -= d.length;
        if (tokens < 0) return ws.close(1008, "rate limit");
        const peer = other(); if (!peer || !room!.paired) return; // nothing is buffered for a peer that is not there yet
        stats.bytes += d.length; stats.messages++; o.tap?.(d);
        const out = o.mangle ? o.mangle(d) : d; if (!out) { peer.terminate(); return ws.terminate(); }
        peer.send(out, { binary: true });
      });
      ws.on("close", () => { clearInterval(killer); st!.open--; const peer = other(); if (room!.a === ws) room!.a = undefined; else room!.b = undefined; if (peer) peer.close(1000, "peer left"); if (!room!.a && !room!.b) rooms.delete(rid); });
      ws.on("error", () => ws.terminate());
      if (room.a && room.b) { room.paired = true; stats.paired++; room.a.send("paired"); room.b.send("paired"); }
    });
    return true;
  }
  return { handleUpgrade, stats: () => ({ ...stats, openRooms: rooms.size }), close: () => { for (const r of rooms.values()) { r.a?.terminate(); r.b?.terminate(); } rooms.clear(); wss.close(); } };
}

/** A stand-alone relay HTTP server (what `UNIMSG_RELAY=1` / `pnpm relay` runs). */
export function startRelayServer(port: number, host: string, o: RelayOptions = {}): Promise<{ server: Server; port: number; relay: ReturnType<typeof createRelay>; close(): void }> {
  const relay = createRelay(o);
  const server = createServer((_req, res) => { res.writeHead(404, { "content-type": "text/plain" }); res.end("UniChat relay: WebSocket only\n"); });
  server.on("upgrade", (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) { socket.destroy(); } });
  return new Promise((ok, fail) => { server.once("error", fail); server.listen(port, host, () => ok({ server, port: (server.address() as { port: number }).port, relay, close: () => { relay.close(); server.close(); } })); });
}
