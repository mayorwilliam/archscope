import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/**
 * Workspace package discovery. Imports between workspace packages must
 * resolve to *source files* (a real `imports` edge), never to node_modules —
 * that is what makes monorepo module boundaries visible in the graph.
 *
 * Works without node_modules installed (fixtures are never `pnpm install`ed),
 * so resolution is driven by package.json metadata, not symlinks.
 */

export interface WorkspacePackage {
  name: string;
  /** Absolute path to the package directory. */
  dir: string;
}

export function discoverWorkspacePackages(rootDir: string): WorkspacePackage[] {
  const globs = readWorkspaceGlobs(rootDir);
  const packages: WorkspacePackage[] = [];
  for (const glob of globs) {
    if (glob.startsWith("!")) continue; // negations unsupported in v1
    for (const dir of expandSimpleGlob(rootDir, glob)) {
      const pkgJsonPath = path.join(dir, "package.json");
      if (!fs.existsSync(pkgJsonPath)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as { name?: string };
        if (pkg.name) packages.push({ name: pkg.name, dir });
      } catch {
        // unparseable package.json — not a package
      }
    }
  }
  return packages;
}

function readWorkspaceGlobs(rootDir: string): string[] {
  const pnpmWs = path.join(rootDir, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmWs)) {
    try {
      const parsed = YAML.parse(fs.readFileSync(pnpmWs, "utf8")) as { packages?: string[] };
      if (Array.isArray(parsed?.packages)) return parsed.packages;
    } catch {
      // fall through to package.json
    }
  }
  const rootPkgPath = path.join(rootDir, "package.json");
  if (fs.existsSync(rootPkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8")) as {
        workspaces?: string[] | { packages?: string[] };
      };
      if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
      if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) return pkg.workspaces.packages;
    } catch {
      // no workspaces
    }
  }
  return [];
}

/**
 * Supports the two shapes that cover real-world workspace files:
 * exact dirs ("docs") and single-level stars ("packages/*").
 * Deeper patterns ("**") are intentionally unsupported in v1 — predictable
 * over clever; the config file is the escape hatch.
 */
function expandSimpleGlob(rootDir: string, glob: string): string[] {
  const clean = glob.replace(/\/$/, "");
  if (!clean.includes("*")) {
    const dir = path.join(rootDir, clean);
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? [dir] : [];
  }
  if (clean.endsWith("/*")) {
    const parent = path.join(rootDir, clean.slice(0, -2));
    if (!fs.existsSync(parent)) return [];
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(parent, e.name));
  }
  return [];
}
