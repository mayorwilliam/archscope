import { describe, expect, it } from "vitest";
import { highlightLines, splitHighlightedHtml } from "../src/lib/highlight";

/**
 * The splitter is the delicate part of the code viewer: hljs spans cross
 * newlines (block comments, template strings) and a naive split would emit
 * unbalanced HTML. Table-driven, per repo convention.
 */

describe("splitHighlightedHtml", () => {
  const rows: Array<{ name: string; html: string; expected: string[] }> = [
    {
      name: "plain lines pass through",
      html: "a\nb\nc",
      expected: ["a", "b", "c"],
    },
    {
      name: "span contained in one line",
      html: '<span class="hljs-keyword">const</span> x\ny',
      expected: ['<span class="hljs-keyword">const</span> x', "y"],
    },
    {
      name: "span crossing a newline is closed and reopened",
      html: '<span class="hljs-comment">/* a\nb */</span>',
      expected: [
        '<span class="hljs-comment">/* a</span>',
        '<span class="hljs-comment">b */</span>',
      ],
    },
    {
      name: "nested spans crossing a newline reopen in order",
      html: '<span class="a">x<span class="b">y\nz</span></span>',
      expected: [
        '<span class="a">x<span class="b">y</span></span>',
        '<span class="a"><span class="b">z</span></span>',
      ],
    },
    {
      name: "single line, no newline",
      html: '<span class="a">solo</span>',
      expected: ['<span class="a">solo</span>'],
    },
  ];

  it.each(rows)("$name", ({ html, expected }) => {
    expect(splitHighlightedHtml(html)).toEqual(expected);
  });
});

describe("highlightLines", () => {
  it("keeps exactly one HTML chunk per source line", () => {
    const source = [
      "/**",
      " * Doc block spanning lines.",
      " */",
      "export function f(): number {",
      '  return Number.parseInt("42", 10);',
      "}",
    ];
    const out = highlightLines(source, "typescript");
    expect(out).toHaveLength(source.length);
    expect(out[3]).toContain("hljs-keyword"); // export
    expect(out[1]).toContain("hljs-comment"); // middle of the block comment
  });

  it("falls back to escaped plain text without a grammar", () => {
    const out = highlightLines(["a < b && c > d"], null);
    expect(out).toEqual(["a &lt; b &amp;&amp; c &gt; d"]);
  });
});
