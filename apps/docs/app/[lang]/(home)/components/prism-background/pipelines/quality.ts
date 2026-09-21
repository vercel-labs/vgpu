import {
  HIGH_LIGHT_MESH_LAYOUT,
  lightMeshLayout,
  type LightMeshLayout,
} from "../scene/light-mesh";
import { BLOOM_LEVELS, BLOOM_VISIBLE_LEVELS } from "./dark/passes/bloom/config";
import type { PrismPipelineQuality } from "./types";

export const LOW_LIGHT_SPECTRAL_SAMPLES = 64;
export const LOW_LIGHT_BEAM_SLICES = 12;
export const LOW_DARK_BLOOM_STRENGTH = 0.15;

export const LOW_LIGHT_MESH_LAYOUT = lightMeshLayout(
  LOW_LIGHT_SPECTRAL_SAMPLES,
  LOW_LIGHT_BEAM_SLICES
);

export function lightMeshLayoutForQuality(
  quality: PrismPipelineQuality
): LightMeshLayout {
  return quality === "low" ? LOW_LIGHT_MESH_LAYOUT : HIGH_LIGHT_MESH_LAYOUT;
}

export function darkBloomVisibleLevelsForQuality(
  quality: PrismPipelineQuality
): number {
  return quality === "low" ? 2 : BLOOM_VISIBLE_LEVELS;
}

export function darkBloomLevelCountForQuality(
  quality: PrismPipelineQuality
): number {
  return quality === "low" ? 2 : BLOOM_LEVELS;
}

export function darkBloomStrengthForQuality(
  quality: PrismPipelineQuality,
  configuredStrength: number
): number {
  return quality === "low"
    ? LOW_DARK_BLOOM_STRENGTH
    : configuredStrength;
}
