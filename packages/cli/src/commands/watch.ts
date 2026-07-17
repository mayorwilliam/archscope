import path from "node:path";
import { analyze, Store } from "@archscope/core";
import chokidar from "chokidar";

/**
 * Watch mode: re-run the pipeline on changes, debounced. The facts cache
 * makes each rebuild pay only for the files that actually changed — the
 * per-run log shows exactly that (extracted vs cached).
 */

const DEBOUNCE_MS = 300;

const IGNORED_DIRS = new Set([
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

const WATCHED_EXTENSIONS = new Set([
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

const WATCHED_FILENAMES = new Set([
  ".archscope.yaml",
  "package.json",
  "tsconfig.json",
  "pnpm-workspace.yaml",
  "lerna.json",
  "pyproject.toml",
]);

export async function runWatch(rootDir: string): Promise<void> {
  await startWatch(rootDir);
}

/**
 * Shared by `watch` and `serve`: initial analyze + chokidar re-analysis on
 * changes. Publishing means writing graph.json — consumers (MCP's GraphSource,
 * serve's REST + SSE) pick that up by mtime, so there is no callback plumbing.
 */
export async function startWatch(rootDir: string): Promise<void> {
  const store = new Store(rootDir);

  let pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function rebuild(): Promise<void> {
    const triggers = [...pending];
    pending = new Set();
    const started = performance.now();
    const { graph, cache } = await analyze({ rootDir });
    store.saveGraph(graph);
    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    const trigger =
      triggers.length === 0
        ? "initial"
        : triggers.length === 1
          ? triggers[0]
          : `${triggers[0]} +${triggers.length - 1} more`;
    log(`${cache.misses} extracted / ${cache.hits} cached (${elapsed}s) — ${trigger}`);
  }

  async function flush(): Promise<void> {
    if (running) {
      timer = setTimeout(flush, DEBOUNCE_MS);
      return;
    }
    running = true;
    try {
      await rebuild();
    } catch (error) {
      log(`analysis failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      running = false;
      if (pending.size > 0) timer = setTimeout(flush, DEBOUNCE_MS);
    }
  }

  function schedule(trigger: string): void {
    pending.add(trigger);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  }

  await rebuild();
  log(`watching ${rootDir} (debounce ${DEBOUNCE_MS}ms, Ctrl-C to stop)`);

  chokidar
    .watch(rootDir, {
      ignoreInitial: true,
      ignored: (absPath) => isIgnored(rootDir, absPath),
    })
    .on("all", (_event, absPath) => {
      if (!isRelevantFile(absPath)) return;
      schedule(path.relative(rootDir, absPath));
    });

  // Branch switches rewrite .git/HEAD without touching source files.
  chokidar
    .watch(path.join(rootDir, ".git", "HEAD"), { ignoreInitial: true })
    .on("all", () => schedule("git HEAD (branch switch)"));
}

// ---------------------------------------------------------------------------

function isIgnored(rootDir: string, absPath: string): boolean {
  const rel = path.relative(rootDir, absPath);
  if (rel === "" || rel === ".") return false;
  const segments = rel.split(path.sep);
  return segments.some((segment, i) => {
    if (IGNORED_DIRS.has(segment)) return true;
    const isWatchedDotfile = i === segments.length - 1 && WATCHED_FILENAMES.has(segment);
    return segment.startsWith(".") && !isWatchedDotfile;
  });
}

function isRelevantFile(absPath: string): boolean {
  const base = path.basename(absPath);
  return WATCHED_FILENAMES.has(base) || WATCHED_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function log(message: string): void {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[watch ${time}] ${message}`);
}
