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
- **packages/mcp** — servidor MCP stdio (`@modelcontextprotocol/sdk`). Handlers ≤30 líneas que delegan a `core/query` — jamás derivan hechos estructurales por su cuenta. `GraphSource` relee `graph.json` por mtime (convive con `watch`) y recalcula el staleness (HEAD actual vs sha del grafo) en cada llamada.
- **packages/cli** — bin `archmap` (Commander): `init`, `analyze [--full]`, `diff`, `watch`, `mcp`. En el comando `mcp`, stdout es el canal del protocolo: cualquier log humano va a stderr.
- **e2e/** — harness contra el CLI **compilado**: SDK `Client` sobre stdio, repo sintético con git real (12 módulos en cadena → números de impact exactos y truncado garantizado). `oss.test.ts` corre solo con `TEST_OSS_REPO=/path` (patrón opt-in, como `TEST_LIVE_DB`).

`fixtures/` está **fuera del workspace pnpm a propósito** (ver `pnpm-workspace.yaml`): si pnpm hiciera hoisting dentro de los fixtures, corrompería exactamente el comportamiento de resolución que los tests del resolver verifican. Por eso los fixtures nunca se `pnpm install`ean.

## Comandos

- `pnpm build` — `tsc -b` en todos los paquetes.
- `pnpm test` — `vitest run` (proyectos por paquete, ver `vitest.config.ts` raíz).
- `pnpm lint` — `biome check .`
- `pnpm lint:fix` — `biome check --write .`
- `pnpm typecheck` — `tsc -b` en modo typecheck por paquete.
- `pnpm test:e2e` — build + harness MCP e2e (requiere build porque spawnea el CLI compilado).
- CLI local (requiere build previo): `node packages/cli/dist/index.js <cmd>` — comandos: `init`, `analyze [--full]`, `diff <base> [head] [--json]`, `watch`, `mcp`.
- El server MCP de este propio repo está registrado en `.mcp.json` (dogfooding) — correr `analyze` antes de usarlo.

## Convenciones de testing

- **Fixtures con goldens** (`fixtures/<nombre>/expected-graph.json`): la primera corrida escribe el golden y **falla a propósito** (`expectGolden` en `packages/core/test/helpers.ts`), forzando revisión humana del contenido antes de commitear.
- **Tests del resolver son table-driven** (`packages/core/test/resolver.test.ts`, `packages/core/test/py-resolver.test.ts`): cada bug de resolución nuevo que aparezca se agrega como una fila nueva de caso, nunca como test suelto.
- Los tests de `core` importan `@archmap/schema` desde su `src/` vía alias en `packages/core/vitest.config.ts` (no `dist/`) — el loop red-green no requiere build.

## Reglas del repo

- Commits: conventional commits en español (`feat(core): ...`, `fix(cli): ...`, `chore: ...`), sin `Co-Authored-By` ni atribución de IA.
- **Nunca ejecutar código de los repos analizados.** Solo análisis estático (parseo, no `require`/`import` dinámico ni scripts del target).
- Resolución workspace: cuando un `package.json` declara un entry en `dist/build/lib` (ej. `"main": "dist/index.js"`), el resolver mapea **siempre** a su gemelo en `src/` primero — construido o no — para no apuntar a un artefacto no escaneado (ver comentario en `packages/core/src/resolve/ts-resolver.ts`).
- `.archmap.yaml` de este propio repo excluye `fixtures/**` (los fixtures son inputs de test, no arquitectura real del proyecto).
- `.archmap/` está en `.gitignore` — el grafo generado no se commitea.

## Estado

**Fase 3 completa**: query engine con budget de tokens explícito (`core/src/query/` — clamp [200, 20000], estimación `chars/4 × 1.15`, property test permanente con budgets aleatorios seedeados que asserta `render ≤ budget` en TODOS los tools) + servidor MCP stdio con los 7 tools no-DB (`get_architecture_overview`, `get_module`, `find_dependencies`, `get_impact`, `search_nodes`, `get_file_context`, `get_architecture_diff`). Toda respuesta abre con staleness header (`graph@sha · branch · clean · analyzed Xm ago` + warning si HEAD se movió). Not-found responde con sugerencias de search. Harness e2e valida los hints de drill-down re-ejecutándolos. Validado contra django (2922 archivos: toda respuesta ≤ budget en chars) y probado interactivamente desde Claude Code (headless) leyendo el grafo de este mismo repo.

Fases 1 y 2 (pipeline TS/JS + Python, cache incremental, snapshots por sha, diff rename-aware, watch) completas — ver historial de commits.

Plan completo de 6 fases guardado en Engram (proyecto `visual-work`, topic `visual-work/plan`). **Fase 4** (siguiente): capa DB — extractores estáticos Prisma + SQLAlchemy, `link.ts` (entidad↔tabla, el diferenciador `maps_to`), introspección viva Postgres, `drift.ts` y los 3 tools MCP de DB. El engine ya recorre `maps_to`/`fk` y renderiza tablas en impact — la Fase 4 solo tiene que poblar el grafo.
