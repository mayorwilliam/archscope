import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createArchmapServer } from "./server.js";

export { GraphSource, type LoadedGraph, NoGraphError } from "./graph-source.js";
export { type ArchmapServerOptions, createArchmapServer } from "./server.js";

/**
 * Serve the graph over stdio. stdout belongs to the protocol from this point
 * on — anything a human should see goes to stderr.
 */
export async function runStdioServer(rootDir: string, version?: string): Promise<void> {
  const server = createArchmapServer({ rootDir, ...(version !== undefined ? { version } : {}) });
  await server.connect(new StdioServerTransport());
  console.error(`archmap mcp: serving ${rootDir} over stdio`);
}
