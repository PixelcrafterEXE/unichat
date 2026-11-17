#!/usr/bin/env node
// Keeps the README feature table in step with the live tests (issue #66).
//
//   node scripts/feature-table.mjs --write    rewrite the README cells from docs/live-results.json
//   node scripts/feature-table.mjs --check    exit 1 when the README disagrees with the results (CI)
//
// docs/live-results.json is written by scripts/live/run.mjs (real-account runs) and may hold `manual` records for things verified by hand:
//   "manual": [{ "row": "Profile pictures of people and chats", "provider": "signal", "status": "verified", "at": "2026-11-16", "note": "..." }]
// A cell is rewritten only when a result exists for its row and provider: ✅ for verified, ❌ for failed. A cell is just the emoji -- the run
// date stays in docs/live-results.json and the failure note goes into the README's notes section by hand -- and a trailing `*` ("see the notes
// below the table") is kept as it is. Cells without a result (unsupported by capability, skipped, never run) keep their hand-written text.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURES } from "./live/features.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = join(root, "README.md"), resultsFile = join(root, "docs", "live-results.json");
const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : "print";
const COLS = { WhatsApp: "whatsapp", Signal: "signal", Matrix: "matrix", Mattermost: "mattermost", Instagram: "instagram", Discord: "discord", Teams: "teams", Threema: "threema" };
const provOf = (p) => (p === "threema-md" ? "threema" : p);
const FAIL_LEGEND = "| ❌ Failing | Tried against the **real service** by the live test (`scripts/live/run.mjs`) and did not work; the note in `docs/live-results.json` says what happened. |";

const data = JSON.parse(readFileSync(resultsFile, "utf8"));
// row -> provider -> { status, at, note } (several feature ids may feed one row: any failure wins, else verified when at least one verified)
const byRow = new Map();
const put = (row, prov, r) => { if (!row) return; const m = byRow.get(row) ?? new Map(); byRow.set(row, m); const cur = m.get(prov); if (!cur || r.status === "failed" || (cur.status !== "failed" && r.at > cur.at)) m.set(prov, r); };
for (const f of FEATURES) for (const [prov, r] of Object.entries(data.results?.[f.id] ?? {})) if (r.status === "verified" || r.status === "failed") put(f.row, provOf(prov), { ...r, feature: f.id });
for (const m of data.manual ?? []) put(m.row, provOf(m.provider), { status: m.status, at: m.at, note: m.note, feature: "manual" });

const lines = readFileSync(readme, "utf8").split("\n");
const head = lines.findIndex((l) => /^\| Feature \|/.test(l));
if (head < 0) throw new Error("README feature table not found");
const cols = lines[head].split("|").slice(1, -1).map((c) => c.trim());
const legendAt = lines.findIndex((l) => l.startsWith("| 🧪 Untested"));
if (legendAt > 0 && !lines.some((l) => l.startsWith("| ❌ Failing"))) lines.splice(legendAt + 1, 0, FAIL_LEGEND);
const head2 = lines.findIndex((l) => /^\| Feature \|/.test(l));
const changes = [];
for (let i = head2 + 2; i < lines.length && lines[i].startsWith("|"); i++) {
  const cells = lines[i].split("|").slice(1, -1).map((c) => c.trim());
  const row = cells[0]; const res = byRow.get(row); if (!res) continue;
  for (let c = 1; c < cols.length; c++) {
    const prov = COLS[cols[c]]; const r = prov && res.get(prov); if (!r || cells[c] === undefined) continue; // a row may be short of columns
    const want = r.status === "verified" ? "✅" : "❌";
    const star = cells[c].endsWith("*") && cells[c].slice(0, -1).trim() === want; // a hand-added "see the notes below" marker survives
    if (cells[c] !== want && !star) { changes.push(`${row} / ${cols[c]}: "${cells[c].slice(0, 50)}" -> "${want}"`); cells[c] = want; }
  }
  lines[i] = "| " + cells.join(" | ") + " |";
}
if (mode === "write") { writeFileSync(readme, lines.join("\n")); console.log(`${changes.length} cell(s) updated`); for (const c of changes) console.log("  " + c); }
else if (mode === "check") { if (changes.length) { console.error(`README feature table is out of date (${changes.length} cell(s)); run: node scripts/feature-table.mjs --write`); for (const c of changes) console.error("  " + c); process.exit(1); } console.log("README feature table matches docs/live-results.json"); }
else for (const c of changes) console.log(c);
