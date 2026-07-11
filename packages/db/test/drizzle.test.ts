import { describe, expect, it } from "vitest";
import { extractDrizzleEntities } from "../src/drizzle.js";
import { parseTypescript } from "./helpers.js";

const SOURCE = `
import { pgTable, pgSchema, serial, text, integer, varchar, timestamp } from "drizzle-orm/pg-core";

export const teams = pgTable("teams", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

const auth = pgSchema("auth");

export const users = auth.table("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  teamId: integer("team_id").references(() => teams.id),
  bio: text(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const notATable = { id: 1 };
const alsoNot = someOtherCall("x", {});
`;

describe("extractDrizzleEntities", async () => {
  const entities = extractDrizzleEntities("src/schema.ts", await parseTypescript(SOURCE));
  const byName = new Map(entities.map((e) => [e.name, e]));

  it("only table-builder calls are entities; names come from the variable", () => {
    expect([...byName.keys()].sort()).toEqual(["teams", "users"]);
  });

  it("the table name is always written in the source → explicit", () => {
    expect(byName.get("teams")).toMatchObject({ table: "teams", tableExplicit: true });
  });

  it("pgSchema variables carry their DB schema into .table() calls", () => {
    expect(byName.get("users")).toMatchObject({ schema: "auth", table: "users" });
    expect(byName.get("teams")?.schema).toBe("public");
  });

  it("unwinds column chains: type, PK, notNull, column name", () => {
    const fields = new Map(byName.get("users")?.fields.map((f) => [f.name, f]));
    expect(fields.get("id")).toMatchObject({ type: "serial", isPk: true, nullable: false });
    expect(fields.get("email")).toMatchObject({ type: "varchar", nullable: false });
    expect(fields.get("teamId")).toMatchObject({ column: "team_id", nullable: true, isFk: true });
    expect(fields.get("createdAt")).toMatchObject({
      type: "timestamp",
      column: "created_at",
      nullable: false,
    });
  });

  it("a bare type call inherits the object key as column name", () => {
    const bio = byName.get("users")?.fields.find((f) => f.name === "bio");
    expect(bio).toMatchObject({ type: "text", nullable: true });
    expect(bio?.column).toBeUndefined();
  });

  it(".references(() => teams.id) yields the relation by entity + field", () => {
    expect(byName.get("users")?.relations).toEqual([
      { columns: ["team_id"], targetEntity: "teams", references: ["id"] },
    ]);
  });
});
