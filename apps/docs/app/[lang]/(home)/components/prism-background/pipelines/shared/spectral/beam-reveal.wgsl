/**
 * Opens a finite-width ray bundle from its center line. The uniform branches
 * keep the settled frame exact and avoid leaving a residual line at zero.
 */
export fn beamWidthReveal(profile: f32, progress: f32) -> f32 {
  let reveal = clamp(progress, 0.0, 1.0);
  if reveal <= 0.0 {
    return 0.0;
  }
  if reveal >= 1.0 {
    return 1.0;
  }
  // Outgoing spectral cells carry one flat profile per beam slice, so the
  // minimum feather lets adjacent rainbow slices join without visible steps.
  let antialias = max(fwidth(profile) * 1.5, 0.04);
  return 1.0 - smoothstep(
    max(reveal - antialias, 0.0),
    min(reveal + antialias, 1.0),
    abs(profile),
  );
}
