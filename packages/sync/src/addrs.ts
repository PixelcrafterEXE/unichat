// Reaching a peer: candidate addresses, happy-eyeballs style racing, local interface selection, relay rendezvous ids.
import { createHmac } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { addrKey, type Addr, type Dev } from "./group.js";

const RFC1918 = (ip: string) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip);
const CGNAT = (ip: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip); // 100.64.0.0/10: Tailscale and other VPNs live here
export type ListenScope = "loopback" | "lan" | "address";
export interface ListenSetting { enabled: boolean; scope: ListenScope; address?: string }
/** A paired device listens on the local network by default (well-known port 45045..45052): without it a peer on the same Wi-Fi can never reach it directly. The user can turn it off. */
export const DEFAULT_LISTEN: ListenSetting = { enabled: true, scope: "lan" };

export interface Iface { name: string; address: string; family: 4 | 6; internal: boolean; netmask?: string }
/**
 * Interface list supplied by the host (Android: the native side reads ConnectivityManager / LinkProperties and sends it, because on some Android versions
 * `os.networkInterfaces()` throws or returns nothing). When set and non-empty it REPLACES the OS answer; `undefined` restores the OS answer.
 */
let override: Iface[] | undefined;
export function setInterfaceOverride(list: Iface[] | undefined) { override = list && list.length ? list.map((i) => ({ ...i })) : undefined; }
export function interfaces(): Iface[] {
  if (override) return override.map((i) => ({ ...i }));
  const out: Iface[] = [];
  let all: ReturnType<typeof networkInterfaces> = {}; try { all = networkInterfaces(); } catch { /* some Android versions refuse to list interfaces: then there is nothing to listen on or probe, and typing an address still works */ }
  for (const [name, list] of Object.entries(all)) for (const i of list ?? []) out.push({ name, address: i.address.replace(/%.*$/, ""), family: i.family === "IPv6" ? 6 : 4, internal: i.internal, netmask: i.netmask });
  return out;
}
/** Private-network IPv4 addresses of this machine (what "LAN interfaces" means: never a public address, never a Docker-style wildcard). VPN addresses (100.64/10) are NOT included: pick them explicitly. */
export const lanBindAddresses = (ifs = interfaces()) => ifs.filter((i) => i.family === 4 && !i.internal && RFC1918(i.address)).map((i) => i.address);
/** Addresses worth telling a peer about for the given bind set. */
export const advertisable = (binds: string[]) => binds.filter((h) => h !== "0.0.0.0" && h !== "::" && !/^127\./.test(h) && h !== "::1");
/** The addresses the listener should be bound to for a setting, or an error text. */
export function bindsFor(s: ListenSetting, ifs = interfaces()): { hosts: string[]; error?: string } {
  if (s.scope === "loopback") return { hosts: ["127.0.0.1"] };
  if (s.scope === "lan") return { hosts: lanBindAddresses(ifs) };
  const a = (s.address ?? "").trim().replace(/^\[|\]$/g, "");
  if (!a) return { hosts: [], error: "Enter the address of the network interface to listen on (for example your Tailscale or VPN address)." };
  if (a === "0.0.0.0" || a === "::") return { hosts: [], error: "Listening on every interface is not offered. Pick \"local network\" or one specific address." };
  if (!ifs.some((i) => i.address === a)) return { hosts: [], error: `This computer has no network interface with the address ${a}.` };
  return { hosts: [a] };
}
export const isVpnAddress = CGNAT;
const maskBits = (m?: string) => { if (!m || !/^\d+\.\d+\.\d+\.\d+$/.test(m)) return 24; return m.split(".").reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, "").length, 0); };
/**
 * Short fingerprint of the networks this device is on: the subnets of its private IPv4 interfaces (VPN / docker ranges excluded), sorted and hashed.
 * Changes when the device joins another Wi-Fi; addresses announced together with it are only valid while the owner still announces that fingerprint.
 */
export function netFingerprint(ifs: Iface[] = interfaces()): string {
  const subnets = ifs.filter((i) => i.family === 4 && !i.internal && RFC1918(i.address) && !/^(docker|br-|veth|virbr|tun|tap|wg|tailscale|zt)/i.test(i.name)).map((i) => {
    const b = maskBits(i.netmask), ip = i.address.split(".").reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0), m = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
    return ((ip & m) >>> 0).toString(16) + "/" + b;
  }).sort();
  return createHmac("sha256", "unichat-net-fp").update(subnets.join(",")).digest("hex").slice(0, 12);
}
/** Private-network IPv4 (RFC1918 / link-local): what the "local network" listener scope allows. Used to filter connections when the listener is bound to the wildcard address. */
export const isLanAddress = (ip: string) => RFC1918(ip.replace(/^::ffff:/, ""));

/** Order candidates: addresses that worked recently first, then manual ones, then learned, then mDNS; ones that failed lately sink. */
export function orderAddrs(d: Dev, now = Date.now()): Addr[] {
  const t = (s?: string) => (s ? Date.parse(s) || 0 : 0), rank = (a: Addr) => (a.src === "manual" ? 2 : a.src === "pairing" ? 1 : a.src === "learned" ? 1 : 0);
  const score = (a: Addr) => (t(a.good) ? 1e12 + t(a.good) : 0) + rank(a) * 1e9 - (a.bad && now - t(a.bad) < 60_000 ? 5e11 : 0) - (a.fails ?? 0) * 1e6;
  const lan = (a: Addr) => (a.kind === "tcp" ? 0 : a.kind === "dht" ? 1 : 2); // tcp (LAN / saved) first, then the DHT, the self-hosted relay last: the DHT only matters when the cheaper ways failed
  return [...(d.addrs ?? [])].sort((x, y) => lan(x) - lan(y) || score(y) - score(x));
}
export function markAddr(d: Dev, a: Addr, ok: boolean) {
  const x = d.addrs?.find((y) => addrKey(y) === addrKey(a)); if (!x) return;
  if (ok) { x.good = new Date().toISOString(); x.fails = 0; delete x.bad; } else { x.bad = new Date().toISOString(); x.fails = Math.min(20, (x.fails ?? 0) + 1); }
}
/** Backoff for a device with several addresses: exponential on the number of whole rounds that failed. */
export const roundBackoff = (n: number) => Math.min(5000 * 2 ** Math.min(n, 5), 120_000);

export function tcpConnect(host: string, port: number, timeout: number, signal?: AbortSignal): Promise<Socket> {
  return new Promise((ok, fail) => {
    const s = createConnection({ host, port }); s.setNoDelay(true);
    const t = setTimeout(() => { s.destroy(); fail(new Error("connection timed out")); }, timeout);
    const abort = () => { clearTimeout(t); s.destroy(); fail(new Error("aborted")); };
    signal?.addEventListener("abort", abort, { once: true });
    s.once("connect", () => { clearTimeout(t); signal?.removeEventListener("abort", abort); ok(s); }); s.once("error", (e) => { clearTimeout(t); signal?.removeEventListener("abort", abort); fail(e); });
  });
}
export type Opener = (a: Addr, signal: AbortSignal) => Promise<Socket>;
/**
 * Happy eyeballs: start the best candidate at once and the next ones `stagger` ms apart (the DHT only after `dhtDelay`, relays after `relayDelay`: a connect that wins earlier means the later ones never start), first established
 * connection wins and the rest are cancelled. Resolves with the socket and the address that worked; rejects when every candidate failed.
 */
export async function raceConnect(cands: Addr[], open: Opener, o: { stagger?: number; relayDelay?: number; dhtDelay?: number } = {}): Promise<{ sock: Socket; addr: Addr; failed: Addr[] }> {
  if (!cands.length) throw new Error("no address known for this device");
  const stagger = o.stagger ?? 250, relayDelay = o.relayDelay ?? 1500, dhtDelay = o.dhtDelay ?? 1200, ctl = new AbortController(), failed: Addr[] = [];
  return new Promise((ok, fail) => {
    let pending = cands.length, done = false; const timers: ReturnType<typeof setTimeout>[] = [];
    const errs: string[] = [];
    cands.forEach((a, i) => {
      const delay = a.kind === "relay" ? Math.max(relayDelay, i * stagger) : a.kind === "dht" ? Math.max(dhtDelay, i * stagger) : i * stagger;
      timers.push(setTimeout(() => {
        if (done) return;
        const local = new AbortController(); ctl.signal.addEventListener("abort", () => local.abort(), { once: true });
        open(a, local.signal).then((sock) => {
          if (done) { sock.destroy(); return; }
          done = true; ctl.abort(); timers.forEach(clearTimeout); ok({ sock, addr: a, failed });
        }, (e) => {
          if (done) return; failed.push(a); errs.push(String(e?.message ?? e));
          if (--pending <= 0) { done = true; fail(new Error(errs[0] ?? "no address worked")); }
        });
      }, delay));
    });
  });
}

/** Rendezvous id of a pair of devices for a relay: HMAC(group key, sorted ids). Only members know the key, so only members can name the room. */
export const rendezvousId = (groupKeyB64: string, a: string, b: string) =>
  createHmac("sha256", Buffer.from(groupKeyB64, "base64")).update("unichat-relay-rendezvous-v1").update([a, b].sort().join("|")).digest("hex");

/** Plain connect (injectable in tests: see SyncOptions.net). */
export type Connector = (host: string, port: number, timeoutMs: number, signal?: AbortSignal) => Promise<Socket>;
