import type { Target } from "vgpu";
import { target } from "vgpu";

import type { PrismRuntime } from "../../runtime/types";
import type { LightPipelineGraph } from "./types";

export const LIGHT_TARGET_COUNT = 2;

export function ensureLightTargets(
  graph: LightPipelineGraph,
  runtime: PrismRuntime,
  size: readonly [number, number]
): void {
  graph.backdropHDR ??= createTarget(runtime, size, "backdrop-hdr", false);
  graph.sceneHDR ??= createTarget(runtime, size, "scene-hdr", true);
  resizeLightTargets(graph, size);
}

function createTarget(
  runtime: PrismRuntime,
  size: readonly [number, number],
  name: string,
  multisampled: boolean
): Target {
  return target(runtime.gpu, {
    size,
    format: "rgba16float",
    msaa:
      multisampled && !runtime.gpu.device.isCompatibilityMode ? 4 : undefined,
    label: `${runtime.label}.light.${name}`,
  });
}

export function resizeLightTargets(
  graph: LightPipelineGraph,
  size: readonly [number, number]
): void {
  graph.backdropHDR?.resize(size);
  graph.sceneHDR?.resize(size);
}

function destroyTarget(value: Target | undefined): void {
  (value as (Target & { destroy?: () => void }) | undefined)?.destroy?.();
}

export function destroyLightTargets(graph: LightPipelineGraph): void {
  destroyTarget(graph.backdropHDR);
  destroyTarget(graph.sceneHDR);
  graph.backdropHDR = undefined;
  graph.sceneHDR = undefined;
  graph.backdropBundle = undefined;
}
