import { Background, Controls, type Node, ReactFlow } from "@xyflow/react";
import type { LaidOutFlow } from "../layout/useElkLayout";
import { nodeTypes } from "./nodes";

interface FlowCanvasProps {
  flow: LaidOutFlow | null;
  status?: string | undefined;
  onNodeClick?: ((node: Node) => void) | undefined;
  onNodeDoubleClick?: ((node: Node) => void) | undefined;
}

/** Read-only canvas: layout is ELK's job, dragging would only lie about it. */
export function FlowCanvas({ flow, status, onNodeClick, onNodeDoubleClick }: FlowCanvasProps) {
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
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
      {status !== undefined && <div className="canvas-status">{status}</div>}
    </div>
  );
}
