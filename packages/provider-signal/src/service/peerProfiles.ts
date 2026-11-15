// Names of people who are not in the address book: Signal puts a person's chosen profile name on the server, encrypted with their
// profile key (which we learn from their messages or from the contact sync). Fetched slowly, one at a time, only for people without a
// contact name, and remembered. Failures are counted, never logged with ids or names.
import type { SignalStore } from "../store/signalStore.js";
import type { AuthChat } from "./chatTypes.js";
import { decryptProfileName, profileKeyVersion } from "./profileCrypto.js";

const RECHECK_MS = 7 * 24 * 3600_000;   // a person without a profile name is looked at again after a week
const PACE_MS = 1500;                    // one request per 1.5 s: this is a background nicety, never a burst
const RATE_LIMIT_PAUSE_MS = 10 * 60_000;
const dbg = (s: string) => { if (process.env.UNIMSG_DEBUG) process.stderr.write(`[signal] profile names: ${s}\n`); };
const text = (b: Uint8Array | undefined | null) => Buffer.from(b ?? new Uint8Array()).toString("utf8");

export class PeerProfiles {
  private queue: string[] = []; private queued = new Set<string>();
  private running = false; private stopped = false; private pausedUntil = 0;
  private stats = { fetched: 0, none: 0, failed: 0 };
  constructor(
    private readonly store: SignalStore,
    private readonly chat: () => AuthChat | undefined,
    private readonly onNames: () => void,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  stop() { this.stopped = true; this.queue = []; this.queued.clear(); }

  /** Is there a name to look for? Needs their profile key, no saved name, no learned name, not asked recently. */
  needs(aci: string): boolean {
    const id = aci.toLowerCase(); const c = this.store.data.contacts[id];
    if (!c?.profileKey || c.name || this.store.data.names[id]) return false;
    return !c.profileNameCheckedAt || this.now() - c.profileNameCheckedAt > RECHECK_MS;
  }
  enqueue(aci: string) {
    const id = aci.toLowerCase();
    if (this.stopped) return;
    if (this.queued.has(id)) { void this.run(); return; } // already waiting (e.g. after a rate-limit pause): just wake the worker
    if (!this.needs(id)) return;
    this.queued.add(id); this.queue.push(id); void this.run();
  }
  scanAll() { for (const id of Object.keys(this.store.data.contacts)) this.enqueue(id); if (this.queue.length) { dbg(`queued=${this.queue.length}`); void this.run(); } }

  private async run() {
    if (this.running) return; this.running = true;
    let changed = 0;
    try {
      while (!this.stopped && this.queue.length) {
        if (this.now() < this.pausedUntil) break;
        const id = this.queue.shift()!; this.queued.delete(id);
        const chat = this.chat(); if (!chat) { this.queue.unshift(id); this.queued.add(id); break; } // not connected: retried by the next scanAll
        const c = this.store.data.contacts[id]; if (!c?.profileKey) continue;
        try {
          const res = await chat.fetch({ verb: "GET", path: `/v1/profile/${id}/${profileKeyVersion(Buffer.from(c.profileKey, "base64"), id)}`, headers: [] });
          if (res.status === 429) { this.pausedUntil = this.now() + RATE_LIMIT_PAUSE_MS; this.queue.unshift(id); this.queued.add(id); this.stats.failed++; break; }
          if (res.status >= 200 && res.status < 300) {
            const p = JSON.parse(text(res.body)) as { name?: string };
            if (p.name) {
              const n = decryptProfileName(p.name, Buffer.from(c.profileKey, "base64"));
              const full = n.given ? [n.given, n.family].filter(Boolean).join(" ").trim() : "";
              if (full) { this.store.data.names[id] = full; changed++; this.stats.fetched++; } else this.stats.none++;
            } else this.stats.none++;
          } else this.stats.none++; // 404 / 401 / 403: no profile or a stale key
          c.profileNameCheckedAt = this.now(); this.store.touch();
        } catch (e) { this.stats.failed++; if (/not connected|closed|interrupted/i.test(String((e as Error)?.message))) { this.queue.unshift(id); this.queued.add(id); break; } c.profileNameCheckedAt = this.now(); this.store.touch(); }
        if (this.queue.length) await this.sleep(PACE_MS);
      }
    } finally {
      this.running = false;
      if (changed) { this.store.touch(); this.onNames(); }
      dbg(`fetched=${this.stats.fetched} none=${this.stats.none} failed=${this.stats.failed} pending=${this.queue.length}`);
    }
  }
}
