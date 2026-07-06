/**
 * PageRank over the file-import graph, precomputed at analyze time so
 * query-time ranking is O(sort). Hand-rolled power iteration (~30 lines)
 * instead of a graph library: deterministic, dependency-free, and the only
 * graph algorithm v1 needs.
 */

export interface RankInput {
  nodes: string[];
  /** Directed edges [from, to] — "from imports to". */
  edges: Array<[string, string]>;
}

const DAMPING = 0.85;
const ITERATIONS = 30;

export function pageRank(input: RankInput): Map<string, number> {
  const { nodes, edges } = input;
  const n = nodes.length;
  const ranks = new Map<string, number>();
  if (n === 0) return ranks;

  const index = new Map(nodes.map((id, i) => [id, i]));
  const outDegree = new Array<number>(n).fill(0);
  const incoming: number[][] = Array.from({ length: n }, () => []);

  for (const [from, to] of edges) {
    const fi = index.get(from);
    const ti = index.get(to);
    if (fi === undefined || ti === undefined) continue;
    outDegree[fi] = (outDegree[fi] ?? 0) + 1;
    (incoming[ti] as number[]).push(fi);
  }

  let rank = new Array<number>(n).fill(1 / n);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const next = new Array<number>(n).fill((1 - DAMPING) / n);
    // Dangling nodes (no outgoing edges) distribute rank uniformly.
    let danglingSum = 0;
    for (let i = 0; i < n; i++) {
      if ((outDegree[i] ?? 0) === 0) danglingSum += rank[i] as number;
    }
    const danglingShare = (DAMPING * danglingSum) / n;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const from of incoming[i] as number[]) {
        sum += (rank[from] as number) / (outDegree[from] as number);
      }
      next[i] = (next[i] as number) + DAMPING * sum + danglingShare;
    }
    rank = next;
  }

  for (let i = 0; i < n; i++) {
    // Round to keep graph.json diffs stable across float noise.
    ranks.set(nodes[i] as string, Number((rank[i] as number).toFixed(6)));
  }
  return ranks;
}
