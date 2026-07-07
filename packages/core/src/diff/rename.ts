import { execa } from "execa";

/**
 * File renames between two commits, straight from git's own rename detection
 * (-M90: ≥90% similarity). This runs BEFORE graph comparison — with path-based
 * IDs, remapping renamed paths first is what turns a rename into a `moved`
 * entry instead of a spurious add+remove pair.
 */
export async function gitRenames(
  rootDir: string,
  baseSha: string,
  headSha: string,
): Promise<Map<string, string>> {
  const { stdout } = await execa(
    "git",
    ["diff", "--name-status", "-M90", "--diff-filter=R", "-z", baseSha, headSha],
    { cwd: rootDir },
  );
  // -z format: R<score> NUL <old> NUL <new> NUL ...
  const fields = stdout.split("\0");
  const renames = new Map<string, string>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const status = fields[i];
    const oldPath = fields[i + 1];
    const newPath = fields[i + 2];
    if (status?.startsWith("R") && oldPath && newPath) renames.set(oldPath, newPath);
  }
  return renames;
}
