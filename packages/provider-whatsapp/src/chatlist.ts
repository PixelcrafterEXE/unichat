// Pure operations on the provider cache (StoreData): LID<->PN name lookup, LID chat merging, chat visibility.
import { isLidJid } from "./map.js";
import { MAX_MSGS_PER_CHAT, type StoreData } from "./store.js";
import type { NameSources } from "./names.js";

// pn -> lids, cached per lidToPn object. The cache used to be validated with Object.keys(m).length on EVERY call: O(size of the map) per lookup,
// and a chat list asks once per chat (900 chats x 20k entries = seconds of the only thread on a phone). The map only changes through mergeLid (below),
// which bumps `lidVer`; code that fills lidToPn directly (loading, tests) must call lidMapChanged().
const revCache = new WeakMap<object, { v: number; rev: Record<string, string[]> }>();
const lidVer = new WeakMap<object, number>();
export function lidMapChanged(m: Record<string, string>) { lidVer.set(m, (lidVer.get(m) ?? 0) + 1); }
function reverse(m: Record<string, string>): Record<string, string[]> {
  const v = lidVer.get(m) ?? 0;
  const hit = revCache.get(m);
  if (hit && hit.v === v) return hit.rev;
  const rev: Record<string, string[]> = {};
  for (const [lid, pn] of Object.entries(m)) (rev[pn] ??= []).push(lid);
  revCache.set(m, { v, rev });
  return rev;
}

/** The other-addressing ids of the same person: pn for a lid, lid(s) for a pn. */
export function counterparts(d: StoreData, jid: string): string[] {
  if (isLidJid(jid)) { const pn = d.lidToPn[jid]; return pn ? [pn] : []; }
  return reverse(d.lidToPn)[jid] ?? [];
}

/** Collect name sources for a person under either of their ids. */
export function lookupName(d: StoreData, jid: string): NameSources {
  const ids = [jid, ...counterparts(d, jid)];
  const first = (m: Record<string, string>) => { for (const i of ids) { const v = m[i]; if (v && v.trim()) return v; } return undefined; };
  let chatName: string | undefined;
  for (const i of ids) { const c = d.chats[i]; if (c?.kind === "dm" && c.name?.trim()) { chatName = c.name; break; } }
  return { contact: first(d.contacts) ?? chatName, push: first(d.push), verified: first(d.verified) };
}

/**
 * A lid->pn mapping became known: move names, the chat, its messages and anchor from the lid id to the pn id.
 * Idempotent. Returns true when anything was merged.
 */
export function mergeLid(d: StoreData, lid: string, pn: string): boolean {
  if (d.lidToPn[lid] !== pn) lidMapChanged(d.lidToPn);
  d.lidToPn[lid] = pn;
  let changed = false;
  for (const m of [d.contacts, d.push, d.verified]) {
    if (m[lid] !== undefined) { if (m[pn] === undefined) m[pn] = m[lid]!; delete m[lid]; changed = true; }
  }
  const lc = d.chats[lid];
  if (lc) {
    const pc = (d.chats[pn] ??= { id: pn, kind: "dm" });
    if (!pc.name && lc.name) pc.name = lc.name;
    if (lc.lastMessageAt && (!pc.lastMessageAt || lc.lastMessageAt > pc.lastMessageAt)) pc.lastMessageAt = lc.lastMessageAt;
    if (lc.unread) pc.unread = (pc.unread ?? 0) + lc.unread;
    if (lc.muted) pc.muted = true;
    if (lc.archived) pc.archived = true;
    if (lc.started) pc.started = true;
    delete d.chats[lid];
    changed = true;
  }
  const lm = d.msgs[lid];
  if (lm) {
    const pm = (d.msgs[pn] ??= []);
    const seen = new Set(pm.map((x) => x.m.id));
    for (const s of lm) {
      if (seen.has(s.m.id)) continue;
      s.m.chatId = pn;
      if (s.m.senderId === lid) s.m.senderId = pn;
      pm.push(s);
    }
    pm.sort((a, b) => a.ts - b.ts);
    if (pm.length > MAX_MSGS_PER_CHAT) pm.splice(0, pm.length - MAX_MSGS_PER_CHAT);
    delete d.msgs[lid];
    changed = true;
  }
  const la = d.anchors[lid];
  if (la) { const pa = d.anchors[pn]; if (!pa || la.ts > pa.ts) d.anchors[pn] = la; delete d.anchors[lid]; changed = true; }
  return changed;
}

/** Merge everything already keyed by a lid that has a known pn (e.g. after loading an older cache). */
export function mergeAllLids(d: StoreData): number {
  let n = 0;
  for (const [lid, pn] of Object.entries({ ...d.lidToPn })) if (mergeLid(d, lid, pn)) n++;
  return n;
}

/**
 * Conversations worth showing: those with at least one message, groups/communities we are still in, and chats the
 * user started. Everything else (address-book stubs) stays cached for name lookups only.
 */
export function visibleChatIds(d: StoreData): string[] {
  return Object.values(d.chats)
    .filter((c) => (d.msgs[c.id]?.length ?? 0) > 0 || c.member === true || c.started === true)
    .map((c) => c.id);
}
