import type { DeclaredEntity } from "@archscope/db";
import type { Lang, SymbolKind } from "@archscope/schema";

/**
 * FileFacts: the per-file extraction result. This is the unit of caching —
 * everything downstream (resolution, graph build) is recomputed from facts
 * on every run, so facts must contain no resolved paths or cross-file state.
 */

export type ImportKind = "static" | "dynamic" | "reexport" | "require";

export interface ImportFact {
  /** The raw specifier as written: "./login", "@app/utils", "react". */
  specifier: string;
  /** Named imports, when statically known. Empty for side-effect/dynamic imports. */
  symbols: string[];
  kind: ImportKind;
  line: number;
}

export interface SymbolFact {
  name: string;
  symbolKind: SymbolKind;
  exported: boolean;
  startLine: number;
  endLine: number;
}

export interface OrmHint {
  framework: "prisma" | "typeorm" | "drizzle" | "sqlalchemy" | "django";
  startLine: number;
  endLine: number;
}

export interface FileFacts {
  /** Repo-relative, forward slashes. */
  path: string;
  lang: Lang;
  loc: number;
  imports: ImportFact[];
  symbols: SymbolFact[];
  ormHints: OrmHint[];
  /** ORM entities declared in this file (populated when ormHints is). */
  entities?: DeclaredEntity[];
}
