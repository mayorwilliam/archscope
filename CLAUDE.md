# CLAUDE.md

Guía para Claude Code trabajando en **ArchScope** (nombre definitivo; el working name histórico fue "ArchMap", renombrado porque `archmap` ya estaba tomado en npm).

## Qué es

Herramienta local-first que extrae la arquitectura de un repo mediante análisis estático determinista y la sirve desde un único grafo a dos consumidores: un dashboard web y un servidor MCP.

Principios innegociables:

1. **El grafo es la única fuente de verdad.** `.archscope/graph.json` es el producto. Ningún consumidor (dashboard, MCP, diff) re-deriva hechos estructurales por su cuenta — todos leen el mismo grafo.
2. **Determinismo.** Cero LLM en el pipeline de extracción. El mismo repo, analizado dos veces, produce el mismo grafo byte a byte (salvo campos volátiles como timestamps).
3. **Presupuesto de tokens de primera clase.** Toda query futura (dashboard, MCP) va a llevar un budget de tokens explícito — no se diseña ninguna interfaz de consulta sin esto en mente.
4. **Procedencia de cada edge.** Todo edge del grafo lleva `source` (`static` | `live` | `manual`) y `confidence` (`certain` | `inferred`) — nunca se presenta un hecho estructural sin decir de dónde salió y qué tan seguro está el sistema de él.

## Estructura

Monorepo pnpm (`pnpm-workspace.yaml`: `packages/*` + `e2e`):

- **packages/schema** — tipos Zod del grafo (`ArchGraph`, `GraphNode`, `GraphEdge`, etc.) e IDs estables. Los IDs (`mod:`, `file:`, `sym:`, `ent:`, `tbl:`, `pkg:`) se construyen y parsean **solo** en `packages/schema/src/ids.ts` — ningún otro paquete debe montar un ID a mano.
- **packages/core** — el pipeline: `scan` → `parse` (tree-sitter WASM) → `resolve` (imports/workspace) → `infer` (módulos) → `graph/build` (el grafo final + métricas). Además **`src/query/`**: el query engine puro (`engine.ts` view-models JSON-serializables, `render.ts` markdown compacto, `budget.ts` presupuesto). El `BudgetWriter` garantiza **por construcción** que ningún render excede su budget; el truncado siempre termina en un hint ejecutable (`… +N more → tool(...)`).
- **packages/db** — capa DB. Extractores estáticos (`prisma.ts` vía `@mrleebo/prisma-ast`; `sqlalchemy.ts`, `typeorm.ts`, `drizzle.ts` y `django.ts` reciben el árbol tree-sitter **ya parseado** por core — inyección, cero WASM propio) que emiten el mismo intermedio `DeclaredSchema`. `link.ts` (entidad↔tabla: nombre explícito `@@map`/`__tablename__`/`@Entity("x")`/`db_table` → `certain`, convención → `inferred`), `introspect.ts` + `introspect-mysql.ts` (Postgres/MySQL read-only, la URL jamás se persiste y los errores del driver se redactan; en MySQL schema == database → `LiveSchema.defaultSchema` mapea el placeholder `public` declarado al comparar, los nombres vivos se reportan reales), `drift.ts` (declarado vs vivo por familias de tipo normalizadas; `tinyint(1)` → boolean por convención; tipo declarado `unknown` = incomparable, jamás falso positivo), `merge.ts` (overlay vivo **idempotente**: las columnas declaradas quedan intactas, el drift es el delta; `analyze` regenera sin overlay) y `alembic.ts` (detección best-effort: heads + conteo por regex, jamás reconstruye schema — solo línea informativa en `db drift`). Depende solo de `schema` — `core` → `db`, nunca al revés.
- **packages/mcp** — servidor MCP stdio (`@modelcontextprotocol/sdk`). Handlers ≤30 líneas que delegan a `core/query` — jamás derivan hechos estructurales por su cuenta. `GraphSource` (vive en core, compartido con `serve`) relee `graph.json` por mtime (convive con `watch`) y recalcula el staleness (HEAD actual vs sha del grafo) en cada llamada.
- **packages/dashboard** — Vite + React 19 + React Flow (`@xyflow/react`) + elkjs. 4 vistas por hash routing: Overview (módulos con expand/collapse a subflow de archivos), Module drill-down (archivos + imports internos + vecinos agregados, panel de símbolos), ERD (columnas con PK/FK, chips de entidades con confidence, badge de drift) y Diff (pickers de refs, overlay verde/rojo/ámbar + changelist). Consume los view-models de `core/query` **verbatim** vía REST; SSE `graph-updated` → `invalidateQueries()` de react-query = live update. Los builders grafo→flow son puros y unit-testeados (`src/graph/toFlow.ts`); el layout ELK corre en web worker (`elk-api` + `elk-worker.min.js?worker` — el `elk.bundled.js` NO sobrevive el rebundleo de Vite dentro de un worker). Publica solo `dist/` estático; deps todas en devDependencies (se bundlean).
- **packages/cli** — bin `archscope` (Commander): `init`, `analyze [--full]`, `diff`, `watch`, `serve [--port 4400]`, `mcp`, `db introspect|drift`. En el comando `mcp`, stdout es el canal del protocolo: cualquier log humano va a stderr. `serve` = backend completo del dashboard: fastify con estáticos del dashboard, REST (`/api/overview|module|erd|drift|refs|diff|meta`) que devuelve view-models en JSON, SSE (`/api/events`, chokidar sobre `graph.json` — capta también escritores externos como `db introspect`) y el watch de fuentes in-process (`startWatch`, compartido con el comando `watch`). Escucha solo en 127.0.0.1 (local-first). **Es EL paquete publicable**: bundle `tsup` de un solo paquete — los `@archscope/*` (todos `private`) van en devDependencies y se inlinean; las deps de terceros quedan externas como dependencies reales; el worker de piscina se emite como entry propio (`dist/parse/worker.js`, cargado por path en runtime); el dist del dashboard y el README raíz se copian adentro del paquete al build (`scripts/copy-dashboard.mjs`, gitignoreados). `src/version.ts` es la única fuente de versión (CLI `--version`, `meta.toolVersion`, serverInfo MCP).
- **e2e/** — harness contra el CLI **compilado**: SDK `Client` sobre stdio. `mcp.test.ts` usa un repo sintético puro TS (12 módulos en cadena → números de impact exactos); `db.test.ts` usa su propio mini-repo Prisma (26 models → truncado garantizado) para no perturbar esos números. `oss.test.ts` corre solo con `TEST_OSS_REPO=/path` (patrón opt-in, como `TEST_LIVE_DB`). **`dashboard/`** (Playwright, no vitest): fixture con historia git real (base→head con módulo agregado/borrado, dep nueva y columna Prisma nueva) contra `archscope serve`; cubre los 5 criterios de aceptación de Fase 5, incluido el live update <2s sin reload.

`fixtures/` está **fuera del workspace pnpm a propósito** (ver `pnpm-workspace.yaml`): si pnpm hiciera hoisting dentro de los fixtures, corrompería exactamente el comportamiento de resolución que los tests del resolver verifican. Por eso los fixtures nunca se `pnpm install`ean.

## Comandos

- `pnpm build` — build de todos los paquetes (`tsc -b`; el dashboard usa `vite build`; el CLI usa `tsup` y copia el dashboard adentro).
- `pnpm test` — `vitest run` (proyectos por paquete, ver `vitest.config.ts` raíz).
- `pnpm lint` — `biome check .`
- `pnpm lint:fix` — `biome check --write .`
- `pnpm typecheck` — `tsc -b` en modo typecheck por paquete (dashboard y cli: `tsc --noEmit`).
- `pnpm test:e2e` — build + harness MCP e2e (requiere build porque spawnea el CLI compilado).
- `pnpm test:e2e:dashboard` — build + smoke Playwright del dashboard (requiere `pnpm -C e2e exec playwright install chromium` la primera vez).
- `pnpm bench` — build + repo sintético de 5k archivos: presupuesto <60s frío / <5s caliente (`--assert` para gate; corre no-bloqueante en CI).
- CLI local (requiere build previo): `node packages/cli/dist/index.js <cmd>` — comandos: `init`, `analyze [--full]`, `diff <base> [head] [--json]`, `watch`, `serve [--port 4400]`, `mcp`, `db introspect [--source]`, `db drift [--source] [--json]` (exit 1 si hay drift — pensado para CI).
- Dev del dashboard: `pnpm -C packages/dashboard dev` (Vite con proxy `/api` → `localhost:4400`) contra un `archscope serve` corriendo.
- El server MCP de este propio repo está registrado en `.mcp.json` (dogfooding) — correr `analyze` antes de usarlo.

## Convenciones de testing

- **Fixtures con goldens** (`fixtures/<nombre>/expected-graph.json`): la primera corrida escribe el golden y **falla a propósito** (`expectGolden` en `packages/core/test/helpers.ts`), forzando revisión humana del contenido antes de commitear.
- **Tests del resolver son table-driven** (`packages/core/test/resolver.test.ts`, `packages/core/test/py-resolver.test.ts`): cada bug de resolución nuevo que aparezca se agrega como una fila nueva de caso, nunca como test suelto.
- Los tests de `core` importan `@archscope/schema` y `@archscope/db` desde su `src/` vía alias en `packages/core/vitest.config.ts` (no `dist/`) — el loop red-green no requiere build.
- **Tests de DB viva** (`packages/db/test/live-postgres.test.ts`, `live-mysql.test.ts`): Testcontainers, gated por `TEST_LIVE_DB=1` (requiere Docker). Plantan drift exacto y validan que el reporte contenga eso y **nada más**, más la guarda de credenciales (grep de URL/password sobre todo output de `.archscope/`). El de MySQL además cubre el mapeo schema==database y `tinyint(1)`→boolean.
- Al agregar o cambiar un extractor: bump de `EXTRACTOR_VERSION` en `packages/core/src/store/cache.ts` — el cache se invalida solo por key, sin lógica.

## Reglas del repo

- Commits: conventional commits en español (`feat(core): ...`, `fix(cli): ...`, `chore: ...`), sin `Co-Authored-By` ni atribución de IA.
- **Nunca ejecutar código de los repos analizados.** Solo análisis estático (parseo, no `require`/`import` dinámico ni scripts del target).
- Resolución workspace: cuando un `package.json` declara un entry en `dist/build/lib` (ej. `"main": "dist/index.js"`), el resolver mapea **siempre** a su gemelo en `src/` primero — construido o no — para no apuntar a un artefacto no escaneado (ver comentario en `packages/core/src/resolve/ts-resolver.ts`).
- `.archscope.yaml` de este propio repo excluye `fixtures/**` (los fixtures son inputs de test, no arquitectura real del proyecto).
- `.archscope/` está en `.gitignore` — el grafo generado no se commitea.

## Estado

**Fase 6 (última) completa — v0.1.0 PUBLICADA**: extractores TypeORM/Drizzle/Django (fixtures `typeorm-app`/`drizzle-app`/`django-app` con goldens revisados), introspección MySQL con mapeo de schema default, Alembic best-effort, parse paralelo con piscina (umbral 200 misses; bench 5k archivos: ~3s frío / ~2s caliente, presupuesto 60s/5s, determinismo verificado por hash), bundle tsup de un solo paquete + smoke real de `npm pack` → `npx archscope init && analyze && serve && mcp` en proyecto limpio, CI multiplataforma (`.github/workflows/ci.yml`), README + CHANGELOG 0.1.0.

**Nombre definitivo: `archscope`** (2026-07-17). El working name `archmap` estaba tomado en npm (`archmap@1.5.0`, paquete ajeno). Verificado libre en el registry, incluida la variante `arch-scope` (la regla de similitud por puntuación de npm bloquea nombres que colisionan al quitar guiones — descartó a `archatlas`). Rename completo aplicado: bin, paquete, scope interno `@archscope/*`, `.archscope/`, `.archscope.yaml`, MCP, docs, goldens.

**v0.1.0 publicada en npm** (2026-07-26, `npx archscope`): repo público `github.com/mayorwilliam/archscope`, tag `v0.1.0`, CI multiplataforma verde (Ubuntu/macOS/Windows + bench + dashboard e2e) y smoke verificado instalando desde el registry en proyecto limpio. La primera corrida real del CI destapó 4 bugs multiplataforma, todos arreglados: CRLF en Windows (fix: `.gitattributes` con `eol=lf`), EBUSY al borrar temp dirs (fix: `maxRetries` en `rmSync` + cleanup best-effort en cache.test), `resolvePackageEntry` de vite roto con junctions de pnpm (fix: alias workspace→src en `e2e/vitest.config.ts`) y **comillas simples en los filtros pnpm del package.json raíz que cmd.exe trataba como literales — build y typecheck salían verdes sin ejecutar nada en Windows** (fix: comillas dobles escapadas; regla: los scripts npm corren bajo cmd.exe en Windows, jamás usar comillas simples en ellos).

Fases 1–5 completas — ver historial de commits. Pendiente heredado: correr `TEST_LIVE_DB=1` (Testcontainers Postgres + MySQL, falta Docker en la sesión).

Plan completo de 6 fases guardado en Engram (proyecto `visual-work`, topic `visual-work/plan`).
