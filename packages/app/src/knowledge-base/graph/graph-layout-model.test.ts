import { describe, expect, it } from "vitest";
import type {
  KnowledgeBaseGraphEdge,
  KnowledgeBaseGraphNode,
} from "@getpaseo/protocol/knowledge-base/rpc-schemas";
import { layoutKnowledgeGraph } from "./graph-layout-model";

function node(
  path: string,
  overrides: Partial<KnowledgeBaseGraphNode> = {},
): KnowledgeBaseGraphNode {
  return {
    path,
    permalink: path.replace(/\.md$/, ""),
    title: path,
    noteType: "project",
    linkCount: 0,
    ...overrides,
  };
}

const NODES: KnowledgeBaseGraphNode[] = [
  node("inbox.md", { noteType: "inbox" }),
  node("projects/checkout-redesign.md"),
  node("projects/on-site-recording.md"),
  node("scratch/ideas.md", { noteType: "note" }),
];
const EDGES: KnowledgeBaseGraphEdge[] = [
  { source: "projects/checkout-redesign.md", target: "projects/on-site-recording.md" },
  { source: "projects/on-site-recording.md", target: "scratch/ideas.md" },
];

describe("layoutKnowledgeGraph", () => {
  it("lays out the same graph the same way on every run", () => {
    const first = layoutKnowledgeGraph(NODES, EDGES);
    const second = layoutKnowledgeGraph(NODES, EDGES);
    expect(second).toEqual(first);
  });

  it("positions every input node and keeps its edges", () => {
    const layout = layoutKnowledgeGraph(NODES, EDGES);
    expect(layout.nodes.map((n) => n.path).sort()).toEqual(NODES.map((n) => n.path).sort());
    expect(layout.edges).toEqual(EDGES);
    for (const laidOut of layout.nodes) {
      expect(Number.isFinite(laidOut.x)).toBe(true);
      expect(Number.isFinite(laidOut.y)).toBe(true);
    }
  });

  it("drops an edge naming a node absent from the graph", () => {
    const dangling: KnowledgeBaseGraphEdge[] = [
      ...EDGES,
      { source: "projects/checkout-redesign.md", target: "projects/does-not-exist.md" },
    ];
    const layout = layoutKnowledgeGraph(NODES, dangling);
    expect(layout.edges).toEqual(EDGES);
    expect(layout.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("lays out an empty graph without NaN", () => {
    const layout = layoutKnowledgeGraph([], []);
    expect(layout.nodes).toEqual([]);
    expect(Number.isFinite(layout.width)).toBe(true);
    expect(Number.isFinite(layout.height)).toBe(true);
  });

  it("lays out a single node without NaN, centred in the canvas", () => {
    const layout = layoutKnowledgeGraph([node("projects/solo.md")], []);
    expect(layout.nodes).toHaveLength(1);
    const [only] = layout.nodes;
    expect(Number.isFinite(only.x)).toBe(true);
    expect(Number.isFinite(only.y)).toBe(true);
    expect(only.x).toBeGreaterThan(0);
    expect(only.y).toBeGreaterThan(0);
  });

  it("keeps every node within the reported canvas bounds", () => {
    const layout = layoutKnowledgeGraph(NODES, EDGES);
    for (const laidOut of layout.nodes) {
      expect(laidOut.x).toBeGreaterThanOrEqual(0);
      expect(laidOut.x).toBeLessThanOrEqual(layout.width);
      expect(laidOut.y).toBeGreaterThanOrEqual(0);
      expect(laidOut.y).toBeLessThanOrEqual(layout.height);
    }
  });
});
