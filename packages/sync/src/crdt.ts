// Merge rules. Everything here is pure: joins are commutative, associative and idempotent, so replicas converge
// whatever order (and however often) they exchange state.
//
// Entities: every synced thing has a key "<kind>\u0001<id>[\u0001<id2>]".
//   - register kinds (alias, flags, folder, chatFolder, merge, mesh, setting, account, chatCache, creds):
//     last-writer-wins on the HLC stamp (device id breaks ties); a removal is a tombstone with its own stamp.
//   - messages: a small composite, see joinMessage.
import type { Message, Reaction } from "@unimsg/core";

export type Kind = "al" | "fl" | "fo" | "cf" | "me" | "ms" | "se" | "ac" | "cc" | "cr" | "msg";
export const SEP = "\u0001";
export const key = (kind: Kind, ...id: string[]) => [kind, ...id].join(SEP);
export function parseKey(k: string): { kind: Kind; id: string; id2?: string } {
  const [kind, id, id2] = k.split(SEP);
  return { kind: kind as Kind, id: id ?? "", id2 };
}
/** Account an entity belongs to ("" = global): decides per-account sync policy. */
export function accountOfKey(k: string): string {
  const { kind, id } = parseKey(k);
  if (kind === "ac" || kind === "cc" || kind === "cr") return id;
  if (kind === "se") { const m = IMPORTED_CHATS.exec(id); return m ? m[2]! : ""; } // imported-chat lists follow their account's sync mode
  if (kind === "al" || kind === "fl" || kind === "cf" || kind === "msg") return id.startsWith("mesh:") || id.startsWith("merge:") || id.startsWith("folder:") ? "" : id.split(":")[0];
  return "";
}
/** Settings that describe the user's preferences (apply everywhere). Per-device or per-install keys (backup markers, sync internals) never sync. */
export const SYNCED_SETTINGS = new Set(["retentionDays", "collapseSingleChatCommunities", "railOrder", "railGroups", "userCategories", "chatCategories"]); // the last three: groups of communities in the rail, and the user's chat categories
/** Per-account lists of chats created by a Signal / WhatsApp history import (they exist only in this setting, not in the provider's chat cache): without them a paired device would get the messages but no chat rows. */
const IMPORTED_CHATS = /^(signalImport|whatsappImport)\.chats\.(.+)$/;
export const isSyncedSetting = (k: string): boolean => SYNCED_SETTINGS.has(k) || IMPORTED_CHATS.test(k);

/** Deterministic JSON (sorted keys, undefined dropped): equal values give equal strings. */
export function canon(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => canon(x === undefined ? null : x)).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
}

export interface Reg<T = unknown> { h: string; tomb?: boolean; v?: T }
/** LWW register join: higher stamp wins; equal stamps (same device, same write) compare by content for a total order. */
export function joinReg<T>(a: Reg<T>, b: Reg<T>): Reg<T> {
  if (a.h !== b.h) return a.h > b.h ? a : b;
  const ka = canon([a.tomb ?? false, a.v]), kb = canon([b.tomb ?? false, b.v]);
  return ka >= kb ? a : b;
}

// ---- reactions: add/remove set (LWW-element-set) ---------------------------------------------------------------
// One element per (emoji, sender). Each element is its own last-writer-wins register {h: stamp, on: present?}; a removal is a tombstone
// with its own (higher) stamp. Joining two sets takes, per element, the higher stamp, so two devices adding different reactions to the same
// message at the same time both keep theirs, and a removal only beats the add it actually saw. Join is a pointwise register join: commutative,
// associative, idempotent. Count-only reactions (network reports a total but not who) are one extra pseudo element per emoji.
export interface RxEl { h: string; on: boolean; mine?: boolean; n?: number }
export type Rx = Record<string, RxEl>;
const COUNT = "\u0000count";
const rxKey = (emoji: string, sender: string) => emoji + SEP + sender;
/** Elements of a plain reaction list, all stamped `h`. */
export function rxFromReactions(rs: Reaction[] | undefined, h: string): Rx {
  const x: Rx = {};
  for (const r of rs ?? []) {
    for (const s of r.senderIds ?? []) x[rxKey(r.emoji, s)] = { h, on: true, ...(r.mine ? { mine: true } : {}) };
    if (typeof r.count === "number" && r.count > (r.senderIds?.length ?? 0)) x[rxKey(r.emoji, COUNT)] = { h, on: true, n: r.count };
    else if (!r.senderIds?.length && r.mine) x[rxKey(r.emoji, COUNT)] = { h, on: true, n: 1, mine: true };
  }
  return x;
}
/** The visible reaction list of an element set (deterministic order: emoji, then sender id). */
export function rxToReactions(x: Rx): Reaction[] {
  const by = new Map<string, { senders: string[]; mine: boolean; n: number }>();
  for (const [k, el] of Object.entries(x)) {
    if (!el.on) continue;
    const i = k.indexOf(SEP), emoji = k.slice(0, i), sender = k.slice(i + 1), e = by.get(emoji) ?? { senders: [], mine: false, n: 0 };
    if (sender === COUNT) e.n = Math.max(e.n, el.n ?? 0); else e.senders.push(sender);
    if (el.mine) e.mine = true; by.set(emoji, e);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([emoji, e]) => {
    e.senders.sort();
    return { emoji, senderIds: e.senders, ...(e.mine ? { mine: true } : {}), ...(e.n > e.senders.length ? { count: e.n } : {}) } as Reaction;
  });
}
const elOrder = (a: RxEl, b: RxEl) => (a.h !== b.h ? (a.h > b.h ? a : b) : canon([a.on, a.mine ?? false, a.n ?? 0]) >= canon([b.on, b.mine ?? false, b.n ?? 0]) ? a : b);
export function rxJoin(a: Rx, b: Rx): Rx {
  const out: Rx = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = a[k] && b[k] ? elOrder(a[k], b[k]) : (a[k] ?? b[k]);
  return JSON.parse(JSON.stringify(out));
}
/** The element set after a LOCAL change of the reaction list: unchanged elements keep their stamp, new ones get `h`, vanished ones become tombstones. */
export function rxDiff(prev: Rx, now: Reaction[] | undefined, h: string): Rx {
  const target = rxFromReactions(now, h), out: Rx = {};
  for (const [k, el] of Object.entries(target)) { const p = prev[k]; out[k] = p && p.on && canon([p.mine ?? false, p.n ?? 0]) === canon([el.mine ?? false, el.n ?? 0]) ? p : el; }
  for (const [k, p] of Object.entries(prev)) if (!(k in target)) out[k] = p.on ? { h, on: false } : p;
  return out;
}
export const rxMaxStamp = (x: Rx, floor = "") => Object.values(x).reduce((m, e) => (e.h > m ? e.h : m), floor);
/** Shape check for an element set that came over the wire (undefined = unusable). */
export function rxSanitize(x: unknown): Rx | undefined {
  if (!x || typeof x !== "object" || Array.isArray(x)) return undefined;
  const out: Rx = {}; let n = 0;
  for (const [k, e] of Object.entries(x as Record<string, any>)) {
    if (++n > 5000 || !k.includes(SEP) || !e || typeof e.h !== "string" || typeof e.on !== "boolean") return undefined;
    out[k] = { h: e.h, on: e.on, ...(e.mine ? { mine: true } : {}), ...(typeof e.n === "number" && e.n >= 0 && e.n < 1e9 ? { n: e.n } : {}) };
  }
  return out;
}

// ---- messages -------------------------------------------------------------------------------------------------
/** `x` = reaction element set; absent on records that predate it (then derived from m.reactions stamped r). */
export interface MsgRec { m: Message; c: string; r: string; x?: Rx; /** stamp of the pin register (pinned, pinnedAt, pinnedBy, pinnedUntil): last writer wins; absent = never pinned/unpinned */ p?: string }
const PIN_KEYS = ["pinned", "pinnedAt", "pinnedBy", "pinnedUntil"] as const;
/** The pin register of a message as canonical JSON (an unpinned message has none). */
export const pinSig = (m: Message): string => canon(m.pinned ? PIN_KEYS.map((k) => m[k] ?? null) : null);
export const rxOf = (a: MsgRec): Rx => a.x ?? rxFromReactions(a.m.deleted ? [] : a.m.reactions, a.r);
const RANK: Record<string, number> = { failed: 0, sending: 1, sent: 2, delivered: 3, read: 4 };
const VOLATILE = ["reactions", "status", "deleted", "mergeId", "historical", "system", ...PIN_KEYS] as const;
/** The part of a message that is "content": text, attachments, edits, poll state, cards ... everything except reactions / status / deleted. */
export function contentOf(m: Message): Record<string, unknown> {
  const o: Record<string, unknown> = { ...m };
  for (const k of VOLATILE) delete o[k];
  return JSON.parse(canon(o));
}
const contentOrder = (x: MsgRec, cc: string) => `${x.m.editedAt ?? ""}\u0000${x.c}\u0000${cc}`;
/**
 * Join of two copies of the same message (same chatId + id).
 *  - content (text, edits, poll, location, cards ...): the copy with the greatest (editedAt, content stamp, canonical content) wins as a whole,
 *    so an edit seen by one device always beats the unedited text that another device stored later;
 *  - deleted: sticky (once any replica saw the deletion it stays deleted; reactions are cleared then);
 *  - delivery status: the furthest state in sending < sent < delivered < read (failed lowest), like mergeMessage;
 *  - reactions: an add/remove set per (emoji, sender) (see above), so concurrent reactions of two devices both survive and a removal propagates.
 * This is the commutative counterpart of Store.mergeMessage (which is a replay-time merge: incoming wins field by field).
 */
export function joinMessage(a: MsgRec, b: MsgRec): MsgRec {
  const ca = canon(contentOf(a.m)), cb = canon(contentOf(b.m));
  const win = contentOrder(a, ca) >= contentOrder(b, cb) ? a : b;
  const base = JSON.parse(JSON.stringify(contentOf(win.m))) as Message;
  const out: Message = base;
  const status = [a.m.status, b.m.status].filter(Boolean).sort((x, y) => (RANK[y!] ?? 0) - (RANK[x!] ?? 0) || String(x).localeCompare(String(y)))[0];
  if (status) out.status = status;
  const x = rxJoin(rxOf(a), rxOf(b)), deleted = !!(a.m.deleted || b.m.deleted);
  if (deleted) { out.deleted = true; out.reactions = []; }
  else if (a.m.reactions || b.m.reactions || Object.keys(x).length) out.reactions = rxToReactions(x);
  // pin: its own last-writer-wins register (content stays with the edit winner), so a pin never loses to a stale copy and vice versa
  const pa = a.p ?? "", pb = b.p ?? "", pw = pa !== pb ? (pa > pb ? a : b) : pinSig(a.m) >= pinSig(b.m) ? a : b, p = pa > pb ? pa : pb;
  if (pw.m.pinned && !deleted) for (const k of PIN_KEYS) { if (pw.m[k] !== undefined) (out as any)[k] = pw.m[k]; }
  return { m: out, c: win.c, r: rxMaxStamp(x, a.r >= b.r ? a.r : b.r), x, ...(p ? { p } : {}) };
}
/** Comparable fingerprint of what a replica holds for a message (used to detect "nothing changed"). */
export const recSig = (x: MsgRec) => canon([x.m.id, x.m.chatId, contentOf(x.m), x.m.status ?? null, !!x.m.deleted, x.m.deleted ? [] : rxOf(x), x.c, x.r, pinSig(x.m), x.p ?? ""]);
/** Message with exactly the fields of `next`: patchMessage merges, so fields that disappeared must be sent as explicit undefined. */
export function fullPatch(prev: Message, next: Message): Partial<Message> {
  const p: Record<string, unknown> = { ...next };
  for (const k of Object.keys(prev)) if (!(k in next)) p[k] = undefined;
  return p as Partial<Message>;
}
