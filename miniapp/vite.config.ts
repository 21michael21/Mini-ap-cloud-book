import { resolve } from "node:path";
import { defineConfig } from "vite";

const includeReaderHarness = process.env.VERIFY_READER === "1";
const includeFoliateViewHarness = process.env.VERIFY_FOLIATE_VIEW === "1";
const input =
  includeReaderHarness || includeFoliateViewHarness
    ? {
        app: resolve(__dirname, "index.html"),
        ...(includeReaderHarness ? { harness: resolve(__dirname, "harness.html") } : {}),
        ...(includeFoliateViewHarness ? { foliateViewHarness: resolve(__dirname, "foliate-view-harness.html") } : {}),
      }
    : {
        app: resolve(__dirname, "index.html"),
      };

export default defineConfig({
  build: {
    rollupOptions: { input },
  },
});
