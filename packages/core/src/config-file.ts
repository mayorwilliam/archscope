import fs from "node:fs";
import path from "node:path";
import type { ArchmapConfig } from "@archmap/schema";
import { parseArchmapConfig } from "@archmap/schema";
import YAML from "yaml";

export const CONFIG_FILENAME = ".archmap.yaml";

/** Missing config is not an error: heuristics carry a config-less repo. */
export function loadConfig(rootDir: string): ArchmapConfig {
  const file = path.join(rootDir, CONFIG_FILENAME);
  if (!fs.existsSync(file)) return parseArchmapConfig({});
  const raw = YAML.parse(fs.readFileSync(file, "utf8"));
  return parseArchmapConfig(raw);
}
