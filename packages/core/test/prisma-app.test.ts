import type { ArchGraph } from "@archscope/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeFixture, expectGolden } from "./helpers.js";

describe("prisma-app fixture", () => {
  let graph: ArchGraph;

  beforeAll(async () => {
    graph = await analyzeFixture("prisma-app");
  });

  const node = (id: string) => graph.nodes.find((n) => n.id === id);
  const edge = (kind: string, from: string, to: string) =>
    graph.edges.find((e) => e.kind === kind && e.from === from && e.to === to);

  it("creates one entity per model, parented to the .prisma file", () => {
    const user = node("ent:prisma/schema.prisma#User");
    expect(user?.kind).toBe("entity");
    expect(user?.parent).toBe("file:prisma/schema.prisma");
    expect(node("ent:prisma/schema.prisma#Post")).toBeDefined();
    // The enum is a type, not an entity.
    expect(node("ent:prisma/schema.prisma#Role")).toBeUndefined();
  });

  it("keeps columns as attrs with @map overrides applied", () => {
    const user = node("ent:prisma/schema.prisma#User");
    if (user?.attrs.kind !== "entity") throw new Error("expected entity attrs");
    expect(user.attrs.declaredTable).toBe("public.User");
    const fullName = user.attrs.fields.find((f) => f.name === "fullName");
    expect(fullName).toMatchObject({ column: "full_name", nullable: true, type: "String" });
    // Relation fields are navigation, not columns.
    expect(user.attrs.fields.some((f) => f.name === "posts")).toBe(false);
  });

  it("links maps_to: @@map explicit → certain, model-name convention → inferred", () => {
    const posts = edge("maps_to", "ent:prisma/schema.prisma#Post", "tbl:public.posts");
    expect(posts?.confidence).toBe("certain");
    expect(posts?.source).toBe("static");
    const user = edge("maps_to", "ent:prisma/schema.prisma#User", "tbl:public.User");
    expect(user?.confidence).toBe("inferred");
  });

  it("declares tables with columns and the FK annotation", () => {
    const posts = node("tbl:public.posts");
    if (posts?.attrs.kind !== "table") throw new Error("expected table attrs");
    expect(posts.attrs.origin).toBe("declared");
    const authorId = posts.attrs.columns.find((c) => c.name === "author_id");
    expect(authorId?.fkTo).toEqual({ table: "public.User", column: "id" });
  });

  it("emits the fk edge between tables with column pairs", () => {
    const fk = edge("fk", "tbl:public.posts", "tbl:public.User");
    expect(fk?.attrs?.columns).toEqual([["author_id", "id"]]);
    expect(fk?.confidence).toBe("certain");
  });

  it("blast radius of the table reaches the code through maps_to", () => {
    // tbl:public.posts ← ent:Post (maps_to) — the entity's file contains it.
    expect(edge("maps_to", "ent:prisma/schema.prisma#Post", "tbl:public.posts")).toBeDefined();
    const prismaFile = node("file:prisma/schema.prisma");
    expect(prismaFile?.lang).toBe("prisma");
  });

  it("matches the golden graph", () => {
    expectGolden(graph, "prisma-app");
  });
});
