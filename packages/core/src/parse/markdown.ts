import type { DocHeading } from "@archscope/schema";

/**
 * Markdown doc extraction — no tree-sitter, no markdown AST: title and
 * headings by line regex, content normalized to LF and deterministically
 * truncated. Same bytes in, same DocFacts out, always.
 */

export interface DocFacts {
  /** Repo-relative, forward slashes. */
  path: string;
  title: string;
  headings: DocHeading[];
  content: string;
  truncated: boolean;
}

/** Cap per doc so a giant CHANGELOG cannot bloat the graph. Byte-stable cut. */
export const DOC_MAX_BYTES = 131072;

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function extractDocFacts(relPath: string, source: string): DocFacts {
  const normalized = source.replace(/\r\n/g, "\n");

  let content = normalized;
  let truncated = false;
  if (Buffer.byteLength(content, "utf8") > DOC_MAX_BYTES) {
    content = truncateUtf8(content, DOC_MAX_BYTES);
    content += "\n\n… (truncated by archscope)\n";
    truncated = true;
  }

  const headings: DocHeading[] = [];
  let inFence = false;
  for (const line of content.split("\n")) {
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(line);
    if (m) headings.push({ depth: (m[1] as string).length, text: m[2] as string });
  }

  const first = headings.find((h) => h.depth === 1) ?? headings[0];
  const fileName = relPath.split("/").pop() ?? relPath;
  const title = first?.text ?? fileName;

  return { path: relPath, title, headings, content, truncated };
}

/** Cut at a UTF-8 byte budget without splitting a code point, then trim to the last full line. */
function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off continuation bytes (0b10xxxxxx) so we never split a code point.
  while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end--;
  const cut = buf.subarray(0, end).toString("utf8");
  const lastNewline = cut.lastIndexOf("\n");
  return lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
}
