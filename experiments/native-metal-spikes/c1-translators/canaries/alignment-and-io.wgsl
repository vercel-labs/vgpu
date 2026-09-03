struct PaddedWeight {
  @size(16) value: vec2f,
}

struct Params {
  scalar: f32,
  direction: vec3f,
  transform: mat4x4f,
  weights: array<PaddedWeight, 3>,
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(perspective, center) uv: vec2f,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source_texture: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

@vertex fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOut {
  var out: VertexOut;
  let x = f32((vertex_index << 1u) & 2u);
  let y = f32(vertex_index & 2u);
  out.position = params.transform * vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  out.uv = vec2f(x, y);
  return out;
}

@fragment fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let sampled = textureSample(source_texture, source_sampler, input.uv);
  let weight = params.weights[0].value.x + params.weights[1].value.y + params.weights[2].value.x;
  return vec4f(sampled.rgb * params.direction * (params.scalar + weight), sampled.a);
}
