import { linkDeclaredSchema } from "@archmap/db";
import type {
  ArchGraph,
  ArchmapConfig,
  EdgeAttrs,
  GitInfo,
  GraphEdge,
  GraphNode,
  NodeKind,
} from "@archmap/schema";
import { edgeId, fileId, moduleId, packageId, symbolId } from "@archmap/schema";
import type { ModuleInferrer } from "../modules/infer.js";
import type { FileFacts } from "../parse/facts.js";
import type { ImportResolver } from "../resolve/resolver.js";
import { pageRank } from "./metrics.js";

/**
 * FileFacts + resolution + module assignment → ArchGraph.
 *
 * Pure with respect to its inputs: same facts in, same graph out, always.
 * Output ordering is normalized (sorted by ID) so graph.json is diffable
 * and golden tests compare byte-stable structures.
 */

export interface BuildInput {
  rootDir: string;
  toolVersion: string;
  facts: FileFacts[];
  resolver: ImportResolver;
  inferModule: ModuleInferrer;
  config: ArchmapConfig;
  git: GitInfo | null;
  createdAt: string;
}

export function buildGraph(input: BuildInput): ArchGraph {
  const { facts, resolver, inferModule, config } = input;

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const factsByPath = new Map(facts.map((f) => [f.path, f]));
  const layerByModule = new Map<string, string | undefined>();

  // --- modules + files + symbols -----------------------------------------
  for (const file of facts) {
    const assignment = inferModule(file.path);
    const modId = moduleId(assignment.moduleName);
    if (!nodes.has(modId)) {
      layerByModule.set(modId, assignment.layer);
      nodes.set(modId, {
        id: modId,
        kind: "module",
        name: assignment.moduleName,
        attrs: {
          kind: "module",
          ...(assignment.layer !== undefined ? { layer: assignment.layer } : {}),
          source: assignment.source,
        },
        metrics: { loc: 0, fanIn: 0, fanOut: 0, rank: 0 },
      });
    }

    const fid = fileId(file.path);
    nodes.set(fid, {
      id: fid,
      kind: "file",
      name: file.path.split("/").pop() ?? file.path,
      parent: modId,
      lang: file.lang,
      attrs: { kind: "file" },
      metrics: { loc: file.loc, fanIn: 0, fanOut: 0, rank: 0 },
    });

    for (const sym of file.symbols) {
      if (!sym.exported) continue; // v1: the graph carries the API surface, not internals
      const sid = symbolId(file.path, sym.name);
      nodes.set(sid, {
        id: sid,
        kind: "symbol",
        name: sym.name,
        parent: fid,
        lang: file.lang,
        attrs: { kind: "symbol", symbolKind: sym.symbolKind, exported: true },
        metrics: { fanIn: 0, fanOut: 0, rank: 0 },
        span: { path: file.path, startLine: sym.startLine, endLine: sym.endLine },
      });
    }
  }

  // --- import edges --------------------------------------------------------
  for (const file of facts) {
    const fid = fileId(file.path);
    for (const imp of file.imports) {
      for (const { resolution, symbols } of resolver.resolveImport(file.path, imp)) {
        if (resolution.type === "file") {
          if (resolution.relPath === file.path) continue;
          // Only scanned source files become edge targets; a resolution into
          // e.g. a .json asset is not an architectural dependency in v1.
          if (!factsByPath.has(resolution.relPath)) continue;
          upsertEdge(edges, "imports", fid, fileId(resolution.relPath), symbols);
        } else if (resolution.type === "package" || resolution.type === "builtin") {
          const registry = resolution.type === "builtin" ? "stdlib" : resolution.registry;
          const pid = packageId(resolution.name);
          if (!nodes.has(pid)) {
            nodes.set(pid, {
              id: pid,
              kind: "extpkg",
              name: resolution.name,
              attrs: { kind: "extpkg", registry },
              metrics: { fanIn: 0, fanOut: 0, rank: 0 },
            });
          }
          upsertEdge(edges, "imports_pkg", fid, pid, symbols);
        }
        // "unresolved" → no edge: absence of evidence is recorded as absence.
      }
    }
  }

  // --- db: entities, declared tables, maps_to, fk ---------------------------
  const declaredEntities = facts.flatMap((f) => f.entities ?? []);
  if (declaredEntities.length > 0) {
    const linked = linkDeclaredSchema(declaredEntities);
    for (const { entity, id, tableId, confidence } of linked.entities) {
      nodes.set(id, {
        id,
        kind: "entity",
        name: entity.name,
        parent: fileId(entity.filePath),
        ...(factsByPath.get(entity.filePath)?.lang !== undefined
          ? { lang: factsByPath.get(entity.filePath)?.lang }
          : {}),
        attrs: {
          kind: "entity",
          orm: entity.orm,
          declaredTable: `${entity.schema}.${entity.table}`,
          fields: entity.fields,
        },
        metrics: { fanIn: 0, fanOut: 0, rank: 0 },
        span: { path: entity.filePath, startLine: entity.startLine, endLine: entity.endLine },
      });
      const mapsToId = edgeId("maps_to", id, tableId);
      edges.set(mapsToId, {
        id: mapsToId,
        kind: "maps_to",
        from: id,
        to: tableId,
        source: "static",
        confidence,
      });
    }
    for (const table of linked.tables) {
      nodes.set(table.id, {
        id: table.id,
        kind: "table",
        name: table.name,
        attrs: { kind: "table", origin: "declared", columns: table.columns },
        metrics: { fanIn: 0, fanOut: 0, rank: 0 },
      });
    }
    for (const fk of linked.fks) {
      const id = edgeId("fk", fk.fromTableId, fk.toTableId);
      edges.set(id, {
        id,
        kind: "fk",
        from: fk.fromTableId,
        to: fk.toTableId,
        attrs: { columns: fk.columns },
        source: "static",
        confidence: "certain",
      });
    }
  }

  // --- manual edges from config -------------------------------------------
  for (const manual of config.edges ?? []) {
    const id = edgeId(manual.kind, manual.from, manual.to);
    const attrs: EdgeAttrs = {};
    if (manual.reason !== undefined) attrs.reason = manual.reason;
    edges.set(id, {
      id,
      kind: manual.kind,
      from: manual.from,
      to: manual.to,
      ...(manual.reason !== undefined ? { attrs } : {}),
      source: "manual",
      confidence: "certain",
    });
  }

  // --- derived module→module depends_on ------------------------------------
  const dependsWeights = new Map<string, { from: string; to: string; weight: number }>();
  for (const edge of edges.values()) {
    if (edge.kind !== "imports") continue;
    const fromModule = nodes.get(edge.from)?.parent;
    const toModule = nodes.get(edge.to)?.parent;
    if (!fromModule || !toModule || fromModule === toModule) continue;
    const key = edgeId("depends_on", fromModule, toModule);
    const existing = dependsWeights.get(key);
    if (existing) existing.weight += 1;
    else dependsWeights.set(key, { from: fromModule, to: toModule, weight: 1 });
  }
  for (const [id, dep] of dependsWeights) {
    edges.set(id, {
      id,
      kind: "depends_on",
      from: dep.from,
      to: dep.to,
      attrs: { weight: dep.weight },
      source: "static",
      confidence: "certain",
    });
  }

  // --- metrics --------------------------------------------------------------
  applyMetrics(nodes, edges);

  // --- assemble, normalized ordering ----------------------------------------
  const sortedNodes = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const sortedEdges = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));

  const counts: Record<string, number> = {};
  for (const kind of ["module", "file", "symbol", "entity", "table", "extpkg"] as NodeKind[]) {
    counts[kind] = sortedNodes.filter((n) => n.kind === kind).length;
  }

  return {
    schemaVersion: 1,
    meta: {
      tool: "archmap",
      toolVersion: input.toolVersion,
      createdAt: input.createdAt,
      root: input.rootDir,
      git: input.git,
      counts,
    },
    nodes: sortedNodes,
    edges: sortedEdges,
  };
}

// ---------------------------------------------------------------------------

function upsertEdge(
  edges: Map<string, GraphEdge>,
  kind: "imports" | "imports_pkg",
  from: string,
  to: string,
  symbols: string[],
): void {
  const id = edgeId(kind, from, to);
  const existing = edges.get(id);
  if (existing) {
    const merged = new Set([...(existing.attrs?.symbols ?? []), ...symbols]);
    existing.attrs = { ...existing.attrs, symbols: [...merged].sort() };
    return;
  }
  edges.set(id, {
    id,
    kind,
    from,
    to,
    attrs: { symbols: [...new Set(symbols)].sort() },
    source: "static",
    confidence: "certain",
  });
}

function applyMetrics(nodes: Map<string, GraphNode>, edges: Map<string, GraphEdge>): void {
  const fileNodes: string[] = [];
  const fileEdges: Array<[string, string]> = [];

  for (const node of nodes.values()) {
    if (node.kind === "file") fileNodes.push(node.id);
  }
  for (const edge of edges.values()) {
    if (edge.kind === "imports") {
      fileEdges.push([edge.from, edge.to]);
      increment(nodes, edge.from, "fanOut");
      increment(nodes, edge.to, "fanIn");
    } else if (edge.kind === "imports_pkg") {
      increment(nodes, edge.to, "fanIn");
    } else if (edge.kind === "depends_on") {
      increment(nodes, edge.from, "fanOut");
      increment(nodes, edge.to, "fanIn");
    } else if (edge.kind === "maps_to" || edge.kind === "fk") {
      increment(nodes, edge.from, "fanOut");
      increment(nodes, edge.to, "fanIn");
    }
  }

  const ranks = pageRank({ nodes: fileNodes, edges: fileEdges });
  for (const [id, rank] of ranks) {
    const node = nodes.get(id);
    if (node) node.metrics.rank = rank;
  }

  // Module rank/loc aggregate from member files.
  for (const node of nodes.values()) {
    if (node.kind !== "file" || !node.parent) continue;
    const mod = nodes.get(node.parent);
    if (!mod) continue;
    mod.metrics.rank = Number((mod.metrics.rank + node.metrics.rank).toFixed(6));
    mod.metrics.loc = (mod.metrics.loc ?? 0) + (node.metrics.loc ?? 0);
  }
}

function increment(nodes: Map<string, GraphNode>, id: string, field: "fanIn" | "fanOut"): void {
  const node = nodes.get(id);
  if (node) node.metrics[field] += 1;
}
