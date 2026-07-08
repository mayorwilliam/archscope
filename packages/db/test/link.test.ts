import { describe, expect, it } from "vitest";
import type { DeclaredEntity } from "../src/declared.js";
import { linkDeclaredSchema } from "../src/link.js";

function entity(partial: Partial<DeclaredEntity> & { name: string }): DeclaredEntity {
  return {
    filePath: "models.py",
    orm: "sqlalchemy",
    table: partial.name.toLowerCase(),
    schema: "public",
    tableExplicit: true,
    fields: [],
    relations: [],
    startLine: 1,
    endLine: 1,
    ...partial,
  };
}

describe("linkDeclaredSchema", () => {
  it("explicit table name links certain, convention links inferred", () => {
    const linked = linkDeclaredSchema([
      entity({ name: "User", table: "users", tableExplicit: true }),
      entity({ name: "Post", table: "Post", tableExplicit: false, orm: "prisma" }),
    ]);
    const byId = new Map(linked.entities.map((e) => [e.entity.name, e]));
    expect(byId.get("User")?.confidence).toBe("certain");
    expect(byId.get("User")?.tableId).toBe("tbl:public.users");
    expect(byId.get("Post")?.confidence).toBe("inferred");
    expect(byId.get("Post")?.tableId).toBe("tbl:public.Post");
  });

  it("builds table columns from fields, honoring @map-style overrides", () => {
    const linked = linkDeclaredSchema([
      entity({
        name: "User",
        table: "users",
        fields: [
          { name: "id", type: "Int", nullable: false, isPk: true, isFk: false },
          {
            name: "fullName",
            type: "String",
            column: "full_name",
            nullable: true,
            isPk: false,
            isFk: false,
          },
        ],
      }),
    ]);
    expect(linked.tables).toHaveLength(1);
    expect(linked.tables[0]?.columns).toEqual([
      { name: "full_name", sqlType: "String", nullable: true, isPk: false },
      { name: "id", sqlType: "Int", nullable: false, isPk: true },
    ]);
  });

  it("resolves Prisma model targets through the target's field→column map", () => {
    const linked = linkDeclaredSchema([
      entity({
        name: "User",
        table: "users",
        orm: "prisma",
        fields: [
          { name: "id", type: "Int", column: "user_id", nullable: false, isPk: true, isFk: false },
        ],
      }),
      entity({
        name: "Post",
        table: "posts",
        orm: "prisma",
        fields: [
          {
            name: "authorId",
            type: "Int",
            column: "author_id",
            nullable: false,
            isPk: false,
            isFk: true,
          },
        ],
        relations: [{ columns: ["author_id"], targetEntity: "User", references: ["id"] }],
      }),
    ]);
    expect(linked.fks).toEqual([
      {
        fromTableId: "tbl:public.posts",
        toTableId: "tbl:public.users",
        columns: [["author_id", "user_id"]],
      },
    ]);
    const posts = linked.tables.find((t) => t.id === "tbl:public.posts");
    expect(posts?.columns.find((c) => c.name === "author_id")?.fkTo).toEqual({
      table: "public.users",
      column: "user_id",
    });
  });

  it("drops relations whose target entity is unknown instead of guessing", () => {
    const linked = linkDeclaredSchema([
      entity({
        name: "Post",
        relations: [{ columns: ["author_id"], targetEntity: "Ghost", references: ["id"] }],
      }),
    ]);
    expect(linked.fks).toEqual([]);
  });

  it("merges two entities mapping to the same table (first by id wins per column)", () => {
    const linked = linkDeclaredSchema([
      entity({
        name: "UserRead",
        filePath: "a.py",
        table: "users",
        fields: [{ name: "id", type: "Integer", nullable: false, isPk: true, isFk: false }],
      }),
      entity({
        name: "UserWrite",
        filePath: "b.py",
        table: "users",
        fields: [
          { name: "id", type: "BigInteger", nullable: false, isPk: true, isFk: false },
          { name: "email", type: "String", nullable: false, isPk: false, isFk: false },
        ],
      }),
    ]);
    expect(linked.tables).toHaveLength(1);
    expect(linked.tables[0]?.columns.map((c) => `${c.name}:${c.sqlType}`)).toEqual([
      "email:String",
      "id:Integer",
    ]);
    expect(linked.entities.map((e) => e.tableId)).toEqual(["tbl:public.users", "tbl:public.users"]);
  });
});
