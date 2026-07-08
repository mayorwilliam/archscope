import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, Store } from "@archmap/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execa } from "execa";

export const CLI_BIN = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../packages/cli/dist/index.js",
);

/**
 * A synthetic repo big enough to force truncation at small budgets:
 * `areas` top-level dirs (→ inferred modules) × `filesPerArea` files.
 * Inside an area, file-i imports file-(i-1); across areas, area-k/file-0
 * imports the LAST file of area-(k-1) — one long dependency chain, so
 * impact/depth numbers are exactly predictable.
 */
export function generateRepo(dir: string, areas: number, filesPerArea: number): void {
  for (let k = 0; k < areas; k++) {
    const areaDir = path.join(dir, `area${k}`);
    fs.mkdirSync(areaDir, { recursive: true });
    for (let f = 0; f < filesPerArea; f++) {
      const lines: string[] = [];
      if (f > 0) {
        lines.push(`import { helper${f - 1} } from "./file-${f - 1}.js";`);
        lines.push(`export function helper${f}(): number { return helper${f - 1}() + 1; }`);
      } else if (k > 0) {
        const last = filesPerArea - 1;
        lines.push(`import { helper${last} } from "../area${k - 1}/file-${last}.js";`);
        lines.push(`export function helper0(): number { return helper${last}() + 1; }`);
      } else {
        lines.push("export function helper0(): number { return 0; }");
      }
      fs.writeFileSync(path.join(areaDir, `file-${f}.ts`), `${lines.join("\n")}\n`);
    }
  }
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout.trim();
}

export async function initGitRepo(dir: string): Promise<void> {
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "e2e@archmap.test");
  await git(dir, "config", "user.name", "archmap e2e");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".archmap/\n");
}

export async function analyzeAndSave(dir: string): Promise<void> {
  const { graph } = await analyze({ rootDir: dir });
  new Store(fs.realpathSync(dir)).saveGraph(graph);
}

export interface Harness {
  client: Client;
  root: string;
  callText: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ text: string; isError: boolean }>;
  close: () => Promise<void>;
}

/** Spawn the BUILT CLI as an MCP server and connect the SDK client to it. */
export async function connectHarness(root: string): Promise<Harness> {
  const client = new Client({ name: "archmap-e2e", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_BIN, "mcp"],
    cwd: root,
    stderr: "ignore",
  });
  await client.connect(transport);

  const callText: Harness["callText"] = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    return { text, isError: result.isError === true };
  };

  return {
    client,
    root,
    callText,
    close: async () => {
      await client.close();
    },
  };
}

export function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
