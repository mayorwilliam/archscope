import { createRequire } from "node:module";

/** Single source of truth: the published package's own version. */
export const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;
