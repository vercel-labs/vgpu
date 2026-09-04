// Final linear-HDR presentation. The bloom pyramid has already been combined
// into one energy-normalized half-resolution texture, so this pass adds it to
// the untouched HDR scene and performs the one ACES tone mapping plus sRGB
// conversion. Multisampled geometry was already resolved by its scene target.

import { linearToSrgb3, tonemapAces } from "@vgpu/wgsl-std/color";

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var bloomTexture: texture_2d<f32>;
@group(0) @binding(2) var bloomSampler: sampler;

struct PresentParams {
  bloomStrength: f32,
}

@group(0) @binding(3) var<uniform> params: PresentParams;

@fragment
fn fs_main(
  @location(0) uv: vec2f,
  @builtin(position) position: vec4f,
) -> @location(0) vec4f {
  let scene = textureLoad(sceneTexture, vec2i(position.xy), 0).rgb;
  let bloom = textureSampleLevel(bloomTexture, bloomSampler, uv, 0.0).rgb;
  let linear = max(scene + bloom * max(params.bloomStrength, 0.0), vec3f(0.0));
  return vec4f(linearToSrgb3(tonemapAces(linear)), 1.0);
}
