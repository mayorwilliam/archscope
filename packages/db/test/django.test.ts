import { describe, expect, it } from "vitest";
import { extractDjangoEntities } from "../src/django.js";
import { parsePython } from "./helpers.js";

const SOURCE = `
from django.db import models

class Team(models.Model):
    name = models.CharField(max_length=80)

    class Meta:
        db_table = "orgs_team"

class User(models.Model):
    email = models.EmailField()
    team = models.ForeignKey(Team, on_delete=models.CASCADE, null=True)
    nick = models.CharField(max_length=30, null=True, db_column="nickname")
    account = models.ForeignKey("crm.Account", on_delete=models.SET_NULL, null=True, to_field="code")
    tags = models.ManyToManyField("Tag")
    code = models.CharField(max_length=10, primary_key=True)

class AbstractBase(models.Model):
    class Meta:
        abstract = True

class NotAModel:
    name = models.CharField(max_length=10)
`;

describe("extractDjangoEntities", async () => {
  const entities = extractDjangoEntities("shop/models.py", await parsePython(SOURCE));
  const byName = new Map(entities.map((e) => [e.name, e]));

  it("models.Model subclasses are entities; abstract and plain classes are not", () => {
    expect([...byName.keys()].sort()).toEqual(["Team", "User"]);
  });

  it("Meta.db_table is explicit; otherwise app_model convention, inferred", () => {
    expect(byName.get("Team")).toMatchObject({ table: "orgs_team", tableExplicit: true });
    expect(byName.get("User")).toMatchObject({ table: "shop_user", tableExplicit: false });
  });

  it("synthesizes the implicit auto PK only when no field declares one", () => {
    const teamFields = byName.get("Team")?.fields;
    expect(teamFields?.[0]).toMatchObject({ name: "id", isPk: true, type: "unknown" });
    // User declares primary_key=True on code — no synthetic id.
    const userFields = byName.get("User")?.fields;
    expect(userFields?.some((f) => f.name === "id")).toBe(false);
    expect(userFields?.find((f) => f.name === "code")?.isPk).toBe(true);
  });

  it("reads null=, db_column= and field types", () => {
    const fields = new Map(byName.get("User")?.fields.map((f) => [f.name, f]));
    expect(fields.get("email")).toMatchObject({ type: "EmailField", nullable: false });
    expect(fields.get("nick")).toMatchObject({ column: "nickname", nullable: true });
  });

  it("ForeignKey yields the _id column and the relation, by class or string", () => {
    const user = byName.get("User");
    const team = user?.fields.find((f) => f.name === "team");
    expect(team).toMatchObject({ column: "team_id", isFk: true, nullable: true });
    expect(user?.relations).toEqual([
      { columns: ["team_id"], targetEntity: "Team", references: ["id"] },
      { columns: ["account_id"], targetEntity: "Account", references: ["code"] },
    ]);
  });

  it("ManyToManyField is navigation, not a column", () => {
    expect(byName.get("User")?.fields.some((f) => f.name === "tags")).toBe(false);
  });
});
