// SyncService: pairing, device group, sessions and replication. Everything runs inside the Hub's process; the Hub only routes `sync*` RPCs here.
// Protocol summary (see "Device sync" in https://github.com/PixelcrafterEXE/unichat/wiki/Architecture):
//   transport  TCP (or a WebSocket through an optional relay) -> prologue -> Noise_XXpsk0 (psk = scrypt(pairing code) for pairing, HKDF(group key) for sync)
//              -> JSON messages in AEAD frames. Pairing additionally needs BOTH users to confirm a 6-digit code derived from the handshake.
//   session    members{devices,keys,ledger,port,addrs} <-> members; have{of,cursor,empty} (= ack + resume point); batch{entries,upTo}; keys{...}; ping; bye
//              snap-offer/go/chunk/end/ack  initial transfer (encrypted container, resumable)
//              rpc/rpc-res, big            request/response + chunked large messages: media blobs, big credential sessions, proxied accounts
//              ev/offers/sub               home-device proxy events and offers
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { createServer, type Server, type Socket } from "node:net";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { sessionFiles, type CoreEvent, type SyncHostApi } from "@unimsg/core";
import { accept, ChannelError, dial, type Secure } from "./channel.js";
import { isValidCode, newPairingCode, normalizeCode, pairingPsk, sasOf } from "./code.js";
import { accountOfKey, key as ekey, parseKey } from "./crdt.js";
import { addrKey, cleanAddrs, currentKey, groupTag, mergeMembership, migrateGroup, applyAnnounced, needsRekey, newGroup, newIdentity, noteAddr, rekey, revoke, syncPsk, validDhtKey, type Addr, type Dev, type Group, type Identity } from "./group.js";
import { advertisable, netFingerprint, bindsFor, DEFAULT_LISTEN, interfaces, isLanAddress, lanBindAddresses, setInterfaceOverride, markAddr, orderAddrs, raceConnect, rendezvousId, roundBackoff, tcpConnect, type Connector, type Iface, type ListenSetting } from "./addrs.js";
import { dialAny, DialFailure, listenPorts, probeHosts, SYNC_PORT, SYNC_PORT_SPAN, wellKnownPorts, type Cand } from "./discover.js";
import { BIG_MAX_DEFAULT, BigAssembler, sendBig } from "./bulk.js";
import { Avatars } from "./avatars.js";
import { Blobs, cleanPolicy, DEFAULT_POLICY, HARD_MAX, acctOfChat, refOf, type MediaPolicy } from "./blobs.js";
import { Clock } from "./hlc.js";
import { Ledger } from "./ledger.js";
import { lanAddresses, Mdns, SERVICE } from "./mdns.js";
import { deviceIdOf, sameKey } from "./noise.js";
import { NEARBY_PSK, nearbyHost, nearbyJoin } from "./nearby.js";
import { Proxies } from "./proxy.js";
import { MoveService, type MoveOptions } from "./move.js";
import { openRelay } from "./relayclient.js";
import { cleanDhtSetting, DEFAULT_DHT, dhtSeed, pairingDhtSeed, loadHyperdht, DhtTransport, DhtUnavailable, type DhtOpts, type DhtSetting, type DhtState } from "./dht.js";
import { applySnapshot, buildSnapshot, sha256File, snapshotPassphrase } from "./snapshot.js";
import type { SyncCtx, SyncMode, SyncStore, WireEntry } from "./syncstore.js";
import { createCipheriv, createDecipheriv } from "node:crypto";

/**
 * Providers whose session is a bearer-token style secret that can safely be used from several devices at once ("credentials" mode).
 * Signal and WhatsApp are linked-device protocols with ratcheting keys (a copied session breaks both copies): they use the home-device proxy instead.
 * Matrix has per-device E2EE keys, Instagram never auto-shares.
 */
export const CREDENTIAL_PROVIDERS = new Set(["mattermost", "discord", "teams"]);
export type SyncHost = SyncHostApi;
export interface SyncOptions {
  deviceName?: string;
  /** Android: with the "local network" scope bind the wildcard address once (so a Wi-Fi change can never leave the port unbound) and refuse connections that did not arrive on a private address. */
  wildcardLan?: boolean;
  /** TESTS ONLY: bind exactly this address instead of following the user's listener setting. */
  bindHost?: string; port?: number;
  mdns?: boolean | Mdns;
  pairingTtlMs?: number;
  /** wrong-code tries per source address before it is locked out (default 3), and over all sources before pairing closes (default 20) */
  maxPairingFailures?: number; maxPairingGlobal?: number;
  /** every refused inbound handshake takes at least this long (default 300 ms; see channel.ts accept) so refusals cannot be told apart by timing; tests set 0 */
  failFloorMs?: number;
  /** unlinking a group of two: how long to wait for the other device to answer before the instruction is left pending (default 5 s) */
  unlinkWaitMs?: number;
  /** dial attempts for known devices every this many ms (default 10 s) */
  retryMs?: number;
  now?: () => number;
  dir?: string; dataKey?: Uint8Array;
  /** sending through another device: rate limit of writes per paired device (default 30 per 10 s); tests lower it */
  relay?: { max: number; ms: number };
  /** repeated relayed writes: how long / how many results a holder keeps per device (default 10 min, 500); tests shrink it */
  idem?: { ttlMs: number; max: number };
  /** snapshot tuning and test hooks */
  snapshot?: { minEntities?: number; minEntitiesEmpty?: number; piece?: number; afterChunk?: (n: number, abort: () => void) => void };
  /** nearby pairing (no code): at most this many confirmation prompts per "Add a device" session (default 5); after that only the code works */
  maxNearbyPrompts?: number;
  /** pairing approval / SAS timeout (default 2 min) */
  approvalMs?: number;
  /** relay: how long to prefer direct addresses before the relay is tried (default 1500 ms) */
  relayDelayMs?: number;
  /** "Reach my devices from anywhere" (HyperDHT): how long LAN / saved addresses get before the DHT is tried (default 1200 ms), and test hooks. `requireBootstrap` makes the transport refuse to start without bootstrap nodes (tests: the public network is never touched). */
  dht?: { delayMs?: number; loader?: DhtOpts["loader"]; requireBootstrap?: boolean; maxDials?: number; connectMs?: number; startTimeoutMs?: number; upgradeMs?: number };
  /** listening port range (default 45045, 8 ports). With `bindHost` (tests) the range is only used when this is given. */
  wellKnown?: { base: number; span: number };
  /** network access for pairing discovery; tests inject fakes so nothing real is ever scanned. With `bindHost` and no `interfaces`, the LAN probe is off. */
  /** device-to-device move: timeouts and test hooks */
  move?: MoveOptions;
  net?: { interfaces?: () => Iface[]; connect?: Connector; probeConnectMs?: number; connectMs?: number; overallMs?: number; graceMs?: number; concurrency?: number };
}
const DHT_HOST = "the internet (DHT)"; const isDhtHost = (host: string) => host === DHT_HOST;
export const METHODS = new Set(["syncNetworkChanged", "syncStatus", "syncStartPairing", "syncStopPairing", "syncJoin", "syncJoinNearby", "syncBrowse", "syncConfirmJoin", "syncCancelJoin", "syncApproveJoin", "syncDevices", "syncRevoke", "syncDismissRemoved", "syncSetAccountMode", "syncPause", "syncResume", "syncNow",
  "syncLeave", "syncCredentials", "syncConfirmCredentials", "syncRenameDevice", "syncSetListen", "syncSetAddresses", "syncSetAdvertise", "syncSetRelays", "syncSetDht", "syncSetMediaPolicy", "syncSetMetered", "syncSetProxyShare", "syncUseProxy", "syncStopProxy", "syncRelaySet", "syncRelayAsk", "syncMoveStart", "syncMoveRespond", "syncMoveCancel", "syncMoveEstimate", "syncSendHistory"]);
const errmsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Size limits (mutable for tests): a shared login may be at most `credBytes` in total and `credFiles` files; bigger ones travel in pieces (bulk.ts), never inline. */
export const LIMITS = { credBytes: 64 * 1024 * 1024, credFiles: 512, inlineCred: 100_000 };
const BATCH_BYTES = 180_000, WINDOW = 2;
const RPC_INLINE = 300_000;

interface Rpc { ok(v: any): void; fail(e: Error): void; timer: ReturnType<typeof setTimeout> }
interface Session {
  peer: string; ch: Secure; initiator: string; startedAt: number; inflight: number[]; sentUpTo: number; sentG: number; inflightG: number[]; sg: number; sm: number; tot?: { g: number; m: number }; headDone: boolean; peerHave?: { of: string; cursor: number; g?: number; empty?: boolean }; peerLedger?: string;
  wake: () => void; closed: boolean; sent: number; received: number; applying: Promise<unknown>; via?: string;
  /** set while we wait for the peer's "unlinked" answer to our "unlink" */ ackWait?: () => void;
  rid: number; pending: Map<number, Rpc>; big: BigAssembler; serving: number;
  snapTried: boolean; snapWait?: { kinds: string[]; ok(v: any): void; timer: ReturnType<typeof setTimeout> }; snapGoMsg?: any; snapAckMsg?: any; snapRx?: { id: string; got: number; size: number; sha: string; cursor: number; ledger: string; tag: string; file: string; fd?: number; lastSaved: number }; skipEcho: boolean;
}
interface Pairing { psk: Buffer; code: string; expiresAt: number; failures: number; nearbyPrompts: number; keepListening: boolean; timer: ReturnType<typeof setTimeout> }
interface PendingJoin { nearby?: boolean; direction: "outgoing" | "incoming"; ch: Secure; sas: string; name: string; id: string; ip: string; since: number; hostOk?: boolean; joinerOk?: boolean; timer: ReturnType<typeof setTimeout>; settle: () => void }
interface Joining { nearby?: boolean; state: "confirm" | "waiting"; sas: string; hostName: string; ch: Secure; host: string; port: number; pin?: Buffer; direction: "outgoing" | "incoming"; timer: ReturnType<typeof setTimeout> }
type Progress = { state: "offline" | "connecting" | "syncing" | "idle" | "error"; sent: number; received: number; pending: number; lastSync?: string; error?: string; accts?: { done: number; total: number }; chats?: { done: number; total: number }; out?: { accts: { done: number; total: number }; chats: { done: number; total: number } }; phase?: "snapshot"; snapDone?: number; snapTotal?: number; snapDir?: "in" | "out" };
interface SrcState { n: number; until: number; strikes: number; last: number; conns: number[]; open: number }

export class SyncService {
  private ledger: Ledger; private clock!: Clock; private me!: Identity; private group?: Group;
  private servers = new Map<string, Server>(); private port = 0; private mdns?: Mdns; private ownMdns = false;
  private sessions = new Map<string, Session>(); private progress = new Map<string, Progress>();
  private pairing?: Pairing; private pendingJoin?: PendingJoin; private joining?: Joining; private joinResult?: { state: "done" | "failed"; error?: string; reason?: "unreachable" | "code" | "other" }; private joinBusy = false;
  private paused = false; private selfRevoked = false; private timers: ReturnType<typeof setInterval>[] = [];
  private dialing = new Set<string>(); private backoff = new Map<string, { until: number; n: number }>(); private src = new Map<string, SrcState>(); private unauth = 0;
  private wakeT?: ReturnType<typeof setTimeout>; private reloadT?: ReturnType<typeof setTimeout>; private lastReload = 0; private chatsDirty = new Set<string>();
  private modes: Record<string, SyncMode> = {}; private lastCreds = new Map<string, string>(); private credsErr: Record<string, string> = {}; private pulling = new Set<string>(); private staged = new Map<string, any[]>();
  private listen: ListenSetting = { ...DEFAULT_LISTEN }; private relays: string[] = []; private advertiseExtra: Addr[] = []; private listenErr = "";
  private dhtSet: DhtSetting = { ...DEFAULT_DHT }; private dht?: DhtTransport; private dhtKey = ""; private dhtInfo: { state: DhtState; reason?: string } = { state: "off" }; private dhtBusy: Promise<void> = Promise.resolve(); private dhtRetry = { n: 0, until: 0 }; private ifSig = ""; private upgradeAt = new Map<string, number>();
  private parkers = new Map<string, AbortController>(); private bindBusy: Promise<void> = Promise.resolve();
  private policy: MediaPolicy = { ...DEFAULT_POLICY }; private metered = false; private blobs?: Blobs; /** profile pictures (avatars.ts) */ avatars?: Avatars; private mediaActive: any = null; private pumping = false;
  private proxies!: Proxies; private moves!: MoveService; private sealKey!: Buffer;
  private progT = 0; private disposed = false;
  /** we are leaving a group of two: the other device is told to unlink first; until it is (offline), this stays and is delivered on its next session */
  private unlinkPending?: { peer: string; name: string; since: string; reason: "leave" | "remove" };
  /** shown once on a device that was removed from / unlinked out of its group */
  private removedNotice?: { by: string; at: string; reason: "removed" | "unlinked" | "alone" }; private leaving = false;
  readonly ready: Promise<void>; private isReady = false;
  constructor(private host: SyncHost, private store: SyncStore, ledger: Ledger, private o: SyncOptions = {}) {
    this.ledger = ledger; this.ready = this.init(); this.ready.then(() => { this.isReady = true; }, () => { this.isReady = true; });
  }
  handles(m: string) { return METHODS.has(m); }
  private now() { return (this.o.now ?? Date.now)(); }
  /** members of our group that are not removed (0 = no group, 1 = only this device). Announced in the pairing hello so both sides agree who holds the group. */
  private liveCount() { return Object.values(this.group?.devices ?? {}).filter((d) => !d.revoked).length; }
  private helloMsg() { return { id: this.me.id, name: this.me.name, port: this.listeningPort(), v: 1, grp: this.liveCount() }; }

  // ============================================================ setup
  private async init() {
    const L = this.ledger;
    this.me = L.kvGet<Identity>("identity") ?? (() => { const i = newIdentity(this.o.deviceName ?? hostname()); L.kvSet("identity", i); return i; })();
    // A stored identity whose id is not the hash of its own key can never pair: every peer checks exactly that and hangs up
    // with "device id does not match its key", while this device is told the code was refused and nobody logs anything here.
    // It cannot be repaired, only replaced -- which is harmless as long as this device is not in a group yet.
    if (this.me.id !== deviceIdOf(Buffer.from(this.me.pub, "base64"))) {
      const broken = this.me.id;
      if (L.kvGet("group")) console.error(`[sync] the stored identity ${broken} does not match its key, but this device is in a sync group: leave the group here and set it up again.`);
      else { this.me = newIdentity(this.me.name); L.kvSet("identity", this.me); console.warn(`[sync] the stored identity ${broken} did not match its key (nothing could ever pair with it); a new one was made: ${this.me.id}`); }
    }
    if (this.o.deviceName && this.me.name === "localhost") { this.me.name = this.o.deviceName; L.kvSet("identity", this.me); } // Android used to default to the hostname "localhost"
    this.clock = new Clock(this.me.id, () => this.now()); this.clock.restore(L.kvGet("clock"));
    this.modes = L.kvGet<Record<string, SyncMode>>("modes") ?? {};
    this.paused = !!L.kvGet("paused"); this.group = L.kvGet<Group>("group"); if (this.group) migrateGroup(this.group);
    this.listen = { ...DEFAULT_LISTEN, ...(L.kvGet<ListenSetting>("listen") ?? {}) }; this.relays = L.kvGet<string[]>("relays") ?? [];
    this.dhtSet = (() => { try { return cleanDhtSetting(L.kvGet("dht"), DEFAULT_DHT); } catch { return { ...DEFAULT_DHT }; } })();
    this.advertiseExtra = cleanAddrs(L.kvGet("advertise") ?? []); this.policy = cleanPolicy(L.kvGet("mediaPolicy") ?? {}); this.metered = !!L.kvGet("metered");
    this.sealKey = this.o.dataKey ? Buffer.from(this.o.dataKey) : (() => { let k = L.kvGet<string>("sealKey"); if (!k) { k = randomBytes(32).toString("base64"); L.kvSet("sealKey", k); } return Buffer.from(k, "base64"); })();
    this.proxies = new Proxies({
      host: this.host, ledger: L, ask: (p, m, a, ms) => this.rpc(p, m, a, ms), push: (peer, f) => this.pushFrame(peer, f), online: (p) => this.sessions.has(p), name: (p) => this.group?.devices[p]?.name ?? "another device",
      changed: () => this.changedDevices(), paired: (p) => !!this.group?.devices[p] && !this.group.devices[p].revoked && p !== this.me.id,
      accounts: () => this.store.listAccounts().filter((a) => this.modeOf(a.id) !== "none").map((a) => a.id), blocked: (a) => !!this.sharedFrom(a), now: () => this.now(), rate: this.o.relay, idem: this.o.idem, message: (c, i) => this.store.getMessage(c, i),
    });
    this.proxies.bindPeers(() => [...this.sessions.keys()]);
    this.avatars = new Avatars({ store: this.store, ask: (p, m, a, ms) => this.rpc(p, m, a, ms), peers: () => [...this.sessions.keys()], modeNone: (a) => this.modeOf(a) === "none",
      hasAccount: (a) => !!this.host.accountInfo(a) || this.store.listAccounts().some((x) => x.id === a), notify: (p) => this.rpc(p, "av.hint", {}, 5000).then(() => {}, () => {}), held: () => this.metered && this.policy.mode !== "all", emit: (e, d) => this.host.emit(e, d), now: () => this.now() });
    this.store.onAvatar = () => this.avatars?.noteLocal();
    this.moves = new MoveService({
      host: this.host, kv: { get: (k) => L.kvGet(k), set: (k, v) => L.kvSet(k, v) }, dir: this.o.dir, sealKey: this.sealKey, now: () => this.now(), selfName: () => this.me.name,
      send: (peer, msg) => { const s = this.sessions.get(peer); return !s || s.closed ? Promise.reject(new Error("not connected to that device")) : s.ch.send(msg); },
      online: (p) => this.sessions.has(p), paired: (p) => !!this.group?.devices[p] && !this.group.devices[p].revoked && p !== this.me.id, peerName: (p) => this.group?.devices[p]?.name ?? "another device",
      movable: (a) => !!this.host.connector(a) && !this.proxies.isProxy(a), hasActive: (a) => this.store.listAccounts().some((x) => x.id === a && x.status === "active"),
      claim: (a) => this.setOrigin(a, undefined),
      stopSync: (a) => { this.modes[a] = "none"; this.ledger.kvSet("modes", this.modes); },
      ownLogin: (a) => (!!this.host.connector(a) && !this.proxies.isProxy(a)) || this.store.listAccounts().some((x) => x.id === a && x.status === "active") || hasFiles(join(this.host.accountsDir, a)),
      detach: async (a) => { if (this.proxies.isProxy(a)) await this.proxies.stopUsing(a, true); },
      describe: (a) => { const x = this.store.listAccounts().find((y) => y.id === a); return x && { provider: x.provider, label: x.label }; },
      changed: () => this.changedDevices(), opts: this.o.move ?? {},
    });
    this.removedNotice = L.kvGet("removedNotice") ?? undefined; this.unlinkPending = L.kvGet("unlinkPending") ?? undefined;
    if (this.unlinkPending && !this.group?.devices[this.unlinkPending.peer]) { this.unlinkPending = undefined; L.kvDel("unlinkPending"); }
    this.selfRevoked = !!this.group?.devices[this.me.id]?.revoked;
    if (this.selfRevoked) { const me = this.group!.devices[this.me.id]; await this.leaveLocal({ by: this.group!.devices[me.revokedBy ?? ""]?.name ?? "another device", at: me.revoked!, reason: "removed" }); } // told while we were not running: unlink now
    if (this.group && !this.selfRevoked) await this.activate();
  }
  private persist() { if (this.group) this.ledger.kvSet("group", this.group); this.ledger.kvSet("clock", this.clock.state()); }
  private get ctx(): SyncCtx {
    return { ledger: this.ledger, clock: this.clock, device: this.me.id, changed: () => this.wakeSoon(), mode: (a) => this.modeOf(a),
      purgedBefore: () => this.ledger.kvGet<string>("purgedBefore") ?? "", setPurgedBefore: (iso) => this.ledger.kvSet("purgedBefore", iso),
      accountRemoved: (a) => { this.modes[a] = "none"; this.ledger.kvSet("modes", this.modes); this.proxies.accountGone(a); }, credentials: (a, v, h, from) => this.stageCredentials(a, v, h, from),
      isLive: (a) => this.host.isLive(a), wantMedia: (m) => this.wantMedia(m), index: (m) => this.host.indexMessage?.(m) };
  }
  modeOf(acct: string): SyncMode { return this.modes[acct] ?? "archive-only"; }
  private async activate() {
    if (this.disposed || !this.group) return;
    this.store.ctx = this.ctx;
    const pl = (stage: string, data?: Record<string, unknown>) => (globalThis as any).__unimsgPlog?.("sync." + stage, data);
    let t = Date.now(); pl("activate.begin");
    if (!this.ledger.kvGet("bootstrapped")) { const n = await this.store.bootstrap(); this.ledger.kvSet("bootstrapped", true); pl("bootstrap", { ms: Date.now() - t, entries: n }); }
    this.store.adoptSettings(); // settings that became syncable later (idempotent)
    pl("adoptSettings", { ms: Date.now() - t });
    this.blobs ??= new Blobs({ ledger: this.ledger, media: this.host.media, dir: this.o.dir ?? join(process.env.TMPDIR ?? "/tmp", "unimsg-sync-" + this.me.id.slice(0, 8)), sealKey: this.sealKey, modeNone: (a) => this.modeOf(a) === "none",
      ask: (p, m, a, ms) => this.rpc(p, m, a, ms), peers: () => [...this.sessions.keys()], progress: (p) => { this.mediaActive = p; this.setProgressSoon(); } });
    if (this.paused) return;
    this.proxies.start();
    await this.syncListeners(); await this.syncDht();
    if (!this.timers.length) {
      this.timers.push(setInterval(() => this.tick(), this.o.retryMs ?? 10_000), setInterval(() => { this.persist(); this.refreshCreds(); this.proxies.persistAudit(); this.blobs?.sweep(); }, 60_000));
      this.timers.forEach((t) => t.unref?.());
    }
    this.refreshCreds(); this.tick();
    pl("activate.done", { ms: Date.now() - t });
  }
  async hubReady() { await this.ready; if (this.group && !this.selfRevoked && !this.paused) await this.proxies.restore(); }

  // ============================================================ listener (opt-in; see docs: "Device sync > Exposure")
  private wantListen() { return !this.paused && !!this.group && !this.selfRevoked && !this.disposed && (this.listen.enabled || !!this.pairing); }
  private bindList(): string[] {
    if (this.o.bindHost) return [this.o.bindHost];
    const setting: ListenSetting = this.listen.enabled ? this.listen : { enabled: true, scope: "lan" }; // pairing alone: the local network, for as long as the code is open
    if (this.o.wildcardLan && setting.scope === "lan") { this.listenErr = ""; return ["0.0.0.0"]; } // see SyncOptions.wildcardLan; inbound sockets are filtered in acceptTcp()
    const r = bindsFor(setting, interfaces()); this.listenErr = r.error ?? r.note ?? (r.hosts.length ? "" : "No local network address found: connect to Wi-Fi or Ethernet, or choose a specific address.");
    return r.hosts;
  }
  /** Make the open sockets match what is wanted right now. Serialised: callers may fire it at any time. */
  private syncListeners(): Promise<void> {
    this.bindBusy = this.bindBusy.then(() => this.doSyncListeners()).catch(() => {});
    return this.bindBusy;
  }
  private async doSyncListeners() {
    const want = this.wantListen() ? this.bindList() : [];
    for (const [h, srv] of [...this.servers]) if (!srv.listening) { try { srv.close(); } catch { /* closed */ } this.servers.delete(h); } // a server that died (interface removed, OS closed it) is rebound below
    for (const [h, srv] of [...this.servers]) if (!want.includes(h)) { try { srv.close(); } catch { /* closed */ } this.servers.delete(h); }
    for (const h of want) if (!this.servers.has(h)) {
      const srv = createServer((s) => this.acceptTcp(s, h)); srv.on("error", () => { /* keep running */ }); srv.on("close", () => { if (this.servers.get(h) === srv) { this.servers.delete(h); void this.syncListeners(); } });
      const bind = (p: number) => new Promise<void>((ok, fail) => { srv.once("error", fail); srv.listen(p, h, () => { srv.off("error", fail); ok(); }); });
      // a fixed, well-known port (45045, then the next few) so a device that types only the code knows where to knock; random only as the last resort
      const ranged = !this.o.bindHost || !!this.o.wellKnown, wk = this.o.wellKnown ?? { base: SYNC_PORT, span: SYNC_PORT_SPAN };
      const plan = ranged ? [...new Set([this.port || undefined, ...listenPorts(this.ledger.kvGet<number>("port"), wk.base, wk.span)].filter((x): x is number => x !== undefined && (x === 0 || (x >= wk.base && x < wk.base + wk.span))))] : [this.port || this.o.port || this.ledger.kvGet<number>("port") || 0, 0];
      let bound = false, lastErr: unknown;
      for (const p of plan) { try { await bind(p); bound = true; break; } catch (e) { lastErr = e; } }
      if (!bound) { this.listenErr = `Couldn't listen on ${h}: ${errmsg(lastErr)}`; continue; }
      this.servers.set(h, srv); this.port = (srv.address() as { port: number }).port; this.ledger.kvSet("port", this.port);
    }
    if (!this.servers.size) this.port = this.port; // keep the number for the next time
    this.advertise(); this.changedDevices();
  }
  private boundHosts() { return [...this.servers.keys()]; }
  /** Addresses worth telling peers about: the bound ones, or, for the wildcard listener, every private address this device has right now. */
  private advHosts(): string[] { return this.servers.has("0.0.0.0") ? lanBindAddresses(interfaces()) : advertisable(this.boundHosts()); }
  /** wildcard listener on Android: only connections that arrived on a private address of this device are served (the "local network" exposure promise). */
  private acceptTcp(sock: Socket, boundTo: string) {
    if (boundTo === "0.0.0.0" && !isLanAddress(sock.localAddress ?? "")) { sock.destroy(); return; }
    this.onInbound(sock);
  }
  private listeningPort() { return this.servers.size ? this.port : 0; }
  private advertise() {
    if (this.o.mdns === false || this.o.mdns === undefined) return;
    const hosts = this.advHosts();
    if (!this.servers.size || !hosts.length) { this.mdns?.unadvertise(); return; } // never announce a listener that is not on the network
    if (!this.mdns) { this.mdns = this.o.mdns === true ? new Mdns() : this.o.mdns; this.ownMdns = this.o.mdns === true; if (this.ownMdns) void this.mdns.start().catch(() => { this.mdns = undefined; }); }
    if (!this.mdns) return;
    const inst = "unichat-" + this.me.id.slice(0, 10);
    if (this.pairing) this.mdns.advertise({ instance: inst, port: this.port, txt: { v: "1", m: "pair", n: this.me.name.slice(0, 40), nb: this.nearbyOpen() ? "1" : "0" } });
    else if (this.group) this.mdns.advertise({ instance: inst, port: this.port, txt: { v: "1", m: "sync", g: groupTag(currentKey(this.group).key), d: this.me.id.slice(0, 8) } });
  }
  /** Nearby pairing is offered only while "Add a device" is open and its prompt budget (default 5 attempts per session) is not used up. */
  private nearbyOpen() { const p = this.pairing; return !!p && p.expiresAt > this.now() && p.nearbyPrompts < (this.o.maxNearbyPrompts ?? 5); }
  private browseT?: ReturnType<typeof setTimeout>;
  /** The join side asks to see nearby devices: browse mDNS for a while (the UI repeats the call while its list is visible). */
  private async browse() {
    if (!this.o.mdns) return { available: false };
    if (!this.mdns) { this.mdns = this.o.mdns === true ? new Mdns() : this.o.mdns; this.ownMdns = this.o.mdns === true; if (this.ownMdns) await this.mdns.start().catch(() => { this.mdns = undefined; }); }
    else this.mdns.query();
    clearTimeout(this.browseT); this.browseT = setTimeout(() => { if (!this.servers.size && this.ownMdns) { this.mdns?.stop(); this.mdns = undefined; } }, 45_000); this.browseT.unref?.();
    return { available: this.mdns?.available ?? false };
  }
  private selfAddrs(): Addr[] {
    const hosts = this.o.bindHost ? [this.o.bindHost] : this.advHosts();
    return this.servers.size ? [...hosts.map((h) => ({ kind: "tcp" as const, host: h, port: this.port, src: "learned" as const, net: netFingerprint() })), ...this.advertiseExtra.filter((a) => a.kind === "tcp").map((a) => ({ ...a, port: a.port || this.port, src: "learned" as const }))] : [];
  }

  // ============================================================ RPC facade
  async call(method: string, p: any = {}): Promise<unknown> {
    // while the first start-up work runs (indexing a big archive for sync on a phone can take minutes) the status page must not hang on "Loading…": answer at once
    if (!this.isReady && (method === "syncStatus" || method === "syncDevices")) { const st = { loading: true, enabled: !!this.ledger.kvGet("group"), paused: false, revoked: false, devices: [], accounts: [], moves: [], discovered: [], pendingCredentials: [], listen: { enabled: false, scope: "lan", interfaces: [] }, media: { policy: this.policy, metered: false, wanted: 0, fetchedBytes: 0 }, proxy: { offers: [], using: [], shared: [] }, relays: [], advertise: [], now: this.now() }; return method === "syncDevices" ? [] : st; }
    await this.ready;
    switch (method) {
      case "syncStatus": return this.status();
      case "syncDevices": return this.status().devices;
      case "syncStartPairing": return this.startPairing(p);
      case "syncStopPairing": this.stopPairing("stopped"); return {};
      case "syncJoin": return this.join(p);
      case "syncJoinNearby": return this.join({ ...p, nearby: true });
      case "syncBrowse": return this.browse();
      case "syncConfirmJoin": return this.confirmJoin(p.accept !== false, !!p.keepListening);
      case "syncCancelJoin": return this.confirmJoin(false, false);
      case "syncApproveJoin": return this.approveJoin(p.accept !== false);
      case "syncRevoke": return this.revokeDevice(String(p.deviceId));
      case "syncSetAccountMode": return this.setMode(String(p.accountId), p.mode);
      case "syncPause": this.paused = true; this.ledger.kvSet("paused", true); this.teardown(false); this.changedDevices(); return {};
      case "syncResume": this.paused = false; this.ledger.kvSet("paused", false); await this.activate(); this.changedDevices(); return {};
      case "syncNetworkChanged": return this.networkChanged(p?.interfaces);
      case "syncNow": { for (const id of Object.keys(this.group?.devices ?? {})) this.backoff.delete(id); this.tick(); for (const s of this.sessions.values()) s.wake(); return {}; }
      case "syncLeave": return this.leave(!!p?.force);
      case "syncDismissRemoved": this.removedNotice = undefined; this.ledger.kvDel("removedNotice"); this.changedDevices(); return {};
      case "syncRenameDevice": { const n = String(p.name ?? "").trim().slice(0, 60); if (!n) throw new Error("Give this device a name."); this.me.name = n; this.ledger.kvSet("identity", this.me); if (this.group) { this.group.devices[this.me.id].name = n; this.persist(); } this.changedDevices(); return {}; }
      case "syncCredentials": return this.pendingCreds();
      case "syncConfirmCredentials": return this.confirmCreds(String(p.accountId), p.accept !== false);
      case "syncSetListen": return this.setListen(p);
      case "syncSetAddresses": return this.setAddresses(String(p.deviceId), p.addrs);
      case "syncSetAdvertise": this.advertiseExtra = cleanAddrs(p.addrs).filter((a) => a.kind === "tcp").map((a) => ({ ...a, src: "manual" as const })); this.ledger.kvSet("advertise", this.advertiseExtra); this.changedDevices(); return {};
      case "syncSetRelays": return this.setRelays(p.urls);
      case "syncSetDht": return this.setDht(p);
      case "syncSetMediaPolicy": this.policy = cleanPolicy(p, this.policy); this.ledger.kvSet("mediaPolicy", this.policy); this.changedDevices(); void this.pumpMedia(); return this.policy;
      case "syncSetMetered": this.metered = !!p.metered; this.ledger.kvSet("metered", this.metered); this.changedDevices(); void this.pumpMedia(); return {};
      case "syncSetProxyShare": if (p.enabled) this.refuseOnward(String(p.accountId)); this.proxies.setShare(String(p.accountId), !!p.enabled); return {};
      case "syncUseProxy": { await this.proxies.use(String(p.deviceId), String(p.accountId)); return {}; }
      case "syncStopProxy": await this.proxies.stopUsing(String(p.accountId)); return {};
      case "syncRelaySet": if (p.allow === true) this.refuseOnward(String(p.accountId)); this.proxies.setDecision(String(p.deviceId), String(p.accountId), p.allow === null || p.allow === undefined ? null : !!p.allow); return {};
      case "syncRelayAsk": return { state: await this.proxies.askHome(String(p.accountId), p.deviceId ? String(p.deviceId) : undefined) };
      case "syncMoveStart": return this.moves.start({ accountId: p.accountId, accountIds: Array.isArray(p.accountIds) ? p.accountIds.map(String) : undefined, deviceId: p.deviceId, confirmed: p.confirmed === true, includeHistory: p.includeHistory !== false, includeMedia: p.includeMedia !== false, removeHistoryAfter: p.removeHistoryAfter === true });
      case "syncMoveEstimate": return this.moves.estimate((Array.isArray(p.accountIds) ? p.accountIds : [p.accountId]).map(String), p.includeMedia !== false);
      case "syncSendHistory": return this.moves.sendHistory({ accountId: p.accountId, deviceId: p.deviceId, includeMedia: p.includeMedia !== false });
      case "syncMoveRespond": return this.moves.respond(String(p.transferId), p.accept === true, Array.isArray(p.accountIds) ? p.accountIds.map(String) : undefined);
      case "syncMoveCancel": return this.moves.cancel(String(p.transferId));
    }
    throw new Error("unknown sync method " + method);
  }

  status() {
    const g = this.group, now = this.now();
    const accounts = this.store.listAccounts().map((a) => {
      const isProxy = this.proxies.isProxy(a.id), live = !!this.host.connector(a.id) && !isProxy, home = this.proxies.homeOf(a.id);
      return { id: a.id, provider: a.provider, label: a.label, mode: this.modeOf(a.id), canShareCredentials: live && CREDENTIAL_PROVIDERS.has(a.provider) && !this.sharedFrom(a.id), sharedFrom: this.sharedFrom(a.id)?.name, credentialsError: this.credsErr[a.id],
        canShareProxy: live && !this.sharedFrom(a.id), canMove: live, moveWhy: live ? undefined : isProxy ? `Used through ${g?.devices[home!]?.name ?? "another device"}` : a.status === "archived" ? "Signed out here (history only)" : "Not signed in here", proxyShared: this.proxies.isShared(a.id), via: this.proxies.viaOf(a.id), proxyVia: isProxy ? { deviceId: home, deviceName: g?.devices[home!]?.name, online: !!home && this.sessions.has(home), auto: this.proxies.usingList().find((u) => u.accountId === a.id)?.auto, note: this.proxies.note(a.id) } : undefined };
    });
    const devices = Object.values(g?.devices ?? {}).map((d) => {
      const s = this.sessions.get(d.id), pr = this.progress.get(d.id);
      return { id: d.id, name: d.name, self: d.id === this.me.id, online: d.id === this.me.id || !!s, revoked: d.revoked, revokedBy: d.revokedBy ? g?.devices[d.revokedBy]?.name : undefined, removalPending: !!d.revoked && !d.removedAck && now - (Date.parse(d.revoked) || 0) < 30 * 86_400_000, lastSeen: d.id === this.me.id ? undefined : d.lastSeen, addedAt: d.addedAt, progress: pr, via: s?.via, viaKind: s ? (s.via === "dht" ? "dht" : s.via?.startsWith("relay") ? "relay" : "direct") : undefined, lastAddr: orderAddrs(d).find((a) => a.kind === "tcp" && a.good)?.host,
        addrs: d.id === this.me.id ? undefined : (d.addrs ?? []).map((a) => ({ kind: a.kind, host: a.host, port: a.port, url: a.url, src: a.src, good: a.good, bad: a.bad })), audit: this.proxies.audit[d.id] };
    });
    const self = "unichat-" + this.me.id.slice(0, 10) + "." + SERVICE;
    const discovered = this.mdns ? this.mdns.services().filter((s) => s.txt.m === "pair" && s.instance !== self).map((s) => ({ instance: s.instance, name: s.txt.n ?? s.instance, host: s.addrs[0] ?? s.host, port: s.port, nearby: s.txt.nb === "1" })) : [];
    const binds = this.boundHosts().map((h) => (h.includes(":") ? `[${h}]` : h) + ":" + this.port);
    return { enabled: !!g, paused: this.paused, revoked: this.selfRevoked, removedNotice: this.removedNotice, unlinking: this.unlinkPending && { peer: this.unlinkPending.peer, name: this.unlinkPending.name, since: this.unlinkPending.since, reason: this.unlinkPending.reason, online: this.sessions.has(this.unlinkPending.peer) }, deviceId: this.me.id, deviceName: this.me.name, groupId: g?.id, listening: this.servers.size > 0, port: this.port || undefined, binds,
      listen: { ...this.listen, error: this.listenErr || undefined, pairingOnly: this.servers.size > 0 && !this.listen.enabled, interfaces: interfaces().filter((i) => !i.internal && i.family === 4).map((i) => ({ name: i.name, address: i.address })) },
      discovery: this.o.mdns === false || this.o.mdns === undefined ? { available: false, reason: "Discovery is off." } : { available: this.mdns?.available ?? false, reason: this.mdns?.reason ?? (this.mdns ? undefined : "Not started (no listener open, or multicast is unavailable on this device).") },
      relays: this.relays, dht: { ...this.dhtSet, state: this.dhtSet.enabled ? this.dhtInfo.state : "off", reason: this.dhtSet.enabled ? this.dhtInfo.reason : undefined, publicKey: this.dht?.publicKey }, advertise: this.advertiseExtra, dialOnly: !!g && !this.servers.size,
      pairing: this.pairing && { dht: this.pairDhtState, expiresAt: this.pairing.expiresAt, failures: this.pairing.failures, maxFailures: this.o.maxPairingGlobal ?? 20, code: this.pairing.code, ...this.pairingLink(this.pairing) },
      approval: this.pendingJoin && { direction: this.pendingJoin.direction, deviceName: this.pendingJoin.name, sas: this.pendingJoin.sas, since: this.pendingJoin.since, expiresAt: this.pendingJoin.since + (this.o.approvalMs ?? 120_000), hostOk: this.pendingJoin.hostOk, joinerOk: this.pendingJoin.joinerOk, nearby: !!this.pendingJoin.nearby },
      joining: this.joining ? { state: this.joining.state, sas: this.joining.sas, hostName: this.joining.hostName, direction: this.joining.direction, nearby: !!this.joining.nearby } : this.joinResult, solo: this.liveCount() <= 1, joinBusy: this.joinBusy,
      devices, accounts, discovered, pendingCredentials: this.pendingCreds(), moves: this.moves?.list() ?? [], entities: this.ledger.count(), pending: Math.max(0, this.ledger.maxSeq() - Math.min(...[...this.sessions.values()].map((s) => s.sentUpTo), this.ledger.maxSeq())),
      media: { policy: this.policy, metered: this.metered, wanted: this.ledger.wantCount(), fetchedBytes: this.ledger.blobTotal(), active: this.mediaActive, stats: this.blobs?.stats },
      proxy: { offers: this.proxies.offerState(), using: this.proxies.usingList(), shared: accounts.filter((a) => a.proxyShared).map((a) => a.id), ...this.proxies.relayState() }, now };
  }
  /** Tells the UI the device list / progress changed. status() is expensive on a big ledger (it counts rows, decrypts account labels, reads the origins), and a history or backlog transfer reports a change per chunk: first call goes out at once, the rest coalesce into one more call per 500 ms. */
  private changedDevices() {
    if (this.disposed) return;
    const now = Date.now(), gap = now - this.lastStatusEmit;
    if (gap >= 500 && !this.statusT) { this.lastStatusEmit = now; this.host.emit("sync-devices", this.status()); return; }
    if (this.statusT) return;
    this.statusT = setTimeout(() => { this.statusT = undefined; if (this.disposed) return; this.lastStatusEmit = Date.now(); this.host.emit("sync-devices", this.status()); }, Math.max(0, 500 - gap)); this.statusT.unref?.();
  }
  private statusT?: ReturnType<typeof setTimeout>; private lastStatusEmit = 0;
  private originsMemo?: { at: number; v: Record<string, string> };
  // ---- where an account came from: an account that was only shared TO this device (adopted credentials, history copy, relayed) is never shared onward from here
  private origins() { const m = this.originsMemo; if (m && Date.now() - m.at < 1000) return m.v; const v = this.ledger.kvGet<Record<string, string>>("origins") ?? {}; this.originsMemo = { at: Date.now(), v }; return v; } // memoised 1 s: status() asks once per account (sealed kv read + JSON parse each)
  private setOrigin(acct: string, dev: string | undefined) { const o = { ...this.origins() }; if (dev) o[acct] = dev; else delete o[acct]; this.ledger.kvSet("origins", o); this.originsMemo = undefined; }
  /** the device this account comes from ("another device" when only a copy of its history is here); undefined = it is this device's own login (also after a move) */
  private sharedFrom(acct: string): { id?: string; name: string } | undefined {
    const o = this.origins()[acct]; if (o) return { id: o, name: this.group?.devices[o]?.name ?? "another device" };
    const home = this.proxies.homeOf(acct); if (home) return { id: home, name: this.group?.devices[home]?.name ?? "another device" };
    if (!this.store.listAccounts().some((x) => x.id === acct)) return undefined;
    if ((!!this.host.connector(acct) && !this.proxies.isProxy(acct)) || this.store.listAccounts().some((x) => x.id === acct && x.status === "active") || hasFiles(join(this.host.accountsDir, acct))) return undefined;
    return { name: "another device" };
  }
  private refuseOnward(acct: string) { const f = this.sharedFrom(acct); if (f) throw new Error(`This account comes from ${f.name}; share it from there.`); }
  private setMode(acct: string, mode: SyncMode) {
    if (!["none", "archive-only", "credentials"].includes(mode)) throw new Error("Unknown sync mode.");
    if (mode === "credentials") this.refuseOnward(acct);
    const a = this.store.listAccounts().find((x) => x.id === acct); if (!a) throw new Error("Unknown account.");
    if (mode === "credentials" && !this.host.connector(acct)) throw new Error("This device does not hold the login of this account (it only has a copy of its history), so it cannot share it. Change it on the device where the account is signed in.");
    if (mode === "credentials" && !CREDENTIAL_PROVIDERS.has(a.provider)) throw new Error(`${a.provider} sessions cannot be copied to other devices: link the account on each device separately, or let the other devices use it through the device where it is linked ("proxy").`);
    if (mode === "none" && (this.proxies.isShared(acct) || this.proxies.isProxy(acct))) throw new Error("This account is used through a proxy. Stop sharing / using it as a proxy first, or keep syncing its history.");
    this.modes[acct] = mode; this.ledger.kvSet("modes", this.modes); this.proxies.offersChanged();
    if (mode === "credentials") this.refreshCreds();
    this.wakeSoon(); this.changedDevices(); return {};
  }
  private async setListen(p: any) {
    const scope = ["loopback", "lan", "address"].includes(p.scope) ? p.scope : this.listen.scope;
    const next: ListenSetting = { enabled: p.enabled === undefined ? this.listen.enabled : !!p.enabled, scope, ...(scope === "address" ? { address: String(p.address ?? this.listen.address ?? "").trim() } : {}) };
    // Only a setting that cannot work at all is refused (`error`). A `note` -- "your network has no private address" -- is a
    // status, not a reason to fail the call: throwing it turned choosing "my local network" into an error dialog.
    if (next.enabled && !this.o.bindHost) { const r = bindsFor(next, interfaces()); if (r.error) throw new Error(r.error); }
    this.listen = next; this.ledger.kvSet("listen", next);
    await this.syncListeners(); return { ...next };
  }
  private setAddresses(id: string, list: unknown) {
    const d = this.group?.devices[id]; if (!d || id === this.me.id) throw new Error("Unknown device.");
    const manual = cleanAddrs(list, 8).map((a) => ({ ...a, src: "manual" as const }));
    d.addrs = [...(d.addrs ?? []).filter((a) => a.src !== "manual"), ...manual]; this.persist(); this.backoff.delete(id); this.changedDevices(); this.tick(); return {};
  }
  private setRelays(urls: unknown) {
    const list = (Array.isArray(urls) ? urls : []).map((u) => String(u).trim().replace(/\/+$/, "")).filter(Boolean);
    for (const u of list) if (!/^wss?:\/\/[^\s]{1,300}$/.test(u)) throw new Error(`"${u}" is not a relay address (it looks like wss://relay.example.org/relay).`);
    this.relays = list.slice(0, 3); this.ledger.kvSet("relays", this.relays);
    for (const [k, c] of this.parkers) { c.abort(); this.parkers.delete(k); }
    this.changedDevices(); this.tick(); return {};
  }

  // ============================================================ "Reach my devices from anywhere" (HyperDHT, see dht.ts)
  private async setDht(p: any) {
    const next = cleanDhtSetting(p, this.dhtSet);
    this.dhtSet = next; this.ledger.kvSet("dht", next); this.dhtRetry = { n: 0, until: 0 };
    await this.syncDht(); this.changedDevices(); this.tick(); return { ...next };
  }
  private dhtWanted() { return this.dhtSet.enabled && !!this.group && !this.selfRevoked && !this.paused && !this.disposed; }
  /** Make the DHT node match what is wanted right now (serialised, like syncListeners). Nothing is loaded or opened unless the setting is on. */
  private syncDht(): Promise<void> {
    this.dhtBusy = this.dhtBusy.then(() => this.doSyncDht()).catch(() => {});
    return this.dhtBusy;
  }
  private async doSyncDht() {
    const want = this.dhtWanted(), key = want ? this.group!.id + "|" + this.dhtSet.bootstrap.join(",") : "";
    if (this.dht && (!want || this.dhtKey !== key)) { const d = this.dht; this.dht = undefined; await d.stop().catch(() => {}); }
    if (!want) { if (this.dhtInfo.state !== "off") { this.dhtInfo = { state: "off" }; this.dhtRetry = { n: 0, until: 0 }; this.changedDevices(); } return; }
    if (this.dht || this.now() < this.dhtRetry.until) return;
    this.dhtInfo = { state: "starting" }; this.changedDevices();
    const g = this.group!, o = this.o.dht ?? {};
    const t = new DhtTransport({ seed: dhtSeed(Buffer.from(this.me.priv, "base64"), g.id), bootstrap: this.dhtSet.bootstrap, loader: o.loader, requireBootstrap: o.requireBootstrap, maxDials: o.maxDials, startTimeoutMs: o.startTimeoutMs,
      allow: () => Object.values(this.group?.devices ?? {}).filter((d) => d.id !== this.me.id && !d.revoked && d.dht).map((d) => d.dht!),
      onInbound: (sock) => this.onInbound(sock) });
    try {
      await t.start();
      if (!this.dhtWanted()) { await t.stop(); return; }
      this.dht = t; this.dhtKey = key; this.dhtRetry = { n: 0, until: 0 }; this.dhtInfo = { state: "ready" };
      const me = g.devices[this.me.id], pk = t.publicKey;
      if (me && pk && me.dht !== pk) { me.dht = pk; this.persist(); this.broadcastKeys(); } // announce to the group: peers need it to find us
    } catch (e) {
      await t.stop().catch(() => {});
      const n = this.dhtRetry.n + 1, unavailable = e instanceof DhtUnavailable;
      this.dhtRetry = { n, until: this.now() + (unavailable ? 600_000 : Math.min(10_000 * 2 ** Math.min(n, 5), 300_000)) };
      this.dhtInfo = { state: unavailable ? "unavailable" : "error", reason: unavailable ? errmsg(e) : "Couldn't start: " + errmsg(e) };
    }
    this.changedDevices();
  }
  /** Addresses a peer announced (members / addrs frame, over ANY transport incl. the DHT): replace what we knew of that network, try the new ones at once when we only have a DHT / relay session. */
  private learnAnnounced(d: Dev, raw: unknown, s?: Session) {
    const list = cleanAddrs(raw, 8).filter((a) => a.kind === "tcp"); if (!list.length) return;
    const changed = applyAnnounced(d, list); if (changed) this.persist();
    this.backoff.delete(d.id);
    if (s && s.via !== undefined && (s.via === "dht" || s.via.startsWith("relay"))) { this.upgradeAt.delete(d.id); this.upgradeToLan(d, true); } // direct beats the DHT: migrate right away
  }
  private netSigSeen = "";
  private netSig() { return interfaces().filter((i) => !i.internal).map((i) => i.name + i.address).sort().join(","); }
  /**
   * The network changed (Wi-Fi switched, resume from Doze, the Android connectivity callback fired; also called by tick() when the address list differs).
   * `list` (Android: LinkProperties of every network) replaces what os.networkInterfaces() says. Re-evaluates everything that depends on the addresses:
   * listeners are rebound, mDNS memberships re-joined and the service re-announced, the DHT node refreshed, sessions that ran over a vanished local address are closed
   * (they would only time out), peers on surviving sessions get our new addresses, the dial back-off is reset so unreachable peers are tried at once.
   */
  async networkChanged(list?: unknown): Promise<{ listening: boolean; addrs: string[] }> {
    if (Array.isArray(list)) setInterfaceOverride(list.map((i: any) => ({ name: String(i?.name ?? "net").slice(0, 40), address: String(i?.address ?? ""), family: (i?.family === 6 ? 6 : 4) as 4 | 6, internal: !!i?.internal, netmask: i?.netmask ? String(i.netmask) : undefined })).filter((i) => /^[0-9a-f.:]{3,45}$/i.test(i.address)).slice(0, 64));
    this.netSigSeen = this.netSig();
    if (this.paused || this.disposed || !this.group) return { listening: this.servers.size > 0, addrs: this.advHosts() };
    const here = new Set(interfaces().map((i) => i.address));
    for (const s of [...this.sessions.values()]) { const la = (s.ch.socket as Socket | undefined)?.localAddress?.replace(/^::ffff:/, ""); if (la && !/^(127\.|::1$)/.test(la) && here.size && !here.has(la) && s.via !== "dht" && !String(s.via ?? "").startsWith("relay")) this.closeSession(s, "network changed"); }
    for (const id of Object.keys(this.group.devices)) this.backoff.delete(id);
    await this.syncListeners();
    this.mdns?.refresh?.(); this.dht?.refresh();
    const addrs = this.selfAddrs();
    for (const s of this.sessions.values()) void this.sendMsg(s, { t: "addrs", port: this.listeningPort(), addrs }).catch(() => {});
    this.tick(); for (const s of this.sessions.values()) s.wake();
    return { listening: this.servers.size > 0, addrs: this.advHosts() };
  }
  /** Interfaces / addresses changed (Wi-Fi <-> mobile data): announce again. Cheap check, runs on every tick. */
  private checkNetwork() {
    if (!this.dht) return;
    const sig = interfaces().filter((i) => !i.internal).map((i) => i.name + i.address).sort().join(",");
    if (this.ifSig && sig !== this.ifSig) this.dht.refresh();
    this.ifSig = sig;
  }

  // ============================================================ per-source limits
  private srcOf(sock: Socket) { const a = sock.remoteAddress; return a ? a.replace(/^::ffff:/, "").replace(/^([0-9a-f:]+?:[0-9a-f]*:[0-9a-f]*:[0-9a-f]*):.*$/i, "$1") : "relay"; }
  private srcState(ip: string) { let s = this.src.get(ip); if (!s) { s = { n: 0, until: 0, strikes: 0, last: 0, conns: [], open: 0 }; this.src.set(ip, s); if (this.src.size > 2000) this.src.delete(this.src.keys().next().value!); } return s; }
  /** One failed attempt from this source; after `max` of them it is locked out for 30 s, 1 min, 2 min ... (cap 1 h). The pairing session itself is untouched. */
  private srcFail(ip: string, max = this.o.maxPairingFailures ?? 3) {
    const n = this.now(), s = this.srcState(ip); if (n - s.last > 600_000) s.strikes = 0; s.last = n;
    if (++s.n >= max) { s.n = 0; s.strikes++; s.until = n + Math.min(30_000 * 2 ** (s.strikes - 1), 3_600_000); }
  }

  // ============================================================ pairing
  private pairingLink(p: Pairing) {
    const hosts = this.o.bindHost ? [this.o.bindHost] : this.advHosts().length ? this.advHosts() : lanAddresses();
    const k = Buffer.from(this.me.pub, "base64").toString("base64url");
    return { hosts, port: this.port, link: `unichat-sync://pair?h=${hosts.join(",")}&p=${this.port}&c=${normalizeCode(p.code)}&k=${k}` };
  }
  private async startPairing(p: { deviceName?: string; keepListening?: boolean }) {
    if (this.selfRevoked) throw new Error("This device was removed from its group. Leave the group first.");
    if (this.unlinkPending) throw new Error(`This device is unlinking from its group (waiting for ${this.unlinkPending.name}). Finish that first.`);
    if (p?.deviceName?.trim()) { this.me.name = p.deviceName.trim().slice(0, 60); this.ledger.kvSet("identity", this.me); }
    if (!this.group) { this.group = newGroup(this.me); this.persist(); }
    else if (this.group.devices[this.me.id].name !== this.me.name) { this.group.devices[this.me.id].name = this.me.name; this.persist(); }
    this.paused = false; this.ledger.kvSet("paused", false);
    this.stopPairing("restarted"); this.joinResult = undefined;
    const code = newPairingCode(), ttl = this.o.pairingTtlMs ?? 5 * 60_000;
    const pr: Pairing = { code, psk: pairingPsk(code), expiresAt: this.now() + ttl, failures: 0, nearbyPrompts: 0, keepListening: !!p?.keepListening, timer: setTimeout(() => this.stopPairing("expired"), ttl) };
    pr.timer.unref?.(); this.pairing = pr;
    await this.activate(); await this.syncListeners();
    // No TCP listener is not the end of pairing: while a code is shown this device also waits on the code's DHT rendezvous
    // (startPairDht below), which is exactly how two devices on networks that cannot reach each other pair. Refusing here left
    // a laptop whose network has no private address -- a campus Wi-Fi, say -- unable to even show a code.
    if (!this.servers.size && !this.dhtSet.enabled) { this.stopPairing("no network"); throw new Error(this.listenErr || "This device has no network address to listen on."); }
    this.advertise(); this.changedDevices();
    this.startPairDht(pr);
    return { code, expiresAt: pr.expiresAt, maxFailures: this.o.maxPairingGlobal ?? 20, ...this.pairingLink(pr) };
  }
  /** Pairing across networks: while a code is shown, also listen on the code-derived HyperDHT key (see pairingDhtSeed). Best effort and in the background: the local network works without it. */
  private pairDht?: DhtTransport; private pairDhtState: DhtState = "off";
  /** First 8 hex of sha256(psk): tells two pairings apart in a log without putting the code (or anything derived from it that helps a guess) in it. */
  private pairTag(pr: Pairing) { return createHash("sha256").update(pr.psk).digest("hex").slice(0, 8); }
  private startPairDht(pr: Pairing) {
    if (!this.dhtSet.enabled) return;
    const o = this.o.dht ?? {}; this.pairDhtState = "starting";
    const t = new DhtTransport({ seed: pairingDhtSeed(pr.psk), bootstrap: this.dhtSet.bootstrap, loader: o.loader, requireBootstrap: o.requireBootstrap, startTimeoutMs: o.startTimeoutMs, open: true, via: "dht-pair", allow: () => [],
      onInbound: (sock) => {
        if (this.pairing === pr) { console.warn(`[sync] someone reached the rendezvous of the code ${this.pairTag(pr)}; answering it`); this.onInbound(sock); }
        else { console.warn(`[sync] someone reached the rendezvous of the code ${this.pairTag(pr)}, which is not the code shown here any more: hanging up`); sock.destroy(); }
      } });
    this.pairDht = t;
    t.start().then(() => { if (this.pairDht === t) { this.pairDhtState = "ready"; console.warn(`[sync] showing a code (${this.pairTag(pr)}): its rendezvous is open`); this.changedDevices(); } else void t.stop(); },
      (e) => { if (this.pairDht === t) { this.pairDht = undefined; this.pairDhtState = e instanceof DhtUnavailable ? "unavailable" : "error"; console.warn(`[sync] showing a code (${this.pairTag(pr)}): its rendezvous could NOT be opened: ${errmsg(e)}`); this.changedDevices(); } void t.stop(); });
  }
  private stopPairDht() {
    const t = this.pairDht; this.pairDht = undefined; this.pairDhtState = "off";
    if (t) { const k = setTimeout(() => void t.stop(), 90_000); k.unref?.(); } // a pairing handshake that is still running gets time to finish (new callers are refused: no pairing is open)
  }
  private stopPairing(reason: string) {
    if (!this.pairing) return;
    console.warn(`[sync] the code ${this.pairTag(this.pairing)} is no longer shown here (${reason})`);
    clearTimeout(this.pairing.timer); this.pairing = undefined; this.stopPairDht();
    if (this.pendingJoin) this.finishJoin(false, "Pairing was closed.");
    void this.syncListeners().then(() => { if (!this.disposed) this.host.emit("sync-devices", { ...this.status(), pairingEnded: reason }); }, () => {});
  }
  /**
   * The device that ENTERS a code (or scans the QR) dials out; the one that SHOWS it listens. The code alone is enough: the dialer tries, all in parallel and
   * with short timeouts, the addresses inside the link, a typed address, hints from earlier pairings, addresses of known group members, mDNS and a probe
   * of its own private subnets on the well-known port. The first candidate that completes the code-authenticated handshake wins; the rest are cancelled.
   * Returns the 6 digits to compare. Nothing is shared yet.
   */
  private async join(p: { host?: string; port?: number; code?: string; link?: string; deviceName?: string; keepListening?: boolean; nearby?: boolean }) {
    const nearby = !!p.nearby;
    if (this.joining || this.joinBusy) throw new Error("A pairing is already in progress. Confirm or cancel it first.");
    let code = p.code, pin: Buffer | undefined; const fixed: Cand[] = [], wk = this.o.wellKnown ?? { base: SYNC_PORT, span: SYNC_PORT_SPAN }, ports = wellKnownPorts(wk.base, wk.span);
    if (p.link && !nearby) {
      let u: URL; try { u = new URL(p.link); } catch { throw new Error("That is not a UniChat pairing link."); }
      if (u.protocol !== "unichat-sync:") throw new Error("That is not a UniChat pairing link.");
      const port = Number(u.searchParams.get("p")); code = u.searchParams.get("c") ?? code;
      for (const h of (u.searchParams.get("h") ?? "").split(",").map((x) => x.trim()).filter(Boolean)) fixed.push({ host: h, ports: port > 0 ? [port] : ports, src: "link" });
      const k = u.searchParams.get("k"); if (k) pin = Buffer.from(k, "base64url");
    }
    const typed = p.host?.trim(); if (typed) fixed.push({ host: typed.replace(/^\[|\]$/g, ""), ports: Number(p.port) > 0 ? [Number(p.port)] : ports, src: "typed" });
    if (nearby && !typed) throw new Error("Choose a nearby device first.");
    if (!nearby && (!code || !code.trim())) throw new Error("Enter the pairing code shown on the other device.");
    if (!nearby && !isValidCode(code!)) throw new Error("That pairing code doesn't look right: it is 16 letters like bako-lemi-zuta-nosu.");
    if (this.selfRevoked) { this.selfRevoked = false; this.me = newIdentity(this.me.name); this.ledger.kvSet("identity", this.me); this.clock = new Clock(this.me.id, () => this.now()); }
    if (p.deviceName?.trim()) { this.me.name = p.deviceName.trim().slice(0, 60); this.ledger.kvSet("identity", this.me); }
    this.joinResult = undefined; this.joinBusy = true; this.changedDevices();
    const net = this.o.net ?? {}, connect: Connector = net.connect ?? tcpConnect, psk = nearby ? NEARBY_PSK : pairingPsk(code!);
    const explicit = nearby || (!!typed && !p.link); // somebody told us where: no need to look around
    // hints from earlier pairings and addresses of group members we already know (a device that is added again keeps its address)
    if (!explicit) {
      for (const h of this.ledger.kvGet<{ host: string; port: number }[]>("pairHints") ?? []) fixed.push({ host: h.host, ports: [h.port], src: "hint" });
      for (const d of Object.values(this.group?.devices ?? {})) if (d.id !== this.me.id) for (const a of d.addrs ?? []) if (a.kind === "tcp" && a.host && a.port) fixed.push({ host: a.host, ports: [a.port], src: "known" });
    }
    let probe: Cand[] = [];
    if (!explicit && (net.interfaces || !this.o.bindHost)) probe = probeHosts((net.interfaces ?? interfaces)(), 512).map((host) => ({ host, ports, src: "probe" as const }));
    let startedMdns = false, poll: (() => Cand[]) | undefined;
    if (!explicit && this.o.mdns) {
      if (!this.mdns) { this.mdns = this.o.mdns === true ? new Mdns() : this.o.mdns; this.ownMdns = this.o.mdns === true; if (this.ownMdns) { startedMdns = true; await this.mdns.start().catch(() => { this.mdns = undefined; startedMdns = false; }); } }
      const ownInstance = "unichat-" + this.me.id.slice(0, 10);
      const m = this.mdns; if (m) poll = () => m.services().filter((x) => x.txt.m === "pair" && x.port && x.instance !== ownInstance).flatMap((x) => (x.addrs.length ? x.addrs : [x.host]).filter((h) => /^\d+\.\d+\.\d+\.\d+$/.test(h)).map((host) => ({ host, ports: [x.port], src: "mdns" as const })));
    }
    const keys = { pub: Buffer.from(this.me.pub, "base64"), priv: Buffer.from(this.me.priv, "base64") };
    // across networks (a university network, CGNAT): the code also names a HyperDHT key, hole punched like the group sync (see pairingDhtSeed). Raced with everything above; the first handshake wins.
    let jd: DhtTransport | undefined, jdStart: Promise<string> | undefined;
    if (!nearby && this.dhtSet.enabled) {
      const o = this.o.dht ?? {}, seed = pairingDhtSeed(psk);
      const t = jd = new DhtTransport({ seed: Buffer.from(randomBytes(32)), bootstrap: this.dhtSet.bootstrap, loader: o.loader, requireBootstrap: o.requireBootstrap, startTimeoutMs: o.startTimeoutMs, allow: () => [], onInbound: (s) => s.destroy() });
      jdStart = t.start().then(() => t.keyOf(seed)); jdStart.catch(() => {});
      fixed.push({ host: "dht", ports: [0], src: "dht" });
    }
    let r;
    try {
      r = await dialAny<Secure>({
        fixed, probe, poll, concurrency: net.concurrency ?? 64, overallMs: net.overallMs ?? (jd ? 45_000 : 20_000), graceMs: net.graceMs,
        attempt: async (host, port, signal, c) => {
          const sock = c.src === "dht" ? await jd!.connect(await jdStart!, signal, this.o.dht?.connectMs ?? 30_000) : await connect(host, port, c.src === "probe" ? net.probeConnectMs ?? 400 : net.connectMs ?? 4000, signal);
          const kill = () => sock.destroy(); if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true });
          try {
            const secure = await dial(sock, { mode: nearby ? "nearby" : "pair", psk, s: keys, hello: this.helloMsg(), timeoutMs: 6000,
              checkRemote: (pub, hello) => {
                if (hello?.id !== deviceIdOf(pub)) throw new ChannelError("auth", "device id does not match its key");
                if (pin && !sameKey(pin, pub)) throw new ChannelError("auth", "this is not the device that showed the QR code");
                if (this.liveCount() > 1 && Number(hello?.grp) > 1) throw new ChannelError("protocol", "Both devices already belong to a sync group. Leave the group on one of them first.", true);
              } });
            if (nearby) { try { await nearbyJoin(secure); } catch (e) { secure.close(); throw e instanceof ChannelError && e.code !== "closed" ? new ChannelError("protocol", e.message, true) : new ChannelError("protocol", "The other device stopped answering.", true); } }
            return secure;
          } finally { signal.removeEventListener("abort", kill); }
        },
        dispose: (ch) => ch.close(),
      });
    } catch (e) {
      this.joinBusy = false; void jd?.stop();
      if (startedMdns && !this.servers.size) { this.mdns?.stop(); this.mdns = undefined; }
      if (e instanceof DialFailure) {
        // What the dial actually did, in the log of the device that tried: "the code was not accepted" and "nobody answered"
        // look the same from the outside, and without these numbers a pairing complaint cannot be told apart from a typo.
        const st = e.stats;
        console.warn(`[sync] pairing failed: reason=${e.reason} candidates=${st.tried} answered=${st.connected} refusedTheCode=${st.rejected} connectionRefused=${st.refused} timedOut=${st.timedOut}${st.rejectedBy ? ` refusedBy=${st.rejectedBy}` : ""}${st.rejectedWhy ? ` why="${st.rejectedWhy}"` : ""}${pin ? " link=yes" : ""}${nearby ? " nearby=yes" : ""}`);
        const msg = nearby && e.reason !== "other" ? "Couldn't reach that device. Make sure both are on the same Wi-Fi and it still shows \"Add a device\"." : e.reason === "code" ? "The pairing code was not accepted (wrong code, expired, or too many attempts)." + (pin ? " If you scanned a QR code, check that it is the one on the other device's screen." : "")
          : e.reason === "unreachable" ? "Couldn't reach a device showing that code. Both the local network and the internet (HyperDHT hole punching) were tried. If the other device is on a very restrictive network (symmetric NAT, UDP blocked), try the other direction: show a code on this device instead and type it there." : e.message;
        this.joinResult = { state: "failed", error: msg, reason: e.reason }; this.changedDevices(); throw new Error(msg);
      }
      this.changedDevices(); throw e;
    }
    this.joinBusy = false;
    if (startedMdns && !this.servers.size) { this.mdns?.stop(); this.mdns = undefined; }
    const viaDht = r.cand.src === "dht";
    if (jd) { if (viaDht) (r.value as any).socket?.once?.("close", () => void jd!.stop()); else void jd.stop(); } // the DHT node lives exactly as long as the connection that runs over it
    const ch = r.value, host = viaDht ? DHT_HOST : r.cand.host, port = r.port, hints = (this.ledger.kvGet<{ host: string; port: number }[]>("pairHints") ?? []).filter((h) => !(h.host === host && h.port === port));
    if (!nearby && !viaDht) this.ledger.kvSet("pairHints", [{ host, port }, ...hints].slice(0, 4)); // nothing is remembered about a device nobody has confirmed yet
    const hostName = String(ch.hello?.name ?? "the other device").slice(0, 60), sas = sasOf(ch.transcript), via = viaDht ? host : `${host}:${port}`;
    if (this.liveCount() > 1 && !(Number(ch.hello?.grp) > 1)) { void this.pairHost(ch, host, undefined, !!p.keepListening, nearby); return { sas, hostName, role: "host", via }; } // we hold the group and dialed the new device: we admit it
    const timer = setTimeout(() => void this.confirmJoin(false, false).catch(() => {}), (this.o.approvalMs ?? 120_000) + 30_000); timer.unref?.();
    this.joining = { state: "confirm", sas, hostName, ch, host, port, pin, direction: "outgoing", timer, nearby };
    this.changedDevices();
    return { sas, hostName, role: "joiner", via };
  }
  /** A device that holds a group dialed us (we show a code and have no group of our own to speak of): we are the one joining. */
  private async joinInbound(ch: Secure, ip: string, nearby = false) {
    if (this.joining || this.pendingJoin) { try { await ch.send({ t: "busy" }); } catch { /* gone */ } return ch.close(); }
    const timer = setTimeout(() => void this.confirmJoin(false, false).catch(() => {}), (this.o.approvalMs ?? 120_000) + 30_000); timer.unref?.();
    this.joining = { state: "confirm", sas: sasOf(ch.transcript), hostName: String(ch.hello?.name ?? "the other device").slice(0, 60), ch, host: ip.replace(/^::ffff:/, ""), port: Number(ch.hello?.port) || 0, direction: "incoming", timer, nearby };
    this.changedDevices();
  }
  /** B side, step 2: the user compared the digits. Accept: wait for the other device's approval, then receive the group. */
  private async confirmJoin(accept: boolean, keepListening: boolean) {
    const j = this.joining; if (!j) throw new Error("There is no pairing waiting for confirmation.");
    clearTimeout(j.timer);
    if (!accept) { try { await j.ch.send({ t: "sas", ok: false }); } catch { /* gone */ } j.ch.close(); this.joining = undefined; this.joinResult = undefined; this.changedDevices(); return {}; }
    j.state = "waiting"; this.changedDevices();
    const ch = j.ch, host = j.host, port = j.port, prevGroup = this.group;
    try {
      await ch.send({ t: "sas", ok: true });
      const w = await ch.recv((this.o.approvalMs ?? 120_000) + 30_000);
      if (w?.t === "denied") throw new Error("The other device did not approve this pairing.");
      if (w?.t === "busy") throw new Error("The other device is busy with another pairing.");
      if (w?.t !== "welcome" || !w.group || typeof w.group.id !== "string") throw new Error("unexpected reply");
      const g: Group = { id: w.group.id, devices: {}, keys: [] };
      g.devices[this.me.id] = { id: this.me.id, name: this.me.name, pub: this.me.pub, addedAt: new Date().toISOString() };
      mergeMembership(g, w.devices, w.keys, this.me.id);
      if (!g.keys.length) throw new Error("the other device sent no group key");
      const peer = deviceIdOf(ch.remoteStatic);
      if (!g.devices[peer]) throw new Error("the other device is not part of its own group");
      if (!isDhtHost(host) && (Number(ch.hello?.port) || port)) noteAddr(g.devices[peer], { kind: "tcp", host, port: Number(ch.hello?.port) || port, src: "pairing" });
      this.group = g; this.persist();
      if (keepListening && !this.listen.enabled) { this.listen = { ...this.listen, enabled: true }; this.ledger.kvSet("listen", this.listen); }
      await ch.send({ t: "joined", port: this.listeningPort(), dht: await this.ownDhtKey(g.id) });
      const ok = await ch.recv(10_000); if (ok?.t !== "added") throw new Error("the other device did not confirm");
    } catch (e) { ch.close(); this.group = prevGroup; if (prevGroup) this.persist(); else this.ledger.kvDel("group"); this.joining = undefined; this.joinResult = { state: "failed", error: "Pairing failed: " + errmsg(e) }; this.changedDevices(); throw new Error("Pairing failed: " + errmsg(e)); }
    ch.close(); this.joining = undefined; this.joinResult = { state: "done" };
    if (this.pairing) this.stopPairing("joined"); // we had been showing a code ourselves (the other device could not reach us / we could not reach it): that code is no longer needed
    await this.activate(); this.changedDevices();
    return { deviceId: this.me.id, groupId: this.group!.id };
  }
  /** A side: the user answered "Device X wants to join: do both screens show the same digits?" */
  private approveJoin(accept: boolean) {
    const pj = this.pendingJoin; if (!pj) throw new Error("No device is waiting for approval.");
    pj.hostOk = accept; pj.settle(); return {};
  }
  private finishJoin(_ok: boolean, _why: string) { const pj = this.pendingJoin; if (!pj) return; clearTimeout(pj.timer); this.pendingJoin = undefined; pj.hostOk ??= false; pj.settle(); }
  /**
   * The user unlinks this device. Group of two: the other device is told first (see startUnlink), a group of one is meaningless. Group of three or more: this device
   * writes its own removal tombstone and tells every connected member before it forgets the group (the others pass it on to members that were offline).
   * `force` (the user gave up waiting) unlinks right away.
   */
  private async leave(force = false) {
    const g = this.group;
    if (g && !force && !this.selfRevoked) {
      const live = Object.values(g.devices).filter((d) => d.id !== this.me.id && !d.revoked);
      if (live.length === 1) return this.startUnlink(live[0].id, "leave");
      if (live.length > 1) {
        revoke(g, this.me.id, this.me.id); g.devices[this.me.id].removedAck = g.devices[this.me.id].revoked; this.persist();
        const fr = { t: "keys", devices: g.devices, keys: g.keys };
        await Promise.race([Promise.all([...this.sessions.values()].map((s) => s.ch.send(fr).catch(() => {}))), new Promise((r) => setTimeout(r, 1500))]);
        await new Promise((r) => setTimeout(r, 100)); // let the frames leave the socket before it is closed
      }
    }
    return this.leaveLocal();
  }
  /** Forget the group on this device (archive and account logins stay). With `notice` the UI shows why. */
  private async leaveLocal(notice?: { by: string; at: string; reason: "removed" | "unlinked" | "alone" }) {
    if (this.leaving) return {};
    this.leaving = true;
    try { return await this.leaveNow(notice); } finally { this.leaving = false; }
  }
  private async leaveNow(notice?: { by: string; at: string; reason: "removed" | "unlinked" | "alone" }) {
    if (notice && !this.group) return {};
    if (notice && !this.unlinkPending) { this.removedNotice = notice; this.ledger.kvSet("removedNotice", notice); }
    this.unlinkPending = undefined; this.ledger.kvDel("unlinkPending");
    this.teardown(true);
    await this.proxies.releaseAll().catch(() => {});
    for (const u of this.proxies.usingList()) await this.proxies.stopUsing(u.accountId).catch(() => {});
    this.group = undefined; this.selfRevoked = false; this.store.ctx = undefined;
    this.ledger.kvDel("group"); this.ledger.kvDel("bootstrapped"); this.ledger.kvDel("cursors");
    await this.syncDht(); // no group any more: the DHT node goes away
    this.me = newIdentity(this.me.name); this.ledger.kvSet("identity", this.me); this.clock = new Clock(this.me.id, () => this.now());
    this.changedDevices(); return {};
  }
  private teardown(closeMdns: boolean) {
    this.stopPairing("stopped");
    for (const s of [...this.sessions.values()]) this.closeSession(s, "paused");
    for (const t of this.timers) clearInterval(t); this.timers = [];
    for (const c of this.parkers.values()) c.abort(); this.parkers.clear();
    void this.syncDht(); // paused / revoked / left: the DHT node and its sockets go away with the sessions
    for (const srv of this.servers.values()) { try { srv.close(); (srv as any).closeAllConnections?.(); } catch { /* closed */ } } this.servers.clear();
    this.proxies?.stop();
    this.mdns?.unadvertise(); if (closeMdns && this.ownMdns) { this.mdns?.stop(); this.mdns = undefined; }
  }

  // ============================================================ inbound connections
  private onInbound(sock: Socket) {
    const ip = this.srcOf(sock), st = this.srcState(ip), now = this.now(), viaPairDht = (sock as any).unichatVia === "dht-pair", viaDht = (sock as any).unichatVia === "dht" || viaPairDht, viaRelay = ip === "relay"; // viaRelay: no source address (relay or DHT): only the firewall / unauthenticated cap apply
    st.conns = st.conns.filter((t) => now - t < 60_000); st.conns.push(now);
    if ((!viaRelay && (st.until > now || st.conns.length > 40 || st.open >= 3)) || this.unauth >= 8) { sock.destroy(); return; } // per-source lockout, connection rate, concurrent half-open
    this.unauth++; st.open++; sock.setNoDelay?.(true); sock.setTimeout?.(30_000, () => sock.destroy());
    let mode = "", done = false; const leave = () => { if (!done) { done = true; this.unauth--; st.open--; } };
    accept(sock, {
      s: { pub: Buffer.from(this.me.pub, "base64"), priv: Buffer.from(this.me.priv, "base64") }, hello: this.helloMsg(), timeoutMs: 8000, failFloorMs: this.o.failFloorMs,
      pskFor: (m, tags) => {
        mode = m;
        if (viaPairDht ? m !== "pair" : viaDht && m !== "sync") return undefined; // the group DHT key only syncs; the code-derived pairing key only pairs by code (no nearby prompts from the internet)
        if (m === "pair") return this.pairing && this.pairing.expiresAt > this.now() ? { psk: this.pairing.psk } : undefined;
        if (m === "nearby") return this.nearbyOpen() ? { psk: NEARBY_PSK } : undefined; // public psk: the digits both people compare are the only authentication
        if (m === "sync" && this.group && !this.paused) for (const t of tags) { const k = this.group.keys.find((x) => x.tag === t); if (k) return { psk: syncPsk(k.key), tag: t }; }
        return undefined;
      },
      checkRemote: (pub, hello, m) => {
        if (hello?.id !== deviceIdOf(pub)) throw new ChannelError("auth", "device id does not match its key");
        if ((m === "pair" || m === "nearby") && this.liveCount() > 1 && Number(hello?.grp) > 1) throw new ChannelError("protocol", "both devices already have a group", true);
        if (m === "sync") { const d = this.group?.devices[hello.id]; if (!d || !sameKey(Buffer.from(d.pub, "base64"), pub)) throw new ChannelError("auth", "not a member", true); } // only paired, non-revoked devices get past the handshake
      },
    }).then(async (ch) => {
      leave(); sock.setTimeout?.(0);
      if (ch.mode === "nearby") {
        const pr = this.pairing;
        if (!pr || !this.nearbyOpen()) return ch.close();
        pr.nearbyPrompts++; // counted when the attempt starts: aborted attempts use up the budget too
        try { await nearbyHost(ch); } catch { this.srcFail(ip, 2); return ch.close(); }
        if (Number(ch.hello?.grp) > 1 && this.liveCount() <= 1) return this.joinInbound(ch, ip, true);
        return this.pairHost(ch, ip, pr, false, true);
      }
      if (ch.mode === "pair") return Number(ch.hello?.grp) > 1 && this.liveCount() <= 1 ? this.joinInbound(ch, ip) : this.pairHost(ch, ip, this.pairing);
      if (this.group?.devices[deviceIdOf(ch.remoteStatic)]?.revoked) return this.refuseRemoved(ch, deviceIdOf(ch.remoteStatic)); // a removed device gets told, never synced
      return this.runSession(ch, deviceIdOf(ch.remoteStatic), false, viaRelay ? undefined : sock.remoteAddress, viaDht ? "dht" : viaRelay ? "relay" : undefined);
    }, (e) => {
      leave(); sock.destroy();
      if (viaRelay) return;
      if ((mode === "pair" || mode === "nearby") && this.pairing && !(e instanceof ChannelError && (e.code === "closed" || e.soft))) { // a wrong code (or garbage): counts against THIS source, the pairing stays open for others
        this.srcFail(ip);
        // The other device is told "that code was not accepted"; without this line the device that SHOWS the code stays
        // silent, and the two sides cannot be told apart: a code that does not match, or one nobody ever brought here.
        console.warn(`[sync] refused a pairing attempt from ${ip}: ${e instanceof ChannelError ? e.code : "error"} (this device is showing a code; ${this.pairing.failures + 1} attempt(s) did not match it)`);
        if (++this.pairing.failures >= (this.o.maxPairingGlobal ?? 20)) this.stopPairing("too many wrong attempts"); else this.changedDevices();
      } else if (!(e instanceof ChannelError && ((e.code === "closed" && !mode) || e.soft))) {
        if (mode === "pair" || mode === "nearby") console.warn(`[sync] a pairing attempt arrived from ${ip} while no code is open here (it expired, was cancelled, or a new one was started)`);
        this.srcFail(ip, 6); // soft = a known kind of mismatch (old key, revoked member), not a guessing attempt
      }
    });
  }
  /** This device's group DHT public key without starting a node (derived, see dhtSeed): pairing hands it to the other device, which has no session to learn it from yet. */
  private async ownDhtKey(groupId: string): Promise<string | undefined> {
    if (!this.dhtSet.enabled) return undefined;
    try { const D = await (this.o.dht?.loader ?? loadHyperdht)(); return Buffer.from(D.keyPair(dhtSeed(Buffer.from(this.me.priv, "base64"), groupId)).publicKey).toString("hex"); } catch { return undefined; }
  }
  /** A side of pairing: the code was right. Show "Device X wants to join" with the 6 digits and wait for BOTH people to confirm. One code admits ONE device. */
  private async pairHost(ch: Secure, ip: string, pr?: Pairing, keepAfter = false, nearby = false) {
    const g = this.group; if (!g) return ch.close();
    const direction: "incoming" | "outgoing" = pr ? "incoming" : "outgoing";
    if (pr && !this.pairing) return ch.close();
    if (this.pendingJoin || this.joining) { try { await ch.send({ t: "busy" }); } catch { /* gone */ } return ch.close(); }
    const sas = sasOf(ch.transcript), approvalMs = this.o.approvalMs ?? 120_000;
    let settleFn = () => {}; const settled = new Promise<void>((ok) => (settleFn = ok));
    const pj: PendingJoin = { nearby, direction, ch, sas, name: String(ch.hello?.name ?? "device").slice(0, 60), id: deviceIdOf(ch.remoteStatic), ip, since: this.now(), settle: () => { if (pj.hostOk === false || pj.joinerOk === false || (pj.hostOk && pj.joinerOk)) settleFn(); },
      timer: setTimeout(() => { pj.hostOk ??= false; settleFn(); }, approvalMs) };
    pj.timer.unref?.(); this.pendingJoin = pj; this.changedDevices();
    void (async () => { try { const m = await ch.recv(approvalMs + 5000); pj.joinerOk = m?.t === "sas" && m.ok === true; } catch { pj.joinerOk = false; } pj.settle(); })();
    await settled; clearTimeout(pj.timer);
    if (this.disposed) { try { ch.close(); } catch { /* closed */ } return; }
    const approved = pj.hostOk === true && pj.joinerOk === true && (!pr || this.pairing === pr); this.pendingJoin = undefined;
    if (!approved) { try { await ch.send({ t: "denied" }); } catch { /* gone */ } ch.close(); if (pj.hostOk === false && pj.joinerOk !== false) this.srcFail(ip, 1); this.changedDevices(); return; }
    if (pr) this.stopPairing("paired"); // single use: the code is dead from now on
    try {
      const mine = await this.ownDhtKey(g.id); if (mine && g.devices[this.me.id]) g.devices[this.me.id].dht = mine;
      await ch.send({ t: "welcome", group: { id: g.id }, devices: g.devices, keys: [currentKey(g)] });
      const j = await ch.recv(15_000); if (j?.t !== "joined") throw new Error("no confirmation");
      const id = deviceIdOf(ch.remoteStatic), hello = ch.hello;
      g.devices[id] = { id, name: String(hello.name ?? "device").slice(0, 60), pub: ch.remoteStatic.toString("base64"), addedAt: new Date().toISOString(), lastSeen: new Date().toISOString(), dht: validDhtKey(j.dht) };
      const port = Number(j.port) || Number(hello.port) || 0, rhost = ch.socket.remoteAddress?.replace(/^::ffff:/, "");
      if (rhost && port) noteAddr(g.devices[id], { kind: "tcp", host: rhost, port, src: "learned" });
      if ((pr?.keepListening || keepAfter) && !this.listen.enabled) { this.listen = { ...this.listen, enabled: true }; this.ledger.kvSet("listen", this.listen); }
      this.persist(); await ch.send({ t: "added" }); void this.syncListeners(); this.changedDevices(); this.broadcastKeys(); this.tick();
    } catch { /* aborted: the joiner never became a member */ }
    ch.close();
  }

  // ============================================================ outbound
  private tick() {
    this.moves?.tick();
    if (this.paused || !this.group || this.selfRevoked || this.disposed) return;
    const now = this.now();
    if (!this.o.bindHost) { const sig = this.netSig(); if (this.netSigSeen && sig !== this.netSigSeen) void this.networkChanged(); this.netSigSeen = sig; } // Wi-Fi <-> Wi-Fi / mobile: new addresses
    if (!this.o.bindHost && (this.listen.enabled || this.pairing)) void this.syncListeners(); // interfaces come and go; also retries a bind that failed (Wi-Fi not up yet)
    if (this.dhtSet.enabled) { void this.syncDht(); this.checkNetwork(); }
    for (const d of Object.values(this.group.devices)) {
      if (d.id === this.me.id || d.revoked) continue;
      const found = this.mdns?.services().find((s) => s.txt.m === "sync" && s.txt.d === d.id.slice(0, 8) && s.port);
      if (found) { const before = d.addrs?.length ?? 0, k = addrKey({ kind: "tcp", host: found.addrs[0] ?? found.host, port: found.port, src: "mdns" }); const had = d.addrs?.some((a) => addrKey(a) === k); noteAddr(d, { kind: "tcp", host: found.addrs[0] ?? found.host, port: found.port, src: "mdns" }, "mdns"); if (!had || (d.addrs?.length ?? 0) !== before) { this.backoff.delete(d.id); this.upgradeAt.delete(d.id); } } // a new address seen: try it now, not after the back-off
      this.parkFor(d);
      if (this.dialing.has(d.id)) continue;
      if (this.sessions.has(d.id)) { this.upgradeToLan(d); continue; }
      const b = this.backoff.get(d.id); if (b && b.until > now) continue;
      if (!this.candidates(d).length) continue;
      this.dialing.add(d.id);
      this.dialPeer(d).catch(() => { const n = (this.backoff.get(d.id)?.n ?? 0) + 1; this.backoff.set(d.id, { n, until: this.now() + roundBackoff(n) }); this.setProgress(d.id, { state: "offline" }); })
        .finally(() => this.dialing.delete(d.id));
    }
    void this.pumpMedia();
    if (!this.paused && this.sessions.size) void this.avatars?.pump(); // low priority, self-throttled
  }
  /** A session that runs over the DHT is replaced by a LAN / saved-address one as soon as such a connection works (tried every `upgradeMs`, default 60 s; the better session wins on both ends, see runSession). */
  private upgradeToLan(d: Dev, _now = false) {
    const s = this.sessions.get(d.id); if (!s || !(s.via === "dht" || s.via?.startsWith("relay")) || this.dialing.has(d.id)) return;
    const now = this.now(); if (now - (this.upgradeAt.get(d.id) ?? 0) < (this.o.dht?.upgradeMs ?? 15_000)) return;
    this.upgradeAt.set(d.id, now);
    if (!orderAddrs(d).some((a) => a.kind === "tcp")) return;
    this.dialing.add(d.id);
    this.dialPeer(d, true).catch(() => { /* still not reachable directly: keep the DHT session */ }).finally(() => this.dialing.delete(d.id));
  }
  /** Addresses to race: the peer's own list (best first: tcp, then the DHT, then relays), the DHT when enabled and the peer announced a key (only for the device with the larger id: the smaller one listens), plus relays (same rule). */
  private candidates(d: Dev, lanOnly = false): Addr[] {
    const out = orderAddrs(d).filter((a) => a.kind === "tcp" || (!lanOnly && a.kind === "relay" && this.me.id > d.id));
    if (!lanOnly && this.dht && d.dht && this.me.id > d.id) { const i = out.findIndex((a) => a.kind === "relay"); out.splice(i < 0 ? out.length : i, 0, { kind: "dht", src: "learned" }); }
    if (lanOnly) { // moving off the DHT: addresses in one of our own subnets first
      const mine = interfaces().filter((i) => i.family === 4 && !i.internal).map((i) => i.address.split(".").slice(0, 3).join("."));
      const near = (a: Addr) => (a.host && mine.includes(a.host.split(".").slice(0, 3).join(".")) ? 0 : 1);
      return out.map((a, i) => ({ a, i })).sort((x, y) => near(x.a) - near(y.a) || x.i - y.i).map((x) => x.a);
    }
    if (this.me.id > d.id) for (const url of this.relays) if (!out.some((a) => a.kind === "relay" && a.url === url)) out.push({ kind: "relay", url, src: "manual" });
    return out;
  }
  /** The device with the smaller id waits in each relay room for the other one (relay rooms are named by an HMAC of the group key). */
  private parkFor(d: Dev) {
    if (this.me.id > d.id || !this.group) return;
    const bases = new Set([...this.relays, ...(d.addrs ?? []).filter((a) => a.kind === "relay").map((a) => a.url!)]);
    for (const base of bases) {
      const k = base + "|" + d.id; if (this.parkers.has(k) || this.sessions.has(d.id)) continue;
      const ctl = new AbortController(); this.parkers.set(k, ctl);
      const rid = rendezvousId(currentKey(this.group).key, this.me.id, d.id);
      openRelay(base, rid, { signal: ctl.signal, waitMs: 5 * 60_000 }).then((sock) => { this.parkers.delete(k); this.onInbound(sock); this.tick(); }, () => { setTimeout(() => this.parkers.delete(k), 5000).unref?.(); });
    }
  }
  private async dialPeer(d: Dev, upgrade = false) {
    const g = this.group!; if (!upgrade) this.setProgress(d.id, { state: "connecting" });
    let ch: Secure | undefined, err: unknown, used: Addr | undefined; const cands = this.candidates(d, upgrade);
    // the responder picks the key by tag; a lagging device only knows older keys, so try the newest first and fall back (it is then upgraded in-session)
    for (const k of [...g.keys].sort((x, y) => y.revoked.length - x.revoked.length).slice(0, 3)) {
      let r;
      try { r = await raceConnect(cands, (a, signal) => (a.kind === "tcp" ? tcpConnect(a.host!, a.port!, upgrade ? 1500 : 4000, signal) : a.kind === "dht" ? this.dht!.connect(d.dht!, signal, this.o.dht?.connectMs) : openRelay(a.url!, rendezvousId(k.key, this.me.id, d.id), { signal })), { relayDelay: this.o.relayDelayMs, dhtDelay: this.o.dht?.delayMs }); }
      catch (e) { for (const a of cands) markAddr(d, a, false); throw e; } // (a DHT candidate is not stored in d.addrs, markAddr ignores it)
      for (const a of r.failed) markAddr(d, a, false);
      try {
        ch = await dial(r.sock, { mode: "sync", tags: [k.tag], s: { pub: Buffer.from(this.me.pub, "base64"), priv: Buffer.from(this.me.priv, "base64") }, psk: syncPsk(k.key), hello: this.helloMsg(),
          checkRemote: (pub, hello) => { if (hello?.id !== d.id || !sameKey(pub, Buffer.from(d.pub, "base64"))) throw new ChannelError("auth", "unexpected device"); } });
        used = r.addr; break;
      } catch (e) { err = e; if (!(e instanceof ChannelError && e.code === "auth")) break; }
    }
    if (!ch || !used) throw err;
    markAddr(d, used, true); this.backoff.delete(d.id);
    await this.runSession(ch, d.id, true, undefined, used.kind === "relay" ? "relay " + used.url : used.kind === "dht" ? "dht" : `${used.host}:${used.port}`);
  }

  // ============================================================ session
  private async runSession(ch: Secure, peer: string, outbound: boolean, remoteHost?: string, via?: string) {
    const g = this.group; if (!g || this.paused) return ch.close();
    const initiator = outbound ? this.me.id : peer, prev = this.sessions.get(peer);
    const vr = (v?: string) => (v === "dht" ? 1 : 0); // a LAN / saved-address / relay session beats a DHT one on both ends; between equals the smaller initiator id wins
    if (prev) { if (vr(prev.via) < vr(via) || (vr(prev.via) === vr(via) && prev.initiator <= initiator)) return ch.close(); this.closeSession(prev, "superseded"); }
    let wakeFn = () => {};
    const s: Session = { peer, ch, initiator, startedAt: this.now(), inflight: [], sentUpTo: 0, sentG: 0, inflightG: [], sg: 0, sm: 0, headDone: false, wake: () => wakeFn(), closed: false, sent: 0, received: 0, applying: Promise.resolve(), via, rid: 0, pending: new Map(), big: new BigAssembler(BIG_MAX_DEFAULT), serving: 0, snapTried: false, skipEcho: false };
    this.sessions.set(peer, s);
    const d = g.devices[peer]; d.lastSeen = new Date().toISOString();
    if (remoteHost && !outbound && Number(ch.hello?.port) > 0) noteAddr(d, { kind: "tcp", host: remoteHost.replace(/^::ffff:/, ""), port: Number(ch.hello.port), src: "learned" }, "learned");
    this.setProgress(peer, { state: "syncing" }); this.changedDevices();
    let signal: (() => void) | undefined; const waitSignal = (ms: number) => new Promise<void>((ok) => { const t = setTimeout(ok, ms); signal = () => { clearTimeout(t); ok(); }; });
    wakeFn = () => signal?.();
    const cursors = () => this.ledger.kvGet<Record<string, { ledger: string; applied: number; g?: number }>>("cursors") ?? {};
    try {
      await ch.send({ t: "members", devices: g.devices, keys: g.keys, ledger: this.ledger.id, port: this.listeningPort(), addrs: this.selfAddrs() });
      const m = await ch.recv(15_000);
      if (m?.t === "bye" && m.why === "revoked") return this.removedByPeer(s, m.by); // the peer says we were removed
      if (m?.t !== "members") throw new Error("expected members");
      s.peerLedger = String(m.ledger);
      const r = mergeMembership(g, m.devices, m.keys, this.me.id);
      if (g.devices[this.me.id].revoked) return this.removedByPeer(s);
      if (r.revoked.length) this.applyRemoved(r.revoked);
      if (g.devices[peer].revoked) throw new Error("peer revoked");
      { const own = validDhtKey(m.devices?.[peer]?.dht); if (own && g.devices[peer].dht !== own) g.devices[peer].dht = own; } // the device's own report of its DHT key wins
      this.learnAnnounced(g.devices[peer], m.addrs, s); // what the peer says about itself, on every session
      this.persist();
      if (r.added.length || r.revoked.length || r.keysAdded) { this.changedDevices(); if (r.keysAdded) this.advertise(); }
      this.resolveRekey(s);
      this.proxies.presenceChanged(peer, true); this.moves.onUp(peer);
      const cur = cursors()[peer], applied = cur && cur.ledger === s.peerLedger ? cur.applied : 0, gApplied = cur && cur.ledger === s.peerLedger ? Math.max(cur.g ?? 0, applied) : 0;
      await ch.send({ t: "have", of: s.peerLedger, cursor: applied, g: gApplied, empty: this.ledger.count() === 0 }); // `g`: cursor of the global-state class (see the priority classes in the sender loop)
      const recvLoop = (async () => {
        for (;;) {
          const x = await ch.recv(75_000);
          switch (x?.t) {
            case "have": s.peerHave = { of: String(x.of), cursor: Number(x.cursor) || 0, g: x.g === undefined ? undefined : Number(x.g) || 0, empty: !!x.empty }; if (s.peerHave.of !== this.ledger.id) { s.peerHave.cursor = 0; if (s.peerHave.g !== undefined) s.peerHave.g = 0; } while (s.inflight.length && s.inflight[0] <= s.peerHave.cursor) s.inflight.shift(); while (s.inflightG.length && s.inflightG[0] <= (s.peerHave.g ?? 0)) s.inflightG.shift(); signal?.(); break;
            case "batch": {
              if (!Array.isArray(x.entries) || x.entries.length > 2000 || !Number.isFinite(x.upTo)) throw new Error("bad batch");
              const res = await this.store.applyRemote(x.entries as WireEntry[], peer);
              s.received += res.applied;
              // cls "g": global state (accounts, settings, folders, ...) advances only the g cursor; "m": messages only the message cursor; "h": the newest messages ahead of the backlog (no cursor, idempotent); none: both (legacy peers, snapshot tail)
              const cs = cursors(), pc = cs[peer]?.ledger === s.peerLedger ? cs[peer] : undefined, up = Number(x.upTo), cl = x.cls;
              let ap = pc?.applied ?? 0, gg = Math.max(pc?.g ?? 0, ap);
              if (cl === "g") gg = Math.max(gg, up); else if (cl === "m") ap = Math.max(ap, up); else if (cl !== "h") { ap = up; gg = Math.max(gg, up); }
              if (cl !== "h") { cs[peer] = { ledger: s.peerLedger!, applied: ap, g: gg }; this.ledger.kvSet("cursors", cs); await ch.send({ t: "have", of: s.peerLedger, cursor: ap, g: gg }); }
              this.afterApply(res);
              const tot = x.tot && Number.isFinite(x.tot.g) && Number.isFinite(x.tot.m) ? x.tot : undefined;
              this.setProgress(peer, { received: s.received, state: x.more ? "syncing" : undefined, ...(tot ? { accts: { done: x.more ? Math.min(Number(x.sg) || 0, tot.g) : tot.g, total: tot.g }, chats: { done: x.more ? Math.min(Number(x.sm) || 0, tot.m) : tot.m, total: tot.m } } : {}) });
              if (!x.more) this.setProgress(peer, { lastSync: new Date().toISOString() });
              break;
            }
            case "keys": { const rr = mergeMembership(g, x.devices, x.keys, this.me.id); if (g.devices[this.me.id].revoked) return this.removedByPeer(s); if (rr.revoked.length) this.applyRemoved(rr.revoked); this.persist(); if (rr.keysAdded || rr.revoked.length || rr.added.length) { this.advertise(); this.changedDevices(); } this.resolveRekey(s); if (g.devices[peer].revoked) throw new Error("peer revoked"); break; }
            case "ping": break;
            case "bye": if (x.why === "revoked") return this.removedByPeer(s, x.by); return; // that device removed this one: unlink
            case "unlink": { // the other device of a group of two unlinks: so do we (a group of one is meaningless)
              await ch.send({ t: "unlinked" }).catch(() => {});
              void this.leaveLocal({ by: g.devices[peer]?.name ?? "another device", at: new Date().toISOString(), reason: x.removed ? "removed" : "unlinked" }); return;
            }
            case "unlinked": { // answer to our "unlink" (group of two), or the confirmation of a removed device
              if (s.ackWait) { const f = s.ackWait; s.ackWait = undefined; f(); } else this.noteRemovedAck(peer);
              break;
            }
            default: if (!(await this.handleExtra(s, x, cursors))) throw new Error("unknown message");
          }
        }
      })();
      const sendLoop = (async () => {
        let lastPing = this.now();
        while (!s.closed) {
          const have = s.peerHave;
          if (!have || s.inflight.length + s.inflightG.length >= WINDOW) { await waitSignal(1000); if (this.now() - lastPing > 20_000) { lastPing = this.now(); await ch.send({ t: "ping" }); } continue; }
          // Priority classes (peers that report a `g` cursor): 1) global state (accounts, credentials, settings, folders, merges, flags, aliases, chat caches), 2) the newest messages, 3) the message backlog in ledger order, 4) files (blobs.ts, after this loop is idle). Each class has its own cursor, so resumption and idempotency work per class.
          const classes = have.g !== undefined; let cls: "g" | "m" | undefined, from = Math.max(s.sentUpTo, have.cursor), rows: ReturnType<Ledger["since"]>;
          if (classes) {
            const fromG = Math.max(s.sentG, have.g!), gRows = this.ledger.sinceClass(fromG, 400, false);
            if (gRows.length) { cls = "g"; from = fromG; rows = gRows; }
            else {
              if (this.wantSnapshot(s)) { await this.sendSnapshot(s); continue; }
              if (!s.headDone && have.cursor === 0) { s.headDone = true; await this.sendHead(s); continue; }
              cls = "m"; rows = this.ledger.sinceClass(from, 400, true);
            }
            if (!s.tot) s.tot = { g: this.ledger.countClass(Math.max(s.sentG, have.g!), false), m: this.ledger.countClass(from, true) };
          } else { if (this.wantSnapshot(s)) { await this.sendSnapshot(s); continue; } rows = this.ledger.since(from, 400); }
          if (!rows.length) {
            this.setProgress(peer, { state: "idle", pending: 0 });
            await waitSignal(10_000); if (this.now() - lastPing > 20_000) { lastPing = this.now(); await ch.send({ t: "ping" }); } continue;
          }
          const mp = this.store.maps(), entries: WireEntry[] = []; let bytes = 0, upTo = from, last = false;
          for (const e of rows) {
            const acct = accountOfKey(e.key);
            let w: WireEntry | undefined;
            if (acct && this.modeOf(acct) === "none") w = undefined;
            else if (parseKey(e.key).kind === "cr") w = await this.credsEntry(e.key, e.hlc);
            else if (e.src === peer && ((cls === "g" ? have.g! : have.cursor) > 0 || s.skipEcho)) w = undefined; // the peer already has what it gave us
            else w = this.store.entry(e, mp);
            const sz = w ? JSON.stringify(w).length : 0;
            if (w && sz > 400_000) w = undefined;
            if (w && bytes + sz > BATCH_BYTES && entries.length) break;
            if (w) { entries.push(w); bytes += sz; }
            upTo = e.seq;
          }
          const scanned = rows.indexOf(rows.find((r) => r.seq === upTo)!) + 1;
          if (cls === "g") { s.sentG = upTo; s.inflightG.push(upTo); s.sg += scanned; last = scanned === rows.length && rows.length < 400 && !this.ledger.sinceClass(Math.max(s.sentUpTo, have.cursor), 1, true).length; }
          else { s.sentUpTo = upTo; s.inflight.push(upTo); if (cls === "m") s.sm += scanned; last = upTo >= this.ledger.maxSeq(); if (cls === "m") last = scanned === rows.length && rows.length < 400; }
          s.sent += entries.length;
          await ch.send({ t: "batch", entries, upTo, more: !last, ...(cls ? { cls, tot: s.tot, sg: s.sg, sm: s.sm } : {}) });
          this.setProgress(peer, { sent: s.sent, pending: Math.max(0, this.ledger.maxSeq() - upTo), state: "syncing", ...(cls && s.tot ? { out: { accts: { done: last ? s.tot.g : Math.min(s.sg, s.tot.g), total: s.tot.g }, chats: { done: last ? s.tot.m : Math.min(s.sm, s.tot.m), total: s.tot.m } } } : {}) }); // the sending side shows its progress too
        }
      })();
      if (this.unlinkPending?.peer === peer) void this.sendUnlink(s, 5000); // the instruction waited for this device to come online
      await Promise.race([recvLoop, sendLoop]);
    } catch (e) {
      const ex = e as Error; if (!s.closed) this.setProgress(peer, { state: "error", error: ex.message });
    } finally {
      this.closeSession(s, "ended");
    }
  }
  private closeSession(s: Session, why: string) {
    if (s.closed) return; s.closed = true; s.wake();
    for (const p of s.pending.values()) { clearTimeout(p.timer); p.fail(new Error("session closed")); } s.pending.clear();
    if (s.snapWait) { clearTimeout(s.snapWait.timer); s.snapWait.ok(undefined); }
    s.big.clear();
    if (s.snapRx?.fd !== undefined) { try { closeSync(s.snapRx.fd); } catch { /* closed */ } }
    try {
      const gd = this.group?.devices[s.peer]; // a removed device is told by whom, and gets a moment to confirm that it unlinked
      void s.ch.send(why === "revoked" ? { t: "bye", why, by: this.group?.devices[gd?.revokedBy ?? ""]?.name } : { t: "bye" }).catch(() => {});
    } catch { /* ignore */ }
    setTimeout(() => s.ch.close(), why === "revoked" ? 1500 : 30);
    const mine = this.sessions.get(s.peer) === s;
    if (mine) this.sessions.delete(s.peer);
    if (mine && !this.disposed) { this.proxies.presenceChanged(s.peer, false); this.moves.onDown(s.peer); }
    if (!this.disposed) { if (why !== "superseded") { const p = this.progress.get(s.peer); if (p && p.state !== "error") this.setProgress(s.peer, { state: "offline", phase: undefined }); } this.changedDevices(); }
  }
  private afterApply(res: { chats: Set<string>; accounts: boolean; global: boolean }) {
    for (const c of res.chats) this.chatsDirty.add(c);
    if (!res.chats.size && !res.accounts && !res.global) return;
    if (this.reloadT) return;
    // a backlog arrives as hundreds of batches: reload at most every ~1.5 s while they keep coming (each reload makes the UI rebuild its chat list), 250 ms for an isolated change
    const since = Date.now() - this.lastReload, wait = res.accounts ? 20 : since < 10_000 ? 1500 : 250; // accounts arrive first: show them at once
    this.reloadT = setTimeout(async () => {
      this.reloadT = undefined; const chats = [...this.chatsDirty]; this.chatsDirty.clear(); this.lastReload = Date.now();
      try { await this.host.reload({ search: false }); } catch { /* hub shutting down */ } // the search index is kept current message by message (SyncCtx.index)
      for (const c of chats.slice(0, 200)) this.host.emit("history-updated", { chatId: c });
    }, wait); this.reloadT.unref?.();
  }
  private wakeSoon() {
    if (this.wakeT) return;
    this.wakeT = setTimeout(() => { this.wakeT = undefined; for (const s of this.sessions.values()) s.wake(); }, 40); this.wakeT.unref?.();
  }
  private setProgress(peer: string, p: Partial<Progress>) {
    const cur = this.progress.get(peer) ?? { state: "offline" as const, sent: 0, received: 0, pending: 0 };
    const next = { ...cur, ...Object.fromEntries(Object.entries(p).filter(([k, v]) => v !== undefined || k === "phase")) } as Progress;
    this.progress.set(peer, next);
    const n = Date.now(); if (n - this.progT > 250 || p.state || "phase" in p) { this.progT = n; this.host.emit("sync-progress", { peer, ...next, media: this.mediaActive }); }
  }
  private setProgressSoon() { const n = Date.now(); if (n - this.progT > 250) { this.progT = n; this.host.emit("sync-progress", { media: this.mediaActive }); } }

  // ============================================================ rpc + big messages over a session
  private pushFrame(peer: string, frame: object): boolean {
    const s = this.sessions.get(peer); if (!s || s.closed) return false;
    void this.sendMsg(s, frame).catch(() => {}); return true;
  }
  private async sendMsg(s: Session, obj: any) {
    const j = JSON.stringify(obj);
    if (j.length < RPC_INLINE) await s.ch.send(obj); else await sendBig(s.ch, randomBytes(8).toString("hex"), "msg", obj);
  }
  rpc(peer: string, method: string, params: unknown, ms = 60_000): Promise<any> {
    const s = this.sessions.get(peer); if (!s || s.closed) return Promise.reject(new Error("not connected to that device"));
    const id = ++s.rid;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { s.pending.delete(id); fail(new Error("the other device did not answer in time (timed out)")); }, ms);
      s.pending.set(id, { ok, fail, timer });
      this.sendMsg(s, { t: "rpc", id, m: method, p: params }).catch((e) => { clearTimeout(timer); s.pending.delete(id); fail(e); });
    });
  }
  private handlers(): Record<string, (peer: string, p: any) => Promise<any> | any> {
    return {
      "blob.q": (_p, p) => this.blobs?.query(p) ?? null,
      "blob.get": (_p, p) => this.blobs?.range(p) ?? null,
      "av.list": (_p, p) => this.avatars?.list(p) ?? { items: [], more: false },
      "av.get": (_p, p) => this.avatars?.get(p) ?? null,
      "av.hint": (peer) => { this.avatars?.nudge(peer); return null; },
      "proxy.call": (peer, p) => this.proxies.serve(peer, p),
      "relay.ask": (peer, p) => ({ state: this.proxies.askedBy(peer, String(p?.acct)) }),
      "cred.get": (_p, p) => this.collectCreds(String(p?.acct), true),
    };
  }
  /** Frames beyond the ledger protocol. Returns false for an unknown type. */
  private async handleExtra(s: Session, x: any, cursors: () => Record<string, { ledger: string; applied: number; g?: number }>): Promise<boolean> {
    switch (x?.t) {
      case "big": { const r = s.big.push(x); if (r && r.kind === "msg") await this.handleExtra(s, r.payload, cursors); return true; }
      case "rpc": {
        if (s.serving >= 32) { void this.sendMsg(s, { t: "rpc-res", id: x.id, e: "busy" }).catch(() => {}); return true; }
        s.serving++;
        void (async () => {
          try { const h = this.handlers()[String(x.m)]; if (!h) throw new Error("unknown request"); const r = await h(s.peer, x.p); await this.sendMsg(s, { t: "rpc-res", id: x.id, r: r === undefined ? null : r }); }
          catch (e) { try { await this.sendMsg(s, { t: "rpc-res", id: x.id, e: errmsg(e).slice(0, 500) }); } catch { /* gone */ } }
          finally { s.serving--; }
        })(); return true;
      }
      case "rpc-res": { const p = s.pending.get(x.id); if (p) { clearTimeout(p.timer); s.pending.delete(x.id); if (x.e !== undefined) p.fail(new Error(String(x.e))); else p.ok(x.r); } return true; }
      case "ev": if (typeof x.acct === "string" && x.e && typeof x.e.type === "string") this.proxies.onEvent(x.acct, x.e as CoreEvent); return true;
      case "addrs": { // the peer's addresses changed while the session stays up (it moved to another network but kept a path to us)
        const d = this.group?.devices[s.peer]; if (d) this.learnAnnounced(d, x.addrs, s);
        return true;
      }
      case "offers": this.proxies.setOffers(s.peer, x.accounts); return true;
      case "sub": this.proxies.subscribe(s.peer, Array.isArray(x.accts) ? x.accts.map(String) : []); return true;
      case "snap-offer": await this.onSnapOffer(s, x); return true;
      default: if (typeof x?.t === "string" && x.t.startsWith("mv-")) return this.moves.onFrame(s.peer, x); // device-to-device move: point to point, never through the ledger
      case "snap-go": case "snap-no": case "snap-ack": { if (s.snapWait && s.snapWait.kinds.includes(x.t)) { clearTimeout(s.snapWait.timer); const w = s.snapWait; s.snapWait = undefined; w.ok(x); } return true; }
      case "snap-chunk": this.onSnapChunk(s, x); return true;
      case "snap-end": await this.onSnapEnd(s, x, cursors); return true;
    }
    return false;
  }

  // ============================================================ initial transfer (snapshot)
  private snapDir() { const d = join(this.o.dir ?? join(process.env.TMPDIR ?? "/tmp", "unimsg-sync-" + this.me.id.slice(0, 8)), "snapshots"); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }
  private wantSnapshot(s: Session) {
    const h = s.peerHave; if (!h || s.snapTried || this.group === undefined) return false;
    const max = this.ledger.maxSeq(), min = h.empty ? (this.o.snapshot?.minEntitiesEmpty ?? 50) : (this.o.snapshot?.minEntities ?? 800);
    return (h.cursor === 0 && max >= min) || max - h.cursor > 20_000;
  }
  /** The newest messages first (a fresh peer): the chat list is usable long before the backlog is through. They advance no cursor; the ordinary pass sends them again and the receiver skips them. */
  private async sendHead(s: Session) {
    const mp = this.store.maps(), entries: WireEntry[] = []; let bytes = 0;
    const flush = async () => { if (!entries.length) return; const e = entries.splice(0); bytes = 0; s.sent += e.length; await s.ch.send({ t: "batch", entries: e, upTo: 0, more: true, cls: "h" }); };
    for (const r of this.ledger.newestMessages(600)) {
      const acct = accountOfKey(r.key); if (acct && this.modeOf(acct) === "none") continue;
      const w = this.store.entry(r, mp); if (!w) continue; const sz = JSON.stringify(w).length; if (sz > 400_000) continue;
      if (bytes + sz > BATCH_BYTES) await flush(); entries.push(w); bytes += sz;
    }
    await flush();
  }
  private waitSnap(s: Session, kinds: string[], ms: number): Promise<any> {
    return new Promise((ok) => { const timer = setTimeout(() => { s.snapWait = undefined; ok(undefined); }, ms); s.snapWait = { kinds, ok, timer }; });
  }
  /** Sender: offer, stream the encrypted archive from where the receiver says it stopped, wait for the receiver to apply it. */
  private async sendSnapshot(s: Session) {
    s.snapTried = true; const peer = s.peer, g = this.group!, key = currentKey(g), have = s.peerHave!;
    const recs = this.ledger.kvGet<Record<string, any>>("snapshots") ?? {}; let rec = recs[peer];
    try {
      if (!rec || !existsSync(rec.file) || this.now() - rec.createdAt > 3600_000 || rec.tag !== key.tag || rec.cursor < have.cursor) {
        if (rec) rmSync(rec.file, { force: true });
        const id = randomBytes(8).toString("hex"), file = join(this.snapDir(), `out-${peer.slice(0, 8)}-${id}.unimsg-sync`);
        this.setProgress(peer, { state: "syncing", phase: "snapshot", snapDone: 0, snapTotal: 0, snapDir: "out" });
        const b = await buildSnapshot(file, { ledger: this.ledger, store: this.store, passphrase: snapshotPassphrase(key.key, id), modeOf: (a) => this.modeOf(a) });
        rec = { id, file, size: b.size, sha: b.sha256, cursor: b.cursor, entries: b.entries, tag: key.tag, createdAt: this.now() }; recs[peer] = rec; this.ledger.kvSet("snapshots", recs);
      }
      const goP = this.waitSnap(s, ["snap-go", "snap-no"], 30_000);
      await s.ch.send({ t: "snap-offer", id: rec.id, size: rec.size, sha: rec.sha, cursor: rec.cursor, tag: rec.tag, ledger: this.ledger.id, entries: rec.entries });
      const go = await goP;
      if (!go || go.t !== "snap-go" || go.id !== rec.id) { this.setProgress(peer, { phase: undefined }); return; } // refused or no answer: plain ledger replay
      const piece = this.o.snapshot?.piece ?? 96 * 1024, fd = openSync(rec.file, "r"); let off = Math.max(0, Math.min(Number(go.from) || 0, rec.size)), n = 0, abort = false;
      try {
        while (off < rec.size && !s.closed) {
          const buf = Buffer.alloc(Math.min(piece, rec.size - off)); readSync(fd, buf, 0, buf.length, off);
          await s.ch.send({ t: "snap-chunk", id: rec.id, off, d: buf.toString("base64") }); off += buf.length; n++;
          this.setProgress(peer, { phase: "snapshot", snapDone: off, snapTotal: rec.size, snapDir: "out" });
          this.o.snapshot?.afterChunk?.(n, () => { abort = true; }); if (abort) { s.ch.close(); throw new Error("interrupted (test)"); }
        }
      } finally { closeSync(fd); }
      const ackP = this.waitSnap(s, ["snap-ack"], 10 * 60_000);
      await s.ch.send({ t: "snap-end", id: rec.id });
      const ack = await ackP;
      if (!ack?.ok) { if (ack?.error && ack.error !== "incomplete") { rmSync(rec.file, { force: true }); delete recs[peer]; this.ledger.kvSet("snapshots", recs); } this.setProgress(peer, { phase: undefined }); return; }
      // the receiver now holds everything up to rec.cursor; credentials never ride in a snapshot, so send them (they still wait for the user's confirmation there)
      const crs: WireEntry[] = []; let from = 0;
      for (;;) { const rows = this.ledger.since(from, 500); if (!rows.length) break; for (const e of rows) { from = e.seq; if (e.seq <= rec.cursor && parseKey(e.key).kind === "cr" && this.modeOf(accountOfKey(e.key)) !== "none") { const w = await this.credsEntry(e.key, e.hlc); if (w) crs.push(w); } } if (from >= rec.cursor) break; }
      s.sentUpTo = Math.max(s.sentUpTo, rec.cursor); s.sentG = Math.max(s.sentG, rec.cursor); s.inflight.push(rec.cursor);
      await s.ch.send({ t: "batch", entries: crs, upTo: rec.cursor, more: true });
      rmSync(rec.file, { force: true }); delete recs[peer]; this.ledger.kvSet("snapshots", recs);
      this.setProgress(peer, { phase: undefined, lastSync: new Date().toISOString() });
    } catch (e) { this.setProgress(peer, { phase: undefined }); if (!s.closed) throw e; return; }
  }
  private async onSnapOffer(s: Session, x: any) {
    const g = this.group!; const ok = typeof x.id === "string" && /^[0-9a-f]{16}$/.test(x.id) && Number.isSafeInteger(x.size) && x.size > 0 && x.size < 16 * 2 ** 30 && typeof x.sha === "string" && /^[0-9a-f]{64}$/.test(x.sha) && Number.isSafeInteger(x.cursor) && typeof x.ledger === "string" && g.keys.some((k) => k.tag === x.tag);
    if (!ok || x.ledger !== s.peerLedger) { await s.ch.send({ t: "snap-no", id: x.id }); return; }
    const all = this.ledger.kvGet<Record<string, any>>("snapIn") ?? {}, prev = all[s.peer], file = join(this.snapDir(), `in-${s.peer.slice(0, 8)}.part`);
    let got = 0;
    if (prev && prev.id === x.id && existsSync(file)) { got = Math.min(statSync(file).size, prev.got ?? 0); if (statSync(file).size > got) { const b = readFileSync(file).subarray(0, got); writeFileSync(file, b, { mode: 0o600 }); } }
    else { rmSync(file, { force: true }); }
    if (got === 0) writeFileSync(file, Buffer.alloc(0), { mode: 0o600 });
    s.snapRx = { id: x.id, got, size: x.size, sha: x.sha, cursor: x.cursor, ledger: x.ledger, tag: x.tag, file, lastSaved: got };
    all[s.peer] = { id: x.id, got }; this.ledger.kvSet("snapIn", all);
    this.setProgress(s.peer, { state: "syncing", phase: "snapshot", snapDone: got, snapTotal: x.size, snapDir: "in" });
    await s.ch.send({ t: "snap-go", id: x.id, from: got });
  }
  private onSnapChunk(s: Session, x: any) {
    const r = s.snapRx; if (!r || x.id !== r.id || x.off !== r.got || typeof x.d !== "string") throw new Error("bad snapshot chunk");
    const b = Buffer.from(x.d, "base64"); if (!b.length || r.got + b.length > r.size) throw new Error("bad snapshot chunk");
    appendFileSync(r.file, b, { mode: 0o600 }); r.got += b.length;
    if (r.got - r.lastSaved >= 1 << 20) { r.lastSaved = r.got; const all = this.ledger.kvGet<Record<string, any>>("snapIn") ?? {}; all[s.peer] = { id: r.id, got: r.got }; this.ledger.kvSet("snapIn", all); }
    this.setProgress(s.peer, { phase: "snapshot", snapDone: r.got, snapTotal: r.size, snapDir: "in" });
  }
  private async onSnapEnd(s: Session, x: any, cursors: () => Record<string, { ledger: string; applied: number; g?: number }>) {
    const r = s.snapRx; if (!r || x.id !== r.id) throw new Error("unexpected snapshot end");
    const all = this.ledger.kvGet<Record<string, any>>("snapIn") ?? {}, fail = async (why: string, drop: boolean) => { if (drop) { rmSync(r.file, { force: true }); delete all[s.peer]; this.ledger.kvSet("snapIn", all); } s.snapRx = undefined; this.setProgress(s.peer, { phase: undefined }); await s.ch.send({ t: "snap-ack", id: r.id, ok: false, error: why }); };
    all[s.peer] = { id: r.id, got: r.got }; this.ledger.kvSet("snapIn", all);
    if (r.got !== r.size) return fail("incomplete", false);
    if ((await sha256File(r.file)) !== r.sha) return fail("hash mismatch", true);
    const key = this.group!.keys.find((k) => k.tag === r.tag); if (!key) return fail("unknown key", true);
    try {
      await applySnapshot(r.file, snapshotPassphrase(key.key, r.id), { expectLedger: s.peerLedger, batch: this.ledger.count() === 0 ? 2000 : 1000, apply: (e) => this.store.applyRemote(e, s.peer),
        onProgress: (n) => this.setProgress(s.peer, { phase: "snapshot", snapDone: r.size, snapTotal: r.size, received: s.received + n }) });
    } catch (e) { return fail(errmsg(e), true); }
    const cs = cursors(); cs[s.peer] = { ledger: s.peerLedger!, applied: r.cursor, g: r.cursor }; this.ledger.kvSet("cursors", cs);
    rmSync(r.file, { force: true }); delete all[s.peer]; this.ledger.kvSet("snapIn", all); s.snapRx = undefined; s.skipEcho = true;
    this.afterApply({ chats: new Set(), accounts: true, global: true });
    this.setProgress(s.peer, { phase: undefined, lastSync: new Date().toISOString() });
    await s.ch.send({ t: "snap-ack", id: r.id, ok: true }); await s.ch.send({ t: "have", of: s.peerLedger, cursor: r.cursor, g: r.cursor });
  }

  // ============================================================ media (lazy blob sync)
  private wantMedia(m: { chatId: string; id: string; attachments?: { id: string; size?: number }[] }) {
    const acct = acctOfChat(m.chatId); if (!acct || this.modeOf(acct) === "none") return;
    for (const a of m.attachments ?? []) {
      const ref = refOf(m.chatId, m.id, a.id); if (this.host.media.has(acct, ref)) continue;
      this.ledger.wantAdd({ ref, acct, chat: m.chatId, msg: m.id, att: a.id, size: Number(a.size) || 0, time: (m as any).time ?? "" });
    }
  }
  /** Hub hook: the user opened an attachment this device does not have. */
  async fetchMedia(_acct: string, chat: string, msg: string, att: string) {
    await this.ready; if (!this.blobs || !this.group || this.paused || !this.sessions.size) return undefined;
    return this.blobs.fetch({ chat, msg, att }, { maxBytes: HARD_MAX });
  }
  /** Background: drain the want list under the per-device policy. */
  private async pumpMedia() {
    if (this.pumping || !this.blobs || this.policy.mode === "off" || (this.policy.mode === "wifi" && this.metered) || !this.sessions.size || this.paused) return;
    this.pumping = true;
    try {
      for (let guard = 0; guard < 200; guard++) {
        const items = this.ledger.wantNext(this.now(), 5); if (!items.length || !this.sessions.size || this.paused) break;
        let progressed = false;
        for (const w of items) {
          if ((this.policy.mode as string) === "off" || (this.policy.mode === "wifi" && this.metered)) return;
          if (this.modeOf(w.acct) === "none" || (this.host.connector(w.acct) && !this.proxies.isProxy(w.acct)) || this.host.media.has(w.acct, w.ref) || (w.size && w.size > this.policy.maxFileMB * 1048576)) { this.ledger.wantDone(w.ref); progressed = true; continue; }
          if (this.ledger.blobTotal() + w.size > this.policy.maxTotalMB * 1048576) return;
          const b = await this.blobs.fetch({ chat: w.chat, msg: w.msg, att: w.att }, { maxBytes: this.policy.maxFileMB * 1048576 });
          if (b) { this.ledger.wantDone(w.ref); progressed = true; this.host.emit("sync-progress", { media: null, mediaFetched: w.ref }); }
          else if (w.tries >= 5) this.ledger.wantDone(w.ref); else this.ledger.wantRetry(w.ref, this.now() + Math.min(600_000 * 2 ** w.tries, 6 * 3600_000));
        }
        if (!progressed) break;
      }
    } finally { this.pumping = false; this.changedDevices(); }
  }

  // ============================================================ membership / revocation
  private async revokeDevice(id: string) {
    const g = this.group; if (!g) throw new Error("Sync is not set up.");
    if (id === this.me.id) throw new Error("Use \"Leave this group\" to remove this device.");
    if (!g.devices[id] || g.devices[id].revoked) throw new Error("That device is not in the group.");
    if (!Object.values(g.devices).some((d) => d.id !== id && d.id !== this.me.id && !d.revoked)) return this.startUnlink(id, "remove"); // group of two: both unlink
    // group of three or more: a tombstone (who, when) + a fresh key without the device. Connected members get it now, the others on their next session (members / keys frames, over any path);
    // the removed device is told by every member that sees it, or when it next connects to one.
    revoke(g, id, this.me.id); this.persist();
    this.applyRemoved([id]);
    this.advertise(); this.broadcastKeys(); this.changedDevices(); return {};
  }
  /** Everything that tied this device to the removed ones: sessions (they are told), relay permissions / offers, addresses. */
  private applyRemoved(ids: string[]) {
    const g = this.group; if (!g) return;
    for (const id of ids) {
      if (id === this.me.id) continue;
      const s = this.sessions.get(id); if (s) this.closeSession(s, "revoked");
      this.proxies.forgetDevice(id); void this.proxies.removedBy(id);
      const d = g.devices[id]; if (d) { delete d.addrs; delete d.dht; }
      this.backoff.delete(id); this.progress.delete(id);
    }
    this.persist(); this.changedDevices();
    if (this.liveCount() <= 1 && !this.unlinkPending && !this.selfRevoked) { // everybody else is gone (two devices removed each other concurrently): nothing left to sync with
      const last = g.devices[ids[ids.length - 1]];
      void this.leaveLocal({ by: g.devices[last?.revokedBy ?? ""]?.name ?? "another device", at: new Date().toISOString(), reason: "alone" });
    }
  }
  /** A removed device confirmed (over a closing session) that it unlinked itself. */
  private noteRemovedAck(peer: string) {
    const d = this.group?.devices[peer]; if (!d?.revoked || d.removedAck) return;
    d.removedAck = new Date().toISOString(); this.persist(); this.changedDevices(); this.broadcastKeys();
  }
  /** A removed device connected to us (it still knows an older key): tell it who removed it, wait for its confirmation, drop the connection. */
  private async refuseRemoved(ch: Secure, id: string) {
    const g = this.group, d = g?.devices[id]; if (!g || !d) return ch.close();
    try {
      await ch.send({ t: "bye", why: "revoked", by: g.devices[d.revokedBy ?? ""]?.name });
      for (let i = 0; i < 4; i++) { const a = await ch.recv(3000); if (a?.t === "unlinked") { this.noteRemovedAck(id); break; } }
    } catch { /* gone */ }
    ch.close();
  }
  /** The other device of a group of two (or, for a removal, the device to be removed) must unlink. Delivered now when it is online, otherwise as soon as it is. */
  private async startUnlink(peer: string, reason: "leave" | "remove") {
    const d = this.group!.devices[peer];
    this.unlinkPending = { peer, name: d.name, since: new Date().toISOString(), reason }; this.ledger.kvSet("unlinkPending", this.unlinkPending);
    this.changedDevices();
    const t0 = Date.now(), wait = this.o.unlinkWaitMs ?? 5000;
    if (!this.sessions.has(peer)) { for (const k of Object.keys(this.group!.devices)) this.backoff.delete(k); this.tick(); }
    while (!this.sessions.get(peer) && Date.now() - t0 < wait) await new Promise((r) => setTimeout(r, 100));
    const s = this.sessions.get(peer);
    const done = !!s && (await this.sendUnlink(s, Math.max(1500, wait - (Date.now() - t0))));
    return { pending: !done, deviceName: d.name };
  }
  private async sendUnlink(s: Session, ms: number): Promise<boolean> {
    const p = this.unlinkPending; if (!p || p.peer !== s.peer || s.closed || s.ackWait) return false;
    const ack = new Promise<boolean>((ok) => { const t = setTimeout(() => { s.ackWait = undefined; ok(false); }, ms); s.ackWait = () => { clearTimeout(t); ok(true); }; });
    try { await s.ch.send({ t: "unlink", removed: p.reason === "remove" }); } catch { s.ackWait = undefined; return false; }
    if (!(await ack)) return false;
    await this.leaveLocal(); return true;
  }
  /** `s.peer` told us (or our own membership list says) that we were removed: confirm, then unlink (the archive stays, the group state goes). */
  private async removedByPeer(s: Session, byName?: unknown) {
    const me = this.group?.devices[this.me.id], g = this.group;
    await s.ch.send({ t: "unlinked" }).catch(() => {});
    const by = typeof byName === "string" && byName ? byName.slice(0, 60) : g?.devices[me?.revokedBy ?? ""]?.name ?? "another device";
    await this.leaveLocal({ by, at: me?.revoked ?? new Date().toISOString(), reason: "removed" });
  }
  /** Tell every connected member the membership + keys (they adopt keys that exclude... never a revoked one: those sessions are closed). */
  private broadcastKeys() {
    const g = this.group; if (!g) return;
    for (const s of this.sessions.values()) if (!g.devices[s.peer]?.revoked) void s.ch.send({ t: "keys", devices: g.devices, keys: g.keys }).catch(() => {});
  }
  /** Concurrent revocations: the member with the smaller id of a connected pair mints the key that excludes everybody revoked so far. */
  private resolveRekey(s: Session) {
    const g = this.group; if (!g || !needsRekey(g)) return;
    if (this.me.id < s.peer) { rekey(g); this.persist(); this.advertise(); this.broadcastKeys(); }
  }

  // ============================================================ credentials (token-style accounts only)
  private hashCreds(acct: string) {
    const h = createHash("sha256"); const files = sessionFiles(join(this.host.accountsDir, acct));
    for (const f of files) { h.update(f.rel); h.update(readFileSync(f.abs)); }
    return { files, hash: h.digest("hex") };
  }
  private refreshCreds() {
    if (!this.store.ctx) return;
    for (const a of this.store.listAccounts()) {
      if (this.modeOf(a.id) !== "credentials" || !CREDENTIAL_PROVIDERS.has(a.provider) || this.sharedFrom(a.id)) continue;
      const { files, hash } = this.hashCreds(a.id); if (!files.length) continue;
      const k = ekey("cr", a.id), row = this.ledger.get(k);
      if (row?.meta?.h !== hash) { this.ledger.put({ key: k, hlc: this.clock.tick(), meta: { h: hash } }); this.wakeSoon(); }
    }
  }
  /** The session of an account as portable files (the provider's own export hook re-seals things like a key kept outside the folder), within the size limits. */
  private async collectCreds(acct: string, forPeer = false): Promise<any> {
    const a = this.store.listAccounts().find((x) => x.id === acct);
    if (!a || this.modeOf(acct) !== "credentials" || !CREDENTIAL_PROVIDERS.has(a.provider) || this.sharedFrom(acct)) { if (forPeer) throw new Error("not shared"); return undefined; }
    const dir = join(this.host.accountsDir, acct); let files = sessionFiles(dir).map((f) => ({ rel: f.rel, abs: f.abs, size: f.size })) as { rel: string; abs?: string; size: number; data?: Buffer }[];
    const hook = this.host.provider(a.provider)?.exportSession;
    if (hook) { const ex = await hook(dir).catch(() => undefined); if (ex) { const omit = new Set(ex.omit ?? []); files = files.filter((f) => !omit.has(f.rel)); for (const f of ex.files ?? []) files.push({ rel: f.rel, size: f.data.length, data: Buffer.from(f.data) }); } }
    if (!files.length) return undefined;
    const total = files.reduce((n, f) => n + f.size, 0);
    if (files.length > LIMITS.credFiles || total > LIMITS.credBytes || files.some((f) => f.size > LIMITS.credBytes / 2)) {
      this.credsErr[acct] = files.length > LIMITS.credFiles ? `This login has ${files.length} files; at most ${LIMITS.credFiles} can be shared.` : `This login is ${(total / 1048576).toFixed(1)} MB; the limit for sharing is ${LIMITS.credBytes / 1048576} MB.`;
      this.changedDevices(); return undefined;
    }
    delete this.credsErr[acct];
    return { provider: a.provider, bytes: total, files: files.map((f) => ({ rel: f.rel, b64: (f.data ?? readFileSync(f.abs!)).toString("base64") })) };
  }
  private async credsEntry(k: string, hlc: string): Promise<WireEntry | undefined> {
    const acct = parseKey(k).id, c = await this.collectCreds(acct); if (!c) return undefined;
    if (c.bytes <= LIMITS.inlineCred) return { k, h: hlc, v: { provider: c.provider, files: c.files } };
    return { k, h: hlc, v: { provider: c.provider, chunked: { bytes: c.bytes, files: c.files.length } } }; // the receiver pulls the files in pieces (rpc cred.get)
  }
  private stageCredentials(acct: string, v: any, hlc: string, from: string) {
    const a = this.store.listAccounts().find((x) => x.id === acct);
    if (!a || !CREDENTIAL_PROVIDERS.has(a.provider) || v?.provider !== a.provider || this.modeOf(acct) === "none") return;
    if ((this.lastCreds.get(acct) ?? this.ledger.kvGet<Record<string, string>>("credSeen")?.[acct] ?? "") >= hlc) return;
    if (v.chunked) {
      const b = Number(v.chunked.bytes) || 0, id = acct + "|" + hlc;
      if (b > LIMITS.credBytes) { this.credsErr[acct] = `The other device offers a ${(b / 1048576).toFixed(1)} MB login; the limit is ${LIMITS.credBytes / 1048576} MB.`; this.changedDevices(); return; }
      if (this.pulling.has(id)) return; this.pulling.add(id);
      void this.rpc(from, "cred.get", { acct }, 5 * 60_000).then((r) => this.stageFiles(acct, a.provider, r?.files, hlc, from), (e) => { this.credsErr[acct] = "Couldn't receive the login: " + errmsg(e); this.changedDevices(); }).finally(() => this.pulling.delete(id));
      return;
    }
    this.stageFiles(acct, a.provider, v.files, hlc, from);
  }
  private stageFiles(acct: string, provider: string, raw: unknown, hlc: string, from: string) {
    if (!Array.isArray(raw)) return;
    if (raw.length > LIMITS.credFiles) { this.credsErr[acct] = `The login has too many files (${raw.length}).`; this.changedDevices(); return; }
    let total = 0; const files = raw.filter((f: any) => typeof f?.rel === "string" && typeof f?.b64 === "string" && !unsafeRel(f.rel));
    for (const f of files) total += Math.floor((f.b64.length * 3) / 4);
    if (!files.length) return;
    if (total > LIMITS.credBytes) { this.credsErr[acct] = `The login is ${(total / 1048576).toFixed(1)} MB; the limit is ${LIMITS.credBytes / 1048576} MB.`; this.changedDevices(); return; }
    delete this.credsErr[acct];
    this.stash(acct, files);
    const pend = this.ledger.kvGet<Record<string, any>>("pendingCreds") ?? {};
    pend[acct] = { from, hlc, provider, files: files.length, bytes: total }; this.ledger.kvSet("pendingCreds", pend);
    this.host.emit("sync-credentials", this.pendingCreds());
  }
  // staged (not yet confirmed) session files: sealed on disk next to sync.db, or in memory without a directory
  private stashFile(acct: string) { return this.o.dir ? join(this.o.dir, "staged-" + createHash("sha256").update(acct).digest("hex").slice(0, 16) + ".sealed") : undefined; }
  private stash(acct: string, files: any[]) {
    const f = this.stashFile(acct); if (!f) { this.staged.set(acct, files); return; }
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", this.sealKey, iv), ct = Buffer.concat([c.update(JSON.stringify(files), "utf8"), c.final()]);
    writeFileSync(f, Buffer.concat([iv, c.getAuthTag(), ct]), { mode: 0o600 });
  }
  private unstash(acct: string): any[] | undefined {
    const f = this.stashFile(acct); if (!f) return this.staged.get(acct);
    if (!existsSync(f)) return undefined;
    const b = readFileSync(f), d = createDecipheriv("aes-256-gcm", this.sealKey, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
  }
  private pendingCreds() {
    const pend = this.ledger.kvGet<Record<string, any>>("pendingCreds") ?? {};
    return Object.entries(pend).map(([accountId, p]) => ({ accountId, provider: p.provider, label: this.store.listAccounts().find((a) => a.id === accountId)?.label ?? accountId, from: p.from, fromName: this.group?.devices[p.from]?.name ?? "another device", files: p.files, bytes: p.bytes }));
  }
  private async confirmCreds(acct: string, accept: boolean) {
    const pend = this.ledger.kvGet<Record<string, any>>("pendingCreds") ?? {}, p = pend[acct];
    if (!p) throw new Error("There is no pending login for that account.");
    const files = accept ? this.unstash(acct) : undefined;
    delete pend[acct]; this.ledger.kvSet("pendingCreds", pend); this.staged.delete(acct); const sf = this.stashFile(acct); if (sf) rmSync(sf, { force: true });
    const seen = this.ledger.kvGet<Record<string, string>>("credSeen") ?? {}; seen[acct] = p.hlc; this.ledger.kvSet("credSeen", seen);
    if (accept) {
      if (!files) throw new Error("The received login is no longer available. Ask the other device to send it again.");
      this.setOrigin(acct, p.from); if (this.modes[acct] === "credentials") { this.modes[acct] = "archive-only"; this.ledger.kvSet("modes", this.modes); } // adopted: it comes from p.from and is not shared onward from here
      const dir = join(this.host.accountsDir, acct);
      for (const f of files as { rel: string; b64: string }[]) {
        if (unsafeRel(f.rel)) continue;
        const dst = join(dir, f.rel); mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
        writeFileSync(dst, Buffer.from(f.b64, "base64"), { mode: 0o600 }); try { chmodSync(dst, 0o600); } catch { /* ignore */ }
      }
      await this.host.provider(p.provider)?.importSession?.(dir); // re-seal for THIS install (e.g. Discord: the key lived in an environment variable on the other device)
      await this.host.reload(); // the account may not be in the Hub yet (debounced reload)
      await this.host.call("signIn", { accountId: acct });
    }
    this.host.emit("sync-credentials", this.pendingCreds()); return {};
  }

  // ============================================================ shutdown
  async dispose() {
    this.disposed = true; await this.ready.catch(() => {}); this.moves?.dispose();
    clearTimeout(this.wakeT); clearTimeout(this.reloadT); clearTimeout(this.statusT); this.avatars?.stop(); this.store.onAvatar = undefined;
    this.teardown(true); await this.dhtBusy.catch(() => {}); try { this.persist(); } catch { /* closed */ }
    this.store.ctx = undefined; this.ledger.close();
  }
}

/** cheap "is there anything in this folder" (status is called often, also on phones: no tree walk) */
const hasFiles = (dir: string) => { try { return readdirSync(dir).length > 0; } catch { return false; } };
const unsafeRel = (rel: string) => !rel || isAbsolute(rel) || rel.split(/[\\/]/).some((x) => x === ".." || x === "") || rel.includes("\0");
void addrKey; void migrateGroup;
