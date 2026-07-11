import { defineConfig } from "tsup";

/**
 * The published `archmap` package is ONE bundle: every @archmap/* workspace
 * package is inlined (they live in devDependencies and never reach npm),
 * while third-party runtime deps stay external as real dependencies.
 *
 * Two entries, not one: the piscina pool loads dist/parse/worker.js by path
 * at runtime (see core's createExtractPool), so the worker must exist as its
 * own file next to the bundle. Both entries bundle from the BUILT core dist —
 * pnpm builds workspace deps first, topologically.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "parse/worker": "../core/dist/parse/worker.js",
  },
  format: "esm",
  platform: "node",
  target: "node20",
  splitting: false,
  clean: true,
  dts: false,
  sourcemap: false,
  noExternal: [/^@archmap\//],
  onSuccess: "node scripts/copy-dashboard.mjs",
});
