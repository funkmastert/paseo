import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type {
  KnowledgeBaseGraphEdge,
  KnowledgeBaseGraphNode,
} from "@getpaseo/protocol/knowledge-base/rpc-schemas";

/**
 * A static force layout (KTD-11, U9): fixed seed and iteration count so the same graph lays out
 * the same way every run. d3-force never calls `Math.random()` on its own — nodes without an
 * initial position are placed on a golden-angle spiral keyed by array index — so determinism only
 * needs a stable node order (sorted by path here) and ticking a fixed number of times instead of
 * letting the simulation run its own timer.
 */
const ITERATIONS = 300;
const LINK_DISTANCE = 120;
const CHARGE_STRENGTH = -220;
const NODE_RADIUS = 10;
/** Collision radius: half the 44pt minimum touch target, so laid-out nodes never overlap it. */
const COLLIDE_RADIUS = 22;
const PADDING = COLLIDE_RADIUS + 8;
/** The canvas for an empty or single-node graph, so the viewport always has a sane fit size. */
const MIN_CANVAS_SIZE = COLLIDE_RADIUS * 2 + PADDING * 2;

export interface KnowledgeGraphPositionedNode extends KnowledgeBaseGraphNode {
  x: number;
  y: number;
}

export interface KnowledgeGraphLayout {
  nodes: readonly KnowledgeGraphPositionedNode[];
  edges: readonly KnowledgeBaseGraphEdge[];
  width: number;
  height: number;
}

type SimNode = KnowledgeBaseGraphNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode>;

/**
 * Lays out `nodes` and `edges` deterministically. An edge naming a path absent from `nodes` is
 * dropped rather than left to throw partway through the simulation.
 */
export function layoutKnowledgeGraph(
  nodes: readonly KnowledgeBaseGraphNode[],
  edges: readonly KnowledgeBaseGraphEdge[],
): KnowledgeGraphLayout {
  if (nodes.length === 0) {
    return { nodes: [], edges: [], width: MIN_CANVAS_SIZE, height: MIN_CANVAS_SIZE };
  }
  const sorted = [...nodes].sort((a, b) => a.path.localeCompare(b.path));
  const knownPaths = new Set(sorted.map((node) => node.path));
  const resolvedEdges = edges.filter(
    (edge) => knownPaths.has(edge.source) && knownPaths.has(edge.target),
  );
  const simNodes: SimNode[] = sorted.map((node) => Object.assign({}, node));
  const simLinks: SimLink[] = resolvedEdges.map((edge) => ({
    source: edge.source,
    target: edge.target,
  }));

  const simulation = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(simLinks)
        .id((node) => node.path)
        .distance(LINK_DISTANCE),
    )
    .force("charge", forceManyBody().strength(CHARGE_STRENGTH))
    .force("collide", forceCollide<SimNode>(COLLIDE_RADIUS))
    .force("center", forceCenter(0, 0))
    .stop();
  simulation.tick(ITERATIONS);

  for (const node of simNodes) {
    if (!Number.isFinite(node.x)) node.x = 0;
    if (!Number.isFinite(node.y)) node.y = 0;
  }
  const positioned = simNodes as KnowledgeGraphPositionedNode[];
  const { width, height, nodes: shifted } = fitToCanvas(positioned);
  return { nodes: shifted, edges: resolvedEdges, width, height };
}

function fitToCanvas(nodes: readonly KnowledgeGraphPositionedNode[]): {
  nodes: KnowledgeGraphPositionedNode[];
  width: number;
  height: number;
} {
  if (nodes.length === 1) {
    const [only] = nodes;
    return {
      nodes: [{ ...only, x: MIN_CANVAS_SIZE / 2, y: MIN_CANVAS_SIZE / 2 }],
      width: MIN_CANVAS_SIZE,
      height: MIN_CANVAS_SIZE,
    };
  }
  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxY = Math.max(...nodes.map((node) => node.y));
  const width = Math.max(MIN_CANVAS_SIZE, maxX - minX + PADDING * 2);
  const height = Math.max(MIN_CANVAS_SIZE, maxY - minY + PADDING * 2);
  const offsetX = PADDING - minX + (width - (maxX - minX + PADDING * 2)) / 2;
  const offsetY = PADDING - minY + (height - (maxY - minY + PADDING * 2)) / 2;
  return {
    nodes: nodes.map((node) =>
      Object.assign({}, node, { x: node.x + offsetX, y: node.y + offsetY }),
    ),
    width,
    height,
  };
}

export const __private__ = { NODE_RADIUS, COLLIDE_RADIUS, MIN_CANVAS_SIZE };
