import type { ImportFact } from "../parse/facts.js";
import type { PyResolver } from "./py-resolver.js";
import type { Resolution, TsResolver } from "./ts-resolver.js";

/**
 * The resolver seam between parse and graph build. One ImportFact can map to
 * SEVERAL edges (Python's `from . import a, b` is one statement but two file
 * dependencies), so resolution returns a list, each with the symbol names
 * that belong on that edge.
 */

export interface ResolvedImport {
  resolution: Resolution;
  /** The subset of the import's names attributed to this target. */
  symbols: string[];
}

export interface ImportResolver {
  resolveImport(importerRelPath: string, imp: ImportFact): ResolvedImport[];
}

/** Dispatches on the importer's language. The graph build sees one resolver. */
export class CombinedResolver implements ImportResolver {
  constructor(
    private readonly ts: TsResolver,
    private readonly py: PyResolver,
  ) {}

  resolveImport(importerRelPath: string, imp: ImportFact): ResolvedImport[] {
    if (importerRelPath.endsWith(".py")) {
      return this.py.resolveImport(importerRelPath, imp);
    }
    return [{ resolution: this.ts.resolve(importerRelPath, imp.specifier), symbols: imp.symbols }];
  }
}
