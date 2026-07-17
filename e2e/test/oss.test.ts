import fs from "node:fs";
import { estimateTokens, indexGraph, overviewView, Store } from "@archscope/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeAndSave, connectHarness, type Harness } from "./helpers.js";

/**
 * Acceptance gate for phase 3, opt-in because it needs a real clone:
 *
 *   TEST_OSS_REPO=/path/to/some-2k-file-repo pnpm -C e2e test
 *
 * Analyzes the repo, serves it over MCP and asserts the budget guarantee in
 * chars for every tool, against nodes picked from the repo's own graph.
 */

const target = process.env.TEST_OSS_REPO;

describe.skipIf(!target)("budget guarantee on a real OSS repo", () => {
  let h: Harness;
  let sampleModule: string;
  let sampleFile: string;

  beforeAll(async () => {
    const root = fs.realpathSync(target as string);
    await analyzeAndSave(root);
    const graph = new Store(root).loadGraph();
    if (!graph) throw new Error("analyze did not produce a graph");
    const view = overviewView(indexGraph(graph));
    const top = view.modules.find((m) => m.files > 0) ?? view.modules[0];
    if (!top) throw new Error("no modules in target repo");
    sampleModule = top.name;
    const file = graph.nodes.find((n) => n.kind === "file" && n.parent === top.id);
    if (!file) throw new Error("no files in top module");
    sampleFile = file.id.slice("file:".length);
    h = await connectHarness(root);
  }, 300_000);

  afterAll(async () => {
    await h?.close();
  });

  const budgets = [200, 1000, 5000, 20000];

  it.each(budgets)("all tools fit budget=%i", async (budget) => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["get_architecture_overview", {}],
      ["get_module", { module: sampleModule }],
      ["find_dependencies", { node_id: sampleFile }],
      ["get_impact", { node_id: sampleFile }],
      ["search_nodes", { query: "test" }],
      ["get_file_context", { path: sampleFile }],
    ];
    for (const [tool, args] of calls) {
      const { text, isError } = await h.callText(tool, { ...args, budget_tokens: budget });
      expect(isError, `${tool} errored: ${text}`).toBe(false);
      expect(text.length, `${tool} at ${budget}`).toBeLessThanOrEqual(budget * 4);
      expect(estimateTokens(text), `${tool} at ${budget}`).toBeLessThanOrEqual(budget);
    }
  });
});
