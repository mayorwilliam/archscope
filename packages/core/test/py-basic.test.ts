import type { ArchGraph } from "@archscope/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeFixture, expectGolden } from "./helpers.js";

describe("py-basic fixture", () => {
  let graph: ArchGraph;

  beforeAll(async () => {
    graph = await analyzeFixture("py-basic");
  });

  const edge = (kind: string, from: string, to: string) =>
    graph.edges.find((e) => e.kind === kind && e.from === from && e.to === to);

  it("infers modules through the src/ layout", () => {
    const modules = graph.nodes.filter((n) => n.kind === "module").map((n) => n.name);
    expect(modules.sort()).toEqual(["app", "py-basic"]);
  });

  it("resolves absolute imports through the src root", () => {
    expect(edge("imports", "file:main.py", "file:src/app/api/handlers.py")).toBeDefined();
  });

  it("resolves `from . import x` to the submodule, not __init__", () => {
    expect(
      edge("imports", "file:src/app/api/__init__.py", "file:src/app/api/handlers.py"),
    ).toBeDefined();
    expect(
      edge("imports", "file:src/app/api/__init__.py", "file:src/app/__init__.py"),
    ).toBeUndefined();
  });

  it("resolves two-dot relative imports across sibling packages", () => {
    expect(
      edge("imports", "file:src/app/api/handlers.py", "file:src/app/models/user.py"),
    ).toBeDefined();
    expect(
      edge("imports", "file:src/app/api/handlers.py", "file:src/app/db/client.py"),
    ).toBeDefined();
  });

  it("captures importlib.import_module with a literal string", () => {
    expect(edge("imports", "file:src/app/db/client.py", "file:src/app/plugins.py")).toBeDefined();
  });

  it("classifies externals: PyPI package vs stdlib", () => {
    const requests = graph.nodes.find((n) => n.id === "pkg:requests");
    expect(requests?.attrs).toMatchObject({ kind: "extpkg", registry: "pypi" });

    const os = graph.nodes.find((n) => n.id === "pkg:os");
    expect(os?.attrs).toMatchObject({ kind: "extpkg", registry: "stdlib" });
  });

  it("derives the module-level depends_on from the entrypoint", () => {
    expect(edge("depends_on", "mod:py-basic", "mod:app")).toBeDefined();
  });

  it("applies export conventions: underscore-private and __all__", () => {
    const symbolIds = graph.nodes.filter((n) => n.kind === "symbol").map((n) => n.id);
    expect(symbolIds).toContain("sym:src/app/models/user.py#User");
    expect(symbolIds).toContain("sym:src/app/models/user.py#USER_TABLE");
    expect(symbolIds).toContain("sym:src/app/db/client.py#connect");
    // underscore convention
    expect(symbolIds).not.toContain("sym:src/app/models/user.py#_hash_password");
    expect(symbolIds).not.toContain("sym:src/app/config.py#_INTERNAL_FLAG");
    // __all__ wins over the underscore convention when present
    expect(symbolIds).not.toContain("sym:src/app/db/client.py#POOL_SIZE");
  });

  it("matches the golden graph", () => {
    expectGolden(graph, "py-basic");
  });
});
