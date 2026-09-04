export fn shade(uv: vec2f) -> vec4f {
  return vec4f(uv, 0.0, 1.0);
}

@fragment
fn draw_fragment(@location(0) uv: vec2f) -> @location(0) vec4f {
  return shade(uv);
}
