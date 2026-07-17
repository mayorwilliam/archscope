import fs from "node:fs";
import path from "node:path";
import { parseArchGraph } from "@archscope/schema";
import { describe, expect, it } from "vitest";
import {
  dependenciesView,
  fileContextView,
  impactView,
  indexGraph,
  moduleView,
  overviewView,
  resolveNodeRef,
  searchView,
} from "../src/query/engine.js";
import { fixturePath } from "./helpers.js";

/**
 * Engine tests run over the hand-reviewed fixture goldens — the graph is an
 * input here, so no parsing/WASM is involved and the expectations are exact.
 */

function loadGolden(fixture: string) {
  const raw = JSON.parse(
    fs.readFileSync(path.join(fixturePath(fixture), "expected-graph.json"), "utf8"),
  );
  return indexGraph(parseArchGraph(raw));
}

const index = loadGolden("ts-basic");

describe("resolveNodeRef", () => {
  it("resolves full IDs, bare module names and bare file paths", () => {
    expect(resolveNodeRef(index, "mod:auth")?.id).toBe("mod:auth");
    expect(resolveNodeRef(index, "auth")?.id).toBe("mod:auth");
    expect(resolveNodeRef(index, "src/main.ts")?.id).toBe("file:src/main.ts");
    expect(resolveNodeRef(index, "express")?.id).toBe("pkg:express");
    expect(resolveNodeRef(index, "nope/nothing.ts")).toBeNull();
  });
});

describe("overviewView", () => {
  const view = overviewView(index);

  it("lists every module with file counts and dependency degrees", () => {
    expect(view.modules.map((m) => m.id).sort()).toEqual([
      "mod:auth",
      "mod:db",
      "mod:ts-basic",
      "mod:utils",
    ]);
    const utils = view.modules.find((m) => m.id === "mod:utils");
    expect(utils?.files).toBe(1);
    expect(utils?.dependents).toBe(3); // auth, db and the root module all lean on utils
    expect(utils?.dependsOn).toBe(0);
  });

  it("carries the module→module dependency list sorted by weight", () => {
    expect(view.dependencies.length).toBe(4);
    for (const dep of view.dependencies) {
      expect(dep.from.startsWith("mod:")).toBe(true);
      expect(dep.weight).toBeGreaterThanOrEqual(1);
    }
    const weights = view.dependencies.map((d) => d.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
  });

  it("aggregates external packages by fan-in", () => {
    expect(view.packages.map((p) => p.id).sort()).toEqual(["pkg:express", "pkg:fs", "pkg:path"]);
  });
});

describe("moduleView", () => {
  it("returns files, deps in both directions and packages for a module", () => {
    const view = moduleView(index, "auth");
    expect(view).not.toBeNull();
    expect(view?.files.map((f) => f.path).sort()).toEqual([
      "src/auth/index.ts",
      "src/auth/login.ts",
      "src/auth/session.ts",
    ]);
    expect(view?.dependsOn.map((d) => d.to)).toEqual(["mod:utils"]);
    expect(view?.dependents.map((d) => d.from)).toEqual(["mod:ts-basic"]);
    const login = view?.files.find((f) => f.path === "src/auth/login.ts");
    expect(login?.exports).toEqual(["LOGIN_TIMEOUT", "login"]);
  });

  it("lists internal file→file imports, excluding edges that leave the module", () => {
    const view = moduleView(index, "auth");
    // login → utils/format crosses the module boundary and must not appear.
    expect(view?.internalImports).toEqual([
      { from: "file:src/auth/index.ts", to: "file:src/auth/login.ts" },
      { from: "file:src/auth/index.ts", to: "file:src/auth/session.ts" },
      { from: "file:src/auth/login.ts", to: "file:src/auth/session.ts" },
      { from: "file:src/auth/session.ts", to: "file:src/auth/login.ts" },
    ]);
  });

  it("returns null for non-modules and unknown names", () => {
    expect(moduleView(index, "src/main.ts")).toBeNull();
    expect(moduleView(index, "ghost")).toBeNull();
  });
});

describe("dependenciesView", () => {
  it("splits edges into outgoing and incoming with symbols", () => {
    const view = dependenciesView(index, "src/auth/login.ts");
    expect(view?.out.map((d) => d.id).sort()).toEqual([
      "file:src/auth/session.ts",
      "file:src/utils/format.ts",
    ]);
    expect(view?.in.map((d) => d.id).sort()).toEqual([
      "file:src/auth/index.ts",
      "file:src/auth/session.ts",
    ]);
    for (const item of [...(view?.out ?? []), ...(view?.in ?? [])]) {
      expect(item.source).toBe("static");
      expect(item.confidence).toBe("certain");
    }
  });
});

describe("impactView", () => {
  it("computes the transitive blast radius of a file, cycles included", () => {
    const view = impactView(index, "src/utils/format.ts");
    expect(view?.directDependents.map((d) => d.id).sort()).toEqual([
      "file:src/auth/login.ts",
      "file:src/db/client.ts",
      "file:src/main.ts",
    ]);
    // login/session import each other — the cycle must not loop or double-count.
    expect(view?.transitive.totalFiles).toBe(5);
    expect(view?.transitive.maxDepth).toBe(2);
    const byModule = Object.fromEntries(
      (view?.transitive.byModule ?? []).map((m) => [m.id, m.files]),
    );
    expect(byModule).toEqual({ "mod:auth": 3, "mod:db": 1, "mod:ts-basic": 1 });
  });

  it("hops from a symbol to its containing file before walking importers", () => {
    const view = impactView(index, "sym:src/utils/format.ts#formatDate");
    expect(view?.transitive.totalFiles).toBe(6); // format.ts itself + the 5 dependents
    expect(view?.transitive.maxDepth).toBe(3);
  });
});

describe("searchView", () => {
  it("ranks exact name matches first and respects kind filters", () => {
    const view = searchView(index, "login");
    expect(view.results[0]?.id).toBe("sym:src/auth/login.ts#login");
    expect(view.results.some((r) => r.id === "file:src/auth/login.ts")).toBe(true);

    const onlyFiles = searchView(index, "login", ["file"]);
    expect(onlyFiles.results.every((r) => r.kind === "file")).toBe(true);
  });

  it("reports the containing module of each hit", () => {
    const view = searchView(index, "session");
    const hit = view.results.find((r) => r.id === "file:src/auth/session.ts");
    expect(hit?.moduleId).toBe("mod:auth");
  });
});

describe("fileContextView", () => {
  it("gathers exports, imports and importers of a file", () => {
    const view = fileContextView(index, "src/auth/login.ts");
    expect(view?.moduleId).toBe("mod:auth");
    expect(view?.exports.map((e) => e.name)).toContain("login");
    expect(view?.imports.map((d) => d.id)).toContain("file:src/utils/format.ts");
    expect(view?.importedBy.map((d) => d.id)).toContain("file:src/auth/index.ts");
  });

  it("returns null for anything that is not a file", () => {
    expect(fileContextView(index, "mod:auth")).toBeNull();
    expect(fileContextView(index, "missing.ts")).toBeNull();
  });
});
