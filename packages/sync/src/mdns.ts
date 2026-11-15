// A tiny multicast-DNS announcer/browser for the service `_unichat-sync._tcp.local` (RFC 6762/6763 subset) on node:dgram.
// It announces: PTR (service -> instance), SRV (port, host), TXT (key=value pairs) and A records, and browses by multicast queries.
// The TXT record never carries secrets: pairing mode advertises {v, m: "pair", n: device name}; a group member advertises
// {m: "sync", g: group tag (rotates with the group key), d: device id prefix}. Unicast replies / known-answer suppression are not implemented.
import { createSocket, type Socket } from "node:dgram";
import { interfaces } from "./addrs.js";

export const SERVICE = "_unichat-sync._tcp.local";
const MDNS_ADDR = "224.0.0.251", MDNS_PORT = 5353;
export interface Service { instance: string; host: string; port: number; txt: Record<string, string>; addrs: string[]; seen: number }

// ---- DNS wire codec ----
const T = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;
function nameBuf(n: string): Buffer {
  const parts: Buffer[] = [];
  for (const l of n.split(".").filter(Boolean)) { const b = Buffer.from(l, "utf8"); if (b.length > 63) throw new Error("dns label too long"); parts.push(Buffer.from([b.length]), b); }
  parts.push(Buffer.from([0])); return Buffer.concat(parts);
}
function rr(name: string, type: number, ttl: number, data: Buffer, flush = false): Buffer {
  const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE((flush ? 0x8000 : 0) | 1, 2); h.writeUInt32BE(ttl, 4); h.writeUInt16BE(data.length, 8);
  return Buffer.concat([nameBuf(name), h, data]);
}
export interface Rec { name: string; type: number; ttl: number; data: any }
export function encodeResponse(recs: { name: string; type: "PTR" | "SRV" | "TXT" | "A"; ttl: number; data: any }[]): Buffer {
  const h = Buffer.alloc(12); h.writeUInt16BE(0x8400, 2); h.writeUInt16BE(recs.length, 6);
  const out = recs.map((r) => {
    switch (r.type) {
      case "PTR": return rr(r.name, T.PTR, r.ttl, nameBuf(r.data));
      case "SRV": { const d = Buffer.alloc(6); d.writeUInt16BE(0, 0); d.writeUInt16BE(0, 2); d.writeUInt16BE(r.data.port, 4); return rr(r.name, T.SRV, r.ttl, Buffer.concat([d, nameBuf(r.data.target)]), true); }
      case "TXT": { const kv = Object.entries(r.data as Record<string, string>).map(([k, v]) => Buffer.from(`${k}=${v}`)).filter((b) => b.length < 256); return rr(r.name, T.TXT, r.ttl, Buffer.concat(kv.length ? kv.flatMap((b) => [Buffer.from([b.length]), b]) : [Buffer.from([0])]), true); }
      case "A": return rr(r.name, T.A, r.ttl, Buffer.from((r.data as string).split(".").map(Number)), true);
    }
  });
  return Buffer.concat([h, ...out]);
}
export function encodeQuery(name: string, type: "PTR" = "PTR"): Buffer {
  const h = Buffer.alloc(12); h.writeUInt16BE(1, 4); const q = Buffer.alloc(4); q.writeUInt16BE(T[type], 0); q.writeUInt16BE(1, 2);
  return Buffer.concat([h, nameBuf(name), q]);
}
function readName(b: Buffer, off: number): [string, number] {
  const labels: string[] = []; let p = off, end = -1, hops = 0;
  for (;;) {
    if (p >= b.length) throw new Error("dns: truncated name");
    const l = b[p];
    if (l === 0) { p++; break; }
    if ((l & 0xc0) === 0xc0) { if (++hops > 16) throw new Error("dns: compression loop"); if (end < 0) end = p + 2; p = ((l & 0x3f) << 8) | b[p + 1]; continue; }
    if (p + 1 + l > b.length) throw new Error("dns: truncated label");
    labels.push(b.subarray(p + 1, p + 1 + l).toString("utf8")); p += 1 + l;
  }
  return [labels.join("."), end < 0 ? p : end];
}
/** Parse a packet: questions + all answer/authority/additional records (data decoded for PTR/SRV/TXT/A, others skipped). Never throws on junk: returns what it understood. */
export function decode(b: Buffer): { response: boolean; questions: { name: string; type: number }[]; records: Rec[] } {
  const out = { response: false, questions: [] as { name: string; type: number }[], records: [] as Rec[] };
  try {
    if (b.length < 12) return out;
    out.response = (b.readUInt16BE(2) & 0x8000) !== 0;
    const qd = b.readUInt16BE(4), n = b.readUInt16BE(6) + b.readUInt16BE(8) + b.readUInt16BE(10); let p = 12;
    for (let i = 0; i < qd; i++) { const [name, q] = readName(b, p); out.questions.push({ name, type: b.readUInt16BE(q) }); p = q + 4; }
    for (let i = 0; i < Math.min(n, 64); i++) {
      const [name, q] = readName(b, p); const type = b.readUInt16BE(q), ttl = b.readUInt32BE(q + 4), len = b.readUInt16BE(q + 8), d = q + 10;
      if (d + len > b.length) break;
      let data: any;
      if (type === T.PTR) data = readName(b, d)[0];
      else if (type === T.SRV) data = { port: b.readUInt16BE(d + 4), target: readName(b, d + 6)[0] };
      else if (type === T.A && len === 4) data = [...b.subarray(d, d + 4)].join(".");
      else if (type === T.TXT) { data = {}; for (let o = d; o < d + len;) { const l = b[o]; const s = b.subarray(o + 1, o + 1 + l).toString("utf8"); const i = s.indexOf("="); if (i > 0) data[s.slice(0, i)] = s.slice(i + 1); o += 1 + l; } }
      if (data !== undefined) out.records.push({ name, type, ttl, data });
      p = d + len;
    }
  } catch { /* junk from the network: ignore */ }
  return out;
}
/** Fold records of a response into the service table (pure; used by the browser and by tests). */
export function collect(table: Map<string, Service>, recs: Rec[], now = Date.now()) {
  const inst = (n: string) => n.endsWith("." + SERVICE) ? n : undefined;
  const aRec = new Map<string, string[]>(); for (const r of recs) if (r.type === T.A) aRec.set(r.name, [...(aRec.get(r.name) ?? []), r.data]);
  for (const r of recs) {
    if (r.type === T.PTR && r.name === SERVICE && inst(r.data)) { if (r.ttl === 0) table.delete(r.data); else if (!table.has(r.data)) table.set(r.data, { instance: r.data, host: "", port: 0, txt: {}, addrs: [], seen: now }); }
  }
  for (const r of recs) {
    const s = table.get(r.name); if (!s) continue;
    if (r.type === T.SRV) { s.port = r.data.port; s.host = r.data.target; s.seen = now; }
    if (r.type === T.TXT) s.txt = r.data;
  }
  for (const s of table.values()) if (s.host && aRec.has(s.host)) s.addrs = aRec.get(s.host)!;
}

export function lanAddresses(): string[] {
  return interfaces().filter((i) => i.family === 4 && !i.internal).map((i) => i.address); // never throws (see interfaces())
}

export interface MdnsOptions {
  /** UDP port (5353; tests use another one so they never talk to a real mDNS daemon) */ port?: number;
  /** multicast group (224.0.0.251) */ group?: string;
  /** interface addresses to join the group on and announce from (default: every non-internal IPv4 address; falls back to loopback only when there is none) */ ifaces?: string[];
  /** address to bind (default 0.0.0.0, the usual for mDNS; tests bind the group address so no unicast listener exists) */ bind?: string;
}
/**
 * Multicast DNS announcer / browser. Correct multicast needs three things: SO_REUSEADDR (several mDNS stacks share port 5353: avahi, systemd-resolved, us),
 * an explicit IP_ADD_MEMBERSHIP on EACH interface (the default interface is often the wrong one: VPNs, Docker bridges), and sending on each interface
 * (IP_MULTICAST_IF) so the answer leaves the interface the record's address belongs to. IPv6 (ff02::fb) is not implemented: pairing falls back to typing
 * the address / QR code, which also covers networks that block multicast and Android without a MulticastLock (see apps/android/README.md).
 * `available` tells the UI whether discovery works at all; everything else keeps working without it.
 */
export class Mdns {
  private sock?: Socket; private timers: ReturnType<typeof setInterval>[] = []; private joined: string[] = [];
  readonly table = new Map<string, Service>();
  private ann?: { instance: string; port: number; txt: Record<string, string> };
  /** undefined until start() finished; false when no interface could join the group (no multicast capability, blocked by the OS / Android without MulticastLock) */
  available?: boolean; reason?: string;
  constructor(private o: MdnsOptions = {}) {}
  private get port() { return this.o.port ?? MDNS_PORT; } private get group() { return this.o.group ?? MDNS_ADDR; }
  async start() {
    const s = createSocket({ type: "udp4", reuseAddr: true }); this.sock = s;
    await new Promise<void>((ok, fail) => { s.once("error", fail); s.bind(this.port, this.o.bind ?? "0.0.0.0", () => { s.off("error", fail); ok(); }); });
    s.on("error", () => { /* network went away: browsing just stops */ });
    const want = this.o.ifaces ?? (lanAddresses().length ? lanAddresses() : ["127.0.0.1"]);
    try { s.setMulticastTTL(255); s.setMulticastLoopback(true); } catch { /* ignore */ }
    for (const ifc of want) { try { s.addMembership(this.group, ifc); this.joined.push(ifc); } catch { /* this interface cannot do multicast */ } }
    this.available = this.joined.length > 0; this.reason = this.available ? undefined : "No network interface allows multicast (or the system blocks it). Type the address or scan the QR code instead.";
    s.on("message", (m) => this.onPacket(m));
    this.timers.push(setInterval(() => this.query(), 8000), setInterval(() => this.announce(), 40_000));
    this.timers.forEach((t) => t.unref?.());
    this.query();
  }
  /** The network changed (Wi-Fi reconnected, new address): multicast group memberships are per interface address and die with the old one. Join again, announce, ask. */
  refresh() {
    const s = this.sock; if (!s) return;
    for (const ifc of this.joined) { try { s.dropMembership(this.group, ifc); } catch { /* the address is gone already */ } }
    this.joined = [];
    const want = this.o.ifaces ?? (lanAddresses().length ? lanAddresses() : ["127.0.0.1"]);
    for (const ifc of want) { try { s.addMembership(this.group, ifc); this.joined.push(ifc); } catch { /* this interface cannot do multicast */ } }
    this.available = this.joined.length > 0; this.reason = this.available ? undefined : "No network interface allows multicast (or the system blocks it). Type the address or scan the QR code instead.";
    this.announce(); this.query();
  }
  private send(b: Buffer) {
    const s = this.sock; if (!s) return;
    for (const ifc of this.joined.length ? this.joined : [undefined]) { try { if (ifc) s.setMulticastInterface(ifc); s.send(b, this.port, this.group, () => {}); } catch { /* ignore */ } }
  }
  query() { this.send(encodeQuery(SERVICE)); }
  /** Start (or update) announcing this device. */
  advertise(a: { instance: string; port: number; txt: Record<string, string> }) { this.ann = a; this.announce(); }
  unadvertise() { if (this.ann) this.send(this.records(0)); this.ann = undefined; }
  private records(ttl: number) {
    const a = this.ann!, full = `${a.instance}.${SERVICE}`, host = `${a.instance}.local`;
    return encodeResponse([{ name: SERVICE, type: "PTR", ttl, data: full }, { name: full, type: "SRV", ttl, data: { port: a.port, target: host } }, { name: full, type: "TXT", ttl, data: a.txt },
      ...(this.o.ifaces ?? lanAddresses()).map((ip) => ({ name: host, type: "A" as const, ttl, data: ip }))]);
  }
  private announce() { if (this.ann) this.send(this.records(120)); }
  private onPacket(m: Buffer) {
    const d = decode(m);
    if (!d.response && this.ann && d.questions.some((q) => q.name === SERVICE)) this.announce();
    if (d.records.length) { collect(this.table, d.records); const now = Date.now(); for (const [k, s] of this.table) if (now - s.seen > 300_000) this.table.delete(k); }
  }
  services(): Service[] { return [...this.table.values()].filter((s) => s.port && (s.addrs.length || s.host)); }
  stop() { this.unadvertise(); this.timers.forEach(clearInterval); this.timers = []; try { this.sock?.close(); } catch { /* closed */ } this.sock = undefined; }
}
