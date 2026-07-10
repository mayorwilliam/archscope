import { useMeta } from "../api/queries";

function relativeTime(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** The same honesty header MCP responses carry, in pixels. */
export function StalenessBar({ connected }: { connected: boolean }) {
  const { data } = useMeta();
  if (!data) return <div className="staleness" />;

  const { staleness } = data;
  const sha = staleness.builtSha?.slice(0, 8) ?? "no git";
  const stale =
    staleness.builtSha !== null &&
    staleness.currentSha !== null &&
    staleness.builtSha !== staleness.currentSha;

  return (
    <div className="staleness" data-testid="staleness">
      <span
        className={`live-dot${connected ? " connected" : ""}`}
        title={connected ? "Live updates connected" : "Live updates disconnected"}
        data-testid="live-dot"
        data-connected={connected}
      />
      <span>
        graph@{sha}
        {staleness.branch !== null ? ` · ${staleness.branch}` : ""}
        {staleness.builtDirty ? " · dirty" : ""}
        {` · analyzed ${relativeTime(staleness.createdAt)}`}
      </span>
      {stale && (
        <span className="stale-warning" data-testid="stale-warning">
          HEAD moved — re-analyze
        </span>
      )}
    </div>
  );
}
