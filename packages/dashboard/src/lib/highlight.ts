import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";

/**
 * Syntax highlighting for the code viewer: hljs core + only the grammars the
 * graph can produce, bundled locally (no CDN — local-first). Output is split
 * back into ONE HTML string per line so the viewer can address, number and
 * scroll to individual lines.
 */

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);

const LANG_BY_GRAPH_LANG: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
};

export function grammarFor(lang: string | undefined, path: string): string | null {
  if (lang !== undefined && LANG_BY_GRAPH_LANG[lang]) return LANG_BY_GRAPH_LANG[lang] as string;
  if (/\.(md|markdown)$/i.test(path)) return "markdown";
  if (/\.json$/i.test(path)) return "json";
  return null; // prisma & friends render plain
}

/** Escape for the plain-text fallback and the search-mode renderer. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * hljs emits one HTML blob whose <span>s can cross newlines (block comments,
 * template strings). Splitting naively would produce unbalanced HTML — this
 * closes every open span at each newline and reopens it on the next line.
 */
export function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = [];
  let current = "";
  const re = /(<span[^>]*>)|(<\/span>)|(\n)/g;
  let last = 0;
  let match = re.exec(html);
  while (match !== null) {
    current += html.slice(last, match.index);
    last = re.lastIndex;
    if (match[1] !== undefined) {
      stack.push(match[1]);
      current += match[1];
    } else if (match[2] !== undefined) {
      stack.pop();
      current += match[2];
    } else {
      current += "</span>".repeat(stack.length);
      lines.push(current);
      current = stack.join("");
    }
    match = re.exec(html);
  }
  current += html.slice(last);
  lines.push(current);
  return lines;
}

/** Source lines → per-line highlighted HTML (falls back to escaped plain text). */
export function highlightLines(lines: string[], grammar: string | null): string[] {
  if (grammar === null) return lines.map(escapeHtml);
  try {
    const { value } = hljs.highlight(lines.join("\n"), {
      language: grammar,
      ignoreIllegals: true,
    });
    const split = splitHighlightedHtml(value);
    // Paranoia: a mismatch means the splitter and the source disagree — plain
    // text is always correct, degraded is better than misaligned.
    return split.length === lines.length ? split : lines.map(escapeHtml);
  } catch {
    return lines.map(escapeHtml);
  }
}
