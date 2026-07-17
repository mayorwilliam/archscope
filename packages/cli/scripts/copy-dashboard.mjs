import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ship the dashboard inside the CLI package: @archscope/dashboard publishes
 * nothing (private), so its built dist/ is copied to <pkg>/dashboard, where
 * `archscope serve` falls back when the workspace package isn't resolvable
 * (i.e. every npm install).
 */
const pkgDir = path.resolve(fileURLToPath(import.meta.url), "../..");
const source = path.resolve(pkgDir, "../dashboard/dist");
const target = path.join(pkgDir, "dashboard");

if (!fs.existsSync(path.join(source, "index.html"))) {
  console.error(`copy-dashboard: no built dashboard at ${source} — run the dashboard build first.`);
  process.exit(1);
}
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
console.log(`copy-dashboard: ${source} → ${target}`);

// npm always packs README.md from the package dir — the canonical one lives
// at the repo root, so mirror it here at build time (gitignored).
const readme = path.resolve(pkgDir, "../../README.md");
if (fs.existsSync(readme)) {
  fs.copyFileSync(readme, path.join(pkgDir, "README.md"));
  console.log("copy-dashboard: README.md mirrored into the package");
}
