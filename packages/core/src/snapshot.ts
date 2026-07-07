import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArchGraph } from "@archmap/schema";
import { execa } from "execa";
import { analyze } from "./pipeline.js";
import { Store } from "./store/store.js";

/**
 * Snapshots on demand: any commit-ish resolves to a graph. If the snapshot
 * for that sha doesn't exist yet, the ref is materialized in a temporary
 * `git worktree` and analyzed there — pointed at the MAIN repo's facts cache,
 * so a historical analysis only pays for the files that actually differ.
 */

export interface EnsureSnapshotResult {
  sha: string;
  graph: ArchGraph;
  /** false when the snapshot already existed. */
  created: boolean;
}

export async function resolveRef(rootDir: string, ref: string): Promise<string> {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: rootDir,
    });
    return stdout.trim();
  } catch {
    throw new Error(`Not a commit: '${ref}'`);
  }
}

export async function ensureSnapshot(
  rootDir: string,
  ref: string,
  options: { toolVersion?: string } = {},
): Promise<EnsureSnapshotResult> {
  const sha = await resolveRef(rootDir, ref);
  const store = new Store(rootDir);

  const existing = store.loadSnapshot(sha);
  if (existing) return { sha, graph: existing, created: false };

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "archmap-worktree-"));
  try {
    await execa("git", ["worktree", "add", "--detach", worktree, sha], { cwd: rootDir });
    const { graph } = await analyze({
      rootDir: worktree,
      cache: { dir: store.cacheDir },
      // Module identity belongs to the repo, not to the throwaway directory.
      rootName: path.basename(path.resolve(rootDir)),
      ...(options.toolVersion !== undefined ? { toolVersion: options.toolVersion } : {}),
    });
    // The snapshot describes the repo at that sha, not the throwaway worktree.
    graph.meta.root = path.resolve(rootDir);
    store.saveSnapshot(graph);
    return { sha, graph, created: true };
  } finally {
    await execa("git", ["worktree", "remove", "--force", worktree], { cwd: rootDir }).catch(
      () => {},
    );
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}
