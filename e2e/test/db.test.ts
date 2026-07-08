import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "@archmap/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  analyzeAndSave,
  connectHarness,
  git,
  type Harness,
  initGitRepo,
  makeTmpDir,
} from "./helpers.js";

/**
 * DB tools end-to-end: a tiny Prisma repo, analyzed by the BUILT CLI and
 * served over stdio. Numbers are exact by construction. mcp.test.ts keeps its
 * own pure-TS repo so its module/impact arithmetic stays untouched.
 */

const SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id       Int     @id
  email    String  @unique
  fullName String? @map("full_name")
  posts    Post[]
}

model Post {
  id       Int  @id
  authorId Int  @map("author_id")
  author   User @relation(fields: [authorId], references: [id])

  @@map("posts")
}
`;

/** Filler models so get_db_schema is guaranteed to truncate at MIN_BUDGET. */
const WIDE_MODELS = 24;
const wideSchema = Array.from({ length: WIDE_MODELS }, (_, i) => {
  const n = String(i).padStart(2, "0");
  return `model Wide${n} {\n  id    Int    @id\n  label String\n\n  @@map("wide_${n}")\n}\n`;
}).join("\n");

const TABLES = 2 + WIDE_MODELS;

let root: string;
let h: Harness;

beforeAll(async () => {
  root = makeTmpDir("archmap-e2e-db-");
  fs.mkdirSync(path.join(root, "prisma"), { recursive: true });
  fs.writeFileSync(path.join(root, "prisma", "schema.prisma"), `${SCHEMA}\n${wideSchema}`);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "users.ts"),
    'import { PrismaClient } from "@prisma/client";\nexport const prisma = new PrismaClient();\n',
  );
  await initGitRepo(root);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", "prisma app");
  await analyzeAndSave(root);
  h = await connectHarness(root);
});

afterAll(async () => {
  await h?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("get_db_schema", () => {
  it("lists tables with entity linkage, PKs and the FK graph", async () => {
    const { text, isError } = await h.callText("get_db_schema", { budget_tokens: 8000 });
    expect(isError).toBe(false);
    expect(text).toContain(`# DB schema — ${TABLES} tables · ${TABLES} entities`);
    expect(text).toContain("static declarations only");
    expect(text).toContain("tbl:public.posts");
    expect(text).toContain("ent:prisma/schema.prisma#Post [prisma]");
    expect(text).toContain("## Foreign keys (1)");
    expect(text).toContain("tbl:public.posts → tbl:public.User · author_id→id");
  });

  it("drills into one table with column-level detail", async () => {
    const { text } = await h.callText("get_db_schema", { table: "posts", budget_tokens: 8000 });
    expect(text).toContain("# tbl:public.posts — table");
    expect(text).toContain("- author_id · Int · fk → public.User.id");
    expect(text).toContain("## Mapped entities (1)");
  });
});

describe("get_entity_relations", () => {
  it("resolves a bare entity name to fields, table and FK neighborhood", async () => {
    const { text, isError } = await h.callText("get_entity_relations", {
      entity: "User",
      budget_tokens: 8000,
    });
    expect(isError).toBe(false);
    expect(text).toContain("# ent:prisma/schema.prisma#User — entity");
    // Convention-derived table name is honestly marked inferred.
    expect(text).toContain("table tbl:public.User");
    expect(text).toContain("- fullName · String · col full_name · nullable");
    expect(text).toContain("← tbl:public.posts · author_id→id · ent:prisma/schema.prisma#Post");
  });

  it("fails unknown refs with suggestions", async () => {
    const { text, isError } = await h.callText("get_entity_relations", { entity: "Ghost" });
    expect(isError).toBe(true);
    expect(text).toContain('Not found: "Ghost"');
    expect(text).toContain("search_nodes");
  });
});

describe("blast radius crosses maps_to", () => {
  it("get_impact on a table reaches the declaring code", async () => {
    const { text } = await h.callText("get_impact", {
      node_id: "tbl:public.posts",
      budget_tokens: 8000,
    });
    expect(text).toContain("# Impact of changing tbl:public.posts (table)");
    expect(text).toContain("ent:prisma/schema.prisma#Post");
  });
});

describe("budget guarantee for DB tools (asserted in chars)", () => {
  const SWEEP: Array<[string, Record<string, unknown>]> = [
    ["get_db_schema", {}],
    ["get_db_schema", { table: "posts" }],
    ["get_entity_relations", { entity: "User" }],
    ["get_schema_drift", {}],
  ];
  const budgets = [200, 500, 2000, 20000];
  for (const [tool, args] of SWEEP) {
    it.each(budgets)(`${tool}(${JSON.stringify(args)}) fits budget=%i`, async (budget) => {
      const { text, isError } = await h.callText(tool, { ...args, budget_tokens: budget });
      expect(isError).toBe(false);
      expect(text.length).toBeLessThanOrEqual(budget * 4);
      expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
    });
  }
});

describe("drill-down hints", () => {
  it("a truncated db schema hints a follow-up that succeeds within ITS budget", async () => {
    const { text } = await h.callText("get_db_schema", { budget_tokens: 200 });
    const hint = /… \+\d+ more → get_db_schema\(budget_tokens=(\d+)\)/.exec(text);
    expect(hint, `no drill-down hint in:\n${text}`).not.toBeNull();
    const budget = Number(hint?.[1]);
    const followUp = await h.callText("get_db_schema", { budget_tokens: budget });
    expect(followUp.isError).toBe(false);
    expect(estimateTokens(followUp.text)).toBeLessThanOrEqual(budget);
  });
});
