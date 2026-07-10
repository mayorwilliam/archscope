import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "dashboard",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      // Test against source, not dist — keeps the red-green loop build-free.
      "@archmap/schema": path.resolve(__dirname, "../schema/src/index.ts"),
    },
  },
});
