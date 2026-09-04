// Separable 9-tap Gaussian; `direction` is one texel along x or y.
struct Params { direction: vec2f, padding: vec2f }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let weights = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  var c = textureSampleLevel(source, source_sampler, uv, 0.0).rgb * weights[0];
  for (var i = 1; i < 5; i = i + 1) {
    let offset = params.direction * f32(i) * 1.5;
    c = c + textureSampleLevel(source, source_sampler, uv + offset, 0.0).rgb * weights[i];
    c = c + textureSampleLevel(source, source_sampler, uv - offset, 0.0).rgb * weights[i];
  }
  return vec4f(c, 1.0);
}
