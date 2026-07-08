import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "db",
    include: ["test/**/*.test.ts"],
    // WASM parser init (sqlalchemy tests) and testcontainers need headroom.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      // Test against source, not dist — keeps the red-green loop build-free.
      "@archmap/schema": path.resolve(__dirname, "../schema/src/index.ts"),
    },
  },
});
