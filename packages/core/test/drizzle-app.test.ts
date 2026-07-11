import type { ArchGraph } from "@archmap/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeFixture, expectGolden } from "./helpers.js";

describe("drizzle-app fixture", () => {
  let graph: ArchGraph;

  beforeAll(async () => {
    graph = await analyzeFixture("drizzle-app");
  });

  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  const edge = (kind: string, from: string, to: string) =>
    graph.edges.find((e) => e.kind === kind && e.from === from && e.to === to);

  it("extracts the table builders as entities named after their variables", () => {
    expect(node("ent:src/schema.ts#teams")?.kind).toBe("entity");
    expect(node("ent:src/schema.ts#users")?.kind).toBe("entity");
  });

  it("drizzle table names are always explicit → certain, honoring pgSchema", () => {
    expect(edge("maps_to", "ent:src/schema.ts#teams", "tbl:public.teams")?.confidence).toBe(
      "certain",
    );
    expect(edge("maps_to", "ent:src/schema.ts#users", "tbl:auth.users")?.confidence).toBe(
      "certain",
    );
  });

  it(".references() becomes an fk edge across schemas", () => {
    const fk = edge("fk", "tbl:auth.users", "tbl:public.teams");
    expect(fk?.attrs?.columns).toEqual([["team_id", "id"]]);
  });

  it("the bare text() column inherits its key and stays nullable", () => {
    const users = node("tbl:auth.users");
    if (users?.attrs.kind !== "table") throw new Error("expected table attrs");
    const bio = users.attrs.columns.find((c) => c.name === "bio");
    expect(bio).toMatchObject({ sqlType: "text", nullable: true });
  });

  it("matches the golden graph", () => {
    expectGolden(graph, "drizzle-app");
  });
});
