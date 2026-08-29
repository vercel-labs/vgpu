import { linear_to_srgb, tonemap_aces } from "./env-common.wgsl";

// Exposure, tonemapping, and sRGB conversion happen once after HDR composition.
@group(0) @binding(0) var color_tex: texture_2d<f32>;
@group(0) @binding(1) var color_samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSample(color_tex, color_samp, uv).rgb;
  return vec4f(linear_to_srgb(tonemap_aces(color * 0.95)), 1.0);
}
