import { useMemo, useState } from "react";
import { useModule } from "../api/queries";
import { FlowCanvas } from "../components/FlowCanvas";
import { applyFocus } from "../graph/focus";
import { moduleFlow } from "../graph/toFlow";
import type { FileNodeData } from "../graph/types-internal";
import { useElkLayout } from "../layout/useElkLayout";
import { navigate } from "../router";

export function ModuleScreen({ moduleRef }: { moduleRef: string }) {
  const { data: view, error, isPending } = useModule(moduleRef);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const spec = useMemo(() => (view ? moduleFlow(view) : null), [view]);
  const flow = useElkLayout(spec, "DOWN");

  // Hover previews, selection pins — same focus model as the overview.
  const focusedId = hoveredId ?? selectedFileId;
  const decorated = useMemo(() => (flow ? applyFocus(flow, focusedId) : null), [flow, focusedId]);

  const selectedFile = view?.files.find((file) => file.id === selectedFileId) ?? null;
  const status = error ? error.message : isPending || (spec && !flow) ? "Laying out…" : undefined;

  return (
    <div className="view" data-testid="module-view">
      <FlowCanvas
        flow={decorated}
        status={status}
        onNodeClick={(node) => {
          if (node.type === "file") {
            setSelectedFileId((node.data as unknown as FileNodeData).fileId);
          }
        }}
        onNodeDoubleClick={(node) => {
          if (node.type === "extModule") {
            navigate({ view: "module", ref: node.id });
            setSelectedFileId(null);
          }
        }}
        onNodeMouseEnter={(node) => setHoveredId(node.id)}
        onNodeMouseLeave={() => setHoveredId(null)}
        onPaneClick={() => setSelectedFileId(null)}
      />
      <aside className="side-panel" data-testid="module-panel">
        {view && (
          <>
            <h2>{view.name}</h2>
            <div className="metrics-row">
              {view.layer !== undefined && <span>layer {view.layer}</span>}
              <span>{view.files.length} files</span>
              <span>{view.loc.toLocaleString()} loc</span>
              <span>source: {view.source}</span>
            </div>

            {selectedFile ? (
              <>
                <h3>{selectedFile.path}</h3>
                <div className="metrics-row">
                  <span>{selectedFile.loc} loc</span>
                  <span>fan-in {selectedFile.fanIn}</span>
                  <span>fan-out {selectedFile.fanOut}</span>
                </div>
                <h3>Exports ({selectedFile.exports.length})</h3>
                <ul data-testid="symbols-list">
                  {selectedFile.exports.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                  {selectedFile.exports.length === 0 && (
                    <li className="muted">No exported symbols</li>
                  )}
                </ul>
              </>
            ) : (
              <>
                <h3>Files by rank</h3>
                <ul>
                  {view.files.map((file) => (
                    <li key={file.id}>
                      <span>{file.path}</span>
                      <span className="muted">{file.exports.length} exports</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3>Depends on</h3>
            <ul>
              {view.dependsOn.map((dep) => (
                <li key={dep.to}>
                  <span>{dep.to.replace(/^mod:/, "")}</span>
                  <span className="muted">×{dep.weight}</span>
                </li>
              ))}
              {view.dependsOn.length === 0 && <li className="muted">Nothing</li>}
            </ul>
            <h3>Depended on by</h3>
            <ul>
              {view.dependents.map((dep) => (
                <li key={dep.from}>
                  <span>{dep.from.replace(/^mod:/, "")}</span>
                  <span className="muted">×{dep.weight}</span>
                </li>
              ))}
              {view.dependents.length === 0 && <li className="muted">Nothing</li>}
            </ul>
            {view.packages.length > 0 && (
              <>
                <h3>External packages</h3>
                <ul>
                  {view.packages.map((pkg) => (
                    <li key={pkg.id}>
                      <span>{pkg.name}</span>
                      <span className="muted">
                        {pkg.registry} · ×{pkg.fanIn}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
