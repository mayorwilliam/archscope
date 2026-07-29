import { parseNodeId } from "@archscope/schema";
import { useEffect, useMemo, useState } from "react";
import { useModules, useOverview } from "../api/queries";
import type { SearchResult } from "../api/types";
import { FilePanel } from "../components/FilePanel";
import { type FitTarget, FlowCanvas } from "../components/FlowCanvas";
import { nodeCallbacks } from "../components/nodes";
import { SearchPanel } from "../components/SearchPanel";
import { applyFocus } from "../graph/focus";
import { overviewFlow } from "../graph/toFlow";
import type { FileNodeData, ModuleNodeData, ModuleView } from "../graph/types-internal";
import { useElkLayout } from "../layout/useElkLayout";
import { navigate } from "../router";

export function GraphScreen() {
  const { data: overview, error, isPending } = useOverview();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [jump, setJump] = useState<FitTarget | null>(null);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);

  const expandedList = useMemo(() => [...expanded].sort(), [expanded]);
  const { data: loadedList } = useModules(expandedList);
  const loadedModules = useMemo(
    () => new Map<string, ModuleView>((loadedList ?? []).map((view) => [view.id, view])),
    [loadedList],
  );

  useEffect(() => {
    nodeCallbacks.onToggleExpand = (moduleId: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(moduleId)) next.delete(moduleId);
        else next.add(moduleId);
        return next;
      });
    };
    return () => {
      nodeCallbacks.onToggleExpand = undefined;
    };
  }, []);

  const spec = useMemo(
    () => (overview ? overviewFlow(overview, expanded, loadedModules) : null),
    [overview, expanded, loadedModules],
  );
  const flow = useElkLayout(spec, "DOWN");

  // Hover previews, click pins: the pin survives until the pane is clicked.
  const focusedId = hoveredId ?? pinnedId;
  const decorated = useMemo(() => (flow ? applyFocus(flow, focusedId) : null), [flow, focusedId]);

  const onSearchPick = (result: SearchResult) => {
    if (result.kind === "file" && result.moduleId !== undefined) {
      const moduleId = result.moduleId;
      setExpanded((prev) => (prev.has(moduleId) ? prev : new Set(prev).add(moduleId)));
    }
    setPinnedId(result.id);
    setJump((prev) => ({ id: result.id, nonce: (prev?.nonce ?? 0) + 1 }));
  };

  const status = error
    ? error.message
    : isPending || (spec && !flow)
      ? "Laying out…"
      : overview && overview.modules.length === 0
        ? "No modules in the graph."
        : undefined;

  return (
    <div className="view" data-testid="graph-view">
      <FlowCanvas
        flow={decorated}
        status={status}
        fitTo={jump}
        onNodeClick={(node) => {
          setPinnedId(node.id);
          // A file node click opens the file: exports, docs, recent commits.
          if (node.type === "file") {
            const fileId = (node.data as unknown as FileNodeData).fileId;
            setOpenFilePath(parseNodeId(fileId).rest);
          }
        }}
        onNodeDoubleClick={(node) => {
          if (node.type === "module" || node.type === "moduleGroup") {
            navigate({ view: "module", ref: (node.data as unknown as ModuleNodeData).moduleId });
          }
        }}
        onNodeMouseEnter={(node) => setHoveredId(node.id)}
        onNodeMouseLeave={() => setHoveredId(null)}
        onPaneClick={() => {
          setPinnedId(null);
          setOpenFilePath(null);
        }}
      />
      <SearchPanel onPick={onSearchPick} />
      {openFilePath !== null && (
        <FilePanel path={openFilePath} onClose={() => setOpenFilePath(null)} />
      )}
    </div>
  );
}
