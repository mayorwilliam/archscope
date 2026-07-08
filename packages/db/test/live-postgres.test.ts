import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeDrift, type DeclaredTableInput } from "../src/drift.js";
import { introspectPostgres, type LiveSchema, redactSecret } from "../src/introspect.js";
import { mergeLiveSchema } from "../src/merge.js";
import { baseGraphWithUsers } from "./live-helpers.js";

/**
 * Live introspection against a real Postgres (Testcontainers). Opt-in like
 * TEST_OSS_REPO: `TEST_LIVE_DB=1 pnpm vitest run --project db`.
 *
 * The database is planted with EXACT drift against the declared schema below;
 * the report must contain those findings and nothing else. The credential
 * guard then proves the connection URL never reaches any .archmap/ artifact.
 */

const LIVE = process.env.TEST_LIVE_DB === "1";

const declared: DeclaredTableInput[] = [
  {
    schema: "public",
    name: "users",
    columns: [
      { name: "id", sqlType: "Int", nullable: false, isPk: true },
      { name: "email", sqlType: "String", nullable: false, isPk: false },
      { name: "full_name", sqlType: "String", nullable: true, isPk: false }, // planted: missing in db
    ],
  },
  {
    schema: "public",
    name: "posts",
    columns: [
      { name: "id", sqlType: "Int", nullable: false, isPk: true },
      {
        name: "author_id",
        sqlType: "Int",
        nullable: false,
        isPk: false,
        fkTo: { table: "public.users", column: "id" }, // planted: constraint dropped live
      },
    ],
  },
];

const DDL = `
  CREATE TABLE users (
    id integer PRIMARY KEY,
    email varchar(255) NOT NULL,
    created_at timestamptz            -- planted: missing in code
  );
  CREATE TABLE posts (
    id integer PRIMARY KEY,
    title text NOT NULL,              -- planted: missing in code
    author_id integer                 -- planted: nullable (declared not null), no FK constraint
  );
`;

describe.runIf(LIVE)("live Postgres introspection + drift (TEST_LIVE_DB=1)", () => {
  let container: import("@testcontainers/postgresql").StartedPostgreSqlContainer;
  let url: string;
  let live: LiveSchema;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withPassword("s3cr3t-planted-password")
      .start();
    url = container.getConnectionUri();

    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(DDL);
    await client.end();

    live = await introspectPostgres(url);
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("introspects tables, columns, PKs and nullability", () => {
    const users = live.tables.find((t) => t.name === "users");
    expect(users?.columns.map((c) => c.name)).toEqual(["id", "email", "created_at"]);
    expect(users?.columns.find((c) => c.name === "id")?.isPk).toBe(true);
    expect(users?.columns.find((c) => c.name === "created_at")?.nullable).toBe(true);
  });

  it("reports exactly the planted drift, nothing else", () => {
    const report = computeDrift(declared, live);
    const flat = [...report.byTable.entries()].flatMap(([table, entries]) =>
      entries.map((e) => `${table} ${e.kind}${e.column ? ` ${e.column}` : ""}`),
    );
    expect(flat.sort()).toEqual(
      [
        "public.users column_missing_in_db full_name",
        "public.users column_missing_in_code created_at",
        "public.posts column_missing_in_code title",
        "public.posts nullability_mismatch author_id",
        "public.posts fk_missing_in_db author_id",
      ].sort(),
    );
  });

  it("credential guard: nothing under .archmap/ contains the URL or password", () => {
    const { graph } = mergeLiveSchema(baseGraphWithUsers(), live, {
      source: "main",
      dialect: "postgres",
      introspectedAt: new Date().toISOString(),
    });

    // Write the artifact exactly like the CLI does, then grep every byte.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archmap-cred-guard-"));
    const archmapDir = path.join(dir, ".archmap");
    fs.mkdirSync(archmapDir, { recursive: true });
    fs.writeFileSync(path.join(archmapDir, "graph.json"), JSON.stringify(graph, null, 2));

    const password = "s3cr3t-planted-password";
    for (const file of fs.readdirSync(archmapDir)) {
      const body = fs.readFileSync(path.join(archmapDir, file), "utf8");
      expect(body).not.toContain(password);
      expect(body).not.toContain(url);
      expect(body).not.toContain("postgres://");
      expect(body).not.toContain("postgresql://");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("connection errors are redacted before they propagate", async () => {
    const badUrl = url.replace(/:\d+\//, ":1/"); // unreachable port, same credentials
    await expect(introspectPostgres(badUrl)).rejects.toThrow();
    try {
      await introspectPostgres(badUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("s3cr3t-planted-password");
    }
  });
});

describe("redactSecret", () => {
  it("strips the full URL and the password on their own", () => {
    const url = "postgres://app:hunter2@db.internal:5432/prod";
    expect(redactSecret(`connect failed for ${url}`, url)).not.toContain("hunter2");
    expect(redactSecret("password authentication failed for hunter2", url)).not.toContain(
      "hunter2",
    );
  });
});
