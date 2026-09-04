import type { Edge, Node } from "@xyflow/react";

import type {
  PrismDebugSource,
  PrismPipelineMode,
  PrismPipelineQuality,
} from "../../pipelines/types";
import type { PrismDebugPreviewBridge } from "../preview-bridge";
import { controlGroupsForSource } from "./control-schema";

export type PrismDebugNodeData = {
  readonly bridge: PrismDebugPreviewBridge;
  readonly mode: PrismPipelineMode;
  readonly quality: PrismPipelineQuality;
  readonly source: PrismDebugSource;
};

export type PrismDebugFlowNode = Node<PrismDebugNodeData, "prismDebug">;
export type PrismDebugEdgeData = Record<string, never>;
export type PrismDebugFlowEdge = Edge<PrismDebugEdgeData, "prismDebug">;

export type PrismDebugGraphModel = {
  readonly nodes: PrismDebugFlowNode[];
  readonly edges: PrismDebugFlowEdge[];
};

const NODE_GAP = 64;
const COLUMN_GAP = 460;
const PREVIEW_NODE_HEIGHT = 224;
const NON_PREVIEW_NODE_HEIGHT = 70;
const CONTROL_ROW_HEIGHT = 48;
const CONTROL_GROUP_HEIGHT = 34;
const CONTROL_PREVIEW_HEIGHT = 112;
const DETAIL_ROW_HEIGHT = 25;
const DETAIL_BLOCK_PADDING = 14;

/** Builds a deterministic left-to-right layout without React-owned graph state. */
export function createDebugGraphModel(
  sources: readonly PrismDebugSource[],
  bridge: PrismDebugPreviewBridge,
  mode: PrismPipelineMode,
  quality: PrismPipelineQuality = "high"
): PrismDebugGraphModel {
  const knownIds = new Set(sources.map(({ id }) => id));
  const depthOf = createDepthResolver(sources);
  const nextYByDepth = new Map<number, number>();

  const nodes = sources.map<PrismDebugFlowNode>((source) => {
    const depth = depthOf(source.id);
    const y = nextYByDepth.get(depth) ?? 0;
    nextYByDepth.set(
      depth,
      y + estimatedNodeHeight(source, mode, quality) + NODE_GAP
    );
    return {
      id: source.id,
      type: "prismDebug",
      position: { x: depth * COLUMN_GAP, y },
      data: { bridge, mode, quality, source },
      draggable: false,
      selectable: false,
      // XYFlow disables pointer hit-testing when a node is neither draggable
      // nor selectable. Keep the node interactive so its `nopan` controls can
      // receive the gesture without making the node itself draggable.
      style: { pointerEvents: "all" },
    };
  });

  const edges = sources.flatMap<PrismDebugFlowEdge>((target) =>
    target.inputs.flatMap((dependency, index) =>
      knownIds.has(dependency.source)
        ? [
            {
              id: `${dependency.source}:${target.id}:${index}`,
              source: dependency.source,
              target: target.id,
              type: "prismDebug",
              label: dependency.operation,
              labelBgPadding: [6, 3],
              labelBgBorderRadius: 4,
              selectable: false,
            },
          ]
        : []
    )
  );

  return { nodes, edges };
}

export function estimatedNodeHeight(
  source: PrismDebugSource,
  mode: PrismPipelineMode,
  quality: PrismPipelineQuality = "high"
): number {
  const groups = controlGroupsForSource(source.id, mode, quality);
  const controlCount = groups.reduce(
    (count, group) => count + group.controls.length,
    0
  );
  const previewCount = groups.reduce(
    (count, group) => count + (group.preview ? 1 : 0),
    0
  );
  return (
    (source.visualization === "none"
      ? NON_PREVIEW_NODE_HEIGHT
      : PREVIEW_NODE_HEIGHT) +
    groups.length * CONTROL_GROUP_HEIGHT +
    previewCount * CONTROL_PREVIEW_HEIGHT +
    controlCount * CONTROL_ROW_HEIGHT +
    (source.details?.length
      ? DETAIL_BLOCK_PADDING + source.details.length * DETAIL_ROW_HEIGHT
      : 0)
  );
}

function createDepthResolver(sources: readonly PrismDebugSource[]) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const depths = new Map<string, number>();
  const resolving = new Set<string>();

  const depthOf = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (resolving.has(id)) return 0;

    const source = sourceById.get(id);
    if (!source || source.inputs.length === 0) return 0;

    resolving.add(id);
    let depth = 0;
    for (const input of source.inputs) {
      if (!sourceById.has(input.source)) continue;
      depth = Math.max(depth, depthOf(input.source) + 1);
    }
    resolving.delete(id);
    depths.set(id, depth);
    return depth;
  };

  return depthOf;
}
