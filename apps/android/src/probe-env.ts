// Imported FIRST by the probe entries: nodejs-mobile's os.tmpdir() resolved to /tmp (not writable on Android) in the signal tests, so point TMPDIR at the app's own data dir.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const base = process.env.UNIMSG_DATA || process.cwd();
const t = join(base, "probe-tmp");
mkdirSync(t, { recursive: true });
console.log(`PROBE-ENV TMPDIR was ${process.env.TMPDIR ?? "(unset)"} -> ${t}`);
process.env.TMPDIR = t;
// nodejs-mobile's os.tmpdir() ignores TMPDIR (returns /tmp, EACCES): replace it, including the ESM named export
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
(os as any).tmpdir = () => t;
syncBuiltinESMExports();
