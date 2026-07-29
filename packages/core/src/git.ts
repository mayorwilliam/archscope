import type { GitInfo } from "@archscope/schema";
import { execa } from "execa";

/** Best-effort git metadata; a repo without git is a valid analysis target. */
export async function gitInfo(rootDir: string): Promise<GitInfo | null> {
  try {
    const [sha, branch, status] = await Promise.all([
      git(rootDir, ["rev-parse", "HEAD"]),
      git(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
      // Our own output must never count as dirt: without the exclusion, a
      // repo that doesn't gitignore .archscope/ reads dirty forever after the
      // first analyze — and dirty repos never get snapshots.
      git(rootDir, ["status", "--porcelain", "--", ":(exclude).archscope"]),
    ]);
    return { sha, branch, dirty: status.length > 0 };
  } catch {
    return null;
  }
}

export interface GitRef {
  name: string;
  /** For annotated tags this is the PEELED commit sha, not the tag object. */
  sha: string;
  kind: "branch" | "tag";
  /** Creator date (ISO strict) — what makes refs sortable on a time axis. */
  date?: string;
}

/** Local branches and tags — the candidates for the dashboard's diff pickers. */
export async function gitRefs(rootDir: string): Promise<GitRef[]> {
  try {
    const out = await git(rootDir, [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(*objectname)%09%(creatordate:iso-strict)",
      "refs/heads",
      "refs/tags",
    ]);
    const refs: GitRef[] = [];
    for (const rawLine of out.split("\n")) {
      const [refname, sha, peeled, date] = rawLine.trim().split("\t");
      if (!refname || !sha) continue;
      refs.push({
        name: refname.replace(/^refs\/(heads|tags)\//, ""),
        sha: peeled || sha,
        kind: refname.startsWith("refs/tags/") ? "tag" : "branch",
        ...(date ? { date } : {}),
      });
    }
    return refs;
  } catch {
    return [];
  }
}

/**
 * The unified patch ONE commit applied to ONE file (rename-aware via
 * --follow). Raw `git` output, served for display — never a graph fact.
 */
export async function gitFileDiff(rootDir: string, sha: string, path: string): Promise<string> {
  try {
    return await git(rootDir, ["log", "--follow", "--format=", "-p", "-n", "1", sha, "--", path]);
  } catch {
    return "";
  }
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  /** Author date, ISO strict. */
  date: string;
  author: string;
  subject: string;
  /** Tag names decorating this commit. */
  tags: string[];
}

/**
 * Recent history of a ref, one call: sha, author, date, subject and tag
 * decorations per commit. Fields are separated by \x1f (never appears in
 * subjects); lines are trimmed per line — the Windows CRLF lesson.
 *
 * `path` scopes the log to one file (with --follow, so history survives
 * renames). Git metadata is live state — never persisted into the graph.
 */
export async function gitLog(
  rootDir: string,
  options: { limit?: number; ref?: string; path?: string } = {},
): Promise<GitCommit[]> {
  const { limit = 50, ref = "HEAD", path } = options;
  try {
    const out = await git(rootDir, [
      "log",
      "--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%D",
      "-n",
      String(limit),
      ...(path !== undefined ? ["--follow"] : []),
      ref,
      "--",
      ...(path !== undefined ? [path] : []),
    ]);
    const commits: GitCommit[] = [];
    for (const rawLine of out.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      const [sha, shortSha, date, author, subject, decorations] = line.split("\x1f");
      if (!sha || !shortSha || !date) continue;
      const tags = (decorations ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d.startsWith("tag: "))
        .map((d) => d.slice("tag: ".length));
      commits.push({ sha, shortSha, date, author: author ?? "", subject: subject ?? "", tags });
    }
    return commits;
  } catch {
    return [];
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout.trim();
}
