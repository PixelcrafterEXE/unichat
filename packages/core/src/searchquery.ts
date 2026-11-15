// Query language of the global search (pure, no Node dependencies: the mock backend of the UI uses the very same code).
//
//   words            every word must occur; each word is a PREFIX match ("pizz" finds "Pizza"); case and diacritics are ignored ("cafe" finds "Café")
//   "exact phrase"   the words in this order, as whole words
//   -word  -"a b"    must NOT occur
//   from:anna        sender name contains "anna" (from:me = my own messages; several from: = any of them)
//   in:family        chat name contains "family" (several in: = any of them)
//   has:image|video|file|voice|link|poll   the message has such an attachment / a link / a poll (several has: = all of them)
//   after:2026-01-01 before:2026-02-01     dates (YYYY, YYYY-MM or YYYY-MM-DD; after is inclusive, before exclusive; UTC)
// Values with spaces are quoted: from:"Anna Schmidt".
import { cardsOf, type Message } from "./model.js";

export type HasKind = "image" | "video" | "file" | "voice" | "link" | "poll";
export const HAS_KINDS: HasKind[] = ["image", "video", "file", "voice", "link", "poll"];
export const HAS_BIT: Record<HasKind, number> = { image: 1, video: 2, file: 4, voice: 8, link: 16, poll: 32 };

/** One searched unit: `tokens` are folded words; `prefix`: the last token may continue (plain words), false for quoted phrases. */
export interface Unit { tokens: string[]; prefix: boolean }
export interface ParsedQuery {
  raw: string;
  /** Required text units (AND) and excluded ones. */
  units: Unit[]; not: Unit[];
  from: string[]; in: string[]; has: HasKind[];
  /** Epoch ms: `after` inclusive, `before` exclusive. */
  after?: number; before?: number;
  /** Mistakes the user can fix (unknown operator value, bad date...). The rest of the query still runs. */
  errors: string[];
  /** Operators that were recognised, in the order written (for the UI's chips). */
  filters: { op: "from" | "in" | "has" | "after" | "before"; value: string }[];
}

// the class body of /[\p{L}\p{N}\p{Co}]/ taken from a regex literal, so the Android bundle step (apps/android/scripts/unicode-props.mjs, no ICU in nodejs-mobile) can lower it
const ALNUM = /[\p{L}\p{N}\p{Co}]/u.source.slice(1, -1);
const TOKEN = new RegExp(`[${ALNUM}]+`, "gu");

/** Lower-case and drop diacritics WITHOUT changing the length (offsets in the folded text are valid in the original). */
export function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch.length !== 1) { out += ch; continue; }
    let f = ch;
    if (ch.charCodeAt(0) > 127) { const d = ch.normalize("NFD"); if (d.length > 1 && /^\p{M}$/u.test(d[1])) f = d[0]; }
    const l = f.toLowerCase();
    out += l.length === 1 ? l : f;
  }
  return out;
}
export const tokenize = (s: string): string[] => fold(s).match(TOKEN) ?? [];

const dateMs = (v: string): number | undefined => {
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v)) return undefined;
  const t = Date.parse(v.length === 4 ? v + "-01-01" : v.length === 7 ? v + "-01" : v);
  return Number.isFinite(t) ? t : undefined;
};

export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = { raw: input, units: [], not: [], from: [], in: [], has: [], errors: [], filters: [] };
  // split into pieces: [-]op:value, [-]"phrase", [-]word. Quotes may follow op: or a leading minus.
  const re = /(-)?(?:(\w+):)?(?:"([^"]*)"?|(\S+))/gu;
  for (let m: RegExpExecArray | null; (m = re.exec(input)); ) {
    const neg = !!m[1];
    let op: string | undefined = m[2]?.toLowerCase(); const quoted = m[3] !== undefined; let val = (m[3] ?? m[4] ?? "").trim();
    if (op && !["from", "in", "has", "after", "before"].includes(op)) { val = `${m[2]}:${val}`; op = undefined; }
    if (!op) {
      const tokens = tokenize(val); if (!tokens.length) continue;
      (neg ? q.not : q.units).push({ tokens, prefix: !quoted });
      continue;
    }
    if (!val) continue;
    if (neg) { q.errors.push(`"-${op}:" is not supported`); continue; }
    const fv = fold(val);
    if (op === "from") { q.from.push(fv); q.filters.push({ op, value: val }); }
    else if (op === "in") { q.in.push(fv); q.filters.push({ op, value: val }); }
    else if (op === "has") {
      const k = (fv === "images" || fv === "photo" || fv === "picture" ? "image" : fv === "videos" ? "video" : fv === "files" || fv === "document" ? "file" : fv === "audio" ? "voice" : fv === "links" || fv === "url" ? "link" : fv === "polls" ? "poll" : fv) as HasKind;
      if (HAS_KINDS.includes(k)) { if (!q.has.includes(k)) q.has.push(k); q.filters.push({ op, value: k }); } else q.errors.push(`has:${val} is not known (use ${HAS_KINDS.join(", ")})`);
    } else {
      const t = dateMs(val), dop = op as "after" | "before";
      if (t === undefined) q.errors.push(`${op}:${val} is not a date (use YYYY-MM-DD)`);
      else { if (op === "after") q.after = Math.max(q.after ?? 0, t); else q.before = Math.min(q.before ?? Infinity, t); q.filters.push({ op: dop, value: val }); }
    }
  }
  return q;
}
/** Nothing to search for (only mistakes, or empty). */
export const isEmptyQuery = (q: ParsedQuery) => !q.units.length && !q.from.length && !q.in.length && !q.has.length && q.after === undefined && q.before === undefined;

/** has:... bits of a message (stored with the index entry). */
export function messageFlags(m: Message): number {
  let f = 0;
  for (const a of m.attachments ?? []) {
    f |= a.kind === "image" || a.kind === "sticker" ? HAS_BIT.image : a.kind === "video" ? HAS_BIT.video : a.kind === "voice" ? HAS_BIT.voice : HAS_BIT.file;
    if (a.kind === "audio") f |= HAS_BIT.voice;
  }
  if (m.poll) f |= HAS_BIT.poll;
  if (/(?:https?:\/\/|www\.)\S/i.test(m.text ?? "") || cardsOf(m).some((c) => c.kind === "link")) f |= HAS_BIT.link;
  return f;
}
export const hasMask = (q: ParsedQuery) => q.has.reduce((n, k) => n | HAS_BIT[k], 0);

/** Regex for a unit over FOLDED text (whole-word start; phrases also whole-word end). */
export function unitRegex(u: Unit, flags = "u"): RegExp {
  const body = u.tokens.join(`[^${ALNUM}]+`);
  return new RegExp(`(?<![${ALNUM}])${body}${u.prefix ? "" : `(?![${ALNUM}])`}`, flags);
}
/** Compile the text part (units + not) into a predicate over folded text. */
export function textMatcher(q: ParsedQuery): (folded: string) => boolean {
  const pos = q.units.map((u) => unitRegex(u)), neg = q.not.map((u) => unitRegex(u));
  return (t) => pos.every((r) => r.test(t)) && !neg.some((r) => r.test(t));
}
/** [start,end) ranges of every matched unit in `text` (original text; prefix words are extended to the end of the word), merged and sorted. */
export function highlightRanges(text: string, q: ParsedQuery): [number, number][] {
  const low = fold(text), out: [number, number][] = [];
  for (const u of q.units) {
    const r = unitRegex(u, "gu");
    for (let m: RegExpExecArray | null; (m = r.exec(low)); ) {
      let end = m.index + m[0].length;
      if (u.prefix) while (end < low.length && new RegExp(`[${ALNUM}]`, "u").test(low[end])) end++;
      out.push([m.index, end]);
      if (!m[0].length) r.lastIndex++;
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of out) { const l = merged.at(-1); if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else merged.push([r[0], r[1]]); }
  return merged;
}
/** ~130 characters around the first match, with highlight offsets inside the snippet. */
export function snippetFor(raw: string, q: ParsedQuery): { snippet: string; ranges: [number, number][] } {
  const flat = raw.replace(/\s+/g, " ").trim(), all = highlightRanges(flat, q);
  const first = all[0]?.[0] ?? 0, start = Math.max(0, first - 40), end = Math.min(flat.length, start + 130);
  const pre = start > 0 ? "…" : "";
  const ranges = all.filter(([a, b]) => b > start && a < end).map(([a, b]): [number, number] => [pre.length + Math.max(a, start) - start, pre.length + Math.min(b, end) - start]);
  return { snippet: pre + flat.slice(start, end) + (end < flat.length ? "…" : ""), ranges };
}
