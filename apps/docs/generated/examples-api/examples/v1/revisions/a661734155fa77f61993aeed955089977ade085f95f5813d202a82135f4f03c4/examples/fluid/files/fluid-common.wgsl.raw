export struct Grid {
  size: vec2u,
  dye_size: vec2u,
  aspect: f32,
  _pad0: f32,
  _pad1: vec2f,
}

export struct Input {
  step: u32,
  pointer_active: f32,
  _pad0: vec2f,
  pointer_from: vec2f,
  pointer_to: vec2f,
  pointer_velocity: vec2f,
  _pad1: vec2f,
  pointer_color: vec4f,
  idle_a: vec4f,
  idle_b: vec4f,
}

export fn index_of(p: vec2i, size: vec2u) -> u32 {
  let q = clamp(p, vec2i(0), vec2i(size) - 1);
  return u32(q.y) * size.x + u32(q.x);
}

export fn cell_uv(p: vec2i, size: vec2u) -> vec2f {
  return (vec2f(p) + 0.5) / vec2f(size);
}

export fn segment_weight(
  p: vec2f,
  a: vec2f,
  b: vec2f,
  radius_squared: f32,
  aspect: f32,
) -> f32 {
  let scale = vec2f(aspect, 1.0);
  let point = p * scale;
  let origin = a * scale;
  let delta = (b - a) * scale;
  let t = clamp(dot(point - origin, delta) / max(dot(delta, delta), 1e-7), 0.0, 1.0);
  let d = point - (origin + t * delta);
  return exp(-dot(d, d) / radius_squared);
}

export fn emitter_weight(p: vec2f, emitter: vec4f, aspect: f32) -> f32 {
  let d = (p - emitter.xy) * vec2f(aspect, 1.0);
  return exp(-dot(d, d) / emitter.w) * emitter.z;
}
