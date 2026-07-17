import fs from "node:fs";
import path from "node:path";
import type { ArchscopeConfig } from "@archscope/schema";
import { parseArchscopeConfig } from "@archscope/schema";
import YAML from "yaml";

export const CONFIG_FILENAME = ".archscope.yaml";

/** Missing config is not an error: heuristics carry a config-less repo. */
export function loadConfig(rootDir: string): ArchscopeConfig {
  const file = path.join(rootDir, CONFIG_FILENAME);
  if (!fs.existsSync(file)) return parseArchscopeConfig({});
  const raw = YAML.parse(fs.readFileSync(file, "utf8"));
  return parseArchscopeConfig(raw);
}
