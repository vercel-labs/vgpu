import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

import type { PrismDebugFlowEdge } from "./model";

export function ElkEdge(props: EdgeProps<PrismDebugFlowEdge>) {
  // React Flow owns the handle coordinates after it measures each rendered
  // node. ELK only places nodes; using its estimated edge endpoints here makes
  // lines miss handles whenever previews, details, or controls change height.
  const [path, labelX, labelY] = getSmoothStepPath(props);
  return (
    <BaseEdge
      id={props.id}
      interactionWidth={props.interactionWidth}
      label={props.label}
      labelBgBorderRadius={props.labelBgBorderRadius}
      labelBgPadding={props.labelBgPadding}
      labelBgStyle={props.labelBgStyle}
      labelShowBg={props.labelShowBg}
      labelStyle={props.labelStyle}
      labelX={labelX}
      labelY={labelY}
      markerEnd={props.markerEnd}
      markerStart={props.markerStart}
      path={path}
      style={props.style}
    />
  );
}
