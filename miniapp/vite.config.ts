import { resolve } from "node:path";
import { defineConfig } from "vite";

const input =
  process.env.VERIFY_READER === "1"
    ? {
        app: resolve(__dirname, "index.html"),
        harness: resolve(__dirname, "harness.html"),
      }
    : {
        app: resolve(__dirname, "index.html"),
      };

export default defineConfig({
  build: {
    rollupOptions: { input },
  },
});
