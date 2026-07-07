import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { ArchGraph } from "@archmap/schema";
import { parseArchGraph } from "@archmap/schema";

/**
 * All `.archmap/` disk I/O goes through this class — it is the interface
 * boundary that lets very large repos swap JSON for SQLite later without
 * touching any consumer.
 */

export class Store {
  readonly dir: string;

  constructor(rootDir: string) {
    this.dir = path.join(rootDir, ".archmap");
  }

  get graphPath(): string {
    return path.join(this.dir, "graph.json");
  }

  get cacheDir(): string {
    return path.join(this.dir, "cache");
  }

  get snapshotsDir(): string {
    return path.join(this.dir, "snapshots");
  }

  saveGraph(graph: ArchGraph): string {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.graphPath, JSON.stringify(graph, null, 2));
    return this.graphPath;
  }

  /** Returns null when no graph exists. Throws on schema mismatch — loudly. */
  loadGraph(): ArchGraph | null {
    if (!fs.existsSync(this.graphPath)) return null;
    const raw = JSON.parse(fs.readFileSync(this.graphPath, "utf8"));
    return parseArchGraph(raw);
  }

  // --- snapshots: one immutable graph per commit sha ------------------------

  snapshotPath(sha: string): string {
    return path.join(this.snapshotsDir, `${sha}.json.gz`);
  }

  hasSnapshot(sha: string): boolean {
    return fs.existsSync(this.snapshotPath(sha));
  }

  /** The snapshot's identity is the commit it was built from. */
  saveSnapshot(graph: ArchGraph): string {
    const sha = graph.meta.git?.sha;
    if (!sha) throw new Error("Cannot snapshot a graph without git metadata.");
    if (graph.meta.git?.dirty) throw new Error("Refusing to snapshot a dirty working tree.");
    fs.mkdirSync(this.snapshotsDir, { recursive: true });
    const file = this.snapshotPath(sha);
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(graph)));
    return file;
  }

  loadSnapshot(sha: string): ArchGraph | null {
    const file = this.snapshotPath(sha);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
    return parseArchGraph(raw);
  }

  listSnapshots(): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.snapshotsDir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.endsWith(".json.gz"))
      .map((name) => name.slice(0, -".json.gz".length))
      .sort();
  }
}
