export const PI: f32 = 3.141592653589793;

// Copied from the environment-map and transmission examples. Texture v=0 is
// the zenith and v=1 the nadir, so the direction-to-texture Y convention stays
// explicit and shared by every reflection/refraction path.
export fn equirect_uv(direction: vec3f) -> vec2f {
  let d = normalize(direction);
  return vec2f(
    atan2(d.z, d.x) / (2.0 * PI) + 0.5,
    acos(clamp(d.y, -1.0, 1.0)) / PI,
  );
}

export fn direction_from_equirect(uv: vec2f) -> vec3f {
  let phi = (uv.x - 0.5) * 2.0 * PI;
  let theta = uv.y * PI;
  return vec3f(
    sin(theta) * cos(phi),
    cos(theta),
    sin(theta) * sin(phi),
  );
}

/** Selects the prefiltered level matching the direction's angular footprint. */
export fn env_lod(
  cone: f32,
  ddx: vec3f,
  ddy: vec3f,
  texel_angle: f32,
) -> f32 {
  let footprint = max(length(ddx), length(ddy));
  return max(log2(max(cone, footprint) / texel_angle), 0.0);
}

/**
 * One texture fetch with the examples' smooth reconstruction. `size` is level
 * zero's extent and `lod` may be fractional for trilinear mip blending.
 */
export fn sample_env(
  env: texture_2d<f32>,
  env_samp: sampler,
  direction: vec3f,
  lod: f32,
  size: vec2f,
) -> vec3f {
  let level_size = max(size / exp2(lod), vec2f(2.0));
  let texel = equirect_uv(direction) * level_size - 0.5;
  let corner = floor(texel);
  let f = fract(texel);
  let uv = (corner + f * f * (3.0 - 2.0 * f) + 0.5) / level_size;
  return textureSampleLevel(env, env_samp, uv, lod).rgb;
}
