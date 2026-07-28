import { describe, expect, it } from "vitest";
import {
  DOC_SUMMARY_MAX,
  normalizeJsDoc,
  normalizePyDoc,
  pyStringBody,
} from "../src/parse/doc-normalize.js";
import { DOC_MAX_BYTES, extractDocFacts } from "../src/parse/markdown.js";

/**
 * Table-driven, per the repo convention: every weird comment shape found in
 * the wild becomes a new row here, never an inline fix elsewhere.
 */

describe("normalizeJsDoc", () => {
  const rows: Array<{ name: string; raw: string; expected: string | undefined }> = [
    {
      name: "single line",
      raw: "/** Does the thing. */",
      expected: "Does the thing.",
    },
    {
      name: "multi-line with stars",
      raw: "/**\n * First line\n * second line.\n */",
      expected: "First line second line.",
    },
    {
      name: "cuts at first tag",
      raw: "/**\n * Summary here.\n * @param x the x\n * @returns y\n */",
      expected: "Summary here.",
    },
    {
      name: "first paragraph only",
      raw: "/**\n * Para one.\n *\n * Para two is dropped.\n */",
      expected: "Para one.",
    },
    {
      name: "tag-only comment yields nothing",
      raw: "/**\n * @deprecated use other()\n */",
      expected: undefined,
    },
    {
      name: "@fileoverview keeps inline prose",
      raw: "/**\n * @fileoverview Session helpers for the app.\n */",
      expected: "Session helpers for the app.",
    },
    {
      name: "@module label with following prose",
      raw: "/**\n * @module\n * Utilities for formatting.\n */",
      expected: "Utilities for formatting.",
    },
    {
      name: "plain block comment (not jsdoc) still normalizes",
      raw: "/* Legacy header comment. */",
      expected: "Legacy header comment.",
    },
    {
      name: "empty comment",
      raw: "/** */",
      expected: undefined,
    },
    {
      name: "email in prose is not a tag (line must START with @)",
      raw: "/** Contact admin@example.com for access. */",
      expected: "Contact admin@example.com for access.",
    },
  ];

  it.each(rows)("$name", ({ raw, expected }) => {
    expect(normalizeJsDoc(raw)).toBe(expected);
  });

  it("caps the summary at DOC_SUMMARY_MAX", () => {
    const long = `/** ${"palabra ".repeat(300)} */`;
    const result = normalizeJsDoc(long);
    expect(result).toBeDefined();
    expect((result as string).length).toBeLessThanOrEqual(DOC_SUMMARY_MAX);
    expect(result?.endsWith("…")).toBe(true);
  });
});

describe("normalizePyDoc / pyStringBody", () => {
  const rows: Array<{ name: string; literal: string; expected: string | undefined }> = [
    {
      name: "triple double quotes",
      literal: '"""Do the thing."""',
      expected: "Do the thing.",
    },
    {
      name: "triple single quotes",
      literal: "'''Do the thing.'''",
      expected: "Do the thing.",
    },
    {
      name: "single-quoted one-liner",
      literal: "'Short doc.'",
      expected: "Short doc.",
    },
    {
      name: "raw string prefix",
      literal: 'r"""Pattern doc with \\d escapes."""',
      expected: "Pattern doc with \\d escapes.",
    },
    {
      name: "multi-line first paragraph joins",
      literal: '"""First line\n    continues here.\n\n    Second para dropped.\n    """',
      expected: "First line continues here.",
    },
    {
      name: "leading blank line before prose",
      literal: '"""\n    Actual summary.\n    """',
      expected: "Actual summary.",
    },
    {
      name: "empty docstring",
      literal: '""""""',
      expected: undefined,
    },
  ];

  it.each(rows)("$name", ({ literal, expected }) => {
    expect(normalizePyDoc(pyStringBody(literal))).toBe(expected);
  });
});

describe("extractDocFacts", () => {
  it("title from first h1, headings skip fenced pseudo-headings", () => {
    const md = "intro\n\n# Real Title\n\n```sh\n# not a heading\n```\n\n## Sub\n";
    const facts = extractDocFacts("docs/x.md", md);
    expect(facts.title).toBe("Real Title");
    expect(facts.headings).toEqual([
      { depth: 1, text: "Real Title" },
      { depth: 2, text: "Sub" },
    ]);
  });

  it("falls back to the first heading of any depth, then the filename", () => {
    expect(extractDocFacts("a/b.md", "### Deep only\n").title).toBe("Deep only");
    expect(extractDocFacts("a/b.md", "no headings at all\n").title).toBe("b.md");
  });

  it("normalizes CRLF to LF", () => {
    const facts = extractDocFacts("x.md", "# T\r\nline\r\n");
    expect(facts.content).toBe("# T\nline\n");
  });

  it("truncates deterministically at DOC_MAX_BYTES with a marker", () => {
    const big = `# Big\n\n${"línea con acentos áéíóú\n".repeat(10_000)}`;
    const facts = extractDocFacts("big.md", big);
    expect(facts.truncated).toBe(true);
    expect(Buffer.byteLength(facts.content, "utf8")).toBeLessThanOrEqual(DOC_MAX_BYTES + 100);
    expect(facts.content.endsWith("… (truncated by archscope)\n")).toBe(true);
    // Byte-stable: same input, same cut.
    expect(extractDocFacts("big.md", big).content).toBe(facts.content);
  });

  it("closes markdown ATX headings (trailing #s) cleanly", () => {
    expect(extractDocFacts("x.md", "## Closed ##\n").title).toBe("Closed");
  });
});
