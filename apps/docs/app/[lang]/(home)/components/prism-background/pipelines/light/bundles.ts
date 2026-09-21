import { bundle } from "vgpu";

import type { PrismRuntime } from "../../runtime/types";
import type { LightPipelineGraph } from "./types";

/** Pass L0 has stable draw/bind identities and is replayed as one bundle. */
export function recordLightBackdropBundle(
  graph: LightPipelineGraph,
  runtime: PrismRuntime
): void {
  if (graph.backdropBundle || !graph.backdropHDR) return;
  const light = graph.lightMeshLayout;
  graph.backdropBundle = bundle(
    runtime.gpu,
    {
      target: graph.backdropHDR,
      label: `${runtime.label}.light.backdrop-bundle`,
    },
    (recorded) => {
      recorded.draw(graph.wall);
      recorded.draw(graph.prismShadow);
      recorded.draw(graph.caustic, {
        firstVertex: 0,
        vertices: light.whiteVertices,
      });
      recorded.draw(graph.caustic, {
        firstVertex: light.outgoingFirstVertex,
        vertices: light.outgoingVertices,
      });
      recorded.draw(graph.glassBack);
      recorded.draw(graph.caustic, {
        firstVertex: light.internalFirstVertex,
        vertices: light.internalVertices,
      });
    }
  );
}
