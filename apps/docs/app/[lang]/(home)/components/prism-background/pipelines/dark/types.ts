import type { Bundle, Draw, Effect, Target } from "vgpu";

import type { LightMeshLayout } from "../../scene/light-mesh";
import type { PrismPipelineQuality } from "../types";

export interface BloomLevelTargets {
  readonly horizontal: Target;
  readonly vertical: Target;
}

export interface BloomLevelEffects {
  readonly horizontal: Effect;
  readonly vertical: Effect;
}

export type BloomTargets = readonly BloomLevelTargets[];

export type BloomBlurEffects = readonly BloomLevelEffects[];

/** Dark-only draws, postprocess effects, and render targets. */
export interface DarkPipelineGraph {
  readonly quality: PrismPipelineQuality;
  readonly lightMeshLayout: LightMeshLayout;
  readonly bloomVisibleLevels: number;
  readonly dedicatedParticleLight: boolean;
  readonly light: Draw;
  lightWireframe?: Draw;
  readonly dust: Draw;
  readonly copyBackground: Effect;
  readonly bloomExtract: Effect;
  readonly bloomBlur: BloomBlurEffects;
  readonly bloomComposite: Effect;
  readonly particleLightDownsample?: Effect;
  readonly present: Effect;
  readonly copyPresentation: Effect;
  readonly glassBack: Draw;
  readonly glassFront: Draw;
  wireframe?: Draw;
  backdropBundle?: Bundle;
  backgroundTarget?: Target;
  sceneTarget?: Target;
  bloomTargets?: BloomTargets;
  presentationTarget?: Target;
}
