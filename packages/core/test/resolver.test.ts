import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type Resolution, TsResolver } from "../src/resolve/ts-resolver.js";
import { discoverWorkspacePackages } from "../src/resolve/workspace.js";
import { fixturePath } from "./helpers.js";

/**
 * Table-driven resolver cases. Every mis-resolution bug report becomes one
 * new row here — that is the maintenance contract for the resolver.
 */

interface Case {
  importer: string;
  specifier: string;
  expected: Resolution;
}

describe("TsResolver on ts-basic", () => {
  const root = fixturePath("ts-basic");
  const resolver = new TsResolver(root, discoverWorkspacePackages(root));

  const cases: Case[] = [
    {
      importer: "src/main.ts",
      specifier: "./auth",
      expected: { type: "file", relPath: "src/auth/index.ts" },
    },
    {
      importer: "src/main.ts",
      specifier: "@utils/format",
      expected: { type: "file", relPath: "src/utils/format.ts" },
    },
    {
      importer: "src/auth/login.ts",
      specifier: "../utils/format.js",
      expected: { type: "file", relPath: "src/utils/format.ts" },
    },
    {
      importer: "src/auth/login.ts",
      specifier: "./session.js",
      expected: { type: "file", relPath: "src/auth/session.ts" },
    },
    {
      importer: "src/main.ts",
      specifier: "express",
      expected: { type: "package", name: "express", registry: "npm" },
    },
    {
      importer: "src/main.ts",
      specifier: "node:path",
      expected: { type: "builtin", name: "path" },
    },
    {
      importer: "src/db/client.ts",
      specifier: "node:fs",
      expected: { type: "builtin", name: "fs" },
    },
    {
      importer: "src/main.ts",
      specifier: "@scope/pkg/deep/path",
      expected: { type: "package", name: "@scope/pkg", registry: "npm" },
    },
    { importer: "src/main.ts", specifier: "./does-not-exist", expected: { type: "unresolved" } },
  ];

  it.each(cases)("$importer → $specifier", ({ importer, specifier, expected }) => {
    expect(resolver.resolve(importer, specifier)).toEqual(expected);
  });
});

describe("TsResolver under a symlinked root", () => {
  // macOS os.tmpdir() lives under /var → /private/var. enhanced-resolve
  // returns symlink-free paths, so an un-realpathed root made every file
  // classify as outside the repo (bug found by the Phase 2 diff tests).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archscope-symlink-"));
  fs.cpSync(fixturePath("ts-basic"), root, { recursive: true });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves relative imports to files, not 'unresolved'", () => {
    const resolver = new TsResolver(root, discoverWorkspacePackages(root));
    expect(resolver.resolve("src/main.ts", "./auth")).toEqual({
      type: "file",
      relPath: "src/auth/index.ts",
    });
  });
});

describe("TsResolver on ts-monorepo", () => {
  const root = fixturePath("ts-monorepo");
  const resolver = new TsResolver(root, discoverWorkspacePackages(root));

  const cases: Case[] = [
    {
      importer: "packages/ui/src/index.ts",
      specifier: "@fix/core",
      expected: { type: "file", relPath: "packages/core-lib/src/index.ts" },
    },
    {
      importer: "packages/ui/src/index.ts",
      specifier: "@fix/core/helpers",
      expected: { type: "file", relPath: "packages/core-lib/src/helpers.ts" },
    },
  ];

  it.each(cases)("$importer → $specifier", ({ importer, specifier, expected }) => {
    expect(resolver.resolve(importer, specifier)).toEqual(expected);
  });
});
