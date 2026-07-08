import type {
  ArchGraph,
  DriftEntry,
  EntityField,
  GraphEdge,
  GraphNode,
  NodeKind,
  TableColumn,
} from "@archmap/schema";
import { fileId, moduleId, packageId, parseNodeId, tableId } from "@archmap/schema";

/**
 * The query engine is a pure library over an already-built ArchGraph: no I/O,
 * no git, no clock. It produces JSON-serializable view-models that BOTH
 * consumers share — the MCP server renders them to markdown (render.ts) and
 * the dashboard's REST layer will serve them verbatim (phase 5). Every list
 * is deterministically ordered (score/rank desc, then id asc) so the same
 * graph always yields the same view.
 */

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface GraphIndex {
  graph: ArchGraph;
  nodes: Map<string, GraphNode>;
  /** parent id → children, in graph (id-sorted) order. */
  children: Map<string, GraphNode[]>;
  /** edge.from → edges, in graph (id-sorted) order. */
  outEdges: Map<string, GraphEdge[]>;
  /** edge.to → edges, in graph (id-sorted) order. */
  inEdges: Map<string, GraphEdge[]>;
}

export function indexGraph(graph: ArchGraph): GraphIndex {
  const nodes = new Map<string, GraphNode>();
  const children = new Map<string, GraphNode[]>();
  const outEdges = new Map<string, GraphEdge[]>();
  const inEdges = new Map<string, GraphEdge[]>();

  for (const node of graph.nodes) {
    nodes.set(node.id, node);
    if (node.parent) push(children, node.parent, node);
  }
  for (const edge of graph.edges) {
    push(outEdges, edge.from, edge);
    push(inEdges, edge.to, edge);
  }
  return { graph, nodes, children, outEdges, inEdges };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Resolve a user-supplied reference to a node. Accepts full IDs
 * ("file:src/a.ts", "mod:auth") and bare module names / file paths — agents
 * shouldn't need to know the ID scheme to ask a question.
 */
export function resolveNodeRef(index: GraphIndex, ref: string): GraphNode | null {
  const direct = index.nodes.get(ref);
  if (direct) return direct;
  for (const candidate of [moduleId(ref), fileId(ref), packageId(ref)]) {
    const node = index.nodes.get(candidate);
    if (node) return node;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface ModuleSummary {
  id: string;
  name: string;
  layer?: string;
  files: number;
  loc: number;
  rank: number;
  /** Outgoing / incoming depends_on counts. */
  dependsOn: number;
  dependents: number;
}

export interface ModuleDependency {
  from: string;
  to: string;
  weight: number;
  source: GraphEdge["source"];
  confidence: GraphEdge["confidence"];
}

export interface PackageSummary {
  id: string;
  name: string;
  registry: string;
  /** How many files import it. */
  fanIn: number;
}

export interface OverviewView {
  root: string;
  counts: Record<string, number>;
  totalImports: number;
  modules: ModuleSummary[];
  dependencies: ModuleDependency[];
  packages: PackageSummary[];
}

export function overviewView(index: GraphIndex): OverviewView {
  const modules: ModuleSummary[] = [];
  const packages: PackageSummary[] = [];
  const dependencies: ModuleDependency[] = [];
  let totalImports = 0;

  for (const node of index.graph.nodes) {
    if (node.kind === "module") modules.push(moduleSummary(index, node));
    else if (node.kind === "extpkg") {
      const registry = node.attrs.kind === "extpkg" ? node.attrs.registry : "npm";
      packages.push({ id: node.id, name: node.name, registry, fanIn: node.metrics.fanIn });
    }
  }
  for (const edge of index.graph.edges) {
    if (edge.kind === "imports") totalImports += 1;
    else if (edge.kind === "depends_on") {
      dependencies.push({
        from: edge.from,
        to: edge.to,
        weight: edge.attrs?.weight ?? 1,
        source: edge.source,
        confidence: edge.confidence,
      });
    }
  }

  modules.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  dependencies.sort((a, b) => b.weight - a.weight || (a.from + a.to).localeCompare(b.from + b.to));
  packages.sort((a, b) => b.fanIn - a.fanIn || a.id.localeCompare(b.id));

  return {
    root: index.graph.meta.root,
    counts: index.graph.meta.counts,
    totalImports,
    modules,
    dependencies,
    packages,
  };
}

function moduleSummary(index: GraphIndex, node: GraphNode): ModuleSummary {
  let files = 0;
  for (const child of index.children.get(node.id) ?? []) {
    if (child.kind === "file") files += 1;
  }
  let dependsOn = 0;
  let dependents = 0;
  for (const edge of index.outEdges.get(node.id) ?? []) {
    if (edge.kind === "depends_on") dependsOn += 1;
  }
  for (const edge of index.inEdges.get(node.id) ?? []) {
    if (edge.kind === "depends_on") dependents += 1;
  }
  const layer = node.attrs.kind === "module" ? node.attrs.layer : undefined;
  return {
    id: node.id,
    name: node.name,
    ...(layer !== undefined ? { layer } : {}),
    files,
    loc: node.metrics.loc ?? 0,
    rank: node.metrics.rank,
    dependsOn,
    dependents,
  };
}

// ---------------------------------------------------------------------------
// Module drill-down
// ---------------------------------------------------------------------------

export interface FileSummary {
  id: string;
  path: string;
  loc: number;
  rank: number;
  fanIn: number;
  fanOut: number;
  exports: string[];
}

export interface ModuleView {
  id: string;
  name: string;
  layer?: string;
  source: string;
  loc: number;
  rank: number;
  files: FileSummary[];
  dependsOn: ModuleDependency[];
  dependents: ModuleDependency[];
  packages: PackageSummary[];
}

export function moduleView(index: GraphIndex, ref: string): ModuleView | null {
  const node = resolveNodeRef(index, ref);
  if (node?.kind !== "module") return null;

  const files: FileSummary[] = [];
  const pkgFanIn = new Map<string, number>();
  for (const child of index.children.get(node.id) ?? []) {
    if (child.kind !== "file") continue;
    const exports: string[] = [];
    for (const sym of index.children.get(child.id) ?? []) {
      if (sym.kind === "symbol") exports.push(sym.name);
    }
    files.push({
      id: child.id,
      path: parseNodeId(child.id).rest,
      loc: child.metrics.loc ?? 0,
      rank: child.metrics.rank,
      fanIn: child.metrics.fanIn,
      fanOut: child.metrics.fanOut,
      exports: exports.sort(),
    });
    for (const edge of index.outEdges.get(child.id) ?? []) {
      if (edge.kind === "imports_pkg") {
        pkgFanIn.set(edge.to, (pkgFanIn.get(edge.to) ?? 0) + 1);
      }
    }
  }
  files.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));

  const packages: PackageSummary[] = [...pkgFanIn.entries()].map(([id, fanIn]) => {
    const pkg = index.nodes.get(id);
    const registry = pkg?.attrs.kind === "extpkg" ? pkg.attrs.registry : "npm";
    return { id, name: pkg?.name ?? id, registry, fanIn };
  });
  packages.sort((a, b) => b.fanIn - a.fanIn || a.id.localeCompare(b.id));

  const dependsOn = moduleDeps(index.outEdges.get(node.id) ?? []);
  const dependents = moduleDeps(index.inEdges.get(node.id) ?? []);
  const layer = node.attrs.kind === "module" ? node.attrs.layer : undefined;
  const source = node.attrs.kind === "module" ? node.attrs.source : "inferred";

  return {
    id: node.id,
    name: node.name,
    ...(layer !== undefined ? { layer } : {}),
    source,
    loc: node.metrics.loc ?? 0,
    rank: node.metrics.rank,
    files,
    dependsOn,
    dependents,
    packages,
  };
}

function moduleDeps(edges: GraphEdge[]): ModuleDependency[] {
  const deps: ModuleDependency[] = [];
  for (const edge of edges) {
    if (edge.kind !== "depends_on") continue;
    deps.push({
      from: edge.from,
      to: edge.to,
      weight: edge.attrs?.weight ?? 1,
      source: edge.source,
      confidence: edge.confidence,
    });
  }
  deps.sort((a, b) => b.weight - a.weight || (a.from + a.to).localeCompare(b.from + b.to));
  return deps;
}

// ---------------------------------------------------------------------------
// Dependencies of a single node
// ---------------------------------------------------------------------------

export interface DependencyItem {
  edgeKind: GraphEdge["kind"];
  /** The node on the other side of the edge. */
  id: string;
  name: string;
  nodeKind: NodeKind;
  symbols?: string[];
  weight?: number;
  source: GraphEdge["source"];
  confidence: GraphEdge["confidence"];
  reason?: string;
}

export interface DependenciesView {
  node: { id: string; kind: NodeKind; name: string };
  out: DependencyItem[];
  in: DependencyItem[];
}

export function dependenciesView(index: GraphIndex, ref: string): DependenciesView | null {
  const node = resolveNodeRef(index, ref);
  if (!node) return null;
  return {
    node: { id: node.id, kind: node.kind, name: node.name },
    out: dependencyItems(index, index.outEdges.get(node.id) ?? [], "to"),
    in: dependencyItems(index, index.inEdges.get(node.id) ?? [], "from"),
  };
}

function dependencyItems(
  index: GraphIndex,
  edges: GraphEdge[],
  side: "from" | "to",
): DependencyItem[] {
  const items: DependencyItem[] = [];
  for (const edge of edges) {
    const otherId = side === "to" ? edge.to : edge.from;
    const other = index.nodes.get(otherId);
    items.push({
      edgeKind: edge.kind,
      id: otherId,
      name: other?.name ?? otherId,
      nodeKind: other?.kind ?? "file",
      ...(edge.attrs?.symbols !== undefined ? { symbols: edge.attrs.symbols } : {}),
      ...(edge.attrs?.weight !== undefined ? { weight: edge.attrs.weight } : {}),
      source: edge.source,
      confidence: edge.confidence,
      ...(edge.attrs?.reason !== undefined ? { reason: edge.attrs.reason } : {}),
    });
  }
  items.sort((a, b) => a.edgeKind.localeCompare(b.edgeKind) || a.id.localeCompare(b.id));
  return items;
}

// ---------------------------------------------------------------------------
// Impact (blast radius)
// ---------------------------------------------------------------------------

/** BFS visit cap — huge graphs still answer, flagged as truncated. */
const MAX_IMPACT_VISITS = 5_000;

export interface ImpactDependent {
  id: string;
  name: string;
  kind: NodeKind;
  symbols?: string[];
}

export interface ImpactModule {
  id: string;
  name: string;
  files: number;
  minDepth: number;
}

export interface ImpactView {
  node: { id: string; kind: NodeKind; name: string };
  directDependents: ImpactDependent[];
  transitive: {
    totalFiles: number;
    maxDepth: number;
    byModule: ImpactModule[];
  };
  /** Tables reachable via maps_to from the impacted code (phase 4+ graphs). */
  tables: Array<{ id: string; name: string }>;
  truncated: boolean;
}

/**
 * Reverse-reachability over the edges that transmit change: imports (file),
 * depends_on (module), maps_to (table → entity). Symbols and entities also
 * impact the file that contains them, so containment hops count as depth 1.
 */
export function impactView(index: GraphIndex, ref: string): ImpactView | null {
  const node = resolveNodeRef(index, ref);
  if (!node) return null;

  const depth = new Map<string, number>([[node.id, 0]]);
  const queue: string[] = [node.id];
  let truncated = false;

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    const currentDepth = depth.get(currentId) as number;
    if (depth.size >= MAX_IMPACT_VISITS) {
      truncated = true;
      break;
    }
    for (const neighbor of reverseNeighbors(index, currentId)) {
      if (depth.has(neighbor)) continue;
      depth.set(neighbor, currentDepth + 1);
      queue.push(neighbor);
    }
  }
  depth.delete(node.id);

  const directDependents: ImpactDependent[] = [];
  for (const edge of index.inEdges.get(node.id) ?? []) {
    if (edge.kind !== "imports" && edge.kind !== "depends_on" && edge.kind !== "maps_to") continue;
    const from = index.nodes.get(edge.from);
    if (!from) continue;
    directDependents.push({
      id: from.id,
      name: from.name,
      kind: from.kind,
      ...(edge.attrs?.symbols !== undefined ? { symbols: edge.attrs.symbols } : {}),
    });
  }
  directDependents.sort((a, b) => a.id.localeCompare(b.id));

  const byModule = new Map<string, ImpactModule>();
  let totalFiles = 0;
  let maxDepth = 0;
  const tables: Array<{ id: string; name: string }> = [];
  for (const [id, d] of depth) {
    maxDepth = Math.max(maxDepth, d);
    const affected = index.nodes.get(id);
    if (!affected) continue;
    if (affected.kind === "table") tables.push({ id, name: affected.name });
    if (affected.kind !== "file") continue;
    totalFiles += 1;
    const modId = affected.parent;
    if (!modId) continue;
    const entry = byModule.get(modId);
    if (entry) {
      entry.files += 1;
      entry.minDepth = Math.min(entry.minDepth, d);
    } else {
      const mod = index.nodes.get(modId);
      byModule.set(modId, { id: modId, name: mod?.name ?? modId, files: 1, minDepth: d });
    }
  }

  // Code → tables direction: entities contained in the impacted files (and in
  // the target itself) map to tables the change can reach.
  for (const fileNodeId of [node.id, ...depth.keys()]) {
    const fileNode = index.nodes.get(fileNodeId);
    if (fileNode?.kind !== "file") continue;
    for (const child of index.children.get(fileNodeId) ?? []) {
      if (child.kind !== "entity") continue;
      for (const edge of index.outEdges.get(child.id) ?? []) {
        if (edge.kind !== "maps_to") continue;
        const table = index.nodes.get(edge.to);
        if (table && !tables.some((t) => t.id === table.id)) {
          tables.push({ id: table.id, name: table.name });
        }
      }
    }
  }

  const modules = [...byModule.values()].sort(
    (a, b) => b.files - a.files || a.id.localeCompare(b.id),
  );
  tables.sort((a, b) => a.id.localeCompare(b.id));

  return {
    node: { id: node.id, kind: node.kind, name: node.name },
    directDependents,
    transitive: { totalFiles, maxDepth, byModule: modules },
    tables,
    truncated,
  };
}

function reverseNeighbors(index: GraphIndex, id: string): string[] {
  const neighbors: string[] = [];
  for (const edge of index.inEdges.get(id) ?? []) {
    if (edge.kind === "imports" || edge.kind === "depends_on" || edge.kind === "maps_to") {
      neighbors.push(edge.from);
    }
  }
  // A change to a symbol/entity is a change to the file that contains it.
  const node = index.nodes.get(id);
  if (node?.parent && (node.kind === "symbol" || node.kind === "entity")) {
    neighbors.push(node.parent);
  }
  return neighbors;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const MAX_SEARCH_RESULTS = 100;

export interface SearchResult {
  id: string;
  kind: NodeKind;
  name: string;
  moduleId?: string;
  rank: number;
  score: number;
}

export interface SearchView {
  query: string;
  total: number;
  results: SearchResult[];
}

export function searchView(index: GraphIndex, query: string, kinds?: NodeKind[]): SearchView {
  const q = query.toLowerCase();
  const results: SearchResult[] = [];
  let total = 0;

  for (const node of index.graph.nodes) {
    if (kinds && kinds.length > 0 && !kinds.includes(node.kind)) continue;
    const name = node.name.toLowerCase();
    let score = 0;
    if (name === q) score = 3;
    else if (name.startsWith(q)) score = 2;
    else if (name.includes(q)) score = 1;
    else if (node.id.toLowerCase().includes(q)) score = 0.5;
    if (score === 0) continue;
    total += 1;
    const moduleId = containingModule(index, node);
    results.push({
      id: node.id,
      kind: node.kind,
      name: node.name,
      ...(moduleId !== undefined ? { moduleId } : {}),
      rank: node.metrics.rank,
      score,
    });
  }

  results.sort((a, b) => b.score - a.score || b.rank - a.rank || a.id.localeCompare(b.id));
  return { query, total, results: results.slice(0, MAX_SEARCH_RESULTS) };
}

function containingModule(index: GraphIndex, node: GraphNode): string | undefined {
  let current: GraphNode | undefined = node;
  while (current) {
    if (current.kind === "module") return current.id;
    current = current.parent ? index.nodes.get(current.parent) : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// DB schema
// ---------------------------------------------------------------------------

export type LiveMeta = NonNullable<ArchGraph["meta"]["live"]>;

export interface TableEntityRef {
  id: string;
  name: string;
  orm: string;
  confidence: GraphEdge["confidence"];
}

export interface TableSummary {
  id: string;
  schema: string;
  name: string;
  origin: "declared" | "live" | "both";
  columns: number;
  pks: string[];
  entities: TableEntityRef[];
  drift: number;
}

export interface FkRelation {
  from: string;
  to: string;
  columns: Array<[string, string]>;
  source: GraphEdge["source"];
  confidence: GraphEdge["confidence"];
}

export interface DbSchemaView {
  live: LiveMeta | null;
  schemas: Array<{ schema: string; tables: TableSummary[] }>;
  fks: FkRelation[];
  totals: { tables: number; entities: number; drift: number };
}

export function dbSchemaView(index: GraphIndex): DbSchemaView {
  const bySchema = new Map<string, TableSummary[]>();
  const fks: FkRelation[] = [];
  let entities = 0;
  let tables = 0;
  let drift = 0;

  for (const node of index.graph.nodes) {
    if (node.kind === "entity") entities += 1;
    if (node.kind !== "table" || node.attrs.kind !== "table") continue;
    tables += 1;
    const summary = tableSummary(index, node);
    drift += summary.drift;
    const list = bySchema.get(summary.schema);
    if (list) list.push(summary);
    else bySchema.set(summary.schema, [summary]);
  }
  for (const edge of index.graph.edges) {
    if (edge.kind !== "fk") continue;
    fks.push({
      from: edge.from,
      to: edge.to,
      columns: edge.attrs?.columns ?? [],
      source: edge.source,
      confidence: edge.confidence,
    });
  }

  const schemas = [...bySchema.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([schema, list]) => ({
      schema,
      tables: list.sort((a, b) => a.id.localeCompare(b.id)),
    }));
  fks.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  return {
    live: index.graph.meta.live ?? null,
    schemas,
    fks,
    totals: { tables, entities, drift },
  };
}

function tableSummary(index: GraphIndex, node: GraphNode): TableSummary {
  if (node.attrs.kind !== "table") throw new Error(`not a table node: ${node.id}`);
  const { schema } = splitTableRef(node.id, node.name);
  return {
    id: node.id,
    schema,
    name: node.name,
    origin: node.attrs.origin,
    columns: node.attrs.columns.length,
    pks: node.attrs.columns.filter((c) => c.isPk).map((c) => c.name),
    entities: mappedEntities(index, node.id),
    drift: node.attrs.drift?.length ?? 0,
  };
}

function mappedEntities(index: GraphIndex, tableNodeId: string): TableEntityRef[] {
  const refs: TableEntityRef[] = [];
  for (const edge of index.inEdges.get(tableNodeId) ?? []) {
    if (edge.kind !== "maps_to") continue;
    const entity = index.nodes.get(edge.from);
    if (entity?.attrs.kind !== "entity") continue;
    refs.push({
      id: entity.id,
      name: entity.name,
      orm: entity.attrs.orm,
      confidence: edge.confidence,
    });
  }
  refs.sort((a, b) => a.id.localeCompare(b.id));
  return refs;
}

/** `tbl:public.users` → { schema: "public", table: "users" }. */
function splitTableRef(id: string, fallbackName: string): { schema: string; table: string } {
  const rest = parseNodeId(id).rest;
  const dot = rest.indexOf(".");
  if (dot === -1) return { schema: "public", table: fallbackName };
  return { schema: rest.slice(0, dot), table: rest.slice(dot + 1) };
}

// ---------------------------------------------------------------------------
// Entity/table relations
// ---------------------------------------------------------------------------

export interface RelatedTable {
  direction: "out" | "in";
  tableId: string;
  tableName: string;
  columns: Array<[string, string]>;
  source: GraphEdge["source"];
  confidence: GraphEdge["confidence"];
  entities: TableEntityRef[];
}

export interface EntityRelationsView {
  center: { id: string; kind: "entity" | "table"; name: string };
  /** The table side of the pair — null when an entity's table node is absent. */
  table: {
    id: string;
    schema: string;
    name: string;
    origin: "declared" | "live" | "both";
    columns: TableColumn[];
    drift: DriftEntry[];
  } | null;
  /** Every entity mapping to that table (includes the center when it is one). */
  entities: Array<TableEntityRef & { file: string }>;
  /** Declared fields — only when the center is an entity. */
  fields: EntityField[] | null;
  related: RelatedTable[];
}

export function entityRelationsView(
  index: GraphIndex,
  ref: string,
  prefer: "entity" | "table" = "entity",
): EntityRelationsView | null {
  const node = resolveDbRef(index, ref, prefer);
  if (!node) return null;

  let tableNode: GraphNode | null = null;
  if (node.kind === "table") {
    tableNode = node;
  } else {
    for (const edge of index.outEdges.get(node.id) ?? []) {
      if (edge.kind === "maps_to") {
        tableNode = index.nodes.get(edge.to) ?? null;
        break;
      }
    }
  }

  const entities: EntityRelationsView["entities"] = [];
  if (tableNode) {
    for (const ref of mappedEntities(index, tableNode.id)) {
      const entityNode = index.nodes.get(ref.id);
      entities.push({
        ...ref,
        file: entityNode?.parent ? parseNodeId(entityNode.parent).rest : "",
      });
    }
  } else if (node.attrs.kind === "entity") {
    entities.push({
      id: node.id,
      name: node.name,
      orm: node.attrs.orm,
      confidence: "certain",
      file: node.parent ? parseNodeId(node.parent).rest : "",
    });
  }

  const related: RelatedTable[] = [];
  if (tableNode) {
    for (const edge of index.outEdges.get(tableNode.id) ?? []) {
      if (edge.kind === "fk") related.push(relatedTable(index, edge, "out"));
    }
    for (const edge of index.inEdges.get(tableNode.id) ?? []) {
      if (edge.kind === "fk") related.push(relatedTable(index, edge, "in"));
    }
    related.sort(
      (a, b) => a.direction.localeCompare(b.direction) || a.tableId.localeCompare(b.tableId),
    );
  }

  const table =
    tableNode && tableNode.attrs.kind === "table"
      ? {
          id: tableNode.id,
          ...splitTableRefAs(tableNode),
          origin: tableNode.attrs.origin,
          columns: tableNode.attrs.columns,
          drift: tableNode.attrs.drift ?? [],
        }
      : null;

  return {
    center: { id: node.id, kind: node.kind === "table" ? "table" : "entity", name: node.name },
    table,
    entities,
    fields: node.attrs.kind === "entity" ? node.attrs.fields : null,
    related,
  };
}

function splitTableRefAs(node: GraphNode): { schema: string; name: string } {
  const { schema, table } = splitTableRef(node.id, node.name);
  return { schema, name: table };
}

function relatedTable(index: GraphIndex, edge: GraphEdge, direction: "out" | "in"): RelatedTable {
  const otherId = direction === "out" ? edge.to : edge.from;
  const other = index.nodes.get(otherId);
  return {
    direction,
    tableId: otherId,
    tableName: other?.name ?? otherId,
    columns: edge.attrs?.columns ?? [],
    source: edge.source,
    confidence: edge.confidence,
    entities: mappedEntities(index, otherId),
  };
}

/**
 * DB references arrive in every shape an agent might try: node ids,
 * "schema.table", bare table or entity names. Explicit ids and qualified
 * names always win; bare names search the PREFERRED kind first (Prisma's
 * default table name equals the model name, so "User" is both an entity and
 * a table — the asking tool decides which reading it means). Bare-name
 * matches must be unique — an ambiguous name returns null and the caller's
 * not-found path suggests candidates instead of silently picking one.
 */
function resolveDbRef(
  index: GraphIndex,
  ref: string,
  prefer: "entity" | "table",
): GraphNode | null {
  const direct = index.nodes.get(ref);
  if (direct && (direct.kind === "entity" || direct.kind === "table")) return direct;

  if (ref.includes(".")) {
    const qualified = index.nodes.get(`tbl:${ref}`);
    if (qualified?.kind === "table") return qualified;
  }

  const lower = ref.toLowerCase();
  const kinds: Array<"entity" | "table"> =
    prefer === "entity" ? ["entity", "table"] : ["table", "entity"];
  for (const kind of kinds) {
    if (kind === "table") {
      const publicTable = index.nodes.get(tableId("public", ref));
      if (publicTable?.kind === "table") return publicTable;
    }
    const matches = index.graph.nodes.filter(
      (n) => n.kind === kind && n.name.toLowerCase() === lower,
    );
    if (matches.length === 1) return matches[0] ?? null;
    if (matches.length > 1) return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schema drift
// ---------------------------------------------------------------------------

export interface DriftTable {
  id: string;
  name: string;
  entries: DriftEntry[];
}

export interface SchemaDriftView {
  live: LiveMeta | null;
  tables: DriftTable[];
  totals: { tablesWithDrift: number; entries: number; tablesChecked: number };
}

export function schemaDriftView(index: GraphIndex): SchemaDriftView {
  const tables: DriftTable[] = [];
  let entries = 0;
  let tablesChecked = 0;

  for (const node of index.graph.nodes) {
    if (node.kind !== "table" || node.attrs.kind !== "table") continue;
    tablesChecked += 1;
    const drift = node.attrs.drift ?? [];
    if (drift.length === 0) continue;
    tables.push({ id: node.id, name: node.name, entries: drift });
    entries += drift.length;
  }
  tables.sort((a, b) => a.id.localeCompare(b.id));

  return {
    live: index.graph.meta.live ?? null,
    tables,
    totals: { tablesWithDrift: tables.length, entries, tablesChecked },
  };
}

// ---------------------------------------------------------------------------
// File context
// ---------------------------------------------------------------------------

export interface FileExport {
  name: string;
  symbolKind: string;
  startLine?: number;
  endLine?: number;
}

export interface FileContextView {
  id: string;
  path: string;
  lang?: string;
  loc: number;
  rank: number;
  fanIn: number;
  fanOut: number;
  moduleId?: string;
  exports: FileExport[];
  entities: Array<{ id: string; name: string; orm: string; declaredTable: string }>;
  imports: DependencyItem[];
  importedBy: DependencyItem[];
}

export function fileContextView(index: GraphIndex, ref: string): FileContextView | null {
  const node = resolveNodeRef(index, ref);
  if (node?.kind !== "file") return null;

  const exports: FileExport[] = [];
  const entities: FileContextView["entities"] = [];
  for (const child of index.children.get(node.id) ?? []) {
    if (child.kind === "symbol" && child.attrs.kind === "symbol") {
      exports.push({
        name: child.name,
        symbolKind: child.attrs.symbolKind,
        ...(child.span !== undefined
          ? { startLine: child.span.startLine, endLine: child.span.endLine }
          : {}),
      });
    } else if (child.kind === "entity" && child.attrs.kind === "entity") {
      entities.push({
        id: child.id,
        name: child.name,
        orm: child.attrs.orm,
        declaredTable: child.attrs.declaredTable,
      });
    }
  }
  exports.sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0) || a.name.localeCompare(b.name));
  entities.sort((a, b) => a.id.localeCompare(b.id));

  return {
    id: node.id,
    path: parseNodeId(node.id).rest,
    ...(node.lang !== undefined ? { lang: node.lang } : {}),
    loc: node.metrics.loc ?? 0,
    rank: node.metrics.rank,
    fanIn: node.metrics.fanIn,
    fanOut: node.metrics.fanOut,
    ...(node.parent !== undefined ? { moduleId: node.parent } : {}),
    exports,
    entities,
    imports: dependencyItems(index, index.outEdges.get(node.id) ?? [], "to"),
    importedBy: dependencyItems(index, index.inEdges.get(node.id) ?? [], "from"),
  };
}
