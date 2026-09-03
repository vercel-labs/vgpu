struct Params {
  scale: vec4f,
}

struct Output {
  values: array<vec4f, 4>,
}

@group(0) @binding(3) var<uniform> params: Params;
@group(1) @binding(7) var source_texture: texture_2d<f32>;
@group(1) @binding(2) var source_sampler: sampler;
@group(2) @binding(0) var<storage, read_write> output: Output;

@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  output.values[id.x] =
    textureSampleLevel(source_texture, source_sampler, vec2f(0.5), 0.0) * params.scale;
}
