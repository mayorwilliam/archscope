import type { ArchGraph } from "@archmap/schema";
import { parseArchGraph } from "@archmap/schema";

/** Minimal valid graph with one declared table, for merge-level tests. */
export function baseGraphWithUsers(): ArchGraph {
  return parseArchGraph({
    schemaVersion: 1,
    meta: {
      tool: "archmap",
      toolVersion: "test",
      createdAt: "1970-01-01T00:00:00.000Z",
      root: "<test>",
      git: null,
      counts: { module: 0, file: 0, symbol: 0, entity: 0, table: 1, extpkg: 0 },
    },
    nodes: [
      {
        id: "tbl:public.users",
        kind: "table",
        name: "users",
        attrs: {
          kind: "table",
          origin: "declared",
          columns: [
            { name: "id", sqlType: "Int", nullable: false, isPk: true },
            { name: "email", sqlType: "String", nullable: false, isPk: false },
          ],
        },
        metrics: { fanIn: 0, fanOut: 0, rank: 0 },
      },
    ],
    edges: [],
  });
}
