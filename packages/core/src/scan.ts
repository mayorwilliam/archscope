import fs from "node:fs";
import path from "node:path";
import type { ArchscopeConfig } from "@archscope/schema";
import { normalizePath } from "@archscope/schema";
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
  ".prisma",
]);

const ALWAYS_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".archscope",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);

export function scanSourceFiles(rootDir: string, config: ArchscopeConfig): string[] {
  return scanFiles(rootDir, config, (name) =>
    SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase()),
  );
}

/**
 * Markdown docs for the wiki. Deliberately curated — "every .md in the repo"
 * would drown the wiki in a docs-site repo: any README.md, anything under
 * docs/, and root-level pages (CONTRIBUTING.md, ARCHITECTURE.md, ...).
 * `config.docs.include` replaces these defaults; `docs.exclude` filters more.
 */
export function scanDocFiles(rootDir: string, config: ArchscopeConfig): string[] {
  const isIncluded =
    config.docs?.include && config.docs.include.length > 0
      ? picomatch(config.docs.include, { dot: true })
      : (rel: string) => {
          if (!rel.toLowerCase().endsWith(".md")) return false;
          const base = rel.split("/").pop() ?? rel;
          if (base.toLowerCase() === "readme.md") return true;
          if (rel.startsWith("docs/")) return true;
          return !rel.includes("/"); // root-level *.md
        };
  const isDocExcluded =
    config.docs?.exclude && config.docs.exclude.length > 0
      ? picomatch(config.docs.exclude, { dot: true })
      : () => false;
  return scanFiles(
    rootDir,
    config,
    (name) => name.toLowerCase().endsWith(".md"),
    (rel) => isIncluded(rel) && !isDocExcluded(rel),
  );
}

function scanFiles(
  rootDir: string,
  config: ArchscopeConfig,
  matchesName: (fileName: string) => boolean,
  matchesPath: (relPath: string) => boolean = () => true,
): string[] {
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
        if (!matchesName(entry.name)) continue;
        const normalized = normalizePath(rel);
        if (ig.ignores(normalized) || isExcluded(normalized) || !matchesPath(normalized)) continue;
        results.push(normalized);
      }
    }
  }
}
