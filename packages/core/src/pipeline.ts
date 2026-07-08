import fs from "node:fs";
import path from "node:path";
import type { ArchGraph, ArchmapConfig } from "@archmap/schema";
import { loadConfig } from "./config-file.js";
import { gitInfo } from "./git.js";
import { buildGraph } from "./graph/build.js";
import { createModuleInferrer } from "./modules/infer.js";
import type { FileFacts } from "./parse/facts.js";
import { grammarForFile } from "./parse/parser.js";
import { extractPrismaFacts } from "./parse/prisma.js";
import { extractPyFacts } from "./parse/py.js";
import { extractTsFacts } from "./parse/ts.js";
import { PyResolver } from "./resolve/py-resolver.js";
import { CombinedResolver } from "./resolve/resolver.js";
import { TsResolver } from "./resolve/ts-resolver.js";
import { discoverWorkspacePackages } from "./resolve/workspace.js";
import { scanSourceFiles } from "./scan.js";
import { type CacheStats, FactsCache, factsKey } from "./store/cache.js";

/**
 * The pipeline: scan → parse → resolve → infer → build.
 * Each stage is a pure function over explicit inputs; this file only wires
 * them together. Determinism is the contract — same repo state, same graph.
 */

export interface AnalyzeOptions {
  rootDir: string;
  config?: ArchmapConfig;
  toolVersion?: string;
  /** Injectable for tests; defaults to now. */
  createdAt?: string;
  /**
   * Incremental extraction cache. Defaults to `<rootDir>/.archmap/cache`.
   * `false` disables it; `dir` redirects it (a worktree analysis pointing at
   * the main repo's cache is what makes cross-ref snapshots cheap); `refresh`
   * ignores existing entries but still rewrites them (CLI --full).
   */
  cache?: boolean | { dir?: string; refresh?: boolean };
  /**
   * Name for the root fallback module. Defaults to the analyzed directory's
   * basename; snapshot analyses in temp worktrees pass the real repo name so
   * module identity is stable across snapshots.
   */
  rootName?: string;
}

export interface AnalyzeResult {
  graph: ArchGraph;
  /** Files skipped because no extractor handles them. */
  skipped: string[];
  cache: CacheStats;
}

export async function analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
  // realpath, not just resolve: enhanced-resolve returns symlink-free paths,
  // and a symlinked root (macOS /var/folders, /tmp) would make every resolved
  // file look like it lives outside the repo.
  const rootDir = fs.realpathSync(path.resolve(options.rootDir));
  const config = options.config ?? loadConfig(rootDir);

  const files = scanSourceFiles(rootDir, config);
  const workspacePackages = discoverWorkspacePackages(rootDir);

  const cacheOpt = options.cache ?? true;
  const cache =
    cacheOpt === false
      ? null
      : new FactsCache(
          (typeof cacheOpt === "object" ? cacheOpt.dir : undefined) ??
            path.join(rootDir, ".archmap", "cache"),
        );
  const refresh = typeof cacheOpt === "object" && cacheOpt.refresh === true;
  const stats: CacheStats = { hits: 0, misses: 0 };

  const facts: FileFacts[] = [];
  const skipped: string[] = [];
  for (const relPath of files) {
    const grammar = grammarForFile(relPath);
    const isPrisma = relPath.endsWith(".prisma");
    if (grammar === null && !isPrisma) {
      skipped.push(relPath);
      continue;
    }
    const source = fs.readFileSync(path.join(rootDir, relPath), "utf8");
    const key = cache ? factsKey(relPath, source) : null;
    if (cache && key && !refresh) {
      const cached = cache.get(key);
      if (cached) {
        facts.push(cached);
        stats.hits++;
        continue;
      }
    }
    const extracted = isPrisma
      ? extractPrismaFacts(relPath, source)
      : grammar === "python"
        ? await extractPyFacts(relPath, source)
        : await extractTsFacts(relPath, source);
    if (cache && key) cache.put(key, extracted);
    facts.push(extracted);
    stats.misses++;
  }

  const resolver = new CombinedResolver(
    new TsResolver(rootDir, workspacePackages),
    new PyResolver(rootDir, config),
  );
  const inferModule = createModuleInferrer(rootDir, config, workspacePackages, options.rootName);
  const git = await gitInfo(rootDir);

  const graph = buildGraph({
    rootDir,
    toolVersion: options.toolVersion ?? "0.0.1",
    facts,
    resolver,
    inferModule,
    config,
    git,
    createdAt: options.createdAt ?? new Date().toISOString(),
  });

  return { graph, skipped, cache: stats };
}
