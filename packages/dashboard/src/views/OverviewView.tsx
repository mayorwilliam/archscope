import { useEffect, useMemo, useState } from "react";
import { useModules, useOverview } from "../api/queries";
import { FlowCanvas } from "../components/FlowCanvas";
import { nodeCallbacks } from "../components/nodes";
import { overviewFlow } from "../graph/toFlow";
import type { ModuleNodeData, ModuleView } from "../graph/types-internal";
import { useElkLayout } from "../layout/useElkLayout";
import { navigate } from "../router";

export function OverviewScreen() {
  const { data: overview, error, isPending } = useOverview();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

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

  const status = error
    ? error.message
    : isPending || (spec && !flow)
      ? "Laying out…"
      : overview && overview.modules.length === 0
        ? "No modules in the graph."
        : undefined;

  return (
    <div className="view" data-testid="overview-view">
      <FlowCanvas
        flow={flow}
        status={status}
        onNodeDoubleClick={(node) => {
          if (node.type === "module" || node.type === "moduleGroup") {
            navigate({ view: "module", ref: (node.data as unknown as ModuleNodeData).moduleId });
          }
        }}
      />
    </div>
  );
}
