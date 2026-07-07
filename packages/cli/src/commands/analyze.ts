import { analyze, Store } from "@archmap/core";

export async function runAnalyze(rootDir: string, options: { full?: boolean }): Promise<void> {
  const started = performance.now();
  // --full is accepted from day one for CLI stability; it becomes meaningful
  // when the incremental cache lands in Phase 2.
  void options.full;

  const { graph, skipped } = await analyze({ rootDir });
  const store = new Store(rootDir);
  const outPath = store.saveGraph(graph);

  const elapsed = ((performance.now() - started) / 1000).toFixed(1);
  const c = graph.meta.counts;
  console.log(
    `Analyzed ${c.file ?? 0} files → ${c.module ?? 0} modules, ` +
      `${graph.edges.length} edges (${elapsed}s)`,
  );
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} files with no extractor.`);
  }
  if (graph.meta.git) {
    const { branch, sha, dirty } = graph.meta.git;
    console.log(`Git: ${branch}@${sha.slice(0, 8)}${dirty ? " (dirty)" : ""}`);
  }
  console.log(`Graph written to ${outPath}`);
}
