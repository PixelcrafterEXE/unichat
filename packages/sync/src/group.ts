// Device identity and group membership (persisted sealed in the ledger's kv).
import { createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { deviceIdOf, generateKeyPair } from "./noise.js";

export interface Identity { id: string; name: string; pub: string; priv: string }
/**
 * One way to reach a peer. `dht`: no host/port, the target is derived (the peer's HyperDHT public key, `Dev.dht`, see dht.ts). `tcp`: host (IPv4/IPv6 literal or DNS name, e.g. a DDNS name) + port. `relay`: base URL of a user-chosen relay (ws:// or wss://, see apps/server relay.ts);
 * the rendezvous id is derived from the group key and both device ids, never stored. src: where we learned it (the peer itself on every session, mDNS, the pairing, or typed in by the user).
 */
export interface Addr { kind: "tcp" | "relay" | "dht"; host?: string; port?: number; url?: string; src: "pairing" | "learned" | "mdns" | "manual"; good?: string; bad?: string; fails?: number; /** fingerprint of the network the owner announced this address from (service.ts netFingerprint) */ net?: string }
export interface Dev { id: string; name: string; pub: string; addedAt: string; revoked?: string; /** device id that removed it (tombstone, merged with `revoked`) */ revokedBy?: string; /** when the removed device confirmed that it unlinked itself (tombstone, merged) */ removedAck?: string; addrs?: Addr[]; lastSeen?: string; /** HyperDHT public key (hex) of this device for this group, announced by the device itself (dht.ts); only meaningful when "Reach my devices from anywhere" is on */ dht?: string; /** phase-1 single address, migrated into addrs on load */ addr?: { host: string; port: number } }
export interface KeyEntry { tag: string; key: string; revoked: string[] }
export interface Group { id: string; devices: Record<string, Dev>; keys: KeyEntry[] }

export const keyTag = (key: Buffer) => createHash("sha256").update("unichat-sync-key-tag").update(key).digest("hex").slice(0, 16);
export function newIdentity(name: string): Identity {
  const kp = generateKeyPair();
  return { id: deviceIdOf(kp.pub), name, pub: kp.pub.toString("base64"), priv: kp.priv.toString("base64") };
}
export function newGroup(me: Identity): Group {
  const key = randomBytes(32);
  return { id: randomBytes(8).toString("hex"), devices: { [me.id]: { id: me.id, name: me.name, pub: me.pub, addedAt: new Date().toISOString() } }, keys: [{ tag: keyTag(key), key: key.toString("base64"), revoked: [] }] };
}
/** PSK for a normal sync session: HKDF over the group key (domain-separated from everything else). */
export const syncPsk = (key: string): Buffer => Buffer.from(hkdfSync("sha256", Buffer.from(key, "base64"), Buffer.alloc(0), "unichat-sync-session-psk-v1", 32));
/** Rotating, non-secret label announced over mDNS so group members find each other; derived from the current key, so it changes on revoke. */
export const groupTag = (key: string) => createHmac("sha256", Buffer.from(key, "base64")).update("unichat-sync-mdns-tag").digest("hex").slice(0, 8);
/** The current key = the one that excludes the most revoked devices (revocation sets only grow). */
export function currentKey(g: Group): KeyEntry { return [...g.keys].sort((a, b) => b.revoked.length - a.revoked.length || (a.tag < b.tag ? 1 : -1))[0]; }
export const revokedIds = (g: Group) => Object.values(g.devices).filter((d) => d.revoked).map((d) => d.id).sort();
const MAX_KEYS = 8;
export function addKey(g: Group, k: KeyEntry): boolean {
  if (g.keys.some((x) => x.tag === k.tag)) return false;
  g.keys.push(k);
  if (g.keys.length > MAX_KEYS) { const cur = currentKey(g); g.keys = [cur, ...g.keys.filter((x) => x !== cur).slice(-(MAX_KEYS - 1))]; }
  return true;
}
/** Revoke a device: it is marked, and a FRESH random key is generated that excludes it (old keys stay only so lagging members can still connect and be upgraded). */
export function revoke(g: Group, id: string, by?: string): KeyEntry {
  const d = g.devices[id]; if (!d) throw new Error("unknown device");
  d.revoked ??= new Date().toISOString(); if (by && !d.revokedBy) d.revokedBy = by;
  return rekey(g);
}
export function rekey(g: Group): KeyEntry {
  const key = randomBytes(32), k = { tag: keyTag(key), key: key.toString("base64"), revoked: revokedIds(g) };
  addKey(g, k); return k;
}
/** Merge what a (trusted, authenticated) member knows. Returns what changed. */
export function mergeMembership(g: Group, devices: Record<string, Dev>, keys: KeyEntry[], me: string): { added: string[]; revoked: string[]; keysAdded: number } {
  const added: string[] = [], revoked: string[] = [];
  for (const d of Object.values(devices ?? {})) {
    if (!d || typeof d.id !== "string" || typeof d.pub !== "string" || deviceIdOf(Buffer.from(d.pub, "base64")) !== d.id) continue; // an id must be the hash of its key
    const l = g.devices[d.id];
    const hints = cleanAddrs(d.addrs).filter((a) => a.src !== "manual").map((a) => ({ ...a, src: "learned" as const, good: undefined, bad: undefined, fails: undefined }));
    const dht = validDhtKey(d.dht);
    if (l && dht && !l.dht) l.dht = dht; // only fills a gap: the device's own report (session, see service.ts) replaces it
    if (l && !l.addrs?.length && hints.length) l.addrs = hints.slice(0, 4); // address hints from a member; only fill gaps, the peer's own report and our observations win
    if (!l) { g.devices[d.id] = { id: d.id, name: String(d.name ?? "device").slice(0, 60), pub: d.pub, addedAt: String(d.addedAt ?? new Date().toISOString()), ...(d.revoked ? { revoked: String(d.revoked), ...(typeof d.revokedBy === "string" ? { revokedBy: d.revokedBy.slice(0, 64) } : {}) } : {}),...(dht ? { dht } : {}), ...(hints.length ? { addrs: hints.slice(0, 4) } : {}) }; added.push(d.id); if (d.revoked) revoked.push(d.id); }
    else if (d.revoked && !l.revoked) { l.revoked = String(d.revoked); revoked.push(d.id); }
    if (l && l.revoked) { // tombstone details only ever fill gaps
      if (!l.revokedBy && typeof d.revokedBy === "string") l.revokedBy = d.revokedBy.slice(0, 64);
      if (!l.removedAck && typeof d.removedAck === "string") l.removedAck = d.removedAck.slice(0, 40);
    }
  }
  let keysAdded = 0;
  for (const k of keys ?? []) {
    if (!k || typeof k.key !== "string" || !Array.isArray(k.revoked) || Buffer.from(k.key, "base64").length !== 32) continue;
    if (k.revoked.includes(me)) continue; // never keep a key from an epoch that excluded us (we would be a revoked device)
    const e = { tag: keyTag(Buffer.from(k.key, "base64")), key: k.key, revoked: k.revoked.map(String) };
    if (addKey(g, e)) keysAdded++;
  }
  return { added, revoked, keysAdded };
}
/** True when the current key does not yet exclude every revoked device (concurrent revocations by two members). */
export const needsRekey = (g: Group) => { const c = new Set(currentKey(g).revoked); return revokedIds(g).some((i) => !c.has(i)); };

const HOST_RE = /^[A-Za-z0-9_.:\-%\[\]]{1,255}$/;
/** Validate address records that came from the network or from the UI (never trust shape or size). */
export function cleanAddrs(x: unknown, max = 16): Addr[] {
  const out: Addr[] = [];
  for (const a of Array.isArray(x) ? x : []) {
    if (!a || typeof a !== "object") continue;
    const src = ["pairing", "learned", "mdns", "manual"].includes(a.src) ? a.src : "learned";
    if (a.kind === "dht") out.push({ kind: "dht", src, ...(typeof a.good === "string" ? { good: a.good } : {}), ...(typeof a.bad === "string" ? { bad: a.bad } : {}), ...(Number.isInteger(a.fails) ? { fails: a.fails } : {}) });
    else if (a.kind === "relay") { if (typeof a.url === "string" && /^wss?:\/\/[^\s]{1,300}$/.test(a.url)) out.push({ kind: "relay", url: a.url.replace(/\/+$/, ""), src }); }
    else if (typeof a.host === "string" && HOST_RE.test(a.host) && Number.isInteger(a.port) && a.port > 0 && a.port < 65536) out.push({ kind: "tcp", host: a.host.replace(/^\[|\]$/g, "").replace(/^::ffff:/, ""), port: a.port, src, ...(typeof a.good === "string" ? { good: a.good } : {}), ...(typeof a.bad === "string" ? { bad: a.bad } : {}), ...(Number.isInteger(a.fails) ? { fails: a.fails } : {}), ...(typeof a.net === "string" && /^[0-9a-f]{4,32}$/.test(a.net) ? { net: a.net } : {}) });
    if (out.length >= max) break;
  }
  return out;
}
export const addrKey = (a: Addr) => (a.kind === "relay" ? "relay:" + a.url : a.kind === "dht" ? "dht" : `tcp:${a.host}:${a.port}`);
/** A HyperDHT public key as lower-case hex (32 bytes), or undefined. */
export const validDhtKey = (x: unknown): string | undefined => (typeof x === "string" && /^[0-9a-f]{64}$/i.test(x) ? x.toLowerCase() : undefined);
/** Add or refresh an address on a device (dedupe by host:port / url; a manual entry is never downgraded; at most 12 per device, oldest learned ones go first). */
export function noteAddr(d: Dev, a: Addr, replaceSrc?: Addr["src"]): void {
  const list = (d.addrs ??= []), k = addrKey(a), i = list.findIndex((x) => addrKey(x) === k);
  if (i >= 0) { if (list[i].src !== "manual") list[i].src = a.src; return; }
  list.push(a);
  if (replaceSrc) for (let j = list.length - 2; j >= 0 && list.filter((x) => x.src === replaceSrc && x.kind === a.kind).length > 6; j--) if (list[j].src === replaceSrc && list[j].kind === a.kind) list.splice(j, 1);
  while (list.length > 12) { const j = list.findIndex((x) => x.src !== "manual"); list.splice(j < 0 ? 0 : j, 1); }
}
/** Phase-1 state kept one `addr`; keep the group file readable by moving it into the list. */
export function migrateGroup(g: Group): Group {
  for (const d of Object.values(g.devices)) if (d.addr) { if (d.addr.host && d.addr.port) noteAddr(d, { kind: "tcp", host: d.addr.host, port: d.addr.port, src: "learned" }); delete d.addr; }
  return g;
}

/**
 * A device told us (members frame, "addrs" frame, DHT session) which tcp addresses it has RIGHT NOW. That list is authoritative for everything we learned
 * second-hand: learned / mdns / pairing addresses that are not in it are dropped (they belong to a network the device left, e.g. the old home Wi-Fi),
 * unless one worked within the last minute. Manual addresses are the user's and stay. An empty announcement changes nothing (a device that cannot list its
 * interfaces must not make us forget everything). Returns true when the address list changed.
 */
export function applyAnnounced(d: Dev, announced: Addr[], now = Date.now()): boolean {
  const ann = announced.filter((a) => a.kind === "tcp"); if (!ann.length) return false;
  const keys = new Set(ann.map(addrKey)); let changed = false;
  const before = (d.addrs ?? []).length;
  d.addrs = (d.addrs ?? []).filter((x) => x.kind !== "tcp" || x.src === "manual" || keys.has(addrKey(x)) || (x.good && now - (Date.parse(x.good) || 0) < 60_000));
  if (d.addrs.length !== before) changed = true;
  for (const a of ann) {
    const x = d.addrs.find((y) => addrKey(y) === addrKey(a));
    if (x) { if (a.net && x.net !== a.net) { x.net = a.net; changed = true; } if (x.src !== "manual") x.src = "learned"; delete x.bad; x.fails = 0; continue; }
    noteAddr(d, { ...a, src: "learned", good: undefined, bad: undefined, fails: undefined }, "learned"); changed = true;
  }
  return changed;
}
