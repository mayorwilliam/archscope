import { describe, expect, it } from "vitest";
import { extractPrismaEntities } from "../src/prisma.js";

const SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  USER
  ADMIN
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  role      Role     @default(USER)
  bio       String?
  posts     Post[]
}

model Post {
  id        Int      @id
  title     String
  authorId  Int      @map("author_id")
  author    User     @relation(fields: [authorId], references: [id])
  @@map("posts")
}

model AuditLog {
  eventId   Int
  source    String
  @@id([eventId, source])
  @@map("audit_log")
  @@schema("ops")
}
`;

describe("extractPrismaEntities", () => {
  const entities = extractPrismaEntities("prisma/schema.prisma", SCHEMA);
  const byName = new Map(entities.map((e) => [e.name, e]));

  it("extracts one entity per model, none per enum/datasource", () => {
    expect(entities.map((e) => e.name)).toEqual(["User", "Post", "AuditLog"]);
  });

  it("defaults table to the model name, marked as convention (inferred)", () => {
    const user = byName.get("User");
    expect(user?.table).toBe("User");
    expect(user?.tableExplicit).toBe(false);
    expect(user?.schema).toBe("public");
  });

  it("honors @@map and @@schema as explicit declarations", () => {
    const post = byName.get("Post");
    expect(post?.table).toBe("posts");
    expect(post?.tableExplicit).toBe(true);
    const audit = byName.get("AuditLog");
    expect(audit?.schema).toBe("ops");
    expect(audit?.table).toBe("audit_log");
  });

  it("keeps scalar and enum fields as columns, drops relation fields", () => {
    const user = byName.get("User");
    expect(user?.fields.map((f) => f.name)).toEqual(["id", "email", "role", "bio"]);
    expect(user?.fields.find((f) => f.name === "role")?.type).toBe("Role");
    expect(user?.fields.find((f) => f.name === "bio")?.nullable).toBe(true);
    expect(user?.fields.find((f) => f.name === "id")?.isPk).toBe(true);
  });

  it("maps @relation to a relation with COLUMN names and marks the FK field", () => {
    const post = byName.get("Post");
    expect(post?.relations).toEqual([
      { columns: ["author_id"], targetEntity: "User", references: ["id"] },
    ]);
    const authorId = post?.fields.find((f) => f.name === "authorId");
    expect(authorId?.isFk).toBe(true);
    expect(authorId?.column).toBe("author_id");
  });

  it("applies composite @@id to the named fields", () => {
    const audit = byName.get("AuditLog");
    expect(audit?.fields.filter((f) => f.isPk).map((f) => f.name)).toEqual(["eventId", "source"]);
  });

  it("carries line spans for entity nodes", () => {
    const user = byName.get("User");
    expect(user?.startLine).toBeGreaterThan(1);
    expect(user?.endLine).toBeGreaterThan(user?.startLine ?? 0);
  });

  it("returns no entities for unparseable sources instead of throwing", () => {
    expect(extractPrismaEntities("broken.prisma", "model {{{{")).toEqual([]);
  });
});
