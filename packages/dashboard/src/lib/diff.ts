/**
 * Minimal unified-diff parser for the code viewer's per-commit view. Pure
 * presentation parsing of git's display format (like markdown rendering) —
 * it derives no structural facts. Old/new line numbers come from the @@
 * hunk headers so removed lines can show where they USED to live.
 */

export interface DiffLine {
  kind: "meta" | "hunk" | "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const META_PREFIXES = [
  "diff ",
  "index ",
  "+++",
  "---",
  "new file",
  "deleted file",
  "similarity",
  "dissimilarity",
  "rename ",
  "copy ",
  "old mode",
  "new mode",
  "Binary files",
  "\\",
];

export function parseUnifiedDiff(patch: string): DiffLine[] {
  if (patch.trim() === "") return [];
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.replace(/\n$/, "").split("\n")) {
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (META_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
      out.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    } else {
      out.push({
        kind: "ctx",
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
        oldNo: oldNo++,
        newNo: newNo++,
      });
    }
  }
  return out;
}
