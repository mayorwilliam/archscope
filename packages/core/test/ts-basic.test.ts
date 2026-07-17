import type { ArchGraph } from "@archscope/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeFixture, expectGolden } from "./helpers.js";

describe("ts-basic fixture", () => {
  let graph: ArchGraph;

  beforeAll(async () => {
    graph = await analyzeFixture("ts-basic");
  });

  const edge = (kind: string, from: string, to: string) =>
    graph.edges.find((e) => e.kind === kind && e.from === from && e.to === to);

  it("infers modules from first-level directories under src/", () => {
    const modules = graph.nodes.filter((n) => n.kind === "module").map((n) => n.name);
    expect(modules.sort()).toEqual(["auth", "db", "ts-basic", "utils"]);
  });

  it("resolves the barrel import (main → auth/index)", () => {
    expect(edge("imports", "file:src/main.ts", "file:src/auth/index.ts")).toBeDefined();
  });

  it("resolves tsconfig paths aliases (@utils/format)", () => {
    expect(edge("imports", "file:src/main.ts", "file:src/utils/format.ts")).toBeDefined();
  });

  it("resolves ESM .js imports to .ts sources", () => {
    expect(edge("imports", "file:src/auth/login.ts", "file:src/utils/format.ts")).toBeDefined();
  });

  it("keeps both directions of the circular import", () => {
    expect(edge("imports", "file:src/auth/login.ts", "file:src/auth/session.ts")).toBeDefined();
    expect(edge("imports", "file:src/auth/session.ts", "file:src/auth/login.ts")).toBeDefined();
  });

  it("captures barrel re-exports as reexport imports", () => {
    expect(edge("imports", "file:src/auth/index.ts", "file:src/auth/login.ts")).toBeDefined();
    expect(edge("imports", "file:src/auth/index.ts", "file:src/auth/session.ts")).toBeDefined();
  });

  it("captures dynamic import() and require()", () => {
    expect(edge("imports", "file:src/db/client.ts", "file:src/utils/format.ts")).toBeDefined();
    expect(edge("imports_pkg", "file:src/db/client.ts", "pkg:fs")).toBeDefined();
  });

  it("classifies externals: npm package vs node builtin", () => {
    const express = graph.nodes.find((n) => n.id === "pkg:express");
    expect(express?.attrs).toMatchObject({ kind: "extpkg", registry: "npm" });

    const pathPkg = graph.nodes.find((n) => n.id === "pkg:path");
    expect(pathPkg?.attrs).toMatchObject({ kind: "extpkg", registry: "stdlib" });
  });

  it("derives module-level depends_on with weights", () => {
    const authToUtils = edge("depends_on", "mod:auth", "mod:utils");
    expect(authToUtils?.attrs?.weight).toBe(1);

    const rootToAuth = edge("depends_on", "mod:ts-basic", "mod:auth");
    expect(rootToAuth).toBeDefined();
  });

  it("extracts exported symbols only", () => {
    const symbolNames = graph.nodes.filter((n) => n.kind === "symbol").map((n) => n.name);
    expect(symbolNames).toContain("login");
    expect(symbolNames).toContain("LOGIN_TIMEOUT");
    expect(symbolNames).toContain("Session");
    expect(symbolNames).toContain("formatDate");
    // `session` local in createSession is not top-level; `fs` in client.ts is not exported.
    expect(symbolNames).not.toContain("fs");
  });

  it("matches the golden graph", () => {
    expectGolden(graph, "ts-basic");
  });
});
