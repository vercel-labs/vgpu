import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";

@group(0) @binding(0) var sceneColor: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;

// Resolved MSAA scene to the output: a soft vignette and a one-step dither against banding
// in the dark wall gradient.
@fragment
fn fs_main(@builtin(position) position: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(sceneColor, sceneSampler, uv, 0.0).rgb;
  let centered = uv - vec2f(0.5, 0.46);
  let vignette = 1.0 - 0.32 * smoothstep(0.18, 0.75, dot(centered, centered) * 1.6);
  let noise = unitFloat(pcg3d(vec3u(vec2u(position.xy), 7u)).x) - 0.5;
  return vec4f(color * vignette + noise / 255.0, 1.0);
}
