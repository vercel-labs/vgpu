// Recombines the three detailed scales reserved for visible bloom. Increasing
// radius transfers weight toward the broadest of those scales without
// enlarging discrete taps.

struct CompositeParams {
  radius: f32,
  factors: vec4f,
}

@group(0) @binding(0) var level0Texture: texture_2d<f32>;
@group(0) @binding(1) var level1Texture: texture_2d<f32>;
@group(0) @binding(2) var level2Texture: texture_2d<f32>;
@group(0) @binding(3) var levelSampler: sampler;
@group(0) @binding(4) var<uniform> params: CompositeParams;

fn factor(index: u32) -> f32 {
  let nearToFar = array<f32, 4>(
    params.factors.x,
    params.factors.y,
    params.factors.z,
    params.factors.w,
  );
  return mix(
    nearToFar[index],
    nearToFar[2u - index],
    clamp(params.radius, 0.0, 1.0),
  );
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let weight0 = factor(0u);
  let weight1 = factor(1u);
  let weight2 = factor(2u);
  let color = (
    textureSampleLevel(level0Texture, levelSampler, uv, 0.0).rgb * weight0
    + textureSampleLevel(level1Texture, levelSampler, uv, 0.0).rgb * weight1
    + textureSampleLevel(level2Texture, levelSampler, uv, 0.0).rgb * weight2
  ) / max(weight0 + weight1 + weight2, 0.0001);
  return vec4f(max(color, vec3f(0.0)), 1.0);
}
