import { z } from "zod";

/**
 * The graph is the product: a single deterministic artifact that every
 * consumer (dashboard, MCP, diff, drift) treats as read-only truth.
 *
 * Zod-first: files on disk are validated on every read, so a corrupt or
 * stale-schema graph fails loudly instead of producing silent nonsense.
 */

export const NODE_KINDS = ["module", "file", "symbol", "entity", "table", "extpkg"] as const;
export const NodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof NodeKindSchema>;

export const LangSchema = z.enum(["ts", "js", "py", "prisma"]);
export type Lang = z.infer<typeof LangSchema>;

// ---------------------------------------------------------------------------
// Kind-specific attrs
// ---------------------------------------------------------------------------

export const ModuleAttrsSchema = z.object({
  kind: z.literal("module"),
  layer: z.string().optional(),
  source: z.enum(["inferred", "config", "workspace"]),
});

export const FileAttrsSchema = z.object({
  kind: z.literal("file"),
});

export const SymbolKindSchema = z.enum(["function", "class", "const", "type", "interface", "enum"]);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

export const SymbolAttrsSchema = z.object({
  kind: z.literal("symbol"),
  symbolKind: SymbolKindSchema,
  exported: z.boolean(),
});

export const EntityFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  /** Column name when it differs from the field name (@map, db_column, ...). */
  column: z.string().optional(),
  nullable: z.boolean(),
  isPk: z.boolean(),
  isFk: z.boolean(),
});
export type EntityField = z.infer<typeof EntityFieldSchema>;

export const OrmSchema = z.enum(["prisma", "typeorm", "drizzle", "sqlalchemy", "django"]);
export type Orm = z.infer<typeof OrmSchema>;

export const EntityAttrsSchema = z.object({
  kind: z.literal("entity"),
  orm: OrmSchema,
  declaredTable: z.string(),
  fields: z.array(EntityFieldSchema),
});

export const TableColumnSchema = z.object({
  name: z.string(),
  sqlType: z.string(),
  nullable: z.boolean(),
  isPk: z.boolean(),
  fkTo: z.object({ table: z.string(), column: z.string() }).optional(),
});
export type TableColumn = z.infer<typeof TableColumnSchema>;

export const DriftKindSchema = z.enum([
  "table_missing_in_db",
  "table_missing_in_code",
  "column_missing_in_db",
  "column_missing_in_code",
  "type_mismatch",
  "nullability_mismatch",
  "fk_missing_in_db",
  "fk_missing_in_code",
]);
export type DriftKind = z.infer<typeof DriftKindSchema>;

export const DriftEntrySchema = z.object({
  kind: DriftKindSchema,
  detail: z.string(),
  column: z.string().optional(),
});
export type DriftEntry = z.infer<typeof DriftEntrySchema>;

export const TableAttrsSchema = z.object({
  kind: z.literal("table"),
  origin: z.enum(["declared", "live", "both"]),
  columns: z.array(TableColumnSchema),
  drift: z.array(DriftEntrySchema).optional(),
});

export const ExtPkgAttrsSchema = z.object({
  kind: z.literal("extpkg"),
  /** "npm" | "pypi" | "stdlib" — where the unresolved import points. */
  registry: z.enum(["npm", "pypi", "stdlib"]),
});

export const NodeAttrsSchema = z.discriminatedUnion("kind", [
  ModuleAttrsSchema,
  FileAttrsSchema,
  SymbolAttrsSchema,
  EntityAttrsSchema,
  TableAttrsSchema,
  ExtPkgAttrsSchema,
]);
export type NodeAttrs = z.infer<typeof NodeAttrsSchema>;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export const SpanSchema = z.object({
  path: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
});
export type Span = z.infer<typeof SpanSchema>;

export const NodeMetricsSchema = z.object({
  loc: z.number().int().nonnegative().optional(),
  fanIn: z.number().int().nonnegative(),
  fanOut: z.number().int().nonnegative(),
  /** Precomputed PageRank over the file-import graph; 0 for non-file nodes in v1. */
  rank: z.number().nonnegative(),
});
export type NodeMetrics = z.infer<typeof NodeMetricsSchema>;

export const GraphNodeSchema = z.object({
  id: z.string(),
  kind: NodeKindSchema,
  name: z.string(),
  /** Containment tree: symbol→file, file→module, entity→file, table→schema pseudo-module. */
  parent: z.string().optional(),
  lang: LangSchema.optional(),
  attrs: NodeAttrsSchema,
  metrics: NodeMetricsSchema,
  span: SpanSchema.optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export const EDGE_KINDS = [
  "imports",
  "imports_pkg",
  "calls",
  "fk",
  "maps_to",
  "depends_on",
] as const;
export const EdgeKindSchema = z.enum(EDGE_KINDS);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const EdgeAttrsSchema = z.object({
  /** imports: which names were imported. */
  symbols: z.array(z.string()).optional(),
  /** depends_on: count of underlying file-level imports. */
  weight: z.number().int().positive().optional(),
  /** fk: [fromColumn, toColumn] pairs. */
  columns: z.array(z.tuple([z.string(), z.string()])).optional(),
  /** manual edges: the user's stated reason, surfaced verbatim in UIs. */
  reason: z.string().optional(),
});
export type EdgeAttrs = z.infer<typeof EdgeAttrsSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string(),
  kind: EdgeKindSchema,
  from: z.string(),
  to: z.string(),
  attrs: EdgeAttrsSchema.optional(),
  source: z.enum(["static", "live", "manual"]),
  confidence: z.enum(["certain", "inferred"]),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

export const GitInfoSchema = z.object({
  sha: z.string(),
  branch: z.string(),
  dirty: z.boolean(),
});
export type GitInfo = z.infer<typeof GitInfoSchema>;

export const ArchGraphSchema = z.object({
  schemaVersion: z.literal(1),
  meta: z.object({
    tool: z.literal("archmap"),
    toolVersion: z.string(),
    createdAt: z.string(),
    root: z.string(),
    git: GitInfoSchema.nullable(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    /**
     * Present only after `archmap db introspect` merged a live database into
     * the graph. `analyze` regenerates from static facts and drops it —
     * live data is an explicit overlay, never part of the deterministic build.
     */
    live: z
      .object({
        source: z.string(),
        dialect: z.enum(["postgres", "mysql"]),
        introspectedAt: z.string(),
      })
      .optional(),
  }),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});
export type ArchGraph = z.infer<typeof ArchGraphSchema>;

/** Parse + validate a graph read from disk. Throws ZodError on mismatch. */
export function parseArchGraph(data: unknown): ArchGraph {
  return ArchGraphSchema.parse(data);
}
