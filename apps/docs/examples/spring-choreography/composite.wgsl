// Scene + two bloom levels, exposure and ACES in linear light, then the sRGB
// transfer for the canvas. The deep-blue backdrop and vignette are applied in
// display space, and a one-step dither keeps the dark gradient band-free.

import { linearToSrgb3, tonemapAces } from "@vgpu/wgsl-std/color";
import { pcg2d } from "@vgpu/wgsl-std/hash";

struct Params {
  exposure: f32,
  bloomNear: f32,
  bloomFar: f32,
  aspect: f32,
}

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var near: texture_2d<f32>;
@group(0) @binding(2) var far: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<uniform> params: Params;

@fragment fn fs_main(@location(0) uv: vec2f, @builtin(position) position: vec4f) -> @location(0) vec4f {
  let hdr = textureSampleLevel(scene, samp, uv, 0.0).rgb
    + textureSampleLevel(near, samp, uv, 0.0).rgb * params.bloomNear
    + textureSampleLevel(far, samp, uv, 0.0).rgb * params.bloomFar;
  var color = linearToSrgb3(tonemapAces(hdr * params.exposure));

  let centered = (uv - 0.5) * vec2f(params.aspect, 1.0);
  let backdrop = mix(vec3f(0.035, 0.05, 0.11), vec3f(0.004, 0.006, 0.016), smoothstep(0.1, 1.1, length(centered)));
  color = color + backdrop * (1.0 - color);
  let vignette = 1.0 - 0.35 * smoothstep(0.45, 1.25, length((uv - 0.5) * 2.0));
  color *= vignette;

  let noise = pcg2d(vec2u(position.xy));
  let dither = (f32(noise.x >> 8u) / 16777216.0 - f32(noise.y >> 8u) / 16777216.0) / 255.0;
  return vec4f(color + dither, 1.0);
}
