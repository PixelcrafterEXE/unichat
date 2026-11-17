#!/usr/bin/env node
// Builds the public demo of the UI (https://pixelcrafterexe.github.io/unichat/): the normal web build, served under the
// repository's Pages path and pinned to the mock data, because there is no backend behind it.
//   node scripts/build-demo.mjs [--base /unichat/] [--out apps/ui/dist-demo]
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const base = opt("--base", "/unichat/"), out = opt("--out", "dist-demo");

execFileSync("npx", ["vite", "build", `--base=${base}`, `--outDir=${out}`], { cwd: join(root, "apps/ui"), stdio: "inherit", env: { ...process.env, UNICHAT_VERSION: process.env.UNICHAT_VERSION || "demo" } });

const dir = join(root, "apps/ui", out), index = join(dir, "index.html");
const html = readFileSync(index, "utf8").replace("</head>", `<script>
      /* Demo build: there is no backend here, so the app always runs on the mock data (apps/ui/src/mock.ts). */
      if (!new URLSearchParams(location.search).has("mock")) location.replace(location.pathname + "?mock" + location.hash);
    </script>
  </head>`);
writeFileSync(index, html);
copyFileSync(index, join(dir, "404.html")); // Pages serves 404.html for deep links; the app routes client-side
writeFileSync(join(dir, ".nojekyll"), "");  // keep Pages from dropping files that start with an underscore
console.log(`demo ready in apps/ui/${out} (base ${base})`);
