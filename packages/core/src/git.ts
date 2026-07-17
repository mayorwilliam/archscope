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
  sha: string;
  kind: "branch" | "tag";
}

/** Local branches and tags — the candidates for the dashboard's diff pickers. */
export async function gitRefs(rootDir: string): Promise<GitRef[]> {
  try {
    const out = await git(rootDir, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/tags",
    ]);
    const refs: GitRef[] = [];
    for (const line of out.split("\n")) {
      const [refname, sha] = line.split(" ");
      if (!refname || !sha) continue;
      refs.push({
        name: refname.replace(/^refs\/(heads|tags)\//, ""),
        sha,
        kind: refname.startsWith("refs/tags/") ? "tag" : "branch",
      });
    }
    return refs;
  } catch {
    return [];
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout.trim();
}
