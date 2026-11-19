// Runs Node code inside Electron's runtime (ELECTRON_RUN_AS_NODE): BoringSSL instead of OpenSSL -- the crypto the
// desktop app really has. Pairing on the desktop could not complete a single handshake for as long as nothing ran
// there: createCipheriv has no chacha20-poly1305 in Electron (see packages/core/src/chacha.ts), and every test ran on
// plain Node, where it does. Usage: node scripts/electron-node.mjs --test <files...>   (TypeScript via tsx)
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const electron = createRequire(new URL("../apps/desktop/package.json", import.meta.url))("electron"); // path of the binary
const tsx = createRequire(new URL("../packages/sync/package.json", import.meta.url)).resolve("tsx/esm");
const r = spawnSync(electron, ["--import", pathToFileURL(tsx).href, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
if (r.error) { console.error(r.error.message); process.exit(1); }
process.exit(r.status ?? 1);
