import type { ArchGraph } from "@archscope/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeFixture, expectGolden } from "./helpers.js";

describe("typeorm-app fixture", () => {
  let graph: ArchGraph;

  beforeAll(async () => {
    graph = await analyzeFixture("typeorm-app");
  });

  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  const edge = (kind: string, from: string, to: string) =>
    graph.edges.find((e) => e.kind === kind && e.from === from && e.to === to);

  it("extracts the decorated classes as entities", () => {
    const team = node("ent:src/entities/team.ts#Team");
    expect(team?.kind).toBe("entity");
    expect(team?.parent).toBe("file:src/entities/team.ts");
    expect(node("ent:src/entities/user.ts#UserAccount")?.kind).toBe("entity");
  });

  it("explicit @Entity name links certain; naming convention links inferred", () => {
    const explicit = edge("maps_to", "ent:src/entities/team.ts#Team", "tbl:org.teams");
    expect(explicit?.confidence).toBe("certain");
    // UserAccount → snake_case convention → user_account, inferred.
    const convention = edge(
      "maps_to",
      "ent:src/entities/user.ts#UserAccount",
      "tbl:public.user_account",
    );
    expect(convention?.confidence).toBe("inferred");
  });

  it("the cross-file ManyToOne becomes an fk edge with its join column", () => {
    const fk = edge("fk", "tbl:public.user_account", "tbl:org.teams");
    expect(fk?.attrs?.columns).toEqual([["team_id", "id"]]);
  });

  it("matches the golden graph", () => {
    expectGolden(graph, "typeorm-app");
  });
});
