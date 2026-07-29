# Changelog

## 0.2.0

ArchScope deja de ser un dashboard de grafos y pasa a ser **el wiki de tu proyecto, conectado por grafos**.

- **Prosa determinista en el grafo** (`schemaVersion` 2): los READMEs, `docs/**` y `*.md` de raíz son nodos `doc` con su contenido embebido y un edge `documents` hacia el módulo que documentan (con confidence explícita); los JSDoc/TSDoc y docstrings de Python viajan como resumen en cada símbolo y archivo. Cero LLM, byte a byte reproducible. Curado por defecto y overrideable con `docs.include/exclude` en `.archscope.yaml`.
- **Dashboard wiki-first**: sidebar persistente con búsqueda (módulos, archivos y docs), home con el README del proyecto + stat cards + salud de dependencias (ciclos), páginas de módulo con prosa, métricas (instability incluida), mini-grafo de vecindario embebido y tabla de archivos con sus docs. El canvas completo vive en `#/graph` (expand/collapse, buscador jump-to-node y foco de vecindario incluidos). Estética editorial nueva, claro y oscuro.
- **Timeline** (`#/timeline`): tags como hitos, commits recientes como detalle; click en un punto materializa su snapshot on-demand y muestra el resumen; dos puntos → compare. Los diffs ahora son **linkeables**: `#/diff/<base>..<head>`.
- **Visor de archivo**: click en un archivo del grafo abre un modal con el código completo resaltado, búsqueda dentro del archivo, outline de exports con salto a línea, historia git del archivo (rename-aware) y el **diff de cada commit** — lo que estaba antes en rojo, el cambio en verde.
- **Servidor MCP: 10 → 13 tools**: `get_doc` (prosa del wiki), `get_timeline` (el eje temporal, marcando qué snapshots existen) y `get_architecture_history` (un rango de historia como serie de intervalos diffeados) — pensadas para que un agente estudie cómo evolucionó la arquitectura.
- **REST nuevo** para el dashboard: `/api/docs|doc|file|file/history|file/diff|source|timeline|timeline/point` — `source` y los endpoints de archivo solo sirven paths que existen como nodos del grafo (anti-traversal por construcción).
- **Watch**: los `.md` también disparan re-análisis — el wiki se actualiza en vivo.
- Migración: correr `archscope analyze` tras actualizar (el `schemaVersion` nuevo lo pide); los snapshots viejos se reconstruyen solos on-demand.

## 0.1.0

Primera versión publicable.

- **Pipeline determinista** TS/JS + Python: tree-sitter WASM, resolución con tsconfig paths / workspaces / imports relativos Python, inferencia de módulos en 3 niveles, PageRank precomputado. Cero LLM, cero ejecución de código del repo analizado.
- **Capa DB**: extractores estáticos Prisma, SQLAlchemy, TypeORM, Drizzle y Django → un mismo `DeclaredSchema`; link entidad↔tabla (`maps_to`) con confidence explícita; introspección viva **Postgres y MySQL** (read-only, credenciales solo por env var, jamás persistidas); **drift** declarado-vs-vivo por familias de tipo; detección Alembic best-effort (heads + conteo).
- **Historia**: snapshots por git sha, diff arquitectónico rename-aware (`archscope diff`), watch incremental.
- **Query engine con presupuesto de tokens**: toda respuesta ≤ budget por construcción, truncado con hint de drill-down ejecutable, header de staleness.
- **Servidor MCP** (stdio): 10 tools sobre el mismo grafo.
- **Dashboard** (React Flow + ELK): overview con expand/collapse, drill-down de módulo, ERD con PK/FK y badges de drift, vista diff — live update por SSE sin reload.
- **Performance**: parse paralelo con piscina sobre el umbral de 200 archivos; 5k archivos en ~3s frío / ~2s caliente (presupuesto: 60s/5s).
- **Empaquetado**: un solo paquete npm (bundle tsup, dashboard embebido, worker de piscina como entry propio); `npx <pkg> init && analyze && serve` sin build steps; CI matrix macOS/Linux/Windows.
