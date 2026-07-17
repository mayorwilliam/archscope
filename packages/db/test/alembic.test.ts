import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectAlembic } from "../src/alembic.js";

function migration(revision: string, down: string | string[] | null): string {
  const downValue =
    down === null
      ? "None"
      : Array.isArray(down)
        ? `(${down.map((d) => `"${d}"`).join(", ")})`
        : `"${down}"`;
  return `"""a migration"""\nrevision: str = "${revision}"\ndown_revision = ${downValue}\n\ndef upgrade() -> None:\n    pass\n`;
}

describe("detectAlembic", () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "archscope-alembic-"));
    const versions = path.join(root, "migrations", "versions");
    fs.mkdirSync(versions, { recursive: true });
    fs.writeFileSync(path.join(root, "migrations", "env.py"), "# alembic env\n");
    fs.writeFileSync(path.join(root, "alembic.ini"), "[alembic]\nscript_location = migrations\n");
    // Linear chain a → b, plus a branch c off a, merged by d — heads: just d.
    fs.writeFileSync(path.join(versions, "001_a.py"), migration("aaa1", null));
    fs.writeFileSync(path.join(versions, "002_b.py"), migration("bbb2", "aaa1"));
    fs.writeFileSync(path.join(versions, "003_c.py"), migration("ccc3", "aaa1"));
    fs.writeFileSync(path.join(versions, "004_merge.py"), migration("ddd4", ["bbb2", "ccc3"]));
    fs.writeFileSync(path.join(versions, "__init__.py"), "");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("finds the versions dir via alembic.ini and computes the merged head", () => {
    const info = detectAlembic(root);
    expect(info).toEqual({
      versionsDir: "migrations/versions",
      count: 4,
      heads: ["ddd4"],
    });
  });

  it("finds the conventional env.py + versions/ pair without alembic.ini", () => {
    fs.rmSync(path.join(root, "alembic.ini"));
    expect(detectAlembic(root)?.count).toBe(4);
  });

  it("reports multiple heads when branches are unmerged", () => {
    fs.rmSync(path.join(root, "migrations", "versions", "004_merge.py"));
    expect(detectAlembic(root)?.heads).toEqual(["bbb2", "ccc3"]);
  });

  it("returns null when there is nothing alembic-shaped", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "archscope-noalembic-"));
    expect(detectAlembic(empty)).toBeNull();
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
