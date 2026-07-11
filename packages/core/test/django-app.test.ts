import type { ArchGraph } from "@archmap/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeFixture, expectGolden } from "./helpers.js";

describe("django-app fixture", () => {
  let graph: ArchGraph;

  beforeAll(async () => {
    graph = await analyzeFixture("django-app");
  });

  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  const edge = (kind: string, from: string, to: string) =>
    graph.edges.find((e) => e.kind === kind && e.from === from && e.to === to);

  it("concrete models are entities; the abstract base is not", () => {
    expect(node("ent:shop/models.py#Team")?.kind).toBe("entity");
    expect(node("ent:shop/models.py#Customer")?.kind).toBe("entity");
    expect(node("ent:shop/models.py#AbstractAudit")).toBeUndefined();
  });

  it("Meta.db_table links certain; app_model convention links inferred", () => {
    expect(edge("maps_to", "ent:shop/models.py#Team", "tbl:public.orgs_team")?.confidence).toBe(
      "certain",
    );
    expect(
      edge("maps_to", "ent:shop/models.py#Customer", "tbl:public.shop_customer")?.confidence,
    ).toBe("inferred");
  });

  it("ForeignKey becomes an fk edge through the synthesized _id column", () => {
    const fk = edge("fk", "tbl:public.shop_customer", "tbl:public.orgs_team");
    expect(fk?.attrs?.columns).toEqual([["team_id", "id"]]);
  });

  it("the implicit auto PK is declared with an incomparable type", () => {
    const team = node("tbl:public.orgs_team");
    if (team?.attrs.kind !== "table") throw new Error("expected table attrs");
    const id = team.attrs.columns.find((c) => c.name === "id");
    expect(id).toMatchObject({ isPk: true, sqlType: "unknown" });
  });

  it("matches the golden graph", () => {
    expectGolden(graph, "django-app");
  });
});
