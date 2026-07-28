/**
 * Doc-comment normalization: raw JSDoc / Python docstring text → one summary
 * paragraph. Pure string functions, table-tested — every weird comment shape
 * that shows up in the wild becomes a new test row, never an inline fix.
 */

/** Hard cap for a symbol/file summary; the full text stays reachable via span. */
export const DOC_SUMMARY_MAX = 1000;

/**
 * `/** ... *​/` → first paragraph, tags stripped. Returns undefined when the
 * comment has no prose (e.g. only `@param` tags).
 */
export function normalizeJsDoc(raw: string): string | undefined {
  let text = raw.trim();
  if (text.startsWith("/**")) text = text.slice(3);
  else if (text.startsWith("/*")) text = text.slice(2);
  if (text.endsWith("*/")) text = text.slice(0, -2);

  const lines = text.split("\n").map((line) => line.replace(/^\s*\*\s?/, "").trimEnd());

  const kept: string[] = [];
  for (let line of lines) {
    // `@fileoverview`/`@module` label the comment, the prose follows inline.
    const labeled = /^@(fileoverview|module|file)\b\s*(.*)$/.exec(line.trim());
    if (labeled) line = labeled[2] as string;
    // Any other tag ends the summary — @param/@returns are API docs, not prose.
    if (/^\s*@\w/.test(line)) break;
    kept.push(line);
  }

  return firstParagraph(kept);
}

/** Python docstring body (quotes already stripped by the caller) → first paragraph. */
export function normalizePyDoc(body: string): string | undefined {
  const lines = dedent(body.replace(/\r\n/g, "\n").split("\n"));
  return firstParagraph(lines);
}

/** Strip string prefixes and matching quotes from a Python string literal. */
export function pyStringBody(literal: string): string {
  const text = literal.replace(/^[rRbBuUfF]{0,2}/, "");
  for (const quote of ['"""', "'''", '"', "'"]) {
    if (text.startsWith(quote) && text.endsWith(quote) && text.length >= quote.length * 2) {
      return text.slice(quote.length, -quote.length);
    }
  }
  return text;
}

// ---------------------------------------------------------------------------

function firstParagraph(lines: string[]): string | undefined {
  const start = lines.findIndex((l) => l.trim() !== "");
  if (start === -1) return undefined;
  const paragraph: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line === "") break;
    paragraph.push(line);
  }
  const joined = paragraph.join(" ").replace(/\s+/g, " ").trim();
  if (joined === "") return undefined;
  return joined.length > DOC_SUMMARY_MAX ? `${joined.slice(0, DOC_SUMMARY_MAX - 1)}…` : joined;
}

function dedent(lines: string[]): string[] {
  let indent = Number.POSITIVE_INFINITY;
  // First line of a docstring sits right after the quotes — never indented.
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const m = /^\s*/.exec(line);
    indent = Math.min(indent, (m?.[0] ?? "").length);
  }
  if (!Number.isFinite(indent) || indent === 0) return lines;
  return lines.map((line, i) => (i === 0 ? line : line.slice(indent)));
}
