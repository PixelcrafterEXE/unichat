// Imported FIRST by the backend entry. nodejs-mobile's os.tmpdir() answers "/tmp", which does not exist on Android, and it ignores TMPDIR.
// Baileys (WhatsApp) writes every outgoing media file there while encrypting it ("ENOENT /tmp/image...-enc", then "Media upload failed on all
// hosts"), so the temp directory is moved into the app's own data directory, for os.tmpdir() callers and TMPDIR readers alike.
import os from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const dataDir = process.argv[2] || process.env.UNIMSG_DATA || "";
if (dataDir) {
  const t = join(dataDir, "tmp");
  try { mkdirSync(t, { recursive: true }); } catch { /* reported by the first write */ }
  process.env.TMPDIR = t;
  (os as any).tmpdir = () => t;
  syncBuiltinESMExports();
}
