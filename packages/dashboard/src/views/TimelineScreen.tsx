import { useState } from "react";
import { useTimeline, useTimelinePoint } from "../api/queries";
import type { TimelinePoint } from "../api/types";
import { navigate } from "../router";

const WINDOWS = [30, 100, 300];

/**
 * The project's time axis: tags above the line as milestones, commits below
 * as dots, oldest → newest. Click a point for its snapshot summary (built
 * lazily server-side); pick two points to land on the linkable diff.
 */
export function TimelineScreen() {
  const [commits, setCommits] = useState(30);
  const { data: timeline, error, isPending } = useTimeline(commits);
  const [selected, setSelected] = useState<string | null>(null);
  const [compareBase, setCompareBase] = useState<string | null>(null);

  // Oldest on the left — a timeline reads left to right.
  const points = [...(timeline?.points ?? [])].reverse();

  const pick = (point: TimelinePoint) => {
    if (compareBase !== null && compareBase !== point.sha) {
      navigate({ view: "diff", base: compareBase.slice(0, 12), head: point.sha.slice(0, 12) });
      return;
    }
    setSelected((prev) => (prev === point.sha ? null : point.sha));
  };

  return (
    <div className="wiki-scroll">
      <div className="wiki-page timeline-page" data-testid="timeline-view">
        <header className="page-header">
          <div className="page-kicker">Timeline{timeline ? ` · ${timeline.branch}` : ""}</div>
          <h1>How the architecture moved</h1>
          <div className="page-meta">
            <span>
              {timeline?.totals.commits ?? 0} commits · {timeline?.totals.milestones ?? 0}{" "}
              milestones · {timeline?.totals.snapshotsBuilt ?? 0} snapshots built
            </span>
            <span className="window-picker">
              {WINDOWS.map((n) => (
                <button
                  type="button"
                  key={n}
                  className={`link-btn${n === commits ? " current" : ""}`}
                  onClick={() => setCommits(n)}
                >
                  {n}
                </button>
              ))}
            </span>
          </div>
        </header>

        {isPending && <div className="empty-note">Loading history…</div>}
        {error && <div className="empty-note">{error.message}</div>}
        {timeline && points.length === 0 && (
          <div className="empty-note">No git history — the timeline needs a repository.</div>
        )}

        {points.length > 0 && (
          <div className="card timeline-card">
            <div className="timeline-axis" data-testid="timeline-axis">
              {points.map((point) => (
                <button
                  type="button"
                  key={point.sha}
                  className={[
                    "timeline-point",
                    point.milestone ? "milestone" : "",
                    selected === point.sha ? "selected" : "",
                    compareBase === point.sha ? "compare-base" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-testid={point.milestone ? "timeline-milestone" : "timeline-point"}
                  title={`${point.shortSha} · ${point.date.slice(0, 10)} · ${point.subject}`}
                  onClick={() => pick(point)}
                >
                  {point.milestone && (
                    <span className="milestone-label">{point.tags.join(", ")}</span>
                  )}
                  <span className="dot" />
                  {point.snapshot.built && <span className="built-tick">✓</span>}
                </button>
              ))}
            </div>
            <div className="timeline-legend">
              <span>● commit</span>
              <span className="milestone-key">◆ tag</span>
              <span>✓ snapshot built</span>
              {compareBase !== null && (
                <span className="compare-hint" data-testid="timeline-compare-hint">
                  comparing from {compareBase.slice(0, 7)} — pick the second point
                  <button type="button" className="link-btn" onClick={() => setCompareBase(null)}>
                    cancel
                  </button>
                </span>
              )}
            </div>
          </div>
        )}

        {selected !== null && (
          <PointCard
            sha={selected}
            point={points.find((p) => p.sha === selected)}
            onCompareFrom={() => {
              setCompareBase(selected);
              setSelected(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function PointCard({
  sha,
  point,
  onCompareFrom,
}: {
  sha: string;
  point: TimelinePoint | undefined;
  onCompareFrom: () => void;
}) {
  const { data, error, isPending } = useTimelinePoint(sha);

  return (
    <div className="card point-card" data-testid="timeline-point-card">
      <h2>
        {point?.subject ?? sha.slice(0, 7)}
        {point?.tags.length ? (
          <span className="layer-badge tag-badge">{point.tags.join(", ")}</span>
        ) : null}
      </h2>
      <div className="page-meta">
        <span>{sha.slice(0, 12)}</span>
        {point && <span>{point.date.slice(0, 10)}</span>}
        {point?.author && <span>{point.author}</span>}
        <button
          type="button"
          className="link-btn"
          data-testid="timeline-compare-btn"
          onClick={onCompareFrom}
        >
          Compare from here →
        </button>
      </div>

      {isPending && (
        <p className="muted-note">
          Building snapshot for {sha.slice(0, 7)}… (first visit analyzes it)
        </p>
      )}
      {error && <p className="muted-note">{error.message}</p>}
      {data && (
        <>
          <div className="card-grid">
            {Object.entries(data.counts)
              .filter(([, value]) => value > 0)
              .map(([label, value]) => (
                <div className="stat-card" key={label}>
                  <div className="stat-value">{value.toLocaleString()}</div>
                  <div className="stat-label">{label}</div>
                </div>
              ))}
          </div>
          <ul className="dep-list">
            {data.modules.slice(0, 10).map((mod) => (
              <li key={mod.id}>
                <span className="dep-name">{mod.name}</span>
                <span className="weight">
                  {mod.files} files · {mod.loc.toLocaleString()} loc
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
