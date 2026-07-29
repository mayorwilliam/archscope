import { describe, expect, it } from "vitest";
import { type DiffLine, parseUnifiedDiff } from "../src/lib/diff";

/** Table-driven, per repo convention: weird git output shapes become rows. */

const PATCH = [
  "diff --git a/x.ts b/x.ts",
  "index 111..222 100644",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " export { a };",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("classifies meta, hunk, add, del and context lines", () => {
    const kinds = parseUnifiedDiff(PATCH).map((l) => l.kind);
    expect(kinds).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "ctx",
      "del",
      "add",
      "add",
      "ctx",
    ]);
  });

  it("numbers lines from the hunk header: del counts old, add counts new, ctx both", () => {
    const lines = parseUnifiedDiff(PATCH);
    const byText = (text: string) => lines.find((l) => l.text === text) as DiffLine;
    expect(byText("const a = 1;")).toMatchObject({ oldNo: 1, newNo: 1 });
    expect(byText("const b = 2;")).toMatchObject({ kind: "del", oldNo: 2 });
    expect(byText("const b = 3;")).toMatchObject({ kind: "add", newNo: 2 });
    expect(byText("const c = 4;")).toMatchObject({ kind: "add", newNo: 3 });
    expect(byText("export { a };")).toMatchObject({ oldNo: 3, newNo: 4 });
  });

  it("a second hunk resets the counters", () => {
    const twoHunks = `${PATCH}\n@@ -10,1 +11,1 @@\n-old line\n+new line`;
    const lines = parseUnifiedDiff(twoHunks);
    expect(lines.find((l) => l.text === "old line")).toMatchObject({ oldNo: 10 });
    expect(lines.find((l) => l.text === "new line")).toMatchObject({ newNo: 11 });
  });

  it("'\\ No newline at end of file' is meta, not a removal", () => {
    const lines = parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file");
    expect(lines[lines.length - 1]).toMatchObject({ kind: "meta" });
  });

  it("an empty patch yields no lines", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("\n")).toEqual([]);
  });
});
