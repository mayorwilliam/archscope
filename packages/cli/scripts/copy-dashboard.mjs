import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ship the dashboard inside the CLI package: @archmap/dashboard publishes
 * nothing (private), so its built dist/ is copied to <pkg>/dashboard, where
 * `archmap serve` falls back when the workspace package isn't resolvable
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
