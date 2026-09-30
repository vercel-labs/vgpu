// Final pass: the lit scene plus a faint half-resolution bloom on the brightest
// rim highlights, ACES tone mapping, the sRGB transfer for the canvas, a soft
// vignette and a one-step dither so the dark navy gradient does not band.

import { linearToSrgb3, tonemapAces } from "@vgpu/wgsl-std/color";
import { pcg2d } from "@vgpu/wgsl-std/hash";

struct Composite {
  aspect: f32,
  bloom: f32,
  exposure: f32,
  vignette: f32,
}

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var bloomTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> composite: Composite;

@fragment fn fs_main(@location(0) uv: vec2f, @builtin(position) position: vec4f) -> @location(0) vec4f {
  let base = textureSampleLevel(scene, samp, uv, 0.0).rgb;
  let glow = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
  let hdr = (base + glow * composite.bloom) * composite.exposure;
  var color = linearToSrgb3(tonemapAces(hdr));

  var q = uv - 0.5;
  q.x *= composite.aspect;
  let radius = length(q) / length(vec2f(0.5 * composite.aspect, 0.5));
  color *= 1.0 - composite.vignette * smoothstep(0.45, 1.05, radius);

  let noise = pcg2d(vec2u(position.xy));
  let dither = (f32(noise.x & 0xffffu) + f32(noise.y & 0xffffu)) / 65535.0 - 1.0;
  color += dither / 255.0;
  return vec4f(color, 1.0);
}
