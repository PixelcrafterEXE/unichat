// A tolerant reader for the SQL that Signal Android writes into a backup. NOTHING IS EVER EXECUTED: statements are tokenised and
// only two shapes are understood, everything else is ignored:
//   CREATE TABLE [IF NOT EXISTS] name ( col type ..., constraint ... )      -> the column order of `name`
//   INSERT [OR x] INTO name [(c1, c2, ...)] VALUES (v, v, ...) [, (...)]    -> rows; `?` takes the next bound parameter
// Values: ?  ?NNN  'text' ('' escapes a quote)  numbers (int/float/hex)  NULL  TRUE/FALSE  X'hex' blobs.
import type { SqlValue } from "./legacy.js";

type Tok = { t: "id" | "str" | "num" | "blob" | "param" | "sym"; v: string };
const MAX_SQL = 8 * 1024 * 1024;

export function tokenize(sql: string): Tok[] | undefined {
  if (sql.length > MAX_SQL) return undefined;
  const out: Tok[] = []; let i = 0; const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === " " || c === "\n" || c === "\t" || c === "\r") { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") { const e = sql.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'") { // string literal
      let s = ""; i++;
      for (;;) { if (i >= n) return undefined; if (sql[i] === "'") { if (sql[i + 1] === "'") { s += "'"; i += 2; continue; } i++; break; } s += sql[i++]; }
      out.push({ t: "str", v: s }); continue;
    }
    if ((c === "x" || c === "X") && sql[i + 1] === "'") {
      const e = sql.indexOf("'", i + 2); if (e < 0) return undefined; const hex = sql.slice(i + 2, e);
      if (!/^([0-9a-fA-F]{2})*$/.test(hex)) return undefined; out.push({ t: "blob", v: hex }); i = e + 1; continue;
    }
    if (c === '"' || c === "`" || c === "[") { // quoted identifier
      const close = c === "[" ? "]" : c; let s = ""; i++;
      for (;;) { if (i >= n) return undefined; if (sql[i] === close) { if (close !== "]" && sql[i + 1] === close) { s += close; i += 2; continue; } i++; break; } s += sql[i++]; }
      out.push({ t: "id", v: s }); continue;
    }
    if (c === "?") { let j = i + 1; while (j < n && /\d/.test(sql[j]!)) j++; out.push({ t: "param", v: sql.slice(i + 1, j) }); i = j; continue; }
    if (/[0-9]/.test(c) || ((c === "-" || c === "+" || c === ".") && /[0-9.]/.test(sql[i + 1] ?? ""))) {
      const m = /^[+-]?(0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(sql.slice(i, i + 64));
      if (m) { out.push({ t: "num", v: m[0] }); i += m[0].length; continue; }
    }
    if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++; out.push({ t: "id", v: sql.slice(i, j) }); i = j; continue; }
    out.push({ t: "sym", v: c }); i++;
  }
  return out;
}
const kw = (t: Tok | undefined, w: string) => !!t && t.t === "id" && t.v.toLowerCase() === w;

export type Parsed =
  | { kind: "create"; table: string; columns: string[] }
  | { kind: "insert"; table: string; columns?: string[]; rows: SqlValue[][] }
  | { kind: "other" };

function literal(t: Tok): SqlValue | undefined {
  if (t.t === "str") return t.v;
  if (t.t === "blob") return Buffer.from(t.v, "hex");
  if (t.t === "num") {
    if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(t.v)) return Number(t.v);
    if (/^[+-]?\d+$/.test(t.v)) { const b = BigInt(t.v); return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b; }
    const f = Number(t.v); return Number.isFinite(f) ? f : undefined;
  }
  if (t.t === "id") { const l = t.v.toLowerCase(); if (l === "null") return null; if (l === "true") return 1; if (l === "false") return 0; }
  return undefined;
}

/** Parse one statement with its bound parameters. Never throws: unknown/odd input is `other`. */
export function parseStatement(sql: string, params: SqlValue[]): Parsed {
  const t = tokenize(sql); if (!t || !t.length) return { kind: "other" };
  let i = 0;
  if (kw(t[0], "create")) {
    i = 1; if (kw(t[i], "temp") || kw(t[i], "temporary")) i++;
    if (!kw(t[i], "table")) return { kind: "other" }; i++;
    if (kw(t[i], "if") && kw(t[i + 1], "not") && kw(t[i + 2], "exists")) i += 3;
    let name = t[i++]?.v; if (t[i]?.v === "." && t[i + 1]) { name = t[i + 1]!.v; i += 2; } // schema.name
    if (!name || t[i]?.v !== "(") return { kind: "other" }; i++;
    const cols: string[] = []; let depth = 0, atStart = true;
    for (; i < t.length; i++) {
      const k = t[i]!;
      if (k.t === "sym" && k.v === "(") depth++;
      else if (k.t === "sym" && k.v === ")") { if (depth === 0) break; depth--; }
      else if (k.t === "sym" && k.v === "," && depth === 0) { atStart = true; continue; }
      else if (atStart && depth === 0) {
        atStart = false;
        const l = k.v.toLowerCase();
        if (k.t === "id" && ["primary", "unique", "foreign", "check", "constraint"].includes(l) && (t[i + 1]?.t === "id" || t[i + 1]?.v === "(")) continue; // table constraint
        cols.push(k.v.toLowerCase());
      }
    }
    return { kind: "create", table: name.toLowerCase(), columns: cols };
  }
  if (!kw(t[0], "insert") && !kw(t[0], "replace")) return { kind: "other" };
  i = 1; if (kw(t[0], "insert") && kw(t[i], "or")) i += 2; // INSERT OR REPLACE
  if (!kw(t[i], "into")) return { kind: "other" }; i++;
  let table = t[i++]?.v; if (t[i]?.v === "." && t[i + 1]) { table = t[i + 1]!.v; i += 2; }
  if (!table) return { kind: "other" };
  let columns: string[] | undefined;
  if (t[i]?.v === "(") { columns = []; i++; while (i < t.length && t[i]!.v !== ")") { if (t[i]!.v !== ",") columns.push(t[i]!.v.toLowerCase()); i++; } i++; }
  if (!kw(t[i], "values")) return { kind: "other" }; i++;
  const rows: SqlValue[][] = []; let next = 0;
  while (t[i]?.v === "(") {
    i++; const row: SqlValue[] = [];
    while (i < t.length && !(t[i]!.t === "sym" && t[i]!.v === ")")) {
      const k = t[i]!;
      if (k.t === "sym" && k.v === ",") { i++; continue; }
      if (k.t === "param") { const idx = k.v ? Number(k.v) - 1 : next++; if (k.v) next = Math.max(next, idx + 1); row.push(idx >= 0 && idx < params.length ? params[idx]! : null); i++; continue; }
      const v = literal(k); if (v === undefined) return { kind: "other" }; row.push(v); i++;
    }
    i++; rows.push(row);
    if (t[i]?.v === ",") i++;
  }
  if (!rows.length) return { kind: "other" };
  return { kind: "insert", table: table.toLowerCase(), columns, rows };
}

/** Schema of every table seen so far (CREATE TABLE statements arrive first in a real backup). */
export class Schema {
  private cols = new Map<string, string[]>();
  note(table: string, columns: string[]) { this.cols.set(table, columns); }
  has(table: string) { return this.cols.has(table); }
  columns(table: string) { return this.cols.get(table); }
  /** Name -> value for one inserted row. Undefined when the row cannot be interpreted (positional insert into an unknown table, width mismatch). */
  row(table: string, columns: string[] | undefined, values: SqlValue[]): Record<string, SqlValue> | undefined {
    const names = columns ?? this.cols.get(table);
    if (!names || names.length === 0) return undefined;
    if (columns && columns.length !== values.length) return undefined;
    const o: Record<string, SqlValue> = {};
    for (let k = 0; k < Math.min(names.length, values.length); k++) o[names[k]!] = values[k]!;
    return o;
  }
}
