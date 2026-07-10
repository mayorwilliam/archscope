import { defineConfig } from "@playwright/test";

/**
 * Dashboard smoke suite: one fixture repo, one `archmap serve`, tests run
 * serially against it (the live-update test mutates the repo on purpose).
 */
export default defineConfig({
  testDir: "./dashboard",
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    viewport: { width: 1440, height: 900 },
  },
});
