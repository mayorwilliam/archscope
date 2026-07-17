import { parseNodeId } from "@archscope/schema";
import type {
  DiffResponse,
  ErdView,
  ModuleView,
  OverviewView,
  TableColumn,
  TableEntityRef,
} from "../api/types";

/**
 * Pure builders: view-models in, layout-ready flow specs out. Everything the
 * canvas shows is decided here (and unit-tested here) — the React components
 * only render what these functions produce.
 */

export interface FlowNodeSpec {
  id: string;
  type: "module" | "moduleGroup" | "file" | "extModule" | "table";
  data: Record<string, unknown>;
  /** Fixed size for leaves; groups omit it and take ELK's computed size. */
  width?: number;
  height?: number;
  parentId?: string;
}

export interface FlowEdgeSpec {
  id: string;
  source: string;
  target: string;
  label?: string;
  className?: string;
  strokeWidth?: number;
}

export interface FlowGraphSpec {
  nodes: FlowNodeSpec[];
  edges: FlowEdgeSpec[];
}

export const SIZES = {
  module: { width: 230, height: 76 },
  file: { width: 190, height: 52 },
  extModule: { width: 200, height: 56 },
  table: { width: 250, headerHeight: 36, entityRowHeight: 26, columnHeight: 22, padding: 8 },
} as const;

export type DiffStatus = "added" | "removed" | "changed";

export interface ModuleNodeData {
  moduleId: string;
  name: string;
  layer: string | undefined;
  files: number;
  loc: number;
  expanded: boolean;
  expandable: boolean;
  status?: DiffStatus;
  statusDetail?: string;
}

export interface FileNodeData {
  fileId: string;
  path: string;
  fileName: string;
  loc: number;
}

export interface TableNodeData {
  tableId: string;
  schema: string;
  name: string;
  origin: string;
  columns: TableColumn[];
  entities: TableEntityRef[];
  driftCount: number;
}

/** Deterministic per-layer accent color. */
const LAYER_PALETTE = [
  "#2563eb",
  "#7c3aed",
  "#0891b2",
  "#16a34a",
  "#d97706",
  "#dc2626",
  "#db2777",
  "#65a30d",
];

export function layerColor(layer: string): string {
  let hash = 0;
  for (const char of layer) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return LAYER_PALETTE[Math.abs(hash) % LAYER_PALETTE.length] as string;
}

export function edgeWidth(weight: number): number {
  return Math.min(1 + Math.log2(Math.max(weight, 1)), 5);
}

function fileNode(fileId: string, loc: number, parentId?: string): FlowNodeSpec {
  const path = parseNodeId(fileId).rest;
  return {
    id: fileId,
    type: "file",
    data: {
      fileId,
      path,
      fileName: path.split("/").pop() ?? path,
      loc,
    } satisfies FileNodeData,
    width: SIZES.file.width,
    height: SIZES.file.height,
    ...(parentId !== undefined ? { parentId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Overview: modules by layer, depends_on edges, expandable groups
// ---------------------------------------------------------------------------

export function overviewFlow(
  view: OverviewView,
  expanded: ReadonlySet<string>,
  loadedModules: ReadonlyMap<string, ModuleView>,
): FlowGraphSpec {
  const nodes: FlowNodeSpec[] = [];
  const edges: FlowEdgeSpec[] = [];

  for (const summary of view.modules) {
    const detail = expanded.has(summary.id) ? loadedModules.get(summary.id) : undefined;
    const data: ModuleNodeData = {
      moduleId: summary.id,
      name: summary.name,
      layer: summary.layer,
      files: summary.files,
      loc: summary.loc,
      expanded: detail !== undefined,
      expandable: summary.files > 0,
    };
    if (detail) {
      nodes.push({ id: summary.id, type: "moduleGroup", data: { ...data } });
      for (const file of detail.files) nodes.push(fileNode(file.id, file.loc, summary.id));
      for (const imp of detail.internalImports) {
        edges.push({
          id: `imp:${imp.from}→${imp.to}`,
          source: imp.from,
          target: imp.to,
          className: "edge-internal",
        });
      }
    } else {
      nodes.push({
        id: summary.id,
        type: "module",
        data: { ...data },
        width: SIZES.module.width,
        height: SIZES.module.height,
      });
    }
  }

  for (const dep of view.dependencies) {
    edges.push({
      id: `dep:${dep.from}→${dep.to}`,
      source: dep.from,
      target: dep.to,
      strokeWidth: edgeWidth(dep.weight),
      ...(dep.weight > 1 ? { label: String(dep.weight) } : {}),
    });
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Module drill-down: the module as a group, neighbors as ghosts
// ---------------------------------------------------------------------------

export function moduleFlow(view: ModuleView): FlowGraphSpec {
  const nodes: FlowNodeSpec[] = [];
  const edges: FlowEdgeSpec[] = [];

  nodes.push({
    id: view.id,
    type: "moduleGroup",
    data: {
      moduleId: view.id,
      name: view.name,
      layer: view.layer,
      files: view.files.length,
      loc: view.loc,
      expanded: true,
      expandable: false,
    } satisfies ModuleNodeData,
  });
  for (const file of view.files) nodes.push(fileNode(file.id, file.loc, view.id));
  for (const imp of view.internalImports) {
    edges.push({
      id: `imp:${imp.from}→${imp.to}`,
      source: imp.from,
      target: imp.to,
      className: "edge-internal",
    });
  }

  // Aggregated external dependencies, exactly as the graph states them:
  // module→module edges — files inside, neighbor modules as ghost nodes.
  const neighbors = new Map<string, { name: string }>();
  for (const dep of [...view.dependsOn, ...view.dependents]) {
    for (const id of [dep.from, dep.to]) {
      if (id !== view.id && !neighbors.has(id)) {
        neighbors.set(id, { name: parseNodeId(id).rest });
      }
    }
  }
  for (const [id, neighbor] of neighbors) {
    nodes.push({
      id,
      type: "extModule",
      data: { moduleId: id, name: neighbor.name },
      width: SIZES.extModule.width,
      height: SIZES.extModule.height,
    });
  }
  for (const dep of view.dependsOn) {
    edges.push({
      id: `dep:${dep.from}→${dep.to}`,
      source: dep.from,
      target: dep.to,
      strokeWidth: edgeWidth(dep.weight),
      label: `${dep.weight}`,
    });
  }
  for (const dep of view.dependents) {
    edges.push({
      id: `dep:${dep.from}→${dep.to}`,
      source: dep.from,
      target: dep.to,
      strokeWidth: edgeWidth(dep.weight),
      label: `${dep.weight}`,
    });
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// ERD: tables with columns, fk edges (Liam-style)
// ---------------------------------------------------------------------------

export function tableHeight(columns: number, hasEntities: boolean): number {
  const { headerHeight, entityRowHeight, columnHeight, padding } = SIZES.table;
  return headerHeight + (hasEntities ? entityRowHeight : 0) + columns * columnHeight + padding;
}

export function erdFlow(view: ErdView): FlowGraphSpec {
  const nodes: FlowNodeSpec[] = [];
  const edges: FlowEdgeSpec[] = [];

  for (const table of view.tables) {
    nodes.push({
      id: table.id,
      type: "table",
      data: {
        tableId: table.id,
        schema: table.schema,
        name: table.name,
        origin: table.origin,
        columns: table.columns,
        entities: table.entities,
        driftCount: table.drift.length,
      } satisfies TableNodeData,
      width: SIZES.table.width,
      height: tableHeight(table.columns.length, table.entities.length > 0),
    });
  }
  for (const fk of view.fks) {
    edges.push({
      id: `fk:${fk.from}→${fk.to}`,
      source: fk.from,
      target: fk.to,
      className: "edge-fk",
      label: fk.columns.map(([from, to]) => `${from} → ${to}`).join(", "),
    });
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Diff: head's module graph colored by the diff, removed things as ghosts
// ---------------------------------------------------------------------------

export function diffFlow(response: DiffResponse): FlowGraphSpec {
  const { diff, headOverview } = response;
  const added = new Set(diff.moduleChanges.added);
  const renamedByNew = new Map(diff.moduleChanges.renamed.map(([oldId, newId]) => [newId, oldId]));
  const addedDeps = new Set(diff.dependencyChanges.added.map((e) => `${e.from}→${e.to}`));
  const removedDeps = diff.dependencyChanges.removed;
  const weightDeltas = new Map(
    diff.dependencyChanges.weightDelta.map((w) => [`${w.edge.from}→${w.edge.to}`, w]),
  );

  const nodes: FlowNodeSpec[] = [];
  const edges: FlowEdgeSpec[] = [];

  for (const summary of headOverview.modules) {
    const renamedFrom = renamedByNew.get(summary.id);
    const status: DiffStatus | undefined = added.has(summary.id)
      ? "added"
      : renamedFrom !== undefined
        ? "changed"
        : undefined;
    nodes.push({
      id: summary.id,
      type: "module",
      data: {
        moduleId: summary.id,
        name: summary.name,
        layer: summary.layer,
        files: summary.files,
        loc: summary.loc,
        expanded: false,
        expandable: false,
        ...(status !== undefined ? { status } : {}),
        ...(renamedFrom !== undefined
          ? { statusDetail: `renamed from ${parseNodeId(renamedFrom).rest}` }
          : {}),
      } satisfies ModuleNodeData,
      width: SIZES.module.width,
      height: SIZES.module.height,
    });
  }

  const present = new Set(headOverview.modules.map((m) => m.id));
  const ghosts = new Set<string>(diff.moduleChanges.removed);
  for (const edge of removedDeps) {
    for (const id of [edge.from, edge.to]) if (!present.has(id)) ghosts.add(id);
  }
  for (const id of [...ghosts].sort()) {
    nodes.push({
      id,
      type: "module",
      data: {
        moduleId: id,
        name: parseNodeId(id).rest,
        layer: undefined,
        files: 0,
        loc: 0,
        expanded: false,
        expandable: false,
        status: "removed",
      } satisfies ModuleNodeData,
      width: SIZES.module.width,
      height: SIZES.module.height,
    });
  }

  for (const dep of headOverview.dependencies) {
    const key = `${dep.from}→${dep.to}`;
    const delta = weightDeltas.get(key);
    edges.push({
      id: `dep:${key}`,
      source: dep.from,
      target: dep.to,
      strokeWidth: edgeWidth(dep.weight),
      ...(addedDeps.has(key)
        ? { className: "edge-added" }
        : delta !== undefined
          ? { className: "edge-changed", label: `${delta.before} → ${delta.after}` }
          : {}),
    });
  }
  for (const edge of removedDeps) {
    edges.push({
      id: `dep-removed:${edge.from}→${edge.to}`,
      source: edge.from,
      target: edge.to,
      className: "edge-removed",
    });
  }

  return { nodes, edges };
}
