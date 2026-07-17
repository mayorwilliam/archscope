import type { EntityField, Orm } from "@archscope/schema";

/**
 * DeclaredSchema: the ORM-neutral intermediate every static extractor emits.
 * Prisma, SQLAlchemy (and later TypeORM/Drizzle/Django) all reduce to this
 * shape, so link.ts and the graph builder never see ORM specifics.
 *
 * Extractors NEVER execute code from the analyzed repo — everything here
 * comes from parsing source text.
 */

export interface DeclaredRelation {
  /** FK column names on THIS entity's table (already mapped, not field names). */
  columns: string[];
  /**
   * Exactly one of the two targets is set: Prisma relations reference a model
   * (resolved to its table by link.ts); SQLAlchemy's ForeignKey("t.c") names
   * the table directly.
   */
  targetEntity?: string;
  targetTable?: string;
  targetSchema?: string;
  /**
   * Referenced identifiers on the target: field names for targetEntity
   * (resolved to columns by link.ts), column names for targetTable.
   */
  references: string[];
}

export interface DeclaredEntity {
  name: string;
  /** Repo-relative, forward slashes — same convention as FileFacts.path. */
  filePath: string;
  orm: Orm;
  /** Table name, unqualified. */
  table: string;
  /** DB schema; "public" unless the source declares one. */
  schema: string;
  /**
   * True when the table name was written in the source (@@map, __tablename__)
   * → maps_to is `certain`. False when derived by ORM convention → `inferred`.
   */
  tableExplicit: boolean;
  fields: EntityField[];
  relations: DeclaredRelation[];
  startLine: number;
  endLine: number;
}

export const DEFAULT_DB_SCHEMA = "public";

/** `schema.table` — the grouping key used by link.ts and drift.ts. */
export function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}
