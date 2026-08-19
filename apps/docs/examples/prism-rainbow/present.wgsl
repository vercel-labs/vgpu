// Final linear-HDR presentation. Both glass interfaces have already been
// composed into the ping-pong targets; tone mapping happens exactly once here.

import { linearToSrgb3, tonemapAces } from "@vgpu/wgsl-std/color";

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let linear = textureLoad(sceneTexture, vec2i(position.xy), 0).rgb;
  return vec4f(linearToSrgb3(tonemapAces(linear)), 1.0);
}
