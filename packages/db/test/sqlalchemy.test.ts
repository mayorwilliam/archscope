import { describe, expect, it } from "vitest";
import { extractSqlalchemyEntities } from "../src/sqlalchemy.js";
import { parsePython } from "./helpers.js";

const CLASSIC = `
from sqlalchemy import Column, ForeignKey, Integer, String
from .base import Base

class Team(Base):
    __tablename__ = "teams"
    __table_args__ = {"schema": "org"}
    id = Column(Integer, primary_key=True)
    name = Column("team_name", String(80), nullable=False)

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String(255), nullable=False)
    team_id = Column(Integer, ForeignKey("org.teams.id"))

class NotAModel:
    id = Column(Integer, primary_key=True)
`;

const MODERN = `
from typing import Optional
from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .base import Base

class Post(Base):
    __tablename__ = "posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str]
    subtitle: Mapped[Optional[str]]
    summary: Mapped[str | None] = mapped_column(String(500))
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    author: Mapped["User"] = relationship(back_populates="posts")
    tags: Mapped[List["Tag"]] = relationship()
`;

describe("extractSqlalchemyEntities — classic Column style", async () => {
  const entities = extractSqlalchemyEntities("app/models.py", await parsePython(CLASSIC));
  const byName = new Map(entities.map((e) => [e.name, e]));

  it("only classes with a literal __tablename__ are entities", () => {
    expect(entities.map((e) => e.name)).toEqual(["Team", "User"]);
  });

  it("__tablename__ is always explicit → certain linkage upstream", () => {
    expect(byName.get("User")?.tableExplicit).toBe(true);
    expect(byName.get("User")?.table).toBe("users");
  });

  it("reads the schema from __table_args__", () => {
    expect(byName.get("Team")?.schema).toBe("org");
    expect(byName.get("User")?.schema).toBe("public");
  });

  it("extracts column overrides, types, nullability and PKs", () => {
    const name = byName.get("Team")?.fields.find((f) => f.name === "name");
    expect(name).toEqual({
      name: "name",
      type: "String(80)",
      column: "team_name",
      nullable: false,
      isPk: false,
      isFk: false,
    });
    const id = byName.get("Team")?.fields.find((f) => f.name === "id");
    expect(id?.isPk).toBe(true);
    expect(id?.nullable).toBe(false);
    // Classic Column default: nullable unless primary_key or explicit kwarg.
    const email = byName.get("User")?.fields.find((f) => f.name === "email");
    expect(email?.nullable).toBe(false);
    const teamId = byName.get("User")?.fields.find((f) => f.name === "team_id");
    expect(teamId?.nullable).toBe(true);
  });

  it("ForeignKey with a schema-qualified target becomes a relation", () => {
    expect(byName.get("User")?.relations).toEqual([
      { columns: ["team_id"], targetTable: "teams", targetSchema: "org", references: ["id"] },
    ]);
    expect(byName.get("User")?.fields.find((f) => f.name === "team_id")?.isFk).toBe(true);
  });
});

describe("extractSqlalchemyEntities — 2.0 Mapped style", async () => {
  const entities = extractSqlalchemyEntities("app/post.py", await parsePython(MODERN));
  const post = entities[0];

  it("extracts the entity with mapped_column and bare annotations", () => {
    expect(post?.name).toBe("Post");
    expect(post?.fields.map((f) => f.name)).toEqual([
      "id",
      "title",
      "subtitle",
      "summary",
      "author_id",
    ]);
  });

  it("relationship() attributes are navigation, not columns", () => {
    expect(post?.fields.some((f) => f.name === "author" || f.name === "tags")).toBe(false);
  });

  it("derives type and nullability from Mapped[...] annotations", () => {
    const title = post?.fields.find((f) => f.name === "title");
    expect(title).toMatchObject({ type: "str", nullable: false });
    const subtitle = post?.fields.find((f) => f.name === "subtitle");
    expect(subtitle).toMatchObject({ type: "str", nullable: true });
    // Explicit type arg beats the annotation; `str | None` still means nullable.
    const summary = post?.fields.find((f) => f.name === "summary");
    expect(summary).toMatchObject({ type: "String(500)", nullable: true });
  });

  it("mapped_column(ForeignKey(...)) yields the relation", () => {
    expect(post?.relations).toEqual([
      { columns: ["author_id"], targetTable: "users", references: ["id"] },
    ]);
  });

  it("spans cover the class definition", () => {
    expect(post?.startLine).toBe(7);
    expect(post?.endLine).toBeGreaterThan(7);
  });
});
