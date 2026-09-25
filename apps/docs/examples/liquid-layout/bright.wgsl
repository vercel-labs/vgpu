// Bloom bright pass into a quarter-resolution target. Only the brightest rim
// highlights and bubble glints exceed the threshold. Four linear taps, each
// averaging a 2×2 quad, cover the whole 4×4 block of scene pixels behind every
// output pixel, so a thin rim line never falls between samples and shimmers.
// Each tap is thresholded on its own so the average does not dilute the line
// below the threshold.

import { luminance } from "@vgpu/wgsl-std/color";

struct Bright {
  // Scene texel size in uv.
  texelSize: vec2f,
  threshold: f32,
  smoothing: f32,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> bright: Bright;

fn lit(uv: vec2f) -> vec3f {
  let color = textureSampleLevel(src, samp, uv, 0.0).rgb;
  return color * smoothstep(bright.threshold, bright.threshold + bright.smoothing, luminance(color));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = bright.texelSize;
  let sum = lit(uv + vec2f(-t.x, -t.y)) + lit(uv + vec2f(t.x, -t.y)) + lit(uv + vec2f(-t.x, t.y)) + lit(uv + t);
  return vec4f(sum * 0.25, 1.0);
}
