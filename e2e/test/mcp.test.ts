import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "@archmap/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeAndSave,
  connectHarness,
  generateRepo,
  git,
  type Harness,
  initGitRepo,
  makeTmpDir,
} from "./helpers.js";

/**
 * End-to-end over the real thing: the BUILT CLI spawned as an MCP server,
 * driven by the official SDK client over stdio — exactly how Claude Code
 * will consume it. The repo is synthetic (12 chained modules × 6 files) so
 * every structural number asserted here is exact, and small budgets are
 * guaranteed to force truncation.
 */

const AREAS = 12;
const FILES = 6;

let root: string;
let h: Harness;

beforeAll(async () => {
  root = makeTmpDir("archmap-e2e-");
  generateRepo(root, AREAS, FILES);
  await initGitRepo(root);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "base architecture");

  // Head commit introduces a brand-new cross-module dependency for the diff.
  fs.writeFileSync(
    path.join(root, "area11", "hotpath.ts"),
    'import { helper0 } from "../area0/file-0.js";\nexport const jump = helper0();\n',
  );
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "area11 reaches into area0");

  await analyzeAndSave(root);
  h = await connectHarness(root);
});

afterAll(async () => {
  await h?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const TOOLS = [
  "find_dependencies",
  "get_architecture_diff",
  "get_architecture_overview",
  "get_file_context",
  "get_impact",
  "get_module",
  "search_nodes",
];

/** Happy-path arguments per tool, used by the budget sweep. */
const SWEEP_ARGS: Record<string, Record<string, unknown>> = {
  get_architecture_overview: {},
  get_module: { module: "area3" },
  find_dependencies: { node_id: "area3/file-2.ts" },
  get_impact: { node_id: "area0/file-0.ts" },
  search_nodes: { query: "helper" },
  get_file_context: { path: "area5/file-4.ts" },
  get_architecture_diff: { base: "HEAD~1" },
};

describe("tool surface", () => {
  it("exposes exactly the 7 non-DB tools", async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
  });
});

describe("the 7 tools answer correctly", () => {
  it("get_architecture_overview names every module under a staleness header", async () => {
    const { text, isError } = await h.callText("get_architecture_overview", {});
    expect(isError).toBe(false);
    expect(text).toMatch(/^graph@[0-9a-f]{8} · main · clean/);
    expect(text).toContain("12 modules");
    expect(text).toContain("mod:area0");
  });

  it("get_module reports files and both dependency directions", async () => {
    const { text } = await h.callText("get_module", { module: "area3", budget_tokens: 8000 });
    expect(text).toContain("# mod:area3 — module");
    expect(text).toContain("file:area3/file-5.ts");
    expect(text).toContain("mod:area2"); // depends on
    expect(text).toContain("mod:area4"); // depended on by
  });

  it("find_dependencies splits outgoing and incoming edges", async () => {
    const { text } = await h.callText("find_dependencies", { node_id: "area3/file-2.ts" });
    expect(text).toContain("## Outgoing (1)");
    expect(text).toContain("file:area3/file-1.ts");
    expect(text).toContain("## Incoming (1)");
    expect(text).toContain("file:area3/file-3.ts");
  });

  it("get_impact walks the full transitive chain", async () => {
    const { text } = await h.callText("get_impact", {
      node_id: "area0/file-0.ts",
      budget_tokens: 20000,
    });
    // 72 files total, minus the target itself, plus hotpath.ts → 72.
    expect(text).toContain("72 transitive files across 12 modules");
  });

  it("search_nodes finds symbols and reports their module", async () => {
    const { text } = await h.callText("search_nodes", { query: "helper3", budget_tokens: 8000 });
    expect(text).toContain("sym:area0/file-3.ts#helper3");
    expect(text).toContain("mod:area0");
  });

  it("get_file_context shows exports, imports and importers", async () => {
    const { text } = await h.callText("get_file_context", { path: "area5/file-4.ts" });
    expect(text).toContain("# file:area5/file-4.ts");
    expect(text).toContain("helper4");
    expect(text).toContain("file:area5/file-3.ts");
    expect(text).toContain("file:area5/file-5.ts");
  });

  it("get_architecture_diff reports the new cross-module dependency", async () => {
    const { text } = await h.callText("get_architecture_diff", {
      base: "HEAD~1",
      budget_tokens: 8000,
    });
    expect(text).toContain("+ mod:area11 → mod:area0");
    expect(text).toContain("1 added · 0 removed · 0 moved");
  });

  it("unknown references fail with suggestions, not silence", async () => {
    const { text, isError } = await h.callText("get_module", { module: "aera3" });
    expect(isError).toBe(true);
    expect(text).toContain('Not found: "aera3"');
    expect(text).toContain("search_nodes");
  });
});

describe("budget guarantee (asserted in chars)", () => {
  const budgets = [200, 500, 2000, 20000];
  for (const tool of TOOLS) {
    it.each(budgets)(`${tool} fits budget=%i`, async (budget) => {
      const args = { ...SWEEP_ARGS[tool], budget_tokens: budget };
      const { text, isError } = await h.callText(tool, args);
      expect(isError).toBe(false);
      expect(text.length).toBeLessThanOrEqual(budget * 4);
      expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
    });
  }
});

describe("drill-down hints are executable calls", () => {
  const PRIMARY_PARAM: Record<string, string | null> = {
    get_architecture_overview: null,
    get_module: "module",
    find_dependencies: "node_id",
    get_impact: "node_id",
    search_nodes: "query",
    get_file_context: "path",
  };

  it("a truncated overview hints a call that succeeds and fits ITS budget", async () => {
    const { text } = await h.callText("get_architecture_overview", { budget_tokens: 200 });
    const hint = /… \+\d+ more → ([a-z_]+)\((.*)\)/.exec(text);
    expect(hint, `no drill-down hint in:\n${text}`).not.toBeNull();

    const [, tool, rawArgs] = hint as unknown as [string, string, string];
    const budgetMatch = /budget_tokens=(\d+)/.exec(rawArgs);
    const quoted = [...rawArgs.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const budget = Number(budgetMatch?.[1] ?? 2000);

    const args: Record<string, unknown> = { budget_tokens: budget };
    const param = PRIMARY_PARAM[tool];
    if (param && quoted[0] !== undefined) args[param] = quoted[0];

    const followUp = await h.callText(tool, args);
    expect(followUp.isError).toBe(false);
    expect(estimateTokens(followUp.text)).toBeLessThanOrEqual(budget);
  });

  it("a truncated search hints the same query with a bigger budget", async () => {
    const { text } = await h.callText("search_nodes", { query: "helper", budget_tokens: 200 });
    expect(text).toContain("… +");
    expect(text).toContain('search_nodes("helper", budget_tokens=');
  });
});

// Keep last: it moves HEAD, which makes every later response carry a warning.
describe("staleness", () => {
  it("warns as soon as HEAD moves past the analyzed sha", async () => {
    await git(root, "commit", "-q", "--allow-empty", "-m", "move head");
    const { text } = await h.callText("get_architecture_overview", {});
    expect(text).toContain("⚠ stale: HEAD is now");
    expect(text).toContain("archmap analyze");
  });
});
