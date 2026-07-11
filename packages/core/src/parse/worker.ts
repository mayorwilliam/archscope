import type { FileFacts } from "./facts.js";
import { grammarForFile } from "./parser.js";
import { extractPrismaFacts } from "./prisma.js";
import { extractPyFacts } from "./py.js";
import { extractTsFacts } from "./ts.js";

/**
 * Piscina worker: one file in, FileFacts out. Each worker thread initializes
 * its own tree-sitter WASM runtime lazily (parser.ts singletons are
 * per-thread), so threads never share parser state. Extraction is a pure
 * function of (path, source) — running it on any thread yields identical
 * facts, which is what keeps the parallel pipeline deterministic.
 */

export interface ExtractJob {
  relPath: string;
  source: string;
}

export default async function extract({ relPath, source }: ExtractJob): Promise<FileFacts> {
  if (relPath.endsWith(".prisma")) return extractPrismaFacts(relPath, source);
  const grammar = grammarForFile(relPath);
  if (grammar === "python") return extractPyFacts(relPath, source);
  return extractTsFacts(relPath, source);
}
