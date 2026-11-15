// "Move to another device" over the sync channel: a two-phase hand-over of ONE account's login between two PAIRED devices.
// Point to point only: these frames go over the one authenticated Noise session between the two devices. They are never written to the sync
// ledger, never replicated to a third device, never logged. The persisted records below hold metadata only (no file name content, no secrets).
//
//   source (OUT)                                        target (IN)
//   asking    --mv-prepare{account, sizes}-->           asking     (the user sees "Move X from A to B?" and decides)
//             <--mv-reply{ok}-----------------          staging    (accepted; files go to a sealed staging area, NOT active)
//   sending   --mv-begin / mv-chunk* / mv-end-->        staged     (every file and the whole manifest verified by SHA-256)
//             <--mv-staged{ok}----------------
//   committing --mv-commit-->                           committing (install, re-seal, start the connector)
//             <--mv-done{ok}------------------          owned      (durable record written BEFORE mv-done is sent)  | aborted (rolled back)
//   wiping    (only now: stop + wipe the session here, no remote logout)
//   done      --mv-ack-->                               (staging already gone)
//
// Ownership: the source owns the account until the target has durably recorded "owned". The source wipes only after it has SEEN that fact
// (mv-done{ok} or mv-state{owned}), exactly once (record "wiping" -> "done"). Anything that goes wrong before the target is "owned" rolls the
// target back and leaves the source untouched. If the answer is lost after the target committed, the source stays in "committing" and asks
// (mv-query) on every reconnect: the target's answer is binding (it tombstones the transfer when it says "not-owner").
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SyncHostApi } from "@unimsg/core";

export const MOVE_VERSION = 1;
/** Mutable for tests. */
export const MOVE_LIMITS = { bytes: 512 * 1024 * 1024, files: 4096, file: 128 * 1024 * 1024, chunk: 192 * 1024 };
export interface MoveOptions { approvalMs?: number; stepMs?: number; commitMs?: number; settleMs?: number; maxPrepares?: number; windowMs?: number; tamper?: (m: { tid: string; f: number; i: number; d: Buffer }) => Buffer | undefined;
  /** TESTS ONLY: called before every move frame is sent / after one arrives (may close the session or delay). */
  hook?: (e: { dir: "send" | "recv"; t: string; tid: string }) => void | "drop" | Promise<void | "drop"> }

type OutState = "queued" | "asking" | "sending" | "committing" | "wiping" | "done" | "failed";
type InState = "asking" | "staging" | "staged" | "committing" | "owned" | "aborted";
export interface BatchItem { acct: string; label: string; provider: string }
export interface Batch { id: string; n: number; i: number; items: BatchItem[] }
export interface MoveRec {
  tid: string; role: "out" | "in"; peer: string; peerName: string; acct: string; provider: string; label: string; state: OutState | InState;
  files: number; bytes: number; at: number; updated: number; reason?: string; wipeError?: string; batch?: Batch; kind?: "history"; history?: { media: boolean; removeAfter: boolean }; hist?: { m: number; f: number; b: number }; histFailed?: boolean; removeError?: string; /** target: who declined / why it ended */ by?: "me" | "them";
}
export interface MoveView extends MoveRec { from: string; to: string; done: number; total: number; histDone?: { m: number; f: number }; stage?: "login" | "history"; phase: "queued" | "confirm" | "waiting" | "sending" | "finishing" | "done" | "failed"; error?: string }

export interface MoveDeps {
  host: SyncHostApi; kv: { get<T>(k: string): T | undefined; set(k: string, v: unknown): void };
  dir?: string; sealKey: Buffer; now(): number; selfName(): string;
  send(peer: string, msg: object): Promise<void>; online(peer: string): boolean; paired(peer: string): boolean; peerName(peer: string): string;
  /** the account has a live connector of its own here (not a proxy) */
  movable(acct: string): boolean; hasActive(acct: string): boolean;
  /** this device has its OWN login for the account (live connector that is not a relay, an active row, or session files); a history copy / relayed copy is not one */
  /** stop replicating this account (after "remove the history from this device") */ stopSync(acct: string): void;
  /** the account is now this device's own (moved here): forget where it came from */ claim(acct: string): void;
  ownLogin(acct: string): boolean; /** stop using the account through another device (a relay), before the real login is installed */ detach(acct: string): Promise<void>; describe(acct: string): { provider: string; label: string } | undefined; changed(): void; opts: MoveOptions;
}

const KEY = "moves";
const ID = /^[\w.-]{1,80}$/, TID = /^[0-9a-f]{32}$/;
const unsafeRel = (rel: string) => typeof rel !== "string" || !rel || rel.length > 400 || isAbsolute(rel) || rel.split(/[\\/]/).some((x) => x === ".." || x === "") || rel.includes("\0");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const manifestHash = (files: { rel: string; size: number; sha: string }[]) => sha(JSON.stringify(files.map((f) => [f.rel, f.size, f.sha])));
const errmsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
class Cancelled extends Error { constructor(msg: string, public by: "me" | "them" = "them") { super(msg); } }

/** Staging area: sealed (AES-256-GCM with the install's seal key) next to sync.db, or in memory when there is no directory. Never in the ledger. */
export class Stage {
  private mem = new Map<number, Buffer>();
  constructor(private dir: string | undefined, private key: Buffer, private tid: string) { if (dir) mkdirSync(this.root(), { recursive: true, mode: 0o700 }); }
  private root() { return join(this.dir!, "move-" + this.tid); }
  put(i: number, data: Buffer) {
    if (!this.dir) { this.mem.set(i, data); return; }
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", this.key, iv); c.setAAD(Buffer.from(this.tid + ":" + i));
    const ct = Buffer.concat([c.update(data), c.final()]);
    writeFileSync(join(this.root(), i + ".sealed"), Buffer.concat([iv, c.getAuthTag(), ct]), { mode: 0o600 });
  }
  get(i: number): Buffer {
    if (!this.dir) { const b = this.mem.get(i); if (!b) throw new Error("staged file missing"); return b; }
    const b = readFileSync(join(this.root(), i + ".sealed")), d = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12)); d.setAAD(Buffer.from(this.tid + ":" + i)); d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]);
  }
  clear() { this.mem.clear(); if (this.dir) try { rmSync(this.root(), { recursive: true, force: true }); } catch { /* best effort */ } }
}
/** Remove staging folders that no record claims (a crash between staging and the record). */
export function sweepStages(dir: string | undefined, keep: Set<string>) {
  if (!dir || !existsSync(dir)) return;
  for (const n of readdirSync(dir)) if (n.startsWith("move-") && !keep.has(n.slice(5))) try { rmSync(join(dir, n), { recursive: true, force: true }); } catch { /* best effort */ }
}

interface Live {
  rec: MoveRec; q: any[]; waiter?: { kinds: string[]; ok(x: any): void; fail(e: Error): void; timer: ReturnType<typeof setTimeout> }; timer?: ReturnType<typeof setTimeout>; cancelled?: Cancelled;
  hm: number; hf: number; inHistory?: boolean; histOk?: boolean; hist?: { m: number; f: number; cur?: { chatId: string; messageId: string; attId: string; mime: string; name?: string; size: number; sha: string; next: number; chunks: Buffer[]; got: number; h: ReturnType<typeof createHash> } }; hq: Promise<void>;
  // source
  bundle?: { files: { rel: string; data: Buffer; sha: string }[] }; sentBytes: number;
  // target
  stage?: Stage; plan?: { rel: string; size: number; sha: string }[]; cur?: { f: number; next: number; chunks: Buffer[]; got: number; h: ReturnType<typeof createHash> }; filesDone: number; gotBytes: number; commit?: Promise<void>;
}

export class MoveService {
  private live = new Map<string, Live>(); private batches = new Map<string, { queue: string[]; stopped: boolean }>(); private accepted = new Map<string, { peer: string; allowed: Set<string>; at: number }>(); private prepares = new Map<string, number[]>(); private disposed = false;
  constructor(private d: MoveDeps) {
    for (const r of Object.values(this.recs())) {
      // anything that was in flight when this process stopped: nothing was handed over yet -> it is over (never "committing": that one is resolved by asking)
      if (r.role === "out" && (r.state === "asking" || r.state === "sending" || r.state === "queued")) { r.state = "failed"; r.reason = "Interrupted: this device restarted. Nothing changed."; this.save(r); }
      if (r.role === "in" && (r.state === "asking" || r.state === "staging" || r.state === "staged")) { r.state = "aborted"; r.reason = "Interrupted: this device restarted. Nothing was installed."; this.save(r); }
    }
    sweepStages(this.d.dir, new Set());
  }
  private o() { return this.d.opts; }
  private async tx(peer: string, msg: any) { if ((await this.o().hook?.({ dir: "send", t: msg.t, tid: msg.tid })) === "drop") return; return this.d.send(peer, msg); }
  private recs(): Record<string, MoveRec> { return this.d.kv.get<Record<string, MoveRec>>(KEY) ?? {}; }
  private save(r: MoveRec) {
    const all = this.recs(); r.updated = this.d.now(); all[r.tid] = r;
    const ids = Object.keys(all);
    if (ids.length > 300) for (const id of ids.sort((a, b) => all[a].updated - all[b].updated).slice(0, ids.length - 300)) if (all[id].state !== "committing") delete all[id];
    this.d.kv.set(KEY, all);
  }
  private set(r: MoveRec, state: MoveRec["state"], reason?: string) {
    r.state = state; if (reason !== undefined) r.reason = reason; this.save(r);
    if (state === "done" || state === "failed" || state === "aborted" || state === "owned") { const l = this.live.get(r.tid); if (l) { clearTimeout(l.timer); l.bundle = undefined; this.live.delete(r.tid); } if (r.role === "out" && (state === "done" || state === "failed")) this.advance(r); }
    this.d.changed();
  }
  /** the one in-memory record of a transfer (or the stored one) */
  private get(tid: string): MoveRec | undefined { return this.live.get(tid)?.rec ?? this.recs()[tid]; }

  // ============================================================ views
  list(): MoveView[] {
    const now = this.d.now(); void now;
    return Object.values(this.recs()).sort((a, b) => b.at - a.at).slice(0, 40).map((r) => this.view(r));
  }
  private view(r: MoveRec): MoveView {
    const l = this.live.get(r.tid), me = this.d.selfName(), other = r.peerName;
    const from = r.role === "out" ? me : other, to = r.role === "out" ? other : me;
    const total = r.bytes + (r.hist?.b ?? 0), done = r.role === "out" ? l?.sentBytes ?? 0 : l?.gotBytes ?? 0;
    let phase: MoveView["phase"];
    if (r.role === "in" && r.state === "asking") phase = "confirm";
    else if (r.role === "out" && r.state === "asking") phase = "waiting";
    else if (r.state === "queued") phase = "queued";
    else if (r.state === "sending" || r.state === "staging") phase = "sending";
    else if (r.state === "done" || r.state === "owned") phase = "done";
    else if (r.state === "failed" || r.state === "aborted") phase = "failed";
    else phase = "finishing";
    return { ...r, from, to, done, total, phase, error: phase === "failed" ? r.reason : undefined, ...(r.hist ? { histDone: { m: l?.hm ?? (phase === "done" ? r.hist.m : 0), f: l?.hf ?? (phase === "done" ? r.hist.f : 0) }, stage: (l?.inHistory ? "history" : "login") as "history" | "login" } : {}) };
  }

  // ============================================================ source: start / cancel
  async start(p: { accountId?: string; accountIds?: string[]; deviceId: string; confirmed: boolean; includeHistory?: boolean; includeMedia?: boolean; removeHistoryAfter?: boolean }): Promise<{ transferId: string; transferIds: string[] }> {
    const ids = [...new Set((p.accountIds ?? [p.accountId]).map((x) => String(x ?? "")))], peer = String(p.deviceId ?? "");
    if (p.confirmed !== true) throw new Error("Confirm the move first.");
    if (!ids.length || ids.length > 50 || ids.some((a) => !ID.test(a))) throw new Error("Unknown account.");
    if (!this.d.paired(peer)) throw new Error("That device is not one of your paired devices.");
    if (!this.d.online(peer)) throw new Error("That device is not online right now.");
    for (const a of ids) if (!this.d.movable(a)) throw new Error("This account is not signed in on this device, so there is nothing to move.");
    for (const r of Object.values(this.recs())) if (r.role === "out" && ["queued", "asking", "sending", "wiping"].includes(r.state)) throw new Error("Another move is still running.");
    for (const r of Object.values(this.recs())) if (r.role === "out" && ids.includes(r.acct) && r.state === "committing") throw new Error("This account is already being handed over; wait until the other device has answered.");
    const bid = randomBytes(16).toString("hex"), now = this.d.now();
    const items = ids.map((acct) => { const m = this.d.describe(acct); return { acct, provider: m?.provider ?? "", label: m?.label ?? acct }; });
    const recs = items.map((it, i): MoveRec => ({ tid: randomBytes(16).toString("hex"), role: "out", peer, peerName: this.d.peerName(peer), acct: it.acct, provider: it.provider, label: it.label, state: "queued", files: 0, bytes: 0, at: now + (ids.length - i), updated: now, ...(p.includeHistory === false ? {} : { history: { media: p.includeMedia !== false, removeAfter: p.removeHistoryAfter === true } }), ...(ids.length > 1 ? { batch: { id: bid, n: ids.length, i, items } } : {}) }));
    for (const r of recs) this.save(r);
    this.batches.set(bid, { queue: recs.slice(1).map((r) => r.tid), stopped: false });
    for (const r of recs) if (!r.batch) this.batches.delete(bid);
    this.d.changed();
    const first = recs[0]; await this.activate(first.tid, recs.length === 1);
    return { transferId: first.tid, transferIds: recs.map((r) => r.tid) };
  }
  /** What "also move the chat history" would send, for the confirm dialog. */
  estimate(accountIds: string[], includeMedia: boolean) {
    const accounts = accountIds.map((id) => { const e = this.d.host.history.estimate(id, includeMedia), m = this.d.describe(id); return { id, label: m?.label ?? id, ...e }; });
    return { accounts, messages: accounts.reduce((n, a) => n + a.messages, 0), files: accounts.reduce((n, a) => n + a.files, 0), bytes: accounts.reduce((n, a) => n + a.bytes, 0) };
  }
  /** One-shot: send this device's archive of ONE account to ONE paired device (no login moves). The receiver confirms first. */
  async sendHistory(p: { accountId: string; deviceId: string; includeMedia?: boolean }): Promise<{ transferId: string }> {
    const acct = String(p.accountId ?? ""), peer = String(p.deviceId ?? ""), m = this.d.describe(acct);
    if (!m || !ID.test(acct)) throw new Error("Unknown account."); if (!this.d.paired(peer)) throw new Error("That device is not one of your paired devices."); if (!this.d.online(peer)) throw new Error("That device is not online right now.");
    for (const r of Object.values(this.recs())) if (r.role === "out" && ["queued", "asking", "sending", "wiping"].includes(r.state)) throw new Error("Another move is still running.");
    const now = this.d.now(), rec: MoveRec = { tid: randomBytes(16).toString("hex"), role: "out", peer, peerName: this.d.peerName(peer), acct, provider: m.provider, label: m.label, state: "queued", files: 0, bytes: 0, at: now, updated: now, kind: "history", history: { media: p.includeMedia !== false, removeAfter: false } };
    this.save(rec); this.d.changed(); await this.activate(rec.tid, true); return { transferId: rec.tid };
  }
  /** Collect the login and start the transfer of one queued account. A single move reports collect errors to the caller; in a batch they fail that row only. */
  private async activate(tid: string, strict = false) {
    const r = this.get(tid); if (!r || r.state !== "queued") return;
    let files: { rel: string; data: Buffer; sha: string }[], bytes: number;
    try {
      if (!this.d.online(r.peer)) throw new Error("The connection to the other device was lost. Nothing changed.");
      const b = r.kind === "history" ? { provider: r.provider, label: r.label, files: [] as { rel: string; data: Buffer }[] } : await this.d.host.moveCollect(r.acct);
      if (!b.files.length && r.kind !== "history") throw new Error("This account has no login that can be moved.");
      files = b.files.map((f) => ({ rel: f.rel, data: f.data, sha: sha(f.data) })); bytes = files.reduce((n, f) => n + f.data.length, 0);
      if (files.length > MOVE_LIMITS.files || bytes > MOVE_LIMITS.bytes || files.some((f) => f.data.length > MOVE_LIMITS.file || unsafeRel(f.rel))) throw new Error("This login is too large to move this way.");
      r.provider = b.provider; r.label = b.label;
      if (r.history) { const e = this.d.host.history.estimate(r.acct, r.history.media); r.hist = { m: e.messages, f: e.files, b: e.bytes }; }
    } catch (e) { this.set(r, "failed", errmsg(e)); if (strict) throw e; return; }
    r.files = files.length; r.bytes = bytes; r.at = this.d.now(); this.set(r, "asking");
    const l: Live = { rec: r, q: [], bundle: { files }, sentBytes: 0, filesDone: 0, gotBytes: 0, hm: 0, hf: 0, hq: Promise.resolve() }; this.live.set(r.tid, l);
    void this.runOut(l);
  }
  /** a batch row finished (done or failed): the next one goes */
  private advance(r: MoveRec) {
    const bid = r.batch?.id, b = bid ? this.batches.get(bid) : undefined; if (!b || b.stopped) return;
    const next = b.queue.shift(); if (!next) { this.batches.delete(bid!); return; }
    void this.activate(next);
  }
  private stopBatch(bid: string | undefined, why: string) {
    const b = bid ? this.batches.get(bid) : undefined; if (!b) return; b.stopped = true;
    for (const t of b.queue.splice(0)) { const q = this.get(t); if (q && q.state === "queued") this.set(q, "failed", why); }
    this.batches.delete(bid!);
  }
  /** Either side may cancel until the target starts to install. */
  async cancel(tid: string) {
    const l = this.live.get(tid), r = l?.rec ?? this.recs()[tid]; if (!r) throw new Error("Unknown move.");
    if (r.role === "out" && (r.state === "committing" || r.state === "wiping")) throw new Error("It is too late to cancel: the other device is taking over. Wait a moment.");
    if (r.role === "in" && (r.state === "committing" || r.state === "owned")) throw new Error("It is too late to cancel.");
    if (r.state === "done" || r.state === "failed" || r.state === "aborted") return {};
    if (r.role === "out") { if (r.state === "queued") { const b = r.batch && this.batches.get(r.batch.id); if (b) b.queue = b.queue.filter((t) => t !== tid); this.set(r, "failed", "Cancelled."); return {}; } this.stopBatch(r.batch?.id, "Cancelled."); }
    void this.tx(r.peer, { t: "mv-cancel", mv: MOVE_VERSION, tid }).catch(() => {});
    this.end(l ?? this.adopt(r), new Cancelled("Cancelled.", "me"));
    return {};
  }
  private adopt(r: MoveRec): Live { const l: Live = { rec: r, q: [], sentBytes: 0, filesDone: 0, gotBytes: 0, hm: 0, hf: 0, hq: Promise.resolve() }; this.live.set(r.tid, l); return l; }

  private wait(l: Live, kinds: string[], ms: number): Promise<any> {
    if (l.cancelled) return Promise.reject(l.cancelled);
    const i = l.q.findIndex((x) => kinds.includes(x.t)); if (i >= 0) return Promise.resolve(l.q.splice(i, 1)[0]);
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { l.waiter = undefined; fail(new Error("The other device did not answer in time.")); }, ms);
      l.waiter = { kinds, ok: (x) => { clearTimeout(timer); l.waiter = undefined; ok(x); }, fail: (e) => { clearTimeout(timer); l.waiter = undefined; fail(e); }, timer };
    });
  }
  /** Stop a transfer that has not been handed over: wake whoever waits, roll the staging back. */
  private end(l: Live, why: Cancelled) {
    const r = l.rec; l.cancelled ??= why;
    if (r.role === "in" && ["asking", "staging", "staged"].includes(r.state)) { l.stage?.clear(); l.stage = undefined; l.cur = undefined; this.set(r, "aborted", why.by === "me" ? "Cancelled." : why.message); }
    else if (r.role === "out" && ["asking", "sending"].includes(r.state)) { if (l.bundle) l.bundle = undefined; this.set(r, "failed", why.by === "me" ? "Cancelled. Nothing changed." : why.message); }
    clearTimeout(l.timer); l.waiter?.fail(why);
  }

  private async runOut(l: Live) {
    const r = l.rec, o = this.o(), step = o.stepMs ?? 60_000;
    try {
      await this.tx(r.peer, { t: "mv-prepare", mv: MOVE_VERSION, tid: r.tid, acct: r.acct, provider: r.provider, label: r.label, files: r.files, bytes: r.bytes, fromName: this.d.selfName(), ...(r.kind ? { kind: r.kind } : {}), ...(r.history ? { history: r.history, hist: r.hist } : {}), ...(r.batch ? { batch: r.batch } : {}) });
      const rep = await this.wait(l, ["mv-reply"], (o.approvalMs ?? 120_000) + 10_000);
      if (rep.ok !== true && rep.reason === "denied") this.stopBatch(r.batch?.id, REASONS.denied);
      if (rep.ok !== true) throw new Cancelled(REASONS[String(rep.reason)] ?? "The other device did not accept.", "them");
      this.set(r, "sending");
      if (r.kind === "history") { await this.streamHistory(l); this.set(r, "done"); return; }
      const files = l.bundle!.files;
      await this.tx(r.peer, { t: "mv-begin", mv: MOVE_VERSION, tid: r.tid, files: files.map((f) => ({ rel: f.rel, size: f.data.length, sha: f.sha })) });
      for (let f = 0; f < files.length; f++) {
        const data = files[f].data; let i = 0;
        for (let off = 0; off < data.length || (off === 0 && data.length === 0); off += MOVE_LIMITS.chunk, i++) {
          if (l.cancelled) throw l.cancelled;
          let part = data.subarray(off, Math.min(data.length, off + MOVE_LIMITS.chunk));
          if (o.tamper) part = o.tamper({ tid: r.tid, f, i, d: Buffer.from(part) }) ?? part;
          await this.tx(r.peer, { t: "mv-chunk", mv: MOVE_VERSION, tid: r.tid, f, i, d: part.toString("base64") });
          l.sentBytes += part.length; this.d.changed();
          if (data.length === 0) break;
        }
      }
      await this.tx(r.peer, { t: "mv-end", mv: MOVE_VERSION, tid: r.tid, manifest: manifestHash(files.map((f) => ({ rel: f.rel, size: f.data.length, sha: f.sha }))) });
      const st = await this.wait(l, ["mv-staged"], step);
      if (st.ok !== true) throw new Cancelled(st.error ? String(st.error).slice(0, 200) : "The other device could not store the login.", "them");
      if (l.cancelled) throw l.cancelled;
      if (r.history) await this.streamHistory(l); // the archive first: the login is committed (and the source wiped) only after the history arrived complete
      if (l.cancelled) throw l.cancelled;
      // POINT OF NO RETURN for cancelling: from the moment mv-commit may reach the target, only the target's answer decides who owns the account.
      l.bundle = undefined; this.set(r, "committing");
      await this.tx(r.peer, { t: "mv-commit", mv: MOVE_VERSION, tid: r.tid });
      l.timer = setTimeout(() => this.resolve(r.tid), o.commitMs ?? 90_000); l.timer.unref?.();
    } catch (e) {
      if (r.state === "committing") { this.d.changed(); return; } // outcome unknown: resolved by mv-done / mv-query on reconnect
      if (l.inHistory) { r.histFailed = true; l.inHistory = false; }
      const why = e instanceof Cancelled ? e : new Cancelled(this.d.online(r.peer) ? errmsg(e) : "The connection to the other device was lost. Nothing changed.", "them");
      if (!(e instanceof Cancelled && e.by === "them")) void this.tx(r.peer, { t: "mv-cancel", mv: MOVE_VERSION, tid: r.tid }).catch(() => {});
      this.end(l, why);
    }
  }
  /** Source: stream the account's archive; resolves when the target confirmed it complete (mv-hdone). Any failure leaves the login untouched here. */
  private async streamHistory(l: Live) {
    const r = l.rec, o = this.o(), step = o.stepMs ?? 60_000, media = r.history?.media === true; l.inHistory = true;
    await this.tx(r.peer, { t: "mv-hbegin", mv: MOVE_VERSION, tid: r.tid, media, m: r.hist?.m ?? 0, f: r.hist?.f ?? 0, b: r.hist?.b ?? 0, acct: r.acct, provider: r.provider, label: r.label });
    let i = 0, msgs = 0, files = 0;
    for await (const p of this.d.host.history.pieces(r.acct, media)) {
      if (l.cancelled) throw l.cancelled;
      if (p.kind === "rows") { await this.tx(r.peer, { t: "mv-hrows", mv: MOVE_VERSION, tid: r.tid, i: i++, rows: p.rows }); msgs += p.messages; l.hm = msgs; l.sentBytes += JSON.stringify(p.rows).length; }
      else {
        const data = p.data, h = sha(data);
        await this.tx(r.peer, { t: "mv-hfile", mv: MOVE_VERSION, tid: r.tid, i: i++, chatId: p.chatId, messageId: p.messageId, attId: p.attId, mime: p.mime, name: p.name, size: data.length, sha: h });
        let j = 0; for (let off = 0; off < data.length; off += MOVE_LIMITS.chunk, j++) { if (l.cancelled) throw l.cancelled; await this.tx(r.peer, { t: "mv-hchunk", mv: MOVE_VERSION, tid: r.tid, j, d: data.subarray(off, off + MOVE_LIMITS.chunk).toString("base64") }); l.sentBytes += Math.min(MOVE_LIMITS.chunk, data.length - off); }
        files++; l.hf = files;
      }
      this.d.changed();
    }
    await this.tx(r.peer, { t: "mv-hend", mv: MOVE_VERSION, tid: r.tid, m: msgs, f: files });
    const d = await this.wait(l, ["mv-hdone"], step);
    if (d.ok !== true) throw new Cancelled(d.error ? String(d.error).slice(0, 200) : "The other device could not store the chat history.", "them");
    l.inHistory = false;
  }
  /** Source: ask the target who owns the account (after a timeout, and on every reconnect). */
  private resolve(tid: string) {
    const r = this.get(tid); if (!r || r.role !== "out" || r.state !== "committing" || this.disposed) return;
    if (!this.d.online(r.peer)) return;
    void this.tx(r.peer, { t: "mv-query", mv: MOVE_VERSION, tid }).catch(() => {});
    const l = this.live.get(tid); if (l) { clearTimeout(l.timer); l.timer = setTimeout(() => this.resolve(tid), this.o().commitMs ?? 90_000); l.timer.unref?.(); }
  }
  /** Source: the target owns the account -> wipe here, exactly once. */
  private async finishOut(tid: string) {
    const r = this.get(tid); if (!r || r.role !== "out" || r.state !== "committing") return; // already wiping / done: never twice
    const l = this.live.get(tid); clearTimeout(l?.timer);
    this.set(r, "wiping");
    let wipeError: string | undefined;
    try { await this.d.host.call("moveAwayAccount", { accountId: r.acct, confirmedSaved: true }); } catch (e) { wipeError = errmsg(e); }
    if (wipeError) r.wipeError = wipeError;
    if (r.history?.removeAfter) { try { this.d.stopSync(r.acct); this.d.host.history.remove(r.acct); } catch (e) { r.removeError = errmsg(e); } } // only now: the target owns the account and holds the history
    this.set(r, "done");
    void this.tx(r.peer, { t: "mv-ack", mv: MOVE_VERSION, tid }).catch(() => {});
  }

  // ============================================================ target: respond / frames
  async respond(tid: string, accept: boolean, accountIds?: string[]) {
    const l = this.live.get(tid), r = l?.rec; if (!l || !r || r.role !== "in" || r.state !== "asking") throw new Error("There is nothing to confirm.");
    clearTimeout(l.timer);
    if (!accept) { void this.tx(r.peer, { t: "mv-reply", mv: MOVE_VERSION, tid, ok: false, reason: "denied" }).catch(() => {}); this.end(l, new Cancelled("You said no.", "me")); return {}; }
    if (r.batch) {
      const allowed = new Set(r.batch.items.map((i) => i.acct).filter((a) => !accountIds || accountIds.includes(a)));
      this.accepted.set(r.batch.id, { peer: r.peer, allowed, at: this.d.now() });
      if (!allowed.has(r.acct)) { void this.tx(r.peer, { t: "mv-reply", mv: MOVE_VERSION, tid, ok: false, reason: "skipped" }).catch(() => {}); this.end(l, new Cancelled(REASONS.skipped, "me")); return {}; }
    }
    l.stage = new Stage(this.d.dir, this.d.sealKey, tid); this.set(r, "staging");
    try { await this.tx(r.peer, { t: "mv-reply", mv: MOVE_VERSION, tid, ok: true }); } catch (e) { this.end(l, new Cancelled("The connection to the other device was lost. Nothing was installed.", "them")); throw e; }
    this.armIdle(l);
    return {};
  }
  private armIdle(l: Live) { clearTimeout(l.timer); l.timer = setTimeout(() => this.end(l, new Cancelled("The other device stopped sending. Nothing was installed.")), this.o().stepMs ?? 60_000); l.timer.unref?.(); }

  /** Returns true when the frame was a move frame (handled). `peer` is the authenticated, paired device the frame came from. */
  /** History frames return a promise: the caller awaits it before reading the next frame (backpressure: a slow target slows the sender down). */
  onFrame(peer: string, x: any): boolean | Promise<boolean> {
    if (typeof x?.t !== "string" || !x.t.startsWith("mv-")) return false;
    try { void this.o().hook?.({ dir: "recv", t: x.t, tid: String(x.tid) }); } catch { /* test hook */ }
    if (!this.d.paired(peer) || typeof x.tid !== "string" || !TID.test(x.tid)) return true; // not a paired device / garbage: ignore, never act
    if (x.mv !== MOVE_VERSION) { if (x.t === "mv-prepare") void this.tx(peer, { t: "mv-reply", mv: MOVE_VERSION, tid: x.tid, ok: false, reason: "version" }).catch(() => {}); return true; }
    const fail = (e: unknown) => { if (typeof x.t === "string" && x.t.startsWith("mv-h")) void this.tx(peer, { t: "mv-hdone", mv: MOVE_VERSION, tid: x.tid, ok: false, error: errmsg(e).slice(0, 200) }).catch(() => {}); const l = this.live.get(x.tid); if (l && l.rec.peer === peer) { void this.tx(peer, { t: "mv-cancel", mv: MOVE_VERSION, tid: x.tid }).catch(() => {}); this.end(l, new Cancelled(errmsg(e), "them")); } };
    try { const r = this.frame(peer, x); if (r instanceof Promise) return r.then(() => true, (e) => { fail(e); return true; }); } catch (e) { fail(e); }
    return true;
  }
  private frame(peer: string, x: any): void | Promise<void> {
    const tid: string = x.tid, l = this.live.get(tid), r = l?.rec ?? this.recs()[tid];
    if (x.t === "mv-prepare") return this.onPrepare(peer, x);
    if (x.t === "mv-query") return this.onQuery(peer, tid);
    if (!r || r.peer !== peer) return; // not ours: ignore
    switch (x.t) {
      case "mv-reply": case "mv-staged": case "mv-hdone": if (r.role === "out" && l) { if (l.waiter && l.waiter.kinds.includes(x.t)) l.waiter.ok(x); else l.q.push(x); } return;
      case "mv-done": {
        if (r.role !== "out") return;
        if (x.ok === true) void this.finishOut(tid);
        else if (r.state === "committing") { this.set(r, "failed", x.error ? String(x.error).slice(0, 200) : "The other device could not start the account. Nothing changed here."); }
        return;
      }
      case "mv-state": {
        if (r.role !== "out" || r.state !== "committing") return;
        if (x.state === "owned") void this.finishOut(tid);
        else if (x.state === "not-owner") this.set(r, "failed", "The other device did not take over the account. Nothing changed here.");
        return;
      }
      case "mv-cancel": if (l) this.end(l, new Cancelled(r.role === "out" ? "The other device cancelled." : "The other device cancelled. Nothing was installed.")); return;
      case "mv-ack": return; // the source is done; nothing left to clean on the target (staging was removed at commit)
      case "mv-hbegin": return this.onHBegin(l, x);
      case "mv-hrows": return this.onHRows(l, x);
      case "mv-hfile": return this.onHFile(l, x);
      case "mv-hchunk": return this.onHChunk(l, x);
      case "mv-hend": return this.onHEnd(l, x);
      case "mv-begin": return this.onBegin(l, x);
      case "mv-chunk": return this.onChunk(l, x);
      case "mv-end": return this.onEnd(l, x);
      case "mv-commit":
        if (!l || r.role !== "in" || r.state !== "staged" || (r.history && !l.histOk)) { void this.tx(peer, { t: "mv-done", mv: MOVE_VERSION, tid, ok: false, error: "The other device no longer holds this transfer. Nothing changed." }).catch(() => {}); return; }
        return this.onCommit(l, r);
    }
  }
  private onPrepare(peer: string, x: any) {
    const tid: string = x.tid, deny = (reason: string) => { void this.tx(peer, { t: "mv-reply", mv: MOVE_VERSION, tid, ok: false, reason }).catch(() => {}); };
    if (this.recs()[tid] || this.live.has(tid)) return deny("replay"); // a transfer id works once, whatever happened to it
    const now = this.d.now(), win = this.o().windowMs ?? 10 * 60_000, hist = (this.prepares.get(peer) ?? []).filter((t) => now - t < win);
    let batch: Batch | undefined; const bx = x.batch;
    if (bx !== undefined) {
      if (typeof bx?.id !== "string" || !TID.test(bx.id) || !Array.isArray(bx.items) || bx.items.length < 2 || bx.items.length > 50 || !Number.isInteger(bx.i) || bx.i < 0 || bx.i >= bx.items.length) return deny("invalid");
      const items: BatchItem[] = bx.items.map((i: any) => ({ acct: String(i?.acct), provider: String(i?.provider), label: String(i?.label ?? "").slice(0, 100) || String(i?.acct) }));
      if (items.some((i) => !ID.test(i.acct) || !ID.test(i.provider)) || items[bx.i].acct !== String(x.acct)) return deny("invalid");
      batch = { id: bx.id, n: items.length, i: bx.i, items };
    }
    const pre = batch && this.accepted.get(batch.id), preOk = !!pre && pre.peer === peer; // the user already answered for this whole batch
    if (!preOk) { if (hist.length >= (this.o().maxPrepares ?? 5)) return deny("rate"); hist.push(now); this.prepares.set(peer, hist); }
    else if (!pre!.allowed.has(String(x.acct))) return deny("skipped");
    for (const l of this.live.values()) if (l.rec.role === "in" && ["asking", "staging", "staged", "committing"].includes(l.rec.state)) return deny("busy");
    const acct = String(x.acct), provider = String(x.provider), label = String(x.label ?? "").slice(0, 100), files = Number(x.files), bytes = Number(x.bytes), kind = x.kind === "history" ? "history" as const : undefined;
    const history = x.history && typeof x.history === "object" ? { media: x.history.media === true, removeAfter: false } : undefined, hx = x.hist || {};
    const hs = history && Number.isFinite(hx.m) && Number.isFinite(hx.f) && Number.isFinite(hx.b) && hx.m >= 0 && hx.f >= 0 && hx.b >= 0 ? { m: Math.floor(hx.m), f: Math.floor(hx.f), b: Math.floor(hx.b) } : undefined;
    if (kind && !history) return deny("invalid");
    if (!ID.test(acct) || !ID.test(provider) || !Number.isInteger(files) || files < (kind ? 0 : 1) || files > MOVE_LIMITS.files || !Number.isFinite(bytes) || bytes < 0 || bytes > MOVE_LIMITS.bytes) return deny("invalid");
    if (!this.d.host.provider(provider)) return deny("unsupported");
    if (!kind && this.d.ownLogin(acct)) return deny("live"); // a real login here; a history copy or a relayed copy is replaced at commit
    const rec: MoveRec = { tid, role: "in", peer, peerName: this.d.peerName(peer), acct, provider, label: label || acct, state: "asking", files, bytes, at: now, updated: now, ...(kind ? { kind } : {}), ...(history ? { history } : {}), ...(hs ? { hist: hs } : {}), ...(batch ? { batch } : {}) };
    this.save(rec); const l: Live = { rec, q: [], sentBytes: 0, filesDone: 0, gotBytes: 0, hm: 0, hf: 0, hq: Promise.resolve() }; this.live.set(tid, l);
    if (preOk) { l.stage = new Stage(this.d.dir, this.d.sealKey, tid); this.set(rec, "staging"); void this.tx(peer, { t: "mv-reply", mv: MOVE_VERSION, tid, ok: true }).catch(() => this.end(l, new Cancelled("The connection to the other device was lost. Nothing was installed.", "them"))); this.armIdle(l); return; }
    l.timer = setTimeout(() => { if (rec.state === "asking") { void this.tx(peer, { t: "mv-reply", mv: MOVE_VERSION, tid, ok: false, reason: "timeout" }).catch(() => {}); this.end(l, new Cancelled("Nobody answered in time.", "me")); } }, this.o().approvalMs ?? 120_000); l.timer.unref?.();
    this.d.changed();
  }
  private need(l: Live | undefined, state: InState): Live { if (!l || l.rec.role !== "in" || l.rec.state !== state) throw new Error("unexpected message"); return l; }
  // ---- history (target): applied as it arrives (merge, idempotent), verified by counts and per-file SHA-256; the login is installed only after mv-hend verified
  private onHBegin(l0: Live | undefined, x: any) {
    const l = l0; if (!l || l.rec.role !== "in" || !l.rec.history || (l.rec.kind === "history" ? l.rec.state !== "staging" : l.rec.state !== "staged") || l.hist) throw new Error("unexpected message");
    const r = l.rec; if (typeof x.acct !== "string" || x.acct !== r.acct) throw new Error("History for another account.");
    this.d.host.history.ensureAccount(r.acct, r.provider, r.label);
    l.hist = { m: 0, f: 0 }; l.hm = 0; l.hf = 0; l.inHistory = true; this.armIdle(l); this.d.changed();
  }
  private async onHRows(l0: Live | undefined, x: any) {
    const l = l0; if (!l?.hist || l.hist.cur || !Array.isArray(x.rows) || x.rows.length > 20_000) throw new Error("unexpected message");
    const n = await this.d.host.history.applyRows(l.rec.acct, x.rows);
    await new Promise<void>((r) => setImmediate(r)); // a history copy is hundreds of these in a row: let timers, the UI bridge and $ping run between batches
    l.hist.m += n; l.hm = l.hist.m; l.gotBytes += JSON.stringify(x.rows).length; this.armIdle(l); this.d.changed();
  }
  private onHFile(l0: Live | undefined, x: any) {
    const l = l0; if (!l?.hist || l.hist.cur || l.rec.history?.media !== true) throw new Error("unexpected message");
    if (typeof x.chatId !== "string" || typeof x.messageId !== "string" || typeof x.attId !== "string" || typeof x.mime !== "string" || !Number.isInteger(x.size) || x.size < 0 || x.size > MOVE_LIMITS.file || typeof x.sha !== "string" || !/^[0-9a-f]{64}$/.test(x.sha)) throw new Error("The history file list is not valid.");
    l.hist.cur = { chatId: x.chatId, messageId: x.messageId, attId: x.attId, mime: x.mime.slice(0, 200), name: typeof x.name === "string" ? x.name.slice(0, 300) : undefined, size: x.size, sha: x.sha, next: 0, chunks: [], got: 0, h: createHash("sha256") };
    if (x.size === 0) this.finishHFile(l); this.armIdle(l);
  }
  private onHChunk(l0: Live | undefined, x: any) {
    const l = l0, c = l?.hist?.cur; if (!l || !c || x.j !== c.next || typeof x.d !== "string" || x.d.length > Math.ceil(MOVE_LIMITS.chunk / 3) * 4 + 8) throw new Error("A history piece arrived out of order.");
    const part = Buffer.from(x.d, "base64"); if (part.length > MOVE_LIMITS.chunk || c.got + part.length > c.size) throw new Error("A history piece was larger than announced.");
    c.chunks.push(part); c.got += part.length; c.next++; c.h.update(part); l.gotBytes += part.length; this.armIdle(l);
    if (c.got === c.size) this.finishHFile(l); this.d.changed();
  }
  private finishHFile(l: Live) {
    const c = l.hist!.cur!; if (c.h.digest("hex") !== c.sha) throw new Error("A history file arrived damaged (checksum mismatch). Nothing was moved.");
    this.d.host.history.applyMedia(l.rec.acct, { chatId: c.chatId, messageId: c.messageId, attId: c.attId, mime: c.mime, name: c.name, data: Buffer.concat(c.chunks) });
    l.hist!.cur = undefined; l.hist!.f++; l.hf = l.hist!.f;
  }
  private onHEnd(l0: Live | undefined, x: any) {
    const l = l0; if (!l?.hist || l.hist.cur) throw new Error("The history transfer ended early. Nothing was moved.");
    if (x.m !== l.hist.m || x.f !== l.hist.f) throw new Error("The chat history is incomplete (counts differ). Nothing was moved.");
    l.histOk = true; l.inHistory = false; this.armIdle(l);
    void this.tx(l.rec.peer, { t: "mv-hdone", mv: MOVE_VERSION, tid: l.rec.tid, ok: true }).catch(() => {});
    if (l.rec.kind === "history") this.set(l.rec, "owned"); // history only: nothing more to do
  }
  private onBegin(l0: Live | undefined, x: any) {
    const l = this.need(l0, "staging"); if (l.plan) throw new Error("unexpected message");
    const r = l.rec, plan = x.files;
    if (!Array.isArray(plan) || plan.length !== r.files) throw new Error("The file list does not match what was announced.");
    let total = 0; const seen = new Set<string>();
    for (const f of plan) {
      if (unsafeRel(f?.rel) || seen.has(f.rel) || !Number.isInteger(f.size) || f.size < 0 || f.size > MOVE_LIMITS.file || typeof f.sha !== "string" || !/^[0-9a-f]{64}$/.test(f.sha)) throw new Error("The file list is not valid.");
      seen.add(f.rel); total += f.size;
    }
    if (total !== r.bytes || total > MOVE_LIMITS.bytes) throw new Error("The size does not match what was announced.");
    l.plan = plan.map((f: any) => ({ rel: f.rel, size: f.size, sha: f.sha })); l.cur = undefined; l.filesDone = 0; this.armIdle(l);
    this.nextFile(l);
  }
  /** skip zero-length files at the front (they come with one empty chunk) */
  private nextFile(l: Live) { if (l.filesDone < l.plan!.length) l.cur = { f: l.filesDone, next: 0, chunks: [], got: 0, h: createHash("sha256") }; else l.cur = undefined; }
  private onChunk(l0: Live | undefined, x: any) {
    const l = this.need(l0, "staging"); if (!l.plan || !l.cur) throw new Error("unexpected message");
    const c = l.cur, f = l.plan[c.f];
    if (x.f !== c.f || x.i !== c.next || typeof x.d !== "string" || x.d.length > Math.ceil(MOVE_LIMITS.chunk / 3) * 4 + 8) throw new Error("A piece arrived out of order.");
    const part = Buffer.from(x.d, "base64"); if (part.length > MOVE_LIMITS.chunk || c.got + part.length > f.size) throw new Error("A piece was larger than announced.");
    c.chunks.push(part); c.got += part.length; c.next++; c.h.update(part); l.gotBytes += part.length; this.armIdle(l);
    if (c.got === f.size) {
      const data = Buffer.concat(c.chunks);
      if (c.h.digest("hex") !== f.sha) throw new Error("A file arrived damaged (checksum mismatch). Nothing was installed.");
      l.stage!.put(c.f, data); l.filesDone++; this.nextFile(l);
    }
    this.d.changed();
  }
  private onEnd(l0: Live | undefined, x: any) {
    const l = this.need(l0, "staging"); if (!l.plan || l.filesDone !== l.plan.length) throw new Error("The transfer ended early. Nothing was installed.");
    if (x.manifest !== manifestHash(l.plan)) throw new Error("The transfer did not verify. Nothing was installed.");
    clearTimeout(l.timer); this.set(l.rec, "staged");
    void this.tx(l.rec.peer, { t: "mv-staged", mv: MOVE_VERSION, tid: l.rec.tid, ok: true }).catch(() => {});
    // staged and waiting for mv-commit: give up if it never comes
    this.armIdle(l);
  }
  private onCommit(l0: Live | undefined, r: MoveRec) {
    const l = this.need(l0, "staged"); clearTimeout(l.timer);
    this.set(r, "committing");
    l.commit = (async () => {
      let err: string | undefined;
      try {
        const files = l.plan!.map((p, i) => ({ rel: p.rel, data: l.stage!.get(i) }));
        await this.d.detach(r.acct); // a relayed copy stops using the other device; the real login replaces it
        await this.d.host.moveInstall(r.acct, r.provider, r.label, files, { settleMs: this.o().settleMs });
      } catch (e) { err = errmsg(e); }
      l.stage?.clear(); l.stage = undefined;
      if (err === undefined) { try { this.d.claim(r.acct); } catch { /* best effort */ } this.set(r, "owned"); await this.tx(r.peer, { t: "mv-done", mv: MOVE_VERSION, tid: r.tid, ok: true }).catch(() => {}); } // the record is durable BEFORE the answer leaves
      else { this.set(r, "aborted", err); await this.tx(r.peer, { t: "mv-done", mv: MOVE_VERSION, tid: r.tid, ok: false, error: err.slice(0, 200) }).catch(() => {}); }
    })();
  }
  /** Binding answer: after "not-owner" this target will never commit that transfer. */
  private onQuery(peer: string, tid: string) {
    const send = (state: string) => void this.tx(peer, { t: "mv-state", mv: MOVE_VERSION, tid, state }).catch(() => {});
    const l = this.live.get(tid), r = l?.rec ?? this.recs()[tid];
    if (r && r.role === "in" && r.peer !== peer) return send("not-owner");
    if (!r) { this.save({ tid, role: "in", peer, peerName: this.d.peerName(peer), acct: "", provider: "", label: "", state: "aborted", files: 0, bytes: 0, at: this.d.now(), updated: this.d.now(), reason: "never received" }); return send("not-owner"); }
    if (r.role !== "in") return send("not-owner");
    void (async () => {
      if (l?.commit) await l.commit.catch(() => {});
      const cur = this.get(tid) ?? r;
      if (cur.state === "owned") return send("owned");
      if (cur.state === "committing") { // this process died while installing: what is true on disk decides
        if (this.d.hasActive(cur.acct)) { this.set(cur, "owned"); return send("owned"); }
        this.set(cur, "aborted", "Interrupted while installing.");
      } else if (["asking", "staging", "staged"].includes(cur.state)) { if (l) this.end(l, new Cancelled("The other device asked who owns the account; this device does not.")); else this.set(cur, "aborted", "Cancelled."); }
      send("not-owner");
    })();
  }

  // ============================================================ session life cycle
  onUp(peer: string) { for (const r of Object.values(this.recs())) if (r.role === "out" && r.peer === peer && r.state === "committing") this.resolve(r.tid); }
  onDown(peer: string) {
    for (const l of [...this.live.values()]) {
      const r = l.rec; if (r.peer !== peer) continue;
      if (r.role === "out" && ["asking", "sending"].includes(r.state)) this.end(l, new Cancelled("The connection to the other device was lost. Nothing changed.", "them"));
      else if (r.role === "in" && ["asking", "staging", "staged"].includes(r.state)) this.end(l, new Cancelled("The connection to the other device was lost. Nothing was installed.", "them"));
      // committing (either side) keeps going / waits for the answer
    }
  }
  tick() { for (const r of Object.values(this.recs())) if (r.role === "out" && r.state === "committing") this.resolve(r.tid); }
  dispose() { this.disposed = true; for (const l of this.live.values()) { clearTimeout(l.timer); l.waiter?.fail(new Error("stopped")); l.stage?.clear(); } }
}
const REASONS: Record<string, string> = {
  denied: "The other device said no.", busy: "The other device is already handling a move.", replay: "The other device refused: this move was already used.",
  rate: "Too many tries. Wait a few minutes.", unsupported: "The other device cannot run this kind of account.", live: "This account is already signed in on the other device.",
  skipped: "The other device chose not to receive this one.", invalid: "The other device could not accept this account.", version: "The other device runs a different version of UniChat. Update both and try again.", timeout: "Nobody answered on the other device in time.",
};
