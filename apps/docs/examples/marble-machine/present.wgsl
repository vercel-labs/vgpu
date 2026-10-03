import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";

@group(0) @binding(0) var sceneColor: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;

// The resolved scene to the output: a gentle vignette toward the corners, and half a step of
// integer-hash dither so the dark cyclorama gradient does not band.
@fragment
fn fs_main(@builtin(position) position: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(sceneColor, sceneSampler, uv, 0.0).rgb;
  let centered = (uv - vec2f(0.5, 0.48)) * vec2f(1.0, 0.8);
  let vignette = 1.0 - 0.28 * smoothstep(0.08, 0.42, dot(centered, centered));
  let noise = unitFloat(pcg3d(vec3u(vec2u(position.xy), 11u)).x) - 0.5;
  return vec4f(color * vignette + noise / 255.0, 1.0);
}
