import type { Draw, Effect } from "vgpu";
import { draw, effect } from "vgpu";

import type { PrismDebugSourceId } from "../../../debug/sources";
import causticDebugWgsl from "../passes/caustic/caustic-debug.wgsl";
import causticWgsl from "../passes/caustic/caustic.wgsl";
import shadowWgsl from "../passes/shadow/shadow.wgsl";
import wallDebugWgsl from "../passes/wall/wall-debug.wgsl";
import { sceneUniforms } from "../../../runtime/uniforms";
import type { PrismRuntime } from "../../../runtime/types";
import {
  LIGHT_CAUSTIC_DEBUG_ENTRY,
  LIGHT_WALL_DEBUG_ENTRIES,
} from "./entries";
import { prismShadowUniforms } from "../passes/shadow/tuning";
import { lightCausticUniforms, lightWallUniforms } from "../uniforms";
import type { LightPipelineGraph } from "../types";

export type LightDebugDrawable = Draw | Effect;

export interface LightDebugDraws {
  readonly sources: Readonly<
    Partial<Record<PrismDebugSourceId, LightDebugDrawable>>
  >;
  readonly ranges: Readonly<
    Partial<
      Record<
        PrismDebugSourceId,
        { readonly firstVertex: number; readonly vertices: number }
      >
    >
  >;
  /** Refreshes preview-only uniform buffers from the shared runtime. */
  bind(): void;
}

/**
 * Lazily-created preview shaders. They share production helpers/resources but
 * allocate no target and never participate in L0/L1.
 */
export function createLightDebugDraws(
  runtime: PrismRuntime,
  graph: LightPipelineGraph
): LightDebugDraws {
  if (!graph.assets)
    throw new Error("prepare() must load light assets before debug previews.");
  const sources: Partial<Record<PrismDebugSourceId, LightDebugDrawable>> = {};
  const wallPreviews: Draw[] = [];
  for (const [id, fragment] of Object.entries(LIGHT_WALL_DEBUG_ENTRIES)) {
    const preview = draw(runtime.gpu, {
      shader: wallDebugWgsl,
      vertices: 6,
      depth: false,
      entry: { vertex: "vs_debug", fragment },
      label: `${runtime.label}.debug.${id}`,
    });
    wallPreviews.push(preview);
    sources[id as keyof typeof LIGHT_WALL_DEBUG_ENTRIES] = preview;
  }
  const rawCaustic = effect(runtime.gpu, causticDebugWgsl, {
    label: `${runtime.label}.debug.raw-caustic.${LIGHT_CAUSTIC_DEBUG_ENTRY}`,
  });
  rawCaustic.set({
    causticProfile: graph.assets.causticProfile,
    causticSampler: graph.materialSampler,
  });
  sources["raw-caustic"] = rawCaustic;

  const projected = draw(runtime.gpu, {
    shader: causticWgsl,
    geometry: runtime.lightGeometry,
    blend: "additive",
    depth: false,
    cull: "none",
    label: `${runtime.label}.debug.projected-caustic`,
  });
  sources["projected-caustic"] = projected;
  const prismShadow = draw(runtime.gpu, {
    shader: shadowWgsl,
    geometry: graph.prismShadowGeometry,
    depth: false,
    cull: "none",
    entry: { vertex: "vs_main", fragment: "fs_debug" },
    label: `${runtime.label}.debug.prism-cast-shadow`,
  });
  sources["prism-shadow"] = prismShadow;
  const result: LightDebugDraws = {
    sources,
    ranges: {
      "projected-caustic": {
        firstVertex: graph.lightMeshLayout.outgoingFirstVertex,
        vertices: graph.lightMeshLayout.outgoingVertices,
      },
    },
    bind() {
      const assets = graph.assets;
      if (!assets) return;
      const wallBindings = {
        params: lightWallUniforms(runtime),
        wallMaterial: assets.wallMaterial,
        wallLighting: assets.wallLighting,
        materialSampler: graph.materialSampler,
      };
      for (const preview of wallPreviews) preview.set(wallBindings);
      projected.set({
        scene: sceneUniforms(runtime, 1, graph.lightMeshLayout),
        caustic: lightCausticUniforms(runtime),
        causticProfile: assets.causticProfile,
        causticSampler: graph.materialSampler,
        wallMaterial: assets.wallMaterial,
      });
      prismShadow.set({
        shadow: prismShadowUniforms(runtime.view.viewProjection),
      });
    },
  };
  result.bind();
  return result;
}
