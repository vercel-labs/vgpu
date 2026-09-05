@group(0) @binding(0) var<storage, read_write> produced: array<u32, 8>;

@compute @workgroup_size(1, 1, 1)
fn produce(@builtin(global_invocation_id) id: vec3<u32>) {
  if any(id != vec3<u32>(0u)) {
    return;
  }

  // Words 0...3 are a zero-count decoy. The real indirect packet starts at byte 16.
  produced[4] = 3u;
  produced[5] = 1u;
  produced[6] = 0u;
  produced[7] = 0u;
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertex: u32) -> VertexOutput {
  // The indirect firstVertex is observable: 0 selects green and 3 selects red.
  let positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  let color = select(
    vec4<f32>(1.0, 0.0, 0.0, 1.0),
    vec4<f32>(0.0, 1.0, 0.0, 1.0),
    vertex < 3u,
  );
  return VertexOutput(vec4<f32>(positions[vertex], 0.0, 1.0), color);
}

@fragment
fn fragmentMain(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
  return color;
}
