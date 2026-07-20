export struct Sim {
  size: vec2u,
  step: u32,
  pointer_active: f32,
  pointer_from: vec2f,
  pointer_to: vec2f,
  pointer_velocity: vec2f,
  pointer_color: vec4f,
  idle_a: vec4f,
  idle_b: vec4f,
  output_size: vec2f,
  _pad: vec2f,
}

export fn index_of(p: vec2i, size: vec2u) -> u32 {
  let q = clamp(p, vec2i(0), vec2i(size) - 1);
  return u32(q.y) * size.x + u32(q.x);
}

export fn cell_uv(p: vec2i, size: vec2u) -> vec2f {
  return (vec2f(p) + .5) / vec2f(size);
}

export fn segment_weight(p: vec2f, a: vec2f, b: vec2f, radius: f32) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-7), 0.0, 1.0);
  let d = distance(p, a + t * ab);
  return exp(-3.5 * d * d / max(radius * radius, 1e-6));
}

export fn emitter_weight(p: vec2f, e: vec4f) -> f32 {
  let d = p - e.xy;
  return exp(-dot(d, d) / max(e.w * e.w, 1e-6)) * e.z;
}
