import type { ArchDiff, ArchGraph, GraphEdge, GraphNode } from "@archscope/schema";
import { docId, edgeId, entityId, fileId, moduleId, symbolId, tableId } from "@archscope/schema";
import { describe, expect, it } from "vitest";
import { BudgetWriter, estimateTokens, MAX_BUDGET, MIN_BUDGET } from "../src/query/budget.js";
import {
  dbSchemaView,
  dependenciesView,
  docsView,
  docView,
  entityRelationsView,
  fileContextView,
  impactView,
  indexGraph,
  moduleView,
  overviewView,
  schemaDriftView,
  searchView,
} from "../src/query/engine.js";
import {
  type RenderContext,
  renderDbSchema,
  renderDependencies,
  renderDiff,
  renderDoc,
  renderDocs,
  renderEntityRelations,
  renderFileContext,
  renderImpact,
  renderModule,
  renderNotFound,
  renderOverview,
  renderSchemaDrift,
  renderSearch,
  stalenessLines,
} from "../src/query/render.js";

/**
 * The permanent regression guard for principle #3: for ANY budget in range,
 * every renderer's output fits. Budgets come from a seeded PRNG so the run
 * is deterministic; the graph is synthetic and big enough that every render
 * is forced to truncate at the low end of the range.
 */

// --- deterministic pseudo-randomness ----------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- synthetic graph: 30 modules × 10 files, chained imports -----------------

function syntheticGraph(): ArchGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const MODULES = 30;
  const FILES = 10;

  for (let m = 0; m < MODULES; m++) {
    const modName = `area-${String(m).padStart(2, "0")}`;
    nodes.push({
      id: moduleId(modName),
      kind: "module",
      name: modName,
      attrs: { kind: "module", source: "inferred" },
      metrics: { loc: 100 * (m + 1), fanIn: m, fanOut: 1, rank: (MODULES - m) / 100 },
    });
    for (let f = 0; f < FILES; f++) {
      const relPath = `${modName}/file-${f}.ts`;
      nodes.push({
        id: fileId(relPath),
        kind: "file",
        name: `file-${f}.ts`,
        parent: moduleId(modName),
        lang: "ts",
        attrs: { kind: "file" },
        metrics: { loc: 40 + f, fanIn: 2, fanOut: 2, rank: (FILES - f) / 1000 },
      });
      nodes.push({
        id: symbolId(relPath, `helper${f}`),
        kind: "symbol",
        name: `helper${f}`,
        parent: fileId(relPath),
        lang: "ts",
        attrs: { kind: "symbol", symbolKind: "function", exported: true },
        metrics: { fanIn: 0, fanOut: 0, rank: 0 },
        span: { path: relPath, startLine: 1, endLine: 5 },
      });
      if (f > 0) {
        const from = fileId(relPath);
        const to = fileId(`${modName}/file-${f - 1}.ts`);
        edges.push({
          id: edgeId("imports", from, to),
          kind: "imports",
          from,
          to,
          attrs: { symbols: [`helper${f - 1}`] },
          source: "static",
          confidence: "certain",
        });
      }
    }
    if (m > 0) {
      const prev = `area-${String(m - 1).padStart(2, "0")}`;
      const from = fileId(`${modName}/file-0.ts`);
      const to = fileId(`${prev}/file-0.ts`);
      edges.push({
        id: edgeId("imports", from, to),
        kind: "imports",
        from,
        to,
        attrs: { symbols: ["helper0"] },
        source: "static",
        confidence: "certain",
      });
      edges.push({
        id: edgeId("depends_on", moduleId(modName), moduleId(prev)),
        kind: "depends_on",
        from: moduleId(modName),
        to: moduleId(prev),
        attrs: { weight: m },
        source: "static",
        confidence: "certain",
      });
    }
  }

  // DB layer: enough tables/entities/drift that every DB render truncates at
  // the low end of the budget range.
  const TABLES = 25;
  for (let t = 0; t < TABLES; t++) {
    const tableName = `table_${String(t).padStart(2, "0")}`;
    const filePath = `area-00/file-0.ts`;
    const tid = tableId("public", tableName);
    nodes.push({
      id: tid,
      kind: "table",
      name: tableName,
      attrs: {
        kind: "table",
        origin: t % 3 === 0 ? "both" : "declared",
        columns: Array.from({ length: 8 }, (_, c) => ({
          name: `col_${c}`,
          sqlType: c === 0 ? "Int" : "String",
          nullable: c % 2 === 1,
          isPk: c === 0,
        })),
        ...(t % 3 === 0
          ? {
              drift: [
                {
                  kind: "column_missing_in_code" as const,
                  column: "legacy",
                  detail: `legacy (live varchar) is not declared in code — table ${tableName}`,
                },
              ],
            }
          : {}),
      },
      metrics: { fanIn: 1, fanOut: 0, rank: 0 },
    });
    const eid = entityId(filePath, `Entity${t}`);
    nodes.push({
      id: eid,
      kind: "entity",
      name: `Entity${t}`,
      parent: fileId(filePath),
      lang: "ts",
      attrs: {
        kind: "entity",
        orm: "prisma",
        declaredTable: `public.${tableName}`,
        fields: Array.from({ length: 8 }, (_, c) => ({
          name: `col_${c}`,
          type: c === 0 ? "Int" : "String",
          nullable: c % 2 === 1,
          isPk: c === 0,
          isFk: false,
        })),
      },
      metrics: { fanIn: 0, fanOut: 1, rank: 0 },
      span: { path: filePath, startLine: 1, endLine: 9 },
    });
    edges.push({
      id: edgeId("maps_to", eid, tid),
      kind: "maps_to",
      from: eid,
      to: tid,
      source: "static",
      confidence: t % 2 === 0 ? "certain" : "inferred",
    });
    if (t > 0) {
      const prev = tableId("public", `table_${String(t - 1).padStart(2, "0")}`);
      edges.push({
        id: edgeId("fk", tid, prev),
        kind: "fk",
        from: tid,
        to: prev,
        attrs: { columns: [["col_1", "col_0"]] },
        source: "static",
        confidence: "certain",
      });
    }
  }

  // A long README documenting area-05: forces renderModule's About section
  // and renderDoc to truncate at the low end of the budget range.
  const readmePath = "area-05/README.md";
  nodes.push({
    id: docId(readmePath),
    kind: "doc",
    name: "Area 05",
    attrs: {
      kind: "doc",
      format: "markdown",
      title: "Area 05",
      content: `# Area 05\n\n${Array.from(
        { length: 120 },
        (_, i) => `Line ${i} of the area-05 readme, long enough to matter.`,
      ).join("\n")}\n`,
      truncated: false,
      headings: [{ depth: 1, text: "Area 05" }],
    },
    metrics: { fanIn: 0, fanOut: 0, rank: 0 },
  });
  edges.push({
    id: edgeId("documents", docId(readmePath), moduleId("area-05")),
    kind: "documents",
    from: docId(readmePath),
    to: moduleId("area-05"),
    source: "static",
    confidence: "certain",
  });

  return {
    schemaVersion: 2,
    meta: {
      tool: "archscope",
      toolVersion: "test",
      createdAt: "2026-01-01T00:00:00.000Z",
      root: "/repo/synthetic",
      git: { sha: "aabbccdd00112233", branch: "main", dirty: false },
      live: {
        source: "main",
        dialect: "postgres",
        introspectedAt: "2026-01-01T00:00:00.000Z",
      },
      counts: {
        module: MODULES,
        file: MODULES * FILES,
        symbol: MODULES * FILES,
        entity: TABLES,
        table: TABLES,
        extpkg: 0,
        doc: 1,
      },
    },
    nodes,
    edges,
  };
}

function syntheticDiff(): ArchDiff {
  return {
    base: { sha: "1111111111111111", ref: "main" },
    head: { sha: "2222222222222222", ref: "HEAD" },
    moduleChanges: {
      added: Array.from({ length: 40 }, (_, i) => `mod:new-${i}`),
      removed: ["mod:legacy"],
      renamed: [["mod:old-name", "mod:new-name"]],
    },
    dependencyChanges: {
      added: Array.from({ length: 30 }, (_, i) => ({
        kind: "depends_on" as const,
        from: `mod:new-${i}`,
        to: "mod:core",
      })),
      removed: [],
      weightDelta: [
        { edge: { kind: "depends_on", from: "mod:cli", to: "mod:core" }, before: 3, after: 9 },
      ],
    },
    dbChanges: { tables: [], fks: [], driftDelta: [] },
    fileChanges: Array.from({ length: 150 }, (_, i) => ({
      id: `file:src/gen/f${i}.ts`,
      change: "added" as const,
    })),
  };
}

const index = indexGraph(syntheticGraph());
const staleness = {
  builtSha: "aabbccdd00112233",
  branch: "main",
  builtDirty: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  currentSha: "aabbccdd00112233",
  now: new Date("2026-01-01T00:05:00.000Z"),
};

function everyRender(ctx: RenderContext): Array<[string, string]> {
  const searchAll = searchView(index, "file");
  const mod = moduleView(index, "area-05");
  const deps = dependenciesView(index, "area-05/file-5.ts");
  const impact = impactView(index, "area-00/file-0.ts");
  const file = fileContextView(index, "area-05/file-5.ts");
  const entityRel = entityRelationsView(index, "Entity10");
  const tableRel = entityRelationsView(index, "public.table_10");
  const doc = docView(index, "area-05/README.md");
  if (!mod || !deps || !impact || !file || !entityRel || !tableRel || !doc) {
    throw new Error("synthetic graph lookup failed");
  }
  return [
    ["get_doc", renderDoc(doc, ctx)],
    ["docs_list", renderDocs(docsView(index), ctx)],
    ["get_architecture_overview", renderOverview(overviewView(index), ctx)],
    ["get_module", renderModule(mod, ctx)],
    ["find_dependencies", renderDependencies(deps, ctx)],
    ["get_impact", renderImpact(impact, ctx)],
    ["search_nodes", renderSearch(searchAll, ctx)],
    ["get_file_context", renderFileContext(file, ctx)],
    ["get_architecture_diff", renderDiff(syntheticDiff(), ctx)],
    ["get_db_schema", renderDbSchema(dbSchemaView(index), ctx)],
    ["get_db_schema(table)", renderEntityRelations(tableRel, ctx)],
    ["get_entity_relations", renderEntityRelations(entityRel, ctx)],
    ["get_schema_drift", renderSchemaDrift(schemaDriftView(index), ctx)],
    ["not_found", renderNotFound("ghost-module", [{ id: "mod:area-01", kind: "module" }], ctx)],
  ];
}

describe("budget property: every renderer fits any budget in range", () => {
  const random = mulberry32(20260708);
  const budgets: number[] = [MIN_BUDGET, MAX_BUDGET];
  for (let i = 0; i < 40; i++) {
    budgets.push(MIN_BUDGET + Math.floor(random() * (MAX_BUDGET - MIN_BUDGET)));
  }

  it.each(budgets)("budget=%i", (budget) => {
    for (const [tool, text] of everyRender({ budget, staleness })) {
      expect(estimateTokens(text), `${tool} exceeded ${budget} tokens`).toBeLessThanOrEqual(budget);
      expect(text.length, `${tool} exceeded ${budget * 4} chars`).toBeLessThanOrEqual(budget * 4);
    }
  });
});

describe("truncation is explicit and actionable", () => {
  it("cut lists end with a +N more hint pointing at a follow-up call", () => {
    const text = renderOverview(overviewView(index), { budget: 400, staleness });
    expect(text).toContain("… +");
    expect(text).toContain("budget_tokens=");
  });

  it("small budgets still yield the header and the headline", () => {
    const text = renderOverview(overviewView(index), { budget: MIN_BUDGET, staleness });
    expect(text).toContain("graph@aabbccdd");
    expect(text).toContain("30 modules");
  });

  it("a large budget renders the synthetic graph without truncation", () => {
    const text = renderOverview(overviewView(index), { budget: MAX_BUDGET, staleness });
    expect(text).not.toContain("… +");
    expect(text).toContain("mod:area-29");
  });
});

describe("staleness header", () => {
  it("names the sha, branch, tree state and age of the graph", () => {
    const lines = stalenessLines(staleness);
    expect(lines).toEqual(["graph@aabbccdd · main · clean · analyzed 5m ago"]);
  });

  it("warns when HEAD has moved past the analyzed sha", () => {
    const lines = stalenessLines({ ...staleness, currentSha: "ffee00112233" });
    expect(lines[1]).toContain("⚠ stale: HEAD is now ffee0011");
    expect(lines[1]).toContain("archscope analyze");
  });

  it("degrades gracefully without git", () => {
    const lines = stalenessLines({ createdAt: "2026-01-01T00:00:00.000Z", now: staleness.now });
    expect(lines).toEqual(["graph (no git) · analyzed 5m ago"]);
  });
});

describe("BudgetWriter", () => {
  it("never exceeds its budget even when single lines are oversized", () => {
    const w = new BudgetWriter(MIN_BUDGET);
    const accepted = w.line("x".repeat(10_000));
    expect(accepted).toBe(false);
    expect(w.line("short line")).toBe(true);
    expect(estimateTokens(w.toString())).toBeLessThanOrEqual(MIN_BUDGET);
  });

  it("reserves room for the hint before committing list items", () => {
    const w = new BudgetWriter(MIN_BUDGET);
    const items = Array.from({ length: 100 }, (_, i) => `- item number ${i} with some padding`);
    const written = w.list(items, (n) => `… +${n} more → refetch(budget_tokens=1000)`);
    expect(written).toBeLessThan(items.length);
    expect(w.toString()).toContain(`… +${items.length - written} more`);
    expect(estimateTokens(w.toString())).toBeLessThanOrEqual(MIN_BUDGET);
  });

  it("writes everything when it fits, with no hint", () => {
    const w = new BudgetWriter(MAX_BUDGET);
    const written = w.list(["- a", "- b"], (n) => `… +${n} more`);
    expect(written).toBe(2);
    expect(w.toString()).toBe("- a\n- b");
  });
});
