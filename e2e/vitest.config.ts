import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "e2e",
    include: ["test/**/*.test.ts"],
    // Analyzing repos and building snapshots in git worktrees takes real time.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
  resolve: {
    alias: {
      // El harness importa utilidades de core/schema en el proceso de vitest;
      // el sistema bajo test sigue siendo el CLI compilado spawneado aparte.
      // Alias a src como en packages/core: evita resolver los entries dist de
      // los links workspace, que en Windows rompen resolvePackageEntry de vite.
      "@archscope/core": path.resolve(__dirname, "../packages/core/src/index.ts"),
      "@archscope/schema": path.resolve(__dirname, "../packages/schema/src/index.ts"),
      "@archscope/db": path.resolve(__dirname, "../packages/db/src/index.ts"),
    },
  },
});
