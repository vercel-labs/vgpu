struct Values {
  values: array<u32>,
}

@group(0) @binding(0) var<storage, read_write> values: Values;

@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  values.values[id.x] += 1u;
}
