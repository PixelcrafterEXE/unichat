// Avatar sync: profile pictures are replicated between paired devices so a device without a live connection (signed out, archived,
// never signed in) still shows them. Pull-based over the existing session RPC, deliberately OUTSIDE the ledger, so it can never delay messages:
//   av.list  {after,limit} -> [{k,s,t,z}]  key, sha-256, fetchedAt, size of every real avatar the peer holds (paged, ~100 bytes each)
//   av.get   {k,s}         -> {k,s,t,z,mime,d(base64)}  one picture (<= AVATAR_MAX_BYTES, so it fits one RPC message)
// Deletions travel as TOMBSTONES (st "gone", t = deletion time, kept 30 days) and "the provider has no picture" as st "none" (only while younger
// than 1 h, so peers do not all hammer the provider). Last writer wins by time: a tombstone beats an older picture, a newer picture beats a
// tombstone, and "none" never replaces a picture. The puller compares by hash: an avatar it already holds with the same sha is never requested again (delta). A different sha wins only
// when the sender's fetchedAt is newer (last writer wins). Limits: AVATAR_MAX_BYTES per picture, AVATAR_TOTAL_BYTES in total (the store
// evicts the oldest), at most MAX_PER_RUN pictures per run, a gap between requests, one run per peer every `everyMs`, and nothing at all on a
// metered connection unless the media policy is "all". Only accounts that exist here and are not set to "none" are accepted; no secrets are involved.
import { AVATAR_MAX_BYTES, AVATAR_NEGATIVE_MS, avatarKeyId, avatarTomb, avatarWins, pruneAvatarStore, type AvatarState, type StoredAvatar, type Store } from "@unimsg/core";
import { createHash } from "node:crypto";

export interface AvatarDeps {
  store: Store;
  ask(peer: string, method: string, p: unknown, ms?: number): Promise<any>;
  peers(): string[];
  modeNone(acct: string): boolean;
  hasAccount(acct: string): boolean;
  /** true = do not pull now (metered connection and the media policy is not "all") */
  held(): boolean;
  emit(event: string, data: unknown): void;
  now(): number;
  /** tell a peer our store gained pictures (a small `av.hint` rpc; failures ignored) */
  notify?(peer: string): void;
}
interface Item { k: string; s: string; t: number; z: number; st?: "none" | "gone"; r?: string }
export const MAX_PER_RUN = 200, LIST_PAGE = 400, AV_KEY = /^(chat|space|contact|emoji)\|[^\s]{1,400}$/;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const avatarAccount = (key: string) => { const id = avatarKeyId(key), i = id.indexOf(":"); return i < 0 ? "" : id.slice(0, i); };

export class Avatars {
  stats = { listed: 0, fetched: 0, fetchedBytes: 0, skipped: 0, rejected: 0, served: 0, servedBytes: 0, runs: 0, moved: 0, hintsSent: 0, hintsGot: 0 };
  /** minimum time between two runs against the same peer; the gap between two requests */
  everyMs = 5 * 60_000; gapMs = 40; startDelayMs = 2_000;
  /** after a pull that moved pictures the next one is due this soon (repeats until a pull moves nothing); hints are sent at most this often */
  perRun = MAX_PER_RUN; drainMs = 15_000; hintEveryMs = 10_000; nudgeDelayMs = 500;
  private last = new Map<string, number>(); private running = false; private applying = false; private hintAt = 0; private hintT?: ReturnType<typeof setTimeout>; private nudgeT?: ReturnType<typeof setTimeout>;
  constructor(private d: AvatarDeps) {}

  // ---------------------------------------------------------------- serving
  list(p: { after?: string; limit?: number }): { items: Item[]; more: boolean } {
    const limit = Math.min(LIST_PAGE, Math.max(1, Math.floor(Number(p?.limit) || LIST_PAGE)));
    const after = typeof p?.after === "string" ? p.after : undefined, items: Item[] = [];
    let cur = after, more = false;
    for (let guard = 0; guard < 50 && !more; guard++) { // pages are scanned until `limit` servable items are found (hidden accounts are skipped)
      const page = this.d.store.listAvatars({ after: cur, limit: limit + 1 });
      if (!page.length) break;
      for (const m of page) {
        cur = m.key; const hidden = this.d.modeNone(avatarAccount(m.key));
        const ok = m.state === "gone" ? true : m.state === "none" ? !hidden && this.d.now() - m.fetchedAt < AVATAR_NEGATIVE_MS : !hidden && m.size <= AVATAR_MAX_BYTES;
        if (!ok) continue;
        if (items.length >= limit) { more = true; break; }
        items.push({ k: m.key, s: m.sha, t: m.fetchedAt, z: m.size, ...(m.state !== "pic" ? { st: m.state } : {}), ...(m.rev ? { r: m.rev } : {}) });
      }
      if (page.length < limit + 1) break;
    }
    return { items, more };
  }
  get(p: { k: string; s?: string }): { k: string; s: string; t: number; z: number; mime: string; d: string; r?: string } | null {
    const k = String(p?.k ?? ""); if (!AV_KEY.test(k) || this.d.modeNone(avatarAccount(k))) return null;
    const a = this.d.store.getAvatar(k); if (!a || a.empty || a.gone || !a.data.length || a.data.length > AVATAR_MAX_BYTES || (p.s && a.sha !== p.s)) return null;
    this.stats.served++; this.stats.servedBytes += a.data.length;
    return { k, s: a.sha, t: a.fetchedAt, z: a.data.length, mime: a.mime, d: Buffer.from(a.data).toString("base64"), ...(a.rev ? { r: a.rev } : {}) };
  }

  // ---------------------------------------------------------------- hints: "my store gained pictures" (throttled) -> the peer pulls soon
  /** Our store changed through something other than a pull (the Hub fetched / refreshed / deleted a picture): tell the peers, at most once per `hintEveryMs`. */
  noteLocal() {
    if (this.applying || !this.d.notify || this.hintT) return;
    const wait = Math.max(0, this.hintAt + this.hintEveryMs - this.d.now());
    this.hintT = setTimeout(() => { this.hintT = undefined; this.hintAt = this.d.now(); for (const p of this.d.peers()) { this.stats.hintsSent++; this.d.notify!(p); } }, wait + 200);
    this.hintT.unref?.();
  }
  /** A peer says it has news: pull from it in a moment (still subject to the metered rule). */
  nudge(peer: string) {
    this.stats.hintsGot++; this.last.set(peer, 0);
    if (this.nudgeT) return;
    this.nudgeT = setTimeout(() => { this.nudgeT = undefined; void this.pump(); }, this.nudgeDelayMs); this.nudgeT.unref?.();
  }
  stop() { clearTimeout(this.hintT); clearTimeout(this.nudgeT); }

  // ---------------------------------------------------------------- pulling
  /** Pull from every online peer that is due (or all of them with `force`). Never throws; safe to call often. */
  async pump(force = false): Promise<string[]> {
    if (this.running || (!force && this.d.held())) return [];
    this.running = true; const changed: string[] = [];
    try {
      for (const peer of this.d.peers()) {
        const now = this.d.now(), seen = this.last.get(peer);
        if (!force) { if (seen === undefined) { this.last.set(peer, now - this.everyMs + this.startDelayMs); continue; } if (now - seen < this.everyMs) continue; }
        this.last.set(peer, now);
        try {
          const got = await this.pullFrom(peer, force); changed.push(...got);
          if (this.stats.moved > 0) { this.stats.moved = 0; this.last.set(peer, this.d.now() - this.everyMs + this.drainMs); } // it moved something: look again soon, until a pull moves nothing
        } catch { /* peer went away: next run */ }
      }
    } finally { this.running = false; }
    if (changed.length) { pruneAvatarStore(this.d.store, this.d.now()); this.d.emit("avatars-changed", { keys: changed, source: "sync" }); }
    return changed;
  }
  private async pullFrom(peer: string, force: boolean): Promise<string[]> {
    const got: string[] = []; let after: string | undefined, budget = this.perRun;
    this.stats.runs++;
    for (let page = 0; page < 200; page++) {
      if (!force && this.d.held()) break;
      const r = await this.d.ask(peer, "av.list", { after, limit: LIST_PAGE }, 30_000);
      const items = Array.isArray(r?.items) ? r.items : []; if (!items.length) break;
      for (const it of items) {
        after = typeof it?.k === "string" ? it.k : after; this.stats.listed++;
        const w = this.wanted(it); if (!w) continue;
        if (w === "meta") { const k = this.applyMeta(it); if (k) got.push(k); continue; } // none / tombstone: no bytes, applied right away
        if (budget <= 0) return got;
        budget--;
        const a = await this.fetchOne(peer, it); if (a) got.push(a);
        if (this.gapMs) await new Promise((ok) => setTimeout(ok, this.gapMs));
      }
      if (!r.more) break;
    }
    return got;
  }
  /** Should this listed row be applied? "fetch" = request the bytes, "meta" = apply it as is (none / tombstone), false = ignore. */
  private wanted(it: any): false | "fetch" | "meta" {
    const st: AvatarState = it?.st === "gone" || it?.st === "none" ? it.st : "pic";
    const shaOk = st !== "pic" ? it?.s === "" || it?.s === undefined : typeof it?.s === "string" && /^[0-9a-f]{64}$/.test(it.s);
    if (!it || typeof it.k !== "string" || !AV_KEY.test(it.k) || !shaOk || !Number.isFinite(it.t) || it.t <= 0 || (st === "pic" && (!Number.isInteger(it.z) || it.z <= 0 || it.z > AVATAR_MAX_BYTES))) { this.stats.rejected++; return false; }
    const acct = avatarAccount(it.k);
    if (!acct || this.d.modeNone(acct) || !this.d.hasAccount(acct)) { this.stats.skipped++; return false; }
    if (st === "none" && this.d.now() - it.t >= AVATAR_NEGATIVE_MS) { this.stats.skipped++; return false; }
    if (!avatarWins({ state: st, fetchedAt: Math.min(Number(it.t), this.d.now() + 3600_000), sha: it.s ?? "" }, this.d.store.getAvatar(it.k))) { this.stats.skipped++; return false; }
    return st === "pic" ? "fetch" : "meta";
  }
  private applyMeta(it: Item): string | undefined {
    const at = Math.min(Number(it.t), this.d.now() + 3600_000);
    this.applying = true; try { this.d.store.putAvatar(it.st === "gone" ? avatarTomb(it.k, at) : { key: it.k, mime: "", data: new Uint8Array(), fetchedAt: at, sha: "", empty: true, ...(it.r ? { rev: String(it.r).slice(0, 200) } : {}) }); } finally { this.applying = false; }
    this.stats.fetched++; this.stats.moved++; return it.st === "gone" ? it.k : undefined;
  }
  private async fetchOne(peer: string, it: { k: string; s: string; t: number; z: number }): Promise<string | undefined> {
    const r = await this.d.ask(peer, "av.get", { k: it.k, s: it.s }, 30_000).catch(() => null);
    if (!r || r.k !== it.k || r.s !== it.s || typeof r.d !== "string") { this.stats.rejected++; return undefined; }
    const data = new Uint8Array(Buffer.from(r.d, "base64"));
    if (!data.length || data.length > AVATAR_MAX_BYTES || sha(data) !== it.s) { this.stats.rejected++; return undefined; }
    const mime = typeof r.mime === "string" && /^image\/[\w.+-]{1,40}$/.test(r.mime) ? r.mime : "image/jpeg";
    const a: StoredAvatar = { key: it.k, mime, data, fetchedAt: Math.min(Number(it.t), this.d.now() + 3600_000), sha: it.s, ...(typeof r.r === "string" && r.r ? { rev: r.r.slice(0, 200) } : {}) };
    this.applying = true; try { this.d.store.putAvatar(a); } finally { this.applying = false; }
    this.stats.fetched++; this.stats.moved++; this.stats.fetchedBytes += data.length;
    return it.k;
  }
}
