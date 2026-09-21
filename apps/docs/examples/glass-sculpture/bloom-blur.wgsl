struct BloomBlurParams {
  direction: vec2f,
  padding: vec2f,
}

@group(0) @binding(0) var<uniform> params: BloomBlurParams;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linear_sampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  var color = textureSampleLevel(source, linear_sampler, uv, 0.0).rgb * weights[0];
  for (var i = 1; i < 5; i += 1) {
    let offset = params.direction * f32(i) * 1.5;
    color += textureSampleLevel(source, linear_sampler, uv + offset, 0.0).rgb * weights[i];
    color += textureSampleLevel(source, linear_sampler, uv - offset, 0.0).rgb * weights[i];
  }
  return vec4f(color, 1.0);
}
