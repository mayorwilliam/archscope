import { loadConfig, Store } from "@archmap/core";
import {
  computeDrift,
  type DeclaredTableInput,
  type DriftReport,
  detectAlembic,
  introspectMysql,
  introspectPostgres,
  type LiveSchema,
  mergeLiveSchema,
} from "@archmap/db";
import type { ArchGraph, DbLiveSource } from "@archmap/schema";

/**
 * `archmap db introspect` — introspect the live DB and MERGE it into
 * graph.json (origin both/live, drift entries, meta.live). `archmap db drift`
 * — same comparison, report only, exit 1 when drift exists (CI-friendly).
 *
 * The connection URL is read from the env var NAMED in .archmap.yaml
 * (db.live[].urlEnv), lives only in this process, and is never printed nor
 * persisted — errors from the driver are redacted upstream.
 */

export async function runDbIntrospect(
  rootDir: string,
  options: { source?: string },
): Promise<void> {
  const { store, graph, live, source } = await introspectFromConfig(rootDir, options);

  const { graph: merged, drift } = mergeLiveSchema(graph, live, {
    source: source.name,
    dialect: source.dialect,
    introspectedAt: new Date().toISOString(),
  });
  const outPath = store.saveGraph(merged);

  const tables = merged.nodes.filter((n) => n.kind === "table");
  const both = tables.filter((n) => n.attrs.kind === "table" && n.attrs.origin === "both").length;
  const liveOnly = tables.filter(
    (n) => n.attrs.kind === "table" && n.attrs.origin === "live",
  ).length;
  console.log(
    `Introspected "${source.name}" (${source.dialect}): ${live.tables.length} live tables — ` +
      `${both} matched, ${liveOnly} live-only, ${tables.length - both - liveOnly} declared-only`,
  );
  console.log(driftSummary(drift));
  console.log(`Graph updated at ${outPath}`);
}

export async function runDbDrift(
  rootDir: string,
  options: { source?: string; json?: boolean },
): Promise<void> {
  const { graph, live } = await introspectFromConfig(rootDir, options);
  const drift = computeDrift(declaredTables(graph), live);

  if (options.json) {
    console.log(JSON.stringify(Object.fromEntries(drift.byTable), null, 2));
  } else if (drift.total === 0) {
    console.log(`✓ No drift: ${drift.tablesChecked} declared tables match the live database.`);
  } else {
    console.log(driftSummary(drift));
    for (const [table, entries] of drift.byTable) {
      console.log(`\n${table}`);
      for (const entry of entries) console.log(`  ⚠ ${entry.kind}: ${entry.detail}`);
    }
  }
  logAlembicHint(rootDir);
  if (drift.total > 0) process.exitCode = 1;
}

/**
 * Best-effort context line: when the repo manages its schema with alembic,
 * drift readers want to know how many migrations exist and where the head is.
 * Purely informational — never part of the graph, never affects the exit code.
 */
function logAlembicHint(rootDir: string): void {
  const alembic = detectAlembic(rootDir);
  if (!alembic) return;
  console.log(
    `ℹ alembic: ${alembic.count} migrations in ${alembic.versionsDir}, ` +
      `head${alembic.heads.length > 1 ? "s" : ""} ${alembic.heads.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------

async function introspectFromConfig(
  rootDir: string,
  options: { source?: string },
): Promise<{ store: Store; graph: ArchGraph; live: LiveSchema; source: DbLiveSource }> {
  const store = new Store(rootDir);
  const graph = store.loadGraph();
  if (!graph) {
    throw new Error("No graph found — run `archmap analyze` first.");
  }

  const sources = loadConfig(rootDir).db?.live ?? [];
  const source = pickSource(sources, options.source);

  const url = process.env[source.urlEnv];
  if (!url) {
    throw new Error(
      `Env var ${source.urlEnv} (source "${source.name}") is not set. ` +
        `Export it with the connection URL — it is never persisted.`,
    );
  }

  if (source.dialect === "mysql") {
    // "public" is the unqualified-declaration placeholder — on MySQL it maps
    // to the connection's database, which the introspector scopes to itself.
    const schemas = declaredSchemas(graph).filter((s) => s !== "public");
    const live = await introspectMysql(url, schemas.length > 0 ? { schemas } : {});
    return { store, graph, live, source };
  }
  const schemas = declaredSchemas(graph);
  const live = await introspectPostgres(url, schemas.length > 0 ? { schemas } : {});
  return { store, graph, live, source };
}

function pickSource(sources: DbLiveSource[], name?: string): DbLiveSource {
  if (sources.length === 0) {
    throw new Error(
      "No live DB sources configured. Add to .archmap.yaml:\n" +
        "  db:\n    live:\n      - name: main\n        dialect: postgres\n        urlEnv: DATABASE_URL",
    );
  }
  if (name === undefined) {
    if (sources.length === 1) return sources[0] as DbLiveSource;
    const names = sources.map((s) => s.name).join(", ");
    throw new Error(`Several live sources configured (${names}) — pass --source <name>.`);
  }
  const found = sources.find((s) => s.name === name);
  if (!found) {
    throw new Error(
      `Unknown source "${name}". Configured: ${sources.map((s) => s.name).join(", ")}`,
    );
  }
  return found;
}

function declaredTables(graph: ArchGraph): DeclaredTableInput[] {
  const tables: DeclaredTableInput[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "table" || node.attrs.kind !== "table") continue;
    if (node.attrs.origin === "live") continue; // previous overlay, not code truth
    const rest = node.id.startsWith("tbl:") ? node.id.slice(4) : node.id;
    const dot = rest.indexOf(".");
    tables.push({
      schema: dot === -1 ? "public" : rest.slice(0, dot),
      name: dot === -1 ? node.name : rest.slice(dot + 1),
      columns: node.attrs.columns,
    });
  }
  return tables;
}

/** Only the schemas the code declares tables in — keeps shared DBs quiet. */
function declaredSchemas(graph: ArchGraph): string[] {
  return [...new Set(declaredTables(graph).map((t) => t.schema))].sort();
}

function driftSummary(drift: DriftReport): string {
  return drift.total === 0
    ? `✓ No drift across ${drift.tablesChecked} declared tables.`
    : `⚠ ${drift.total} drift findings across ${drift.byTable.size} tables ` +
        `(${drift.tablesChecked} declared tables checked) — see \`archmap db drift\` or get_schema_drift.`;
}
