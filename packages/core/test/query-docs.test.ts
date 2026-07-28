import type { ArchGraph, GraphEdge, GraphNode } from "@archscope/schema";
import { docId, edgeId, fileId, moduleId } from "@archscope/schema";
import { describe, expect, it } from "vitest";
import { docsView, docView, indexGraph, moduleView } from "../src/query/engine.js";
import { renderDoc, renderModule } from "../src/query/render.js";

/** Doc semantics: readme selection, ref resolution, render hints. */

function docNode(path: string, title: string, content: string): GraphNode {
  return {
    id: docId(path),
    kind: "doc",
    name: title,
    attrs: {
      kind: "doc",
      format: "markdown",
      title,
      content,
      truncated: false,
      headings: [{ depth: 1, text: title }],
    },
    metrics: { fanIn: 0, fanOut: 0, rank: 0 },
  };
}

function documentsEdge(path: string, mod: string, confidence: "certain" | "inferred"): GraphEdge {
  return {
    id: edgeId("documents", docId(path), moduleId(mod)),
    kind: "documents",
    from: docId(path),
    to: moduleId(mod),
    source: "static",
    confidence,
  };
}

function graphWith(nodes: GraphNode[], edges: GraphEdge[]): ArchGraph {
  return {
    schemaVersion: 2,
    meta: {
      tool: "archscope",
      toolVersion: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      root: "/repo/x",
      git: null,
      counts: {},
    },
    nodes,
    edges,
  };
}

const auth: GraphNode = {
  id: moduleId("auth"),
  kind: "module",
  name: "auth",
  attrs: { kind: "module", source: "inferred" },
  metrics: { loc: 10, fanIn: 0, fanOut: 0, rank: 0.5 },
};

const authFile: GraphNode = {
  id: fileId("auth/login.ts"),
  kind: "file",
  name: "login.ts",
  parent: moduleId("auth"),
  lang: "ts",
  attrs: { kind: "file", doc: "Login helpers." },
  metrics: { loc: 10, fanIn: 0, fanOut: 0, rank: 0.5 },
};

const staleness = { createdAt: "2026-01-01T00:00:00.000Z", now: new Date("2026-01-01T00:05:00Z") };

describe("moduleView.readme selection", () => {
  it("prefers a certain documents edge over an inferred one", () => {
    const index = indexGraph(
      graphWith(
        [
          auth,
          authFile,
          docNode("README.md", "Root", "# Root\nroot text\n"),
          docNode("auth/README.md", "Auth", "# Auth\nauth text\n"),
        ],
        [
          documentsEdge("README.md", "auth", "inferred"),
          documentsEdge("auth/README.md", "auth", "certain"),
        ],
      ),
    );
    expect(moduleView(index, "auth")?.readme?.path).toBe("auth/README.md");
  });

  it("ties break by path ascending", () => {
    const index = indexGraph(
      graphWith(
        [
          auth,
          authFile,
          docNode("auth/b/README.md", "B", "b\n"),
          docNode("auth/a/README.md", "A", "a\n"),
        ],
        [
          documentsEdge("auth/b/README.md", "auth", "certain"),
          documentsEdge("auth/a/README.md", "auth", "certain"),
        ],
      ),
    );
    expect(moduleView(index, "auth")?.readme?.path).toBe("auth/a/README.md");
  });

  it("is absent when no documents edge points at the module", () => {
    const index = indexGraph(graphWith([auth, authFile], []));
    expect(moduleView(index, "auth")?.readme).toBeUndefined();
  });
});

describe("docView / docsView", () => {
  const index = indexGraph(
    graphWith(
      [
        auth,
        authFile,
        docNode("auth/README.md", "Auth", "# Auth\ntext\n"),
        docNode("CONTRIBUTING.md", "Contributing", "c\n"),
      ],
      [documentsEdge("auth/README.md", "auth", "certain")],
    ),
  );

  it("resolves a bare path and a doc: id to the same doc", () => {
    expect(docView(index, "auth/README.md")?.id).toBe("doc:auth/README.md");
    expect(docView(index, "doc:auth/README.md")?.id).toBe("doc:auth/README.md");
  });

  it("carries the documented module with its confidence", () => {
    const view = docView(index, "auth/README.md");
    expect(view?.module).toEqual({ id: "mod:auth", name: "auth", confidence: "certain" });
    expect(docView(index, "CONTRIBUTING.md")?.module).toBeUndefined();
  });

  it("lists docs sorted by path (localeCompare, per repo convention)", () => {
    const view = docsView(index);
    expect(view.total).toBe(2);
    expect(view.docs.map((d) => d.path)).toEqual(["auth/README.md", "CONTRIBUTING.md"]);
  });
});

describe("doc rendering", () => {
  const longContent = `# Long\n\n${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}\n`;
  const index = indexGraph(
    graphWith(
      [auth, authFile, docNode("auth/README.md", "Long", longContent)],
      [documentsEdge("auth/README.md", "auth", "certain")],
    ),
  );

  it("renderDoc truncation ends in an executable get_doc hint", () => {
    const doc = docView(index, "auth/README.md");
    if (!doc) throw new Error("doc not found");
    const text = renderDoc(doc, { budget: 250, staleness });
    expect(text).toContain("… +");
    expect(text).toContain('get_doc("auth/README.md", budget_tokens=');
  });

  it("get_module caps About and points the rest at get_doc", () => {
    const mod = moduleView(index, "auth");
    if (!mod) throw new Error("module not found");
    const text = renderModule(mod, { budget: 20_000, staleness });
    expect(text).toContain("## About (auth/README.md)");
    // 202 content lines, About shows at most 30 → the rest is deferred.
    expect(text).toMatch(/\+\d+ more → get_doc\("auth\/README\.md"/);
    expect(text).toContain("## Files (by rank)"); // prose never crowds out structure
  });

  it("file doc summaries ride along file rows", () => {
    const mod = moduleView(index, "auth");
    if (!mod) throw new Error("module not found");
    const text = renderModule(mod, { budget: 20_000, staleness });
    expect(text).toContain("— Login helpers.");
  });
});
