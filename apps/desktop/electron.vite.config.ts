import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// @signalapp/libsignal-client (incl. subpaths) locates its .node prebuild relative to its own package dir, so it cannot be bundled:
// it stays external and is shipped unpacked (see electron-builder.yml: asarUnpack).

export default defineConfig({
  main: {
    // Bundle everything (workspace packages are TS sources) except native add-ons.
    build: { outDir: "out/main", rollupOptions: { input: "src/main.ts", external: [/^@signalapp\/libsignal-client(\/|$)/] } },
  },
  // Sandboxed preloads must be CommonJS (ESM .mjs preloads are not supported with sandbox: true).
  preload: { build: { outDir: "out/preload", rollupOptions: { input: "src/preload.ts", output: { format: "cjs", entryFileNames: "preload.cjs" } } } },
  renderer: {
    root: "../ui",
    plugins: [react()],
    build: { outDir: "../desktop/out/renderer", emptyOutDir: true, rollupOptions: { input: "../ui/index.html" } },
  },
});
