import { Background, Controls, type Node, ReactFlow, useReactFlow } from "@xyflow/react";
import { useEffect } from "react";
import type { LaidOutFlow } from "../layout/useElkLayout";
import { nodeTypes } from "./nodes";

/** A navigation request: fly the viewport to this node. Bump nonce to re-fire. */
export interface FitTarget {
  id: string;
  nonce: number;
}

interface FlowCanvasProps {
  flow: LaidOutFlow | null;
  status?: string | undefined;
  fitTo?: FitTarget | null | undefined;
  onNodeClick?: ((node: Node) => void) | undefined;
  onNodeDoubleClick?: ((node: Node) => void) | undefined;
  onNodeMouseEnter?: ((node: Node) => void) | undefined;
  onNodeMouseLeave?: (() => void) | undefined;
  onPaneClick?: (() => void) | undefined;
}

/**
 * Flies to the fit target once the node exists in the current layout. A jump
 * into a just-expanded module lands here twice: first without the node (no-op),
 * then again when the new layout arrives (version bump) — and then it flies.
 */
function FitToNode({ target, version }: { target: FitTarget | null; version: number }) {
  const reactFlow = useReactFlow();
  useEffect(() => {
    // `version` is read so each finished layout re-runs the effect: the node a
    // search jump targets may not exist until its module finishes laying out.
    void version;
    if (!target) return;
    if (!reactFlow.getNode(target.id)) return;
    void reactFlow.fitView({
      nodes: [{ id: target.id }],
      duration: 500,
      maxZoom: 1.3,
      padding: 0.25,
    });
  }, [target, version, reactFlow]);
  return null;
}

/** Read-only canvas: layout is ELK's job, dragging would only lie about it. */
export function FlowCanvas({
  flow,
  status,
  fitTo,
  onNodeClick,
  onNodeDoubleClick,
  onNodeMouseEnter,
  onNodeMouseLeave,
  onPaneClick,
}: FlowCanvasProps) {
  return (
    <div className="canvas" data-testid="canvas">
      {flow && (
        <ReactFlow
          key={flow.version}
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.1}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          {...(onNodeClick
            ? { onNodeClick: (_event: unknown, node: Node) => onNodeClick(node) }
            : {})}
          {...(onNodeDoubleClick
            ? { onNodeDoubleClick: (_event: unknown, node: Node) => onNodeDoubleClick(node) }
            : {})}
          {...(onNodeMouseEnter
            ? { onNodeMouseEnter: (_event: unknown, node: Node) => onNodeMouseEnter(node) }
            : {})}
          {...(onNodeMouseLeave ? { onNodeMouseLeave: () => onNodeMouseLeave() } : {})}
          {...(onPaneClick ? { onPaneClick: () => onPaneClick() } : {})}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
          <FitToNode target={fitTo ?? null} version={flow.version} />
        </ReactFlow>
      )}
      {status !== undefined && <div className="canvas-status">{status}</div>}
    </div>
  );
}
