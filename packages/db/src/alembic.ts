import fs from "node:fs";
import path from "node:path";

/**
 * Alembic detection, best-effort BY DESIGN: finds the migration directory and
 * reads revision ids from the version files (regex over source text — never
 * executes anything). The schema itself is NOT reconstructed from migrations;
 * declared truth comes from the ORM extractors, live truth from introspection.
 * This exists so drift reports can say "you also have N alembic migrations,
 * head abc123" — a hint for the human, not a fact in the graph.
 */

export interface AlembicInfo {
  /** Repo-relative directory holding the version files. */
  versionsDir: string;
  /** Version files parsed. */
  count: number;
  /** Revisions nothing else lists as down_revision — the current head(s). */
  heads: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist"]);

export function detectAlembic(rootDir: string): AlembicInfo | null {
  const versionsDir = findVersionsDir(rootDir);
  if (!versionsDir) return null;

  const revisions = new Map<string, string[]>(); // revision → down_revisions
  const files = fs
    .readdirSync(versionsDir)
    .filter((f) => f.endsWith(".py") && !f.startsWith("__"))
    .sort();
  for (const file of files) {
    const source = fs.readFileSync(path.join(versionsDir, file), "utf8");
    const revision = matchAssignment(source, "revision");
    if (!revision) continue;
    revisions.set(revision[0] as string, matchAssignment(source, "down_revision") ?? []);
  }
  if (revisions.size === 0) return null;

  const referenced = new Set([...revisions.values()].flat());
  const heads = [...revisions.keys()].filter((r) => !referenced.has(r)).sort();

  return {
    versionsDir: path.relative(rootDir, versionsDir).split(path.sep).join("/"),
    count: revisions.size,
    heads,
  };
}

// ---------------------------------------------------------------------------

/**
 * alembic.ini's script_location first; otherwise a shallow walk (≤3 levels)
 * for the conventional env.py + versions/ pair.
 */
function findVersionsDir(rootDir: string): string | null {
  const ini = path.join(rootDir, "alembic.ini");
  if (fs.existsSync(ini)) {
    const match = fs.readFileSync(ini, "utf8").match(/^\s*script_location\s*=\s*(.+)$/m);
    if (match) {
      // "migrations" is a plain path; "%(here)s/migrations" anchors to the ini.
      const location = (match[1] as string).trim().replace(/%\(here\)s/g, ".");
      const candidate = path.join(rootDir, location, "versions");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return walkForVersions(rootDir, 3);
}

function walkForVersions(dir: string, depth: number): string | null {
  if (depth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = new Set(entries.map((e) => e.name));
  if (names.has("env.py") && names.has("versions")) {
    const versions = path.join(dir, "versions");
    if (fs.statSync(versions).isDirectory()) return versions;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const found = walkForVersions(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

/**
 * `revision = "ae1027a6acf"` / `down_revision = None` / tuple for merges,
 * with or without the modern `: str` annotation.
 */
function matchAssignment(source: string, name: string): string[] | null {
  const line = source.match(new RegExp(`^${name}(?::[^=]+)?\\s*=\\s*(.+)$`, "m"));
  if (!line) return null;
  const value = (line[1] as string).trim();
  if (value === "None") return [];
  const strings = [...value.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] as string);
  return strings.length > 0 ? strings : null;
}
