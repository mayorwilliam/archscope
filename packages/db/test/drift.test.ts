import { describe, expect, it } from "vitest";
import { computeDrift, type DeclaredTableInput, normalizeSqlType } from "../src/drift.js";
import type { LiveSchema } from "../src/introspect.js";

/**
 * Every drift kind planted exactly once; the report must contain exactly the
 * planted findings and NOTHING else — a drift detector that over-reports is
 * as useless as one that under-reports.
 */

const declared: DeclaredTableInput[] = [
  {
    schema: "public",
    name: "users",
    columns: [
      { name: "id", sqlType: "Int", nullable: false, isPk: true },
      { name: "email", sqlType: "String", nullable: false, isPk: false },
      { name: "full_name", sqlType: "String", nullable: true, isPk: false }, // → column_missing_in_db
      { name: "role", sqlType: "String", nullable: false, isPk: false }, // → type_mismatch (live int4)
    ],
  },
  {
    schema: "public",
    name: "posts",
    columns: [
      { name: "id", sqlType: "Int", nullable: false, isPk: true },
      // → nullability_mismatch (live nullable) + fk_missing_in_db (no live constraint)
      {
        name: "author_id",
        sqlType: "Int",
        nullable: false,
        isPk: false,
        fkTo: { table: "public.users", column: "id" },
      },
    ],
  },
  {
    schema: "public",
    name: "ghosts", // → table_missing_in_db
    columns: [{ name: "id", sqlType: "Int", nullable: false, isPk: true }],
  },
];

const live: LiveSchema = {
  dialect: "postgres",
  tables: [
    {
      schema: "public",
      name: "users",
      columns: [
        { name: "id", sqlType: "int4", nullable: false, isPk: true },
        { name: "email", sqlType: "varchar", nullable: false, isPk: false },
        { name: "role", sqlType: "int4", nullable: false, isPk: false },
        { name: "created_at", sqlType: "timestamptz", nullable: true, isPk: false }, // → column_missing_in_code
      ],
      fks: [],
    },
    {
      schema: "public",
      name: "posts",
      columns: [
        { name: "id", sqlType: "int4", nullable: false, isPk: true },
        { name: "author_id", sqlType: "int4", nullable: true, isPk: false },
        { name: "editor_id", sqlType: "int4", nullable: true, isPk: false }, // → column_missing_in_code
      ],
      // → fk_missing_in_code (editor_id constraint exists only live)
      fks: [
        { fromColumns: ["editor_id"], toSchema: "public", toTable: "users", toColumns: ["id"] },
      ],
    },
    {
      schema: "public",
      name: "stray", // → table_missing_in_code
      columns: [{ name: "id", sqlType: "int4", nullable: false, isPk: true }],
      fks: [],
    },
    {
      schema: "analytics", // outside every declared schema → ignored entirely
      name: "events",
      columns: [],
      fks: [],
    },
  ],
};

describe("computeDrift", () => {
  const report = computeDrift(declared, live);

  it("reports exactly the planted findings, nothing else", () => {
    const flat = [...report.byTable.entries()].flatMap(([table, entries]) =>
      entries.map((e) => `${table} ${e.kind}${e.column ? ` ${e.column}` : ""}`),
    );
    expect(flat.sort()).toEqual(
      [
        "public.users column_missing_in_db full_name",
        "public.users type_mismatch role",
        "public.users column_missing_in_code created_at",
        "public.posts nullability_mismatch author_id",
        "public.posts fk_missing_in_db author_id",
        "public.posts column_missing_in_code editor_id",
        "public.posts fk_missing_in_code editor_id",
        "public.ghosts table_missing_in_db",
        "public.stray table_missing_in_code",
      ].sort(),
    );
    expect(report.total).toBe(9);
    expect(report.tablesChecked).toBe(3);
  });

  it("matching columns with equivalent type families are silent", () => {
    // email String ≈ varchar; id Int ≈ int4 — none of them may appear.
    const users = report.byTable.get("public.users") ?? [];
    expect(users.some((e) => e.column === "email" || e.column === "id")).toBe(false);
  });

  it("ignores live schemas where the code declares nothing", () => {
    expect(report.byTable.has("analytics.events")).toBe(false);
  });

  it("is clean when declared and live agree", () => {
    const clean = computeDrift(
      [declared[0] as DeclaredTableInput].map((t) => ({
        ...t,
        columns: t.columns.filter((c) => c.name !== "full_name" && c.name !== "role"),
      })),
      {
        dialect: "postgres",
        tables: [
          {
            schema: "public",
            name: "users",
            columns: [
              { name: "id", sqlType: "int4", nullable: false, isPk: true },
              { name: "email", sqlType: "varchar", nullable: false, isPk: false },
            ],
            fks: [],
          },
        ],
      },
    );
    expect(clean.total).toBe(0);
  });
});

describe("normalizeSqlType", () => {
  const cases: Array<[string, string]> = [
    ["String", "text"],
    ["String(255)", "text"],
    ["varchar", "text"],
    ["str", "text"],
    ["Int", "integer"],
    ["int4", "integer"],
    ["Integer", "integer"],
    ["BigInt", "bigint"],
    ["int8", "bigint"],
    ["Boolean", "boolean"],
    ["bool", "boolean"],
    ["DateTime", "timestamp"],
    ["timestamptz", "timestamp"],
    ["datetime.datetime", "timestamp"],
    ["sa.Integer", "integer"],
    ["Float", "double"],
    ["float8", "double"],
    ["Json", "json"],
    ["jsonb", "json"],
    ["MyEnum", "myenum"], // unknown → its own lowercased base, same-vs-same still matches
  ];
  for (const [raw, family] of cases) {
    it(`${raw} → ${family}`, () => {
      expect(normalizeSqlType(raw)).toBe(family);
    });
  }
});
