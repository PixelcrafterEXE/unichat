import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// @signalapp/libsignal-client (incl. subpaths) locates its .node prebuild relative to its own package dir, so it cannot be bundled:
// it stays external and is shipped unpacked (see electron-builder.yml: asarUnpack). hyperdht ("Reach my devices from anywhere")
// is the same case through udx-native / sodium-native: bundling its JS left the add-ons behind, so the packaged app reported
// "not available on this platform" and devices on networks that cannot reach each other had no way to pair at all.

export default defineConfig({
  main: {
    // Bundle everything (workspace packages are TS sources) except native add-ons.
    build: { outDir: "out/main", rollupOptions: { input: "src/main.ts", external: [/^@signalapp\/libsignal-client(\/|$)/, /^hyperdht(\/|$)/, /^(udx|sodium)-native(\/|$)/] } },
  },
  // Sandboxed preloads must be CommonJS (ESM .mjs preloads are not supported with sandbox: true).
  preload: { build: { outDir: "out/preload", rollupOptions: { input: "src/preload.ts", output: { format: "cjs", entryFileNames: "preload.cjs" } } } },
  renderer: {
    root: "../ui",
    plugins: [react()],
    // The UI reads __UNICHAT_VERSION__ (apps/ui/vite.config.ts defines it for the web build). Without it here the packaged
    // desktop app called itself "dev" and refused to self-update, however it was released (issue #90).
    define: { __UNICHAT_VERSION__: JSON.stringify(process.env.UNICHAT_VERSION || "dev") },
    build: { outDir: "../desktop/out/renderer", emptyOutDir: true, rollupOptions: { input: "../ui/index.html" } },
  },
});
