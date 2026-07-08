import fs from "node:fs";
import { type GraphIndex, gitInfo, indexGraph, type StalenessInfo, Store } from "@archmap/core";

/**
 * Serves the current graph to tool handlers. The index is rebuilt only when
 * graph.json's mtime moves — which is exactly how `archmap watch` publishes
 * updates, so a long-lived MCP server and watch mode compose for free.
 * Staleness (current HEAD vs. the analyzed sha) is re-checked on every call:
 * it is the one fact that must never be cached.
 */

export class NoGraphError extends Error {
  constructor(rootDir: string) {
    super(
      `No architecture graph found in ${rootDir}/.archmap/graph.json — ` +
        `run \`archmap analyze\` there first.`,
    );
    this.name = "NoGraphError";
  }
}

export interface LoadedGraph {
  index: GraphIndex;
  staleness: StalenessInfo;
}

export class GraphSource {
  readonly rootDir: string;
  private readonly store: Store;
  private cached: { mtimeMs: number; index: GraphIndex } | null = null;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    this.store = new Store(rootDir);
  }

  async load(): Promise<LoadedGraph> {
    const stat = fs.statSync(this.store.graphPath, { throwIfNoEntry: false });
    if (!stat) throw new NoGraphError(this.rootDir);
    if (!this.cached || this.cached.mtimeMs !== stat.mtimeMs) {
      const graph = this.store.loadGraph();
      if (!graph) throw new NoGraphError(this.rootDir);
      this.cached = { mtimeMs: stat.mtimeMs, index: indexGraph(graph) };
    }

    const current = await gitInfo(this.rootDir);
    const meta = this.cached.index.graph.meta;
    return {
      index: this.cached.index,
      staleness: {
        builtSha: meta.git?.sha ?? null,
        branch: meta.git?.branch ?? null,
        builtDirty: meta.git?.dirty ?? false,
        createdAt: meta.createdAt,
        currentSha: current?.sha ?? null,
      },
    };
  }
}
