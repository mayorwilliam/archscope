import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ArchGraph } from "@archscope/schema";
import { expect } from "vitest";
import { analyze } from "../src/pipeline.js";

const FIXTURES = path.resolve(fileURLToPath(import.meta.url), "../../../../fixtures");

export function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

export async function analyzeFixture(name: string): Promise<ArchGraph> {
  const { graph } = await analyze({
    rootDir: fixturePath(name),
    createdAt: "1970-01-01T00:00:00.000Z",
    toolVersion: "test",
    cache: false, // fixtures are inputs — no .archscope/ side effects in them
  });
  return normalizeGraph(graph);
}

/** Strip volatile fields so goldens compare byte-stable structures. */
export function normalizeGraph(graph: ArchGraph): ArchGraph {
  return {
    ...graph,
    meta: {
      ...graph.meta,
      createdAt: "1970-01-01T00:00:00.000Z",
      root: "<fixture>",
      git: null,
      toolVersion: "test",
    },
  };
}

/**
 * Golden comparison. On first run the golden doesn't exist: it is written
 * and the test fails, forcing a human to review the file before committing.
 */
export function expectGolden(graph: ArchGraph, fixtureName: string): void {
  const goldenPath = path.join(FIXTURES, fixtureName, "expected-graph.json");
  const actual = `${JSON.stringify(graph, null, 2)}\n`;
  if (!fs.existsSync(goldenPath)) {
    fs.writeFileSync(goldenPath, actual);
    throw new Error(`Golden created at ${goldenPath} — review it by hand, then re-run the tests.`);
  }
  const expected = fs.readFileSync(goldenPath, "utf8");
  expect(actual).toBe(expected);
}
