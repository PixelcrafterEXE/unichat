// Startup / query cost of the global search on a SYNTHETIC archive (sealed SQLite store with a random key in a temp dir).
//   usage: TMPDIR=~/unichat-build/search pnpm exec tsx src/search.perf.ts [messages=500000] [maxMs]
// Prints: seal+insert time, FTS5 and in-memory fill time (= startup cost until search is ready), RSS growth and query latencies.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SqliteStore } from "./index.js";
import { createSearchIndex, parseQuery, type Message } from "@unimsg/core";

const N = Number(process.argv[2] ?? 500_000);
const words = "the be to of and a in that have it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us pizza friday meeting invoice holiday dinner café zürich photo report lunch tomorrow tonight weekend project deadline".split(" ");
const rnd = (n: number) => Math.floor(Math.random() * n);
const dir = mkdtempSync(join(tmpdir(), "unichat-perf-"));
try {
  const store = new SqliteStore(join(dir, "perf.db"), randomBytes(32));
  let t = performance.now();
  const base = Date.parse("2022-01-01T00:00:00Z"), span = 4 * 365 * 864e5;
  for (let i = 0; i < N; i += 5000) {
    const batch: Message[] = [];
    for (let j = i; j < Math.min(N, i + 5000); j++) {
      const len = 3 + rnd(14), text = Array.from({ length: len }, () => words[rnd(words.length)]).join(" ");
      batch.push({ id: "m" + j, chatId: `acc${j % 3}:chat${j % 400}`, accountId: `acc${j % 3}`, sender: `User ${j % 37}`, senderId: "u" + (j % 37), text, time: new Date(base + Math.floor((j / N) * span)).toISOString(), fromMe: j % 11 === 0,
        ...(j % 25 === 0 ? { attachments: [{ id: "a" + j, kind: "image" as const, mime: "image/jpeg", name: `IMG_${j}.jpg` }] } : {}) });
    }
    store.putMessages(batch);
  }
  console.log(`archive: ${N} sealed messages written in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  const rss = () => process.memoryUsage().rss / 1048576;
  for (const backend of ["fts", "memory"] as const) {
    global.gc?.(); const r0 = rss(); t = performance.now();
    const idx = createSearchIndex(store, { backend, maxEntries: 5_000_000, maxChars: 2_000_000_000 });
    await idx.rebuild();
    const fill = (performance.now() - t) / 1000;
    console.log(`\n[${backend}] engine=${idx.engine} indexed=${idx.size} startup fill=${fill.toFixed(1)} s (${Math.round(N / fill)} msg/s) rss +${(rss() - r0).toFixed(0)} MB`);
    for (const q of ["pizza", "pizz friday", '"friday night"', "café zurich", "invoice -holiday", "has:image dinner", "from:\"user 7\" after:2024-01-01 meeting", "the"]) {
      const pq = parseQuery(q); const run = () => idx.search({ pq, limit: 40, offset: 0 });
      run(); t = performance.now(); const res = run(); const ms = performance.now() - t;
      console.log(`  ${q.padEnd(40)} ${String(res.total).padStart(7)} hits  ${ms.toFixed(0).padStart(5)} ms`);
    }
    // incremental update cost
    t = performance.now(); for (let i = 0; i < 1000; i++) idx.upsert({ id: "live" + i, chatId: "acc0:chat1", accountId: "acc0", sender: "x", senderId: "x", text: "live message " + i, time: new Date().toISOString(), fromMe: false });
    console.log(`  1000 live upserts: ${(performance.now() - t).toFixed(0)} ms`);
  }
  // upper bound for what a sealed scan alone costs
  t = performance.now(); let n = 0, after: any; for (;;) { const p = store.scanMessages!({ after, limit: 1000 }); n += p.length; if (p.length < 1000) break; after = { chatId: p.at(-1)!.chatId, id: p.at(-1)!.id }; }
  console.log(`\nsealed scan alone (decrypt ${n} rows): ${((performance.now() - t) / 1000).toFixed(1)} s`);
} finally { rmSync(dir, { recursive: true, force: true }); }
