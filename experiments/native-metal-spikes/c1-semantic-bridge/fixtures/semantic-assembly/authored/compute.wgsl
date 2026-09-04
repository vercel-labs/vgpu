@compute @workgroup_size(4, 2)
fn step(@builtin(global_invocation_id) id: vec3u) {
  _ = id;
}
