import { draw, effect } from "vgpu";

import bloomBlurPairedWgsl from "./passes/bloom/bloom-blur-paired.wgsl";
import bloomBlurWgsl from "./passes/bloom/bloom-blur.wgsl";
import bloomCompositeLowWgsl from "./passes/bloom/bloom-composite-low.wgsl";
import bloomCompositeWgsl from "./passes/bloom/bloom-composite.wgsl";
import bloomExtractWgsl from "./passes/bloom/bloom-extract.wgsl";
import { BLOOM_BLUR_SAMPLING } from "./passes/bloom/pairing";
import copyLinearWgsl from "../shared/presentation/copy-linear.wgsl";
import dustWgsl from "./passes/particles/dust.wgsl";
import glassBackWgsl from "../shared/glass/glass-back.wgsl";
import glassWgsl from "../shared/glass/glass.wgsl";
import lightWgsl from "./passes/light/light.wgsl";
import lightWireframeWgsl from "../shared/spectral/light-wireframe.wgsl";
import particleLightDownsampleWgsl from "./passes/particles/particle-light-downsample.wgsl";
import presentWgsl from "./passes/presentation/present.wgsl";
import { ensurePrismWireframeGeometry } from "../../runtime/resources";
import type { PrismRuntime } from "../../runtime/types";
import wireframeWgsl from "../shared/wireframe/wireframe.wgsl";
import {
  darkBloomLevelCountForQuality,
  darkBloomVisibleLevelsForQuality,
  lightMeshLayoutForQuality,
} from "../quality";
import type { PrismPipelineQuality } from "../types";
import copyPresentationWgsl from "./passes/presentation/copy-presentation.wgsl";
import type { BloomBlurEffects, DarkPipelineGraph } from "./types";

export const DUST_PARTICLE_COUNT = 2200;

export function createDarkGraph(
  runtime: PrismRuntime,
  quality: PrismPipelineQuality = "high"
): DarkPipelineGraph {
  const { gpu, label } = runtime;
  const bloomLevelCount = darkBloomLevelCountForQuality(quality);
  // Keep construction order stable: renderer lifecycle tests also assert this
  // inventory, making accidental dark graph changes explicit.
  const light = draw(gpu, {
    shader: lightWgsl,
    geometry: runtime.lightGeometry,
    blend: "additive",
    cull: "none",
    depth: false,
    label: `${label}.light`,
  });
  const copyBackground = effect(gpu, copyLinearWgsl, {
    label: `${label}.pass-b-copy-a`,
  });
  const bloomExtract = effect(gpu, bloomExtractWgsl, {
    label: `${label}.bloom-extract`,
  });
  const bloomBlur = Array.from({ length: bloomLevelCount }, (_, level) => {
    const sampling = BLOOM_BLUR_SAMPLING[level]!;
    return {
      horizontal: effect(
        gpu,
        sampling.horizontal === "bilinear-pairs"
          ? bloomBlurPairedWgsl
          : bloomBlurWgsl,
        { label: `${label}.bloom-${level}-horizontal` }
      ),
      vertical: effect(
        gpu,
        sampling.vertical === "bilinear-pairs"
          ? bloomBlurPairedWgsl
          : bloomBlurWgsl,
        { label: `${label}.bloom-${level}-vertical` }
      ),
    };
  }) as unknown as BloomBlurEffects;
  const bloomComposite = effect(
    gpu,
    quality === "low" ? bloomCompositeLowWgsl : bloomCompositeWgsl,
    { label: `${label}.bloom-composite` }
  );
  const particleLightDownsample =
    quality === "high"
      ? effect(gpu, particleLightDownsampleWgsl, {
          label: `${label}.particle-light-downsample`,
        })
      : undefined;
  const present = effect(gpu, presentWgsl, { label: `${label}.present` });
  const copyPresentation = effect(gpu, copyPresentationWgsl, {
    label: `${label}.copy-presentation`,
  });
  const glassBack = draw(gpu, {
    shader: glassBackWgsl,
    geometry: runtime.prism,
    cull: "front",
    depth: false,
    blend: "premultiplied",
    label: `${label}.glass-back`,
  });
  const glassFront = draw(gpu, {
    shader: glassWgsl,
    geometry: runtime.prism,
    cull: "back",
    depth: false,
    label: `${label}.glass-front`,
  });
  const dust = draw(gpu, {
    shader: dustWgsl,
    vertices: 6,
    instances: DUST_PARTICLE_COUNT,
    cull: "none",
    depth: false,
    blend: "additive",
    label: `${label}.dust`,
  });

  return {
    quality,
    lightMeshLayout: lightMeshLayoutForQuality(quality),
    bloomVisibleLevels: darkBloomVisibleLevelsForQuality(quality),
    dedicatedParticleLight: quality === "high",
    light,
    copyBackground,
    bloomExtract,
    bloomBlur,
    bloomComposite,
    particleLightDownsample,
    present,
    copyPresentation,
    glassBack,
    glassFront,
    dust,
  };
}

/** Creates debug-only draws when their controls are first enabled. */
export function ensureDarkWireframeDraws(
  graph: DarkPipelineGraph,
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
      label: `${label}.wireframe`,
    });
  }
  if (runtime.controls.lightWireframe && !graph.lightWireframe) {
    graph.lightWireframe = draw(gpu, {
      shader: lightWireframeWgsl,
      geometry: runtime.lightGeometry,
      cull: "none",
      depth: false,
      blend: "premultiplied",
      label: `${label}.light-wireframe`,
    });
  }
}
