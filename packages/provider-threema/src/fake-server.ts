// In-process fake of the Threema Gateway (127.0.0.1 only) plus fake peers that can "send" to the account through the callback webhook.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { box, boxOpen, generateKeyPair, randomNonce } from "./nacl.js";
import { callbackMac, frame, hex, unframe, unhex } from "./proto.js";

export const GW = "*TESTGW1", SECRET = "gw-secret-abc123";
export interface Peer { id: string; sk: Uint8Array; pk: Uint8Array; nickname?: string }
export interface Sent { to: string; id: string; type: number; data: Uint8Array }

export class FakeGateway {
  server!: Server; url = "";
  gw = generateKeyPair();
  peers = new Map<string, Peer>();
  sent: Sent[] = [];
  blobs = new Map<string, Uint8Array>();
  credits = 100;
  callbackUrl = "";
  failNext = 0; rateLimitNext = 0; hits: string[] = [];
  registeredGwKey = hex(this.gw.publicKey);

  peer(id: string, nickname?: string): Peer { const k = generateKeyPair(); const p = { id, sk: k.secretKey, pk: k.publicKey, nickname }; this.peers.set(id, p); return p; }

  async start() {
    this.server = createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks);
      this.hits.push(`${req.method} ${u.pathname}`);
      const out = (code: number, body = "", type = "text/plain") => { res.writeHead(code, { "content-type": type }); res.end(body); };
      let form = new URLSearchParams(u.searchParams);
      const ct = req.headers["content-type"] ?? "";
      let blob: Uint8Array | undefined;
      if (ct.startsWith("application/x-www-form-urlencoded")) for (const [k, v] of new URLSearchParams(raw.toString())) form.set(k, v);
      if (ct.startsWith("multipart/form-data")) { const fd = await new Response(raw, { headers: { "content-type": ct } }).formData(); const b = fd.get("blob"); if (b instanceof Blob) blob = new Uint8Array(await b.arrayBuffer()); }
      if (form.get("from") !== GW || form.get("secret") !== SECRET) return out(401);
      if (this.failNext > 0) { this.failNext--; return out(500); }
      if (this.rateLimitNext > 0) { this.rateLimitNext--; return out(429); }
      if (u.pathname === "/credits") return out(200, String(this.credits));
      let m: RegExpMatchArray | null;
      if ((m = u.pathname.match(/^\/pubkeys\/([^/]+)$/))) {
        if (m[1] === GW) return out(200, this.registeredGwKey);
        const p = this.peers.get(m[1]); return p ? out(200, hex(p.pk)) : out(404);
      }
      if (u.pathname === "/send_e2e" && req.method === "POST") {
        if (this.credits <= 0) return out(402);
        const to = form.get("to") ?? "", p = this.peers.get(to); if (!p) return out(400);
        const plain = boxOpen(unhex(form.get("box") ?? ""), unhex(form.get("nonce") ?? ""), this.gw.publicKey, p.sk);
        const f = plain && unframe(plain); if (!f) return out(400);
        this.credits--; const id = randomBytes(8).toString("hex");
        this.sent.push({ to, id, type: f.type, data: f.data }); return out(200, id);
      }
      if (u.pathname === "/upload_blob" && req.method === "POST") {
        if (!blob?.length) return out(400); if (this.credits <= 0) return out(402);
        this.credits--; const id = randomBytes(16).toString("hex"); this.blobs.set(id, blob); return out(200, id);
      }
      if ((m = u.pathname.match(/^\/blobs\/([0-9a-f]+)$/))) { const b = this.blobs.get(m[1]); return b ? out(200, Buffer.from(b) as unknown as string, "application/octet-stream") : out(404); }
      out(404);
    });
    await new Promise<void>((ok) => this.server.listen(0, "127.0.0.1", ok));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close() { this.server.closeAllConnections?.(); await new Promise((ok) => this.server.close(ok)); }

  /** A peer sends an E2E message to the account: POST to the connector's callback listener. Resolves with the HTTP status. */
  async deliver(peerId: string, type: number, payload: Uint8Array, o: { messageId?: string; date?: number; badMac?: boolean; secret?: string } = {}): Promise<{ status: number; messageId: string }> {
    const p = this.peers.get(peerId)!; const nonce = randomNonce();
    const f = { from: peerId, to: GW, messageId: o.messageId ?? randomBytes(8).toString("hex"), date: String(o.date ?? Math.floor(Date.now() / 1000)), nonce: hex(nonce), box: hex(box(frame(type, payload), nonce, this.gw.publicKey, p.sk)) };
    const mac = o.badMac ? "0".repeat(64) : callbackMac(o.secret ?? SECRET, f);
    const r = await fetch(this.callbackUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...f, mac, ...(p.nickname ? { nickname: p.nickname } : {}) }) });
    return { status: r.status, messageId: f.messageId };
  }
}
