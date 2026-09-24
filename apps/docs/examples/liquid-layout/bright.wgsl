// Bloom bright pass. Only the specular glints, Fresnel rims and caustic
// filaments exceed the threshold. Rendering into a half-resolution target with
// a linear sampler doubles as the first downsample.

import { luminance } from "@vgpu/wgsl-std/color";

struct Bright {
  threshold: f32,
  smoothing: f32,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> bright: Bright;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(src, samp, uv, 0.0).rgb;
  let weight = smoothstep(bright.threshold, bright.threshold + bright.smoothing, luminance(color));
  return vec4f(color * weight, 1.0);
}
