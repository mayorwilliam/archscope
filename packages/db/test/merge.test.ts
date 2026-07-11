import type { ArchGraph } from "@archmap/schema";
import { parseArchGraph } from "@archmap/schema";
import { describe, expect, it } from "vitest";
import type { LiveSchema } from "../src/introspect.js";
import { mergeLiveSchema } from "../src/merge.js";

function baseGraph(): ArchGraph {
  return parseArchGraph({
    schemaVersion: 1,
    meta: {
      tool: "archmap",
      toolVersion: "test",
      createdAt: "1970-01-01T00:00:00.000Z",
      root: "<test>",
      git: null,
      counts: { module: 0, file: 0, symbol: 0, entity: 0, table: 1, extpkg: 0 },
    },
    nodes: [
      {
        id: "tbl:public.users",
        kind: "table",
        name: "users",
        attrs: {
          kind: "table",
          origin: "declared",
          columns: [
            { name: "id", sqlType: "Int", nullable: false, isPk: true },
            { name: "email", sqlType: "String", nullable: false, isPk: false },
          ],
        },
        metrics: { fanIn: 0, fanOut: 0, rank: 0 },
      },
    ],
    edges: [],
  });
}

const live: LiveSchema = {
  dialect: "postgres",
  tables: [
    {
      schema: "public",
      name: "users",
      columns: [
        { name: "id", sqlType: "int4", nullable: false, isPk: true },
        { name: "email", sqlType: "varchar", nullable: false, isPk: false },
        { name: "created_at", sqlType: "timestamptz", nullable: true, isPk: false },
      ],
      fks: [],
    },
    {
      schema: "public",
      name: "sessions",
      columns: [
        { name: "id", sqlType: "int4", nullable: false, isPk: true },
        { name: "user_id", sqlType: "int4", nullable: false, isPk: false },
      ],
      fks: [{ fromColumns: ["user_id"], toSchema: "public", toTable: "users", toColumns: ["id"] }],
    },
  ],
};

const options = {
  source: "main",
  dialect: "postgres" as const,
  introspectedAt: "2026-07-08T00:00:00.000Z",
};

describe("mergeLiveSchema", () => {
  const { graph, drift } = mergeLiveSchema(baseGraph(), live, options);

  it("upgrades matched declared tables to origin both, keeping DECLARED columns", () => {
    const users = graph.nodes.find((n) => n.id === "tbl:public.users");
    if (users?.attrs.kind !== "table") throw new Error("expected table attrs");
    expect(users.attrs.origin).toBe("both");
    // Code truth stays intact — the live-only column shows up as drift, not as
    // a column. Declared column order is preserved verbatim.
    expect(users.attrs.columns.map((c) => c.name)).toEqual(["id", "email"]);
    expect(users.attrs.drift?.map((d) => d.kind)).toEqual(["column_missing_in_code"]);
  });

  it("adds live-only tables with live columns and a missing-in-code drift entry", () => {
    const sessions = graph.nodes.find((n) => n.id === "tbl:public.sessions");
    if (sessions?.attrs.kind !== "table") throw new Error("expected table attrs");
    expect(sessions.attrs.origin).toBe("live");
    expect(sessions.attrs.columns.map((c) => c.name)).toEqual(["id", "user_id"]);
    expect(sessions.attrs.columns.find((c) => c.name === "user_id")?.fkTo).toEqual({
      table: "public.users",
      column: "id",
    });
    expect(sessions.attrs.drift?.map((d) => d.kind)).toEqual(["table_missing_in_code"]);
  });

  it("adds live FK edges with source live", () => {
    const fk = graph.edges.find((e) => e.id === "fk|tbl:public.sessions|tbl:public.users");
    expect(fk).toMatchObject({ kind: "fk", source: "live", confidence: "certain" });
    expect(fk?.attrs?.columns).toEqual([["user_id", "id"]]);
  });

  it("stamps meta.live and recounts nodes", () => {
    expect(graph.meta.live).toEqual(options);
    expect(graph.meta.counts.table).toBe(2);
  });

  it("returns the same drift the report API computes", () => {
    expect(drift.total).toBe(2);
  });

  it("is idempotent: merging the same live schema twice is byte-identical", () => {
    const second = mergeLiveSchema(graph, live, options);
    expect(JSON.stringify(second.graph)).toBe(JSON.stringify(graph));
  });

  it("a fresh live schema replaces the previous overlay instead of stacking", () => {
    const shrunk: LiveSchema = {
      dialect: "postgres",
      tables: [live.tables[0] as LiveSchema["tables"][number]],
    };
    const remerged = mergeLiveSchema(graph, shrunk, options).graph;
    expect(remerged.nodes.some((n) => n.id === "tbl:public.sessions")).toBe(false);
    expect(remerged.edges.some((e) => e.source === "live")).toBe(false);
    expect(remerged.meta.counts.table).toBe(1);
  });

  it("the merged graph still validates against the zod schema", () => {
    expect(() => parseArchGraph(JSON.parse(JSON.stringify(graph)))).not.toThrow();
  });
});

describe("mergeLiveSchema — MySQL default-schema mapping", () => {
  const mysqlLive: LiveSchema = {
    dialect: "mysql",
    defaultSchema: "appdb", // MySQL: schema == the connection's database
    tables: [
      {
        schema: "appdb",
        name: "users",
        columns: [
          { name: "id", sqlType: "int", nullable: false, isPk: true },
          { name: "email", sqlType: "varchar", nullable: false, isPk: false },
        ],
        fks: [],
      },
      {
        schema: "appdb",
        name: "sessions",
        columns: [
          { name: "id", sqlType: "int", nullable: false, isPk: true },
          { name: "user_id", sqlType: "int", nullable: false, isPk: false },
        ],
        fks: [{ fromColumns: ["user_id"], toSchema: "appdb", toTable: "users", toColumns: ["id"] }],
      },
    ],
  };
  const mysqlOptions = { ...options, dialect: "mysql" as const };
  const { graph, drift } = mergeLiveSchema(baseGraph(), mysqlLive, mysqlOptions);

  it("matches tbl:public.* against the connection's database, keeping the node id", () => {
    const users = graph.nodes.find((n) => n.id === "tbl:public.users");
    if (users?.attrs.kind !== "table") throw new Error("expected table attrs");
    expect(users.attrs.origin).toBe("both");
    expect(drift.byTable.has("appdb.users")).toBe(false); // clean match
  });

  it("live-only tables keep their real schema in the node id", () => {
    const sessions = graph.nodes.find((n) => n.id === "tbl:appdb.sessions");
    if (sessions?.attrs.kind !== "table") throw new Error("expected table attrs");
    expect(sessions.attrs.origin).toBe("live");
  });

  it("live FKs resolve to the DECLARED node when the table matched", () => {
    const fk = graph.edges.find((e) => e.kind === "fk" && e.source === "live");
    expect(fk?.from).toBe("tbl:appdb.sessions");
    expect(fk?.to).toBe("tbl:public.users"); // mapped, not tbl:appdb.users
  });

  it("stays idempotent under the mapping", () => {
    const second = mergeLiveSchema(graph, mysqlLive, mysqlOptions);
    expect(JSON.stringify(second.graph)).toBe(JSON.stringify(graph));
  });
});
