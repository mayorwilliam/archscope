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

Monorepo pnpm (`pnpm-workspace.yaml`: `packages/*`):

- **packages/schema** — tipos Zod del grafo (`ArchGraph`, `GraphNode`, `GraphEdge`, etc.) e IDs estables. Los IDs (`mod:`, `file:`, `sym:`, `ent:`, `tbl:`, `pkg:`) se construyen y parsean **solo** en `packages/schema/src/ids.ts` — ningún otro paquete debe montar un ID a mano.
- **packages/core** — el pipeline: `scan` → `parse` (tree-sitter WASM) → `resolve` (imports/workspace) → `infer` (módulos) → `graph/build` (el grafo final + métricas).
- **packages/cli** — bin `archmap` (Commander): comandos `init` (detecta el stack y escribe `.archmap.yaml`) y `analyze` (corre el pipeline y escribe `.archmap/graph.json`).

`fixtures/` está **fuera del workspace pnpm a propósito** (ver `pnpm-workspace.yaml`): si pnpm hiciera hoisting dentro de los fixtures, corrompería exactamente el comportamiento de resolución que los tests del resolver verifican. Por eso los fixtures nunca se `pnpm install`ean.

## Comandos

- `pnpm build` — `tsc -b` en todos los paquetes.
- `pnpm test` — `vitest run` (proyectos por paquete, ver `vitest.config.ts` raíz).
- `pnpm lint` — `biome check .`
- `pnpm lint:fix` — `biome check --write .`
- `pnpm typecheck` — `tsc -b` en modo typecheck por paquete.
- CLI local (requiere build previo): `node packages/cli/dist/index.js <cmd>` — comandos: `init`, `analyze [--full]`, `diff <base> [head] [--json]`, `watch`.

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

**Fase 2 completa**: extracción TS/JS + Python deterministas, cache incremental de `FileFacts` por content-hash (`.archmap/cache/`), snapshots gzip por sha (`.archmap/snapshots/`, solo con árbol limpio), diff arquitectónico rename-aware (`archmap diff` — snapshots bajo demanda vía git worktree temporal con cache compartido) y watch mode. Fixtures `ts-basic`/`ts-monorepo`/`py-basic` con goldens revisados a mano. Validado contra requests/flask/django (django: 3034 archivos, 20s frío / 1.9s caliente).

Plan completo de 6 fases guardado en Engram (proyecto `visual-work`, topic `visual-work/plan`). **Fase 3** (siguiente): query engine con budget de tokens explícito + servidor MCP (los 7 tools no-DB), MCP antes que dashboard para forzar el query engine como librería pura.
