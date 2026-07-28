import { linear_to_srgb, tonemap_aces } from "./env-common.wgsl";

// The only pass that leaves linear HDR. Everything upstream — sky, floor, glass — writes
// scene-referred radiance into an rgba16float target, so exposure, tonemap and the sRGB
// transfer happen exactly once, here, on the composited result.
struct Present {
  exposure: f32,
};
@group(0) @binding(0) var<uniform> present: Present;
@group(0) @binding(1) var color_tex: texture_2d<f32>;
@group(0) @binding(2) var color_samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSample(color_tex, color_samp, uv).rgb;
  return vec4f(linear_to_srgb(tonemap_aces(color * present.exposure)), 1.0);
}
