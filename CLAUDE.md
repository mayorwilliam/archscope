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
- **packages/mcp** — servidor MCP stdio (`@modelcontextprotocol/sdk`). Handlers ≤30 líneas que delegan a `core/query` — jamás derivan hechos estructurales por su cuenta. `GraphSource` (vive en core, compartido con `serve`) relee `graph.json` por mtime (convive con `watch`) y recalcula el staleness (HEAD actual vs sha del grafo) en cada llamada.
- **packages/dashboard** — Vite + React 19 + React Flow (`@xyflow/react`) + elkjs. 4 vistas por hash routing: Overview (módulos con expand/collapse a subflow de archivos), Module drill-down (archivos + imports internos + vecinos agregados, panel de símbolos), ERD (columnas con PK/FK, chips de entidades con confidence, badge de drift) y Diff (pickers de refs, overlay verde/rojo/ámbar + changelist). Consume los view-models de `core/query` **verbatim** vía REST; SSE `graph-updated` → `invalidateQueries()` de react-query = live update. Los builders grafo→flow son puros y unit-testeados (`src/graph/toFlow.ts`); el layout ELK corre en web worker (`elk-api` + `elk-worker.min.js?worker` — el `elk.bundled.js` NO sobrevive el rebundleo de Vite dentro de un worker). Publica solo `dist/` estático; deps todas en devDependencies (se bundlean).
- **packages/cli** — bin `archmap` (Commander): `init`, `analyze [--full]`, `diff`, `watch`, `serve [--port 4400]`, `mcp`, `db introspect|drift`. En el comando `mcp`, stdout es el canal del protocolo: cualquier log humano va a stderr. `serve` = backend completo del dashboard: fastify con estáticos del dist de `@archmap/dashboard`, REST (`/api/overview|module|erd|drift|refs|diff|meta`) que devuelve view-models en JSON, SSE (`/api/events`, chokidar sobre `graph.json` — capta también escritores externos como `db introspect`) y el watch de fuentes in-process (`startWatch`, compartido con el comando `watch`). Escucha solo en 127.0.0.1 (local-first).
- **e2e/** — harness contra el CLI **compilado**: SDK `Client` sobre stdio. `mcp.test.ts` usa un repo sintético puro TS (12 módulos en cadena → números de impact exactos); `db.test.ts` usa su propio mini-repo Prisma (26 models → truncado garantizado) para no perturbar esos números. `oss.test.ts` corre solo con `TEST_OSS_REPO=/path` (patrón opt-in, como `TEST_LIVE_DB`). **`dashboard/`** (Playwright, no vitest): fixture con historia git real (base→head con módulo agregado/borrado, dep nueva y columna Prisma nueva) contra `archmap serve`; cubre los 5 criterios de aceptación de Fase 5, incluido el live update <2s sin reload.

`fixtures/` está **fuera del workspace pnpm a propósito** (ver `pnpm-workspace.yaml`): si pnpm hiciera hoisting dentro de los fixtures, corrompería exactamente el comportamiento de resolución que los tests del resolver verifican. Por eso los fixtures nunca se `pnpm install`ean.

## Comandos

- `pnpm build` — build de todos los paquetes (`tsc -b`; el dashboard usa `vite build`).
- `pnpm test` — `vitest run` (proyectos por paquete, ver `vitest.config.ts` raíz).
- `pnpm lint` — `biome check .`
- `pnpm lint:fix` — `biome check --write .`
- `pnpm typecheck` — `tsc -b` en modo typecheck por paquete (dashboard: `tsc --noEmit`).
- `pnpm test:e2e` — build + harness MCP e2e (requiere build porque spawnea el CLI compilado).
- `pnpm test:e2e:dashboard` — build + smoke Playwright del dashboard (requiere `pnpm -C e2e exec playwright install chromium` la primera vez).
- CLI local (requiere build previo): `node packages/cli/dist/index.js <cmd>` — comandos: `init`, `analyze [--full]`, `diff <base> [head] [--json]`, `watch`, `serve [--port 4400]`, `mcp`, `db introspect [--source]`, `db drift [--source] [--json]` (exit 1 si hay drift — pensado para CI).
- Dev del dashboard: `pnpm -C packages/dashboard dev` (Vite con proxy `/api` → `localhost:4400`) contra un `archmap serve` corriendo.
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

**Fase 5 completa**: dashboard. `packages/dashboard` (Vite + React Flow + elkjs en worker) con las 4 vistas del plan y `archmap serve` como su backend (REST de view-models verbatim + SSE + estáticos + watch in-process). Para servirlo, el query engine ganó `erdView` (columnas completas con PK/FK — `dbSchemaView` sigue resumido para el budget de MCP), `moduleView.internalImports` (imports file→file dentro del módulo) y `gitRefs`; `GraphSource` se mudó de `mcp` a `core` porque ahora lo comparten ambos consumidores. Smoke Playwright (`e2e/dashboard/`) verde con los 5 criterios de aceptación: conteo de módulos, expand/collapse, ERD con FKs + badge de drift, diff coloreado con changelist y live update <2s sin reload. Sin router ni zustand: hash routing propio y estado local — react-query + SSE cubren todo el estado remoto.

Fases 1–4 (pipeline TS/JS + Python, cache incremental, snapshots por sha, diff rename-aware, watch, query engine con budget, servidor MCP con los 10 tools, capa DB con introspección viva y drift) completas — ver historial de commits. Pendiente heredado de Fase 4: correr `TEST_LIVE_DB=1` (Testcontainers, falta Docker en la sesión).

Plan completo de 6 fases guardado en Engram (proyecto `visual-work`, topic `visual-work/plan`). **Fase 6** (siguiente y última): amplitud + hardening + ship — TypeORM/Drizzle/Django, MySQL, Alembic best-effort, `piscina` paralelo, perf en repo 5k archivos, bundle `tsup`, README/docs, publish v0.1.0 en npm.
