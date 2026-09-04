struct C3VertexInput {
  @location(3) position: vec2<f32>,
  @location(7) intensity: f32,
}

struct C3VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(2) @interpolate(linear, centroid) uv: vec2<f32>,
  @location(5) @interpolate(flat) tag: u32,
}

struct C3FragmentOutput {
  @location(1) low: vec4<f32>,
  @location(4) high: vec4<f32>,
}

@vertex
fn c3_sparse_vertex(input: C3VertexInput) -> C3VertexOutput {
  var output: C3VertexOutput;
  output.position = vec4(input.position, 0.0, 1.0);
  output.uv = input.position;
  output.tag = u32(input.intensity);
  return output;
}

@fragment
fn c3_sparse_fragment(input: C3VertexOutput) -> C3FragmentOutput {
  var output: C3FragmentOutput;
  output.low = vec4(input.uv, f32(input.tag), 1.0);
  output.high = vec4(input.uv.yx, 0.0, 1.0);
  return output;
}
