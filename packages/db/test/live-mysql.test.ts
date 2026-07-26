import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeDrift, type DeclaredTableInput } from "../src/drift.js";
import type { LiveSchema } from "../src/introspect.js";
import { introspectMysql } from "../src/introspect-mysql.js";
import { mergeLiveSchema } from "../src/merge.js";
import { baseGraphWithUsers } from "./live-helpers.js";

/**
 * Live introspection against a real MySQL (Testcontainers). Opt-in like the
 * Postgres twin: `TEST_LIVE_DB=1 pnpm vitest run --project db`.
 *
 * Exercises what MySQL does differently: schema == database (the declared
 * "public" placeholder must map onto the connection's database) and
 * tinyint(1)-as-boolean. Planted drift must be reported exactly, plus the
 * same credential guard as Postgres.
 */

const LIVE = process.env.TEST_LIVE_DB === "1";

const declared: DeclaredTableInput[] = [
  {
    schema: "public", // unqualified — must match the container's database
    name: "users",
    columns: [
      { name: "id", sqlType: "Int", nullable: false, isPk: true },
      { name: "email", sqlType: "String", nullable: false, isPk: false },
      { name: "active", sqlType: "Boolean", nullable: false, isPk: false },
      { name: "full_name", sqlType: "String", nullable: true, isPk: false }, // planted: missing in db
    ],
  },
];

const DDL = `
  CREATE TABLE users (
    id int PRIMARY KEY,
    email varchar(255) NOT NULL,
    active tinyint(1) NOT NULL,
    created_at datetime              -- planted: missing in code
  )
`;

describe.runIf(LIVE)("live MySQL introspection + drift (TEST_LIVE_DB=1)", () => {
  let container: import("@testcontainers/mysql").StartedMySqlContainer;
  let url: string;
  let live: LiveSchema;

  beforeAll(async () => {
    const { MySqlContainer } = await import("@testcontainers/mysql");
    container = await new MySqlContainer("mysql:8.4")
      .withDatabase("appdb")
      .withRootPassword("s3cr3t-planted-password")
      .start();
    url = container.getConnectionUri();

    const { default: mysql } = await import("mysql2/promise");
    const connection = await mysql.createConnection(url);
    await connection.query(DDL);
    await connection.end();

    live = await introspectMysql(url);
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("scopes to the connection's database and reports it as defaultSchema", () => {
    expect(live.dialect).toBe("mysql");
    expect(live.defaultSchema).toBe("appdb");
    expect(live.tables.map((t) => `${t.schema}.${t.name}`)).toEqual(["appdb.users"]);
  });

  it("introspects columns, PKs, nullability and tinyint(1) as boolean", () => {
    const users = live.tables.find((t) => t.name === "users");
    expect(users?.columns.map((c) => c.name)).toEqual(["id", "email", "active", "created_at"]);
    expect(users?.columns.find((c) => c.name === "id")?.isPk).toBe(true);
    expect(users?.columns.find((c) => c.name === "active")?.sqlType).toBe("tinyint(1)");
    expect(users?.columns.find((c) => c.name === "created_at")?.nullable).toBe(true);
  });

  it("reports exactly the planted drift through the schema mapping", () => {
    const report = computeDrift(declared, live);
    const flat = [...report.byTable.entries()].flatMap(([table, entries]) =>
      entries.map((e) => `${table} ${e.kind}${e.column ? ` ${e.column}` : ""}`),
    );
    expect(flat.sort()).toEqual(
      [
        "appdb.users column_missing_in_db full_name",
        "appdb.users column_missing_in_code created_at",
      ].sort(),
    );
  });

  it("credential guard: nothing under .archscope/ contains the URL or password", () => {
    const { graph } = mergeLiveSchema(baseGraphWithUsers(), live, {
      source: "main",
      dialect: "mysql",
      introspectedAt: new Date().toISOString(),
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archscope-cred-guard-"));
    const archscopeDir = path.join(dir, ".archscope");
    fs.mkdirSync(archscopeDir, { recursive: true });
    fs.writeFileSync(path.join(archscopeDir, "graph.json"), JSON.stringify(graph, null, 2));

    const password = "s3cr3t-planted-password";
    for (const file of fs.readdirSync(archscopeDir)) {
      const body = fs.readFileSync(path.join(archscopeDir, file), "utf8");
      expect(body).not.toContain(password);
      expect(body).not.toContain(url);
      expect(body).not.toContain("mysql://");
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("connection errors are redacted before they propagate", async () => {
    const badUrl = url.replace(/:\d+\//, ":1/"); // unreachable port, same credentials
    await expect(introspectMysql(badUrl)).rejects.toThrow();
    try {
      await introspectMysql(badUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("s3cr3t-planted-password");
    }
  });
});
