#!/usr/bin/env -S deno run -A
// UI end-to-end runner. Usage: deno run -A apps/ui/e2e/run.ts [--build] [-f name]... [-j N] [--update-shots] [--list]
import { Browser, startStaticServer, Page } from "./lib/harness.ts";
import type { TestDef } from "./lib/test.ts";

const here = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const uiDir = here.replace(/\/e2e$/, "");
const args = Deno.args;
const flag = (n: string) => args.includes(n);
const multi = (...names: string[]) => { const r: string[] = []; for (let i = 0; i < args.length; i++) if (names.includes(args[i]!) && args[i + 1]) r.push(...args[++i]!.split(",")); return r; };
const one = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

if (flag("--help") || flag("-h")) {
  console.log(`UI e2e runner (mock UI + headless Chromium)
  --build            run "pnpm --filter @unimsg/ui build" first
  --dist DIR         serve this build instead of apps/ui/dist
  -f, --filter TEXT  only tests whose "file > name" contains TEXT (case-insensitive; repeat or comma-separate; prefix ! to exclude)
  -j, --jobs N       run N tests in parallel, each worker with its own Chromium + profile (default 1)
  --retry N          re-run failing tests up to N times; passes after a retry are reported as FLAKY
  --timeout MS       per-test timeout (default 60000, a test can set its own)
  --update-shots     write named reference screenshots to apps/ui/e2e/shots/ (not compared)
  --list             list tests and exit`);
  Deno.exit(0);
}

const jobs = Math.max(1, Number(one("-j") ?? one("--jobs") ?? 1));
const retries = Number(one("--retry") ?? 0);
const defTimeout = Number(one("--timeout") ?? 60000);
const dist = one("--dist") ?? uiDir + "/dist";
const filters = multi("-f", "--filter").map((s) => s.toLowerCase());
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

// ---- build ----
if (flag("--build")) {
  console.log("building @unimsg/ui ...");
  const r = await new Deno.Command("pnpm", { args: ["--filter", "@unimsg/ui", "build"], cwd: uiDir, stdout: "inherit", stderr: "inherit" }).output();
  if (!r.success) { console.error("build failed"); Deno.exit(2); }
}
try { await Deno.stat(dist + "/index.html"); } catch { console.error(`no build at ${dist} (run with --build, or: pnpm --filter @unimsg/ui build)`); Deno.exit(2); }

// ---- discover tests ----
const all: (TestDef & { file: string })[] = [];
for await (const e of Deno.readDir(here + "/tests")) {
  if (!e.isFile || !e.name.endsWith(".ts")) continue;
  const mod = await import(`${here}/tests/${e.name}`);
  for (const t of mod.default as TestDef[]) all.push({ ...t, file: e.name.replace(/\.ts$/, "") });
}
all.sort((a, b) => a.file.localeCompare(b.file));
const label = (t: TestDef & { file: string }) => `${t.file} > ${t.name}`;
const inc = filters.filter((f) => !f.startsWith("!")), exc = filters.filter((f) => f.startsWith("!")).map((f) => f.slice(1));
const selected = all.filter((t) => { const l = label(t).toLowerCase(); return (!inc.length || inc.some((f) => l.includes(f))) && !exc.some((f) => l.includes(f)); });
if (flag("--list")) { for (const t of selected) console.log(label(t)); console.log(`${selected.length} tests`); Deno.exit(0); }
if (!selected.length) { console.error("no tests match"); Deno.exit(2); }

// ---- run ----
await Deno.remove(here + "/out", { recursive: true }).catch(() => {});
await Deno.mkdir(here + "/out", { recursive: true });
const shotDir = flag("--update-shots") ? here + "/shots" : undefined;
const server = startStaticServer(dist);
const browsers: Browser[] = [];
let cleaned = false;
const cleanup = async () => { if (cleaned) return; cleaned = true; await Promise.allSettled(browsers.map((b) => b.close())); await server.close().catch(() => {}); };
for (const sig of ["SIGINT", "SIGTERM"] as const) Deno.addSignalListener(sig, async () => { await cleanup(); Deno.exit(130); });

type Result = { test: string; status: "PASS" | "FAIL" | "FLAKY"; ms: number; checks: { name: string; ok: boolean; detail: string }[]; error?: string; attempts: number };
const results: Result[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOnce(b: Browser, t: TestDef & { file: string }): Promise<Omit<Result, "attempts" | "status"> & { passed: boolean }> {
  const page = await b.newPage();
  page.base = server.url; page.fixturesDir = here + "/fixtures"; if (shotDir) page.shotDir = `${shotDir}/${t.file}`;
  const t0 = Date.now(); let error: string | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (t.init) await page.initScript(t.init);
    const limit = t.timeout ?? defTimeout;
    await Promise.race([t.fn(page), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`test timed out after ${limit} ms`)), limit); })]);
  } catch (e) { error = (e as Error).message; }
  clearTimeout(timer);
  const failedChecks = page.checks.filter((c) => !c.ok);
  const passed = !error && failedChecks.length === 0 && page.checks.length > 0;
  if (!passed && !error && page.checks.length === 0) error = "test made no assertions";
  if (!passed) { try { await Promise.race([page.screenshot(`${here}/out/${slug(t.file)}__${slug(t.name)}.png`), sleep(5000)]); } catch { /* page may be gone */ } }
  const pageErrors = page.pageErrors.slice(0, 3);
  await Promise.race([page.close().catch(() => {}), sleep(5000)]);
  return { test: label(t), passed: passed, ms: Date.now() - t0, checks: page.checks, error: error ?? (pageErrors.length && !passed ? "page exceptions: " + pageErrors.join(" | ") : undefined) };
}

async function worker(queue: (TestDef & { file: string })[]) {
  let b = await Browser.launch(); browsers.push(b);
  for (;;) {
    const t = queue.shift(); if (!t) break;
    let r, attempts = 0;
    do {
      attempts++;
      try { r = await runOnce(b, t); }
      catch (e) { // browser crashed: replace it
        try { await b.close(); } catch { /* ignore */ }
        b = await Browser.launch(); browsers.push(b);
        r = { test: label(t), passed: false, ms: 0, checks: [], error: "harness error: " + (e as Error).message };
      }
    } while (!r.passed && attempts <= retries);
    const status = r.passed ? (attempts > 1 ? "FLAKY" : "PASS") : "FAIL";
    results.push({ test: r.test, status, ms: r.ms, checks: r.checks, error: r.error, attempts });
    const fails = r.checks.filter((c) => !c.ok);
    console.log(`${status.padEnd(5)} ${r.test}  (${(r.ms / 1000).toFixed(1)}s, ${r.checks.length - fails.length}/${r.checks.length} checks${attempts > 1 ? `, ${attempts} attempts` : ""})`);
    if (status !== "PASS") { for (const c of fails) console.log(`        x ${c.name}${c.detail ? "  -> " + c.detail : ""}`); if (r.error) console.log(`        ! ${r.error}`); }
  }
}

const started = Date.now();
try {
  const queue = [...selected];
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, () => worker(queue)));
} finally { await cleanup(); }

const pass = results.filter((r) => r.status === "PASS").length, flaky = results.filter((r) => r.status === "FLAKY").length, fail = results.filter((r) => r.status === "FAIL").length;
const checks = results.flatMap((r) => r.checks); const cf = checks.filter((c) => !c.ok).length;
console.log(`\n${"=".repeat(60)}\nTests: ${pass} PASS, ${flaky} FLAKY, ${fail} FAIL  (of ${results.length})   Assertions: ${checks.length - cf} ok, ${cf} failed   ${((Date.now() - started) / 1000).toFixed(1)}s, ${jobs} worker(s)`);
if (fail) { console.log("Failed:"); for (const r of results.filter((r) => r.status === "FAIL")) console.log("  - " + r.test); console.log(`Failure screenshots: ${here}/out/`); }
await Deno.writeTextFile(here + "/out/results.json", JSON.stringify(results, null, 1));
Deno.exit(fail ? 1 : 0);
