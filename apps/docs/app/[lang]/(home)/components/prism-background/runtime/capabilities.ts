import { PARTICLE_LIGHT_FIRST_LEVEL } from "../pipelines/dark/passes/bloom/config";

export const PACKED_BLOOM_FEATURE: GPUFeatureName =
  "rg11b10ufloat-renderable";
export const PACKED_BLOOM_FORMAT: GPUTextureFormat = "rg11b10ufloat";
export const FALLBACK_BLOOM_FORMAT: GPUTextureFormat = "rgba16float";

type FeatureSet = Pick<GPUSupportedFeatures, "has">;

/**
 * Optional features requested at device creation. Packed bloom is useful in
 * production; timestamp queries stay opt-in because only the sampler consumes
 * them. An absent adapter probe preserves the exact rgba16float fallback.
 */
export function prismOptionalFeatures(
  supported: FeatureSet | undefined,
  performanceSampling: boolean
): readonly GPUFeatureName[] {
  if (!supported) return [];
  const features: GPUFeatureName[] = [];
  if (supported.has(PACKED_BLOOM_FEATURE))
    features.push(PACKED_BLOOM_FEATURE);
  if (performanceSampling && supported.has("timestamp-query"))
    features.push("timestamp-query");
  return features;
}

/** Device features, not the optimistic adapter probe, select live storage. */
export function bloomFormatForLevel(
  enabled: FeatureSet,
  level: number
): GPUTextureFormat {
  return level < PARTICLE_LIGHT_FIRST_LEVEL &&
    enabled.has(PACKED_BLOOM_FEATURE)
    ? PACKED_BLOOM_FORMAT
    : FALLBACK_BLOOM_FORMAT;
}
