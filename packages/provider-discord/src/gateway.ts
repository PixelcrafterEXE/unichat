// Minimal Discord Gateway v10 client on `ws`: HELLO / heartbeat / IDENTIFY / RESUME / RECONNECT / INVALID_SESSION, optional zlib-stream.
// Never logs payloads (they contain message text); debug lines carry only opcodes, event names and close codes.
import { constants as Z, createInflate, type Inflate } from "node:zlib";
import WebSocket from "ws";
import { dbg, gatewayAllowed, sleep, type Identity, type Mode } from "./api.js";

export const INTENT = {
  GUILDS: 1 << 0, GUILD_MESSAGES: 1 << 9, GUILD_MESSAGE_REACTIONS: 1 << 10, GUILD_MESSAGE_TYPING: 1 << 11,
  DIRECT_MESSAGES: 1 << 12, DIRECT_MESSAGE_REACTIONS: 1 << 13, DIRECT_MESSAGE_TYPING: 1 << 14,
  MESSAGE_CONTENT: 1 << 15, GUILD_MESSAGE_POLLS: 1 << 24, DIRECT_MESSAGE_POLLS: 1 << 25,
} as const;
/** Everything the connector listens to; GUILD_MEMBERS / GUILD_PRESENCES are deliberately NOT requested (privileged and heavy). */
export const BOT_INTENTS = INTENT.GUILDS | INTENT.GUILD_MESSAGES | INTENT.GUILD_MESSAGE_REACTIONS | INTENT.GUILD_MESSAGE_TYPING
  | INTENT.DIRECT_MESSAGES | INTENT.DIRECT_MESSAGE_REACTIONS | INTENT.DIRECT_MESSAGE_TYPING | INTENT.GUILD_MESSAGE_POLLS | INTENT.DIRECT_MESSAGE_POLLS;
/** Hypothesis: capability bitfield a current desktop/web client sends (community documentation; cannot be verified offline). */
export const USER_CAPABILITIES = 16381;

export type GwFatal = "auth" | "intents" | "config";
export interface GatewayOpts {
  url: string; token: string; mode: Mode; intents: number; identity?: Identity; zlib: boolean;
  onDispatch(t: string, d: any): void;
  /** READY or RESUMED reached (connection usable). */
  onUp(kind: "ready" | "resumed"): void;
  onDown(): void;
  /** Fatal close code. Return true to try again (e.g. after the connector lowered `intents`). */
  onFatal(why: GwFatal, code: number): boolean;
  onProblem?(msg: string): void;
}

const SUFFIX = Buffer.from([0x00, 0x00, 0xff, 0xff]);

export class Gateway {
  intents: number;
  private ws?: WebSocket;
  private stopped = false;
  private sessionId?: string;
  private resumeUrl?: string;
  private seq: number | null = null;
  private identifies: number[] = [];
  private lastIdentify = 0;
  private readonly o: GatewayOpts;
  /** Tests only, and only against a loopback gateway: shrink the safety delays. */
  private readonly fast: boolean;
  private wake?: () => void;
  constructor(o: GatewayOpts) { this.o = o; this.intents = o.intents; this.fast = process.env.UNIMSG_DISCORD_GW_FAST === "1" && /^ws:\/\/127\.0\.0\.1[:/]/.test(o.url); }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }
  start() { this.stopped = false; void this.loop(); }
  stop() { this.stopped = true; try { this.ws?.terminate(); } catch { /* ignore */ } this.ws = undefined; this.wake?.(); }
  /** Drop the session so the next connect is a fresh IDENTIFY. */
  reset() { this.sessionId = undefined; this.seq = null; this.resumeUrl = undefined; }
  /** Send a client opcode (e.g. user-mode subscriptions). */
  send(op: number, d: unknown) { try { if (this.connected) this.ws!.send(JSON.stringify({ op, d })); } catch { /* closing */ } }

  private async loop() {
    let attempt = 0;
    while (!this.stopped) {
      const r = await this.once();
      if (this.stopped) return;
      this.o.onDown();
      if (r.up) attempt = 0;
      const c = r.code;
      if (c === 4004) { if (!this.o.onFatal("auth", c)) return; this.reset(); }
      else if (c === 4014) { if (!this.o.onFatal("intents", c)) return; this.reset(); }
      else if (c === 4010 || c === 4011 || c === 4012 || c === 4013) { if (!this.o.onFatal("config", c)) return; this.reset(); }
      else if (c === 4007 || c === 4009) this.reset();
      let delay = Math.min(60000, (this.fast ? 30 : this.o.mode === "user" ? 3000 : 1000) * 2 ** Math.min(attempt++, 6)) * (0.5 + Math.random() * 0.5);
      if (c === 4008 && !this.fast) delay = Math.max(delay, 30000 + Math.random() * 15000);
      if (r.pause) delay = Math.max(delay, r.pause);
      dbg(`gateway closed (${c}), reconnect in ${Math.round(delay)}ms`);
      await new Promise<void>((ok) => { const t = setTimeout(done, delay); const self = this; function done() { clearTimeout(t); self.wake = undefined; ok(); } this.wake = done; });
    }
  }

  private async throttleIdentify(): Promise<number> {
    const now = Date.now();
    this.identifies = this.identifies.filter((t) => now - t < 3600000);
    let pause = 0;
    if (this.identifies.length >= 6) { pause = 10 * 60000; this.o.onProblem?.("Discord keeps ending the connection; UniChat waits 10 minutes before logging in to the gateway again."); }
    const gap = this.fast ? 0 : this.lastIdentify + 5500 - now;
    if (gap > 0) await sleep(gap);
    return pause;
  }

  private once(): Promise<{ code: number; up: boolean; pause?: number }> {
    return new Promise((resolve) => {
      const base = this.sessionId && this.resumeUrl && gatewayAllowed(this.resumeUrl) ? this.resumeUrl : this.o.url;
      const qs = `v=10&encoding=json${this.o.zlib ? "&compress=zlib-stream" : ""}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${base.replace(/\/$/, "")}/?${qs}`, { handshakeTimeout: 20000, headers: this.o.mode === "user" && this.o.identity ? { "User-Agent": this.o.identity.userAgent, Origin: "https://discord.com" } : {} });
      } catch { resolve({ code: 1006, up: false }); return; }
      this.ws = ws;
      let up = false, acked = true, hb: NodeJS.Timeout | undefined, hb1: NodeJS.Timeout | undefined, pause: number | undefined;
      let inflate: Inflate | undefined, chunks: Buffer[] = [];
      if (this.o.zlib) { inflate = createInflate({ flush: Z.Z_SYNC_FLUSH }); inflate.on("data", (c: Buffer) => chunks.push(c)); inflate.on("error", () => { try { ws.terminate(); } catch { /* ignore */ } }); }
      const beat = () => {
        if (!acked) { dbg("heartbeat not acknowledged: reconnecting"); try { ws.terminate(); } catch { /* ignore */ } return; }
        acked = false; this.sendOn(ws, 1, this.seq);
      };
      const handle = async (text: string) => {
        let p: { op: number; d: any; s?: number | null; t?: string | null };
        try { p = JSON.parse(text); } catch { return; }
        if (typeof p.s === "number") this.seq = p.s;
        switch (p.op) {
          case 10: { // HELLO
            const iv = Number(p.d?.heartbeat_interval) || 41250;
            hb1 = setTimeout(() => { beat(); hb = setInterval(beat, iv); }, iv * Math.random());
            if (this.sessionId) { dbg("RESUME"); this.sendOn(ws, 6, { token: this.o.token, session_id: this.sessionId, seq: this.seq }); }
            else {
              pause = await this.throttleIdentify();
              if (ws.readyState !== WebSocket.OPEN) return;
              this.lastIdentify = Date.now(); this.identifies.push(this.lastIdentify);
              dbg("IDENTIFY"); this.sendOn(ws, 2, this.identifyPayload());
            }
            return;
          }
          case 11: acked = true; return;
          case 1: this.sendOn(ws, 1, this.seq); return;
          case 7: dbg("RECONNECT requested"); try { ws.close(4000, "reconnect"); } catch { /* ignore */ } return;
          case 9: { // INVALID_SESSION
            dbg(`INVALID_SESSION resumable=${p.d === true}`);
            if (p.d !== true) this.reset();
            await sleep(this.fast ? 30 : 1000 + Math.random() * 4000);
            try { ws.close(4000, "invalid session"); } catch { /* ignore */ }
            return;
          }
          case 0: {
            const t = p.t ?? "";
            if (t === "READY") {
              this.sessionId = p.d?.session_id;
              this.resumeUrl = typeof p.d?.resume_gateway_url === "string" ? p.d.resume_gateway_url : undefined;
              up = true; this.o.onUp("ready");
            } else if (t === "RESUMED") { up = true; this.o.onUp("resumed"); }
            dbg(`dispatch ${t}`);
            try { this.o.onDispatch(t, p.d); } catch { /* handlers must not throw; contract rule 3 */ }
            return;
          }
          default: return;
        }
      };
      let chain: Promise<void> = Promise.resolve();
      const enqueue = (text: string) => { chain = chain.then(() => handle(text)).catch(() => {}); };
      ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
        if (!inflate || !isBinary) { enqueue(buf.toString("utf8")); return; }
        inflate.write(buf);
        if (buf.length >= 4 && buf.subarray(buf.length - 4).equals(SUFFIX)) {
          inflate.flush(Z.Z_SYNC_FLUSH, () => { const out = Buffer.concat(chunks).toString("utf8"); chunks = []; if (out) enqueue(out); });
        }
      });
      ws.on("error", () => { /* close follows */ });
      ws.on("close", (code: number) => {
        clearTimeout(hb1); clearInterval(hb); try { inflate?.close(); } catch { /* ignore */ }
        if (this.ws === ws) this.ws = undefined;
        resolve({ code, up, pause });
      });
    });
  }

  private sendOn(ws: WebSocket, op: number, d: unknown) { try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d })); } catch { /* closing */ } }

  private identifyPayload() {
    if (this.o.mode === "bot") {
      return { token: this.o.token, intents: this.intents, large_threshold: 50, properties: { os: "linux", browser: "unimsg", device: "unimsg" } };
    }
    return {
      token: this.o.token, capabilities: USER_CAPABILITIES, properties: this.o.identity?.props ?? {}, compress: false,
      presence: { status: "online", since: 0, activities: [], afk: false }, client_state: { guild_versions: {} },
    };
  }
}
