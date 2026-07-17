import { analyze, Store } from "@archscope/core";
import { VERSION } from "../version.js";

export async function runAnalyze(rootDir: string, options: { full?: boolean }): Promise<void> {
  const started = performance.now();

  const { graph, skipped, cache } = await analyze({
    rootDir,
    toolVersion: VERSION,
    cache: options.full ? { refresh: true } : true,
  });
  const store = new Store(rootDir);
  const outPath = store.saveGraph(graph);

  const elapsed = ((performance.now() - started) / 1000).toFixed(1);
  const c = graph.meta.counts;
  console.log(
    `Analyzed ${c.file ?? 0} files → ${c.module ?? 0} modules, ` +
      `${graph.edges.length} edges (${elapsed}s, ${cache.hits} cached / ${cache.misses} extracted)`,
  );
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} files with no extractor.`);
  }
  if (graph.meta.git) {
    const { branch, sha, dirty } = graph.meta.git;
    console.log(`Git: ${branch}@${sha.slice(0, 8)}${dirty ? " (dirty)" : ""}`);
    if (!dirty) {
      store.saveSnapshot(graph);
      console.log(`Snapshot saved for ${sha.slice(0, 8)}`);
    }
  }
  console.log(`Graph written to ${outPath}`);
}
