import { describe, expect, it } from "vitest";
import type { DiffResponse, ErdView, ModuleView, OverviewView } from "../src/api/types";
import { diffFlow, erdFlow, moduleFlow, overviewFlow, tableHeight } from "../src/graph/toFlow";
import { buildElkGraph, extractPositions } from "../src/layout/layout";

/** Minimal view-models — the builders are pure, so tests are pure data. */

const overview: OverviewView = {
  root: "/repo",
  counts: { module: 2, file: 3 },
  totalImports: 4,
  modules: [
    {
      id: "mod:auth",
      name: "auth",
      layer: "domain",
      files: 2,
      loc: 120,
      rank: 0.4,
      dependsOn: 1,
      dependents: 0,
    },
    { id: "mod:utils", name: "utils", files: 1, loc: 40, rank: 0.6, dependsOn: 0, dependents: 1 },
  ],
  dependencies: [
    { from: "mod:auth", to: "mod:utils", weight: 3, source: "static", confidence: "certain" },
  ],
  packages: [],
};

const authModule: ModuleView = {
  id: "mod:auth",
  name: "auth",
  layer: "domain",
  source: "inferred",
  loc: 120,
  rank: 0.4,
  files: [
    {
      id: "file:src/auth/a.ts",
      path: "src/auth/a.ts",
      loc: 80,
      rank: 0.3,
      fanIn: 1,
      fanOut: 1,
      exports: ["a"],
    },
    {
      id: "file:src/auth/b.ts",
      path: "src/auth/b.ts",
      loc: 40,
      rank: 0.1,
      fanIn: 1,
      fanOut: 0,
      exports: [],
    },
  ],
  internalImports: [{ from: "file:src/auth/a.ts", to: "file:src/auth/b.ts" }],
  dependsOn: [
    { from: "mod:auth", to: "mod:utils", weight: 3, source: "static", confidence: "certain" },
  ],
  dependents: [],
  packages: [],
};

describe("overviewFlow", () => {
  it("renders collapsed modules as plain nodes with weighted depends_on edges", () => {
    const spec = overviewFlow(overview, new Set(), new Map());
    expect(spec.nodes.map((n) => n.type)).toEqual(["module", "module"]);
    const dep = spec.edges.find((e) => e.id === "dep:mod:auth→mod:utils");
    expect(dep?.strokeWidth).toBeGreaterThan(1);
    expect(dep?.label).toBe("3");
  });

  it("expands a module into a group with parented file nodes and internal edges", () => {
    const spec = overviewFlow(overview, new Set(["mod:auth"]), new Map([["mod:auth", authModule]]));
    const group = spec.nodes.find((n) => n.id === "mod:auth");
    expect(group?.type).toBe("moduleGroup");
    expect(group?.width).toBeUndefined(); // ELK sizes groups from their children
    const files = spec.nodes.filter((n) => n.type === "file");
    expect(files.map((n) => n.parentId)).toEqual(["mod:auth", "mod:auth"]);
    expect(spec.edges.some((e) => e.id === "imp:file:src/auth/a.ts→file:src/auth/b.ts")).toBe(true);
  });

  it("keeps a module collapsed until its detail has actually loaded", () => {
    const spec = overviewFlow(overview, new Set(["mod:auth"]), new Map());
    expect(spec.nodes.find((n) => n.id === "mod:auth")?.type).toBe("module");
  });
});

describe("moduleFlow", () => {
  it("draws the module as a group plus aggregated neighbor ghosts", () => {
    const spec = moduleFlow(authModule);
    expect(spec.nodes.find((n) => n.id === "mod:auth")?.type).toBe("moduleGroup");
    expect(spec.nodes.find((n) => n.id === "mod:utils")?.type).toBe("extModule");
    expect(spec.edges.some((e) => e.id === "dep:mod:auth→mod:utils")).toBe(true);
  });
});

describe("erdFlow", () => {
  const erd: ErdView = {
    live: null,
    tables: [
      {
        id: "tbl:public.users",
        schema: "public",
        name: "users",
        origin: "declared",
        columns: [
          { name: "id", sqlType: "int", nullable: false, isPk: true },
          {
            name: "team_id",
            sqlType: "int",
            nullable: true,
            isPk: false,
            fkTo: { table: "public.teams", column: "id" },
          },
        ],
        entities: [{ id: "ent:m.py#User", name: "User", orm: "sqlalchemy", confidence: "certain" }],
        drift: [{ kind: "table_missing_in_db", detail: "users missing" }],
      },
      {
        id: "tbl:public.teams",
        schema: "public",
        name: "teams",
        origin: "declared",
        columns: [{ name: "id", sqlType: "int", nullable: false, isPk: true }],
        entities: [],
        drift: [],
      },
    ],
    fks: [
      {
        from: "tbl:public.users",
        to: "tbl:public.teams",
        columns: [["team_id", "id"]],
        source: "static",
        confidence: "certain",
      },
    ],
    totals: { tables: 2, entities: 1, fks: 1, drift: 1 },
  };

  it("sizes tables by column count and labels fk edges with column pairs", () => {
    const spec = erdFlow(erd);
    const users = spec.nodes.find((n) => n.id === "tbl:public.users");
    const teams = spec.nodes.find((n) => n.id === "tbl:public.teams");
    expect(users?.height).toBe(tableHeight(2, true));
    expect(teams?.height).toBe(tableHeight(1, false));
    expect((users?.height ?? 0) > (teams?.height ?? 0)).toBe(true);
    const fk = spec.edges.find((e) => e.id === "fk:tbl:public.users→tbl:public.teams");
    expect(fk?.label).toBe("team_id → id");
    expect((users?.data as { driftCount: number }).driftCount).toBe(1);
  });
});

describe("diffFlow", () => {
  const response: DiffResponse = {
    headOverview: {
      ...overview,
      modules: [
        ...overview.modules,
        {
          id: "mod:billing",
          name: "billing",
          files: 1,
          loc: 10,
          rank: 0.1,
          dependsOn: 0,
          dependents: 0,
        },
      ],
    },
    diff: {
      base: { sha: "a", ref: "main" },
      head: { sha: "b", ref: "HEAD" },
      moduleChanges: { added: ["mod:billing"], removed: ["mod:legacy"], renamed: [] },
      dependencyChanges: {
        added: [{ kind: "depends_on", from: "mod:auth", to: "mod:utils" }],
        removed: [{ kind: "depends_on", from: "mod:legacy", to: "mod:utils" }],
        weightDelta: [],
      },
      dbChanges: { tables: [], fks: [], driftDelta: [] },
      fileChanges: [],
    },
  };

  it("colors head modules, adds removed ghosts and classifies edges", () => {
    const spec = diffFlow(response);
    const billing = spec.nodes.find((n) => n.id === "mod:billing");
    expect(billing?.data.status).toBe("added");
    const legacy = spec.nodes.find((n) => n.id === "mod:legacy");
    expect(legacy?.data.status).toBe("removed");
    expect(spec.edges.find((e) => e.id === "dep:mod:auth→mod:utils")?.className).toBe("edge-added");
    expect(spec.edges.find((e) => e.id === "dep-removed:mod:legacy→mod:utils")?.className).toBe(
      "edge-removed",
    );
  });
});

describe("buildElkGraph / extractPositions", () => {
  it("nests parented nodes as ELK children and reads positions back", () => {
    const spec = overviewFlow(overview, new Set(["mod:auth"]), new Map([["mod:auth", authModule]]));
    const elk = buildElkGraph(spec, "DOWN");
    const group = elk.children?.find((c) => c.id === "mod:auth");
    expect(group?.children?.map((c) => c.id)).toEqual(["file:src/auth/a.ts", "file:src/auth/b.ts"]);
    expect(elk.edges?.length).toBe(spec.edges.length);

    const positions = extractPositions({
      id: "root",
      children: [
        {
          id: "mod:auth",
          x: 10,
          y: 20,
          width: 300,
          height: 200,
          children: [{ id: "file:src/auth/a.ts", x: 16, y: 40, width: 190, height: 52 }],
        },
      ],
    });
    expect(positions.get("mod:auth")).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    // Child coordinates stay parent-relative — React Flow's parentId contract.
    expect(positions.get("file:src/auth/a.ts")?.x).toBe(16);
  });
});
