import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFileContext, useFileDiff, useFileHistory, useSource } from "../api/queries";
import type { GitCommit } from "../api/types";
import { parseUnifiedDiff } from "../lib/diff";
import { escapeHtml, grammarFor, highlightLines } from "../lib/highlight";
import { navigate } from "../router";

/**
 * Click a file → THIS is the focus now: a centered modal with the real code
 * (highlighted, line-numbered), in-file search with match navigation, the
 * file's exports as a jump-to-line outline, and its recent git history.
 */
export function FileModal({ path, onClose }: { path: string; onClose: () => void }) {
  const { data: file, error, isPending } = useFileContext(path);
  // loc is known once the context arrives; ask for the whole file.
  const end = file !== undefined ? Math.max(file.loc, 1) : null;
  const { data: sourceData, isPending: sourcePending } = useSource(
    end !== null ? path : null,
    1,
    end ?? 1,
  );

  const [query, setQuery] = useState("");
  const [currentMatch, setCurrentMatch] = useState(0);
  // A picked commit switches the viewer to that commit's patch for this file.
  const [viewingCommit, setViewingCommit] = useState<GitCommit | null>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lines = useMemo(() => sourceData?.lines ?? [], [sourceData]);
  const highlighted = useMemo(
    () => highlightLines(lines, grammarFor(file?.lang, path)),
    [lines, file?.lang, path],
  );

  // Line numbers (1-based) containing the query, in order.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return [];
    const hits: number[] = [];
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(q)) hits.push(i + 1);
    });
    return hits;
  }, [lines, query]);

  // Derived, never stale: if the match list shrank under the cursor, clamp.
  const safeMatch = currentMatch < matches.length ? currentMatch : 0;

  const jumpToLine = useCallback((line: number) => {
    codeRef.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: "center" });
  }, []);

  useEffect(() => {
    const target = matches[safeMatch];
    if (target !== undefined) jumpToLine(target);
  }, [matches, safeMatch, jumpToLine]);

  const step = (delta: number) => {
    if (matches.length === 0) return;
    setCurrentMatch((safeMatch + delta + matches.length) % matches.length);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: standard backdrop click-to-close; keyboard users close with Escape (handled above)
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is the keyboard path
    <div className="modal-backdrop" data-testid="file-modal-backdrop" onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only */}
      <div
        className="file-modal"
        role="dialog"
        aria-modal="true"
        aria-label={path}
        data-testid="file-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="file-modal-head">
          <div className="file-modal-title">
            <h2>{path}</h2>
            {file && (
              <span className="metrics-row">
                <span>{file.loc} loc</span>
                <span>←{file.fanIn}</span>
                <span>→{file.fanOut}</span>
                {file.moduleId !== undefined && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() =>
                      file.moduleId && navigate({ view: "module", ref: file.moduleId })
                    }
                  >
                    {file.moduleId.replace(/^mod:/, "")} →
                  </button>
                )}
              </span>
            )}
          </div>
          <div className="file-search">
            {viewingCommit === null && (
              <>
                <input
                  ref={searchRef}
                  value={query}
                  placeholder="Find in file…"
                  data-testid="file-search"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setCurrentMatch(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") step(event.shiftKey ? -1 : 1);
                  }}
                />
                {query.trim() !== "" && (
                  <span className="match-count" data-testid="file-search-count">
                    {matches.length === 0 ? "0" : `${safeMatch + 1}/${matches.length}`}
                  </span>
                )}
                <button
                  type="button"
                  className="link-btn"
                  title="Previous (Shift+Enter)"
                  onClick={() => step(-1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="link-btn"
                  title="Next (Enter)"
                  onClick={() => step(1)}
                >
                  ↓
                </button>
              </>
            )}
            {viewingCommit !== null && (
              <button
                type="button"
                className="link-btn"
                data-testid="diff-back"
                onClick={() => setViewingCommit(null)}
              >
                ← Back to code
              </button>
            )}
          </div>
          <button
            type="button"
            className="link-btn modal-close"
            data-testid="file-modal-close"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="file-modal-body">
          <aside className="file-outline">
            {file && file.doc !== undefined && <p className="file-panel-doc">{file.doc}</p>}
            {file && file.exports.length > 0 && (
              <>
                <h3>Exports ({file.exports.length})</h3>
                {file.exports.map((exp) => (
                  <button
                    type="button"
                    className="outline-item"
                    key={exp.name}
                    data-testid="outline-export"
                    disabled={exp.startLine === undefined}
                    onClick={() => exp.startLine !== undefined && jumpToLine(exp.startLine)}
                    title={exp.doc}
                  >
                    <span className="export-name">{exp.name}</span>
                    <span className="kind-chip">{exp.symbolKind}</span>
                    {exp.startLine !== undefined && <span className="lines">L{exp.startLine}</span>}
                  </button>
                ))}
              </>
            )}
            <FileHistory
              path={path}
              activeSha={viewingCommit?.sha}
              onPickCommit={(commit) =>
                setViewingCommit((prev) => (prev?.sha === commit.sha ? null : commit))
              }
            />
          </aside>

          {viewingCommit !== null ? (
            <CommitDiffView path={path} commit={viewingCommit} />
          ) : (
            <div className="code-view" ref={codeRef} data-testid="code-view">
              {(isPending || sourcePending) && <p className="muted-note">Loading source…</p>}
              {error && <p className="muted-note">{error.message}</p>}
              {lines.map((line, i) => {
                const lineNo = i + 1;
                const isHit = matches.includes(lineNo);
                const isCurrent = matches[safeMatch] === lineNo;
                return (
                  <div
                    className={`code-line${isHit ? " hit" : ""}${isCurrent ? " current" : ""}`}
                    data-line={lineNo}
                    key={lineNo}
                  >
                    <span className="line-no">{lineNo}</span>
                    <span
                      className="line-content"
                      // Safe by construction: hljs escapes source; search mode
                      // renders through escapeHtml + <mark> only.
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: see above
                      dangerouslySetInnerHTML={{
                        __html:
                          query.trim() === ""
                            ? (highlighted[i] ?? escapeHtml(line))
                            : markMatches(line, query.trim()),
                      }}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * What ONE commit did to this file: unified diff with dual line numbers —
 * red is how it was before, green is what the commit made it.
 */
function CommitDiffView({ path, commit }: { path: string; commit: GitCommit }) {
  const { data, error, isPending } = useFileDiff(path, commit.sha);
  // Keys are position-derived here (a patch has no natural per-line identity)
  // and the list is immutable per (sha, path), so they are stable.
  const diffLines = useMemo(
    () =>
      parseUnifiedDiff(data?.patch ?? "").map((line, position) => ({
        ...line,
        key: `${position}:${line.kind}`,
      })),
    [data],
  );

  return (
    <div className="code-view diff-mode" data-testid="commit-diff">
      <div className="diff-head">
        <span className="history-sha">{commit.shortSha}</span>
        <span className="history-date">{commit.date.slice(0, 10)}</span>
        <span className="diff-subject">{commit.subject}</span>
        {commit.author !== "" && <span className="history-date">{commit.author}</span>}
      </div>
      {isPending && <p className="muted-note">Loading diff…</p>}
      {error && <p className="muted-note">{error.message}</p>}
      {data && diffLines.length === 0 && (
        <p className="muted-note">This commit has no changes for this file.</p>
      )}
      {diffLines.map((line) => (
        <div className={`diff-line ${line.kind}`} key={line.key}>
          <span className="line-no old">{line.oldNo ?? ""}</span>
          <span className="line-no new">{line.newNo ?? ""}</span>
          <span className="diff-sign">
            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}
          </span>
          <span className="line-content">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Search mode: escaped plain text with <mark> around case-insensitive hits. */
function markMatches(line: string, query: string): string {
  const lower = line.toLowerCase();
  const q = query.toLowerCase();
  let out = "";
  let from = 0;
  for (;;) {
    const at = lower.indexOf(q, from);
    if (at === -1) break;
    out += escapeHtml(line.slice(from, at));
    out += `<mark>${escapeHtml(line.slice(at, at + query.length))}</mark>`;
    from = at + query.length;
  }
  return out + escapeHtml(line.slice(from));
}

/**
 * Shared "recent changes" block — also embedded in the module wiki page.
 * With `onPickCommit`, rows become buttons that open that commit's diff.
 */
export function FileHistory({
  path,
  activeSha,
  onPickCommit,
}: {
  path: string;
  activeSha?: string | undefined;
  onPickCommit?: (commit: GitCommit) => void;
}) {
  const { data, error, isPending } = useFileHistory(path);

  const row = (commit: GitCommit) => (
    <>
      <span className="history-sha">{commit.shortSha}</span>
      <span className="history-date">{commit.date.slice(0, 10)}</span>
      <span className="history-subject" title={`${commit.author} — ${commit.subject}`}>
        {commit.subject}
      </span>
    </>
  );

  return (
    <div data-testid="file-history">
      <h3>Recent changes</h3>
      {isPending && <p className="muted-note">Loading history…</p>}
      {error && <p className="muted-note">{error.message}</p>}
      {data && data.commits.length === 0 && (
        <p className="muted-note">No commits touch this file (not committed yet?).</p>
      )}
      {data?.commits.map((commit) =>
        onPickCommit !== undefined ? (
          <button
            type="button"
            className={`history-row clickable${activeSha === commit.sha ? " active" : ""}`}
            key={commit.sha}
            data-testid="history-commit"
            onClick={() => onPickCommit(commit)}
          >
            {row(commit)}
          </button>
        ) : (
          <div className="history-row" key={commit.sha}>
            {row(commit)}
          </div>
        ),
      )}
    </div>
  );
}
