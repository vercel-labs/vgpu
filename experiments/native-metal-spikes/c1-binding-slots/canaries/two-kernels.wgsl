struct Data {
  values: array<u32, 4>,
}

@group(3) @binding(9) var<storage, read_write> clear_output: Data;
@group(7) @binding(5) var source_texture: texture_2d<f32>;
@group(7) @binding(6) var source_sampler: sampler;
@group(7) @binding(8) var<storage, read_write> sample_output: Data;

@compute @workgroup_size(1) fn clear(@builtin(global_invocation_id) id: vec3u) {
  clear_output.values[id.x] = 0u;
}

@compute @workgroup_size(1) fn sample(@builtin(global_invocation_id) id: vec3u) {
  let value = textureSampleLevel(source_texture, source_sampler, vec2f(0.5), 0.0).x;
  sample_output.values[id.x] = u32(value);
}
