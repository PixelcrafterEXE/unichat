// "Reach my devices from anywhere": HyperDHT (the Holepunch DHT) as one more TRANSPORT next to mDNS, saved tcp addresses and the optional self-hosted relay.
//
// What the DHT gives us is only a raw, end-to-end encrypted duplex stream to a public key, found through hole punching (no relay in the data path, no server of ours).
// EVERYTHING above it is unchanged: the same framing, the same Noise_XXpsk0 handshake with the group-key psk and the same member check as over TCP (channel.ts, service.ts).
// A stream that cannot pass that is closed, so the DHT is never trusted for authentication.
//
// Identity. Each device derives ONE HyperDHT keypair per group:  seed = HKDF-SHA256(ikm = device Noise private key, salt = SHA-256(group id), info = "unichat-sync-dht-identity-v1").
// The Noise key itself is never used as a DHT key (domain separation by HKDF); the same device has a different, unlinkable DHT key in every group, and nobody without
// the device's private key can compute it. The public key is announced to the group through the group record (`Dev.dht`), so peers know whom to look up without any
// shared secret on the wire. The group key is deliberately NOT an input: it rotates on every revocation, which would silently change every device's DHT address.
//
// What the public DHT sees (documented in docs/ARCHITECTURE.md): your IP address and that of the peer, the time, your device's DHT public key and that it announces / looks up that key.
// It never sees the group id, the group key, device ids, names or any content: the key is a one-way derivation and everything after the DHT handshake is Noise.
//
// Android / nodejs-mobile: `hyperdht` uses the native add-ons udx-native and sodium-native. The module is therefore loaded lazily and any failure is reported as "not available
// on this platform" instead of crashing (see apps/android/README.md).
import { createHash, hkdfSync } from "node:crypto";
import type { Socket } from "node:net";

export interface DhtSetting { enabled: boolean; /** "host:port" entries of your own bootstrap nodes; empty = the public Holepunch bootstrap nodes */ bootstrap: string[] }
/** On by default (user decision, 2026-11-15): it only runs for a device that belongs to a paired group, loads lazily, and a platform without the add-on just reports "not available". */
export const DEFAULT_DHT: DhtSetting = { enabled: true, bootstrap: [] };
export type DhtState = "off" | "starting" | "ready" | "unavailable" | "error";
export class DhtUnavailable extends Error { constructor(msg: string) { super(msg); this.name = "DhtUnavailable"; } }

/** 32-byte seed of this device's DHT keypair in this group (see header). Pure function: no native code needed. */
export function dhtSeed(noisePriv: Uint8Array, groupId: string): Buffer {
  const salt = createHash("sha256").update("unichat-sync-dht-group-v1\0").update(groupId).digest();
  return Buffer.from(hkdfSync("sha256", noisePriv, salt, "unichat-sync-dht-identity-v1", 32));
}

/** Pairing over the DHT: the device that SHOWS a pairing code announces a DHT keypair derived from the code's scrypt key (`pairingPsk`), the device that ENTERS the code connects to that public key.
 * Only the one-way derivation is public: finding the code from the key costs one scrypt per guess (like attacking the Noise handshake itself), and the Noise_XXpsk0 handshake with the code psk plus the
 * 6-digit comparison stay the only authentication. The DHT only carries bytes. */
export function pairingDhtSeed(psk: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", psk, "unichat-sync-pairing-dht-v1", "unichat-sync-pairing-dht-identity-v1", 32));
}

const HOST_RE = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;
/** Validate the user's own bootstrap nodes ("host:port", IPv4, [IPv6] or DNS name). Throws a message fit for the UI. */
export function cleanBootstrap(x: unknown): string[] {
  const list = (Array.isArray(x) ? x : typeof x === "string" ? x.split(/[\s,;]+/) : []).map((s) => String(s).trim()).filter(Boolean);
  if (list.length > 5) throw new Error("Use at most 5 bootstrap nodes.");
  const out: string[] = [];
  for (const e of list) {
    const m = /^(.*):(\d{1,5})$/.exec(e);
    if (!m || !HOST_RE.test(m[1]) || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new Error(`"${e}" is not a bootstrap node. Write it as host:port, for example dht.example.org:49737.`);
    if (!out.includes(e)) out.push(e);
  }
  return out;
}
export function cleanDhtSetting(x: any, prev: DhtSetting = DEFAULT_DHT): DhtSetting {
  return { enabled: x?.enabled === undefined ? prev.enabled : !!x.enabled, bootstrap: x?.bootstrap === undefined ? prev.bootstrap : cleanBootstrap(x.bootstrap) };
}

/** Loads the `hyperdht` module (cached). Any failure (missing native add-on, unsupported platform) becomes DhtUnavailable. */
let cached: Promise<any> | undefined;
export function loadHyperdht(): Promise<any> {
  cached ??= (async () => {
    try { // @ts-ignore hyperdht ships no types and other packages that import this source do not see src/hyperdht.d.ts
      const m = await import("hyperdht"); return (m as any).default ?? m; }
    catch (e) { cached = undefined; throw new DhtUnavailable("not available on this platform: " + (e instanceof Error ? e.message.split("\n")[0] : String(e))); }
  })();
  return cached;
}

export interface DhtOpts {
  seed: Buffer; bootstrap: string[];
  /** called with every inbound stream that passed the DHT-level firewall (still unauthenticated at our level: the Noise handshake follows) */
  onInbound(sock: Socket): void;
  /** hex DHT public keys of the current, non-revoked members (the firewall refuses everyone else before a single byte reaches us) */
  allow(): string[];
  /** pairing rendezvous: accept every caller at the DHT level (the pairing handshake decides) and tag the sockets with this `unichatVia` value (default "dht") */
  open?: boolean; via?: string;
  /** TESTS: replace the module loader (e.g. one that throws, or a different build) */
  loader?: () => Promise<any>;
  /** TESTS: refuse to start without bootstrap nodes, so nothing can ever touch the public network */
  requireBootstrap?: boolean;
  maxDials?: number; startTimeoutMs?: number;
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export class DhtTransport {
  private dht: any; private server: any; private kp: { publicKey: Buffer; secretKey: Buffer } | undefined; private streams = new Set<any>();
  private active = 0; private waiters: (() => void)[] = []; private stopped = false;
  constructor(private o: DhtOpts) {}
  /** Hex DHT public key that belongs to a seed (needs the module; used to find the device that shows a pairing code). */
  async keyOf(seed: Buffer): Promise<string> {
    const DHT = await (this.o.loader ?? loadHyperdht)(); return hex(DHT.keyPair(seed).publicKey);
  }
  /** This device's DHT public key (hex), once started. */
  get publicKey(): string | undefined { return this.kp ? hex(this.kp.publicKey) : undefined; }
  get dials() { return this.active; }

  async start(): Promise<void> {
    const DHT = await (this.o.loader ?? loadHyperdht)().catch((e) => { throw e instanceof DhtUnavailable ? e : new DhtUnavailable("not available on this platform: " + (e instanceof Error ? e.message.split("\n")[0] : String(e))); });
    if (this.o.requireBootstrap && !this.o.bootstrap.length) throw new Error("no bootstrap node configured");
    if (this.stopped) return;
    this.kp = DHT.keyPair(this.o.seed);
    try {
      this.dht = new DHT({ ...(this.o.bootstrap.length ? { bootstrap: this.o.bootstrap } : {}) }); // no bootstrap option = the public Holepunch nodes
      this.dht.on?.("error", () => { /* surfaced through the operations that fail */ });
      this.server = this.dht.createServer({ firewall: (remotePk: Uint8Array) => this.o.open ? false : !this.o.allow().includes(hex(remotePk)) }, (stream: any) => this.accepted(stream));
      this.server.on?.("error", () => { /* keep running */ });
      await withTimeout(this.server.listen(this.kp), this.o.startTimeoutMs ?? 30_000, "the DHT did not answer in time");
    } catch (e) { await this.stop(); throw e; }
  }
  private accepted(stream: any) {
    if (this.stopped) return stream.destroy();
    this.track(stream); this.decorate(stream); this.o.onInbound(stream as Socket);
  }
  private track(s: any) { this.streams.add(s); s.once?.("close", () => this.streams.delete(s)); }
  /** Make a HyperDHT stream usable where the channel code expects a net.Socket. No address: there is no per-source accounting on the DHT, only the firewall and the unauthenticated-session cap. */
  private decorate(s: any) {
    s.on("error", () => { /* the owner (Framed) listens as well; never let an unhandled stream error kill the process */ });
    s.unichatVia = this.o.via ?? "dht"; s.remoteAddress = undefined; s.setNoDelay ??= () => s; s.setTimeout ??= () => s;
  }
  /** Connect to a peer's DHT public key (hex). At most `maxDials` run at once; later ones wait their turn (and give up with the signal). */
  async connect(remote: string, signal: AbortSignal, timeoutMs = 25_000): Promise<Socket> {
    if (!this.dht || this.stopped) throw new Error("the DHT is not running");
    await this.slot(signal);
    try {
      if (signal.aborted || this.stopped) throw new Error("aborted");
      const stream = this.dht.connect(Buffer.from(remote, "hex"), { keyPair: this.kp });
      this.track(stream); this.decorate(stream);
      await new Promise<void>((ok, fail) => {
        const t = setTimeout(() => bad(new Error("the other device did not answer through the DHT")), timeoutMs);
        const clean = () => { clearTimeout(t); signal.removeEventListener("abort", ab); stream.off("open", good); stream.off("error", bad); stream.off("close", gone); };
        const good = () => { clean(); ok(); }, bad = (e: Error) => { clean(); try { stream.destroy(); } catch { /* gone */ } fail(e); }, gone = () => bad(new Error("the DHT connection closed")), ab = () => bad(new Error("aborted"));
        stream.once("open", good); stream.once("error", bad); stream.once("close", gone); signal.addEventListener("abort", ab, { once: true });
      });
      return stream as Socket;
    } finally { this.release(); }
  }
  private slot(signal: AbortSignal): Promise<void> {
    if (this.active < (this.o.maxDials ?? 2)) { this.active++; return Promise.resolve(); }
    return new Promise((ok, fail) => {
      const w = () => { signal.removeEventListener("abort", ab); this.active++; ok(); }, ab = () => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); fail(new Error("aborted")); };
      this.waiters.push(w); signal.addEventListener("abort", ab, { once: true });
    });
  }
  private release() { this.active--; this.waiters.shift()?.(); }
  /** The network changed (Wi-Fi <-> mobile data, new address): announce again and let the node re-learn its public address. */
  refresh() {
    if (this.stopped) return;
    try { void Promise.resolve(this.server?.refresh?.()).catch(() => {}); } catch { /* best effort */ }
    try { void Promise.resolve(this.dht?.refresh?.()).catch(() => {}); } catch { /* best effort */ }
  }
  /** Close every socket, unannounce and destroy the node. Safe to call twice. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const w of this.waiters.splice(0)) w();
    for (const s of [...this.streams]) { try { s.destroy(); } catch { /* gone */ } } this.streams.clear();
    const srv = this.server, dht = this.dht; this.server = this.dht = undefined;
    try { await withTimeout(srv?.close?.(), 3000, "close"); } catch { /* best effort */ }
    try { await withTimeout(dht?.destroy?.({ force: true }), 3000, "destroy"); } catch { /* best effort */ }
  }
}
function withTimeout<T>(p: Promise<T> | T, ms: number, what: string): Promise<T> {
  return new Promise<T>((ok, fail) => { const t = setTimeout(() => fail(new Error(what)), ms); t.unref?.(); Promise.resolve(p).then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); fail(e); }); });
}
