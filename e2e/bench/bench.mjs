import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Performance bench (Fase 6 acceptance): a synthetic 5k-file repo must
 * analyze in < 60s cold and < 5s warm, against the BUILT CLI (the pool only
 * exists in dist). Non-blocking trend by default; `--assert` enforces the
 * thresholds (CI can decide when to gate).
 *
 * Usage: node e2e/bench/bench.mjs [--files 5000] [--assert] [--keep]
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const CLI = path.join(ROOT, "packages/cli/dist/index.js");

const args = process.argv.slice(2);
const FILES = Number(args[args.indexOf("--files") + 1]) || 5000;
const ASSERT = args.includes("--assert");
const KEEP = args.includes("--keep");

const COLD_BUDGET_MS = 60_000;
const WARM_BUDGET_MS = 5_000;

if (!fs.existsSync(CLI)) {
  console.error("Built CLI not found — run `pnpm build` first.");
  process.exit(1);
}

// --- synthetic repo: MODULES top-level dirs, chain + fan-in imports ---------

const MODULES = 25;
const perModule = Math.ceil(FILES / MODULES);
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "archmap-bench-"));

function fileBody(mod, i) {
  const lines = [];
  if (i > 0) lines.push(`import { fn${i - 1} } from "./file${i - 1}";`);
  if (i > 9) lines.push(`import { fn${i - 10} } from "./file${i - 10}";`);
  if (mod > 0 && i === 0) lines.push(`import { fn0 } from "../mod${mod - 1}/file0";`);
  lines.push("");
  lines.push(`export interface Shape${i} { id: number; label: string; }`);
  lines.push(`export const value${i} = ${i};`);
  lines.push(`export function fn${i}(input: Shape${i}): number {`);
  lines.push(
    `  return input.id + value${i}${i > 0 ? ` + fn${i - 1}({ id: 1, label: "x" })` : ""};`,
  );
  lines.push("}");
  return lines.join("\n");
}

let written = 0;
for (let mod = 0; mod < MODULES && written < FILES; mod++) {
  const dir = path.join(repo, `mod${mod}`);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < perModule && written < FILES; i++, written++) {
    fs.writeFileSync(path.join(dir, `file${i}.ts`), fileBody(mod, i));
  }
}
fs.writeFileSync(
  path.join(repo, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true } }),
);
console.log(`Synthetic repo: ${written} files in ${MODULES} modules at ${repo}`);

// --- runs --------------------------------------------------------------------

function analyze(label) {
  const start = performance.now();
  const out = execFileSync(process.execPath, [CLI, "analyze"], { cwd: repo, encoding: "utf8" });
  const ms = performance.now() - start;
  const stats = out.match(/(\d+) cached \/ (\d+) extracted/)?.slice(1) ?? [];
  console.log(
    `${label}: ${(ms / 1000).toFixed(2)}s${stats.length ? ` (${stats[0]} cached / ${stats[1]} extracted)` : ""}`,
  );
  return ms;
}

const cold = analyze("cold");
const warm = analyze("warm");

if (!KEEP) fs.rmSync(repo, { recursive: true, force: true });
else console.log(`Kept: ${repo}`);

console.log(
  `budgets: cold < ${COLD_BUDGET_MS / 1000}s (${cold < COLD_BUDGET_MS ? "PASS" : "FAIL"}), ` +
    `warm < ${WARM_BUDGET_MS / 1000}s (${warm < WARM_BUDGET_MS ? "PASS" : "FAIL"})`,
);
if (ASSERT && (cold >= COLD_BUDGET_MS || warm >= WARM_BUDGET_MS)) process.exit(1);
