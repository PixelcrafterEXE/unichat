// Client side of the optional relay (apps/server/src/relay.ts): a WebSocket presented as a Socket-like duplex, so the Noise channel
// (channel.ts) runs over it unchanged. The relay only ever sees ciphertext after the plaintext prologue.
import { Duplex } from "node:stream";
import type { Socket } from "node:net";

/** Minimal WebSocket surface we need (the `ws` package). */
interface Ws { binaryType: string; send(d: Uint8Array, cb?: (e?: Error) => void): void; close(code?: number): void; terminate?(): void; on(ev: string, f: (...a: any[]) => void): void; once(ev: string, f: (...a: any[]) => void): void; off(ev: string, f: (...a: any[]) => void): void; readyState: number }
class WsDuplex extends Duplex {
  remoteAddress: string | undefined = undefined; remotePort = undefined;
  constructor(private ws: Ws) {
    super({ allowHalfOpen: false, readableHighWaterMark: 1 << 20 });
    ws.on("message", (d: Buffer | string, isBinary: boolean) => { if (isBinary === false || typeof d === "string") return; if (!this.push(Buffer.isBuffer(d) ? d : Buffer.from(d as any))) { /* the relay paces us */ } });
    ws.on("close", () => this.destroy()); ws.on("error", (e: Error) => this.destroy(e));
  }
  _read() { /* push-driven */ }
  _write(chunk: Buffer, _enc: string, cb: (e?: Error | null) => void) { try { this.ws.send(chunk, (e) => cb(e ?? null)); } catch (e) { cb(e as Error); } }
  _destroy(err: Error | null, cb: (e: Error | null) => void) { try { this.ws.terminate ? this.ws.terminate() : this.ws.close(); } catch { /* closed */ } cb(err); }
  setNoDelay() { return this; } setTimeout() { return this; }
}
const loadWs = async () => (await import("ws")).default as unknown as new (url: string, o?: object) => Ws;

/** Open `<base>/<rendezvous id>` and wait until the relay reports that the peer is there too (it sends the text frame "paired"). */
export async function openRelay(base: string, rid: string, o: { signal?: AbortSignal; waitMs?: number; park?: boolean } = {}): Promise<Socket> {
  const WS = await loadWs();
  const ws = new WS(`${base.replace(/\/+$/, "")}/${rid}`, { handshakeTimeout: 8000, maxPayload: 1 << 20, perMessageDeflate: false });
  ws.binaryType = "nodebuffer";
  const dup = new WsDuplex(ws); dup.on("error", () => { /* surfaced through the wait below or by the channel that owns the socket */ }); // listening from the start: nothing the peer sends right after "paired" can be missed
  await new Promise<void>((ok, fail) => {
    const t = setTimeout(() => { try { ws.terminate?.(); } catch { /* */ } fail(new Error("relay did not pair us with the other device in time")); }, o.waitMs ?? 20_000);
    const abort = () => { clearTimeout(t); try { ws.terminate?.(); } catch { /* */ } fail(new Error("aborted")); };
    o.signal?.addEventListener("abort", abort, { once: true });
    ws.on("message", function onMsg(d: any, isBinary: boolean) { if (!isBinary && String(d) === "paired") { clearTimeout(t); ws.off("message", onMsg); o.signal?.removeEventListener("abort", abort); ok(); } });
    ws.once("error", (e: Error) => { clearTimeout(t); fail(e); }); ws.once("close", () => { clearTimeout(t); fail(new Error("relay closed the connection")); });
  });
  return dup as unknown as Socket;
}
