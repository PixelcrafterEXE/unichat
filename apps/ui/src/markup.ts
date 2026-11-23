// Message markup -> a small tree (no DOM, no HTML strings): RichText.tsx turns it into React elements.
// One parser per dialect behind a shared tree, because every network writes formatting its own way
// (WhatsApp *bold* _italic_ ~strike~, Matrix HTML, ...). Only Discord's dialect is implemented so far (issue #98).
//
// Discord: headings (# ## ###, -# subtext) at a line start, **bold** *italic* _italic_ __underline__ ~~strike~~
// (and combinations such as ***bold italic***), `code` and ```lang fenced blocks```, > quote lines and >>> quote-the-rest,
// - / * / 1. lists, ||spoilers||, [masked](https://links), <https://no-embed> links, and \escapes.
// The inline rules follow the regexes of simple-markdown, which Discord's client is built on.

export type Inline =
  | string
  | { t: "b" | "i" | "u" | "s" | "spoiler"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "url"; href: string }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "sub"; c: Inline[] }
  | { t: "pre"; v: string; lang?: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; items: { indent: number; marker: string; c: Inline[] }[] };

export type Dialect = "discord";

/** Cheap check: could this text contain any formatting at all? Plain text keeps the old, simpler rendering. */
export function hasMarkup(text: string): boolean {
  return /[*_~|`\\[<]/.test(text) || /^[ \t]*(#{1,3} |-# |>>> |> |>$|[-*] |\d{1,9}\. )/m.test(text);
}

// ---------------------------------------------------------------- inline
const URL_AT = /https?:\/\/[^\s<]+[^\s<.,;:!?)"'*_~|]/y;
type Rule = { re: RegExp; make: (m: RegExpExecArray, prev: string) => Inline | undefined };
const rules: Rule[] = [
  { re: /\\([^0-9A-Za-z\s])/y, make: (m) => m[1]! },
  { re: /<(https?:\/\/[^\s>]+)>/y, make: (m) => ({ t: "url", href: m[1]! }) },
  { re: /\[((?:\[[^\]\n]*\]|[^[\]\n])+)\]\(\s*<?(https?:\/\/[^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)>?\s*\)/y, make: (m) => ({ t: "link", href: m[2]!, c: inline(m[1]!) }) },
  { re: URL_AT, make: (m) => ({ t: "url", href: m[0] }) },
  { re: /(`+)([\s\S]*?[^`])\1(?!`)/y, make: (m) => ({ t: "code", v: m[2]!.replace(/^ ([\s\S]*\S[\s\S]*) $/, "$1") }) },
  { re: /\|\|([\s\S]+?)\|\|/y, make: (m) => ({ t: "spoiler", c: inline(m[1]!) }) },
  { re: /\*\*((?:\\[\s\S]|[^\\])+?)\*\*(?!\*)/y, make: (m) => ({ t: "b", c: inline(m[1]!) }) },
  { re: /__((?:\\[\s\S]|[^\\])+?)__(?!_)/y, make: (m) => ({ t: "u", c: inline(m[1]!) }) },
  { re: /\*(?=\S)((?:\*\*|\\[\s\S]|\s+(?:\\[\s\S]|[^\s*\\]|\*\*)|[^\s*\\])+?)\*(?!\*)/y, make: (m) => ({ t: "i", c: inline(m[1]!) }) },
  // _italic_ only between word boundaries: snake_case_names stay as they are
  { re: /_((?:__|\\[\s\S]|[^\\_])+?)_(?![A-Za-z0-9_])/y, make: (m, prev) => (/[A-Za-z0-9_]/.test(prev) ? undefined : { t: "i", c: inline(m[1]!) }) },
  { re: /~~([\s\S]+?)~~/y, make: (m) => ({ t: "s", c: inline(m[1]!) }) },
];
const PLAIN = /[^\\<[`|*_~h]+/y;

export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  const push = (x: Inline) => { if (typeof x === "string" && typeof out[out.length - 1] === "string") out[out.length - 1] += x; else out.push(x); };
  let i = 0;
  outer: while (i < s.length) {
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(s);
      if (!m) continue;
      const node = r.make(m, i > 0 ? s[i - 1]! : "");
      if (node === undefined) continue;
      push(node); i += m[0].length; continue outer;
    }
    PLAIN.lastIndex = i;
    const p = PLAIN.exec(s);
    if (p) { push(p[0]); i += p[0].length; } else { push(s[i]!); i++; }
  }
  return out;
}

// ---------------------------------------------------------------- blocks
const FENCE = /```(?:([A-Za-z0-9_+#.-]{1,32})\n)?\n?([\s\S]*?)\n?```/g;

export function parse(text: string, _dialect: Dialect = "discord"): Block[] {
  // fenced code first: nothing inside it is markup; then lines, where ">>> " quotes everything after it (fences included)
  const segs: ({ t: "text"; v: string; at: number } | { t: "pre"; v: string; lang?: string; at: number })[] = [];
  let last = 0; FENCE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = FENCE.exec(text)); ) {
    if (!m[2]!.trim() && !m[1]) continue; // "``````": nothing to show as code
    if (m.index > last) segs.push({ t: "text", v: text.slice(last, m.index), at: last });
    segs.push({ t: "pre", v: m[2]!, ...(m[1] ? { lang: m[1] } : {}), at: m.index });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ t: "text", v: text.slice(last), at: last });

  const out: Block[] = [];
  for (const sg of segs) {
    if (sg.t === "pre") { out.push({ t: "pre", v: sg.v, ...(sg.lang ? { lang: sg.lang } : {}) }); continue; }
    const q = /^[ \t]*>>> ?/m.exec(sg.v);
    if (q) {
      lines(sg.v.slice(0, q.index), out);
      out.push({ t: "quote", c: parse(text.slice(sg.at + q.index + q[0].length)) });
      return out;
    }
    lines(sg.v, out);
  }
  return out;
}

function lines(src: string, out: Block[]) {
  const ls = src.split("\n");
  // a fence or block boundary leaves a newline at the seam: it is the block break itself, not an empty line
  if (ls.length && ls[0] === "" && out.length) ls.shift();
  if (ls.length > 1 && ls[ls.length - 1] === "") ls.pop();
  let para: string[] = [];
  const flush = () => { if (para.length && para.some((l) => l.trim())) out.push({ t: "p", c: inline(para.join("\n")) }); para = []; };
  for (let k = 0; k < ls.length; k++) {
    const l = ls[k]!;
    let m: RegExpExecArray | null;
    if ((m = /^[ \t]*> ?(.*)$/.exec(l)) && (/^[ \t]*> /.test(l) || /^[ \t]*>$/.test(l))) {
      flush(); const q = [m[1]!];
      while (k + 1 < ls.length && /^[ \t]*>( |$)/.test(ls[k + 1]!)) q.push(ls[++k]!.replace(/^[ \t]*> ?/, ""));
      out.push({ t: "quote", c: parse(q.join("\n")) });
    } else if ((m = /^(#{1,3}) +(\S.*)$/.exec(l))) { flush(); out.push({ t: "h", level: m[1]!.length as 1 | 2 | 3, c: inline(m[2]!) }); }
    else if ((m = /^-# +(\S.*)$/.exec(l))) { flush(); out.push({ t: "sub", c: inline(m[1]!) }); }
    else if ((m = /^([ \t]*)([-*]|\d{1,9}\.) +(\S.*)$/.exec(l))) {
      flush();
      const items: { indent: number; marker: string; c: Inline[] }[] = [];
      const item = (mm: RegExpExecArray) => items.push({ indent: Math.min(3, Math.floor(mm[1]!.replace(/\t/g, "  ").length / 2)), marker: /\d/.test(mm[2]!) ? mm[2]! : "•", c: inline(mm[3]!) });
      item(m);
      for (let n: RegExpExecArray | null; k + 1 < ls.length && (n = /^([ \t]*)([-*]|\d{1,9}\.) +(\S.*)$/.exec(ls[k + 1]!)); k++) item(n);
      out.push({ t: "list", items });
    } else para.push(l);
  }
  flush();
}

/** The text without its markup (for places that show one plain line). */
export function plain(text: string): string {
  const walk = (c: Inline[]): string => c.map((x) => (typeof x === "string" ? x : x.t === "code" ? x.v : x.t === "url" ? x.href : x.t === "spoiler" ? "▒▒▒" : walk(x.c))).join("");
  return parse(text).map((b) => (b.t === "pre" ? b.v : b.t === "quote" ? b.c.map((q) => (q.t === "p" || q.t === "h" || q.t === "sub" ? walk(q.c) : "")).join(" ") : b.t === "list" ? b.items.map((i) => walk(i.c)).join(" ") : walk(b.c))).join(" ");
}
