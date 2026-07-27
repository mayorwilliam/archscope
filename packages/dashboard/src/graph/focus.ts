import type { LaidOutFlow } from "../layout/useElkLayout";

/**
 * Post-layout focus decoration: the focused node and its direct neighborhood
 * stay lit, everything else dims. Operates on the laid-out flow — never on
 * the spec — so hovering can never re-trigger an ELK layout. Positions and
 * version are untouched; only classNames change.
 */
export function applyFocus(flow: LaidOutFlow, focusedId: string | null): LaidOutFlow {
  if (focusedId === null) return flow;
  if (!flow.nodes.some((node) => node.id === focusedId)) return flow;

  const kept = new Set<string>([focusedId]);
  const incident = new Set<string>();
  for (const edge of flow.edges) {
    if (edge.source === focusedId || edge.target === focusedId) {
      incident.add(edge.id);
      kept.add(edge.source);
      kept.add(edge.target);
    }
  }

  // A dimmed group holding a lit file reads as a glitch: containers of kept
  // nodes stay visible too.
  const parents = new Map(flow.nodes.map((node) => [node.id, node.parentId]));
  for (const id of [...kept]) {
    const parent = parents.get(id);
    if (parent !== undefined) kept.add(parent);
  }

  return {
    version: flow.version,
    nodes: flow.nodes.map((node) => ({
      ...node,
      className: !kept.has(node.id)
        ? "node-dim"
        : node.id === focusedId
          ? "node-focus"
          : "node-kept",
    })),
    edges: flow.edges.map((edge) => ({
      ...edge,
      className: appendClass(edge.className, incident.has(edge.id) ? "edge-focus" : "edge-dim"),
    })),
  };
}

function appendClass(base: string | undefined, extra: string): string {
  return base === undefined ? extra : `${base} ${extra}`;
}
