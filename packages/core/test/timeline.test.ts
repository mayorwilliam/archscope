import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitLog, gitRefs } from "../src/git.js";
import { ensureSnapshot } from "../src/snapshot.js";
import { buildHistory, buildTimeline } from "../src/timeline.js";

/**
 * Timeline over a real (temp) git repo: 3 commits on main, one annotated tag.
 * Git metadata is live state, so these tests assert structure and ordering,
 * never absolute dates.
 */

describe("timeline", () => {
  let root: string;
  const shas: string[] = [];

  const git = (...args: string[]) => execa("git", args, { cwd: root });

  async function commitAll(message: string): Promise<string> {
    await git("add", "-A");
    await git("commit", "-m", message);
    const { stdout } = await git("rev-parse", "HEAD");
    return stdout.trim();
  }

  function write(relPath: string, content: string): void {
    const file = path.join(root, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "archscope-timeline-")));
    await git("init", "-b", "main");
    await git("config", "user.email", "test@archscope.local");
    await git("config", "user.name", "archscope-test");
    write(".gitignore", ".archscope/\n");

    write("core/a.ts", "export function a(): number {\n  return 1;\n}\n");
    shas.push(await commitAll("core: primer commit"));

    write("api/b.ts", 'import { a } from "../core/a.js";\nexport const b = a();\n');
    shas.push(await commitAll("api: depende de core"));
    await git("tag", "-a", "v0.1.0", "-m", "primera release");

    write("core/c.ts", "export function c(): number {\n  return 3;\n}\n");
    shas.push(await commitAll("core: archivo nuevo"));
  }, 30_000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe("gitLog", () => {
    it("returns commits newest-first with sha, date, author, subject", async () => {
      const log = await gitLog(root, { limit: 10 });
      expect(log.map((c) => c.sha)).toEqual([...shas].reverse());
      expect(log[0]?.subject).toBe("core: archivo nuevo");
      expect(log[0]?.author).toBe("archscope-test");
      expect(log[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(log[0]?.shortSha.length).toBeGreaterThanOrEqual(7);
    });

    it("parses tag decorations into tags[]", async () => {
      const log = await gitLog(root, { limit: 10 });
      const tagged = log.find((c) => c.sha === shas[1]);
      expect(tagged?.tags).toEqual(["v0.1.0"]);
      expect(log[0]?.tags).toEqual([]);
    });

    it("respects the limit and the ref", async () => {
      const one = await gitLog(root, { limit: 1 });
      expect(one).toHaveLength(1);
      const fromTag = await gitLog(root, { limit: 10, ref: "v0.1.0" });
      expect(fromTag[0]?.sha).toBe(shas[1]);
    });

    it("returns [] outside a git repo", async () => {
      expect(await gitLog(os.tmpdir())).toEqual([]);
    });
  });

  describe("gitRefs with dates", () => {
    it("annotated tags carry the PEELED commit sha and a date", async () => {
      const refs = await gitRefs(root);
      const tag = refs.find((r) => r.kind === "tag");
      expect(tag?.name).toBe("v0.1.0");
      expect(tag?.sha).toBe(shas[1]); // commit, not the tag object
      expect(tag?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("buildTimeline", () => {
    it("merges commits and marks milestones; nothing is built yet", async () => {
      const view = await buildTimeline(root, { commits: 10 });
      expect(view.branch).toBe("main");
      expect(view.points).toHaveLength(3);
      expect(view.points[0]?.sha).toBe(shas[2]); // newest first
      const milestone = view.points.find((p) => p.milestone);
      expect(milestone?.sha).toBe(shas[1]);
      expect(milestone?.tags).toEqual(["v0.1.0"]);
      expect(view.totals).toEqual({ commits: 3, milestones: 1, snapshotsBuilt: 0 });
      expect(view.points.every((p) => p.snapshot.built === false)).toBe(true);
    });

    it("snapshot.built flips (with counts) after ensureSnapshot", async () => {
      await ensureSnapshot(root, shas[1] as string);
      const view = await buildTimeline(root, { commits: 10 });
      const point = view.points.find((p) => p.sha === shas[1]);
      expect(point?.snapshot.built).toBe(true);
      expect(point?.snapshot.counts?.file).toBe(2);
      expect(view.totals.snapshotsBuilt).toBe(1);
    }, 30_000);

    it("a tag outside the commit window still appears as a milestone", async () => {
      const view = await buildTimeline(root, { commits: 1 });
      expect(view.points.some((p) => p.sha === shas[1] && p.milestone)).toBe(true);
    });
  });

  describe("buildHistory", () => {
    it("folds a range into waypoint intervals through the tag", async () => {
      const view = await buildHistory(root, { from: shas[0] as string, to: "HEAD" });
      expect(view.points.map((p) => p.sha)).toEqual(shas);
      expect(view.points[1]?.label).toBe("v0.1.0");
      expect(view.intervals).toHaveLength(2);
      // First interval: api/b.ts appears → new module dependency api → core.
      const first = view.intervals[0]?.diff;
      expect(first?.moduleChanges.added).toContain("mod:api");
      expect(
        first?.dependencyChanges.added.some((e) => e.from === "mod:api" && e.to === "mod:core"),
      ).toBe(true);
      // Second interval: only a file lands in core.
      const second = view.intervals[1]?.diff;
      expect(second?.moduleChanges.added).toEqual([]);
      expect(second?.fileChanges.map((c) => c.id)).toEqual(["file:core/c.ts"]);
    }, 60_000);

    it("an empty range yields no intervals", async () => {
      const view = await buildHistory(root, { from: "HEAD", to: "HEAD" });
      expect(view.intervals).toEqual([]);
    });
  });
});
