fn sdf_segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

export fn sdf_triangle_vertices(p: vec2f, a: vec2f, b: vec2f, c: vec2f) -> f32 {
  let d = min(min(sdf_segment(p, a, b), sdf_segment(p, b, c)), sdf_segment(p, c, a));
  let edge0 = b - a;
  let edge1 = c - b;
  let edge2 = a - c;
  let side0 = edge0.x * (p.y - a.y) - edge0.y * (p.x - a.x);
  let side1 = edge1.x * (p.y - b.y) - edge1.y * (p.x - b.x);
  let side2 = edge2.x * (p.y - c.y) - edge2.y * (p.x - c.x);
  let inside = (side0 <= 0.0 && side1 <= 0.0 && side2 <= 0.0) || (side0 >= 0.0 && side1 >= 0.0 && side2 >= 0.0);
  return select(d, -d, inside);
}

export fn sdf_triangle(p: vec2f, r: f32) -> f32 {
  let k = 1.73205080757;
  let a = vec2f(0.0, -2.0 * r);
  let b = vec2f(-k * r, r);
  let c = vec2f(k * r, r);
  return sdf_triangle_vertices(p, a, b, c);
}
