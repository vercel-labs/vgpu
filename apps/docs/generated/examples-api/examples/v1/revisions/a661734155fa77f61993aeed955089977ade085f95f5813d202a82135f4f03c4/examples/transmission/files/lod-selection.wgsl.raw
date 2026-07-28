/** Maps perceptual roughness onto the available screen-space blur pyramid. */
export fn transmission_lod(roughness: f32, levels: f32) -> f32 {
  return pow(roughness, 0.8) * max(levels - 1.0, 0.0);
}

/** Reflection cone used by env_lod. */
export fn reflection_cone(roughness: f32) -> f32 {
  return max(roughness * 0.6, 0.02);
}
