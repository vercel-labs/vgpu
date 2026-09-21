// Copied from the environment-map/transmission environment pyramid. This runs
// only while baking; runtime glass shading still performs one environment fetch.

import { PI } from "./environment-map-common.wgsl";

struct Blur {
  texel: vec2f,
  direction: vec2f,
  radius: f32,
  equirect_compensation: f32,
}

@group(0) @binding(0) var<uniform> blur: Blur;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var src_samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let sin_theta = max(sin(uv.y * PI), 0.15);
  let scale = mix(1.0, 1.0 / sin_theta, blur.equirect_compensation);
  let step = blur.direction * blur.texel * blur.radius * scale;

  var offsets = array<f32, 3>(0.0, 1.3846153846, 3.2307692308);
  var weights = array<f32, 3>(0.2270270270, 0.3162162162, 0.0702702703);
  var sum = textureSampleLevel(src, src_samp, uv, 0.0) * weights[0];
  for (var index = 1; index < 3; index = index + 1) {
    sum += textureSampleLevel(
      src,
      src_samp,
      uv + step * offsets[index],
      0.0,
    ) * weights[index];
    sum += textureSampleLevel(
      src,
      src_samp,
      uv - step * offsets[index],
      0.0,
    ) * weights[index];
  }
  return sum;
}
