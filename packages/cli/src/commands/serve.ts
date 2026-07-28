import fs from "node:fs";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffGraphs,
  docsView,
  docView,
  ensureSnapshot,
  erdView,
  fileContextView,
  GraphSource,
  gitInfo,
  gitRefs,
  gitRenames,
  indexGraph,
  moduleView,
  NoGraphError,
  overviewView,
  schemaDriftView,
  searchView,
} from "@archscope/core";
import { NODE_KINDS, type NodeKind } from "@archscope/schema";
import fastifyStatic from "@fastify/static";
import chokidar from "chokidar";
import Fastify from "fastify";
import { startWatch } from "./watch.js";

/**
 * `archscope serve` is the dashboard's whole backend: static assets, a REST
 * layer that returns core/query view-models VERBATIM (the MCP server renders
 * these same objects to markdown — no consumer derives its own facts), an SSE
 * channel that announces graph updates, and the watch pipeline in-process.
 *
 * The REST layer never touches the pipeline: it reads whatever graph.json
 * says right now (GraphSource re-indexes by mtime). Watch writes, serve reads
 * — the file is the contract, exactly as with the MCP server.
 */

const SSE_HEARTBEAT_MS = 25_000;
const SSE_DEBOUNCE_MS = 100;

export async function runServe(rootDir: string, options: { port?: string }): Promise<void> {
  const port = options.port ? Number.parseInt(options.port, 10) : 4400;
  if (Number.isNaN(port)) throw new Error(`Invalid port: ${options.port}`);

  const source = new GraphSource(rootDir);
  const app = Fastify({ logger: false });

  // --- REST: one endpoint per query view, JSON verbatim ---------------------

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/api/")) reply.header("cache-control", "no-store");
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof NoGraphError) return reply.code(404).send({ error: error.message });
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Not a commit")) return reply.code(400).send({ error: message });
    return reply.code(500).send({ error: message });
  });

  app.get("/api/meta", async () => {
    const { index, staleness } = await source.load();
    const meta = index.graph.meta;
    return {
      staleness,
      root: meta.root,
      counts: meta.counts,
      toolVersion: meta.toolVersion,
      live: meta.live ?? null,
    };
  });

  app.get("/api/overview", async () => {
    const { index } = await source.load();
    return overviewView(index);
  });

  app.get<{ Querystring: { ref?: string } }>("/api/module", async (request, reply) => {
    const ref = request.query.ref;
    if (!ref) return reply.code(400).send({ error: "Missing ?ref=<module name or mod: id>" });
    const { index } = await source.load();
    const view = moduleView(index, ref);
    if (!view) return notFound(reply, index, ref);
    return view;
  });

  app.get<{ Querystring: { q?: string; kinds?: string } }>(
    "/api/search",
    async (request, reply) => {
      const q = request.query.q?.trim();
      if (!q) return reply.code(400).send({ error: "Missing ?q=<text>" });
      const kinds = request.query.kinds
        ?.split(",")
        .filter((kind): kind is NodeKind => (NODE_KINDS as readonly string[]).includes(kind));
      const { index } = await source.load();
      return searchView(index, q, kinds !== undefined && kinds.length > 0 ? kinds : undefined);
    },
  );

  app.get<{ Querystring: { ref?: string } }>("/api/file", async (request, reply) => {
    const ref = request.query.ref;
    if (!ref) return reply.code(400).send({ error: "Missing ?ref=<path or file: id>" });
    const { index } = await source.load();
    const view = fileContextView(index, ref);
    if (!view) return notFound(reply, index, ref);
    return view;
  });

  /**
   * Line range of a file — for "view source" affordances in the wiki. Only
   * paths that exist as file:/doc: nodes in the CURRENT graph are served
   * (path traversal is impossible by construction), clamped to 200 lines.
   * This displays bytes the graph already points at; it derives no facts.
   */
  app.get<{ Querystring: { path?: string; start?: string; end?: string } }>(
    "/api/source",
    async (request, reply) => {
      const relPath = request.query.path;
      if (!relPath) return reply.code(400).send({ error: "Missing ?path=" });
      const { index } = await source.load();
      const node = index.nodes.get(`file:${relPath}`) ?? index.nodes.get(`doc:${relPath}`);
      if (!node) return notFound(reply, index, relPath);
      const start = Math.max(1, Number.parseInt(request.query.start ?? "1", 10) || 1);
      const requestedEnd = Number.parseInt(request.query.end ?? "", 10) || start;
      const end = Math.min(requestedEnd, start + 199);
      let content: string;
      try {
        content = fs.readFileSync(path.join(rootDir, relPath), "utf8");
      } catch {
        return reply.code(404).send({ error: `File not on disk: ${relPath}` });
      }
      const lines = content.split(/\r?\n/).slice(start - 1, end);
      return { path: relPath, startLine: start, endLine: start + lines.length - 1, lines };
    },
  );

  app.get("/api/docs", async () => {
    const { index } = await source.load();
    return docsView(index);
  });

  app.get<{ Querystring: { ref?: string } }>("/api/doc", async (request, reply) => {
    const ref = request.query.ref;
    if (!ref) return reply.code(400).send({ error: "Missing ?ref=<path or doc: id>" });
    const { index } = await source.load();
    const view = docView(index, ref);
    if (!view) return notFound(reply, index, ref);
    return view;
  });

  app.get("/api/erd", async () => {
    const { index } = await source.load();
    return erdView(index);
  });

  app.get("/api/drift", async () => {
    const { index } = await source.load();
    return schemaDriftView(index);
  });

  app.get("/api/refs", async () => {
    const [refs, head] = await Promise.all([gitRefs(rootDir), gitInfo(rootDir)]);
    return { refs, head };
  });

  app.get<{ Querystring: { base?: string; head?: string } }>(
    "/api/diff",
    async (request, reply) => {
      const { base, head = "HEAD" } = request.query;
      if (!base) return reply.code(400).send({ error: "Missing ?base=<ref>" });
      const baseSnap = await ensureSnapshot(rootDir, base);
      const headSnap = await ensureSnapshot(rootDir, head);
      const renames = await gitRenames(rootDir, baseSnap.sha, headSnap.sha);
      const diff = diffGraphs({
        base: baseSnap.graph,
        head: headSnap.graph,
        renames,
        baseRef: { sha: baseSnap.sha, ref: base },
        headRef: { sha: headSnap.sha, ref: head },
      });
      // The overlay draws head's module graph and colors it with the diff —
      // computed here so the client never assembles structural facts itself.
      return { diff, headOverview: overviewView(indexGraph(headSnap.graph)) };
    },
  );

  // --- SSE: graph.json changed → tell every open dashboard ------------------

  const clients = new Set<ServerResponse>();
  app.get("/api/events", (request, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    reply.raw.write("retry: 1000\n\n");
    clients.add(reply.raw);
    request.raw.on("close", () => clients.delete(reply.raw));
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": ping\n\n");
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  let sseTimer: NodeJS.Timeout | null = null;
  const graphPath = path.join(rootDir, ".archscope", "graph.json");
  chokidar.watch(graphPath, { ignoreInitial: true }).on("all", () => {
    if (sseTimer) clearTimeout(sseTimer);
    sseTimer = setTimeout(() => {
      const message = `event: graph-updated\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
      for (const client of clients) client.write(message);
    }, SSE_DEBOUNCE_MS);
  });

  // --- Static dashboard ------------------------------------------------------

  const dashboardDist = resolveDashboardDist();
  if (dashboardDist) {
    await app.register(fastifyStatic, { root: dashboardDist });
  } else {
    console.error("archscope serve: dashboard assets not found — API only (build the monorepo).");
  }

  await app.listen({ port, host: "127.0.0.1" });
  console.log(`archscope serve → http://localhost:${port}  (API under /api, Ctrl-C to stop)`);

  // Watch last: the initial analyze can take a moment on big repos, and the
  // API is already useful with the existing graph while it runs.
  try {
    await startWatch(rootDir);
  } catch (error) {
    console.error(
      `archscope serve: watch failed (${error instanceof Error ? error.message : error}) — ` +
        "serving the existing graph without re-analysis.",
    );
  }
}

// ---------------------------------------------------------------------------

function notFound(
  reply: { code: (n: number) => { send: (body: unknown) => unknown } },
  index: Parameters<typeof searchView>[0],
  ref: string,
): unknown {
  const lastSegment = ref.split("/").pop()?.split("#").pop() ?? ref;
  const suggestions = searchView(index, lastSegment).results.slice(0, 3);
  return reply.code(404).send({ error: `Not found: ${ref}`, suggestions });
}

/**
 * Monorepo dev: resolve @archscope/dashboard's dist through the workspace.
 * Published package: the build copies that dist into <pkg>/dashboard, next to
 * the bundled dist/ (see tsup.config.ts) — @archscope/* never ships to npm.
 */
function resolveDashboardDist(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@archscope/dashboard/package.json");
    const dist = path.join(path.dirname(pkgJson), "dist");
    if (fs.existsSync(path.join(dist, "index.html"))) return dist;
  } catch {
    // not installed as a package — fall through to the bundled copy
  }
  const bundled = fileURLToPath(new URL("../dashboard", import.meta.url));
  return fs.existsSync(path.join(bundled, "index.html")) ? bundled : null;
}
