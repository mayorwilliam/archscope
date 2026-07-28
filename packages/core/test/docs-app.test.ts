import type { ArchGraph } from "@archscope/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeFixture, expectGolden } from "./helpers.js";

describe("docs-app fixture", () => {
  let graph: ArchGraph;

  beforeAll(async () => {
    graph = await analyzeFixture("docs-app");
  });

  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  const symbolDoc = (id: string) => {
    const sym = node(id);
    return sym?.attrs.kind === "symbol" ? sym.attrs.doc : undefined;
  };
  const fileDoc = (id: string) => {
    const file = node(id);
    return file?.attrs.kind === "file" ? file.attrs.doc : undefined;
  };
  const documentsEdge = (from: string) =>
    graph.edges.find((e) => e.kind === "documents" && e.from === from);

  it("emits one doc node per curated markdown file", () => {
    const docs = graph.nodes.filter((n) => n.kind === "doc").map((n) => n.id);
    expect(docs.sort()).toEqual([
      "doc:CONTRIBUTING.md",
      "doc:README.md",
      "doc:docs/guide.md",
      "doc:src/auth/README.md",
    ]);
    expect(graph.meta.counts.doc).toBe(4);
  });

  it("titles come from the first heading, falling back through depths", () => {
    expect(node("doc:README.md")?.name).toBe("Docs App");
    expect(node("doc:CONTRIBUTING.md")?.name).toBe("Contributing"); // h2 fallback
    expect(node("doc:docs/guide.md")?.name).toBe("Guide");
  });

  it("headings inside code fences are not headings", () => {
    const guide = node("doc:docs/guide.md");
    if (guide?.attrs.kind !== "doc") throw new Error("not a doc node");
    expect(guide.attrs.headings.map((h) => h.text)).toEqual(["Guide", "Second section"]);
  });

  it("a README next to its module's files links certain", () => {
    const edge = documentsEdge("doc:src/auth/README.md");
    expect(edge?.to).toBe("mod:auth");
    expect(edge?.confidence).toBe("certain");
  });

  it("the root README links to the root module as inferred (files live in src/)", () => {
    const edge = documentsEdge("doc:README.md");
    expect(edge?.to).toBe("mod:docs-app");
    expect(edge?.confidence).toBe("inferred");
  });

  it("non-README pages carry no documents edge", () => {
    expect(documentsEdge("doc:CONTRIBUTING.md")).toBeUndefined();
    expect(documentsEdge("doc:docs/guide.md")).toBeUndefined();
  });

  it("JSDoc first paragraph lands on the symbol; tags are cut", () => {
    expect(symbolDoc("sym:src/auth/login.ts#login")).toBe(
      "Log a user in and mint a session token.",
    );
    expect(symbolDoc("sym:src/auth/login.ts#MAX_RETRIES")).toBe("Retry budget for the login flow.");
    expect(symbolDoc("sym:src/auth/login.ts#Session")).toBe("Shape of a session record.");
  });

  it("tag-only JSDoc yields no doc", () => {
    expect(symbolDoc("sym:src/auth/login.ts#logout")).toBeUndefined();
  });

  it("a blank line between comment and declaration breaks the bond", () => {
    expect(symbolDoc("sym:src/auth/login.ts#refresh")).toBeUndefined();
  });

  it("a decorator between JSDoc and class does not break the bond", () => {
    expect(symbolDoc("sym:src/auth/session.ts#SessionStore")).toBe(
      "Persist sessions with automatic retry.",
    );
  });

  it("@fileoverview labels the file doc even when adjacent to code", () => {
    expect(fileDoc("file:src/auth/session.ts")).toContain("Session storage helpers");
    expect(fileDoc("file:src/auth/login.ts")).toBeUndefined();
  });

  it("python module docstring becomes the file doc, first paragraph only", () => {
    expect(fileDoc("file:worker/tasks.py")).toBe("Task queue helpers for the worker module.");
  });

  it("python symbol docstrings are captured and dedented", () => {
    expect(symbolDoc("sym:worker/tasks.py#enqueue")).toBe("Push a task onto the queue.");
    expect(symbolDoc("sym:worker/tasks.py#Scheduler")).toBe(
      "Runs periodic jobs on a fixed interval.",
    );
    expect(symbolDoc("sym:worker/tasks.py#plain")).toBeUndefined();
  });

  it("matches the golden graph", () => {
    expectGolden(graph, "docs-app");
  });
});
