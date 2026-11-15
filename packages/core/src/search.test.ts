import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./store.js";
import { SearchIndex, type SearchRequest } from "./search.js";
import { FtsIndex, createSearchIndex, ftsExpression } from "./search-fts.js";
import { fold, highlightRanges, parseQuery, snippetFor } from "./searchquery.js";
import type { Message } from "./model.js";

test("parser: words, phrases, negation, operators, dates, mistakes", () => {
  const q = parseQuery('Pizza "friday night" -vegan from:"Anna Schmidt" in:family has:image has:links after:2026-01-02 before:2026-02 10:30 bogus:x has:zzz after:nope');
  assert.deepEqual(q.units.map((u) => [u.tokens.join(" "), u.prefix]), [["pizza", true], ["friday night", false], ["10 30", true], ["bogus x", true]]);
  assert.deepEqual(q.not.map((u) => u.tokens), [["vegan"]]);
  assert.deepEqual(q.from, ["anna schmidt"]); assert.deepEqual(q.in, ["family"]); assert.deepEqual(q.has, ["image", "link"]);
  assert.equal(q.after, Date.parse("2026-01-02")); assert.equal(q.before, Date.parse("2026-02-01"));
  assert.equal(q.errors.length, 2);
  assert.equal(ftsExpression(q), '("pizza"* AND "friday night" AND "10 30"* AND "bogus x"*) NOT ("vegan"*)');
});
test("fold keeps lengths; highlight extends prefix words and honours diacritics", () => {
  assert.equal(fold("Café Zürich ß"), "cafe zurich ß");
  const q = parseQuery("cafe zuri");
  const raw = "Meet at the Café Zürich tomorrow";
  const r = highlightRanges(raw, q).map(([a, b]) => raw.slice(a, b));
  assert.deepEqual(r, ["Café", "Zürich"]);
  const s = snippetFor("x".repeat(120) + " needle here " + "y".repeat(200), parseQuery("needle"));
  assert.ok(s.snippet.startsWith("…") && s.ranges.length === 1 && s.snippet.slice(...s.ranges[0]) === "needle");
});

const T = (day: number) => `2026-03-${String(day).padStart(2, "0")}T10:00:00Z`;
let n = 0;
const msg = (chatId: string, text: string, day: number, o: Partial<Message> = {}): Message => ({ id: "m" + ++n, chatId, accountId: chatId.split(":")[0], sender: "Ann", senderId: "ann", text, time: T(day), fromMe: false, ...o });
function corpus(): Message[] {
  n = 0;
  return [
    msg("a:1", "Pizza on Friday night?", 1), msg("a:1", "Café Zürich was lovely", 2, { sender: "Zoë" }), msg("a:1", "see https://example.org/menu now", 3),
    msg("a:1", "", 4, { attachments: [{ id: "x", kind: "image", mime: "image/png", name: "Holiday-Photo.png" }] }),
    msg("a:2", "the friday night plan, no pizza", 5, { fromMe: true, sender: "Me" }), msg("a:2", "vegan pizza", 6),
    msg("a:2", "", 7, { poll: { question: "Which restaurant tonight?", options: [{ id: "1", text: "Sushi", voters: [] }, { id: "2", text: "Pasta", voters: [] }], multiple: false } as any }),
    msg("b:9", "voice note about pizza", 8, { attachments: [{ id: "v", kind: "voice", mime: "audio/ogg" }] }), msg("b:9", "deleted pizza", 9, { deleted: true }),
    msg("b:9", "Überraschung! Strasse 12", 10), msg("b:9", "FILE report.pdf", 11, { attachments: [{ id: "f", kind: "file", mime: "application/pdf", name: "Quarterly-Report.pdf" }] }),
  ];
}
const req = (q: string, o: Partial<SearchRequest> = {}): SearchRequest => ({ pq: parseQuery(q), limit: 50, offset: 0, ...o });
const ids = (idx: SearchIndex, q: string, o: Partial<SearchRequest> = {}) => idx.search(req(q, o)).hits.map((h) => h.id).sort();

async function both() {
  const mk = async (backend: "fts" | "memory") => { const st = new MemoryStore(); st.putMessages(corpus()); const i = createSearchIndex(st, { backend }); await i.rebuild(); return i; };
  return { fts: await mk("fts"), mem: await mk("memory") };
}

test("FTS5 and the in-memory fallback agree on the query language", async () => {
  const { fts, mem } = await both();
  assert.equal(fts.engine, "fts5"); assert.equal(mem.engine, "memory");
  assert.ok(fts instanceof FtsIndex);
  const queries = ["pizza", "pizz", "PIZZA friday", '"friday night"', '"night friday"', "cafe", "zurich", "uberraschung", "pizza -vegan", "has:image", "has:voice", "has:link", "has:poll", "has:file",
    "from:zoe", "from:me", "from:ann pizza", "after:2026-03-05", "before:2026-03-05", "after:2026-03-05 before:2026-03-08 pizza", "holiday", "report pdf", "sushi", "restaurant to", "photo has:image", "nothingtofind", "pizza from:me has:image"];
  for (const q of queries) assert.deepEqual(ids(fts, q), ids(mem, q), `query ${q}`);
  // spot checks of absolute semantics
  const text = (i: SearchIndex, q: string) => i.search(req(q)).total;
  assert.equal(text(fts, "pizza"), 4); // deleted message not indexed
  assert.equal(text(fts, '"friday night"'), 2); assert.equal(text(fts, "cafe"), 1); assert.equal(text(fts, "pizza -vegan"), 3);
  assert.equal(text(fts, "has:image"), 1); assert.equal(text(fts, "from:me"), 1); assert.equal(text(fts, "sushi"), 1);
  assert.equal(text(fts, "after:2026-03-05 before:2026-03-08"), 3);
});

test("scope filters, paging, ranking and incremental updates", async () => {
  const { fts, mem } = await both();
  for (const i of [fts, mem]) {
    assert.deepEqual([...i.search(req("pizza", { chatIds: new Set(["a:2"]) })).perChat], [["a:2", 2]]);
    assert.equal(i.search(req("pizza", { accountIds: new Set(["b"]) })).total, 1);
    const p1 = i.search(req("pizza", { limit: 2 })), p2 = i.search(req("pizza", { limit: 2, offset: 2 }));
    assert.equal(p1.hits.length, 2); assert.equal(p2.hits.length, 2); assert.equal(new Set([...p1.hits, ...p2.hits].map((h) => h.id)).size, 4);
    const m = msg("a:1", "brand new pizzeria", 12); i.upsert(m);
    assert.equal(i.search(req("pizz")).total, 5);
    i.upsert({ ...m, text: "edited away" }); assert.equal(i.search(req("pizz")).total, 4); assert.equal(i.search(req("edited")).total, 1);
    i.upsert({ ...m, deleted: true }); assert.equal(i.search(req("edited")).total, 0);
    i.removeAccount("b"); assert.equal(i.search(req("pizza")).total, 3);
    i.removeBefore("2026-03-06T00:00:00Z"); assert.equal(i.search(req("pizza")).total, 1);
  }
  // recency + relevance: a short exact message outranks a long one with the same word
  const st = new MemoryStore(); st.putMessages([msg("a:1", "lunch " + "filler ".repeat(40), 1), msg("a:1", "lunch", 1)]);
  const f = createSearchIndex(st, { backend: "fts" }); await f.rebuild();
  assert.equal(f.search(req("lunch")).hits[0].score > f.search(req("lunch")).hits[1].score, true);
});

test("the FTS index lives in memory only and reports progress", async () => {
  const st = new MemoryStore(); st.putMessages(Array.from({ length: 2500 }, (_, i) => msg("a:1", "hello world " + i, 1 + (i % 20))));
  const fts = createSearchIndex(st, { backend: "fts", pageSize: 500 }) as FtsIndex;
  const seen: number[] = []; fts.onProgress = (n, done) => seen.push(done ? -n : n);
  await fts.rebuild();
  assert.equal(fts.size, 2500); assert.equal(seen.at(-1), -2500); assert.ok(seen.length >= 5 && seen[0] === 500);
  const db = (fts as any).db;
  assert.ok(db.prepare("PRAGMA database_list").all().every((r: any) => r.file === ""), "no database file (main and temp are memory)");
  assert.equal(db.prepare("PRAGMA temp_store").get().temp_store, 2, "temp_store=MEMORY: no spill files");
  assert.ok(["off", "memory"].includes(db.prepare("PRAGMA journal_mode").get().journal_mode));
});

test("bounded index drops the oldest messages and deep search still finds them", async () => {
  const st = new MemoryStore(); st.putMessages(Array.from({ length: 100 }, (_, i) => msg("a:1", "needle " + i, 1 + Math.floor(i / 4))));
  for (const backend of ["fts", "memory"] as const) {
    const i = createSearchIndex(st, { backend, maxEntries: 60, pageSize: 20 }); await i.rebuild();
    assert.ok(i.size < 100 && i.stats().truncated, backend);
    const shallow = i.search(req("needle", { limit: 200 })).total, deep = i.search(req("needle", { limit: 200, deep: { budgetMs: 5000 } }));
    assert.ok(shallow < 100 && deep.total === 100 && deep.deep, `${backend} ${shallow} ${deep.total}`);
  }
});
