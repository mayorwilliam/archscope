import { useMemo, useState } from "react";
import { useFileContext, useModule, useOverview } from "../api/queries";
import type { FileSummary } from "../api/types";
import { FlowCanvas } from "../components/FlowCanvas";
import { Markdown } from "../components/Markdown";
import { SourceExcerpt } from "../components/SourceExcerpt";
import { applyFocus } from "../graph/focus";
import { layerColor, moduleFlow } from "../graph/toFlow";
import { useElkLayout } from "../layout/useElkLayout";
import { navigate } from "../router";

/**
 * The wiki page of one module: prose first (its README), then the numbers,
 * then the embedded neighborhood graph, then files and dependencies. The
 * old canvas-only drill-down became one card among readable content.
 */
export function ModulePage({ moduleRef }: { moduleRef: string }) {
  const { data: view, error, isPending } = useModule(moduleRef);
  const { data: overview } = useOverview();

  if (isPending) {
    return (
      <div className="wiki-scroll">
        <div className="wiki-page">
          <div className="empty-note">Loading…</div>
        </div>
      </div>
    );
  }
  if (error || !view) {
    return (
      <div className="wiki-scroll">
        <div className="wiki-page">
          <div className="empty-note">{error?.message ?? "Module not found."}</div>
        </div>
      </div>
    );
  }

  const summary = overview?.modules.find((m) => m.id === view.id);

  return (
    <div className="wiki-scroll">
      <div className="wiki-page" data-testid="module-page">
        <header className="page-header">
          <div className="page-kicker">
            {view.id}
            <span className="confidence-chip">{view.source}</span>
          </div>
          <h1>
            {view.name}
            {view.layer !== undefined && (
              <span
                className="layer-badge"
                style={{ background: layerColor(view.layer), marginLeft: 12 }}
              >
                {view.layer}
              </span>
            )}
          </h1>
          <div className="page-meta">
            <span>{view.files.length} files</span>
            <span>{view.loc.toLocaleString()} loc</span>
            <span>rank {view.rank.toFixed(3)}</span>
            <span>
              →{view.dependsOn.length} ←{view.dependents.length}
            </span>
            {summary?.instability !== undefined && (
              <span title="Martin instability: 1 = depends on everyone, 0 = everyone depends on it">
                I={summary.instability.toFixed(2)}
              </span>
            )}
          </div>
        </header>

        {view.readme && (
          <div className="card" data-testid="module-readme">
            <Markdown content={view.readme.content} basePath={view.readme.path} />
          </div>
        )}

        <ModuleMiniGraph moduleRef={moduleRef} />

        <div className="card">
          <h2>Files</h2>
          <FileTable files={view.files} />
        </div>

        <div className="two-col">
          <div className="card">
            <h2>Depends on</h2>
            <ul className="dep-list">
              {view.dependsOn.map((dep) => (
                <li key={dep.to}>
                  <button
                    type="button"
                    className="link-btn dep-name"
                    onClick={() => navigate({ view: "module", ref: dep.to })}
                  >
                    {dep.to.replace(/^mod:/, "")}
                  </button>
                  {(dep.source !== "static" || dep.confidence !== "certain") && (
                    <span className={`confidence-chip ${dep.confidence}`}>
                      {dep.source === "manual" ? "manual" : dep.confidence}
                    </span>
                  )}
                  <span className="weight">×{dep.weight}</span>
                </li>
              ))}
              {view.dependsOn.length === 0 && <li className="muted">Nothing</li>}
            </ul>
          </div>
          <div className="card">
            <h2>Depended on by</h2>
            <ul className="dep-list">
              {view.dependents.map((dep) => (
                <li key={dep.from}>
                  <button
                    type="button"
                    className="link-btn dep-name"
                    onClick={() => navigate({ view: "module", ref: dep.from })}
                  >
                    {dep.from.replace(/^mod:/, "")}
                  </button>
                  {(dep.source !== "static" || dep.confidence !== "certain") && (
                    <span className={`confidence-chip ${dep.confidence}`}>
                      {dep.source === "manual" ? "manual" : dep.confidence}
                    </span>
                  )}
                  <span className="weight">×{dep.weight}</span>
                </li>
              ))}
              {view.dependents.length === 0 && <li className="muted">Nothing</li>}
            </ul>
          </div>
        </div>

        {view.packages.length > 0 && (
          <div className="card">
            <h2>External packages</h2>
            <ul className="dep-list">
              {view.packages.map((pkg) => (
                <li key={pkg.id}>
                  <span className="dep-name">{pkg.name}</span>
                  <span className="confidence-chip">{pkg.registry}</span>
                  <span className="weight">×{pkg.fanIn}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** The neighborhood canvas, embedded as one card. Hover previews, click pins. */
function ModuleMiniGraph({ moduleRef }: { moduleRef: string }) {
  const { data: view } = useModule(moduleRef);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  const spec = useMemo(() => (view ? moduleFlow(view) : null), [view]);
  const flow = useElkLayout(spec, "DOWN");
  const decorated = useMemo(
    () => (flow ? applyFocus(flow, focusedId ?? pinnedId) : null),
    [flow, focusedId, pinnedId],
  );

  return (
    <div className="card minigraph-card" data-testid="module-minigraph">
      <div className="minigraph-head">
        <h2>Neighborhood</h2>
        <button type="button" className="link-btn" onClick={() => navigate({ view: "graph" })}>
          Open full graph →
        </button>
      </div>
      <div className="minigraph-body">
        <FlowCanvas
          flow={decorated}
          status={spec && !flow ? "Laying out…" : undefined}
          onNodeClick={(node) => setPinnedId(node.id)}
          onNodeDoubleClick={(node) => {
            if (node.type === "extModule") navigate({ view: "module", ref: node.id });
          }}
          onNodeMouseEnter={(node) => setFocusedId(node.id)}
          onNodeMouseLeave={() => setFocusedId(null)}
          onPaneClick={() => setPinnedId(null)}
        />
      </div>
    </div>
  );
}

function FileTable({ files }: { files: FileSummary[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <table className="file-table">
      <colgroup>
        <col className="c-path" />
        <col className="c-num" />
        <col className="c-num" />
        <col className="c-num" />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th>Path</th>
          <th style={{ textAlign: "right" }}>loc</th>
          <th style={{ textAlign: "right" }}>←</th>
          <th style={{ textAlign: "right" }}>→</th>
          <th>About</th>
        </tr>
      </thead>
      <tbody>
        {files.map((file) => (
          <FileRows
            key={file.id}
            file={file}
            open={openId === file.id}
            onToggle={() => setOpenId((prev) => (prev === file.id ? null : file.id))}
          />
        ))}
      </tbody>
    </table>
  );
}

function FileRows({
  file,
  open,
  onToggle,
}: {
  file: FileSummary;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className={`file-row${open ? " open" : ""}`} data-testid="module-file-row">
        <td className="file-path" onClick={onToggle} onKeyDown={onToggle}>
          {file.path}
        </td>
        <td className="num">{file.loc}</td>
        <td className="num">{file.fanIn}</td>
        <td className="num">{file.fanOut}</td>
        <td className="file-doc">{file.doc ?? ""}</td>
      </tr>
      {open && (
        <tr className="file-detail">
          <td colSpan={5}>
            <FileDetail path={file.path} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Expanded row: the file's exports with docs and inline source excerpts. */
function FileDetail({ path }: { path: string }) {
  const { data: file, error, isPending } = useFileContext(path);
  const [excerpt, setExcerpt] = useState<{ start: number; end: number } | null>(null);

  if (isPending) return <span className="muted">Loading…</span>;
  if (error || !file) return <span className="muted">{error?.message ?? "Not found"}</span>;

  return (
    <div data-testid="file-detail">
      {file.doc !== undefined && <p style={{ margin: "0 0 8px" }}>{file.doc}</p>}
      {file.exports.length === 0 && <span className="muted">No exported symbols</span>}
      {file.exports.map((exp) => (
        <div className="export-row" key={exp.name}>
          <span className="export-name">{exp.name}</span>
          <span className="kind-chip">{exp.symbolKind}</span>
          {exp.startLine !== undefined && (
            <button
              type="button"
              className="link-btn lines"
              onClick={() =>
                setExcerpt((prev) =>
                  prev?.start === exp.startLine
                    ? null
                    : { start: exp.startLine ?? 1, end: exp.endLine ?? exp.startLine ?? 1 },
                )
              }
            >
              L{exp.startLine}–{exp.endLine}
            </button>
          )}
          {exp.doc !== undefined && <span className="export-doc">{exp.doc}</span>}
        </div>
      ))}
      {excerpt && (
        <SourceExcerpt path={file.path} startLine={excerpt.start} endLine={excerpt.end} />
      )}
    </div>
  );
}
