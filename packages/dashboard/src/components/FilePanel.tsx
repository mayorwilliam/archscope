import { useState } from "react";
import { useFileContext, useFileHistory } from "../api/queries";
import { navigate } from "../router";
import { SourceExcerpt } from "./SourceExcerpt";

/**
 * Click a file node on the canvas → this panel: what the file exports (with
 * docs, line spans, inline source) and which commits touched it most
 * recently. The graph stops being a picture and becomes a door.
 */
export function FilePanel({ path, onClose }: { path: string; onClose: () => void }) {
  const { data: file, error, isPending } = useFileContext(path);
  const [excerpt, setExcerpt] = useState<{ start: number; end: number } | null>(null);

  return (
    <aside className="side-panel file-panel" data-testid="file-panel">
      <div className="file-panel-head">
        <h2>{path}</h2>
        <button type="button" className="link-btn" data-testid="file-panel-close" onClick={onClose}>
          ✕
        </button>
      </div>

      {isPending && <p className="muted-note">Loading…</p>}
      {error && <p className="muted-note">{error.message}</p>}

      {file && (
        <>
          <div className="metrics-row">
            <span>{file.loc} loc</span>
            <span>←{file.fanIn}</span>
            <span>→{file.fanOut}</span>
            {file.lang !== undefined && <span>{file.lang}</span>}
          </div>
          {file.doc !== undefined && <p className="file-panel-doc">{file.doc}</p>}
          {file.moduleId !== undefined && (
            <button
              type="button"
              className="link-btn"
              onClick={() => file.moduleId && navigate({ view: "module", ref: file.moduleId })}
            >
              Open module page →
            </button>
          )}

          <FileHistory path={path} />

          <h3>Exports ({file.exports.length})</h3>
          {file.exports.length === 0 && <p className="muted-note">No exported symbols</p>}
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
        </>
      )}
    </aside>
  );
}

/** Shared "recent changes" block — also embedded in the module wiki page. */
export function FileHistory({ path }: { path: string }) {
  const { data, error, isPending } = useFileHistory(path);

  return (
    <div data-testid="file-history">
      <h3>Recent changes</h3>
      {isPending && <p className="muted-note">Loading history…</p>}
      {error && <p className="muted-note">{error.message}</p>}
      {data && data.commits.length === 0 && (
        <p className="muted-note">No commits touch this file (not committed yet?).</p>
      )}
      {data?.commits.map((commit) => (
        <div className="history-row" key={commit.sha}>
          <span className="history-sha">{commit.shortSha}</span>
          <span className="history-date">{commit.date.slice(0, 10)}</span>
          <span className="history-subject" title={`${commit.author} — ${commit.subject}`}>
            {commit.subject}
          </span>
        </div>
      ))}
    </div>
  );
}
