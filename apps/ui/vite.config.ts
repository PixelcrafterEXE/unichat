import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// UNICHAT_VERSION (0.1.<run number>) is set by CI; local builds show "dev".
export default defineConfig({ plugins: [react()], define: { __UNICHAT_VERSION__: JSON.stringify(process.env.UNICHAT_VERSION || "dev") } });
