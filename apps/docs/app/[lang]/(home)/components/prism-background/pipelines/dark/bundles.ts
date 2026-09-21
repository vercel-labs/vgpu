import { bundle } from "vgpu";

import type { PrismRuntime } from "../../runtime/types";
import type { DarkPipelineGraph } from "./types";

/** Records the stable production backdrop. Debug variants remain direct. */
export function recordDarkBackdropBundle(
  graph: DarkPipelineGraph,
  runtime: PrismRuntime
): void {
  if (graph.backdropBundle || !graph.backgroundTarget) return;
  const light = graph.lightMeshLayout;
  graph.backdropBundle = bundle(
    runtime.gpu,
    {
      target: graph.backgroundTarget,
      label: `${runtime.label}.dark-backdrop`,
    },
    (recorded) => {
      recorded.draw(graph.light, {
        firstVertex: 0,
        vertices: light.whiteVertices,
      });
      recorded.draw(graph.light, {
        firstVertex: light.outgoingFirstVertex,
        vertices: light.outgoingVertices,
      });
      recorded.draw(graph.glassBack);
      recorded.draw(graph.light, {
        firstVertex: light.internalFirstVertex,
        vertices: light.internalVertices,
      });
    }
  );
}
