#!/usr/bin/env node
import { Command } from "commander";
import { runAnalyze } from "./commands/analyze.js";
import { runInit } from "./commands/init.js";

const program = new Command();

program
  .name("archmap")
  .description(
    "Architecture graphs for humans and coding agents — from static analysis, deterministically.",
  )
  .version("0.0.1");

program
  .command("init")
  .description("Detect the stack and write .archmap.yaml with commented suggestions")
  .action(async () => {
    await runInit(process.cwd());
  });

program
  .command("analyze")
  .description("Build the architecture graph and write .archmap/graph.json")
  .option("--full", "bypass the incremental cache (no-op until Phase 2)")
  .action(async (options: { full?: boolean }) => {
    await runAnalyze(process.cwd(), options);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
