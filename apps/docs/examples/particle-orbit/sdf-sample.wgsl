// Scene distance functions and the sphere tracer every cascade ray runs.

/** A half-texel counts as a hit. */
export const SDF_HIT_EPSILON: f32 = 0.5;
/** Keep grazing rays moving. */
export const SDF_MIN_STEP: f32 = 0.35;
/** Distance fields converge quickly at 4x intervals. */
export const SDF_MAX_STEPS: i32 = 16;

/** Unsigned distance from `p` to the segment `a`-`b`. */
export fn sdf_segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

/** Signed distance to the triangle `p0,p1,p2` (negative inside). */
export fn sdf_triangle(p: vec2f, p0: vec2f, p1: vec2f, p2: vec2f) -> f32 {
  let e0 = p1 - p0;
  let e1 = p2 - p1;
  let e2 = p0 - p2;
  let v0 = p - p0;
  let v1 = p - p1;
  let v2 = p - p2;
  let pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  let pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  let pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  let s = sign(e0.x * e2.y - e0.y * e2.x);
  let d = min(
    min(
      vec2f(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
      vec2f(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x)),
    ),
    vec2f(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)),
  );
  return -sqrt(d.x) * sign(d.y);
}

export fn sdf_pixel_uv(pixel: vec2f, size: vec2f) -> vec2f {
  let half_texel = 0.5 / size;
  return clamp(pixel / size, half_texel, vec2f(1.0) - half_texel);
}

export fn sdf_sample(
  tex: texture_2d<f32>,
  samp: sampler,
  pixel: vec2f,
  size: vec2f,
) -> f32 {
  return textureSampleLevel(tex, samp, sdf_pixel_uv(pixel, size), 0.0).r;
}

/**
 * Marches `[t_start, t_end]` of one ray through the distance field.
 *
 * Returns `vec4f(radiance, visibility)`: on a hit, the emitter's linear radiance with
 * visibility 0 — the merge below will not add anything behind it; on an escape, black with
 * visibility 1, so the next cascade's longer interval continues the same ray.
 */
export fn sphere_trace(
  sdf_tex: texture_2d<f32>,
  sdf_samp: sampler,
  emitter_tex: texture_2d<f32>,
  emitter_samp: sampler,
  size: vec2f,
  origin: vec2f,
  direction: vec2f,
  t_start: f32,
  t_end: f32,
) -> vec4f {
  var t = t_start;
  for (var step = 0; step < SDF_MAX_STEPS; step = step + 1) {
    let p = origin + direction * t;
    // Off-screen is empty space: nothing to hit, and the field outside is extrapolated.
    if (
      p.x < -1.0 ||
      p.y < -1.0 ||
      p.x > size.x + 1.0 ||
      p.y > size.y + 1.0
    ) {
      break;
    }
    let d = sdf_sample(sdf_tex, sdf_samp, p, size);
    if (d <= SDF_HIT_EPSILON) {
      let emitter = textureSampleLevel(
        emitter_tex,
        emitter_samp,
        sdf_pixel_uv(p, size),
        0.0,
      );
      return vec4f(emitter.rgb, 0.0);
    }
    t = t + max(d, SDF_MIN_STEP);
    if (t > t_end) {
      break;
    }
  }
  return vec4f(0.0, 0.0, 0.0, 1.0);
}
