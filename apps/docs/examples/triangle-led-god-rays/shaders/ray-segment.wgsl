// Finite ray-segment vs padded segment/capsule helpers.
// Tests the cascade ray interval [origin + t_min * dir, origin + t_max * dir]
// against an edge segment expanded by radius.
export fn segment_segment_dist2(p0: vec2f, p1: vec2f, a0: vec2f, a1: vec2f) -> f32 {
  let d1 = p1 - p0;
  let d2 = a1 - a0;
  let r = p0 - a0;
  let aa = dot(d1, d1);
  let ee = dot(d2, d2);
  let ff = dot(d2, r);
  let cc = dot(d1, r);
  let bb = dot(d1, d2);
  let denom = aa * ee - bb * bb;

  var s = 0.0;
  if (denom > 1e-8) {
    s = clamp((bb * ff - cc * ee) / denom, 0.0, 1.0);
  }

  var t = (bb * s + ff) / ee;
  if (t < 0.0) {
    t = 0.0;
    s = clamp(-cc / aa, 0.0, 1.0);
  } else if (t > 1.0) {
    t = 1.0;
    s = clamp((bb - cc) / aa, 0.0, 1.0);
  }

  let closest1 = p0 + d1 * s;
  let closest2 = a0 + d2 * t;
  let diff = closest1 - closest2;
  return dot(diff, diff);
}

export fn ray_hits_edge(
  origin: vec2f,
  dir: vec2f,
  t_min: f32,
  t_max: f32,
  edge0: vec2f,
  edge1: vec2f,
  radius: f32,
) -> bool {
  let p0 = origin + dir * t_min;
  let p1 = origin + dir * t_max;
  return segment_segment_dist2(p0, p1, edge0, edge1) <= radius * radius;
}
