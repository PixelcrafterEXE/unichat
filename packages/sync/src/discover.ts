// Finding the device that shows a pairing code, with no configuration: the code alone is enough.
// The device that ENTERS the code dials out; the one that SHOWS it listens on a well-known port (45045, small fallback range).
// Candidate sources, all tried in parallel, first authenticated handshake wins and cancels the rest:
//   link (QR: addresses inside), typed address, hints (addresses of earlier pairings), known (addresses of the device group), mDNS, LAN probe.
// The LAN probe only ever targets the user's OWN private IPv4 subnets (RFC 1918, at most a /24 per interface and 512 hosts in total) and never
// VPN / container / cellular interfaces. The handshake (channel.ts: Noise XXpsk0 with a key derived from the code) is the only thing a probed host sees;
// the code is never sent, and a host that does not know it learns nothing but that a pairing handshake was started.
import { ChannelError } from "./channel.js";
import type { Iface } from "./addrs.js";

export const SYNC_PORT = 45045, SYNC_PORT_SPAN = 8;
export const wellKnownPorts = (base = SYNC_PORT, span = SYNC_PORT_SPAN) => Array.from({ length: span }, (_, i) => base + i);
/** Listening order: the port used last time (if it is in the range), then the range, then any port (0). */
export function listenPorts(preferred: number | undefined, base = SYNC_PORT, span = SYNC_PORT_SPAN): number[] {
  const r = wellKnownPorts(base, span); return [...(preferred && r.includes(preferred) ? [preferred] : []), ...r.filter((p) => p !== preferred), 0];
}

export type CandSrc = "link" | "typed" | "hint" | "known" | "mdns" | "probe";
export interface Cand { host: string; ports: number[]; src: CandSrc }

// ---- LAN probe targets (pure) ----
const octets = (ip: string) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip); const o = m ? m.slice(1).map(Number) : []; return o.length === 4 && o.every((x) => x <= 255) ? o : undefined; };
const toInt = (o: number[]) => ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
const fromInt = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
/** RFC 1918 only: 10/8, 172.16/12, 192.168/16. Link-local, CGNAT (VPN), loopback and every public address are NOT private for this purpose. */
export function isPrivateLan(ip: string): boolean { const o = octets(ip); return !!o && (o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)); }
const SKIP_IFACE = /^(docker|br-|veth|virbr|cni|flannel|cali|podman|lxc|lxd|vmnet|vboxnet|tun|tap|wg|tailscale|ts\d|zt|ppp|utun|ipsec|nordlynx|proton|mullvad|rmnet|ccmni|pdp|v4-|clat|dummy|kube|weave|ham|hamachi)/i;
const prefixOf = (mask?: string) => { const o = mask ? octets(mask) : undefined; if (!o) return 24; let n = toInt(o), p = 0; while (n & 0x80000000) { p++; n = (n << 1) >>> 0; } return p; };
/** Hosts worth probing on the given interfaces. Never public, VPN, container, cellular, link-local or own addresses; at most a /24 per interface, `max` hosts in total. */
export function probeHosts(ifs: Iface[], max = 512): string[] {
  const own = new Set(ifs.map((i) => i.address)), out: string[] = [], seen = new Set<string>();
  for (const i of ifs) {
    if (i.family !== 4 || i.internal || SKIP_IFACE.test(i.name) || !isPrivateLan(i.address)) continue;
    const o = octets(i.address)!, prefix = Math.max(24, prefixOf(i.netmask)); if (prefix > 30) continue;
    const size = 2 ** (32 - prefix), base = (toInt(o) & (~(size - 1) >>> 0)) >>> 0, me = toInt(o);
    // nearest addresses first: neighbours are the likeliest, DHCP pools are often contiguous
    const order: number[] = []; for (let d = 1; d < size; d++) { order.push(me + d, me - d); }
    for (const n of order) {
      if (n <= base || n >= base + size - 1) continue; // network and broadcast address
      const ip = fromInt(n >>> 0); if (own.has(ip) || seen.has(ip) || !isPrivateLan(ip)) continue;
      seen.add(ip); out.push(ip); if (out.length >= max) return out;
    }
  }
  return out;
}

// ---- parallel dialing ----
export class DialFailure extends Error { constructor(msg: string, public reason: "unreachable" | "code" | "other", public stats: DialStats) { super(msg); } }
export interface DialStats { tried: number; refused: number; timedOut: number; rejected: number; connected: number }
export interface DialAnyOpts<T> {
  /** candidates known up front, tried first (in this order) */ fixed: Cand[];
  /** polled while running (mDNS): candidates found later jump the queue */ poll?: () => Cand[];
  /** LAN probe targets (lowest priority) */ probe?: Cand[];
  /** one connection + authenticated handshake; must destroy its socket when `signal` aborts; ChannelError("auth") = reached something that did not accept the code */
  attempt(host: string, port: number, signal: AbortSignal, c: Cand): Promise<T>;
  /** a winner that arrives after another one won (close its channel) */ dispose?(v: T): void;
  concurrency?: number; overallMs?: number; pollMs?: number;
  /** when the queue is empty but polling is configured, wait this long before giving up (mDNS answers take a moment) */ graceMs?: number;
  signal?: AbortSignal;
}
const isRefused = (e: any) => e?.code === "ECONNREFUSED" || e?.code === "ECONNRESET";
/** Try every candidate (at most `concurrency` at a time) and resolve with the first handshake that authenticates; everything else is cancelled. */
export function dialAny<T>(o: DialAnyOpts<T>): Promise<{ value: T; cand: Cand; port: number; stats: DialStats }> {
  const stats: DialStats = { tried: 0, refused: 0, timedOut: 0, rejected: 0, connected: 0 }, ctl = new AbortController(), conc = o.concurrency ?? 64, t0 = Date.now();
  const queue: Cand[] = [], seen = new Set<string>(); let running = 0, done = false, other: string | undefined;
  const add = (c: Cand, front = false) => { const k = c.host + "|" + c.ports.join(","); if (seen.has(k)) return; seen.add(k); front ? queue.unshift(c) : queue.push(c); };
  return new Promise((ok, fail) => {
    const timers: ReturnType<typeof setTimeout | typeof setInterval>[] = [];
    const finish = (r: { value: T; cand: Cand; port: number } | DialFailure) => {
      if (done) return; done = true; ctl.abort(); timers.forEach((t) => { clearTimeout(t as any); clearInterval(t as any); });
      r instanceof DialFailure ? fail(r) : ok({ ...r, stats });
    };
    const failure = (decisive = false) => {
      const reason = other ? "other" : stats.rejected > 0 ? "code" : "unreachable";
      finish(new DialFailure(other ?? (stats.rejected ? "A device answered but did not accept the code." : decisive ? "unreachable" : "No device showing a pairing code could be reached."), reason, stats));
    };
    const check = () => { if (!done && !running && !queue.length && (!o.poll || Date.now() - t0 >= (o.graceMs ?? 2500))) failure(); };
    const pump = () => { while (!done && running < conc && queue.length) void run(queue.shift()!); check(); };
    const run = async (c: Cand) => {
      running++;
      try {
        for (const port of c.ports) {
          if (done) return; stats.tried++;
          try {
            const v = await o.attempt(c.host, port, ctl.signal, c); stats.connected++;
            if (done) { o.dispose?.(v); return; }
            return finish({ value: v, cand: c, port });
          } catch (e: any) {
            if (done) return;
            if (e instanceof ChannelError && e.code === "auth") { stats.connected++; stats.rejected++; if (c.src === "link" || c.src === "typed" || c.src === "mdns") return failure(true); continue; } // explicitly named / announced host: the code is wrong, stop at once
            if (e instanceof ChannelError && e.code === "protocol" && e.soft) { other = e.message; return failure(true); }
            if (isRefused(e)) { stats.refused++; continue; } // the host is up but nothing listens on this port: try the next port of the range
            stats.timedOut++; return; // dropped / unreachable: no point trying more ports there
          }
        }
      } finally { running--; if (!done) pump(); }
    };
    for (const c of o.fixed) add(c); for (const c of o.probe ?? []) add(c);
    if (o.poll) {
      const take = () => { for (const c of o.poll!()) add(c, true); pump(); };
      timers.push(setInterval(take, o.pollMs ?? 400)); take();
    }
    timers.push(setTimeout(() => failure(), o.overallMs ?? 20_000));
    o.signal?.addEventListener("abort", () => finish(new DialFailure("Cancelled.", "other", stats)), { once: true });
    if (!o.poll) pump(); else timers.push(setInterval(check, 200));
  });
}
