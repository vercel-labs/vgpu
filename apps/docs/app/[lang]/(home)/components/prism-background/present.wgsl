// Final linear-HDR presentation. The bloom pyramid is already rebuilt
// additively from 1/16 back to 1/2 resolution, so this pass only normalizes the
// accumulated energy, adds it to the untouched HDR scene, and performs the one
// ACES tone mapping plus sRGB conversion.

import { linearToSrgb3, tonemapAces } from "@vgpu/wgsl-std/color";

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var bloomTexture: texture_2d<f32>;
@group(0) @binding(2) var bloomSampler: sampler;

struct PresentParams {
  bloomStrength: f32,
}

@group(0) @binding(3) var<uniform> params: PresentParams;

// scatter = 0.65 at all three upsample steps. This is the reciprocal of
// 1 + scatter + scatter^2 + scatter^3, keeping brightness stable as levels are
// added while their progressively wider footprints shape the halo.
const BLOOM_ENERGY_NORMALIZATION = 0.426394;

@fragment
fn fs_main(
  @location(0) uv: vec2f,
  @builtin(position) position: vec4f,
) -> @location(0) vec4f {
  let scene = textureLoad(sceneTexture, vec2i(position.xy), 0).rgb;
  let bloom = textureSampleLevel(bloomTexture, bloomSampler, uv, 0.0).rgb
    * BLOOM_ENERGY_NORMALIZATION;
  let linear = max(scene + bloom * max(params.bloomStrength, 0.0), vec3f(0.0));
  return vec4f(linearToSrgb3(tonemapAces(linear)), 1.0);
}
