import fs from "node:fs";
import path from "node:path";
import type { ArchGraph, ArchmapConfig } from "@archmap/schema";
import { loadConfig } from "./config-file.js";
import { gitInfo } from "./git.js";
import { buildGraph } from "./graph/build.js";
import { createModuleInferrer } from "./modules/infer.js";
import type { FileFacts } from "./parse/facts.js";
import { grammarForFile } from "./parse/parser.js";
import { extractPyFacts } from "./parse/py.js";
import { extractTsFacts } from "./parse/ts.js";
import { PyResolver } from "./resolve/py-resolver.js";
import { CombinedResolver } from "./resolve/resolver.js";
import { TsResolver } from "./resolve/ts-resolver.js";
import { discoverWorkspacePackages } from "./resolve/workspace.js";
import { scanSourceFiles } from "./scan.js";

/**
 * The pipeline: scan → parse → resolve → infer → build.
 * Each stage is a pure function over explicit inputs; this file only wires
 * them together. Determinism is the contract — same repo state, same graph.
 */

export interface AnalyzeOptions {
  rootDir: string;
  config?: ArchmapConfig;
  toolVersion?: string;
  /** Injectable for tests; defaults to now. */
  createdAt?: string;
}

export interface AnalyzeResult {
  graph: ArchGraph;
  /** Files skipped because no extractor handles them. */
  skipped: string[];
}

export async function analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const rootDir = path.resolve(options.rootDir);
  const config = options.config ?? loadConfig(rootDir);

  const files = scanSourceFiles(rootDir, config);
  const workspacePackages = discoverWorkspacePackages(rootDir);

  const facts: FileFacts[] = [];
  const skipped: string[] = [];
  for (const relPath of files) {
    const grammar = grammarForFile(relPath);
    if (grammar === null) {
      skipped.push(relPath);
      continue;
    }
    const source = fs.readFileSync(path.join(rootDir, relPath), "utf8");
    facts.push(
      grammar === "python"
        ? await extractPyFacts(relPath, source)
        : await extractTsFacts(relPath, source),
    );
  }

  const resolver = new CombinedResolver(
    new TsResolver(rootDir, workspacePackages),
    new PyResolver(rootDir, config),
  );
  const inferModule = createModuleInferrer(rootDir, config, workspacePackages);
  const git = await gitInfo(rootDir);

  const graph = buildGraph({
    rootDir,
    toolVersion: options.toolVersion ?? "0.0.1",
    facts,
    resolver,
    inferModule,
    config,
    git,
    createdAt: options.createdAt ?? new Date().toISOString(),
  });

  return { graph, skipped };
}
