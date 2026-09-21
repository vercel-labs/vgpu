struct BloomExtractParams {
  texel: vec2f,
  threshold: f32,
  padding: f32,
}

@group(0) @binding(0) var<uniform> params: BloomExtractParams;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linear_sampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = params.texel;
  let a = textureSampleLevel(source, linear_sampler, uv + vec2f(-t.x, -t.y), 0.0).rgb;
  let b = textureSampleLevel(source, linear_sampler, uv + vec2f(t.x, -t.y), 0.0).rgb;
  let c = textureSampleLevel(source, linear_sampler, uv + vec2f(-t.x, t.y), 0.0).rgb;
  let d = textureSampleLevel(source, linear_sampler, uv + vec2f(t.x, t.y), 0.0).rgb;
  let color = (a + b + c + d) * 0.25;
  let luminance = dot(color, vec3f(0.299, 0.587, 0.114));
  let contribution = max(luminance - params.threshold, 0.0) / max(luminance, 0.0001);
  return vec4f(color * contribution, 1.0);
}
