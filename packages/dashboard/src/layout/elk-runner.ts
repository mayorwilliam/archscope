import type { ElkNode } from "elkjs/lib/elk-api";
import ELK from "elkjs/lib/elk-api.js";
// Vite's ?worker turns elk's own worker script into a constructor — layout
// runs off the main thread with elkjs's stock plumbing, no custom bridge.
import ElkWorker from "elkjs/lib/elk-worker.min.js?worker";

/**
 * Kept apart from the pure builders in layout.ts on purpose: this module
 * touches Worker and Vite-specific imports, so unit tests never load it.
 */

let elk: InstanceType<typeof ELK> | null = null;

export function elkLayout(graph: ElkNode): Promise<ElkNode> {
  if (!elk) elk = new ELK({ workerFactory: () => new ElkWorker() });
  return elk.layout(graph);
}
