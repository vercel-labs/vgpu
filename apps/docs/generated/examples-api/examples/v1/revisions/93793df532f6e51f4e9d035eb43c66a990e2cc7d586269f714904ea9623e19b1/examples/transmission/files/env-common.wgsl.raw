export const PI: f32 = 3.141592653589793;

// Equirectangular ("360°") mapping: every unit direction lands on one texel of the
// environment map. u wraps around the horizon, v goes from zenith (0) to nadir (1).
export fn equirect_uv(direction: vec3f) -> vec2f {
  let d = normalize(direction);
  return vec2f(atan2(d.z, d.x) / (2.0 * PI) + 0.5, acos(clamp(d.y, -1.0, 1.0)) / PI);
}

export fn direction_from_equirect(uv: vec2f) -> vec3f {
  let phi = (uv.x - 0.5) * 2.0 * PI;
  let theta = uv.y * PI;
  return vec3f(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
}

/**
 * Picks a mip of the prefiltered pyramid.
 *
 * Two things want a blurrier level: the material's reflection cone, and the pixel's own
 * angular footprint (a face seen edge-on smears many degrees of environment across one
 * pixel). Both are angles, so the wider one wins and the ratio to one texel's angle is
 * the level. `texel_angle` is 2*PI / map_width.
 *
 * The footprint comes from derivatives of the *direction*, never of the uv: uv jumps by
 * a full turn at the ±180° seam, which would drop that column of pixels to the last mip.
 */
export fn env_lod(cone: f32, ddx: vec3f, ddy: vec3f, texel_angle: f32) -> f32 {
  let footprint = max(length(ddx), length(ddy));
  return max(log2(max(cone, footprint) / texel_angle), 0.0);
}

/**
 * Samples the map with a reconstruction filter that survives magnification.
 *
 * A 360° map is always magnified by a narrow camera — 2048 texels of longitude against a
 * 42° field of view is roughly three screen pixels per texel — and plain bilinear
 * interpolates linearly *inside* each texel, so the gradient's slope breaks at every texel
 * boundary. The eye reads those breaks as blocky steps. Reshaping the fractional
 * coordinate with a smoothstep before the fetch makes the reconstruction C1 across
 * boundaries: still one tap, a handful of extra ALU, no ghosting.
 *
 * `size` is the full-resolution map size; the mip being read shrinks it by 2^lod.
 */
export fn sample_env(env: texture_2d<f32>, env_samp: sampler, direction: vec3f, lod: f32, size: vec2f) -> vec3f {
  let level_size = max(size / exp2(lod), vec2f(2.0));
  let texel = equirect_uv(direction) * level_size - 0.5;
  let corner = floor(texel);
  let f = fract(texel);
  let uv = (corner + f * f * (3.0 - 2.0 * f) + 0.5) / level_size;
  return textureSampleLevel(env, env_samp, uv, lod).rgb;
}

export fn tonemap_aces(color: vec3f) -> vec3f {
  let x = max(color, vec3f(0.0));
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

export fn linear_to_srgb(color: vec3f) -> vec3f {
  let x = max(color, vec3f(0.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}
