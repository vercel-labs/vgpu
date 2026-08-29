import { value_remap_clamp } from "./color-utils.wgsl";

// Smooth value map: input at/below lo reads 0, at/above hi reads 1 (lo > hi inverts).
export fn value_map01(value: f32, lo: f32, hi: f32) -> f32 {
  let denom = hi - lo;
  let safe_denom = select(denom, 0.001, abs(denom) < 0.0001);
  return clamp((value - lo) / safe_denom, 0.0, 1.0);
}

// CLOSE: remap the light first (so it follows the light shape), then mask with a
// thin SDF band hugging the triangle to fake a thin line.
//   near = (outer-radius scale, intensity, light-map lo, light-map hi)
export fn near_falloff(
  triangle_sdf: f32,
  near_light: f32,
  fade_inner: f32,
  circumradius: f32,
  near: vec4f,
  band_power: f32,
  enabled: f32,
) -> f32 {
  let mapped = value_map01(near_light, near.z, near.w);
  let near_outer = max(circumradius * near.x, fade_inner + 0.001);
  let near_fade = value_remap_clamp(triangle_sdf, near_outer, fade_inner, 0.0, 1.0);
  let band = pow(near_fade, max(band_power, 0.001));
  return mapped * band * near.y * enabled;
}

// FAR: pure light fade (no SDF). Remap radiance luminance, shape with the tail
// power, scale by intensity.
//   glow = (intensity, _, light-map lo, light-map hi)
export fn far_falloff(
  near_light: f32,
  glow: vec4f,
  power: f32,
  enabled: f32,
) -> f32 {
  let mapped = value_map01(near_light, glow.z, glow.w);
  let shaped = pow(mapped, max(power, 0.001));
  return shaped * glow.x * enabled;
}
