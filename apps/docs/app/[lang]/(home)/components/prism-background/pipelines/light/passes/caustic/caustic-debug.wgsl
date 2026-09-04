@group(0) @binding(0) var causticProfile: texture_2d<f32>;
@group(0) @binding(1) var causticSampler: sampler;

@fragment
fn fs_raw_caustic(@location(0) uv: vec2f) -> @location(0) vec4f {
  let sample = textureSampleLevel(causticProfile, causticSampler, uv, 0.0);
  return vec4f(sample.rgb * sample.a, 1.0);
}
