import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createArchscopeServer } from "./server.js";

export { GraphSource, type LoadedGraph, NoGraphError } from "@archscope/core";
export { type ArchscopeServerOptions, createArchscopeServer } from "./server.js";

/**
 * Serve the graph over stdio. stdout belongs to the protocol from this point
 * on — anything a human should see goes to stderr.
 */
export async function runStdioServer(rootDir: string, version?: string): Promise<void> {
  const server = createArchscopeServer({ rootDir, ...(version !== undefined ? { version } : {}) });
  await server.connect(new StdioServerTransport());
  console.error(`archscope mcp: serving ${rootDir} over stdio`);
}
