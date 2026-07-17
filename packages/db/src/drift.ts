import type { DriftEntry, TableColumn } from "@archscope/schema";
import { DEFAULT_DB_SCHEMA, tableKey } from "./declared.js";
import type { LiveSchema, LiveTable } from "./introspect.js";

/**
 * drift.ts: declared (code) vs live (database), per table. The comparison is
 * scoped to the DB schemas the code declares tables in — a shared database
 * full of unrelated schemas must not drown the report.
 *
 * Types are compared by normalized FAMILY (String ≈ varchar ≈ text), because
 * every ORM and every dialect spells the same storage class differently.
 * A declared type we can't classify ("unknown") is never reported as a
 * mismatch — no fabricated findings.
 */

export interface DeclaredTableInput {
  schema: string;
  name: string;
  columns: TableColumn[];
}

export interface DriftReport {
  /** `schema.table` → entries. Only tables WITH drift appear. */
  byTable: Map<string, DriftEntry[]>;
  total: number;
  /** How many declared tables were checked against the live DB. */
  tablesChecked: number;
}

export function computeDrift(declared: DeclaredTableInput[], live: LiveSchema): DriftReport {
  const byTable = new Map<string, DriftEntry[]>();
  const push = (key: string, entry: DriftEntry) => {
    const list = byTable.get(key);
    if (list) list.push(entry);
    else byTable.set(key, [entry]);
  };

  // An unqualified declared table lives in the connection's default namespace
  // ("public" on Postgres, the database on MySQL) — map the declared side for
  // matching; report keys carry the live-real name.
  const defaultSchema = live.defaultSchema ?? DEFAULT_DB_SCHEMA;
  const mapSchema = (schema: string) => (schema === DEFAULT_DB_SCHEMA ? defaultSchema : schema);

  const declaredSchemas = new Set(declared.map((t) => mapSchema(t.schema)));
  const liveByKey = new Map(live.tables.map((t) => [tableKey(t.schema, t.name), t]));
  const declaredKeys = new Set(declared.map((t) => tableKey(mapSchema(t.schema), t.name)));

  for (const table of declared) {
    const key = tableKey(mapSchema(table.schema), table.name);
    const liveTable = liveByKey.get(key);
    if (!liveTable) {
      push(key, {
        kind: "table_missing_in_db",
        detail: `${key} is declared in code but missing in the live database`,
      });
      continue;
    }
    for (const entry of compareTable(table, liveTable)) push(key, entry);
  }

  for (const [key, liveTable] of liveByKey) {
    if (declaredKeys.has(key) || !declaredSchemas.has(liveTable.schema)) continue;
    push(key, {
      kind: "table_missing_in_code",
      detail: `${key} exists in the live database but is not declared in code`,
    });
  }

  const sortedByTable = new Map(
    [...byTable.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entries]) => [
        key,
        [...entries].sort(
          (a, b) => a.kind.localeCompare(b.kind) || a.detail.localeCompare(b.detail),
        ),
      ]),
  );
  let total = 0;
  for (const entries of sortedByTable.values()) total += entries.length;
  return { byTable: sortedByTable, total, tablesChecked: declared.length };
}

// ---------------------------------------------------------------------------

function compareTable(declared: DeclaredTableInput, live: LiveTable): DriftEntry[] {
  const entries: DriftEntry[] = [];
  const liveByName = new Map(live.columns.map((c) => [c.name, c]));
  const declaredNames = new Set(declared.columns.map((c) => c.name));

  for (const column of declared.columns) {
    const liveColumn = liveByName.get(column.name);
    if (!liveColumn) {
      entries.push({
        kind: "column_missing_in_db",
        column: column.name,
        detail: `${column.name} (declared ${column.sqlType}) is missing in the live table`,
      });
      continue;
    }
    const declaredFamily = normalizeSqlType(column.sqlType);
    const liveFamily = normalizeSqlType(liveColumn.sqlType);
    if (declaredFamily !== "unknown" && declaredFamily !== liveFamily) {
      entries.push({
        kind: "type_mismatch",
        column: column.name,
        detail: `${column.name}: declared ${column.sqlType} (${declaredFamily}) vs live ${liveColumn.sqlType} (${liveFamily})`,
      });
    }
    if (column.nullable !== liveColumn.nullable) {
      entries.push({
        kind: "nullability_mismatch",
        column: column.name,
        detail: `${column.name}: declared ${column.nullable ? "nullable" : "not null"} vs live ${
          liveColumn.nullable ? "nullable" : "not null"
        }`,
      });
    }
  }

  for (const liveColumn of live.columns) {
    if (declaredNames.has(liveColumn.name)) continue;
    entries.push({
      kind: "column_missing_in_code",
      column: liveColumn.name,
      detail: `${liveColumn.name} (live ${liveColumn.sqlType}) is not declared in code`,
    });
  }

  // FK pairs: declared fkTo annotations vs live constraints, flattened to
  // column granularity so composite keys compare cleanly.
  const declaredPairs = new Set<string>();
  for (const column of declared.columns) {
    if (column.fkTo) declaredPairs.add(`${column.name}→${column.fkTo.table}.${column.fkTo.column}`);
  }
  const livePairs = new Set<string>();
  for (const fk of live.fks) {
    fk.fromColumns.forEach((from, i) => {
      livePairs.add(`${from}→${fk.toSchema}.${fk.toTable}.${fk.toColumns[i] ?? ""}`);
    });
  }
  for (const pair of declaredPairs) {
    if (!livePairs.has(pair)) {
      entries.push({
        kind: "fk_missing_in_db",
        column: pair.split("→")[0] as string,
        detail: `declared FK ${pair.replace("→", " → ")} has no constraint in the live database`,
      });
    }
  }
  for (const pair of livePairs) {
    if (!declaredPairs.has(pair)) {
      entries.push({
        kind: "fk_missing_in_code",
        column: pair.split("→")[0] as string,
        detail: `live FK ${pair.replace("→", " → ")} is not declared in code`,
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------

/**
 * ORM/dialect type spellings → storage family. Unknown spellings normalize
 * to their own lowercased base so same-vs-same still matches, and callers
 * treat the literal "unknown" (extractor couldn't tell) as incomparable.
 */
const TYPE_FAMILIES: Record<string, string> = {
  // Prisma scalars
  string: "text",
  int: "integer",
  bigint: "bigint",
  float: "double",
  decimal: "numeric",
  boolean: "boolean",
  datetime: "timestamp",
  json: "json",
  bytes: "bytea",
  // SQLAlchemy types + Python annotations
  integer: "integer",
  biginteger: "bigint",
  smallinteger: "integer",
  text: "text",
  str: "text",
  unicode: "text",
  unicodetext: "text",
  numeric: "numeric",
  double: "double",
  double_precision: "double",
  bool: "boolean",
  "datetime.datetime": "timestamp",
  date: "date",
  time: "time",
  largebinary: "bytea",
  jsonb: "json",
  uuid: "uuid",
  // Postgres udt names
  int2: "integer",
  int4: "integer",
  int8: "bigint",
  serial: "integer",
  bigserial: "bigint",
  varchar: "text",
  bpchar: "text",
  char: "text",
  float4: "double",
  float8: "double",
  timestamp: "timestamp",
  timestamptz: "timestamp",
  timetz: "time",
  bytea: "bytea",
  // TypeORM / Drizzle builder names not covered above
  smallserial: "integer",
  smallint: "integer",
  mediumint: "integer",
  tinyint: "integer",
  "tinyint(1)": "boolean", // MySQL's boolean, by universal ORM convention
  real: "double",
  doubleprecision: "double",
  // MySQL information_schema DATA_TYPE spellings
  longtext: "text",
  mediumtext: "text",
  tinytext: "text",
  binary: "bytea",
  varbinary: "bytea",
  blob: "bytea",
  longblob: "bytea",
  mediumblob: "bytea",
  tinyblob: "bytea",
  year: "integer",
  // Django field class names (CharField, ...) — lowercased by normalize
  charfield: "text",
  textfield: "text",
  emailfield: "text",
  urlfield: "text",
  slugfield: "text",
  filefield: "text",
  filepathfield: "text",
  imagefield: "text",
  genericipaddressfield: "text",
  integerfield: "integer",
  positiveintegerfield: "integer",
  smallintegerfield: "integer",
  positivesmallintegerfield: "integer",
  bigintegerfield: "bigint",
  positivebigintegerfield: "bigint",
  floatfield: "double",
  decimalfield: "numeric",
  booleanfield: "boolean",
  datetimefield: "timestamp",
  datefield: "date",
  timefield: "time",
  durationfield: "interval",
  uuidfield: "uuid",
  jsonfield: "json",
  binaryfield: "bytea",
};

export function normalizeSqlType(raw: string): string {
  const lower = raw.toLowerCase().trim();
  // Width-qualified spellings first — tinyint(1) means boolean, tinyint(4) int.
  const exact = TYPE_FAMILIES[lower];
  if (exact) return exact;
  const base = lower.replace(/\(.*\)$/, "").trim();
  const direct = TYPE_FAMILIES[base];
  if (direct) return direct;
  const lastSegment = base.split(".").pop() ?? base;
  return TYPE_FAMILIES[lastSegment] ?? lastSegment;
}
