import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";

import type { PrismDebugFlowNode } from "./model";
import { NodeControls } from "./node-controls";
import { PreviewCanvas } from "./preview-canvas";

export const SourceNode = memo(function SourceNode({
  data,
}: NodeProps<PrismDebugFlowNode>) {
  const { bridge, mode, quality, source } = data;
  return (
    <article className="prism-debug-node" data-kind={source.kind}>
      <Handle
        className="prism-debug-node__handle"
        isConnectable={false}
        position={Position.Left}
        type="target"
      />
      <header>
        <strong>{source.label}</strong>
        <span>{source.kind}</span>
      </header>
      {source.visualization === "none" ? null : (
        <PreviewCanvas bridge={bridge} source={source} />
      )}
      {source.details?.length ? (
        <dl className="prism-debug-node__details">
          {source.details.map((item) => (
            <div key={`${item.label}:${item.value}`}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <NodeControls mode={mode} quality={quality} sourceId={source.id} />
      {source.visualization === "none" ? null : (
        <footer>{source.visualization}</footer>
      )}
      <Handle
        className="prism-debug-node__handle"
        isConnectable={false}
        position={Position.Right}
        type="source"
      />
    </article>
  );
});
