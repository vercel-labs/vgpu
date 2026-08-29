import { PI } from "./env-common.wgsl";

// One half of the separable Gaussian used for both roughness pyramids.
struct Blur {
  texel: vec2f,
  direction: vec2f,
  radius: f32,
  equirect_compensation: f32,
};
@group(0) @binding(0) var<uniform> blur: Blur;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var src_samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let sin_theta = max(sin(uv.y * PI), 0.15);
  let scale = mix(1.0, 1.0 / sin_theta, blur.equirect_compensation);
  let step = blur.direction * blur.texel * blur.radius * scale;

  // Five bilinear taps implement a nine-tap Gaussian.
  var offsets = array<f32, 3>(0.0, 1.3846153846, 3.2307692308);
  var weights = array<f32, 3>(0.2270270270, 0.3162162162, 0.0702702703);

  var sum = textureSampleLevel(src, src_samp, uv, 0.0) * weights[0];
  for (var i = 1; i < 3; i++) {
    sum += textureSampleLevel(src, src_samp, uv + step * offsets[i], 0.0) * weights[i];
    sum += textureSampleLevel(src, src_samp, uv - step * offsets[i], 0.0) * weights[i];
  }
  return sum;
}
