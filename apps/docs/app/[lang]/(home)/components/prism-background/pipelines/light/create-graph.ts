import { draw, effect, sampler } from "vgpu";

import copyLinearWgsl from "../shared/presentation/copy-linear.wgsl";
import glassBackWgsl from "../shared/glass/glass-back.wgsl";
import glassWgsl from "../shared/glass/glass.wgsl";
import lightWireframeWgsl from "../shared/spectral/light-wireframe.wgsl";
import causticWgsl from "./passes/caustic/caustic.wgsl";
import glassAccentWgsl from "./passes/glass-accent/glass-accent.wgsl";
import presentWgsl from "./passes/presentation/present.wgsl";
import shadowWgsl from "./passes/shadow/shadow.wgsl";
import wallLowWgsl from "./passes/wall/wall-low.wgsl";
import wallWgsl from "./passes/wall/wall.wgsl";
import { ensurePrismWireframeGeometry } from "../../runtime/resources";
import type { PrismRuntime } from "../../runtime/types";
import { lightMeshLayoutForQuality } from "../quality";
import type { PrismPipelineQuality } from "../types";
import wireframeWgsl from "../shared/wireframe/wireframe.wgsl";
import { createPrismShadowGeometry } from "./passes/shadow/tuning";
import type { LightPipelineGraph } from "./types";

export function createLightGraph(
  runtime: PrismRuntime,
  quality: PrismPipelineQuality = "high"
): LightPipelineGraph {
  const { gpu, label } = runtime;
  const lightMeshLayout = lightMeshLayoutForQuality(quality);
  const prismShadowGeometry = createPrismShadowGeometry(
    gpu,
    `${label}.light.prism-shadow-geometry`
  );
  return {
    quality,
    lightMeshLayout,
    simplifiedWall: quality === "low",
    wall: draw(gpu, {
      shader: quality === "low" ? wallLowWgsl : wallWgsl,
      vertices: 6,
      cull: "back",
      depth: false,
      label: `${label}.light.wall`,
    }),
    prismShadowGeometry,
    prismShadow: draw(gpu, {
      shader: shadowWgsl,
      geometry: prismShadowGeometry,
      blend: "premultiplied",
      cull: "none",
      depth: false,
      label: `${label}.light.prism-cast-shadow`,
    }),
    caustic: draw(gpu, {
      shader: causticWgsl,
      geometry: runtime.lightGeometry,
      blend: "additive",
      cull: "none",
      depth: false,
      label: `${label}.light.projected-caustic`,
    }),
    glassBack: draw(gpu, {
      shader: glassBackWgsl,
      geometry: runtime.prism,
      cull: "front",
      depth: false,
      blend: "premultiplied",
      label: `${label}.light.glass-back`,
    }),
    copyBackdrop: effect(gpu, copyLinearWgsl, {
      label: `${label}.light.copy-backdrop`,
    }),
    glassFront: draw(gpu, {
      shader: glassWgsl,
      geometry: runtime.prism,
      cull: "back",
      depth: false,
      label: `${label}.light.glass-front`,
    }),
    glassAccent: draw(gpu, {
      shader: glassAccentWgsl,
      geometry: runtime.prism,
      cull: "back",
      depth: false,
      blend: "premultiplied",
      label: `${label}.light.glass-accent`,
    }),
    present: effect(gpu, presentWgsl, {
      label: `${label}.light.present`,
    }),
    materialSampler: sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      // Material coordinates are world-space and intentionally repeat. Shadow
      // lookups clamp their UVs explicitly before sharing this sampler.
      addressModeU: "repeat",
      addressModeV: "repeat",
    }),
  };
}

/** Creates debug-only draws when their controls are first enabled. */
export function ensureLightWireframeDraws(
  graph: LightPipelineGraph,
  runtime: PrismRuntime
): void {
  const { gpu, label } = runtime;
  if (runtime.controls.wireframe && !graph.wireframe) {
    graph.wireframe = draw(gpu, {
      shader: wireframeWgsl,
      geometry: ensurePrismWireframeGeometry(runtime),
      cull: "none",
      depth: false,
      blend: "premultiplied",
      label: `${label}.light.wireframe`,
    });
  }
  if (runtime.controls.lightWireframe && !graph.lightWireframe) {
    graph.lightWireframe = draw(gpu, {
      shader: lightWireframeWgsl,
      geometry: runtime.lightGeometry,
      cull: "none",
      depth: false,
      blend: "premultiplied",
      label: `${label}.light.light-wireframe`,
    });
  }
}
