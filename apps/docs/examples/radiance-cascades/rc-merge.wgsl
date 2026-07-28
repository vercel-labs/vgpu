// Merging a cascade into the one below it. Radiance is linear everywhere in this example;
// alpha is *visibility*, not coverage: 1 means "this interval saw nothing, keep going",
// 0 means "an occluder ended the ray here". Pure helpers, no bindings.

/** Weight of each of the four child directions a parent ray fans out into. */
export const RC_BRANCH_WEIGHT: f32 = 0.25;

/**
 * Visibility merge, near over far.
 *
 * `near.a` gates the far interval, so light behind an occluder never leaks forward, and
 * the alphas multiply so the composed ray stays open only while every segment did.
 */
export fn rc_merge(near: vec4f, far: vec4f) -> vec4f {
  return vec4f(near.rgb + near.a * far.rgb, near.a * far.a);
}

/** Bilinear weights for `fraction` in [0,1]^2, ordered (0,0) (1,0) (0,1) (1,1). They sum to 1. */
export fn rc_bilinear_weights(fraction: vec2f) -> vec4f {
  let f = clamp(fraction, vec2f(0.0), vec2f(1.0));
  return vec4f(
    (1.0 - f.x) * (1.0 - f.y),
    f.x * (1.0 - f.y),
    (1.0 - f.x) * f.y,
    f.x * f.y,
  );
}

/**
 * Clamp a probe index to the probe grid.
 *
 * The direction-first atlas interleaves directions inside each probe block, so a probe
 * that walks off the grid would land on a *different direction* of the opposite edge.
 * Clamping in probe space — not in texel space — is what keeps light from leaking around
 * the border of the screen.
 */
export fn rc_clamp_probe(probe: vec2f, grid: vec2f) -> vec2f {
  return clamp(probe, vec2f(0.0), grid - vec2f(1.0));
}

/** Half-texel UV clamp for the bilinear samplers reading scene-sized textures. */
export fn rc_clamp_uv(uv: vec2f, size: vec2f) -> vec2f {
  let half_texel = 0.5 / size;
  return clamp(uv, half_texel, vec2f(1.0) - half_texel);
}
