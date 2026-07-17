import { parseNodeId } from "@archscope/schema";
import { useMemo, useState } from "react";
import { useDiff, useRefs } from "../api/queries";
import { FlowCanvas } from "../components/FlowCanvas";
import { diffFlow } from "../graph/toFlow";
import { useElkLayout } from "../layout/useElkLayout";

const mod = (id: string) => parseNodeId(id).rest;

export function DiffScreen() {
  const { data: refsData } = useRefs();
  const [base, setBase] = useState("");
  const [head, setHead] = useState("HEAD");
  const [committed, setCommitted] = useState<{ base: string; head: string } | null>(null);

  const { data, error, isFetching } = useDiff(committed?.base ?? null, committed?.head ?? "HEAD");
  const spec = useMemo(() => (data ? diffFlow(data) : null), [data]);
  const flow = useElkLayout(spec, "DOWN");

  const refNames = useMemo(() => {
    const names = (refsData?.refs ?? []).map((ref) => ref.name);
    return ["HEAD", ...names.filter((name) => name !== "HEAD")];
  }, [refsData]);

  const diff = data?.diff;
  const changes = diff
    ? diff.moduleChanges.added.length +
      diff.moduleChanges.removed.length +
      diff.moduleChanges.renamed.length +
      diff.dependencyChanges.added.length +
      diff.dependencyChanges.removed.length +
      diff.dependencyChanges.weightDelta.length +
      diff.dbChanges.tables.length +
      diff.dbChanges.fks.length +
      diff.dbChanges.driftDelta.length +
      diff.fileChanges.length
    : 0;

  const status = error
    ? error.message
    : isFetching || (spec && !flow)
      ? "Building snapshots and diffing… (first run for a ref analyzes it)"
      : committed === null
        ? "Pick a base ref and compare."
        : diff && changes === 0
          ? "No architectural changes."
          : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="diff-controls" data-testid="diff-controls">
        <label htmlFor="diff-base">base</label>
        <select
          id="diff-base"
          data-testid="diff-base"
          value={base}
          onChange={(event) => setBase(event.target.value)}
        >
          <option value="" disabled>
            choose ref…
          </option>
          {refNames
            .filter((name) => name !== "HEAD")
            .map((name) => (
              <option key={name}>{name}</option>
            ))}
        </select>
        <label htmlFor="diff-head">head</label>
        <select
          id="diff-head"
          data-testid="diff-head"
          value={head}
          onChange={(event) => setHead(event.target.value)}
        >
          {refNames.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <button
          type="button"
          className="primary"
          data-testid="diff-compare"
          disabled={base === ""}
          onClick={() => setCommitted({ base, head })}
        >
          Compare
        </button>
        {committed && (
          <span className="muted" style={{ color: "var(--muted)", fontSize: 12 }}>
            {committed.base}..{committed.head}
          </span>
        )}
      </div>
      <div className="view" data-testid="diff-view">
        <FlowCanvas flow={flow} status={status} />
        <aside className="side-panel changelist" data-testid="diff-changelist">
          {diff && (
            <>
              <h2>Changes</h2>
              <h3>Modules</h3>
              {diff.moduleChanges.added.map((id) => (
                <div className="change" key={`ma:${id}`} data-testid="change-module-added">
                  <span className="sign added">+</span>
                  <span>{mod(id)}</span>
                </div>
              ))}
              {diff.moduleChanges.removed.map((id) => (
                <div className="change" key={`mr:${id}`} data-testid="change-module-removed">
                  <span className="sign removed">−</span>
                  <span>{mod(id)}</span>
                </div>
              ))}
              {diff.moduleChanges.renamed.map(([oldId, newId]) => (
                <div className="change" key={`mn:${oldId}`}>
                  <span className="sign changed">~</span>
                  <span>
                    {mod(oldId)} → {mod(newId)}
                  </span>
                </div>
              ))}

              <h3>Dependencies</h3>
              {diff.dependencyChanges.added.map((edge) => (
                <div
                  className="change"
                  key={`da:${edge.from}${edge.to}`}
                  data-testid="change-dep-added"
                >
                  <span className="sign added">+</span>
                  <span>
                    {mod(edge.from)} → {mod(edge.to)}
                  </span>
                </div>
              ))}
              {diff.dependencyChanges.removed.map((edge) => (
                <div
                  className="change"
                  key={`dr:${edge.from}${edge.to}`}
                  data-testid="change-dep-removed"
                >
                  <span className="sign removed">−</span>
                  <span>
                    {mod(edge.from)} → {mod(edge.to)}
                  </span>
                </div>
              ))}
              {diff.dependencyChanges.weightDelta.map((delta) => (
                <div className="change" key={`dw:${delta.edge.from}${delta.edge.to}`}>
                  <span className="sign changed">Δ</span>
                  <span>
                    {mod(delta.edge.from)} → {mod(delta.edge.to)}: {delta.before} → {delta.after}
                  </span>
                </div>
              ))}

              {(diff.dbChanges.tables.length > 0 ||
                diff.dbChanges.fks.length > 0 ||
                diff.dbChanges.driftDelta.length > 0) && (
                <>
                  <h3>Database</h3>
                  {diff.dbChanges.tables.map((change) => (
                    <div className="change" key={`t:${change.id}`} data-testid="change-table">
                      <span
                        className={`sign ${change.change === "removed" ? "removed" : change.change === "added" ? "added" : "changed"}`}
                      >
                        {change.change === "added" ? "+" : change.change === "removed" ? "−" : "~"}
                      </span>
                      <span>
                        {mod(change.id)}
                        {change.deltas
                          ?.map((d) => ` ${d.field}: ${d.before} → ${d.after}`)
                          .join(";")}
                      </span>
                    </div>
                  ))}
                  {diff.dbChanges.fks.map((change) => (
                    <div
                      className="change"
                      key={`fk:${change.edge.from}${change.edge.to}`}
                      data-testid="change-fk"
                    >
                      <span className={`sign ${change.change}`}>
                        {change.change === "added" ? "+" : "−"}
                      </span>
                      <span>
                        FK {mod(change.edge.from)} → {mod(change.edge.to)}
                      </span>
                    </div>
                  ))}
                  {diff.dbChanges.driftDelta.map((entry) => (
                    <div className="change" key={`drift:${entry.kind}${entry.detail}`}>
                      <span className="sign changed">⚠</span>
                      <span>{entry.detail}</span>
                    </div>
                  ))}
                </>
              )}

              <h3>Files</h3>
              <p className="muted" style={{ color: "var(--muted)" }}>
                {diff.fileChanges.filter((c) => c.change === "added").length} added ·{" "}
                {diff.fileChanges.filter((c) => c.change === "removed").length} removed ·{" "}
                {diff.fileChanges.filter((c) => c.change === "moved").length} moved
              </p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
