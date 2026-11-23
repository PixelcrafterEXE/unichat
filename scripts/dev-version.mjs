#!/usr/bin/env node
// The version a LOCAL build gets: "0.1.<next>-dev.<stamp>", where <next> is the release this build would become.
// Release numbers belong to CI (release.yml: 0.1.${{ github.run_number }}); a build made on a developer's machine must
// never take one, or the installed app claims to be a release that was never published and the updater has nothing to
// match. The "-dev." pre-release part sorts it BELOW that release (semver), so the updater offers 0.1.<next> and anything
// newer to a local build, but never an older release. (It used to be "dev-0.1.<next>", which no updater could compare and
// electron-builder refused as a package version.)
//
//   node scripts/dev-version.mjs          -> 0.1.14-dev.202611231530
//   node scripts/dev-version.mjs --next   -> 0.1.14   (what the next release will be called)
import { execFileSync } from "node:child_process";

const tags = (() => {
  try { return execFileSync("git", ["tag", "--list", "v*", "--sort=-v:refname"], { encoding: "utf8" }).split("\n").filter(Boolean); }
  catch { return []; }
})();
const latest = tags.map((t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t.trim())).find(Boolean);
const next = latest ? `${latest[1]}.${latest[2]}.${Number(latest[3]) + 1}` : "0.1.0";
const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}`;
process.stdout.write((process.argv.includes("--next") ? next : `${next}-dev.${stamp}`) + "\n");
