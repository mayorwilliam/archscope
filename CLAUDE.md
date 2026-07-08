# CLAUDE.md

Guía para Claude Code trabajando en **ArchMap** (nombre de trabajo).

## Qué es

Herramienta local-first que extrae la arquitectura de un repo mediante análisis estático determinista y la sirve desde un único grafo a dos consumidores: un dashboard web y un servidor MCP.

Principios innegociables:

1. **El grafo es la única fuente de verdad.** `.archmap/graph.json` es el producto. Ningún consumidor (dashboard, MCP, diff) re-deriva hechos estructurales por su cuenta — todos leen el mismo grafo.
2. **Determinismo.** Cero LLM en el pipeline de extracción. El mismo repo, analizado dos veces, produce el mismo grafo byte a byte (salvo campos volátiles como timestamps).
3. **Presupuesto de tokens de primera clase.** Toda query futura (dashboard, MCP) va a llevar un budget de tokens explícito — no se diseña ninguna interfaz de consulta sin esto en mente.
4. **Procedencia de cada edge.** Todo edge del grafo lleva `source` (`static` | `live` | `manual`) y `confidence` (`certain` | `inferred`) — nunca se presenta un hecho estructural sin decir de dónde salió y qué tan seguro está el sistema de él.

## Estructura

Monorepo pnpm (`pnpm-workspace.yaml`: `packages/*` + `e2e`):

- **packages/schema** — tipos Zod del grafo (`ArchGraph`, `GraphNode`, `GraphEdge`, etc.) e IDs estables. Los IDs (`mod:`, `file:`, `sym:`, `ent:`, `tbl:`, `pkg:`) se construyen y parsean **solo** en `packages/schema/src/ids.ts` — ningún otro paquete debe montar un ID a mano.
- **packages/core** — el pipeline: `scan` → `parse` (tree-sitter WASM) → `resolve` (imports/workspace) → `infer` (módulos) → `graph/build` (el grafo final + métricas). Además **`src/query/`**: el query engine puro (`engine.ts` view-models JSON-serializables, `render.ts` markdown compacto, `budget.ts` presupuesto). El `BudgetWriter` garantiza **por construcción** que ningún render excede su budget; el truncado siempre termina en un hint ejecutable (`… +N more → tool(...)`).
- **packages/db** — capa DB. Extractores estáticos (`prisma.ts` vía `@mrleebo/prisma-ast`; `sqlalchemy.ts` recibe el árbol tree-sitter **ya parseado** por core — inyección, cero WASM propio) que emiten el mismo intermedio `DeclaredSchema`. `link.ts` (entidad↔tabla: nombre explícito `@@map`/`__tablename__` → `certain`, convención → `inferred`), `introspect.ts` (Postgres read-only, la URL jamás se persiste y los errores del driver se redactan), `drift.ts` (declarado vs vivo por familias de tipo normalizadas) y `merge.ts` (overlay vivo **idempotente**: las columnas declaradas quedan intactas, el drift es el delta; `analyze` regenera sin overlay). Depende solo de `schema` — `core` → `db`, nunca al revés.
- **packages/mcp** — servidor MCP stdio (`@modelcontextprotocol/sdk`). Handlers ≤30 líneas que delegan a `core/query` — jamás derivan hechos estructurales por su cuenta. `GraphSource` relee `graph.json` por mtime (convive con `watch`) y recalcula el staleness (HEAD actual vs sha del grafo) en cada llamada.
- **packages/cli** — bin `archmap` (Commander): `init`, `analyze [--full]`, `diff`, `watch`, `mcp`, `db introspect|drift`. En el comando `mcp`, stdout es el canal del protocolo: cualquier log humano va a stderr.
- **e2e/** — harness contra el CLI **compilado**: SDK `Client` sobre stdio. `mcp.test.ts` usa un repo sintético puro TS (12 módulos en cadena → números de impact exactos); `db.test.ts` usa su propio mini-repo Prisma (26 models → truncado garantizado) para no perturbar esos números. `oss.test.ts` corre solo con `TEST_OSS_REPO=/path` (patrón opt-in, como `TEST_LIVE_DB`).

`fixtures/` está **fuera del workspace pnpm a propósito** (ver `pnpm-workspace.yaml`): si pnpm hiciera hoisting dentro de los fixtures, corrompería exactamente el comportamiento de resolución que los tests del resolver verifican. Por eso los fixtures nunca se `pnpm install`ean.

## Comandos

- `pnpm build` — `tsc -b` en todos los paquetes.
- `pnpm test` — `vitest run` (proyectos por paquete, ver `vitest.config.ts` raíz).
- `pnpm lint` — `biome check .`
- `pnpm lint:fix` — `biome check --write .`
- `pnpm typecheck` — `tsc -b` en modo typecheck por paquete.
- `pnpm test:e2e` — build + harness MCP e2e (requiere build porque spawnea el CLI compilado).
- CLI local (requiere build previo): `node packages/cli/dist/index.js <cmd>` — comandos: `init`, `analyze [--full]`, `diff <base> [head] [--json]`, `watch`, `mcp`, `db introspect [--source]`, `db drift [--source] [--json]` (exit 1 si hay drift — pensado para CI).
- El server MCP de este propio repo está registrado en `.mcp.json` (dogfooding) — correr `analyze` antes de usarlo.

## Convenciones de testing

- **Fixtures con goldens** (`fixtures/<nombre>/expected-graph.json`): la primera corrida escribe el golden y **falla a propósito** (`expectGolden` en `packages/core/test/helpers.ts`), forzando revisión humana del contenido antes de commitear.
- **Tests del resolver son table-driven** (`packages/core/test/resolver.test.ts`, `packages/core/test/py-resolver.test.ts`): cada bug de resolución nuevo que aparezca se agrega como una fila nueva de caso, nunca como test suelto.
- Los tests de `core` importan `@archmap/schema` y `@archmap/db` desde su `src/` vía alias en `packages/core/vitest.config.ts` (no `dist/`) — el loop red-green no requiere build.
- **Tests de DB viva** (`packages/db/test/live-postgres.test.ts`): Testcontainers Postgres, gated por `TEST_LIVE_DB=1` (requiere Docker). Plantan drift exacto y validan que el reporte contenga eso y **nada más**, más la guarda de credenciales (grep de URL/password sobre todo output de `.archmap/`).

## Reglas del repo

- Commits: conventional commits en español (`feat(core): ...`, `fix(cli): ...`, `chore: ...`), sin `Co-Authored-By` ni atribución de IA.
- **Nunca ejecutar código de los repos analizados.** Solo análisis estático (parseo, no `require`/`import` dinámico ni scripts del target).
- Resolución workspace: cuando un `package.json` declara un entry en `dist/build/lib` (ej. `"main": "dist/index.js"`), el resolver mapea **siempre** a su gemelo en `src/` primero — construido o no — para no apuntar a un artefacto no escaneado (ver comentario en `packages/core/src/resolve/ts-resolver.ts`).
- `.archmap.yaml` de este propio repo excluye `fixtures/**` (los fixtures son inputs de test, no arquitectura real del proyecto).
- `.archmap/` está en `.gitignore` — el grafo generado no se commitea.

## Estado

**Fase 4 completa**: capa DB. Extractores Prisma + SQLAlchemy → `DeclaredSchema` → grafo (nodos `entity`/`table`, edges `maps_to`/`fk` con procedencia honesta), fixtures `prisma-app`/`sqlalchemy-app` con goldens revisados. Introspección viva Postgres + drift + merge idempotente (`archmap db introspect` escribe overlay en el grafo; `analyze` lo regenera sin él). Los 3 tools MCP de DB (`get_db_schema [table?]`, `get_entity_relations`, `get_schema_drift`) con budget, staleness y not-found con sugerencias — un nombre bare como "User" resuelve entidad-primero en `get_entity_relations` y tabla-primero en `get_db_schema` (en Prisma la tabla por convención se llama igual que el model). El diff ahora reporta `dbChanges` (tablas/fks/drift introducido). `EXTRACTOR_VERSION=2` (los facts cachean `entities`). El property test de budget cubre los 10 tools. Pendiente de correr por falta de Docker en la sesión: `TEST_LIVE_DB=1` (Testcontainers con drift plantado) — el resto de la capa viva está cubierta por unit tests (drift/merge/redacción) y el error path del CLI verificado a mano.

Fases 1–3 (pipeline TS/JS + Python, cache incremental, snapshots por sha, diff rename-aware, watch, query engine con budget, servidor MCP con los 7 tools no-DB, harness e2e) completas — ver historial de commits.

Plan completo de 6 fases guardado en Engram (proyecto `visual-work`, topic `visual-work/plan`). **Fase 5** (siguiente): dashboard — Vite + React Flow (`@xyflow/react`) + elkjs, 4 vistas (overview, module drill-down, ERD con badges de drift, diff), REST + SSE servidos por fastify desde el CLI (`serve`). Los view-models JSON del query engine ya existen — la Fase 5 los consume verbatim.
