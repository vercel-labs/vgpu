export const TRANSMISSION_SAMPLES: i32 = 11;

const GOLDEN_ANGLE: f32 = 2.39996323;

/** Stable per-pixel rotation: breaks up rings without temporal noise or thumbnail drift. */
export fn cone_rotation(pixel: vec2f) -> f32 {
  return fract(sin(dot(floor(pixel), vec2f(12.9898, 78.233))) * 43758.5453) * 6.28318531;
}

/**
 * Equal-area golden-angle disk sample, lifted into a cone around `direction`.
 * `radius` is the tangent of the cone half-angle at the outermost sample.
 */
export fn cone_direction(direction: vec3f, sample_index: i32, radius: f32, rotation: f32) -> vec3f {
  let axis = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(direction.y) > 0.9);
  let tangent = normalize(cross(axis, direction));
  let bitangent = cross(direction, tangent);
  let disk_radius = sqrt((f32(sample_index) + 0.5) / f32(TRANSMISSION_SAMPLES));
  let angle = f32(sample_index) * GOLDEN_ANGLE + rotation;
  let offset = (cos(angle) * tangent + sin(angle) * bitangent) * disk_radius * radius;
  return normalize(direction + offset);
}
