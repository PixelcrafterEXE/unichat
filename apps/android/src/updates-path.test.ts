// The native side has to name the folder the backend downloads updates into (twice: the guard in NodeBridge and the
// FileProvider root). Both copies once said "unimsg-data/updates" while the Hub really writes one level deeper, so
// "Restart to update" refused every download and opened no installer (issue #91). This pins all four places together.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

/** <UNIMSG_DATA> is <filesDir>/unimsg-data (NodeRuntime), the Hub nests "accounts", the updater adds "updates". */
const EXPECTED = "unimsg-data/accounts/updates";

test("the backend still writes updates where the native side looks", () => {
  assert.match(read("packages/host/src/index.ts"), /new Hub\(join\(dataDir, "accounts"\)/, "the Hub's data dir moved: UPDATES_DIR and file_paths.xml have to follow");
  assert.match(read("packages/core/src/updater.ts"), /this\.dir = join\(o\.dataDir, "updates"\)/, "the updater's download folder moved: UPDATES_DIR and file_paths.xml have to follow");
  assert.match(read("apps/android/android/app/src/main/java/app/unimsg/android/node/NodeRuntime.java"), /new File\(files, "unimsg-data"\)/, "UNIMSG_DATA moved");
});

test("NodeBridge and the FileProvider root agree on it", () => {
  const java = read("apps/android/android/app/src/main/java/app/unimsg/android/node/NodeBridge.java");
  assert.equal(java.match(/UPDATES_DIR = "([^"]+)"/)?.[1], EXPECTED);
  assert.equal(read("apps/android/android/app/src/main/res/xml/file_paths.xml").match(/name="unimsg_updates" path="([^"]+)"/)?.[1], EXPECTED + "/");
  // the guard must stay a prefix test against that folder, not a "contains"
  assert.match(java, /startsWith\(dir\.getPath\(\) \+ java\.io\.File\.separator\)/);
});
