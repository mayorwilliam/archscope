import type { ElkNode } from "elkjs/lib/elk-api";
import type { FlowGraphSpec, FlowNodeSpec } from "../graph/toFlow";

/**
 * FlowGraphSpec → ELK graph → positioned nodes. Everything here is pure and
 * unit-tested; the worker lives in elk-runner.ts. Containment nests as ELK
 * children, so groups are sized by ELK and child coordinates come back
 * parent-relative — exactly what React Flow's parentId expects.
 */

export type LayoutDirection = "DOWN" | "RIGHT";

const GROUP_PADDING = "[top=40.0,left=16.0,bottom=16.0,right=16.0]";

export function buildElkGraph(spec: FlowGraphSpec, direction: LayoutDirection): ElkNode {
  const byParent = new Map<string | undefined, FlowNodeSpec[]>();
  for (const node of spec.nodes) {
    const list = byParent.get(node.parentId);
    if (list) list.push(node);
    else byParent.set(node.parentId, [node]);
  }

  const toElk = (node: FlowNodeSpec): ElkNode => {
    const children = (byParent.get(node.id) ?? []).map(toElk);
    return {
      id: node.id,
      ...(node.width !== undefined ? { width: node.width } : {}),
      ...(node.height !== undefined ? { height: node.height } : {}),
      ...(children.length > 0 ? { children, layoutOptions: { "elk.padding": GROUP_PADDING } } : {}),
    };
  };

  return {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction,
      "elk.spacing.nodeNode": "36",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    },
    children: (byParent.get(undefined) ?? []).map(toElk),
    edges: spec.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };
}

export interface NodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function extractPositions(layout: ElkNode): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>();
  const walk = (node: ElkNode): void => {
    for (const child of node.children ?? []) {
      positions.set(child.id, {
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: child.width ?? 0,
        height: child.height ?? 0,
      });
      walk(child);
    }
  };
  walk(layout);
  return positions;
}
