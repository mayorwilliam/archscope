import type { Edge, Node } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { applyFocus } from "../src/graph/focus";
import type { LaidOutFlow } from "../src/layout/useElkLayout";

/** Minimal laid-out flow: a group with two files, plus an outsider. */

const node = (id: string, parentId?: string): Node => ({
  id,
  position: { x: 0, y: 0 },
  data: {},
  ...(parentId !== undefined ? { parentId } : {}),
});

const edge = (id: string, source: string, target: string, className?: string): Edge => ({
  id,
  source,
  target,
  ...(className !== undefined ? { className } : {}),
});

const flow: LaidOutFlow = {
  nodes: [
    node("mod:server"),
    node("file:a.ts", "mod:server"),
    node("file:b.ts", "mod:server"),
    node("mod:ui"),
  ],
  edges: [
    edge("e1", "file:a.ts", "file:b.ts", "edge-internal"),
    edge("e2", "mod:server", "mod:ui"),
  ],
  version: 7,
};

describe("applyFocus", () => {
  it("without focus returns the flow untouched", () => {
    expect(applyFocus(flow, null)).toBe(flow);
  });

  it("with an id absent from the layout returns the flow untouched", () => {
    expect(applyFocus(flow, "file:ghost.ts")).toBe(flow);
  });

  it("lights the focused node, its neighbors and incident edges; dims the rest", () => {
    const result = applyFocus(flow, "file:a.ts");
    const byId = new Map(result.nodes.map((n) => [n.id, n.className]));

    expect(byId.get("file:a.ts")).toBe("node-focus");
    expect(byId.get("file:b.ts")).toBe("node-kept");
    expect(byId.get("mod:ui")).toBe("node-dim");

    const incident = result.edges.find((e) => e.id === "e1");
    const other = result.edges.find((e) => e.id === "e2");
    expect(incident?.className).toBe("edge-internal edge-focus");
    expect(other?.className).toBe("edge-dim");
  });

  it("keeps the container of a lit child visible", () => {
    const result = applyFocus(flow, "file:a.ts");
    const group = result.nodes.find((n) => n.id === "mod:server");
    expect(group?.className).toBe("node-kept");
  });

  it("never touches positions or version", () => {
    const result = applyFocus(flow, "file:a.ts");
    expect(result.version).toBe(flow.version);
    expect(result.nodes.map((n) => n.position)).toEqual(flow.nodes.map((n) => n.position));
  });
});
