// Shared by the solver passes. Every field is a render target sampled
// bilinearly at uv (top-left origin, v down); velocity is stored in grid
// texels per second, so one texel is the unit length of every stencil.

export struct Grid {
  size: vec2f,
  texel: vec2f,
}

/** Distance from `p` to the segment a→b, measured in canvas-height units. */
export fn capsule_distance(p: vec2f, a: vec2f, b: vec2f, aspect: f32) -> f32 {
  let scale = vec2f(aspect, 1.0);
  let pa = (p - a) * scale;
  let ba = (b - a) * scale;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h);
}

/** Multiplies velocity: 0 for the normal component on the outermost ring of cells (free-slip walls). */
export fn wall_mask(uv: vec2f, grid: Grid) -> vec2f {
  let cell = uv * grid.size;
  return vec2f(
    select(1.0, 0.0, cell.x < 1.0 || cell.x > grid.size.x - 1.0),
    select(1.0, 0.0, cell.y < 1.0 || cell.y > grid.size.y - 1.0),
  );
}
