// Jump-flood primitives. A seed texel carries the pixel coordinate of the nearest emitter
// found so far in `xy` and a validity flag in `w`; the flood keeps the closest candidate
// of the 3x3 neighborhood at the current jump distance. Pure helpers, no bindings.

/** An empty seed: nothing found yet. */
export fn jfa_empty() -> vec4f {
  return vec4f(0.0, 0.0, 0.0, 0.0);
}

/** A seed pointing at `position` (pixel center coordinates). */
export fn jfa_seed(position: vec2f) -> vec4f {
  return vec4f(position, 0.0, 1.0);
}

/** Keeps whichever of the two seeds is closer to `position`; invalid seeds always lose. */
export fn jfa_pick(current: vec4f, candidate: vec4f, position: vec2f) -> vec4f {
  if (candidate.w < 0.5) { return current; }
  if (current.w < 0.5) { return candidate; }
  let current_distance = distance(current.xy, position);
  let candidate_distance = distance(candidate.xy, position);
  return select(current, candidate, candidate_distance < current_distance);
}

/** Distance from `position` to its seed, or `far` when the flood never reached it. */
export fn jfa_distance(seed: vec4f, position: vec2f, far: f32) -> f32 {
  return select(far, distance(seed.xy, position), seed.w >= 0.5);
}

/**
 * Jump distance of pass `index`, counting down from the largest power of two below the
 * texture: `size/2, size/4, ... 1`.
 *
 * `ceil(log2(size))` passes cover any size, and the pipeline runs two more (JFA+2): plain
 * jump flooding is an approximation that can leave a corner pointing at the second-nearest
 * seed, and the extra unit rounds clean that up. Indices past the halving sequence keep
 * returning 1, so the same formula drives them.
 */
export fn jfa_jump(index: f32, size: f32) -> f32 {
  return max(1.0, exp2(ceil(log2(max(size, 2.0))) - index - 1.0));
}
