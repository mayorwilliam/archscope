import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa, type ResultPromise } from "execa";

export const CLI_BIN = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../packages/cli/dist/index.js",
);

/**
 * Fixture with real git history so the Diff view has something to show:
 *
 *   branch `base`: auth→utils, legacy→utils, prisma User/Team/Post
 *   main (head):   legacy removed, billing→utils added, User gains `bio`
 *
 * Expected head shape (pinned, golden-style): 4 modules (auth, billing,
 * prisma, utils), 5 files, 3 tables, 2 FKs.
 */

const PRISMA_HEADER = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Team {
  id    Int    @id @default(autoincrement())
  name  String
  users User[]
}

model Post {
  id       Int  @id @default(autoincrement())
  title    String
  authorId Int  @map("author_id")
  author   User @relation(fields: [authorId], references: [id])
}
`;

const USER_BASE = `
model User {
  id     Int    @id @default(autoincrement())
  email  String @unique
  teamId Int?   @map("team_id")
  team   Team?  @relation(fields: [teamId], references: [id])
  posts  Post[]
}
`;

const USER_HEAD = `
model User {
  id     Int     @id @default(autoincrement())
  email  String  @unique
  bio    String?
  teamId Int?    @map("team_id")
  team   Team?   @relation(fields: [teamId], references: [id])
  posts  Post[]
}
`;

function write(dir: string, rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execa("git", args, { cwd });
}

export async function buildFixtureRepo(): Promise<string> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "archscope-dash-")));

  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "e2e@archscope.test");
  await git(dir, "config", "user.name", "archscope e2e");
  write(dir, ".gitignore", ".archscope/\n");

  // --- base state ------------------------------------------------------------
  // Wiki prose, present in BOTH commits so diff numbers stay untouched.
  write(dir, "README.md", "# Fixture App\n\nA tiny repo the dashboard smoke tests against.\n");
  write(dir, "auth/README.md", "# Auth module\n\nLogin and session handling.\n");
  write(dir, "utils/fmt.ts", "export function fmt(v: string): string {\n  return v.trim();\n}\n");
  write(
    dir,
    "auth/login.ts",
    'import { fmt } from "../utils/fmt.js";\nexport function login(u: string): string {\n  return fmt(u);\n}\n',
  );
  write(
    dir,
    "auth/session.ts",
    'import { login } from "./login.js";\nexport function session(): string {\n  return login("u");\n}\n',
  );
  write(
    dir,
    "legacy/old.ts",
    'import { fmt } from "../utils/fmt.js";\nexport function old(): string {\n  return fmt("x");\n}\n',
  );
  write(dir, "prisma/schema.prisma", PRISMA_HEADER + USER_BASE);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "base");
  await git(dir, "branch", "base");

  // --- head state ------------------------------------------------------------
  fs.rmSync(path.join(dir, "legacy"), { recursive: true, maxRetries: 5, retryDelay: 100 });
  write(
    dir,
    "billing/invoice.ts",
    'import { fmt } from "../utils/fmt.js";\nexport function invoice(): string {\n  return fmt("inv");\n}\n',
  );
  write(dir, "prisma/schema.prisma", PRISMA_HEADER + USER_HEAD);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "head: billing added, legacy removed, User.bio");

  return dir;
}

export interface ServeHandle {
  port: number;
  url: string;
  process: ResultPromise;
  stop: () => Promise<void>;
}

export async function startServe(repoDir: string): Promise<ServeHandle> {
  const port = 4500 + Math.floor(Math.random() * 400);
  const child = execa(process.execPath, [CLI_BIN, "serve", "--port", String(port)], {
    cwd: repoDir,
    reject: false,
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const url = `http://localhost:${port}`;

  const deadline = Date.now() + 30_000;
  for (;;) {
    // Ready = HTTP up AND the in-process watcher finished its initial
    // rebuild — otherwise that rebuild could race the tests' graph edits.
    let httpUp = false;
    try {
      const response = await fetch(`${url}/api/meta`);
      httpUp = response.ok;
    } catch {
      // not up yet
    }
    if (httpUp && output.includes("watching ")) break;
    if (Date.now() > deadline) {
      throw new Error(`archscope serve did not come up in 30s. Output:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return {
    port,
    url,
    process: child,
    stop: async () => {
      child.kill();
      await child.catch(() => {});
    },
  };
}

/** Plant drift directly in graph.json — the dashboard renders what the graph
 * says, and rewriting the file is exactly how live overlays publish too. */
export function injectDrift(repoDir: string, tableName: string): void {
  const graphPath = path.join(repoDir, ".archscope", "graph.json");
  const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));
  const table = graph.nodes.find(
    (node: { kind: string; name: string }) => node.kind === "table" && node.name === tableName,
  );
  if (!table) throw new Error(`table ${tableName} not in graph`);
  table.attrs.drift = [
    { kind: "column_missing_in_db", column: "bio", detail: "bio: declared but missing in db" },
  ];
  graph.meta.live = {
    source: "e2e",
    dialect: "postgres",
    introspectedAt: new Date().toISOString(),
  };
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2));
}
