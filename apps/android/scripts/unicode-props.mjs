// nodejs-mobile's V8 is built WITHOUT ICU: regex Unicode property escapes (\p{L}, \p{Extended_Pictographic}, ...) are a SyntaxError there
// ("Invalid property name in character class"). This rewrites every \p{X} / \P{X} in the bundle into explicit code point ranges computed
// from the build machine's own ICU, so the bundle parses on the device. Works on regex literals and on RegExp("...") strings.
// Unsupported shapes (\P{..} inside a class) throw so a new use cannot silently break the Android bundle.
const cache = new Map();
function ranges(prop) {
  if (cache.has(prop)) return cache.get(prop);
  const re = new RegExp(`^\\p{${prop}}$`, "u"); // throws on an unknown property name
  const out = []; let start = -1;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const hit = !(cp >= 0xd800 && cp <= 0xdfff) && re.test(String.fromCodePoint(cp));
    if (hit && start < 0) start = cp;
    if (!hit && start >= 0) { out.push([start, cp - 1]); start = -1; }
  }
  if (start >= 0) out.push([start, 0x10ffff]);
  cache.set(prop, out); return out;
}
const hex = (n) => n.toString(16);
const body = (prop, bs) => ranges(prop).map(([a, b]) => (a === b ? `${bs}u{${hex(a)}}` : `${bs}u{${hex(a)}}-${bs}u{${hex(b)}}`)).join("");

/** @returns {{code:string, count:number}} */
export function lowerUnicodeProps(code) {
  let count = 0;
  const out = code.replace(/(\\\\|\\)([pP])\{([A-Za-z_=]+)\}/g, (m, bs, kind, prop, offset) => {
    // inside a [...] class? scan back to the start of the line for an unescaped, unclosed "["
    const lineStart = code.lastIndexOf("\n", offset) + 1, before = code.slice(lineStart, offset);
    let depth = 0; for (let i = 0; i < before.length; i++) { const c = before[i]; if (c === "\\") i++; else if (c === "[") depth = 1; else if (c === "]") depth = 0; }
    count++;
    const esc = bs === "\\\\" ? "\\\\" : "\\"; // regex literal: \u{..}; inside a JS string the backslash is doubled
    if (depth) { if (kind === "P") throw new Error(`\\P{${prop}} inside a character class cannot be lowered`); return body(prop, esc); }
    return `[${kind === "P" ? "^" : ""}${body(prop, esc)}]`;
  });
  if (/\\[pP]\{[A-Za-z_=]+\}/.test(out)) throw new Error("unlowered unicode property escape left in the bundle");
  return { code: out, count };
}
