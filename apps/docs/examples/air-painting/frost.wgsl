// One axis of a nine-tap separable blur. The horizontal pass also downsamples
// the camera to quarter resolution; the vertical pass blurs that result.

struct Frost {
  texel_size: vec2f,
  direction: vec2f,
  sigma: f32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> frost: Frost;

const TAPS: i32 = 4;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let step = frost.texel_size * frost.direction;
  let sigma = max(frost.sigma, 1e-3);
  let denom = 2.0 * sigma * sigma;

  var sum = textureSampleLevel(src, samp, uv, 0.0).rgb;
  var weight_sum = 1.0;
  for (var i = 1; i <= TAPS; i = i + 1) {
    let offset = f32(i);
    let w = exp(-(offset * offset) / denom);
    sum = sum + textureSampleLevel(src, samp, uv + step * offset, 0.0).rgb * w;
    sum = sum + textureSampleLevel(src, samp, uv - step * offset, 0.0).rgb * w;
    weight_sum = weight_sum + 2.0 * w;
  }

  return vec4f(sum / weight_sum, 1.0);
}
