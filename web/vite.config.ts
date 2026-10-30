import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The shared validation parses CSV with csv-parse; its default build needs Node's Buffer
    alias: { "csv-parse/sync": "csv-parse/browser/esm/sync" },
  },
  server: { port: 5173, strictPort: true }, // the API's CORS allows http://localhost:5173
  // jszip is imported only when a ZIP is picked. Pre-bundle it at startup, or the dev server
  // finds it then, re-bundles its deps under a new hash and the open page's import 504s.
  optimizeDeps: { include: ["jszip"] },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    env: { VITE_API_MODE: "mock" },
  },
});
