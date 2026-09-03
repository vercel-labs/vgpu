struct Data {
  values: array<u32>,
}

@group(0) @binding(0) var<storage, read_write> data: Data;

@compute @workgroup_size(1) fn clear(@builtin(global_invocation_id) id: vec3u) {
  data.values[id.x] = 0u;
}

@compute @workgroup_size(8) fn increment(@builtin(global_invocation_id) id: vec3u) {
  data.values[id.x] += 1u;
}

@vertex fn vs_main(@builtin(vertex_index) id: u32) -> @builtin(position) vec4f {
  return vec4f(f32(id & 1u) * 2.0 - 1.0, f32((id >> 1u) & 1u) * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(0.25, 0.5, 1.0, 1.0);
}
