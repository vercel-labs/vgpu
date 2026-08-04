// Bloom threshold. The planet shader clamps itself to 0.7, so with a threshold of
// 0.71 the only thing that survives this pass is the sun — exactly the behaviour
// of a thresholded bloom extraction pass.

import { luminance } from "@vgpu/wgsl-std/color";

struct Bright {
  threshold: f32,
  knee: f32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> bright: Bright;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(src, samp, uv, 0.0).rgb;
  let brightness = luminance(color);
  // Quadratic soft knee around the threshold so highlights roll in smoothly.
  let knee = max(bright.knee, 0.0001);
  let soft = clamp((brightness - bright.threshold + knee) / (2.0 * knee), 0.0, 1.0);
  let contribution = max(soft * soft * knee, brightness - bright.threshold);
  return vec4f(color * max(contribution / max(brightness, 0.0001), 0.0), 1.0);
}
