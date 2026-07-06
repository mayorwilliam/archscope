import fs from "node:fs";
import path from "node:path";
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
}
