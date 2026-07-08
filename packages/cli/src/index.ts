#!/usr/bin/env node
import { Command } from "commander";
import { runAnalyze } from "./commands/analyze.js";
import { runDiff } from "./commands/diff.js";
import { runInit } from "./commands/init.js";
import { runMcp } from "./commands/mcp.js";
import { runWatch } from "./commands/watch.js";

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
  .option("--full", "re-extract every file, ignoring the incremental cache")
  .action(async (options: { full?: boolean }) => {
    await runAnalyze(process.cwd(), options);
  });

program
  .command("diff")
  .description("Compare the architecture between two refs (snapshots built on demand)")
  .argument("<base>", "base ref (sha, branch, tag)")
  .argument("[head]", "head ref", "HEAD")
  .option("--json", "print the full ArchDiff as JSON")
  .action(async (base: string, head: string, options: { json?: boolean }) => {
    await runDiff(process.cwd(), base, head, options);
  });

program
  .command("mcp")
  .description("Serve the architecture graph to coding agents over MCP stdio")
  .action(async () => {
    await runMcp(process.cwd());
  });

program
  .command("watch")
  .description("Re-analyze on file changes (incremental via the facts cache)")
  .action(async () => {
    await runWatch(process.cwd());
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
