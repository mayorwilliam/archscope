import type {
  ArchDiff,
  ArchGraph,
  DriftEntry,
  EdgeChange,
  EdgeRef,
  FieldDelta,
  GraphNode,
  NodeChange,
  RefInfo,
  TableColumn,
  WeightDelta,
} from "@archscope/schema";
import { fileId, parseNodeId, symbolId } from "@archscope/schema";

/**
 * Graph diff = set arithmetic over stable IDs, in three passes:
 *
 *   1. remap base file/symbol IDs through git's rename map, so a renamed
 *      file compares against itself (a `moved`, never an add+remove pair)
 *   2. pair removed↔added modules by how many files they share → renames
 *   3. compare module-level depends_on with renamed modules unified
 *
 * The headline is the module layer; fileChanges is drill-down detail.
 * All output arrays are sorted — two runs over the same snapshots are
 * byte-identical.
 */

export interface DiffInput {
  base: ArchGraph;
  head: ArchGraph;
  /** old repo-relative path → new repo-relative path (from `gitRenames`). */
  renames: Map<string, string>;
  baseRef: RefInfo;
  headRef: RefInfo;
}

export function diffGraphs(input: DiffInput): ArchDiff {
  const { base, head, renames } = input;

  const remapId = (id: string): string => {
    const parsed = parseNodeId(id);
    if (parsed.kind === "file") {
      const renamed = renames.get(parsed.rest);
      return renamed ? fileId(renamed) : id;
    }
    if (parsed.kind === "sym" && parsed.path !== undefined && parsed.name !== undefined) {
      const renamed = renames.get(parsed.path);
      return renamed ? symbolId(renamed, parsed.name) : id;
    }
    return id;
  };

  // --- files -----------------------------------------------------------------
  const baseFiles = new Map<string, GraphNode>(); // remapped id → node
  for (const node of base.nodes) {
    if (node.kind === "file") baseFiles.set(remapId(node.id), node);
  }
  const headFiles = new Map<string, GraphNode>();
  for (const node of head.nodes) {
    if (node.kind === "file") headFiles.set(node.id, node);
  }

  const fileChanges: NodeChange[] = [];
  for (const [remapped, node] of baseFiles) {
    if (!headFiles.has(remapped)) fileChanges.push({ id: node.id, change: "removed" });
    else if (remapped !== node.id) {
      fileChanges.push({ id: remapped, change: "moved", previousId: node.id });
    }
  }
  for (const id of headFiles.keys()) {
    if (!baseFiles.has(id)) fileChanges.push({ id, change: "added" });
  }
  fileChanges.sort((a, b) => a.id.localeCompare(b.id));

  // --- modules ---------------------------------------------------------------
  const baseModules = moduleFileSets(base, remapId);
  const headModules = moduleFileSets(head, (id) => id);

  let added = [...headModules.keys()].filter((id) => !baseModules.has(id));
  let removed = [...baseModules.keys()].filter((id) => !headModules.has(id));

  // A module whose files mostly survived under a new name is a rename.
  const renamed: Array<[string, string]> = [];
  const takenAdded = new Set<string>();
  for (const oldId of removed) {
    const oldFiles = baseModules.get(oldId) ?? new Set();
    let best: { id: string; overlap: number } | null = null;
    for (const newId of added) {
      if (takenAdded.has(newId)) continue;
      const newFiles = headModules.get(newId) ?? new Set();
      const shared = [...oldFiles].filter((f) => newFiles.has(f)).length;
      const overlap = shared / Math.max(oldFiles.size, newFiles.size, 1);
      if (overlap > 0.5 && (best === null || overlap > best.overlap)) {
        best = { id: newId, overlap };
      }
    }
    if (best) {
      renamed.push([oldId, best.id]);
      takenAdded.add(best.id);
    }
  }
  const renamedOld = new Set(renamed.map(([oldId]) => oldId));
  added = added.filter((id) => !takenAdded.has(id)).sort();
  removed = removed.filter((id) => !renamedOld.has(id)).sort();
  renamed.sort((a, b) => a[0].localeCompare(b[0]));

  const moduleRemap = new Map(renamed);
  const remapModule = (id: string): string => moduleRemap.get(id) ?? id;

  // --- module dependencies -----------------------------------------------------
  const baseDeps = dependsOnByKey(base, remapModule);
  const headDeps = dependsOnByKey(head, (id) => id);

  const depAdded: EdgeRef[] = [];
  const depRemoved: EdgeRef[] = [];
  const weightDelta: WeightDelta[] = [];
  for (const [key, dep] of headDeps) {
    const inBase = baseDeps.get(key);
    if (!inBase) depAdded.push(dep.edge);
    else if (inBase.weight !== dep.weight) {
      weightDelta.push({ edge: dep.edge, before: inBase.weight, after: dep.weight });
    }
  }
  for (const [key, dep] of baseDeps) {
    if (!headDeps.has(key)) depRemoved.push(dep.edge);
  }
  const byEdge = (a: EdgeRef, b: EdgeRef) =>
    a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
  depAdded.sort(byEdge);
  depRemoved.sort(byEdge);
  weightDelta.sort((a, b) => byEdge(a.edge, b.edge));

  return {
    base: input.baseRef,
    head: input.headRef,
    moduleChanges: { added, removed, renamed },
    dependencyChanges: { added: depAdded, removed: depRemoved, weightDelta },
    dbChanges: diffDb(base, head),
    fileChanges,
  };
}

// ---------------------------------------------------------------------------
// DB layer: table IDs are schema-qualified names, not paths — git renames
// don't apply, so this is pure set arithmetic plus column-level deltas.
// ---------------------------------------------------------------------------

function diffDb(base: ArchGraph, head: ArchGraph): ArchDiff["dbChanges"] {
  const baseTables = tablesById(base);
  const headTables = tablesById(head);

  const tables: NodeChange[] = [];
  for (const id of baseTables.keys()) {
    if (!headTables.has(id)) tables.push({ id, change: "removed" });
  }
  for (const [id, node] of headTables) {
    const before = baseTables.get(id);
    if (!before) {
      tables.push({ id, change: "added" });
      continue;
    }
    const deltas = columnDeltas(tableColumns(before), tableColumns(node));
    if (deltas.length > 0) tables.push({ id, change: "changed", deltas });
  }
  tables.sort((a, b) => a.id.localeCompare(b.id));

  const baseFks = fkEdgeRefs(base);
  const headFks = fkEdgeRefs(head);
  const fks: EdgeChange[] = [];
  for (const [key, edge] of headFks) {
    if (!baseFks.has(key)) fks.push({ edge, change: "added" });
  }
  for (const [key, edge] of baseFks) {
    if (!headFks.has(key)) fks.push({ edge, change: "removed" });
  }
  fks.sort((a, b) => a.edge.from.localeCompare(b.edge.from) || a.edge.to.localeCompare(b.edge.to));

  // Drift introduced since base (present in head, absent in base). Static
  // snapshots carry no drift; this activates when diffing introspected graphs.
  const baseDrift = new Set(driftKeys(base));
  const driftDelta: DriftEntry[] = [];
  for (const [key, entry] of driftEntries(head)) {
    if (!baseDrift.has(key)) driftDelta.push(entry);
  }
  driftDelta.sort((a, b) => a.kind.localeCompare(b.kind) || a.detail.localeCompare(b.detail));

  return { tables, fks, driftDelta };
}

function tablesById(graph: ArchGraph): Map<string, GraphNode> {
  const map = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (node.kind === "table") map.set(node.id, node);
  }
  return map;
}

function tableColumns(node: GraphNode): TableColumn[] {
  return node.attrs.kind === "table" ? node.attrs.columns : [];
}

function columnDeltas(before: TableColumn[], after: TableColumn[]): FieldDelta[] {
  const beforeByName = new Map(before.map((c) => [c.name, c]));
  const afterByName = new Map(after.map((c) => [c.name, c]));
  const deltas: FieldDelta[] = [];
  for (const [name, column] of beforeByName) {
    if (!afterByName.has(name)) {
      deltas.push({ field: `column ${name}`, before: columnSig(column), after: "∅" });
    }
  }
  for (const [name, column] of afterByName) {
    const prev = beforeByName.get(name);
    if (!prev) {
      deltas.push({ field: `column ${name}`, before: "∅", after: columnSig(column) });
    } else if (columnSig(prev) !== columnSig(column)) {
      deltas.push({ field: `column ${name}`, before: columnSig(prev), after: columnSig(column) });
    }
  }
  deltas.sort((a, b) => a.field.localeCompare(b.field));
  return deltas;
}

function columnSig(column: TableColumn): string {
  return `${column.sqlType}${column.nullable ? "?" : ""}${column.isPk ? " pk" : ""}`;
}

function fkEdgeRefs(graph: ArchGraph): Map<string, EdgeRef> {
  const map = new Map<string, EdgeRef>();
  for (const edge of graph.edges) {
    if (edge.kind !== "fk") continue;
    map.set(`${edge.from} ${edge.to}`, { kind: "fk", from: edge.from, to: edge.to });
  }
  return map;
}

function driftEntries(graph: ArchGraph): Map<string, DriftEntry> {
  const map = new Map<string, DriftEntry>();
  for (const node of graph.nodes) {
    if (node.kind !== "table" || node.attrs.kind !== "table") continue;
    for (const entry of node.attrs.drift ?? []) {
      map.set(`${node.id}|${entry.kind}|${entry.column ?? ""}|${entry.detail}`, entry);
    }
  }
  return map;
}

function driftKeys(graph: ArchGraph): string[] {
  return [...driftEntries(graph).keys()];
}

// ---------------------------------------------------------------------------

function moduleFileSets(
  graph: ArchGraph,
  remapId: (id: string) => string,
): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (node.kind === "module") {
      if (!sets.has(node.id)) sets.set(node.id, new Set());
    } else if (node.kind === "file" && node.parent) {
      let files = sets.get(node.parent);
      if (!files) {
        files = new Set();
        sets.set(node.parent, files);
      }
      files.add(remapId(node.id));
    }
  }
  return sets;
}

interface DepEntry {
  edge: EdgeRef;
  weight: number;
}

function dependsOnByKey(
  graph: ArchGraph,
  remapModule: (id: string) => string,
): Map<string, DepEntry> {
  const deps = new Map<string, DepEntry>();
  for (const edge of graph.edges) {
    if (edge.kind !== "depends_on") continue;
    const from = remapModule(edge.from);
    const to = remapModule(edge.to);
    deps.set(`${from} ${to}`, {
      edge: { kind: "depends_on", from, to },
      weight: edge.attrs?.weight ?? 1,
    });
  }
  return deps;
}
