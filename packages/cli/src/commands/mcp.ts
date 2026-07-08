import { runStdioServer } from "@archmap/mcp";

/** stdout is the MCP transport — never print to it here. */
export async function runMcp(rootDir: string): Promise<void> {
  await runStdioServer(rootDir);
}
