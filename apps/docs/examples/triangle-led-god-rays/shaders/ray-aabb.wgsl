// Conservative 2-D ray vs axis-aligned bounding-box test (slab method).
// Returns true if origin + t * dir for t in [t_min, t_max] can intersect [box_min, box_max].
// Current callers pass finite, non-axis-aligned cascade directions; if reused with arbitrary
// rays, handle zero direction components / parallel-axis boundary cases explicitly.
export fn ray_intersects_aabb(
  origin: vec2f,
  dir: vec2f,
  box_min: vec2f,
  box_max: vec2f,
  t_min: f32,
  t_max: f32,
) -> bool {
  let inv_dir = vec2f(1.0) / dir;
  let t1 = (box_min - origin) * inv_dir;
  let t2 = (box_max - origin) * inv_dir;
  let near2 = min(t1, t2);
  let far2 = max(t1, t2);
  let t_near = max(near2.x, near2.y);
  let t_far = min(far2.x, far2.y);
  return t_near <= t_far && t_far >= t_min && t_near <= t_max;
}
