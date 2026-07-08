import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "e2e",
    include: ["test/**/*.test.ts"],
    // Analyzing repos and building snapshots in git worktrees takes real time.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
