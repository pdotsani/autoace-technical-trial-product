import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The shared validation parses CSV with csv-parse; its default build needs Node's Buffer
    alias: { "csv-parse/sync": "csv-parse/browser/esm/sync" },
  },
  server: { port: 5173, strictPort: true }, // the API's CORS allows http://localhost:5173
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    env: { VITE_API_MODE: "mock" },
  },
});
