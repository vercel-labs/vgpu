override SHARED: f32 = 0.25f;
override VERTEX_ONLY: f32 = 0.5f;
override FRAGMENT_ONLY: f32 = 0.75f;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) baked_vertex: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );

  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  output.baked_vertex = vec2f(VERTEX_ONLY, SHARED);
  return output;
}

struct FragmentInput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) baked_vertex: vec2f,
}

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4f {
  let pixel = floor(input.position.xy);
  return vec4f(
    input.baked_vertex.x + pixel.x * 0.25f,
    input.baked_vertex.y + pixel.y * 0.25f,
    FRAGMENT_ONLY,
    SHARED,
  );
}
