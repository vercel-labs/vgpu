import { shade } from "./fragment.wgsl";

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn draw_vertex(@builtin(vertex_index) index: u32) -> VertexOutput {
  var output: VertexOutput;
  output.position = shade(vec2f(f32(index), 0.0));
  output.uv = vec2f(0.25, 0.75);
  return output;
}
