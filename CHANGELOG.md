# Changelog

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
