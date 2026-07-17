import type { ArchGraph, GraphEdge, GraphNode, NodeKind, TableColumn } from "@archscope/schema";
import { edgeId, tableId } from "@archscope/schema";
import { DEFAULT_DB_SCHEMA, tableKey } from "./declared.js";
import { computeDrift, type DeclaredTableInput, type DriftReport } from "./drift.js";
import type { LiveFk, LiveSchema, LiveTable } from "./introspect.js";

/**
 * Merge a live introspection into an existing graph — the explicit overlay
 * behind `archscope db introspect`. Declared table nodes keep their DECLARED
 * columns (code truth stays intact; drift entries carry the discrepancies),
 * live-only tables enter with live columns, live-only FKs enter as edges
 * with source "live". The merge is idempotent: every run first strips the
 * previous overlay and recomputes it from scratch, and a later `analyze`
 * regenerates the graph without it entirely.
 */

export interface MergeOptions {
  /** Config source name (db.live[].name) — NEVER the connection URL. */
  source: string;
  dialect: "postgres" | "mysql";
  introspectedAt: string;
}

export interface MergeResult {
  graph: ArchGraph;
  drift: DriftReport;
}

export function mergeLiveSchema(
  graph: ArchGraph,
  live: LiveSchema,
  options: MergeOptions,
): MergeResult {
  // Strip any previous overlay: live-only tables, live edges, old drift.
  const nodes = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (node.kind === "table" && node.attrs.kind === "table") {
      if (node.attrs.origin === "live") continue;
      const { drift: _previous, ...attrs } = node.attrs;
      nodes.set(node.id, { ...node, attrs: { ...attrs, origin: "declared" } });
    } else {
      nodes.set(node.id, node);
    }
  }
  const edges = new Map<string, GraphEdge>();
  for (const edge of graph.edges) {
    if (edge.source === "live") continue;
    edges.set(edge.id, edge);
  }

  const declared: DeclaredTableInput[] = [];
  for (const node of nodes.values()) {
    if (node.kind !== "table" || node.attrs.kind !== "table") continue;
    const { schema, name } = splitTableId(node.id, node.name);
    declared.push({ schema, name, columns: node.attrs.columns });
  }
  const drift = computeDrift(declared, live);

  // Same default-namespace mapping as computeDrift: a declared tbl:public.*
  // matches the live table in the connection's default schema (the database,
  // on MySQL). Node IDs keep their declared identity — only matching maps.
  const defaultSchema = live.defaultSchema ?? DEFAULT_DB_SCHEMA;
  const mapSchema = (schema: string) => (schema === DEFAULT_DB_SCHEMA ? defaultSchema : schema);
  const declaredSchemas = new Set(declared.map((t) => mapSchema(t.schema)));

  // live key (`schema.table`, live-real) → graph node id.
  const nodeIdByLiveKey = new Map<string, string>();

  // Declared tables: attach drift, upgrade origin when the live side exists.
  const liveByKey = new Map(live.tables.map((t) => [tableKey(t.schema, t.name), t]));
  for (const node of nodes.values()) {
    if (node.kind !== "table" || node.attrs.kind !== "table") continue;
    const { schema, name } = splitTableId(node.id, node.name);
    const key = tableKey(mapSchema(schema), name);
    nodeIdByLiveKey.set(key, node.id);
    const entries = drift.byTable.get(key) ?? [];
    node.attrs = {
      ...node.attrs,
      origin: liveByKey.has(key) ? "both" : "declared",
      ...(entries.length > 0 ? { drift: entries } : {}),
    };
  }

  // Live-only tables (inside declared schemas): new nodes with live columns.
  for (const table of live.tables) {
    const key = tableKey(table.schema, table.name);
    if (nodeIdByLiveKey.has(key) || !declaredSchemas.has(table.schema)) continue;
    const id = tableId(table.schema, table.name);
    const entries = drift.byTable.get(key) ?? [];
    nodeIdByLiveKey.set(key, id);
    nodes.set(id, {
      id,
      kind: "table",
      name: table.name,
      attrs: {
        kind: "table",
        origin: "live",
        columns: liveColumns(table),
        ...(entries.length > 0 ? { drift: entries } : {}),
      },
      metrics: { fanIn: 0, fanOut: 0, rank: 0 },
    });
  }

  // Live FKs between tables present in the graph; static edges win on id.
  for (const table of live.tables) {
    const fromId = nodeIdByLiveKey.get(tableKey(table.schema, table.name));
    if (fromId === undefined) continue;
    for (const fk of table.fks) {
      const toId = nodeIdByLiveKey.get(tableKey(fk.toSchema, fk.toTable));
      if (toId === undefined) continue;
      const id = edgeId("fk", fromId, toId);
      if (edges.has(id)) continue;
      edges.set(id, {
        id,
        kind: "fk",
        from: fromId,
        to: toId,
        attrs: { columns: fkPairs(fk) },
        source: "live",
        confidence: "certain",
      });
    }
  }

  const sortedNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const sortedEdges = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  const counts: Record<string, number> = {};
  for (const kind of ["module", "file", "symbol", "entity", "table", "extpkg"] as NodeKind[]) {
    counts[kind] = sortedNodes.filter((n) => n.kind === kind).length;
  }

  return {
    graph: {
      ...graph,
      meta: {
        ...graph.meta,
        counts,
        live: {
          source: options.source,
          dialect: options.dialect,
          introspectedAt: options.introspectedAt,
        },
      },
      nodes: sortedNodes,
      edges: sortedEdges,
    },
    drift,
  };
}

// ---------------------------------------------------------------------------

/** `tbl:public.users` → schema/table; falls back to splitting on node name. */
function splitTableId(id: string, name: string): { schema: string; name: string } {
  const rest = id.startsWith("tbl:") ? id.slice(4) : id;
  const dot = rest.indexOf(".");
  if (dot === -1) return { schema: "public", name };
  return { schema: rest.slice(0, dot), name: rest.slice(dot + 1) };
}

function liveColumns(table: LiveTable): TableColumn[] {
  const fkByColumn = new Map<string, { table: string; column: string }>();
  for (const fk of table.fks) {
    fk.fromColumns.forEach((from, i) => {
      if (!fkByColumn.has(from)) {
        fkByColumn.set(from, {
          table: tableKey(fk.toSchema, fk.toTable),
          column: fk.toColumns[i] ?? "",
        });
      }
    });
  }
  return table.columns
    .map((c) => ({
      name: c.name,
      sqlType: c.sqlType,
      nullable: c.nullable,
      isPk: c.isPk,
      ...(fkByColumn.has(c.name) ? { fkTo: fkByColumn.get(c.name) } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function fkPairs(fk: LiveFk): Array<[string, string]> {
  return fk.fromColumns
    .map((from, i) => [from, fk.toColumns[i] ?? ""] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]));
}
