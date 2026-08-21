// Radiance-cascade addressing: how many rays a cascade has, where they point, and where
// each one lives inside the direction-first atlas. Pure helpers, no bindings, so the math
// harness can run them against a CPU reference.

const TAU: f32 = 6.283185307179586;

/** Rays per probe: `direction_base^2 * 4^c`; quality raises the level-0 angular floor. */
export fn rc_ray_count(cascade: f32, direction_base: f32) -> f32 {
  let block = rc_block_size(cascade, direction_base);
  return block * block;
}

/** Probe spacing in scene pixels: `2^c`. Cascade 0 has one probe per pixel. */
export fn rc_probe_spacing(cascade: f32) -> f32 {
  return pow(2.0, cascade);
}

/**
 * Side of the square direction block a probe owns in the atlas.
 *
 * Spacing grows by 2 and the block grows by 2 on every level, so every cascade fills
 * exactly the same atlas. Its edge is `direction_base * scene`, and two atlases can be
 * recycled for the whole descent instead of keeping six alive.
 */
export fn rc_block_size(cascade: f32, direction_base: f32) -> f32 {
  return direction_base * pow(2.0, cascade);
}

/** Uniform angular sweep, half-slot centered: `theta = 2*pi*(i+0.5)/rays`. */
export fn rc_direction(index: f32, rays: f32) -> vec2f {
  let theta = TAU * (index + 0.5) / rays;
  return vec2f(cos(theta), sin(theta));
}

/** Atlas texel -> `vec3f(probe.x, probe.y, direction index)`. */
export fn rc_atlas_decode(texel: vec2f, block: f32) -> vec3f {
  let probe = floor(texel / block);
  let slot = texel - probe * block;
  return vec3f(probe, slot.y * block + slot.x);
}

/** Probe + direction index -> atlas texel. Inverse of `rc_atlas_decode`. */
export fn rc_atlas_texel(probe: vec2f, direction_index: f32, block: f32) -> vec2f {
  let slot = vec2f(direction_index % block, floor(direction_index / block));
  return probe * block + slot;
}

/** Center of a probe, in scene pixels. */
export fn rc_probe_origin(probe: vec2f, spacing: f32) -> vec2f {
  return (probe + 0.5) * spacing;
}
