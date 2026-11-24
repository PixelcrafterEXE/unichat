// Home-device proxy ("sending through another device", user-facing: "via <device>"). Signal and WhatsApp sessions cannot be copied, and even for
// accounts that can, the user often wants the login on ONE device only. Instead of moving the session, device B USES the account through device A,
// which keeps the one real connection:
//   A (holder)  answers an allow-listed RPC surface (provider-remote PROXY_OPS) for an account only when A's user allowed it for that device:
//               either the per-account switch ("Let my other devices send as this account", `shared`) or a remembered per-device answer
//               (`decisions`, set by the one-time prompt "<device> wants to send as <account> through this device. Allow?").
//               Only paired, non-revoked devices get there (the session itself proves that). A forwards the account's events (never login
//               prompts) to devices that subscribed. Counters, a short log of writes and a rate limit are kept per device and account.
//   B (client)  for an account it has only as a mirror (history, no login) and that a paired, ONLINE device holds live AND allows: B attaches a
//               RemoteConnector (packages/provider-remote) AUTOMATICALLY (`reconcile`). The archive (history, chat cache) stays B's own, so nothing
//               is lost while A is off; live traffic goes through A. If A goes away B shows the account as an archive and refuses writes (nothing is
//               queued or replayed); when A returns the same connector resumes. With two holders B keeps its current one while it is online
//               and otherwise picks the one that was active last (ties: smaller device id): no flapping.
// The session files, keys and login prompts never cross; the only secrets on the wire are the messages themselves, inside the Noise channel.
import { isProxyOp, PROXY_OPS, PROXY_WRITE_OPS, RemoteConnector, RemoteError, type ProxyOp, type RemoteLink } from "@unimsg/provider-remote";
import type { AccountVia, Connector, CoreEvent } from "@unimsg/core";
import type { SyncHostApi } from "@unimsg/core";
import type { Ledger } from "./ledger.js";

export const MAX_PROXY_ATTACHMENT = 64 * 1024 * 1024;
export interface Audit { calls: number; errors: number; events: number; bytes: number; last?: string; byOp: Record<string, number>; /** the last writes (send, react, ...) made through this device: "sent from <device>" lives here only, never in chats */ recent?: { at: string; op: string; err?: boolean }[] }
/** What a holder says about one of its live accounts to one peer. */
export interface Offer { id: string; provider: string; label: string; allowed: boolean; denied?: boolean; activeAt: number }
/** ops that change something on the account: rate limited and logged */
const WRITE_OPS = PROXY_WRITE_OPS;
/** repeated requests: how long and how many results a holder remembers per device (a retry inside this window is answered, never executed again) */
export const IDEM = { ttlMs: 10 * 60_000, max: 500 };
const RID = /^[A-Za-z0-9_-]{8,64}$/;
type Idem = { at: number; state: "running"; p: Promise<unknown> } | { at: number; state: "done"; r: unknown };
/** persisted for sends only (restart safety): which message a request id produced. Never the text. `id` is missing while the send is in flight (crash then = unknown). */
interface SentRef { at: number; chatId: string; id?: string }
export const RELAY_RATE = { max: 30, ms: 10_000 };
export interface ProxyDeps {
  host: SyncHostApi; ledger: Ledger;
  ask(peer: string, method: string, params: unknown, ms?: number): Promise<any>;
  /** push one frame (event) to a peer's session; resolves false when there is none */
  push(peer: string, frame: object): boolean;
  online(peer: string): boolean; name(peer: string): string;
  changed(): void;
  /** a paired device of the group that is not revoked (and not this one) */
  paired(peer: string): boolean;
  /** accounts that are synced with other devices (mode is not "none"): only those can be relayed or mirrored */
  accounts(): string[];
  /** the account came from another device (credentials adopted / history copy): never offered, relayed or served onward from here */
  blocked?(acct: string): boolean;
  now?(): number;
  rate?: { max: number; ms: number };
  idem?: { ttlMs: number; max: number };
  /** a message this device archived (used to answer a retried send after a restart) */
  message?(chatId: string, id: string): any;
}
const prefixOf = (acct: string, id: unknown) => `${acct}:${String(id ?? "")}`;
const native = (acct: string, id: any) => (typeof id === "string" && id.startsWith(acct + ":") ? id.slice(acct.length + 1) : id);

export class Proxies {
  // ---- A side
  private shared: Set<string>; private subs = new Map<string, Set<string>>(); audit: Record<string, Record<string, Audit>> = {}; private busy = new Map<string, number>(); private off?: () => void;
  private idem = new Map<string, Map<string, Idem>>(); private sentRefs: Record<string, Record<string, SentRef>>;
  private decisions: Record<string, Record<string, boolean>>; private asks = new Map<string, { peer: string; acct: string; since: number }>(); private active: Record<string, number> = {}; private writes = new Map<string, number[]>(); private offersT?: ReturnType<typeof setTimeout>;
  // ---- B side
  private using: Record<string, { home: string; auto?: boolean }>; private offers: Record<string, Offer[]>; private optOut: Set<string>; private recChain: Promise<void> = Promise.resolve(); private lastVia = new Map<string, string>();
  private evl = new Map<string, Set<(e: CoreEvent) => void>>(); private presence = new Map<string, Set<(on: boolean) => void>>(); private links = new Map<string, RemoteConnector>();
  constructor(private d: ProxyDeps) {
    this.shared = new Set(d.ledger.kvGet<string[]>("proxyShare") ?? []); this.using = d.ledger.kvGet("proxies") ?? {}; this.audit = d.ledger.kvGet("proxyAudit") ?? {};
    this.sentRefs = d.ledger.kvGet("relaySent") ?? {};
    this.decisions = d.ledger.kvGet("relayDecisions") ?? {}; this.offers = d.ledger.kvGet("relayOffers") ?? {}; this.optOut = new Set(d.ledger.kvGet<string[]>("relayOptOut") ?? []);
  }
  private now() { return (this.d.now ?? Date.now)(); }
  start() { this.off ??= this.d.host.subscribe((e, data) => this.onHubEvent(e, data)); }
  stop() { this.off?.(); this.off = undefined; clearTimeout(this.offersT); this.persistAudit(); }
  persistAudit() { this.d.ledger.kvSet("proxyAudit", this.audit); }

  // ================================================================ home side
  isShared(acct: string) { return this.shared.has(acct); }
  setShare(acct: string, on: boolean) {
    const info = this.d.host.accountInfo(acct); if (!info) throw new Error("Unknown account.");
    if (on) {
      if (!this.liveHere(acct)) throw new Error(`${info.label} is not signed in on this device. Only an account that is connected here can be used by your other devices through it.`);
      this.shared.add(acct);
    } else this.shared.delete(acct);
    this.d.ledger.kvSet("proxyShare", [...this.shared]); this.broadcastOffers(); this.d.changed();
  }
  /** this device holds the login of `acct` itself (a relayed account is never offered on) */
  private liveHere(acct: string) { return !!this.d.host.connector(acct) && !this.using[acct] && this.d.accounts().includes(acct) && !this.d.blocked?.(acct); }
  /** May `peer` use `acct` through this device? A remembered answer for that device wins over the per-account switch. */
  canServe(peer: string, acct: string) {
    if (!this.liveHere(acct)) return false;
    const d = this.decisions[peer]?.[acct]; return d === true || (d === undefined && this.shared.has(acct));
  }
  offerList(peer?: string): Offer[] {
    return this.d.accounts().filter((id) => this.liveHere(id)).flatMap((id) => { const i = this.d.host.accountInfo(id); return i ? [{ id, provider: i.provider, label: i.label, allowed: !!peer && this.canServe(peer, id), ...(peer && this.decisions[peer]?.[id] === false ? { denied: true } : {}), activeAt: this.active[id] ?? 0 }] : []; });
  }
  broadcastOffers() { for (const p of this.peersOnline()) this.d.push(p, { t: "offers", accounts: this.offerList(p) }); }
  /** the set of live / synced accounts changed (sign-in, sign-out, sync mode): tell the peers soon, in one go */
  offersChanged() { if (this.offersT) return; this.offersT = setTimeout(() => { this.offersT = undefined; this.broadcastOffers(); this.reconcile(); }, 150); this.offersT.unref?.(); }
  private peersOnline: () => string[] = () => [];
  bindPeers(f: () => string[]) { this.peersOnline = f; }
  private count(peer: string, acct: string, op: string, bytes = 0, err = false) {
    const a = ((this.audit[peer] ??= {})[acct] ??= { calls: 0, errors: 0, events: 0, bytes: 0, byOp: {} });
    a.calls++; a.bytes += bytes; if (err) a.errors++; a.byOp[op] = (a.byOp[op] ?? 0) + 1; a.last = new Date(this.now()).toISOString();
    if (WRITE_OPS.has(op)) { (a.recent ??= []).push({ at: a.last, op, ...(err ? { err: true } : {}) }); if (a.recent.length > 20) a.recent.splice(0, a.recent.length - 20); }
  }
  subscribe(peer: string, accts: string[]) { this.subs.set(peer, new Set(accts.filter((a) => this.canServe(peer, a)))); }
  peerGone(peer: string) { this.subs.delete(peer); }

  // ---- who may use what: remembered answers, the one-time prompt
  /** A paired device wants to use `acct` through this device. Returns what happened: allowed / denied are remembered answers, pending means the user is being asked. */
  askedBy(peer: string, acct: string): "allowed" | "denied" | "pending" {
    if (!this.d.paired(peer)) throw new Error("Unknown device.");
    if (!this.liveHere(acct)) throw new Error("This account is not signed in on that device.");
    if (this.canServe(peer, acct)) return "allowed";
    if (this.decisions[peer]?.[acct] === false) return "denied";
    const k = peer + "|" + acct;
    if (!this.asks.has(k)) {
      if ([...this.asks.values()].filter((x) => x.peer === peer).length >= 8) throw new Error("Too many requests; answer the pending ones first.");
      this.asks.set(k, { peer, acct, since: this.now() }); this.d.changed();
    }
    return "pending";
  }
  /** The user's answer (the prompt, or the devices list): true = allow, false = don't allow, null = forget the answer (then the account switch decides again). */
  setDecision(peer: string, acct: string, allow: boolean | null) {
    if (!this.d.paired(peer)) throw new Error("Unknown device.");
    if (!this.d.host.accountInfo(acct)) throw new Error("Unknown account.");
    const m = (this.decisions[peer] ??= {}); if (allow === null) delete m[acct]; else m[acct] = allow;
    if (!Object.keys(m).length) delete this.decisions[peer];
    this.asks.delete(peer + "|" + acct); this.d.ledger.kvSet("relayDecisions", this.decisions);
    if (allow !== true) { this.subs.get(peer)?.delete(acct); }
    this.d.push(peer, { t: "offers", accounts: this.offerList(peer) }); this.d.changed();
  }
  relayState() {
    const label = (a: string) => this.d.host.accountInfo(a)?.label ?? a;
    return {
      asks: [...this.asks.values()].filter((x) => this.liveHere(x.acct) && this.d.paired(x.peer)).map((x) => ({ deviceId: x.peer, deviceName: this.d.name(x.peer), accountId: x.acct, label: label(x.acct), since: x.since })),
      decisions: Object.entries(this.decisions).flatMap(([peer, m]) => (this.d.paired(peer) ? Object.entries(m).map(([acct, allowed]) => ({ deviceId: peer, deviceName: this.d.name(peer), accountId: acct, label: label(acct), allowed })) : [])),
    };
  }
  /** a device was removed from the group: forget what it was allowed */
  forgetDevice(peer: string) {
    this.forgetIdem(peer); delete this.decisions[peer]; this.subs.delete(peer); for (const k of [...this.asks.keys()]) if (k.startsWith(peer + "|")) this.asks.delete(k);
    this.d.ledger.kvSet("relayDecisions", this.decisions); delete this.offers[peer]; this.d.ledger.kvSet("relayOffers", this.offers);
  }

  /** Execute one proxied operation for `peer`. Everything is validated here; the caller already proved the peer is a paired, non-revoked device. */
  async serve(peer: string, p: { acct?: string; op?: string; args?: any; rid?: string }): Promise<unknown> {
    const acct = String(p?.acct ?? ""), op = p?.op, args = (p?.args && typeof p.args === "object" ? p.args : {}) as Record<string, any>;
    if (!isProxyOp(op)) { throw new Error("That operation is not available through another device."); }
    if (!this.d.paired(peer)) throw new Error("This device is not allowed to do that.");
    if (!this.canServe(peer, acct)) throw new Error("This device doesn't allow sending as this account.");
    const rid = typeof p.rid === "string" && RID.test(p.rid) ? p.rid : undefined;
    if (!rid || !WRITE_OPS.has(op)) return this.execute(peer, acct, op, args);
    // ---- idempotency: one request id = at most one execution, even when the first try is still running or its answer was lost
    const lim = this.d.idem ?? IDEM, now = this.now(), m = this.idemOf(peer, now), hit = m.get(rid);
    if (hit) return hit.state === "running" ? hit.p : hit.r;
    const ref = this.sentRefs[peer]?.[rid];
    if (ref && now - ref.at < lim.ttlMs && op === "send") { // after a restart of this device
      if (!ref.id) throw new Error("This device restarted while sending that message and cannot tell if it went out. Check the chat before you send it again.");
      return this.rebuild(acct, ref);
    }
    let note: SentRef | undefined;
    if (op === "send") { note = { at: now, chatId: "" }; this.setRef(peer, rid, note); }
    const pr = this.execute(peer, acct, op, args, (o) => { if (note && o?.id) { note.chatId = String(o.chatId ?? ""); note.id = String(o.id); this.setRef(peer, rid, note); } });
    m.set(rid, { at: now, state: "running", p: pr });
    try { const r = await pr; m.set(rid, { at: now, state: "done", r }); this.trim(m, lim.max); return r; }
    catch (e) { m.delete(rid); if (note) this.setRef(peer, rid, undefined); throw e; } // a failed write may be tried again
  }
  private idemOf(peer: string, now: number) {
    let m = this.idem.get(peer); if (!m) this.idem.set(peer, (m = new Map()));
    const ttl = (this.d.idem ?? IDEM).ttlMs; for (const [k, v] of m) if (v.state === "done" && now - v.at > ttl) m.delete(k);
    return m;
  }
  private trim(m: Map<string, Idem>, max: number) { while (m.size > max) { const k = m.keys().next().value as string; m.delete(k); } }
  private setRef(peer: string, rid: string, ref: SentRef | undefined) {
    const lim = this.d.idem ?? IDEM, t = this.now(), mine = (this.sentRefs[peer] ??= {});
    if (ref) mine[rid] = ref; else delete mine[rid];
    for (const [k, v] of Object.entries(mine)) if (t - v.at > lim.ttlMs) delete mine[k];
    const keys = Object.keys(mine); if (keys.length > lim.max) for (const k of keys.slice(0, keys.length - lim.max)) delete mine[k];
    if (!keys.length) delete this.sentRefs[peer];
    this.d.ledger.kvSet("relaySent", this.sentRefs);
  }
  private rebuild(acct: string, ref: SentRef) {
    const m = ref.chatId && ref.id ? this.d.message?.(ref.chatId, ref.id) : undefined;
    return this.strip(acct, m ? { ...m, chatId: ref.chatId } : { id: ref.id, chatId: ref.chatId, sender: "me", senderId: "me", text: "", time: new Date(ref.at).toISOString(), fromMe: true, status: "sent" });
  }
  /** the memory of repeated requests is dropped with the device */
  private forgetIdem(peer: string) { this.idem.delete(peer); if (this.sentRefs[peer]) { delete this.sentRefs[peer]; this.d.ledger.kvSet("relaySent", this.sentRefs); } }
  private async execute(peer: string, acct: string, op: ProxyOp, args: Record<string, any>, note?: (o: any) => void): Promise<unknown> {
    const n = this.busy.get(peer) ?? 0; if (n >= 24) throw new Error("The other device is busy; try again in a moment.");
    if (WRITE_OPS.has(op)) {
      const r = this.d.rate ?? RELAY_RATE, t = this.now(), w = (this.writes.get(peer) ?? []).filter((x) => t - x < r.ms);
      if (w.length >= r.max) { this.writes.set(peer, w); this.count(peer, acct, op, 0, true); throw new Error("Too many messages in a short time through this device. Wait a few seconds and try again."); }
      w.push(t); this.writes.set(peer, w);
    }
    this.active[acct] = this.now();
    this.busy.set(peer, n + 1);
    try {
      const r = await this.run(acct, op, args, note);
      this.count(peer, acct, op, typeof r === "object" && r ? JSON.stringify(r).length : 0); return r;
    } catch (e) { this.count(peer, acct, op, 0, true); throw e; }
    finally { this.busy.set(peer, (this.busy.get(peer) ?? 1) - 1); }
  }
  private conn(acct: string): Connector {
    const c = this.using[acct] ? undefined : this.d.host.connector(acct); if (!c) throw new Error("The account is signed out on the other device.");
    return c;
  }
  private async run(acct: string, op: ProxyOp, a: Record<string, any>, note?: (o: any) => void): Promise<unknown> {
    const H = this.d.host, g = (id: unknown) => { if (typeof id !== "string" || !id || id.length > 2000) throw new Error("Bad chat id."); return prefixOf(acct, id); };
    const str = (v: unknown, max = 100_000) => { if (typeof v !== "string" || v.length > max) throw new Error("Bad parameter."); return v; };
    switch (op) {
      case "info": { const i = H.accountInfo(acct); const c = H.connector(acct); let caps; try { caps = c?.capabilities; } catch { /* getter */ } return { activeAt: this.active[acct] ?? 0, capabilities: caps, state: c ? i?.state ?? "connected" : "signed-out", provider: i?.provider, label: i?.label }; }
      case "spaces": return this.conn(acct).spaces();
      case "chats": return this.conn(acct).chats();
      case "history": return this.conn(acct).history(str(a.chatId, 2000), { limit: Math.min(500, Math.max(1, Number(a.limit) || 50)), beforeMessageId: a.beforeMessageId === undefined ? undefined : str(a.beforeMessageId, 2000) });
      case "members": return this.conn(acct).members(str(a.chatId, 2000));
      case "aliases": { const c = this.conn(acct); return c.aliases ? c.aliases(str(a.chatId, 2000)) : []; }
      case "attachment": {
        const chat = g(a.chatId), key = `${chat}|${str(a.messageId, 2000)}|${str(a.attachmentId, 2000)}`;
        let r = H.media.get(acct, key);
        if (!r) { r = await this.conn(acct).downloadAttachment(a.chatId, a.messageId, a.attachmentId); try { H.media.put(acct, key, r); } catch { /* cache is best effort */ } }
        if (r.data.length > MAX_PROXY_ATTACHMENT) throw new Error("That file is too large to send through the home device.");
        return { dataBase64: Buffer.from(r.data).toString("base64"), mime: r.mime, name: r.name };
      }
      case "avatar": { const c = this.conn(acct); if (!c.avatar) return null; const r = await c.avatar({ kind: a.kind, id: str(a.id, 2000) }); return r ? { dataBase64: Buffer.from(r.data).toString("base64"), mime: r.mime } : null; }
      case "send": {
        const m = a.msg ?? {}, out = await H.call("send", { chatId: g(a.chatId), text: String(m.text ?? ""), replyToMessageId: m.replyToMessageId, location: m.location, contacts: m.contacts, poll: m.poll, event: m.event, mentions: m.mentions,
          attachments: (m.attachments ?? []).map((x: any) => ({ kind: x.kind, mime: x.mime, name: x.name, durationMs: x.durationMs, waveform: x.waveform, width: x.width, height: x.height, gif: x.gif, caption: x.caption, dataBase64: x.dataBase64 })) });
        note?.(out); return this.strip(acct, out);
      }
      case "react": case "edit": case "delete": case "setTyping": case "markRead": case "vote": case "editEvent": case "refreshChat": case "openThread": case "acceptRequest": case "declineRequest":
      case "leaveChat": case "addMembers": case "removeMember": case "renameChat": case "blockChat": case "setChatPicture": case "setChatDescription": {
        const { chatId, ...rest } = a; return this.strip(acct, await H.call(op, { ...rest, chatId: g(chatId) }));
      }
      case "startChat": case "createGroup": return this.strip(acct, await H.call(op, { accountId: acct, handle: a.handle, name: a.name, handles: a.handles }));
      case "createSpace": case "joinSpace": return this.strip(acct, await H.call(op, { accountId: acct, name: a.name, description: a.description, invite: a.invite }));
      case "leaveSpace": return H.call("leaveSpace", { spaceId: g(a.spaceId) });
      case "sync": return H.call("syncAccount", { accountId: acct });
      case "getProfile": case "getPrivacy": return H.call(op, { accountId: acct });
      case "updateProfile": return H.call(op, { accountId: acct, displayName: a.displayName, about: a.about, avatar: a.avatar });
      case "setPrivacy": return H.call(op, { accountId: acct, id: str(a.id, 200), value: str(a.value, 2000) });
    }
    throw new Error("unsupported");
  }
  /** Hub-level results carry global ids; the wire speaks native ids. */
  private strip(acct: string, v: any): any {
    if (!v || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => this.strip(acct, x));
    const o = { ...v }; for (const k of ["id", "chatId", "spaceId", "parentId"]) if (typeof o[k] === "string") o[k] = native(acct, o[k]);
    delete o.accountId; return o;
  }
  /** A hub event of an account a device may use -> the subscribed devices. */
  private onHubEvent(event: string, data: any) {
    if (event === "account" || event === "accounts-changed") this.offersChanged();
    if (event === "message" || event === "receipt") { const id = data?.accountId ?? String(data?.chatId ?? "").split(":")[0]; if (id && this.d.accounts().includes(id)) this.active[id] = this.now(); }
    if (!this.subs.size) return;
    let acct = "", e: CoreEvent | undefined;
    const A = (id: unknown) => { const s = String(id ?? ""); return this.d.accounts().find((x) => s.startsWith(x + ":")) ?? ""; };
    switch (event) {
      case "message": acct = data?.accountId ?? A(data?.chatId); e = { type: "message", data: this.strip(acct, data) } as CoreEvent; /* keep `historical`: a replay on the holder is no fresh arrival here either (no notification, no unread bump) */ break;
      case "message-update": acct = A(data?.chatId); e = { type: "message-update", data: { chatId: native(acct, data.chatId), messageId: data.messageId, patch: data.patch } }; break;
      case "receipt": acct = A(data?.chatId); e = { type: "receipt", data: { chatId: native(acct, data.chatId), messageId: data.messageId, status: data.status, by: data.by, at: data.at } }; break;
      case "typing": acct = A(data?.chatId); e = { type: "typing", data: { chatId: native(acct, data.chatId), senderId: data.senderId, typing: !!data.typing } }; break;
      case "chats-changed": acct = data?.accountId ?? ""; e = { type: "chats-changed", data: { chatId: data?.chatId ? native(acct, data.chatId) : undefined } }; break;
      case "spaces-changed": acct = data?.accountId ?? ""; e = { type: "spaces-changed", data: {} }; break;
      case "account": acct = data?.id ?? ""; e = { type: "account", data: { id: acct, state: data.state, detail: data.detail } }; break;
      default: return; // login prompts, errors, history-updated: never forwarded
    }
    if (!acct || !e) return;
    for (const [peer, set] of this.subs) if (set.has(acct) && this.canServe(peer, acct) && this.d.push(peer, { t: "ev", acct, e })) { const a = ((this.audit[peer] ??= {})[acct] ??= { calls: 0, errors: 0, events: 0, bytes: 0, byOp: {} }); a.events++; }
  }

  // ================================================================ client (B) side
  setOffers(peer: string, list: any) {
    this.offers[peer] = (Array.isArray(list) ? list : []).filter((x) => x && typeof x.id === "string" && typeof x.provider === "string").slice(0, 200)
      .map((x) => ({ id: x.id, provider: String(x.provider), label: String(x.label ?? x.id).slice(0, 80), allowed: x.allowed !== false, ...(x.denied ? { denied: true } : {}), activeAt: Number(x.activeAt) || 0 }));
    this.d.ledger.kvSet("relayOffers", this.offers); this.reconcile(); this.d.changed();
  }
  /** offers of devices that are online right now (the manual "Add account from ..." list in Advanced) */
  offerState() { return Object.entries(this.offers).filter(([peer]) => this.d.online(peer)).flatMap(([peer, l]) => l.filter((o) => o.allowed).map((o) => ({ deviceId: peer, deviceName: this.d.name(peer), accountId: o.id, provider: o.provider, label: o.label, using: this.using[o.id]?.home === peer }))); }
  usingList() { return Object.entries(this.using).map(([accountId, u]) => ({ accountId, home: u.home, homeName: this.d.name(u.home), online: this.d.online(u.home), auto: !!u.auto })); }
  isProxy(acct: string) { return !!this.using[acct]; }
  homeOf(acct: string) { return this.using[acct]?.home; }
  hasOffer(peer: string, acct: string) { return this.d.online(peer) && !!this.offers[peer]?.some((o) => o.id === acct && o.allowed); }
  private link(acct: string): RemoteLink {
    const self = this, home = () => this.using[acct]?.home ?? "";
    return {
      home: () => ({ name: self.d.name(home()), online: self.d.online(home()) }),
      call: async (op, args, rid) => {
        const h = home(); if (!h || !self.d.online(h)) throw new RemoteError("unreachable", "unreachable");
        try { return await self.d.ask(h, "proxy.call", { acct, op, args, rid }, op === "attachment" || op === "send" ? 180_000 : 60_000); }
        catch (e) { const m = (e as Error).message; if (/not connected|no session|session closed|timed out/i.test(m)) throw new RemoteError("unreachable", m); throw e; }
      },
      onEvent: (l) => { const s = self.evl.get(acct) ?? new Set(); self.evl.set(acct, s); s.add(l); return () => s.delete(l); },
      onPresence: (l) => { const s = self.presence.get(acct) ?? new Set(); self.presence.set(acct, s); s.add(l); return () => s.delete(l); },
    };
  }
  /** Start using `acct` through device `home` by hand (Advanced). The account must exist here as an archive and not be linked locally. */
  async use(home: string, acct: string) {
    if (!this.hasOffer(home, acct)) throw new Error("That device does not offer this account (it may be offline, or it does not allow sending as this account).");
    if (this.d.host.connector(acct) && !this.using[acct]) throw new Error("This account is signed in on this device already. Sign it out here first if you want to use it through the other device.");
    this.optOut.delete(acct); this.d.ledger.kvSet("relayOptOut", [...this.optOut]);
    const prev = this.using[acct]?.home; this.using[acct] = { home }; this.d.ledger.kvSet("proxies", this.using);
    if (!this.links.has(acct)) await this.attach(acct); else if (prev !== home) this.refreshHome(acct);
    this.sendSub(home); if (prev && prev !== home) this.sendSub(prev); this.annotate(); this.d.changed();
  }
  async attach(acct: string) {
    await this.d.host.reload(); // the archived account may have arrived from the ledger a moment ago
    const conn = new RemoteConnector(this.link(acct), acct); this.links.set(acct, conn);
    await this.d.host.adopt(acct, conn);
  }
  /** the account is now used through another device: tell its connector (it re-reads the capabilities and shows the new state) */
  private refreshHome(acct: string) { for (const l of this.presence.get(acct) ?? []) l(this.d.online(this.using[acct]?.home ?? "")); }
  /** `byUser`: the user chose to stop; the account is then not picked up automatically again until they choose it. */
  async stopUsing(acct: string, byUser = true) {
    const u = this.using[acct]; if (!u) return;
    delete this.using[acct]; this.d.ledger.kvSet("proxies", this.using); this.links.delete(acct);
    if (byUser) { this.optOut.add(acct); this.d.ledger.kvSet("relayOptOut", [...this.optOut]); }
    await this.d.host.release(acct); this.sendSub(u.home); this.annotate(); this.d.changed();
  }
  /** `peer` told us it removed this device: stop relaying through it (accounts go back to plain archives; scheduled messages then fail with a reason). */
  async removedBy(peer: string) {
    for (const [acct, u] of Object.entries(this.using)) if (u.home === peer) await this.stopUsing(acct, false).catch(() => {});
    delete this.offers[peer]; this.d.ledger.kvSet("relayOffers", this.offers); this.annotate(); this.d.changed();
  }
  /** This device was removed from the group: nothing is relayed through anybody any more (accounts go back to plain archives). */
  async releaseAll() {
    for (const acct of Object.keys(this.using)) await this.stopUsing(acct, false).catch(() => {});
    this.offers = {}; this.d.ledger.kvSet("relayOffers", this.offers); this.annotate(); this.d.changed();
  }
  /** After the Hub started: re-attach the proxies we had, then look for accounts that can be relayed now. */
  async restore() { for (const acct of Object.keys(this.using)) { try { if (!this.links.has(acct)) await this.attach(acct); } catch { /* account vanished: the entry stays, status shows it */ } } this.reconcile(); }
  note(acct: string) { return this.links.get(acct)?.homeNote; }
  sendSub(home: string) {
    this.d.push(home, { t: "sub", accts: Object.entries(this.using).filter(([, u]) => u.home === home).map(([a]) => a) });
  }

  // ---- automatic choice of the device an account is used through
  private candidates(acct: string) {
    return Object.entries(this.offers).flatMap(([peer, l]) => { const o = l.find((x) => x.id === acct); return o && this.d.paired(peer) ? [{ peer, o, online: this.d.online(peer) }] : []; });
  }
  /** deterministic: the device that was active last wins, ties go to the smaller id */
  private best(c: { peer: string; o: Offer }[]) { return [...c].sort((x, y) => y.o.activeAt - x.o.activeAt || (x.peer < y.peer ? -1 : 1))[0]; }
  /** Look at every mirrored account and attach / switch / detach as needed. Serialised; safe to call at any time. */
  reconcile(): Promise<void> {
    this.recChain = this.recChain.then(() => this.reconcileNow()).catch(() => {});
    return this.recChain;
  }
  private async reconcileNow() {
    for (const acct of this.d.accounts()) {
      if (!this.d.host.accountInfo(acct)) continue;
      const cur = this.using[acct];
      if (!cur && this.d.host.connector(acct)) continue; // this device holds its own login: never relay
      if (cur && !cur.auto) continue; // chosen by hand
      const ok = this.candidates(acct).filter((c) => c.online && c.o.allowed);
      try {
        if (cur) {
          if (this.d.online(cur.home) && this.offers[cur.home]?.some((o) => o.id === acct && o.allowed)) continue; // keep: no flapping
          if (ok.length) { const b = this.best(ok), prev = cur.home; cur.home = b.peer; this.d.ledger.kvSet("proxies", this.using); this.refreshHome(acct); this.sendSub(b.peer); this.sendSub(prev); }
          else if (this.d.online(cur.home)) await this.stopUsing(acct, false); // the device is here but no longer holds / allows it: back to a plain archive
        } else if (ok.length && !this.optOut.has(acct)) {
          const b = this.best(ok); this.using[acct] = { home: b.peer, auto: true }; this.d.ledger.kvSet("proxies", this.using);
          try { await this.attach(acct); } catch (e) { delete this.using[acct]; this.d.ledger.kvSet("proxies", this.using); this.links.delete(acct); throw e; }
          this.sendSub(b.peer);
        }
      } catch { /* try again at the next change */ }
    }
    this.annotate(); this.d.changed();
  }
  /** What the UI shows next to the account: sending through <device>, archive only, ask to allow. */
  viaOf(acct: string): AccountVia | undefined {
    const cur = this.using[acct];
    if (cur) return { kind: this.d.online(cur.home) ? "relay" : "offline", device: this.d.name(cur.home), deviceId: cur.home };
    if (this.d.host.connector(acct) || this.optOut.has(acct)) return undefined;
    const c = this.candidates(acct); if (!c.length) return undefined;
    const on = c.filter((x) => x.online);
    if (!on.length) { const b = this.best(c); return { kind: "offline", device: this.d.name(b.peer), deviceId: b.peer }; }
    const b = this.best(on); return { kind: b.o.denied ? "denied" : "ask", device: this.d.name(b.peer), deviceId: b.peer };
  }
  annotate() {
    for (const acct of this.d.accounts()) {
      if (!this.d.host.accountInfo(acct)) continue; // not loaded in the Hub yet: the next "accounts-changed" tries again
      const v = this.viaOf(acct), sig = JSON.stringify(v ?? null);
      if (this.lastVia.get(acct) === sig) continue; this.lastVia.set(acct, sig);
      try { this.d.host.annotate(acct, v); } catch { /* unknown account */ }
    }
  }
  /** The user asks `home` to allow sending as `acct` (the composer / account note button). */
  async askHome(acct: string, home?: string): Promise<"allowed" | "denied" | "pending"> {
    const cands = this.candidates(acct).filter((c) => c.online); const h = home ?? (cands.length ? this.best(cands).peer : undefined);
    if (!h || !this.d.online(h)) throw new Error("The device that holds this account is offline.");
    const r = (await this.d.ask(h, "relay.ask", { acct }, 20_000)) as { state: "allowed" | "denied" | "pending" }; return r.state;
  }
  /** A session with `peer` came up or went down. */
  presenceChanged(peer: string, up: boolean) {
    if (up) { this.sendSub(peer); this.d.push(peer, { t: "offers", accounts: this.offerList(peer) }); }
    else { this.peerGone(peer); }
    for (const [acct, u] of Object.entries(this.using)) if (u.home === peer) for (const l of this.presence.get(acct) ?? []) l(up);
    void this.reconcile(); this.d.changed();
  }
  onEvent(acct: string, e: CoreEvent) { if (!this.using[acct]) return; for (const l of this.evl.get(acct) ?? []) l(e); }
  /** An account was removed here: forget the proxy. */
  accountGone(acct: string) { if (this.using[acct]) { delete this.using[acct]; this.d.ledger.kvSet("proxies", this.using); } if (this.shared.delete(acct)) this.d.ledger.kvSet("proxyShare", [...this.shared]); }
  static readonly OPS = PROXY_OPS;
}
