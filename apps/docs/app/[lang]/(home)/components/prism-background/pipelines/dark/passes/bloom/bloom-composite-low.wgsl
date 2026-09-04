// Recombines the two bloom scales retained by the low-quality pipeline.

struct CompositeParams {
  radius: f32,
  factors: vec2f,
}

@group(0) @binding(0) var level0Texture: texture_2d<f32>;
@group(0) @binding(1) var level1Texture: texture_2d<f32>;
@group(0) @binding(2) var levelSampler: sampler;
@group(0) @binding(3) var<uniform> params: CompositeParams;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let radius = clamp(params.radius, 0.0, 1.0);
  let weight0 = mix(params.factors.x, params.factors.y, radius);
  let weight1 = mix(params.factors.y, params.factors.x, radius);
  let color = (
    textureSampleLevel(level0Texture, levelSampler, uv, 0.0).rgb * weight0
      + textureSampleLevel(level1Texture, levelSampler, uv, 0.0).rgb * weight1
  ) / max(weight0 + weight1, 0.0001);
  return vec4f(max(color, vec3f(0.0)), 1.0);
}
