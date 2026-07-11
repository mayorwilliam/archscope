import mysql from "mysql2/promise";
import type { IntrospectOptions, LiveFk, LiveSchema, LiveTable } from "./introspect.js";
import { redactSecret } from "./introspect.js";

/**
 * Live MySQL introspection: information_schema, SELECTs only, with the
 * session forced read-only as belt-and-suspenders. In MySQL schema == database
 * — the connection's database becomes LiveSchema.defaultSchema so drift/merge
 * can map unqualified declared tables onto it.
 *
 * CREDENTIALS ARE RADIOACTIVE — same contract as the Postgres introspector:
 * the URL arrives as a value, is never returned, never persisted, and every
 * error that could echo it back is redacted before it propagates.
 */

const SYSTEM_SCHEMAS = ["mysql", "information_schema", "performance_schema", "sys"];

export async function introspectMysql(
  url: string,
  options: IntrospectOptions = {},
): Promise<LiveSchema> {
  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection(url);
    await connection.query("SET SESSION TRANSACTION READ ONLY");

    const [dbRows] = await connection.query("SELECT DATABASE() AS db");
    const currentDb = (dbRows as Array<{ db: string | null }>)[0]?.db ?? null;

    // Scope: explicit schemas + the connection's database; with neither,
    // every non-system schema (mirrors the Postgres default).
    const scope = [...new Set([...(options.schemas ?? []), ...(currentDb ? [currentDb] : [])])];
    const tables = await loadTables(connection, scope);
    return {
      dialect: "mysql",
      ...(currentDb !== null ? { defaultSchema: currentDb } : {}),
      tables,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactSecret(message, url));
  } finally {
    await connection?.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------

async function loadTables(connection: mysql.Connection, scope: string[]): Promise<LiveTable[]> {
  const filter = scope.length > 0 ? "table_schema IN (?)" : "table_schema NOT IN (?)";
  const filterValue = scope.length > 0 ? scope : SYSTEM_SCHEMAS;

  const [tableRows] = await connection.query(
    `SELECT table_schema AS table_schema, table_name AS table_name
       FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND ${filter}
      ORDER BY table_schema, table_name`,
    [filterValue],
  );

  const byKey = new Map<string, LiveTable>();
  for (const row of tableRows as Array<{ table_schema: string; table_name: string }>) {
    byKey.set(`${row.table_schema}.${row.table_name}`, {
      schema: row.table_schema,
      name: row.table_name,
      columns: [],
      fks: [],
    });
  }

  const [columnRows] = await connection.query(
    `SELECT table_schema AS table_schema, table_name AS table_name,
            column_name AS column_name, data_type AS data_type,
            column_type AS column_type, is_nullable AS is_nullable,
            column_key AS column_key
       FROM information_schema.columns
      WHERE ${filter}
      ORDER BY table_schema, table_name, ordinal_position`,
    [filterValue],
  );
  for (const row of columnRows as Array<{
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    column_type: string;
    is_nullable: string;
    column_key: string;
  }>) {
    // tinyint(1) is MySQL's boolean by universal ORM convention — report the
    // width-qualified spelling so type families can classify it as boolean.
    const sqlType = row.column_type === "tinyint(1)" ? "tinyint(1)" : row.data_type;
    byKey.get(`${row.table_schema}.${row.table_name}`)?.columns.push({
      name: row.column_name,
      sqlType,
      nullable: row.is_nullable === "YES",
      isPk: row.column_key === "PRI",
    });
  }

  // key_column_usage carries from- AND to-column on the same row, so composite
  // keys pair by ordinal_position without any unnesting gymnastics.
  const [fkRows] = await connection.query(
    `SELECT table_schema AS table_schema, table_name AS table_name,
            constraint_name AS constraint_name, column_name AS column_name,
            referenced_table_schema AS referenced_table_schema,
            referenced_table_name AS referenced_table_name,
            referenced_column_name AS referenced_column_name
       FROM information_schema.key_column_usage
      WHERE referenced_table_name IS NOT NULL AND ${filter}
      ORDER BY table_schema, table_name, constraint_name, ordinal_position`,
    [filterValue],
  );
  const fkByConstraint = new Map<string, LiveFk & { owner: string }>();
  for (const row of fkRows as Array<{
    table_schema: string;
    table_name: string;
    constraint_name: string;
    column_name: string;
    referenced_table_schema: string;
    referenced_table_name: string;
    referenced_column_name: string;
  }>) {
    const key = `${row.table_schema}.${row.table_name}.${row.constraint_name}`;
    let fk = fkByConstraint.get(key);
    if (!fk) {
      fk = {
        owner: `${row.table_schema}.${row.table_name}`,
        fromColumns: [],
        toSchema: row.referenced_table_schema,
        toTable: row.referenced_table_name,
        toColumns: [],
      };
      fkByConstraint.set(key, fk);
    }
    fk.fromColumns.push(row.column_name);
    fk.toColumns.push(row.referenced_column_name);
  }
  for (const { owner, ...fk } of fkByConstraint.values()) {
    byKey.get(owner)?.fks.push(fk);
  }

  return [...byKey.values()];
}
