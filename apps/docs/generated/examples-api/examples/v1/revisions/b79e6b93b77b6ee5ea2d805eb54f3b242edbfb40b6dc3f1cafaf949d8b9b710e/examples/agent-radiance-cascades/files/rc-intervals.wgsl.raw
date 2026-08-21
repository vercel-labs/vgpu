// The geometric ray intervals of the cascade hierarchy. Cascade c traces the segment
// [start_c, start_c + length_c] of every ray, with length_c growing by exactly 4 per level
// so four times the angular resolution covers four times the distance at constant cost.
// Pure helpers, no bindings.

/** `start_c = interval0 * (4^c - 1) / 3` — the sum of every shorter interval. */
export fn rc_interval_start(cascade: f32, interval0: f32) -> f32 {
  return interval0 * (pow(4.0, cascade) - 1.0) / 3.0;
}

/** `length_c = interval0 * 4^c`. */
export fn rc_interval_length(cascade: f32, interval0: f32) -> f32 {
  return interval0 * pow(4.0, cascade);
}

/**
 * End of the traced segment, stretched by `overlap` (2%).
 *
 * Without the overlap two neighboring intervals meet at a single point and the sphere
 * tracer's epsilon can slip an occluder through the seam; with it the levels share a
 * sliver of distance and the seam disappears.
 */
export fn rc_interval_end(cascade: f32, interval0: f32, overlap: f32) -> f32 {
  return rc_interval_start(cascade, interval0) + rc_interval_length(cascade, interval0) * (1.0 + overlap);
}

/**
 * Levels needed to cover `diagonal` pixels: the smallest `n` with
 * `interval0 * (4^n - 1) / 3 >= diagonal`, clamped to the 5..6 the research calls for.
 */
export fn rc_cascade_count(diagonal: f32, interval0: f32) -> f32 {
  let exact = ceil(log(1.0 + 3.0 * diagonal / interval0) / log(4.0));
  return clamp(exact, 5.0, 6.0);
}

/** Distance covered by `count` cascades — the end of the last interval, ignoring overlap. */
export fn rc_covered_distance(count: f32, interval0: f32) -> f32 {
  return interval0 * (pow(4.0, count) - 1.0) / 3.0;
}
