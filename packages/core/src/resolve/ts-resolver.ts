import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { normalizePath } from "@archmap/schema";
import enhancedResolve from "enhanced-resolve";
import { createPathsMatcher, getTsconfig, type TsConfigResult } from "get-tsconfig";
import type { WorkspacePackage } from "./workspace.js";

const { ResolverFactory, CachedInputFileSystem } = enhancedResolve;

/**
 * TS/JS import resolution. Order matters and is deliberate:
 *
 *   1. node builtins            → builtin
 *   2. relative/absolute        → enhanced-resolve from the importer's dir
 *   3. tsconfig paths aliases   → candidates probed via enhanced-resolve
 *   4. workspace packages       → resolved to SOURCE files (no node_modules)
 *   5. bare specifier           → enhanced-resolve; node_modules ⇒ package
 *
 * Every fallthrough ends in `package` (external) rather than an error:
 * an unresolvable bare import is an external fact, not a crash.
 */

export type Resolution =
  | { type: "file"; relPath: string }
  | { type: "package"; name: string; registry: "npm" | "pypi" }
  | { type: "builtin"; name: string }
  | { type: "unresolved" };

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const BUILTINS = new Set(builtinModules);

export class TsResolver {
  private readonly rootDir: string;
  private readonly workspaceByName: Map<string, WorkspacePackage>;
  private readonly resolver: ReturnType<typeof ResolverFactory.createResolver>;
  private readonly tsconfigCache = new Map<string, TsConfigResult | null>();
  private readonly matcherCache = new Map<string, ((specifier: string) => string[]) | null>();

  constructor(rootDir: string, workspacePackages: WorkspacePackage[]) {
    // classify() compares enhanced-resolve output (always symlink-free) with
    // this root — so the root itself must be symlink-free too.
    this.rootDir = fs.realpathSync(rootDir);
    this.workspaceByName = new Map(workspacePackages.map((p) => [p.name, p]));
    this.resolver = ResolverFactory.createResolver({
      // biome-ignore lint/suspicious/noExplicitAny: enhanced-resolve's fs type is narrower than node:fs
      fileSystem: new CachedInputFileSystem(fs as any, 4000),
      useSyncFileSystemCalls: true,
      extensions: [...SOURCE_EXTENSIONS, ".json"],
      // ESM-written-in-TS: `import "./x.js"` must find x.ts.
      extensionAlias: {
        ".js": [".ts", ".tsx", ".js", ".jsx"],
        ".mjs": [".mts", ".mjs"],
        ".cjs": [".cts", ".cjs"],
      },
      conditionNames: ["types", "import", "node", "require", "default"],
      mainFields: ["types", "module", "main"],
      mainFiles: ["index"],
      symlinks: true,
    });
  }

  resolve(importerRelPath: string, specifier: string): Resolution {
    const clean = specifier.split("?")[0] as string;
    if (clean === "") return { type: "unresolved" };

    if (clean.startsWith("node:") || BUILTINS.has(clean)) {
      return { type: "builtin", name: clean.replace(/^node:/, "") };
    }

    const importerDir = path.dirname(path.join(this.rootDir, importerRelPath));

    if (clean.startsWith(".") || clean.startsWith("/")) {
      const hit = this.tryEnhanced(importerDir, clean);
      return hit ? this.classify(hit) : { type: "unresolved" };
    }

    const viaPaths = this.tryTsconfigPaths(importerRelPath, clean);
    if (viaPaths) return viaPaths;

    const viaWorkspace = this.tryWorkspace(clean);
    if (viaWorkspace) return viaWorkspace;

    const hit = this.tryEnhanced(importerDir, clean);
    if (hit) return this.classify(hit);

    return { type: "package", name: packageNameOf(clean), registry: "npm" };
  }

  // -------------------------------------------------------------------------

  private classify(absPath: string): Resolution {
    const normalized = normalizePath(absPath);
    const nmIndex = normalized.lastIndexOf("/node_modules/");
    if (nmIndex !== -1) {
      const after = normalized.slice(nmIndex + "/node_modules/".length);
      return { type: "package", name: packageNameOf(after), registry: "npm" };
    }
    const rel = path.relative(this.rootDir, absPath);
    if (rel.startsWith("..")) return { type: "unresolved" };
    return { type: "file", relPath: normalizePath(rel) };
  }

  private tryEnhanced(contextDir: string, specifier: string): string | null {
    try {
      const result = this.resolver.resolveSync({}, contextDir, specifier);
      return typeof result === "string" ? result : null;
    } catch {
      return null;
    }
  }

  private tryTsconfigPaths(importerRelPath: string, specifier: string): Resolution | null {
    const importerAbs = path.join(this.rootDir, importerRelPath);
    const matcher = this.matcherFor(importerAbs);
    if (!matcher) return null;
    for (const candidate of matcher(specifier)) {
      // Candidates are path prefixes, not final files: probe with extensions.
      const probed =
        this.tryEnhanced(path.dirname(candidate), `./${path.basename(candidate)}`) ??
        probeFile(candidate);
      if (probed) return this.classify(probed);
    }
    return null;
  }

  private matcherFor(importerAbs: string): ((specifier: string) => string[]) | null {
    const dir = path.dirname(importerAbs);
    const cached = this.matcherCache.get(dir);
    if (cached !== undefined) return cached;

    let tsconfig = this.tsconfigCache.get(dir);
    if (tsconfig === undefined) {
      try {
        tsconfig = getTsconfig(importerAbs);
      } catch {
        // Unresolvable `extends` (e.g. an uninstalled shared-config package)
        // must not kill the analysis — we just lose paths aliases for it.
        tsconfig = null;
      }
      this.tsconfigCache.set(dir, tsconfig);
    }
    const matcher = tsconfig ? createPathsMatcher(tsconfig) : null;
    this.matcherCache.set(dir, matcher);
    return matcher;
  }

  private tryWorkspace(specifier: string): Resolution | null {
    const name = packageNameOf(specifier);
    const pkg = this.workspaceByName.get(name);
    if (!pkg) return null;
    const subpath = specifier.slice(name.length).replace(/^\//, "");
    const target = subpath
      ? resolveWorkspaceSubpath(pkg.dir, subpath)
      : resolveWorkspaceEntry(pkg.dir);
    return target ? this.classify(target) : { type: "unresolved" };
  }
}

// ---------------------------------------------------------------------------

export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@") && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] as string;
}

function probeFile(base: string): string | null {
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const ext of SOURCE_EXTENSIONS) {
    const withExt = base + ext;
    if (fs.existsSync(withExt)) return withExt;
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const index = path.join(base, `index${ext}`);
    if (fs.existsSync(index)) return index;
  }
  return null;
}

/**
 * Resolve a workspace package's root import to a source file, without
 * node_modules. The architecture graph always wants SOURCE, never build
 * artifacts: a declared entry like "main": "dist/index.js" is mapped to its
 * src/ twin FIRST — whether or not dist/ happens to be built right now.
 * (If dist won the race, the edge would point at an unscanned artifact and
 * silently vanish from the graph.)
 */
function resolveWorkspaceEntry(pkgDir: string): string | null {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const candidates: string[] = [];
  const rootExport = (pkg.exports as Record<string, unknown> | string | undefined) ?? undefined;
  collectExportTargets(
    typeof rootExport === "object" && rootExport !== null && "." in rootExport
      ? (rootExport as Record<string, unknown>)["."]
      : rootExport,
    candidates,
  );
  for (const field of ["types", "module", "main"]) {
    const value = pkg[field];
    if (typeof value === "string") candidates.push(value);
  }
  for (const candidate of candidates) {
    const srcTwin = candidate
      .replace(/^(\.\/)?(dist|build|lib)\//, "src/")
      .replace(/\.d\.ts$/, "")
      .replace(/\.(js|mjs|cjs)$/, "");
    if (srcTwin !== candidate) {
      const probedSrc = probeFile(path.join(pkgDir, srcTwin));
      if (probedSrc) return probedSrc;
    }
    const probed = probeFile(path.join(pkgDir, candidate));
    if (probed) return probed;
  }
  return probeFile(path.join(pkgDir, "src/index")) ?? probeFile(path.join(pkgDir, "index"));
}

function resolveWorkspaceSubpath(pkgDir: string, subpath: string): string | null {
  // src/ first for the same reason as above: source beats artifacts.
  return probeFile(path.join(pkgDir, "src", subpath)) ?? probeFile(path.join(pkgDir, subpath));
}

function collectExportTargets(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value && typeof value === "object") {
    for (const key of ["types", "import", "default", "require", "node"]) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested !== undefined) collectExportTargets(nested, out);
    }
  }
}
