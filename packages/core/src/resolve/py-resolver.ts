import fs from "node:fs";
import path from "node:path";
import type { ArchmapConfig } from "@archmap/schema";
import type { ImportFact } from "../parse/facts.js";
import { PY_STDLIB } from "./py-stdlib.js";
import type { ResolvedImport } from "./resolver.js";

/**
 * Hand-rolled Python import resolution — no interpreter, no sys.path
 * execution, just the deterministic subset of Python's rules:
 *
 *   relative (`from .x import y`)  → anchored at the importer's package
 *   absolute (`import a.b`)        → probed against the source roots,
 *                                    THEN stdlib, THEN external (PyPI)
 *
 * Local-before-stdlib matches Python's own behavior (a repo-level `json.py`
 * shadows the stdlib module). Anything dynamic (importlib with non-literal
 * strings, sys.path mutation, namespace magic) is out of scope by design:
 * those become `manual` edges in `.archmap.yaml`, never guesses.
 *
 * One import can yield several edges: `from . import models, tasks` is a
 * dependency on each submodule file, not on the package's __init__.py.
 */

interface PyTarget {
  relPath: string;
  isPackage: boolean;
}

export class PyResolver {
  private readonly rootDir: string;
  private readonly roots: string[];
  private readonly dirCache = new Map<string, Set<string> | null>();

  constructor(rootDir: string, config: ArchmapConfig) {
    this.rootDir = rootDir;
    const configured = config.python?.sourceRoots;
    this.roots =
      configured && configured.length > 0
        ? configured.map((r) => normalizeRoot(r))
        : autoRoots(rootDir);
  }

  resolveImport(importerRelPath: string, imp: ImportFact): ResolvedImport[] {
    const specifier = imp.specifier;
    if (specifier === "") return [];

    if (specifier.startsWith(".")) {
      return this.resolveRelative(importerRelPath, specifier, imp.symbols);
    }
    return this.resolveAbsolute(specifier, imp.symbols);
  }

  // -------------------------------------------------------------------------

  private resolveRelative(
    importerRelPath: string,
    specifier: string,
    symbols: string[],
  ): ResolvedImport[] {
    let dots = 0;
    while (dots < specifier.length && specifier[dots] === ".") dots++;
    const rest = specifier.slice(dots);

    // One dot anchors at the importer's own package; each extra dot climbs one.
    let baseDir = path.posix.dirname(importerRelPath);
    if (baseDir === ".") baseDir = "";
    for (let i = 1; i < dots; i++) {
      if (baseDir === "") return [{ resolution: { type: "unresolved" }, symbols }];
      const parent = path.posix.dirname(baseDir);
      baseDir = parent === "." ? "" : parent;
    }

    if (rest === "") {
      // `from . import a, b` — the package itself; names are usually submodules.
      return this.edgesForPackage(baseDir, symbols);
    }

    const target = this.probe(joinRel(baseDir, rest.replace(/\./g, "/")));
    if (!target) return [{ resolution: { type: "unresolved" }, symbols }];
    if (target.isPackage) {
      return this.edgesForPackage(path.posix.dirname(target.relPath), symbols);
    }
    return [{ resolution: { type: "file", relPath: target.relPath }, symbols }];
  }

  private resolveAbsolute(specifier: string, symbols: string[]): ResolvedImport[] {
    const segments = specifier.split(".");
    const top = segments[0] as string;
    const asPath = segments.join("/");

    for (const root of this.roots) {
      const target = this.probe(joinRel(root, asPath));
      if (target) {
        if (target.isPackage) {
          return this.edgesForPackage(path.posix.dirname(target.relPath), symbols);
        }
        return [{ resolution: { type: "file", relPath: target.relPath }, symbols }];
      }
      // The top-level package exists locally but the dotted path doesn't:
      // that's a miss inside OUR code, not an external dependency.
      if (this.probe(joinRel(root, top))) {
        return [{ resolution: { type: "unresolved" }, symbols }];
      }
    }

    if (PY_STDLIB.has(top)) {
      return [{ resolution: { type: "builtin", name: top }, symbols }];
    }
    return [{ resolution: { type: "package", name: top, registry: "pypi" }, symbols }];
  }

  /**
   * Edges for `from <package> import a, b`: each name that exists as a
   * submodule gets its own file edge; the rest are attributes of __init__.py.
   */
  private edgesForPackage(packageDir: string, symbols: string[]): ResolvedImport[] {
    const out: ResolvedImport[] = [];
    const initSymbols: string[] = [];
    for (const symbol of symbols) {
      const sub = symbol === "*" ? null : this.probe(joinRel(packageDir, symbol));
      if (sub) out.push({ resolution: { type: "file", relPath: sub.relPath }, symbols: [] });
      else initSymbols.push(symbol);
    }
    const init = joinRel(packageDir, "__init__.py");
    if (this.isFile(init) && (initSymbols.length > 0 || out.length === 0)) {
      out.push({ resolution: { type: "file", relPath: init }, symbols: initSymbols });
    }
    if (out.length === 0) return [{ resolution: { type: "unresolved" }, symbols }];
    return out;
  }

  /** `x` → x.py (module) or x/__init__.py (package), module file first. */
  private probe(relBase: string): PyTarget | null {
    const asModule = `${relBase}.py`;
    if (this.isFile(asModule)) return { relPath: asModule, isPackage: false };
    const asPackage = joinRel(relBase, "__init__.py");
    if (this.isFile(asPackage)) return { relPath: asPackage, isPackage: true };
    return null;
  }

  /**
   * Existence check against real directory entries, not stat: on the
   * case-insensitive filesystems of macOS/Windows, stat("User.py") succeeds
   * when the file is user.py — and the graph would then differ from Linux.
   * Exact-casing matches Python-on-Linux semantics on every platform.
   */
  private isFile(relPath: string): boolean {
    const dir = path.posix.dirname(relPath);
    const entries = this.listDir(dir === "." ? "" : dir);
    return entries?.has(path.posix.basename(relPath)) ?? false;
  }

  private listDir(relDir: string): Set<string> | null {
    const cached = this.dirCache.get(relDir);
    if (cached !== undefined) return cached;
    let result: Set<string> | null = null;
    try {
      const entries = fs.readdirSync(path.join(this.rootDir, relDir), { withFileTypes: true });
      result = new Set(entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name));
    } catch {
      result = null;
    }
    this.dirCache.set(relDir, result);
    return result;
  }
}

// ---------------------------------------------------------------------------

function joinRel(base: string, rest: string): string {
  return base === "" ? rest : `${base}/${rest}`;
}

function normalizeRoot(root: string): string {
  const clean = root.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return clean === "." ? "" : clean;
}

/** Flat layout always; `src/` added when present (Python src-layout). */
function autoRoots(rootDir: string): string[] {
  const roots: string[] = [];
  try {
    if (fs.statSync(path.join(rootDir, "src")).isDirectory()) roots.push("src");
  } catch {
    // no src/ — flat layout
  }
  roots.push("");
  return roots;
}
