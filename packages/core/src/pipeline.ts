import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ArchGraph, ArchmapConfig } from "@archmap/schema";
import { Piscina } from "piscina";
import { loadConfig } from "./config-file.js";
import { gitInfo } from "./git.js";
import { buildGraph } from "./graph/build.js";
import { createModuleInferrer } from "./modules/infer.js";
import type { FileFacts } from "./parse/facts.js";
import { grammarForFile } from "./parse/parser.js";
import { extractPrismaFacts } from "./parse/prisma.js";
import { extractPyFacts } from "./parse/py.js";
import { extractTsFacts } from "./parse/ts.js";
import type { ExtractJob } from "./parse/worker.js";
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

  // Cache pass (sync, main thread): hits fill their slot immediately, misses
  // queue for extraction. Slots keep facts in scan order regardless of which
  // thread finishes when — determinism is positional, not temporal.
  const facts: (FileFacts | null)[] = [];
  const skipped: string[] = [];
  const pending: Array<{ index: number; job: ExtractJob; key: string | null }> = [];
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
    facts.push(null);
    pending.push({ index: facts.length - 1, job: { relPath, source }, key });
    stats.misses++;
  }

  const pool = pending.length >= EXTRACT_PARALLEL_THRESHOLD ? createExtractPool() : null;
  if (pool) {
    try {
      await Promise.all(
        pending.map(async ({ index, job, key }) => {
          const extracted = (await pool.run(job)) as FileFacts;
          if (cache && key) cache.put(key, extracted);
          facts[index] = extracted;
        }),
      );
    } finally {
      await pool.destroy();
    }
  } else {
    for (const { index, job, key } of pending) {
      const extracted = await extractInline(job);
      if (cache && key) cache.put(key, extracted);
      facts[index] = extracted;
    }
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
    facts: facts.filter((f): f is FileFacts => f !== null),
    resolver,
    inferModule,
    config,
    git,
    createdAt: options.createdAt ?? new Date().toISOString(),
  });

  return { graph, skipped, cache: stats };
}

// ---------------------------------------------------------------------------

/**
 * Below this many cache misses the sequential path wins: each piscina worker
 * pays its own tree-sitter WASM init, so small/warm runs skip the pool.
 */
const EXTRACT_PARALLEL_THRESHOLD = 200;

/**
 * The pool needs the COMPILED worker next to the compiled pipeline. Running
 * from TypeScript sources (vitest aliases) there is no dist worker — return
 * null and let the caller take the sequential path, same results, no magic.
 */
function createExtractPool(): Piscina | null {
  const worker = fileURLToPath(new URL("./parse/worker.js", import.meta.url));
  if (!fs.existsSync(worker)) return null;
  return new Piscina({
    filename: worker,
    maxThreads: Math.max(1, Math.min(8, os.availableParallelism() - 1)),
  });
}

async function extractInline({ relPath, source }: ExtractJob): Promise<FileFacts> {
  if (relPath.endsWith(".prisma")) return extractPrismaFacts(relPath, source);
  return grammarForFile(relPath) === "python"
    ? extractPyFacts(relPath, source)
    : extractTsFacts(relPath, source);
}
