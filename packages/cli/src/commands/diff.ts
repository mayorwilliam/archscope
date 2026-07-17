import { diffGraphs, ensureSnapshot, gitRenames } from "@archscope/core";
import type { ArchDiff } from "@archscope/schema";
import { parseNodeId } from "@archscope/schema";

export async function runDiff(
  rootDir: string,
  baseRef: string,
  headRef: string,
  options: { json?: boolean },
): Promise<void> {
  const base = await ensureSnapshot(rootDir, baseRef);
  const head = await ensureSnapshot(rootDir, headRef);
  const renames = await gitRenames(rootDir, base.sha, head.sha);

  const diff = diffGraphs({
    base: base.graph,
    head: head.graph,
    renames,
    baseRef: { sha: base.sha, ref: baseRef },
    headRef: { sha: head.sha, ref: headRef },
  });

  if (options.json) {
    console.log(JSON.stringify(diff, null, 2));
    return;
  }
  printHuman(diff, baseRef, headRef);
}

// ---------------------------------------------------------------------------

function printHuman(diff: ArchDiff, baseRef: string, headRef: string): void {
  const mod = (id: string) => parseNodeId(id).rest;
  const lines: string[] = [];

  const m = diff.moduleChanges;
  if (m.added.length + m.removed.length + m.renamed.length > 0) {
    lines.push("Modules:");
    for (const id of m.added) lines.push(`  + ${mod(id)}`);
    for (const id of m.removed) lines.push(`  - ${mod(id)}`);
    for (const [oldId, newId] of m.renamed) lines.push(`  ~ ${mod(oldId)} → ${mod(newId)}`);
  }

  const d = diff.dependencyChanges;
  if (d.added.length + d.removed.length + d.weightDelta.length > 0) {
    lines.push("Dependencies (module → module):");
    for (const e of d.added) lines.push(`  + ${mod(e.from)} → ${mod(e.to)}`);
    for (const e of d.removed) lines.push(`  - ${mod(e.from)} → ${mod(e.to)}`);
    for (const w of d.weightDelta) {
      lines.push(`  Δ ${mod(w.edge.from)} → ${mod(w.edge.to)}: ${w.before} → ${w.after} imports`);
    }
  }

  const counts = { added: 0, removed: 0, moved: 0, changed: 0 };
  for (const change of diff.fileChanges) counts[change.change] += 1;
  if (diff.fileChanges.length > 0) {
    lines.push(
      `Files: ${counts.added} added, ${counts.removed} removed, ${counts.moved} moved` +
        " (--json for the full changelist)",
    );
  }

  console.log(`Architecture diff ${baseRef}..${headRef}`);
  console.log(lines.length > 0 ? lines.join("\n") : "No architectural changes.");
}
