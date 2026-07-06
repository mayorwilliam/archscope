import type { ArchGraph } from "@archmap/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeFixture, expectGolden } from "./helpers.js";

describe("ts-monorepo fixture", () => {
  let graph: ArchGraph;

  beforeAll(async () => {
    graph = await analyzeFixture("ts-monorepo");
  });

  it("uses workspace packages as modules", () => {
    const modules = graph.nodes.filter((n) => n.kind === "module");
    expect(modules.map((m) => m.name).sort()).toEqual(["@fix/core", "@fix/ui"]);
    for (const m of modules) {
      expect(m.attrs).toMatchObject({ kind: "module", source: "workspace" });
    }
  });

  it("resolves cross-package imports to source files, not dist", () => {
    // @fix/core declares main/exports into dist/ which was never built —
    // resolution must land on the src/ twin.
    const entryEdge = graph.edges.find(
      (e) =>
        e.kind === "imports" &&
        e.from === "file:packages/ui/src/index.ts" &&
        e.to === "file:packages/core-lib/src/index.ts",
    );
    expect(entryEdge).toBeDefined();
  });

  it("resolves workspace subpath imports (@fix/core/helpers)", () => {
    const subpathEdge = graph.edges.find(
      (e) =>
        e.kind === "imports" &&
        e.from === "file:packages/ui/src/index.ts" &&
        e.to === "file:packages/core-lib/src/helpers.ts",
    );
    expect(subpathEdge).toBeDefined();
  });

  it("derives the cross-package depends_on edge", () => {
    const dep = graph.edges.find(
      (e) => e.kind === "depends_on" && e.from === "mod:@fix/ui" && e.to === "mod:@fix/core",
    );
    expect(dep?.attrs?.weight).toBe(2);
  });

  it("matches the golden graph", () => {
    expectGolden(graph, "ts-monorepo");
  });
});
