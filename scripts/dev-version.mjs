#!/usr/bin/env node
// The version a LOCAL build gets: "dev-0.1.<next>", where <next> is the release this build would become.
// Release numbers belong to CI (release.yml: 0.1.${{ github.run_number }}); a build made on a developer's machine must
// never take one, or the installed app claims to be a release that was never published and the updater has nothing to
// match. The "dev-" prefix also makes apps/desktop/src/updater.ts report "dev", so such a build never offers updates.
//
//   node scripts/dev-version.mjs          -> dev-0.1.14
//   node scripts/dev-version.mjs --next   -> 0.1.14   (what the next release will be called)
import { execFileSync } from "node:child_process";

const tags = (() => {
  try { return execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], { encoding: "utf8" }).split("\n").filter(Boolean); }
  catch { return []; }
})();
const latest = tags.map((t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t.trim())).find(Boolean);
const next = latest ? `${latest[1]}.${latest[2]}.${Number(latest[3]) + 1}` : "0.1.0";
process.stdout.write((process.argv.includes("--next") ? next : "dev-" + next) + "\n");
