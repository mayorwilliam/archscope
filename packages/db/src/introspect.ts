import pg from "pg";

/**
 * Live Postgres introspection: information_schema/pg_catalog, SELECTs only,
 * with the session forced read-only as belt-and-suspenders.
 *
 * CREDENTIALS ARE RADIOACTIVE. The connection URL arrives here as a value
 * (the CLI reads it from an env var by NAME), is never returned, never
 * persisted, and every error that could echo it back is redacted before it
 * propagates. Nothing in LiveSchema contains connection material.
 */

export interface LiveColumn {
  name: string;
  /** Postgres udt_name: int4, varchar, timestamptz, ... */
  sqlType: string;
  nullable: boolean;
  isPk: boolean;
}

export interface LiveFk {
  fromColumns: string[];
  toSchema: string;
  toTable: string;
  toColumns: string[];
}

export interface LiveTable {
  schema: string;
  name: string;
  columns: LiveColumn[];
  fks: LiveFk[];
}

export interface LiveSchema {
  dialect: "postgres" | "mysql";
  /**
   * The namespace an UNQUALIFIED declared table lands in: "public" for
   * Postgres, the connection's database for MySQL (where schema == database).
   * Drift/merge map the declared DEFAULT_DB_SCHEMA onto this for matching —
   * live table names are always reported with their real schema.
   */
  defaultSchema?: string;
  tables: LiveTable[];
}

export interface IntrospectOptions {
  /** Restrict to these DB schemas; default: every non-system schema. */
  schemas?: string[];
}

export async function introspectPostgres(
  url: string,
  options: IntrospectOptions = {},
): Promise<LiveSchema> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    const tables = await loadTables(client, options.schemas);
    return { dialect: "postgres", defaultSchema: "public", tables };
  } catch (error) {
    throw redactError(error, url);
  } finally {
    await client.end().catch(() => {});
  }
}

/** Strip the URL and its password from anything that might get logged. */
export function redactSecret(message: string, url: string): string {
  let out = message.split(url).join("<redacted-db-url>");
  try {
    const parsed = new URL(url);
    if (parsed.password) out = out.split(parsed.password).join("<redacted>");
  } catch {
    // not URL-shaped — the full-string replacement above already covers it
  }
  return out;
}

function redactError(error: unknown, url: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactSecret(message, url));
}

// ---------------------------------------------------------------------------

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

async function loadTables(client: pg.Client, schemas?: string[]): Promise<LiveTable[]> {
  const schemaFilter =
    schemas && schemas.length > 0 ? "AND table_schema = ANY($1)" : "AND table_schema <> ALL($1)";
  const filterValue = schemas && schemas.length > 0 ? schemas : SYSTEM_SCHEMAS;

  const tablesRes = await client.query<{ table_schema: string; table_name: string }>(
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' ${schemaFilter}
      ORDER BY table_schema, table_name`,
    [filterValue],
  );

  const byKey = new Map<string, LiveTable>();
  for (const row of tablesRes.rows) {
    byKey.set(`${row.table_schema}.${row.table_name}`, {
      schema: row.table_schema,
      name: row.table_name,
      columns: [],
      fks: [],
    });
  }

  const columnsRes = await client.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    udt_name: string;
    is_nullable: string;
  }>(
    `SELECT table_schema, table_name, column_name, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema <> ALL($1)
      ORDER BY table_schema, table_name, ordinal_position`,
    [SYSTEM_SCHEMAS],
  );
  for (const row of columnsRes.rows) {
    byKey.get(`${row.table_schema}.${row.table_name}`)?.columns.push({
      name: row.column_name,
      sqlType: row.udt_name,
      nullable: row.is_nullable === "YES",
      isPk: false, // marked below
    });
  }

  const pksRes = await client.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
  }>(
    `SELECT tc.table_schema, tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'`,
  );
  for (const row of pksRes.rows) {
    const column = byKey
      .get(`${row.table_schema}.${row.table_name}`)
      ?.columns.find((c) => c.name === row.column_name);
    if (column) column.isPk = true;
  }

  // pg_catalog (not information_schema) for FKs: unnest WITH ORDINALITY is the
  // only way to pair composite-key columns correctly.
  const fksRes = await client.query<{
    from_schema: string;
    from_table: string;
    to_schema: string;
    to_table: string;
    conname: string;
    from_column: string;
    to_column: string;
  }>(
    `SELECT ns.nspname  AS from_schema,
            cl.relname  AS from_table,
            fns.nspname AS to_schema,
            fcl.relname AS to_table,
            con.conname,
            a.attname   AS from_column,
            fa.attname  AS to_column
       FROM pg_constraint con
       JOIN pg_class cl       ON con.conrelid = cl.oid
       JOIN pg_namespace ns   ON cl.relnamespace = ns.oid
       JOIN pg_class fcl      ON con.confrelid = fcl.oid
       JOIN pg_namespace fns  ON fcl.relnamespace = fns.oid
       JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS ord(k, fk, n) ON true
       JOIN pg_attribute a    ON a.attrelid = cl.oid AND a.attnum = ord.k
       JOIN pg_attribute fa   ON fa.attrelid = fcl.oid AND fa.attnum = ord.fk
      WHERE con.contype = 'f' AND ns.nspname <> ALL($1)
      ORDER BY ns.nspname, cl.relname, con.conname, ord.n`,
    [SYSTEM_SCHEMAS],
  );
  const fkByConstraint = new Map<string, LiveFk & { owner: string }>();
  for (const row of fksRes.rows) {
    const key = `${row.from_schema}.${row.from_table}.${row.conname}`;
    let fk = fkByConstraint.get(key);
    if (!fk) {
      fk = {
        owner: `${row.from_schema}.${row.from_table}`,
        fromColumns: [],
        toSchema: row.to_schema,
        toTable: row.to_table,
        toColumns: [],
      };
      fkByConstraint.set(key, fk);
    }
    fk.fromColumns.push(row.from_column);
    fk.toColumns.push(row.to_column);
  }
  for (const { owner, ...fk } of fkByConstraint.values()) {
    byKey.get(owner)?.fks.push(fk);
  }

  return [...byKey.values()];
}
