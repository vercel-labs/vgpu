// The look: the grid the light falls on, and the single place linear radiance becomes
// display pixels. Pure helpers, no bindings.

/**
 * Albedo of the floor: a flat gray with slightly darker ruled lines.
 *
 * The grid is deliberately low contrast — it exists to give the global illumination
 * something to fall on and to make the light's falloff readable, not to be a pattern.
 */
export fn grid_albedo(pixel: vec2f, cell: f32, line_width: f32, base: f32, line: f32) -> vec3f {
  let to_line = abs(fract(pixel / cell - 0.5) - 0.5) * cell;
  let d = min(to_line.x, to_line.y);
  let strength = 1.0 - smoothstep(line_width - 0.75, line_width + 0.75, d);
  return vec3f(mix(base, line, strength));
}

/** ACES filmic curve; keeps HDR emitters from clipping to flat white. */
export fn tonemap_aces(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3f(0.0), vec3f(1.0));
}

/** The one and only encode: everything upstream stays linear. */
export fn linear_to_srgb(color: vec3f) -> vec3f {
  let low = color * 12.92;
  let high = 1.055 * pow(max(color, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(high, low, color <= vec3f(0.0031308));
}

/** Distance ramp for the SDF debug view: bright near an occluder, banded every `period` px. */
export fn distance_ramp(distance: f32, period: f32) -> vec3f {
  let near = exp(-distance / period);
  let bands = 0.5 + 0.5 * cos(6.283185307179586 * distance / period);
  return vec3f(near, near * 0.55 + 0.12 * bands, 0.35 * bands);
}
