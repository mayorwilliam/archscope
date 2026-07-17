import { extractPrismaEntities } from "@archscope/db";
import type { FileFacts } from "./facts.js";

/**
 * .prisma files are declaration-only: no imports, no symbols — their entire
 * contribution to the graph is the entities (and through them, the tables).
 */

export function extractPrismaFacts(relPath: string, source: string): FileFacts {
  const entities = extractPrismaEntities(relPath, source);
  return {
    path: relPath,
    lang: "prisma",
    loc: countLines(source),
    imports: [],
    symbols: [],
    ormHints: entities.map((e) => ({
      framework: "prisma",
      startLine: e.startLine,
      endLine: e.endLine,
    })),
    ...(entities.length > 0 ? { entities } : {}),
  };
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lines++;
  }
  return lines;
}
