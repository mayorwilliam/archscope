import type { TableColumn } from "@archscope/schema";
import { entityId, tableId } from "@archscope/schema";
import { type DeclaredEntity, tableKey } from "./declared.js";

/**
 * link.ts: entity ↔ table. THE differentiator edge — maps_to is what lets a
 * question about `public.users` reach the code that owns it.
 *
 * Confidence is the honest part: a table name written in the source
 * (@@map, __tablename__) links `certain`; a name derived from ORM convention
 * (Prisma model name → table) links `inferred`. Consumers surface the
 * difference — the linker never upgrades a guess to a fact.
 */

export interface LinkedEntity {
  entity: DeclaredEntity;
  id: string;
  tableId: string;
  confidence: "certain" | "inferred";
}

export interface LinkedTable {
  id: string;
  schema: string;
  name: string;
  columns: TableColumn[];
}

export interface LinkedFk {
  fromTableId: string;
  toTableId: string;
  /** [fromColumn, toColumn] pairs; multiple FKs between two tables merge here. */
  columns: Array<[string, string]>;
}

export interface LinkedDbSchema {
  entities: LinkedEntity[];
  tables: LinkedTable[];
  fks: LinkedFk[];
}

export function linkDeclaredSchema(declared: DeclaredEntity[]): LinkedDbSchema {
  // Deterministic regardless of extraction order.
  const sorted = [...declared].sort((a, b) =>
    entityId(a.filePath, a.name).localeCompare(entityId(b.filePath, b.name)),
  );
  const byName = new Map<string, DeclaredEntity>();
  for (const entity of sorted) {
    if (!byName.has(entity.name)) byName.set(entity.name, entity);
  }

  const entities: LinkedEntity[] = [];
  const tables = new Map<string, LinkedTable>();

  for (const entity of sorted) {
    const tid = tableId(entity.schema, entity.table);
    entities.push({
      entity,
      id: entityId(entity.filePath, entity.name),
      tableId: tid,
      confidence: entity.tableExplicit ? "certain" : "inferred",
    });

    let table = tables.get(tid);
    if (!table) {
      table = { id: tid, schema: entity.schema, name: entity.table, columns: [] };
      tables.set(tid, table);
    }
    for (const field of entity.fields) {
      const columnName = field.column ?? field.name;
      // Two entities over one table: first (by entity id) wins per column.
      if (table.columns.some((c) => c.name === columnName)) continue;
      table.columns.push({
        name: columnName,
        sqlType: field.type,
        nullable: field.nullable,
        isPk: field.isPk,
      });
    }
  }

  const fks = new Map<string, LinkedFk>();
  for (const { entity, tableId: fromTableId } of entities) {
    for (const relation of entity.relations) {
      const target = resolveTarget(relation, byName);
      if (!target) continue;
      const key = `${fromTableId}→${target.tableId}`;
      const existing = fks.get(key);
      const fk: LinkedFk = existing ?? { fromTableId, toTableId: target.tableId, columns: [] };
      if (!existing) fks.set(key, fk);
      relation.columns.forEach((fromColumn, i) => {
        const toColumn = target.columns[i] ?? target.columns[0] ?? "id";
        if (!fk.columns.some(([f, t]) => f === fromColumn && t === toColumn)) {
          fk.columns.push([fromColumn, toColumn]);
        }
        annotateFkColumn(tables.get(fromTableId), fromColumn, target, toColumn);
      });
    }
  }

  const sortedTables = [...tables.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const table of sortedTables) table.columns.sort((a, b) => a.name.localeCompare(b.name));
  const sortedFks = [...fks.values()].sort(
    (a, b) => a.fromTableId.localeCompare(b.fromTableId) || a.toTableId.localeCompare(b.toTableId),
  );
  for (const fk of sortedFks) fk.columns.sort((a, b) => a[0].localeCompare(b[0]));

  return { entities, tables: sortedTables, fks: sortedFks };
}

// ---------------------------------------------------------------------------

interface ResolvedTarget {
  tableId: string;
  tableKeyName: string;
  /** Referenced COLUMN names, in relation order. */
  columns: string[];
}

/**
 * Prisma relations reference a model and its FIELD names; SQLAlchemy names
 * the table and its columns directly. Both normalize here. An unresolvable
 * target (model outside the schema) drops the FK — absence over guessing.
 */
function resolveTarget(
  relation: DeclaredEntity["relations"][number],
  byName: Map<string, DeclaredEntity>,
): ResolvedTarget | null {
  if (relation.targetTable !== undefined) {
    const schema = relation.targetSchema ?? "public";
    return {
      tableId: tableId(schema, relation.targetTable),
      tableKeyName: tableKey(schema, relation.targetTable),
      columns: relation.references,
    };
  }
  if (relation.targetEntity !== undefined) {
    const target = byName.get(relation.targetEntity);
    if (!target) return null;
    const columns = relation.references.map((fieldName) => {
      const field = target.fields.find((f) => f.name === fieldName);
      return field ? (field.column ?? field.name) : fieldName;
    });
    return {
      tableId: tableId(target.schema, target.table),
      tableKeyName: tableKey(target.schema, target.table),
      columns,
    };
  }
  return null;
}

function annotateFkColumn(
  table: LinkedTable | undefined,
  columnName: string,
  target: ResolvedTarget,
  toColumn: string,
): void {
  const column = table?.columns.find((c) => c.name === columnName);
  if (column && column.fkTo === undefined) {
    column.fkTo = { table: target.tableKeyName, column: toColumn };
  }
}
