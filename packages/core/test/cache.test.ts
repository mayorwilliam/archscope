import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/pipeline.js";
import { fixturePath, normalizeGraph } from "./helpers.js";

/**
 * The incremental cache contract: correctness is free (same graph with or
 * without cache) and invalidation is per-file (touch one file, re-extract
 * exactly that file).
 */

describe("incremental facts cache", () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "archmap-cache-"));
    fs.cpSync(fixturePath("py-basic"), root, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (cache: Parameters<typeof analyze>[0]["cache"]) =>
    analyze({
      rootDir: root,
      createdAt: "1970-01-01T00:00:00.000Z",
      toolVersion: "test",
      cache,
    });

  it("cold run extracts everything, warm run hits 100%", async () => {
    const cold = await run(true);
    expect(cold.cache).toEqual({ hits: 0, misses: 10 });

    const warm = await run(true);
    expect(warm.cache).toEqual({ hits: 10, misses: 0 });

    // The cache must be invisible in the output: byte-identical graphs.
    expect(normalizeGraph(warm.graph)).toEqual(normalizeGraph(cold.graph));
  });

  it("touching one file re-extracts exactly that file", async () => {
    fs.appendFileSync(path.join(root, "src/app/config.py"), "\nTOUCHED = True\n");

    const result = await run(true);
    expect(result.cache).toEqual({ hits: 9, misses: 1 });

    const touched = result.graph.nodes.find((n) => n.id === "sym:src/app/config.py#TOUCHED");
    expect(touched).toBeDefined();
  });

  it("refresh bypasses reads but repopulates the cache", async () => {
    const refreshed = await run({ refresh: true });
    expect(refreshed.cache).toEqual({ hits: 0, misses: 10 });

    const warm = await run(true);
    expect(warm.cache).toEqual({ hits: 10, misses: 0 });
  });

  it("cache: false never reads nor writes the cache dir", async () => {
    const before = fs.readdirSync(path.join(root, ".archmap/cache")).length;
    const result = await run(false);
    expect(result.cache).toEqual({ hits: 0, misses: 10 });
    expect(fs.readdirSync(path.join(root, ".archmap/cache")).length).toBe(before);
  });
});
