import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffGraphs } from "../src/diff/engine.js";
import { gitRenames } from "../src/diff/rename.js";
import { ensureSnapshot } from "../src/snapshot.js";
import { Store } from "../src/store/store.js";

/**
 * The Phase 2 acceptance scenario, on a scripted git history:
 *
 *   C1: app → legacy, app → utils
 *   C2: + payments module; app drops legacy; utils/format.ts → fmt.ts (git mv)
 *   C3: payments/ → billing/ (whole-module git mv)
 *
 * C1..C2 must report: module added, dependency removed, file MOVED (never
 * add+remove). C2..C3 must report the module rename and keep its
 * dependencies stable under the new name.
 */

describe("architecture diff on scripted git history", () => {
  let root: string;
  let sha1: string;
  let sha2: string;
  let sha3: string;

  const git = (...args: string[]) => execa("git", args, { cwd: root });

  async function commitAll(message: string): Promise<string> {
    await git("add", "-A");
    await git("commit", "-m", message);
    const { stdout } = await git("rev-parse", "HEAD");
    return stdout.trim();
  }

  function write(relPath: string, content: string): void {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "archmap-diff-"));
    await git("init", "-b", "main");
    await git("config", "user.email", "test@archmap.local");
    await git("config", "user.name", "archmap-test");

    // C1
    write(
      "app/index.ts",
      'import { old } from "../legacy/old.js";\nimport { fmt } from "../utils/format.js";\nexport const run = () => fmt(old());\n',
    );
    write("legacy/old.ts", 'export function old(): string {\n  return "legacy";\n}\n');
    write("utils/format.ts", "export function fmt(s: string): string {\n  return s.trim();\n}\n");
    // Root-level file: its module is named after the REPO, and must stay
    // stable even though each snapshot is analyzed in a random-named worktree.
    write("root-config.ts", "export const DEBUG = false;\n");
    sha1 = await commitAll("c1: app depends on legacy and utils");

    // C2: new payments module; app drops legacy; utils/format.ts renamed
    await git("mv", "utils/format.ts", "utils/fmt.ts");
    write(
      "app/index.ts",
      'import { fmt } from "../utils/fmt.js";\nexport const run = () => fmt("app");\n',
    );
    write(
      "payments/charge.ts",
      'import { fmt } from "../utils/fmt.js";\nexport function charge(amount: number): string {\n  return fmt("charged " + String(amount));\n}\n',
    );
    sha2 = await commitAll("c2: payments added, legacy dropped, format renamed");

    // C3: whole-module rename payments/ → billing/
    await git("mv", "payments", "billing");
    sha3 = await commitAll("c3: payments renamed to billing");
  }, 30000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function diffBetween(baseSha: string, headSha: string) {
    const base = await ensureSnapshot(root, baseSha);
    const head = await ensureSnapshot(root, headSha);
    const renames = await gitRenames(root, baseSha, headSha);
    return diffGraphs({
      base: base.graph,
      head: head.graph,
      renames,
      baseRef: { sha: baseSha },
      headRef: { sha: headSha },
    });
  }

  it("C1..C2: module added, dependency removed, rename is a move", async () => {
    const diff = await diffBetween(sha1, sha2);

    expect(diff.moduleChanges.added).toEqual(["mod:payments"]);
    expect(diff.moduleChanges.removed).toEqual([]);
    expect(diff.moduleChanges.renamed).toEqual([]);

    expect(diff.dependencyChanges.removed).toEqual([
      { kind: "depends_on", from: "mod:app", to: "mod:legacy" },
    ]);
    expect(diff.dependencyChanges.added).toEqual([
      { kind: "depends_on", from: "mod:payments", to: "mod:utils" },
    ]);

    // THE rename guarantee: one moved entry, no add+remove pair for it.
    const moved = diff.fileChanges.filter((c) => c.change === "moved");
    expect(moved).toEqual([
      { id: "file:utils/fmt.ts", change: "moved", previousId: "file:utils/format.ts" },
    ]);
    const ids = (change: string) =>
      diff.fileChanges.filter((c) => c.change === change).map((c) => c.id);
    expect(ids("added")).toEqual(["file:payments/charge.ts"]);
    expect(ids("removed")).toEqual([]);
  });

  it("C2..C3: whole-module rename, dependencies stable under the new name", async () => {
    const diff = await diffBetween(sha2, sha3);

    expect(diff.moduleChanges.renamed).toEqual([["mod:payments", "mod:billing"]]);
    expect(diff.moduleChanges.added).toEqual([]);
    expect(diff.moduleChanges.removed).toEqual([]);

    // payments→utils survives as billing→utils: NOT a removed+added pair.
    expect(diff.dependencyChanges.added).toEqual([]);
    expect(diff.dependencyChanges.removed).toEqual([]);
    expect(diff.dependencyChanges.weightDelta).toEqual([]);

    const moved = diff.fileChanges.filter((c) => c.change === "moved");
    expect(moved).toEqual([
      {
        id: "file:billing/charge.ts",
        change: "moved",
        previousId: "file:payments/charge.ts",
      },
    ]);
  });

  it("identical refs diff to nothing", async () => {
    const diff = await diffBetween(sha2, sha2);
    expect(diff.moduleChanges).toEqual({ added: [], removed: [], renamed: [] });
    expect(diff.dependencyChanges).toEqual({ added: [], removed: [], weightDelta: [] });
    expect(diff.fileChanges).toEqual([]);
  });

  it("snapshots are reused on the second request", async () => {
    const store = new Store(root);
    expect(store.hasSnapshot(sha1)).toBe(true);
    const again = await ensureSnapshot(root, sha1);
    expect(again.created).toBe(false);
  });
});
