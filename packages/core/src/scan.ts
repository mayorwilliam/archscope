import fs from "node:fs";
import path from "node:path";
import type { ArchmapConfig } from "@archmap/schema";
import { normalizePath } from "@archmap/schema";
import ignore from "ignore";
import picomatch from "picomatch";

/**
 * Source file discovery: respects .gitignore, built-in ignores, and
 * config `exclude` globs. Returns repo-relative posix paths, sorted —
 * deterministic input order keeps everything downstream deterministic.
 */

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
]);

const ALWAYS_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".archmap",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);

export function scanSourceFiles(rootDir: string, config: ArchmapConfig): string[] {
  const ig = ignore();
  const gitignorePath = path.join(rootDir, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, "utf8"));
  }
  const isExcluded =
    config.exclude && config.exclude.length > 0
      ? picomatch(config.exclude, { dot: true })
      : () => false;

  const results: string[] = [];
  walk(rootDir, "");
  return results.sort();

  function walk(absDir: string, relDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (ALWAYS_IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (ig.ignores(`${rel}/`)) continue;
        walk(path.join(absDir, entry.name), rel);
      } else if (entry.isFile()) {
        if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const normalized = normalizePath(rel);
        if (ig.ignores(normalized) || isExcluded(normalized)) continue;
        results.push(normalized);
      }
    }
  }
}
