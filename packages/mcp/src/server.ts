import {
  buildHistory,
  buildTimeline,
  DEFAULT_BUDGET,
  dbSchemaView,
  dependenciesView,
  diffGraphs,
  docView,
  ensureSnapshot,
  entityRelationsView,
  fileContextView,
  type GraphIndex,
  GraphSource,
  gitRenames,
  impactView,
  MAX_BUDGET,
  MIN_BUDGET,
  moduleView,
  overviewView,
  type RenderContext,
  renderDbSchema,
  renderDependencies,
  renderDiff,
  renderDoc,
  renderEntityRelations,
  renderFileContext,
  renderHistory,
  renderImpact,
  renderModule,
  renderNotFound,
  renderOverview,
  renderSchemaDrift,
  renderSearch,
  renderTimeline,
  type StalenessInfo,
  schemaDriftView,
  searchView,
} from "@archscope/core";
import { NODE_KINDS } from "@archscope/schema";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * The MCP surface is a thin adapter: every handler loads the graph, calls ONE
 * core/query function and returns its rendered markdown. No handler derives
 * structural facts on its own — that is the whole point of the single-graph
 * architecture. Handlers stay ≤30 lines by construction.
 */

export interface ArchscopeServerOptions {
  rootDir: string;
  version?: string;
}

const budget_tokens = z
  .number()
  .int()
  .optional()
  .describe(
    `Token budget for the response, clamped to [${MIN_BUDGET}, ${MAX_BUDGET}]. ` +
      `Default ${DEFAULT_BUDGET}. Truncated lists end with a hint for the follow-up call.`,
  );

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

function failure(body: string): ToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

function ctx(budget: number | undefined, staleness: StalenessInfo): RenderContext {
  return { ...(budget !== undefined ? { budget } : {}), staleness };
}

/** Not-found responses still suggest where to look next. */
function notFound(index: GraphIndex, ref: string, renderCtx: RenderContext): ToolResult {
  const lastSegment = ref.split("/").pop()?.split("#").pop() ?? ref;
  const suggestions = searchView(index, lastSegment).results.slice(0, 3);
  return failure(renderNotFound(ref, suggestions, renderCtx));
}

export function createArchscopeServer(options: ArchscopeServerOptions): McpServer {
  const { rootDir } = options;
  const source = new GraphSource(rootDir);
  const server = new McpServer({ name: "archscope", version: options.version ?? "0.0.1" });

  const guarded =
    <A>(handler: (args: A) => Promise<ToolResult>) =>
    async (args: A): Promise<ToolResult> => {
      try {
        return await handler(args);
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    };

  server.registerTool(
    "get_architecture_overview",
    {
      title: "Architecture overview",
      description:
        "Modules with layers and ranks, module→module dependencies and external packages " +
        "of the analyzed repo. Start here to orient yourself.",
      inputSchema: { budget_tokens },
    },
    guarded(async (args) => {
      const { index, staleness } = await source.load();
      return text(renderOverview(overviewView(index), ctx(args.budget_tokens, staleness)));
    }),
  );

  server.registerTool(
    "get_module",
    {
      title: "Module drill-down",
      description:
        "One module in detail: files by rank with their exports, dependencies in both " +
        "directions and external packages. Accepts a module name or a mod: id.",
      inputSchema: { module: z.string().describe("Module name or mod: id"), budget_tokens },
    },
    guarded(async (args) => {
      const { index, staleness } = await source.load();
      const renderCtx = ctx(args.budget_tokens, staleness);
      const view = moduleView(index, args.module);
      if (!view) return notFound(index, args.module, renderCtx);
      return text(renderModule(view, renderCtx));
    }),
  );

  server.registerTool(
    "find_dependencies",
    {
      title: "Direct dependencies",
      description:
        "Outgoing and incoming edges of one node (file, module, package, symbol). " +
        "Accepts a node id, a bare module name or a repo-relative file path.",
      inputSchema: {
        node_id: z.string().describe("Node id (file:…, mod:…, pkg:…) or bare path/name"),
        budget_tokens,
      },
    },
    guarded(async (args) => {
      const { index, staleness } = await source.load();
      const renderCtx = ctx(args.budget_tokens, staleness);
      const view = dependenciesView(index, args.node_id);
      if (!view) return notFound(index, args.node_id, renderCtx);
      return text(renderDependencies(view, renderCtx));
    }),
  );

  server.registerTool(
    "get_impact",
    {
      title: "Blast radius",
      description:
        "Everything that transitively depends on a node — the code you'd have to look at " +
        "if you changed it. Includes DB tables reachable via entity↔table mappings.",
      inputSchema: {
        node_id: z.string().describe("Node id (file:…, mod:…, tbl:…) or bare path/name"),
        budget_tokens,
      },
    },
    guarded(async (args) => {
      const { index, staleness } = await source.load();
      const renderCtx = ctx(args.budget_tokens, staleness);
      const view = impactView(index, args.node_id);
      if (!view) return notFound(index, args.node_id, renderCtx);
      return text(renderImpact(view, renderCtx));
    }),
  );

  server.registerTool(
    "search_nodes",
    {
      title: "Search the graph",
      description:
        "Find nodes by name substring — modules, files, symbols, entities, tables, packages. " +
        "Results are ranked by match quality, then architectural rank.",
      inputSchema: {
        query: z.string().min(1).describe("Case-insensitive substring"),
        kinds: z.array(z.enum(NODE_KINDS)).optional().describe("Restrict to these node kinds"),
        budget_tokens,
      },
    },
    guarded(async (args) => {
      const { index, staleness } = await source.load();
      const view = searchView(index, args.query, args.kinds);
      return text(renderSearch(view, ctx(args.budget_tokens, staleness)));
    }),
  );

  server.registerTool(
    "get_file_context",
    {
      title: "File context",
      description:
        "One file in detail: module, exported symbols with line spans, imports, importers " +
        "and declared entities. Accepts a repo-relative path or a file: id.",
      inputSchema: {
        path: z.string().describe("Repo-relative file path or file: id"),
        budget_tokens,
      },
    },
    guarded(async (args) => {
      const { index, staleness } = await source.load();
      const renderCtx = ctx(args.budget_tokens, staleness);
      const view = fileContextView(index, args.path);
      if (!view) return notFound(index, args.path, renderCtx);
      return text(renderFileContext(view, renderCtx));
    }),
  );

  server.registerTool(
    "get_doc",
    {
      title: "Project doc",
      description:
        "One markdown doc from the analyzed repo (README, docs/ page) as extracted into the " +
        "graph, with the module it documents. Accepts a repo-relative path or a doc: id. " +
        'Docs are discoverable via search_nodes(kinds=["doc"]) or a module\'s About section.',
      inputSchema: {
        ref: z.string().describe("Repo-relative .md path or doc: id"),
        budget_tokens,
      },
    },
    guarded(async (args) => {
      const { index, staleness } = await source.load();
      const renderCtx = ctx(args.budget_tokens, staleness);
      const view = docView(index, args.ref);
      if (!view) return notFound(index, args.ref, renderCtx);
      return text(renderDoc(view, renderCtx));
    }),
  );

  server.registerTool(
    "get_db_schema",
    {
      title: "Database schema",
      description:
        "Tables grouped by DB schema with their mapped code entities, PKs, foreign keys and " +
        "drift counts. Pass `table` for one table in column-level detail. Static declarations " +
        "come from ORM code (Prisma, SQLAlchemy); live data appears after `archscope db introspect`.",
      inputSchema: {
        table: z.string().optional().describe('One table in detail: "users" or "public.users"'),
        budget_tokens,
      },
    },
    guarded(async (args) => {
      const { index, staleness } = await source.load();
      const renderCtx = ctx(args.budget_tokens, staleness);
      if (args.table === undefined) {
        return text(renderDbSchema(dbSchemaView(index), renderCtx));
      }
      const view = entityRelationsView(index, args.table, "table");
      if (!view) return notFound(index, args.table, renderCtx);
      return text(renderEntityRelations(view, renderCtx));
    }),
  );

  server.registerTool(
    "get_entity_relations",
    {
      title: "Entity relations",
      description:
        "One ORM entity (or table) and its neighborhood: declared fields, the table it maps to, " +
        "FK relations in both directions and the entities behind those tables. Accepts an " +
        'entity name ("User"), an ent: id, or a table reference.',
      inputSchema: {
        entity: z.string().describe("Entity name, ent: id, table name or tbl: id"),
        budget_tokens,
      },
    },
    guarded(async (args) => {
      const { index, staleness } = await source.load();
      const renderCtx = ctx(args.budget_tokens, staleness);
      const view = entityRelationsView(index, args.entity);
      if (!view) return notFound(index, args.entity, renderCtx);
      return text(renderEntityRelations(view, renderCtx));
    }),
  );

  server.registerTool(
    "get_schema_drift",
    {
      title: "Schema drift",
      description:
        "Declared (code) vs live (database) schema discrepancies, per table: missing " +
        "tables/columns, type and nullability mismatches, missing FK constraints. Requires a " +
        "prior `archscope db introspect`; explains how to enable it otherwise.",
      inputSchema: { budget_tokens },
    },
    guarded(async (args) => {
      const { index, staleness } = await source.load();
      return text(renderSchemaDrift(schemaDriftView(index), ctx(args.budget_tokens, staleness)));
    }),
  );

  server.registerTool(
    "get_timeline",
    {
      title: "Project timeline",
      description:
        "The repo's time axis: tags as milestones plus the most recent commits of the current " +
        "branch, marking which points already have an architecture snapshot built. Start here " +
        "before comparing points in time.",
      inputSchema: {
        commits: z.number().int().min(1).max(300).optional().describe("Window size, default 30"),
        budget_tokens,
      },
    },
    guarded(async (args) => {
      const { staleness } = await source.load();
      const view = await buildTimeline(rootDir, {
        ...(args.commits !== undefined ? { commits: args.commits } : {}),
      });
      return text(renderTimeline(view, ctx(args.budget_tokens, staleness)));
    }),
  );

  server.registerTool(
    "get_architecture_history",
    {
      title: "Architecture history",
      description:
        "Walk a range of the repo's history as a SERIES: tag milestones between two refs become " +
        "waypoints and each adjacent pair is diffed. First calls build snapshots on demand and " +
        "can take a while; results are cached per sha forever.",
      inputSchema: {
        from: z.string().describe("Older ref (sha, branch, tag)"),
        to: z.string().optional().describe("Newer ref, default HEAD"),
        max_points: z.number().int().min(2).max(12).optional().describe("Waypoint cap, default 5"),
        budget_tokens,
      },
    },
    guarded(async (args) => {
      const { staleness } = await source.load();
      const view = await buildHistory(rootDir, {
        from: args.from,
        ...(args.to !== undefined ? { to: args.to } : {}),
        ...(args.max_points !== undefined ? { maxPoints: args.max_points } : {}),
      });
      return text(renderHistory(view, ctx(args.budget_tokens, staleness)));
    }),
  );

  server.registerTool(
    "get_architecture_diff",
    {
      title: "Architecture diff",
      description:
        "Module-level architectural changes between two git refs: modules added/removed/renamed, " +
        "new module→module dependencies, file changes. Snapshots are built on demand — the " +
        "first call for an old ref can take a while.",
      inputSchema: {
        base: z.string().describe("Base ref (sha, branch, tag)"),
        head: z.string().optional().describe("Head ref, default HEAD"),
        budget_tokens,
      },
    },
    guarded(async (args) => {
      const headRef = args.head ?? "HEAD";
      const { staleness } = await source.load();
      const base = await ensureSnapshot(rootDir, args.base);
      const head = await ensureSnapshot(rootDir, headRef);
      const renames = await gitRenames(rootDir, base.sha, head.sha);
      const diff = diffGraphs({
        base: base.graph,
        head: head.graph,
        renames,
        baseRef: { sha: base.sha, ref: args.base },
        headRef: { sha: head.sha, ref: headRef },
      });
      return text(renderDiff(diff, ctx(args.budget_tokens, staleness)));
    }),
  );

  return server;
}
