import type { GitInfo } from "@archmap/schema";
import { execa } from "execa";

/** Best-effort git metadata; a repo without git is a valid analysis target. */
export async function gitInfo(rootDir: string): Promise<GitInfo | null> {
  try {
    const [sha, branch, status] = await Promise.all([
      git(rootDir, ["rev-parse", "HEAD"]),
      git(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"]),
      git(rootDir, ["status", "--porcelain"]),
    ]);
    return { sha, branch, dirty: status.length > 0 };
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout.trim();
}
