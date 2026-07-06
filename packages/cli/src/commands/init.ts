import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILENAME, discoverWorkspacePackages, scanSourceFiles } from "@archmap/core";
import { parseArchmapConfig } from "@archmap/schema";

/**
 * `archmap init`: detect the stack, write a config that teaches its own
 * format (suggestions arrive as comments, not decisions), gitignore .archmap/.
 */

interface Detection {
  hasTs: boolean;
  hasPy: boolean;
  workspaceNames: string[];
  ormFiles: string[];
  layerSuggestions: Array<{ dir: string; layer: string }>;
}

const LAYER_HINTS: Record<string, string> = {
  routes: "api",
  controllers: "api",
  api: "api",
  handlers: "api",
  services: "domain",
  domain: "domain",
  usecases: "domain",
  models: "data",
  repositories: "data",
  db: "data",
  entities: "data",
};

export async function runInit(rootDir: string): Promise<void> {
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  if (fs.existsSync(configPath)) {
    console.log(`${CONFIG_FILENAME} already exists — leaving it untouched.`);
    ensureGitignore(rootDir);
    return;
  }

  const detection = detect(rootDir);
  fs.writeFileSync(configPath, renderConfig(detection));
  ensureGitignore(rootDir);

  console.log(`Wrote ${CONFIG_FILENAME}`);
  if (detection.workspaceNames.length > 0) {
    console.log(
      `Detected ${detection.workspaceNames.length} workspace packages (used as modules).`,
    );
  }
  if (detection.ormFiles.length > 0) {
    console.log(`Detected ORM/schema files: ${detection.ormFiles.join(", ")}`);
  }
  console.log("\nNext steps:");
  console.log("  archmap analyze     # build the architecture graph");
}

function detect(rootDir: string): Detection {
  const files = scanSourceFiles(rootDir, parseArchmapConfig({}));
  const workspaceNames = discoverWorkspacePackages(rootDir).map((p) => p.name);

  const ormFiles: string[] = [];
  if (fs.existsSync(path.join(rootDir, "prisma/schema.prisma"))) {
    ormFiles.push("prisma/schema.prisma");
  }
  if (fs.existsSync(path.join(rootDir, "schema.prisma"))) {
    ormFiles.push("schema.prisma");
  }

  const firstLevelDirs = new Set<string>();
  for (const file of files) {
    const withoutSrc = file.startsWith("src/") ? file.slice(4) : file;
    const slash = withoutSrc.indexOf("/");
    if (slash !== -1) firstLevelDirs.add(withoutSrc.slice(0, slash));
  }
  const layerSuggestions = [...firstLevelDirs]
    .filter((dir) => LAYER_HINTS[dir])
    .sort()
    .map((dir) => ({ dir, layer: LAYER_HINTS[dir] as string }));

  return {
    hasTs: files.some((f) => /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(f)),
    hasPy: files.some((f) => f.endsWith(".py")),
    workspaceNames,
    ormFiles,
    layerSuggestions,
  };
}

function renderConfig(d: Detection): string {
  const lines: string[] = [
    "# archmap configuration — commit this file.",
    "# Everything here is optional: without it, workspace packages and",
    "# first-level directories become modules automatically.",
    "version: 1",
    "",
    "# Order layers top→bottom to drive the dashboard's vertical layout:",
    "# layers: [api, domain, data]",
    "",
  ];

  if (d.layerSuggestions.length > 0) {
    lines.push("# Detected directories that look like layers — uncomment and adjust:");
    lines.push("# modules:");
    for (const s of d.layerSuggestions) {
      lines.push(`#   - name: ${s.dir}`);
      lines.push(`#     layer: ${s.layer}`);
      lines.push(`#     include: ["src/${s.dir}/**"]`);
    }
    lines.push("");
  }

  lines.push("# Dependencies static analysis cannot see (dynamic imports, plugins):");
  lines.push("# edges:");
  lines.push('#   - from: "mod:plugins"');
  lines.push('#     to: "mod:core"');
  lines.push("#     kind: depends_on");
  lines.push('#     reason: "loaded via importlib at runtime"');
  lines.push("");

  if (d.hasPy) {
    lines.push("# python:");
    lines.push('#   sourceRoots: ["backend/src"]');
    lines.push("");
  }

  lines.push("# db:");
  lines.push("#   static: auto");
  if (d.ormFiles.length > 0) {
    lines.push(`#   # detected: ${d.ormFiles.join(", ")}`);
  }
  lines.push("#   live:");
  lines.push("#     - name: main");
  lines.push("#       dialect: postgres");
  lines.push("#       urlEnv: DATABASE_URL   # env var NAME — the value never touches disk");
  lines.push("");

  return lines.join("\n");
}

function ensureGitignore(rootDir: string): void {
  const gitignorePath = path.join(rootDir, ".gitignore");
  const entry = ".archmap/";
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf8");
    if (!content.split("\n").some((l) => l.trim() === entry || l.trim() === ".archmap")) {
      fs.appendFileSync(gitignorePath, `${content.endsWith("\n") ? "" : "\n"}${entry}\n`);
      console.log(`Added ${entry} to .gitignore`);
    }
  } else {
    fs.writeFileSync(gitignorePath, `${entry}\n`);
    console.log(`Created .gitignore with ${entry}`);
  }
}
