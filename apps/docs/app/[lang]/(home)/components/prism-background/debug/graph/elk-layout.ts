import ELK, {
  type ElkExtendedEdge,
  type ElkNode,
} from "elkjs/lib/elk.bundled.js";

import { estimatedNodeHeight, type PrismDebugGraphModel } from "./model";

const elk = new ELK();
const NODE_WIDTH = 280;

const LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.padding": "[top=24,left=24,bottom=24,right=24]",
  "elk.spacing.nodeNode": "36",
  "elk.spacing.edgeNode": "20",
  "elk.spacing.edgeEdge": "12",
  "elk.spacing.edgeLabel": "10",
  "elk.layered.spacing.nodeNodeBetweenLayers": "50",
  "elk.layered.spacing.edgeNodeBetweenLayers": "24",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "14",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.nodePlacement.favorStraightEdges": "true",
} as const;

/** Uses ELK's full graph knowledge to place nodes and route around them. */
export async function layoutDebugGraphModel(
  model: PrismDebugGraphModel
): Promise<PrismDebugGraphModel> {
  const graph = await elk.layout({
    id: "prism-debug-root",
    layoutOptions: LAYOUT_OPTIONS,
    children: model.nodes.map<ElkNode>((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: estimatedNodeHeight(
        node.data.source,
        node.data.mode,
        node.data.quality
      ),
    })),
    edges: model.edges.map<ElkExtendedEdge>((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
      labels: edge.label
        ? [
            {
              id: `${edge.id}:label`,
              text: String(edge.label),
              width: estimateLabelWidth(String(edge.label)),
              height: 18,
            },
          ]
        : undefined,
    })),
  });

  const layoutNodes = new Map(
    graph.children?.map((node) => [node.id, node]) ?? []
  );
  return {
    nodes: model.nodes.map((node) => {
      const layout = layoutNodes.get(node.id);
      return layout
        ? {
            ...node,
            position: { x: layout.x ?? 0, y: layout.y ?? 0 },
          }
        : node;
    }),
    // React Flow measures the real nodes and connects their handles. ELK's
    // estimated edge endpoints are deliberately discarded.
    edges: model.edges,
  };
}

function estimateLabelWidth(label: string): number {
  return Math.max(36, label.length * 5.8 + 12);
}
