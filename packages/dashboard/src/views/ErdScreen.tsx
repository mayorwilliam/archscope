import { useMemo, useState } from "react";
import { useErd } from "../api/queries";
import { FlowCanvas } from "../components/FlowCanvas";
import { erdFlow } from "../graph/toFlow";
import type { TableNodeData } from "../graph/types-internal";
import { useElkLayout } from "../layout/useElkLayout";

export function ErdScreen() {
  const { data: view, error, isPending } = useErd();
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);

  const spec = useMemo(() => (view ? erdFlow(view) : null), [view]);
  const flow = useElkLayout(spec, "RIGHT");

  const selected = view?.tables.find((table) => table.id === selectedTableId) ?? null;
  const status = error
    ? error.message
    : isPending || (spec && !flow)
      ? "Laying out…"
      : view && view.tables.length === 0
        ? "No tables in the graph — declare ORM entities or run `archscope db introspect`."
        : undefined;

  return (
    <div className="view" data-testid="erd-view">
      <FlowCanvas
        flow={flow}
        status={status}
        onNodeClick={(node) => {
          if (node.type === "table") {
            setSelectedTableId((node.data as unknown as TableNodeData).tableId);
          }
        }}
      />
      <aside className="side-panel" data-testid="erd-panel">
        {view && !selected && (
          <>
            <h2>Database</h2>
            <div className="metrics-row">
              <span>{view.totals.tables} tables</span>
              <span>{view.totals.entities} entities</span>
              <span>{view.totals.fks} FKs</span>
            </div>
            {view.live ? (
              <p className="muted">
                Live overlay from <strong>{view.live.source}</strong> ({view.live.dialect}).
              </p>
            ) : (
              <p className="muted">Declared schema only — no live introspection yet.</p>
            )}
            {view.totals.drift > 0 && (
              <p>
                <span className="drift-badge">⚠ {view.totals.drift}</span> drift entries — click a
                flagged table.
              </p>
            )}
          </>
        )}
        {selected && (
          <>
            <h2>
              {selected.schema}.{selected.name}
            </h2>
            <div className="metrics-row">
              <span>origin: {selected.origin}</span>
              <span>{selected.columns.length} columns</span>
            </div>
            {selected.entities.length > 0 && (
              <>
                <h3>Mapped entities</h3>
                <ul>
                  {selected.entities.map((entity) => (
                    <li key={entity.id}>
                      <span>{entity.name}</span>
                      <span className="muted">
                        {entity.orm} · {entity.confidence}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {selected.drift.length > 0 && (
              <>
                <h3>Drift</h3>
                <ul data-testid="drift-entries">
                  {selected.drift.map((entry) => (
                    <li key={`${entry.kind}:${entry.column ?? ""}:${entry.detail}`}>
                      <span>{entry.detail}</span>
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
