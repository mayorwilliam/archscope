import type { ArchGraph } from "@archscope/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeFixture, expectGolden } from "./helpers.js";

describe("sqlalchemy-app fixture", () => {
  let graph: ArchGraph;

  beforeAll(async () => {
    graph = await analyzeFixture("sqlalchemy-app");
  });

  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  const edge = (kind: string, from: string, to: string) =>
    graph.edges.find((e) => e.kind === kind && e.from === from && e.to === to);

  it("extracts the three declarative models as entities", () => {
    for (const name of ["Team", "User", "Post"]) {
      const entity = node(`ent:app/models.py#${name}`);
      expect(entity?.kind).toBe("entity");
      expect(entity?.parent).toBe("file:app/models.py");
      expect(entity?.lang).toBe("py");
    }
    // Base has no __tablename__ — not an entity.
    expect(node("ent:app/base.py#Base")).toBeUndefined();
  });

  it("__tablename__ always links certain", () => {
    for (const [entity, table] of [
      ["Team", "teams"],
      ["User", "users"],
      ["Post", "posts"],
    ] as const) {
      const mapsTo = edge("maps_to", `ent:app/models.py#${entity}`, `tbl:public.${table}`);
      expect(mapsTo?.confidence).toBe("certain");
    }
  });

  it("builds both fk edges from ForeignKey declarations", () => {
    expect(edge("fk", "tbl:public.users", "tbl:public.teams")?.attrs?.columns).toEqual([
      ["team_id", "id"],
    ]);
    expect(edge("fk", "tbl:public.posts", "tbl:public.users")?.attrs?.columns).toEqual([
      ["author_id", "id"],
    ]);
  });

  it("mixes classic Column and 2.0 mapped_column styles in one table set", () => {
    const teams = node("tbl:public.teams");
    if (teams?.attrs.kind !== "table") throw new Error("expected table attrs");
    expect(teams.attrs.columns.map((c) => c.name)).toEqual(["id", "team_name"]);

    const users = node("tbl:public.users");
    if (users?.attrs.kind !== "table") throw new Error("expected table attrs");
    const bio = users.attrs.columns.find((c) => c.name === "bio");
    expect(bio?.nullable).toBe(true);
    const email = users.attrs.columns.find((c) => c.name === "email");
    expect(email).toMatchObject({ sqlType: "str", nullable: false });
  });

  it("relationship() attributes never become columns", () => {
    const users = node("tbl:public.users");
    if (users?.attrs.kind !== "table") throw new Error("expected table attrs");
    expect(users.attrs.columns.some((c) => c.name === "posts")).toBe(false);
  });

  it("matches the golden graph", () => {
    expectGolden(graph, "sqlalchemy-app");
  });
});
