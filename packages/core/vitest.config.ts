import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "core",
    include: ["test/**/*.test.ts"],
    // WASM parser init makes the first test slow; generous timeout.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      // Test against source, not dist — keeps the red-green loop build-free.
      "@archmap/schema": path.resolve(__dirname, "../schema/src/index.ts"),
    },
  },
});
