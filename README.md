# ArchScope

**Architecture graphs for humans and coding agents — from deterministic static analysis.**

ArchScope extracts the architecture of a repository — modules, dependencies, DB schema, and how it all changes over time — into a single graph, and serves that same graph to two consumers:

- **A local dashboard** (`archscope serve`): module overview, drill-down, ERD and architectural diff.
- **An MCP server** (`archscope mcp`): 10 tools that give coding agents (Claude Code, Cursor, …) structured, token-budgeted context about your codebase.

No LLM anywhere in the pipeline. The same repo analyzed twice produces the same graph, byte for byte. Every edge carries its provenance (`static` / `live` / `manual`) and confidence (`certain` / `inferred`) — the tool never presents a guess as a fact.

## Quickstart

```bash
npx archscope init      # detect the stack, write .archscope.yaml
npx archscope analyze   # build .archscope/graph.json
npx archscope serve     # dashboard at http://localhost:4400
```

For coding agents:

```bash
claude mcp add archscope -- npx -y archscope mcp
```

## What it understands

| | |
|---|---|
| **Languages** | TypeScript / JavaScript (tsconfig paths, workspace monorepos, dynamic `import()`), Python (absolute + relative imports, `__all__`, `importlib` literals) |
| **ORMs (static)** | Prisma, SQLAlchemy (classic + 2.0 Mapped), TypeORM, Drizzle, Django |
| **Live databases** | Postgres and MySQL introspection (read-only) with **drift detection**: declared schema vs live schema, compared by normalized type families |
| **Migrations** | Alembic detection (best-effort): migration count + current head(s), reported as context — never used to reconstruct the schema |
| **History** | Snapshots per git sha, rename-aware architectural diff (`archscope diff main HEAD`), watch mode with incremental re-analysis |

The `maps_to` edge (entity ↔ table) connects both worlds: ask "what code do I touch if I alter `public.users`?" and get an answer that crosses from the database into the import graph.

## CLI

```
archscope init                      # detect stack, write config + gitignore
archscope analyze [--full]          # build the graph (incremental cache; --full re-extracts)
archscope serve [--port 4400]       # dashboard + REST + SSE + watch, 127.0.0.1 only
archscope mcp                       # MCP server over stdio
archscope diff <base> [head] [--json]   # architectural diff between two refs
archscope watch                     # re-analyze on change
archscope db introspect [--source]  # merge live DB tables + drift into the graph
archscope db drift [--source] [--json]  # report drift; exit 1 if any (CI-friendly)
```

### Live DB credentials

Connection URLs are read from an env var **named** in `.archscope.yaml` — the value never touches disk, never appears in the graph, and driver errors are redacted before they propagate:

```yaml
db:
  live:
    - name: main
      dialect: postgres   # or mysql
      urlEnv: DATABASE_URL
```

## MCP tools

`get_architecture_overview` · `get_module` · `find_dependencies` · `get_impact` (blast radius, tables included via `maps_to`) · `search_nodes` · `get_file_context` · `get_db_schema` · `get_entity_relations` · `get_schema_drift` · `get_architecture_diff`

Every tool accepts `budget_tokens` (clamped to [200, 20000]). Responses are ranked (PageRank + fan-in), truncated **explicitly** with an executable drill-down hint (`… +37 more → get_module("payments", budget_tokens=4000)`), and stamped with a staleness header (`graph@ab12cd34, branch main, clean`) so agents know when the graph is behind HEAD.

## Documented limits (v1)

Honesty over coverage — these are deliberate, visible boundaries, not silent gaps:

- **Dynamic imports**: `require(variable)`, computed `importlib` calls and framework magic are invisible to static analysis. Declare `manual` edges in `.archscope.yaml` for those; they render dashed in the dashboard and labeled over MCP.
- **TypeORM**: custom naming strategies, embedded entities, single-table inheritance, `@ManyToMany` junction tables and `EntitySchema` are out of scope.
- **Drizzle**: composite PKs in the third config argument and `relations()` helpers (navigation-only) are not extracted.
- **Django**: only direct `models.Model` bases are recognized (custom abstract bases are not chased through imports); implicit PK and FK column types are declared `unknown` — drift treats them as incomparable instead of guessing.
- **SQLAlchemy**: Core `Table(...)` definitions and `ForeignKeyConstraint` in `__table_args__` are not extracted.
- **Alembic**: detection only — heads and counts, never schema reconstruction.
- **Symbols**: top-level exported symbols only (the API surface), by design.

## Development

pnpm monorepo: `packages/{schema,core,db,mcp,dashboard,cli}` + `fixtures/` (golden-tested, outside the workspace on purpose) + `e2e/`.

```bash
pnpm install
pnpm build          # tsc -b + vite (dashboard) + tsup (CLI bundle)
pnpm test           # unit tests (vitest)
pnpm test:e2e       # MCP harness against the built CLI
pnpm test:e2e:dashboard   # Playwright smoke
pnpm bench          # 5k-file synthetic repo: < 60s cold / < 5s warm
TEST_LIVE_DB=1 pnpm vitest run --project db   # Testcontainers (Postgres + MySQL)
```

The published `archscope` package is a single tsup bundle: `@archscope/*` workspace packages are inlined, the dashboard ships as static assets inside the package, and only third-party runtime deps are installed from the registry. Analysis never executes code from the target repo.

## License

MIT
