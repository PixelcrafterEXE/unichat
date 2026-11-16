#!/usr/bin/env node
// Moves the long-form documentation out of the repository and into the GitHub wiki, and keeps it there in step.
//
//   node scripts/wiki-sync.mjs --prepare        write the wiki pages to build/wiki/ and show what would change (no git, no deletes)
//   node scripts/wiki-sync.mjs --push           clone the wiki, write the pages, push  (the wiki must have one page already:
//                                               GitHub only creates <repo>.wiki.git after the first page is made in the browser)
//   node scripts/wiki-sync.mjs --push --remove  …and delete the files from the repository, rewriting every reference to them
//
// README.md files stay in the repository: they belong next to the code they describe. Everything else listed in PAGES moves.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode = args.includes("--push") ? "push" : "prepare";
const remove = args.includes("--remove");
const REPO = process.env.UNICHAT_REPO || "PixelcrafterEXE/unichat";
const WIKI_BASE = `https://github.com/${REPO}/wiki`;

/** repository file -> wiki page name (the page's URL is <wiki>/<name>) */
export const PAGES = {
  "docs/ARCHITECTURE.md": "Architecture",
  "docs/WHATSAPP_IMPORT.md": "WhatsApp-history-import",
  "docs/SIGNAL_IMPORT.md": "Signal-history-import",
  "apps/ui/e2e/COVERAGE.md": "UI-test-coverage",
  "apps/ui/e2e/PERF.md": "UI-performance",
  "packages/provider-threema-md/PROTOCOL-NOTES.md": "Threema-protocol-notes",
};
const url = (p) => `${WIKI_BASE}/${PAGES[p]}`;
/** pages the code refers to by bare file name; the generic ones (COVERAGE.md, PERF.md) are left alone on purpose */
const BARE = ["docs/ARCHITECTURE.md", "docs/WHATSAPP_IMPORT.md", "docs/SIGNAL_IMPORT.md", "packages/provider-threema-md/PROTOCOL-NOTES.md"];

const git = (dir, ...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
const tracked = () => git(root, "ls-files").split("\n").filter(Boolean);

/** Every reference to a moved file, anywhere in the repository, becomes the wiki link. */
function rewriteReferences(write) {
  const hits = [];
  for (const f of tracked()) {
    if (f in PAGES || f === "scripts/wiki-sync.mjs" || /\.(png|jpg|jpeg|ico|svg|webmanifest|zst|apk)$/.test(f)) continue; // never rewrite this script's own page map
    let s; try { s = readFileSync(join(root, f), "utf8"); } catch { continue; }
    let out = s;
    for (const p of Object.keys(PAGES)) {
      if (!out.includes(p)) continue;
      // markdown links keep their text, plain mentions in comments become the page name + link
      out = out.replaceAll(`](${p})`, `](${url(p)})`).replaceAll(`](../../${p})`, `](${url(p)})`).replaceAll(p, url(p));
    }
    for (const p of BARE) { // files the code mentions by name only, e.g. "see PROTOCOL-NOTES.md"
      const base = p.split("/").pop();
      if (out.includes(base) && !out.includes(url(p))) out = out.replaceAll(base, `${PAGES[p]} (${url(p)})`);
    }
    if (out !== s) { hits.push(f); if (write) writeFileSync(join(root, f), out); }
  }
  return hits;
}

/** Inside the wiki, links between the moved pages have to point at wiki pages, and links to code at the repository. */
function toWikiPage(p) {
  let s = readFileSync(join(root, p), "utf8");
  for (const q of Object.keys(PAGES)) s = s.replaceAll(q, PAGES[q]);
  s = s.replace(/\]\((?!https?:|#)([^)]+)\)/g, (m, target) => `](https://github.com/${REPO}/blob/main/${target.replace(/^\.\//, "")})`);
  return `${s.trimEnd()}\n\n---\n_This page lives in the [UniChat wiki](${WIKI_BASE}); it is written from [${p}](https://github.com/${REPO}) by \`scripts/wiki-sync.mjs\`._\n`;
}

const home = () => [
  "# UniChat wiki", "",
  "The long-form documentation. The [repository README](https://github.com/" + REPO + ") has the overview and the feature table,",
  "and every package keeps its own README next to its code.", "",
  ...Object.entries(PAGES).map(([p, name]) => `- **[${name.replaceAll("-", " ")}](${WIKI_BASE}/${name})** — from \`${p}\``),
  "", "_Written by `scripts/wiki-sync.mjs`; edit the sources in the repository, not these pages._", "",
].join("\n");

const missing = Object.keys(PAGES).filter((p) => !existsSync(join(root, p)));
if (missing.length && !remove) console.warn("not in the repository (already moved?): " + missing.join(", "));

if (mode === "prepare") {
  const out = join(root, "build", "wiki");
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "Home.md"), home());
  for (const p of Object.keys(PAGES)) if (existsSync(join(root, p))) writeFileSync(join(out, `${PAGES[p]}.md`), toWikiPage(p));
  const refs = rewriteReferences(false);
  console.log(`wrote ${Object.keys(PAGES).length + 1} pages to build/wiki/`);
  console.log(`${refs.length} file(s) reference a moved page and would be rewritten:\n  ${refs.join("\n  ")}`);
  console.log(`\nThe wiki repository must exist before --push works: open ${WIKI_BASE} once and create any page (GitHub has no API for it).`);
} else {
  const wiki = join(root, "build", "wiki-repo");
  rmSync(wiki, { recursive: true, force: true }); mkdirSync(dirname(wiki), { recursive: true });
  try { execFileSync("git", ["clone", "-q", `https://github.com/${REPO}.wiki.git`, wiki], { stdio: "pipe" }); }
  catch { console.error(`Cannot clone ${REPO}.wiki.git — open ${WIKI_BASE} and create one page first (GitHub creates the wiki repository with it).`); process.exit(1); }
  writeFileSync(join(wiki, "Home.md"), home());
  for (const p of Object.keys(PAGES)) if (existsSync(join(root, p))) writeFileSync(join(wiki, `${PAGES[p]}.md`), toWikiPage(p));
  git(wiki, "add", "-A");
  if (git(wiki, "status", "--porcelain").trim()) { git(wiki, "commit", "-m", "Documentation from the repository (scripts/wiki-sync.mjs)"); git(wiki, "push", "-q", "origin", "HEAD"); console.log("wiki updated: " + WIKI_BASE); }
  else console.log("wiki already up to date");
  if (remove) {
    const refs = rewriteReferences(true);
    for (const p of Object.keys(PAGES)) if (existsSync(join(root, p))) git(root, "rm", "-q", p);
    console.log(`removed ${Object.keys(PAGES).length} file(s) from the repository and rewrote ${refs.length} reference(s) — review with git diff, then commit`);
  }
}
