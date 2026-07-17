import { mergeLiveSchema } from "@archscope/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  dbSchemaView,
  entityRelationsView,
  erdView,
  type GraphIndex,
  indexGraph,
  schemaDriftView,
} from "../src/query/engine.js";
import { analyzeFixture } from "./helpers.js";

describe("DB query views over the sqlalchemy-app fixture", () => {
  let index: GraphIndex;

  beforeAll(async () => {
    index = indexGraph(await analyzeFixture("sqlalchemy-app"));
  });

  it("dbSchemaView groups tables by schema with entity linkage", () => {
    const view = dbSchemaView(index);
    expect(view.live).toBeNull();
    expect(view.totals).toEqual({ tables: 3, entities: 3, drift: 0 });
    expect(view.schemas.map((s) => s.schema)).toEqual(["public"]);
    const users = view.schemas[0]?.tables.find((t) => t.name === "users");
    expect(users?.entities.map((e) => e.id)).toEqual(["ent:app/models.py#User"]);
    expect(users?.pks).toEqual(["id"]);
    expect(view.fks.map((f) => `${f.from}→${f.to}`)).toEqual([
      "tbl:public.posts→tbl:public.users",
      "tbl:public.users→tbl:public.teams",
    ]);
  });

  it("erdView ships full columns with PK/FK marks, entities and drift per table", () => {
    const view = erdView(index);
    expect(view.live).toBeNull();
    expect(view.totals).toEqual({ tables: 3, entities: 3, fks: 2, drift: 0 });
    expect(view.tables.map((t) => t.id)).toEqual([
      "tbl:public.posts",
      "tbl:public.teams",
      "tbl:public.users",
    ]);
    const users = view.tables.find((t) => t.name === "users");
    expect(users?.schema).toBe("public");
    expect(users?.columns.find((c) => c.name === "id")?.isPk).toBe(true);
    expect(users?.columns.find((c) => c.name === "team_id")?.fkTo).toEqual({
      table: "public.teams",
      column: "id",
    });
    expect(users?.entities.map((e) => e.id)).toEqual(["ent:app/models.py#User"]);
    expect(users?.drift).toEqual([]);
    expect(view.fks.map((f) => `${f.from}→${f.to}`)).toEqual([
      "tbl:public.posts→tbl:public.users",
      "tbl:public.users→tbl:public.teams",
    ]);
  });

  it("entityRelationsView resolves an entity by bare name", () => {
    const view = entityRelationsView(index, "User");
    expect(view?.center.id).toBe("ent:app/models.py#User");
    expect(view?.table?.id).toBe("tbl:public.users");
    expect(view?.fields?.map((f) => f.name)).toEqual(["id", "email", "bio", "team_id"]);
    // users → teams (out) and posts → users (in)
    expect(view?.related.map((r) => `${r.direction} ${r.tableId}`)).toEqual([
      "in tbl:public.posts",
      "out tbl:public.teams",
    ]);
    expect(view?.related.find((r) => r.direction === "in")?.entities.map((e) => e.id)).toEqual([
      "ent:app/models.py#Post",
    ]);
  });

  it("entityRelationsView resolves a table by schema-qualified and bare name", () => {
    const qualified = entityRelationsView(index, "public.users");
    expect(qualified?.center.kind).toBe("table");
    expect(qualified?.fields).toBeNull();
    expect(qualified?.entities.map((e) => e.id)).toEqual(["ent:app/models.py#User"]);
    const bare = entityRelationsView(index, "users");
    expect(bare?.center.id).toBe("tbl:public.users");
  });

  it("returns null for unknown refs so callers can suggest alternatives", () => {
    expect(entityRelationsView(index, "Ghost")).toBeNull();
  });

  it("schemaDriftView without introspection reports no live source", () => {
    const view = schemaDriftView(index);
    expect(view.live).toBeNull();
    expect(view.totals).toEqual({ tablesWithDrift: 0, entries: 0, tablesChecked: 3 });
  });

  it("schemaDriftView surfaces drift after a live merge", async () => {
    const graph = await analyzeFixture("sqlalchemy-app");
    const { graph: merged } = mergeLiveSchema(
      graph,
      {
        dialect: "postgres",
        tables: [
          {
            schema: "public",
            name: "teams",
            columns: [
              { name: "id", sqlType: "int4", nullable: false, isPk: true },
              { name: "team_name", sqlType: "varchar", nullable: false, isPk: false },
              { name: "created_at", sqlType: "timestamptz", nullable: true, isPk: false },
            ],
            fks: [],
          },
          // users and posts intentionally absent → table_missing_in_db.
        ],
      },
      { source: "main", dialect: "postgres", introspectedAt: "2026-07-08T00:00:00.000Z" },
    );
    const view = schemaDriftView(indexGraph(merged));
    expect(view.live?.source).toBe("main");
    const byTable = new Map(view.tables.map((t) => [t.id, t.entries.map((e) => e.kind)]));
    expect(byTable.get("tbl:public.teams")).toEqual(["column_missing_in_code"]);
    expect(byTable.get("tbl:public.users")).toEqual(["table_missing_in_db"]);
    expect(byTable.get("tbl:public.posts")).toEqual(["table_missing_in_db"]);

    // The same entries back the ERD's per-table drift badges.
    const erd = erdView(indexGraph(merged));
    expect(erd.totals.drift).toBe(3);
    expect(erd.tables.find((t) => t.name === "teams")?.drift.map((d) => d.kind)).toEqual([
      "column_missing_in_code",
    ]);
  });
});
