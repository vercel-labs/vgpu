@group(0) @binding(0)
var<storage, read_write> values: array<u32, 4>;

@compute @workgroup_size(4)
fn c3_noop(@builtin(global_invocation_id) id: vec3<u32>) {
  values[id.x] = id.x;
}
