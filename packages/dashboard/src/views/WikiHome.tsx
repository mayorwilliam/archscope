import { useDoc, useDocs, useMeta, useOverview } from "../api/queries";
import { Markdown } from "../components/Markdown";
import { navigate } from "../router";

function basename(root: string): string {
  const parts = root.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || root;
}

/**
 * The wiki's front page: the project README as prose, the vital signs as
 * stat cards, dependency health, and the top modules as entry points.
 */
export function WikiHome() {
  const { data: meta } = useMeta();
  const { data: overview } = useOverview();
  const { data: docs } = useDocs();
  // 404 when the repo has no root README — the page degrades to stats-only.
  const { data: readme, error: readmeError } = useDoc("README.md");

  const counts = meta?.counts ?? {};
  const stat = (label: string, value: number | undefined) =>
    value !== undefined && value > 0 ? { label, value } : null;
  const stats = [
    stat("modules", counts.module),
    stat("files", counts.file),
    stat("symbols", counts.symbol),
    stat("docs", counts.doc),
    stat("entities", counts.entity),
    stat("tables", counts.table),
    stat("packages", counts.extpkg),
  ].filter((s): s is { label: string; value: number } => s !== null);

  const topModules = (overview?.modules ?? []).slice(0, 9);
  const projectDocs = (docs?.docs ?? []).filter((doc) => doc.path !== "README.md");

  return (
    <div className="wiki-scroll">
      <div className="wiki-page" data-testid="wiki-home">
        <header className="page-header">
          <div className="page-kicker">Project wiki</div>
          <h1>{readme?.title ?? (meta ? basename(meta.root) : "…")}</h1>
          {meta && (
            <div className="page-meta">
              <span>{meta.root}</span>
            </div>
          )}
        </header>

        <div className="card-grid">
          {stats.map((s) => (
            <div className="stat-card" key={s.label}>
              <div className="stat-value">{s.value.toLocaleString()}</div>
              <div className="stat-label">{s.label}</div>
            </div>
          ))}
        </div>

        {overview && overview.cycles.length > 0 && (
          <div className="card health-card" data-testid="health-card">
            <h2>Dependency health</h2>
            {overview.cycles.map((cycle) => (
              <div className="cycle" key={cycle.join("|")}>
                ⚠ cycle: {cycle.map((id) => id.replace(/^mod:/, "")).join(" ↔ ")}
              </div>
            ))}
          </div>
        )}

        {readme && (
          <div className="card" data-testid="wiki-readme">
            <Markdown content={readme.content} basePath={readme.path} />
            {readme.truncated && (
              <div className="doc-truncated-note">
                Stored content was capped at extraction — open the file for the full text.
              </div>
            )}
          </div>
        )}
        {readmeError && !readme && (
          <div className="card">
            <h2>No README</h2>
            <p className="muted">
              This repo has no root README.md — add one and it becomes this page.
            </p>
          </div>
        )}

        <section>
          <h2>Modules by rank</h2>
          <div className="module-cards">
            {topModules.map((mod) => (
              <button
                type="button"
                className="module-card"
                key={mod.id}
                data-testid="home-module-card"
                onClick={() => navigate({ view: "module", ref: mod.id })}
              >
                <span className="module-name">
                  <span className="name">{mod.name}</span>
                </span>
                <span className="module-stats">
                  <span>{mod.files} files</span>
                  <span>{mod.loc.toLocaleString()} loc</span>
                  <span>
                    →{mod.dependsOn} ←{mod.dependents}
                  </span>
                  {mod.instability !== undefined && <span>I={mod.instability.toFixed(2)}</span>}
                </span>
              </button>
            ))}
          </div>
        </section>

        {projectDocs.length > 0 && (
          <section style={{ marginTop: "var(--space-5)" }}>
            <h2>Documents</h2>
            <ul className="doc-list">
              {projectDocs.map((doc) => (
                <li key={doc.id}>
                  <button type="button" onClick={() => navigate({ view: "doc", ref: doc.path })}>
                    <span className="doc-title">{doc.title}</span>
                    <span className="doc-path">{doc.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
