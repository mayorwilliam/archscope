import path from "node:path";
import type { ArchmapConfig } from "@archmap/schema";
import { normalizePath } from "@archmap/schema";
import picomatch from "picomatch";
import type { WorkspacePackage } from "../resolve/workspace.js";

/**
 * Module inference: how files become architecture. Three tiers, first match
 * wins — and each tier is deliberately *predictable* (a heuristic the user
 * can simulate in their head beats a clever one they can't):
 *
 *   1. `.archmap.yaml` module rules (user intent always wins)
 *   2. workspace packages (the right answer in most monorepos)
 *   3. first-level directory under the source root
 */

export interface ModuleAssignment {
  moduleName: string;
  layer?: string;
  source: "config" | "workspace" | "inferred";
}

export type ModuleInferrer = (relPath: string) => ModuleAssignment;

export function createModuleInferrer(
  rootDir: string,
  config: ArchmapConfig,
  workspacePackages: WorkspacePackage[],
): ModuleInferrer {
  const rules = (config.modules ?? []).map((rule) => ({
    rule,
    isMatch: picomatch(rule.include, { dot: true }),
  }));

  const workspaceDirs = workspacePackages
    .map((p) => ({ name: p.name, relDir: normalizePath(path.relative(rootDir, p.dir)) }))
    // Deeper dirs first so nested packages win over their parents.
    .sort((a, b) => b.relDir.length - a.relDir.length);

  const rootName = path.basename(rootDir);

  return (relPath: string): ModuleAssignment => {
    for (const { rule, isMatch } of rules) {
      if (isMatch(relPath)) {
        const assignment: ModuleAssignment = { moduleName: rule.name, source: "config" };
        if (rule.layer !== undefined) assignment.layer = rule.layer;
        return assignment;
      }
    }

    for (const ws of workspaceDirs) {
      if (relPath.startsWith(`${ws.relDir}/`)) {
        return { moduleName: ws.name, source: "workspace" };
      }
    }

    const withoutSrc = relPath.startsWith("src/") ? relPath.slice(4) : relPath;
    const segments = withoutSrc.split("/");
    if (segments.length === 1) {
      // Loose file at the root (or directly in src/) joins the root module.
      return { moduleName: rootName, source: "inferred" };
    }
    const first = segments[0] as string;
    // Well-known container dirs are not architecture — descend one level so an
    // undeclared monorepo (lerna without workspaces, rush, ...) still splits
    // into its real packages instead of one giant "packages" module.
    if (CONTAINER_DIRS.has(first) && segments.length > 2) {
      return { moduleName: segments[1] as string, source: "inferred" };
    }
    return { moduleName: first, source: "inferred" };
  };
}

const CONTAINER_DIRS = new Set(["packages", "apps", "libs", "services", "modules"]);
