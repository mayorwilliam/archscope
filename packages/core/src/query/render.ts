import type { ArchDiff, DriftEntry, EntityField, TableColumn } from "@archscope/schema";
import { parseNodeId } from "@archscope/schema";
import { BudgetWriter, clampBudget, suggestBudget } from "./budget.js";
import type {
  DbSchemaView,
  DependenciesView,
  DependencyItem,
  DocsView,
  DocView,
  EntityRelationsView,
  FileContextView,
  ImpactView,
  LiveMeta,
  ModuleView,
  OverviewView,
  SchemaDriftView,
  SearchView,
} from "./engine.js";

/**
 * View-models → compact markdown with inline node IDs (~40-60% fewer tokens
 * than JSON). Two hard rules, enforced by the BudgetWriter: output never
 * exceeds the budget, and truncation is never silent — every cut list ends
 * with "+N more → <the exact call that retrieves the rest>".
 *
 * Every response opens with a staleness header, because a structural fact is
 * only trustworthy relative to the commit it was extracted from.
 */

export interface StalenessInfo {
  /** Git state captured when the graph was built (graph.meta.git). */
  builtSha?: string | null;
  branch?: string | null;
  builtDirty?: boolean;
  /** graph.meta.createdAt (ISO). */
  createdAt: string;
  /** Where the working tree is NOW; null/undefined when unknown or no git. */
  currentSha?: string | null;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export interface RenderContext {
  budget?: number;
  staleness: StalenessInfo;
}

// ---------------------------------------------------------------------------
// Renderers, one per tool
// ---------------------------------------------------------------------------

export function renderOverview(view: OverviewView, ctx: RenderContext): string {
  const w = open(ctx);
  const budget = w.budget;
  const c = view.counts;
  w.line(`# Architecture overview — ${basename(view.root)}`);
  w.line(
    `${c.module ?? 0} modules · ${c.file ?? 0} files · ${c.symbol ?? 0} symbols · ` +
      `${c.extpkg ?? 0} external packages · ${view.totalImports} import edges`,
  );

  section(w, "## Modules (by rank)");
  w.list(
    view.modules.map(
      (m) =>
        `- ${m.id} · ${m.files} files · ${fmtLoc(m.loc)} loc · r=${fmtRank(m.rank)} · ` +
        `deps →${m.dependsOn} ←${m.dependents}${m.layer ? ` · layer ${m.layer}` : ""}`,
    ),
    (n) => more(n, `get_architecture_overview(budget_tokens=${suggestBudget(budget)})`),
  );

  if (view.dependencies.length > 0) {
    section(w, "## Module dependencies (by weight)");
    w.list(
      view.dependencies.map(
        (d) => `- ${d.from} → ${d.to} · ${d.weight} imports${provenance(d.source, d.confidence)}`,
      ),
      (n) => more(n, `get_architecture_overview(budget_tokens=${suggestBudget(budget)})`),
    );
  }

  if (view.packages.length > 0) {
    section(w, "## External packages (by usage)");
    w.list(
      view.packages.map((p) => `- ${p.id} ←${p.fanIn}`),
      (n) => more(n, `get_architecture_overview(budget_tokens=${suggestBudget(budget)})`),
    );
  }
  return w.toString();
}

export function renderModule(view: ModuleView, ctx: RenderContext): string {
  const w = open(ctx);
  const budget = w.budget;
  const moreModule = (n: number) =>
    more(n, `get_module("${view.name}", budget_tokens=${suggestBudget(budget)})`);

  w.line(`# ${view.id} — module`);
  w.line(
    `${view.layer ? `layer ${view.layer} · ` : ""}source ${view.source} · ` +
      `${view.files.length} files · ${fmtLoc(view.loc)} loc · r=${fmtRank(view.rank)}`,
  );

  if (view.readme) {
    section(w, `## About (${view.readme.path})`);
    renderProse(w, view.readme.content, ABOUT_MAX_LINES, (n) =>
      more(n, `get_doc("${view.readme?.path}", budget_tokens=${suggestBudget(budget)})`),
    );
  }

  if (view.dependsOn.length > 0) {
    section(w, "## Depends on");
    w.list(
      view.dependsOn.map(
        (d) => `- ${d.to} · ${d.weight} imports${provenance(d.source, d.confidence)}`,
      ),
      moreModule,
    );
  }
  if (view.dependents.length > 0) {
    section(w, "## Depended on by");
    w.list(
      view.dependents.map(
        (d) => `- ${d.from} · ${d.weight} imports${provenance(d.source, d.confidence)}`,
      ),
      moreModule,
    );
  }

  section(w, "## Files (by rank)");
  w.list(
    view.files.map(
      (f) =>
        `- ${f.id} · r=${fmtRank(f.rank)} · ←${f.fanIn} →${f.fanOut}` +
        `${f.exports.length > 0 ? ` · exports: ${nameList(f.exports, 4)}` : ""}` +
        `${f.doc !== undefined ? ` — ${clip(f.doc, 100)}` : ""}`,
    ),
    moreModule,
  );

  if (view.packages.length > 0) {
    section(w, "## External packages");
    w.list(
      view.packages.map((p) => `- ${p.id} ←${p.fanIn}`),
      moreModule,
    );
  }
  return w.toString();
}

export function renderDependencies(view: DependenciesView, ctx: RenderContext): string {
  const w = open(ctx);
  const budget = w.budget;
  const moreDeps = (n: number) =>
    more(n, `find_dependencies("${view.node.id}", budget_tokens=${suggestBudget(budget)})`);

  w.line(`# Dependencies — ${view.node.id} (${view.node.kind})`);
  section(w, `## Outgoing (${view.out.length})`);
  if (view.out.length === 0) w.line("(none)");
  else w.list(view.out.map(dependencyLine), moreDeps);

  section(w, `## Incoming (${view.in.length})`);
  if (view.in.length === 0) w.line("(none)");
  else w.list(view.in.map(dependencyLine), moreDeps);
  return w.toString();
}

export function renderImpact(view: ImpactView, ctx: RenderContext): string {
  const w = open(ctx);
  const budget = w.budget;
  const t = view.transitive;
  w.line(`# Impact of changing ${view.node.id} (${view.node.kind})`);
  w.line(
    `${view.directDependents.length} direct dependents · ` +
      `${t.totalFiles} transitive files across ${t.byModule.length} modules · ` +
      `max depth ${t.maxDepth}${view.truncated ? " · ⚠ analysis capped, counts are a floor" : ""}`,
  );

  if (view.directDependents.length > 0) {
    section(w, "## Direct dependents");
    w.list(
      view.directDependents.map(
        (d) =>
          `- ${d.id}${d.symbols && d.symbols.length > 0 ? ` · ${nameList(d.symbols, 4)}` : ""}`,
      ),
      (n) => more(n, `get_impact("${view.node.id}", budget_tokens=${suggestBudget(budget)})`),
    );
  }

  if (t.byModule.length > 0) {
    section(w, "## Affected modules (transitive)");
    w.list(
      t.byModule.map((m) => `- ${m.id} · ${m.files} files · depth ${m.minDepth}`),
      (n) => more(n, `get_impact("${view.node.id}", budget_tokens=${suggestBudget(budget)})`),
    );
  }

  if (view.tables.length > 0) {
    section(w, "## Tables in blast radius (via maps_to)");
    w.list(
      view.tables.map((tb) => `- ${tb.id}`),
      (n) => more(n, `get_impact("${view.node.id}", budget_tokens=${suggestBudget(budget)})`),
    );
  }
  return w.toString();
}

export function renderSearch(view: SearchView, ctx: RenderContext): string {
  const w = open(ctx);
  const budget = w.budget;
  w.line(`# Search "${view.query}" — ${view.total} matches`);
  if (view.results.length === 0) {
    w.line("No nodes match. Try a shorter substring, or get_architecture_overview() to orient.");
    return w.toString();
  }
  w.blank();
  w.list(
    view.results.map((r) => `- ${r.id} · ${r.kind}${r.moduleId ? ` · ${r.moduleId}` : ""}`),
    (n) => more(n, `search_nodes("${view.query}", budget_tokens=${suggestBudget(budget)})`),
  );
  if (view.total > view.results.length) {
    w.line(`(showing top ${view.results.length} of ${view.total} — narrow the query for more)`);
  }
  return w.toString();
}

export function renderFileContext(view: FileContextView, ctx: RenderContext): string {
  const w = open(ctx);
  const budget = w.budget;
  const moreFile = (n: number) =>
    more(n, `get_file_context("${view.path}", budget_tokens=${suggestBudget(budget)})`);

  w.line(`# ${view.id}`);
  w.line(
    `${view.moduleId ? `module ${view.moduleId} · ` : ""}${view.lang ?? "?"} · ` +
      `${fmtLoc(view.loc)} loc · r=${fmtRank(view.rank)} · ←${view.fanIn} →${view.fanOut}`,
  );

  if (view.doc !== undefined) {
    w.line(clip(view.doc, 200));
  }

  if (view.exports.length > 0) {
    section(w, `## Exports (${view.exports.length})`);
    w.list(
      view.exports.map(
        (e) =>
          `- ${e.name} · ${e.symbolKind}` +
          `${e.startLine !== undefined ? ` · L${e.startLine}–${e.endLine}` : ""}` +
          `${e.doc !== undefined ? ` — ${clip(e.doc, 100)}` : ""}`,
      ),
      moreFile,
    );
  }
  if (view.entities.length > 0) {
    section(w, `## Entities (${view.entities.length})`);
    w.list(
      view.entities.map((e) => `- ${e.id} · ${e.orm} → ${e.declaredTable}`),
      moreFile,
    );
  }

  section(w, `## Imports (${view.imports.length})`);
  if (view.imports.length === 0) w.line("(none)");
  else w.list(view.imports.map(dependencyLine), moreFile);

  section(w, `## Imported by (${view.importedBy.length})`);
  if (view.importedBy.length === 0) w.line("(none)");
  else w.list(view.importedBy.map(dependencyLine), moreFile);
  return w.toString();
}

export function renderDiff(diff: ArchDiff, ctx: RenderContext): string {
  const w = open(ctx);
  const budget = w.budget;
  const baseLabel = diff.base.ref ?? shortSha(diff.base.sha);
  const headLabel = diff.head.ref ?? shortSha(diff.head.sha);
  const moreDiff = (n: number) =>
    more(
      n,
      `get_architecture_diff("${baseLabel}", "${headLabel}", budget_tokens=${suggestBudget(budget)})`,
    );

  w.line(`# Architecture diff ${baseLabel}..${headLabel}`);
  w.line(`base ${shortSha(diff.base.sha)} → head ${shortSha(diff.head.sha)}`);

  const m = diff.moduleChanges;
  const hasModuleChanges = m.added.length + m.removed.length + m.renamed.length > 0;
  if (hasModuleChanges) {
    section(w, "## Modules");
    w.list(
      [
        ...m.added.map((id) => `+ ${id}`),
        ...m.removed.map((id) => `- ${id}`),
        ...m.renamed.map(([oldId, newId]) => `~ ${oldId} → ${newId}`),
      ],
      moreDiff,
    );
  }

  const d = diff.dependencyChanges;
  const hasDepChanges = d.added.length + d.removed.length + d.weightDelta.length > 0;
  if (hasDepChanges) {
    section(w, "## Module dependencies");
    w.list(
      [
        ...d.added.map((e) => `+ ${e.from} → ${e.to}`),
        ...d.removed.map((e) => `- ${e.from} → ${e.to}`),
        ...d.weightDelta.map(
          (x) => `Δ ${x.edge.from} → ${x.edge.to} · ${x.before} → ${x.after} imports`,
        ),
      ],
      moreDiff,
    );
  }

  const db = diff.dbChanges;
  if (db.tables.length + db.fks.length + db.driftDelta.length > 0) {
    section(w, "## Database");
    w.list(
      [
        ...db.tables.map((t) => `${changeSign(t.change)} ${t.id}`),
        ...db.fks.map(
          (f) => `${f.change === "added" ? "+" : "-"} fk ${f.edge.from} → ${f.edge.to}`,
        ),
        ...db.driftDelta.map((entry) => `⚠ drift: ${entry.kind} ${entry.detail}`),
      ],
      moreDiff,
    );
  }

  if (diff.fileChanges.length > 0) {
    const counts = { added: 0, removed: 0, moved: 0, changed: 0 };
    for (const change of diff.fileChanges) counts[change.change] += 1;
    section(w, "## Files");
    w.line(
      `${counts.added} added · ${counts.removed} removed · ${counts.moved} moved` +
        ` — get_file_context("<path>") for any of them`,
    );
    w.list(
      diff.fileChanges.map(
        (f) =>
          `${changeSign(f.change)} ${f.id}` +
          `${f.change === "moved" && f.previousId ? ` (was ${parseNodeId(f.previousId).rest})` : ""}`,
      ),
      moreDiff,
    );
  }

  if (!hasModuleChanges && !hasDepChanges && diff.fileChanges.length === 0) {
    w.blank();
    w.line("No architectural changes.");
  }
  return w.toString();
}

export function renderDoc(view: DocView, ctx: RenderContext): string {
  const w = open(ctx);
  const budget = w.budget;
  w.line(`# ${view.id}`);
  w.line(
    `"${view.title}"${view.module ? ` · documents ${view.module.id}` : ""}` +
      `${view.truncated ? " · ⚠ stored content was capped at extraction" : ""}`,
  );
  w.blank();
  renderProse(w, view.content, Number.POSITIVE_INFINITY, (n) =>
    more(n, `get_doc("${view.path}", budget_tokens=${suggestBudget(budget)})`),
  );
  return w.toString();
}

export function renderDocs(view: DocsView, ctx: RenderContext): string {
  const w = open(ctx);
  const budget = w.budget;
  w.line(`# Docs — ${view.total} markdown pages`);
  if (view.total === 0) {
    w.line("No markdown docs in the graph — add a README.md and re-run `archscope analyze`.");
    return w.toString();
  }
  w.blank();
  w.list(
    view.docs.map((d) => `- ${d.id} · "${d.title}"${d.module ? ` · → ${d.module.id}` : ""}`),
    (n) => more(n, `budget_tokens=${suggestBudget(budget)}`),
  );
  w.blank();
  w.line(`Read one: get_doc("<path>").`);
  return w.toString();
}

export function renderDbSchema(view: DbSchemaView, ctx: RenderContext): string {
  const w = open(ctx);
  const budget = w.budget;
  const t = view.totals;
  w.line(`# DB schema — ${t.tables} tables · ${t.entities} entities`);
  w.line(liveLine(view.live, ctx));
  if (t.tables === 0) {
    w.blank();
    w.line(
      "No entities or tables in the graph — the repo declares no supported ORM schema " +
        "(Prisma, SQLAlchemy) or `archscope analyze` predates the DB layer.",
    );
    return w.toString();
  }

  for (const group of view.schemas) {
    section(w, `## ${group.schema} (${group.tables.length} tables)`);
    w.list(
      group.tables.map((tb) => {
        const entities =
          tb.entities.length > 0
            ? ` · ← ${tb.entities.map((e) => `${e.id} [${e.orm}]`).join(", ")}`
            : "";
        const driftTag = tb.drift > 0 ? ` · ⚠ ${tb.drift} drift` : "";
        return (
          `- ${tb.id} · ${tb.columns} cols` +
          `${tb.pks.length > 0 ? ` · pk ${tb.pks.join("+")}` : ""}` +
          ` · ${tb.origin}${entities}${driftTag}`
        );
      }),
      (n) => more(n, `get_db_schema(budget_tokens=${suggestBudget(budget)})`),
    );
  }

  if (view.fks.length > 0) {
    section(w, `## Foreign keys (${view.fks.length})`);
    w.list(
      view.fks.map(
        (fk) =>
          `- ${fk.from} → ${fk.to} · ${fk.columns.map(([a, b]) => `${a}→${b}`).join(", ")}` +
          provenance(fk.source, fk.confidence),
      ),
      (n) => more(n, `get_db_schema(budget_tokens=${suggestBudget(budget)})`),
    );
  }
  w.blank();
  w.line(`Drill down: get_db_schema(table="<schema.table>") or get_entity_relations("<Entity>").`);
  return w.toString();
}

export function renderEntityRelations(view: EntityRelationsView, ctx: RenderContext): string {
  const w = open(ctx);
  const budget = w.budget;
  const moreRel = (n: number) =>
    more(n, `get_entity_relations("${view.center.name}", budget_tokens=${suggestBudget(budget)})`);

  w.line(`# ${view.center.id} — ${view.center.kind}`);
  if (view.table) {
    w.line(
      `table ${view.table.id} · origin ${view.table.origin} · ${view.table.columns.length} cols` +
        `${view.table.drift.length > 0 ? ` · ⚠ ${view.table.drift.length} drift` : ""}`,
    );
  } else {
    w.line("no table node — the entity's table was not linked");
  }

  if (view.fields && view.fields.length > 0) {
    section(w, `## Fields (${view.fields.length})`);
    w.list(view.fields.map(fieldLine), moreRel);
  } else if (view.table) {
    section(w, `## Columns (${view.table.columns.length})`);
    w.list(view.table.columns.map(columnLine), moreRel);
  }

  if (view.entities.length > 0) {
    section(w, `## Mapped entities (${view.entities.length})`);
    w.list(
      view.entities.map(
        (e) =>
          `- ${e.id} · ${e.orm} · ${e.file}${e.confidence === "inferred" ? " [inferred]" : ""}`,
      ),
      moreRel,
    );
  }

  if (view.related.length > 0) {
    section(w, `## FK relations (${view.related.length})`);
    w.list(
      view.related.map((r) => {
        const arrow = r.direction === "out" ? "→" : "←";
        const pairs = r.columns.map(([a, b]) => `${a}→${b}`).join(", ");
        const ents = r.entities.length > 0 ? ` · ${r.entities.map((e) => e.id).join(", ")}` : "";
        return `- ${arrow} ${r.tableId} · ${pairs}${ents}${provenance(r.source, r.confidence)}`;
      }),
      moreRel,
    );
  }

  if (view.table && view.table.drift.length > 0) {
    section(w, `## Drift (${view.table.drift.length})`);
    w.list(view.table.drift.map(driftLine), (n) =>
      more(n, `get_schema_drift(budget_tokens=${suggestBudget(budget)})`),
    );
  }
  return w.toString();
}

export function renderSchemaDrift(view: SchemaDriftView, ctx: RenderContext): string {
  const w = open(ctx);
  const budget = w.budget;
  w.line("# Schema drift — declared vs live");
  w.line(liveLine(view.live, ctx));

  if (!view.live) {
    w.blank();
    w.line(
      "No live introspection data in the graph. Configure `db.live` in .archscope.yaml " +
        "and run `archscope db introspect` — then this tool compares code against the database.",
    );
    return w.toString();
  }
  if (view.totals.entries === 0) {
    w.blank();
    w.line(`✓ No drift: ${view.totals.tablesChecked} tables match the live database.`);
    return w.toString();
  }

  w.line(
    `${view.totals.entries} findings across ${view.totals.tablesWithDrift} of ` +
      `${view.totals.tablesChecked} tables`,
  );
  for (const table of view.tables) {
    section(w, `## ${table.id} (${table.entries.length})`);
    w.list(table.entries.map(driftLine), (n) =>
      more(
        n,
        `get_db_schema(table="${parseNodeId(table.id).rest}", budget_tokens=${suggestBudget(budget)})`,
      ),
    );
  }
  return w.toString();
}

// ---------------------------------------------------------------------------

function liveLine(live: LiveMeta | null, ctx: RenderContext): string {
  if (!live) return "static declarations only — `archscope db introspect` adds live drift";
  const when = ago(live.introspectedAt, ctx.staleness.now ?? new Date());
  return `live: "${live.source}" (${live.dialect}) introspected ${when}`;
}

function fieldLine(field: EntityField): string {
  return (
    `- ${field.name} · ${field.type}` +
    `${field.column !== undefined ? ` · col ${field.column}` : ""}` +
    `${field.isPk ? " · pk" : ""}${field.isFk ? " · fk" : ""}${field.nullable ? " · nullable" : ""}`
  );
}

function columnLine(column: TableColumn): string {
  return (
    `- ${column.name} · ${column.sqlType}` +
    `${column.isPk ? " · pk" : ""}${column.nullable ? " · nullable" : ""}` +
    `${column.fkTo ? ` · fk → ${column.fkTo.table}.${column.fkTo.column}` : ""}`
  );
}

function driftLine(entry: DriftEntry): string {
  return `- ⚠ ${entry.kind}: ${entry.detail}`;
}

export function renderNotFound(
  ref: string,
  suggestions: Array<{ id: string; kind: string }>,
  ctx: RenderContext,
): string {
  const w = open(ctx);
  w.line(`# Not found: "${ref}"`);
  w.line("No node in the graph matches that reference.");
  if (suggestions.length > 0) {
    w.blank();
    w.line("Closest matches:");
    w.list(
      suggestions.map((s) => `- ${s.id} (${s.kind})`),
      (n) => `… +${n} more → search_nodes("${ref}")`,
    );
  } else {
    w.line(`Try search_nodes("...") or get_architecture_overview() to orient.`);
  }
  return w.toString();
}

// ---------------------------------------------------------------------------
// Staleness header
// ---------------------------------------------------------------------------

export function stalenessLines(info: StalenessInfo): string[] {
  const lines: string[] = [];
  const when = ago(info.createdAt, info.now ?? new Date());
  if (info.builtSha) {
    const state = info.builtDirty ? "dirty" : "clean";
    lines.push(
      `graph@${shortSha(info.builtSha)} · ${info.branch ?? "?"} · ${state} · analyzed ${when}`,
    );
  } else {
    lines.push(`graph (no git) · analyzed ${when}`);
  }
  if (info.builtSha && info.currentSha && info.builtSha !== info.currentSha) {
    lines.push(
      `⚠ stale: HEAD is now ${shortSha(info.currentSha)} — run \`archscope analyze\` to refresh`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function open(ctx: RenderContext): BudgetWriter {
  const w = new BudgetWriter(clampBudget(ctx.budget));
  for (const line of stalenessLines(ctx.staleness)) w.line(line);
  w.blank();
  return w;
}

function section(w: BudgetWriter, title: string): void {
  w.blank();
  w.line(title);
}

function more(omitted: number, call: string): string {
  return `… +${omitted} more → ${call}`;
}

/** Lines shown of a module README inside get_module before deferring to get_doc. */
const ABOUT_MAX_LINES = 30;

/**
 * Stream markdown prose through the budget, line by line. `maxLines` bounds
 * how much of the doc this section may claim even when budget remains — the
 * hint always reports the TRUE number of lines left in the document.
 */
function renderProse(
  w: BudgetWriter,
  content: string,
  maxLines: number,
  makeHint: (omitted: number) => string,
): void {
  const lines = content.replace(/\n+$/, "").split("\n");
  const shown = lines.slice(0, maxLines);
  const rest = lines.length - shown.length;
  const written = w.list(shown, (n) => makeHint(n + rest));
  if (written === shown.length && rest > 0) {
    w.line(makeHint(rest));
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function dependencyLine(item: DependencyItem): string {
  const symbols = item.symbols && item.symbols.length > 0 ? ` · ${nameList(item.symbols, 4)}` : "";
  const weight = item.weight !== undefined ? ` · ${item.weight} imports` : "";
  return `- ${item.edgeKind} ${item.id}${symbols}${weight}${provenance(
    item.source,
    item.confidence,
    item.reason,
  )}`;
}

/** Facts that are not static+certain always say where they came from. */
function provenance(source: string, confidence: string, reason?: string): string {
  if (source === "static" && confidence === "certain") return "";
  const tag = source === "manual" ? (reason ? `manual: ${reason}` : "manual") : source;
  return confidence === "inferred" ? ` [${tag}, inferred]` : ` [${tag}]`;
}

function nameList(names: string[], max: number): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} (+${names.length - max})`;
}

function changeSign(change: "added" | "removed" | "moved" | "changed"): string {
  return change === "added" ? "+" : change === "removed" ? "-" : "~";
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function basename(root: string): string {
  const parts = root.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || root;
}

function fmtRank(rank: number): string {
  return rank.toFixed(3);
}

function fmtLoc(loc: number): string {
  return loc >= 10_000
    ? `${Math.round(loc / 1000)}k`
    : loc >= 1_000
      ? `${(loc / 1000).toFixed(1)}k`
      : String(loc);
}

function ago(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return `at ${iso}`;
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
