import { PI } from "./env-common.wgsl";

// One half of a separable Gaussian, run twice per pyramid level (horizontal, then
// vertical) while the target halves in size. Chaining it down the chain doubles the
// angular blur per level, which is what turns the map into a roughness pyramid.
struct Blur {
  /** 1 / destination size: taps are spaced in destination texels. */
  texel: vec2f,
  /** (1, 0) horizontal or (0, 1) vertical. */
  direction: vec2f,
  radius: f32,
  /** 1 on the horizontal pass, 0 on the vertical one. */
  equirect_compensation: f32,
};
@group(0) @binding(0) var<uniform> blur: Blur;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var src_samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Equirect squeezes longitudes together toward the poles, so a fixed texel radius
  // covers a smaller and smaller angle up there. Scale it back (clamped, or the poles
  // smear across half the sky).
  let sin_theta = max(sin(uv.y * PI), 0.15);
  let scale = mix(1.0, 1.0 / sin_theta, blur.equirect_compensation);
  let step = blur.direction * blur.texel * blur.radius * scale;

  // 5 bilinear taps sample a 9-tap Gaussian: the off-center taps sit between texels so
  // hardware filtering folds two weights into one fetch.
  var offsets = array<f32, 3>(0.0, 1.3846153846, 3.2307692308);
  var weights = array<f32, 3>(0.2270270270, 0.3162162162, 0.0702702703);

  var sum = textureSampleLevel(src, src_samp, uv, 0.0) * weights[0];
  for (var i = 1; i < 3; i++) {
    sum += textureSampleLevel(src, src_samp, uv + step * offsets[i], 0.0) * weights[i];
    sum += textureSampleLevel(src, src_samp, uv - step * offsets[i], 0.0) * weights[i];
  }
  return sum;
}
