import type { ArchDiff } from "@archscope/schema";
import { diffGraphs } from "./diff/engine.js";
import { gitRenames } from "./diff/rename.js";
import { type GitCommit, gitInfo, gitLog, gitRefs } from "./git.js";
import { ensureSnapshot, resolveRef } from "./snapshot.js";
import { Store } from "./store/store.js";

/**
 * The project's time axis: tags as milestones, recent commits as detail.
 *
 * Determinism stance — git metadata (log, refs, dates) is LIVE repo state
 * queried per request, exactly like /api/refs and staleness today. It is
 * never persisted into graph.json or snapshots; snapshots stay byte-stable
 * per sha, only this response is volatile.
 *
 * Nothing here builds snapshots except buildHistory (explicitly): the
 * timeline REPORTS which points are materialized; a point's snapshot is
 * built lazily on first use (`ensureSnapshot` is idempotent, sha-addressed
 * and cached forever).
 */

export interface TimelinePoint {
  sha: string;
  shortSha: string;
  /** ISO date. Milestone-only points (tags outside the window) carry the tag date. */
  date: string;
  author: string;
  subject: string;
  tags: string[];
  milestone: boolean;
  snapshot: {
    built: boolean;
    /** Node counts, loaded only for already-built snapshots (capped). */
    counts?: Record<string, number>;
  };
}

export interface TimelineView {
  branch: string | null;
  head: string | null;
  /** Newest first. */
  points: TimelinePoint[];
  totals: { commits: number; milestones: number; snapshotsBuilt: number };
}

/** How many built snapshots get their counts inlined per response. */
const MAX_COUNTS_LOADED = 20;

export async function buildTimeline(
  rootDir: string,
  options: { commits?: number } = {},
): Promise<TimelineView> {
  const { commits = 30 } = options;
  const [log, refs, info] = await Promise.all([
    gitLog(rootDir, { limit: commits }),
    gitRefs(rootDir),
    gitInfo(rootDir),
  ]);
  const store = new Store(rootDir);
  const built = new Set(store.listSnapshots());

  // The log's own order is authoritative (topological, newest first) — a date
  // re-sort would scramble same-second commits. Tags whose commit fell outside
  // the window are INSERTED by date; in practice they are older and append.
  const points: TimelinePoint[] = log.map((commit) => toPoint(commit, built));
  const inWindow = new Set(points.map((p) => p.sha));
  for (const ref of refs) {
    if (ref.kind !== "tag" || inWindow.has(ref.sha) || ref.date === undefined) continue;
    const tagDate = ref.date;
    const point: TimelinePoint = {
      sha: ref.sha,
      shortSha: ref.sha.slice(0, 7),
      date: tagDate,
      author: "",
      subject: ref.name,
      tags: [ref.name],
      milestone: true,
      snapshot: { built: built.has(ref.sha) },
    };
    const insertAt = points.findIndex((p) => p.date < tagDate);
    if (insertAt === -1) points.push(point);
    else points.splice(insertAt, 0, point);
    inWindow.add(ref.sha);
  }

  let loaded = 0;
  for (const point of points) {
    if (!point.snapshot.built || loaded >= MAX_COUNTS_LOADED) continue;
    const graph = store.loadSnapshot(point.sha);
    if (graph) {
      point.snapshot.counts = graph.meta.counts;
      loaded += 1;
    }
  }

  return {
    branch: info?.branch ?? null,
    head: info?.sha ?? null,
    points,
    totals: {
      commits: log.length,
      milestones: points.filter((p) => p.milestone).length,
      snapshotsBuilt: points.filter((p) => p.snapshot.built).length,
    },
  };
}

function toPoint(commit: GitCommit, built: Set<string>): TimelinePoint {
  return {
    sha: commit.sha,
    shortSha: commit.shortSha,
    date: commit.date,
    author: commit.author,
    subject: commit.subject,
    tags: commit.tags,
    milestone: commit.tags.length > 0,
    snapshot: { built: built.has(commit.sha) },
  };
}

// ---------------------------------------------------------------------------
// History: a range folded into pairwise diffs over milestone waypoints
// ---------------------------------------------------------------------------

export interface HistoryPoint {
  sha: string;
  shortSha: string;
  label: string;
  date?: string;
}

export interface HistoryInterval {
  base: HistoryPoint;
  head: HistoryPoint;
  diff: ArchDiff;
}

export interface HistoryView {
  points: HistoryPoint[];
  intervals: HistoryInterval[];
}

/**
 * from..to as a SERIES: tag milestones inside the range become waypoints
 * (evenly sampled down to maxPoints), each waypoint is materialized via
 * ensureSnapshot, and adjacent pairs fold through the rename-aware diff.
 * First call for old refs builds snapshots — seconds each, cached forever.
 *
 * Milestones are selected by ANCESTRY (`git log from..to` decorations), not
 * by date: same-second commits and rebased histories would break any
 * date-ordering assumption.
 */
export async function buildHistory(
  rootDir: string,
  options: { from: string; to?: string; maxPoints?: number },
): Promise<HistoryView> {
  const { from, to = "HEAD", maxPoints = 5 } = options;
  const fromSha = await resolveRef(rootDir, from);
  const toSha = await resolveRef(rootDir, to);
  const [fromDate, toDate] = await Promise.all([
    commitDate(rootDir, fromSha),
    commitDate(rootDir, toSha),
  ]);

  const waypoints: HistoryPoint[] = [
    { sha: fromSha, shortSha: fromSha.slice(0, 7), label: from, date: fromDate },
  ];

  const rangeLog = await gitLog(rootDir, { limit: 1000, ref: `${fromSha}..${toSha}` });
  const tagged = rangeLog
    .filter((commit) => commit.tags.length > 0 && commit.sha !== toSha)
    .reverse(); // log is newest-first; waypoints walk oldest → newest
  for (const commit of sampleEvenly(tagged, Math.max(0, maxPoints - 2))) {
    waypoints.push({
      sha: commit.sha,
      shortSha: commit.shortSha,
      label: commit.tags.join(", "),
      date: commit.date,
    });
  }

  if (toSha !== fromSha) {
    waypoints.push({ sha: toSha, shortSha: toSha.slice(0, 7), label: to, date: toDate });
  }

  const intervals: HistoryInterval[] = [];
  for (let i = 0; i + 1 < waypoints.length; i++) {
    const base = waypoints[i] as HistoryPoint;
    const head = waypoints[i + 1] as HistoryPoint;
    const [baseSnap, headSnap] = [
      await ensureSnapshot(rootDir, base.sha),
      await ensureSnapshot(rootDir, head.sha),
    ];
    const renames = await gitRenames(rootDir, base.sha, head.sha);
    intervals.push({
      base,
      head,
      diff: diffGraphs({
        base: baseSnap.graph,
        head: headSnap.graph,
        renames,
        baseRef: { sha: base.sha, ref: base.label },
        headRef: { sha: head.sha, ref: head.label },
      }),
    });
  }

  return { points: waypoints, intervals };
}

async function commitDate(rootDir: string, sha: string): Promise<string> {
  const log = await gitLog(rootDir, { limit: 1, ref: sha });
  return log[0]?.date ?? "";
}

/** Deterministic even sampling: first/last biased spread over the list. */
function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  if (max <= 0) return [];
  const picked: T[] = [];
  for (let i = 0; i < max; i++) {
    const index = Math.round((i * (items.length - 1)) / Math.max(1, max - 1));
    picked.push(items[index] as T);
  }
  return [...new Set(picked)];
}
