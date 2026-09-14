struct View {
  aspect: f32,
  pixel_scale: f32,
  height: f32,
  time: f32,
}

@group(0) @binding(0) var<uniform> view: View;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertex_main(@builtin(vertex_index) vertex: u32) -> VertexOut {
  let points = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VertexOut;
  out.position = vec4f(points[vertex], 0.999, 1.0);
  out.uv = points[vertex] * vec2f(view.aspect, 1.0);
  return out;
}

@fragment
fn fragment_main(in: VertexOut) -> @location(0) vec4f {
  let wash = exp(-dot(in.uv, in.uv) * 2.2);
  let shadow = exp(-in.uv.x * in.uv.x * 8.0 - pow((in.uv.y + 0.68) * 17.0, 2.0));
  let base = vec3f(0.79, 0.805, 0.825);
  return vec4f(base + vec3f(0.055) * wash - vec3f(0.065) * shadow, 1.0);
}
