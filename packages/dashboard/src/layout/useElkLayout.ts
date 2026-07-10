import type { Edge, Node } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import { useEffect, useState } from "react";
import type { FlowGraphSpec } from "../graph/toFlow";
import { elkLayout } from "./elk-runner";
import { buildElkGraph, extractPositions, type LayoutDirection } from "./layout";

export interface LaidOutFlow {
  nodes: Node[];
  edges: Edge[];
  /** Bumps on every finished layout — used to re-fit the viewport. */
  version: number;
}

/** Async ELK layout: spec in, positioned React Flow nodes/edges out. */
export function useElkLayout(
  spec: FlowGraphSpec | null,
  direction: LayoutDirection,
): LaidOutFlow | null {
  const [result, setResult] = useState<LaidOutFlow | null>(null);

  useEffect(() => {
    if (!spec) {
      setResult(null);
      return;
    }
    let cancelled = false;
    elkLayout(buildElkGraph(spec, direction))
      .then((layout) => {
        if (cancelled) return;
        const positions = extractPositions(layout);
        const nodes: Node[] = spec.nodes.map((node) => {
          const pos = positions.get(node.id);
          return {
            id: node.id,
            type: node.type,
            data: node.data,
            position: { x: pos?.x ?? 0, y: pos?.y ?? 0 },
            width: node.width ?? pos?.width ?? 0,
            height: node.height ?? pos?.height ?? 0,
            draggable: false,
            connectable: false,
            ...(node.parentId !== undefined
              ? { parentId: node.parentId, extent: "parent" as const }
              : {}),
          };
        });
        const edges: Edge[] = spec.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          markerEnd: { type: MarkerType.ArrowClosed },
          ...(edge.label !== undefined ? { label: edge.label } : {}),
          ...(edge.className !== undefined ? { className: edge.className } : {}),
          ...(edge.strokeWidth !== undefined ? { style: { strokeWidth: edge.strokeWidth } } : {}),
        }));
        setResult((prev) => ({ nodes, edges, version: (prev?.version ?? 0) + 1 }));
      })
      .catch((error: unknown) => {
        if (!cancelled) console.error("layout failed:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [spec, direction]);

  return result;
}
