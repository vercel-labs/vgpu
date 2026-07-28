/** How many wavelengths the spectral sweep splits the transmitted ray into. */
export const DISPERSION_SAMPLES: i32 = 7;

/** RGB response of one wavelength, with t from red (0) to blue (1). */
export fn spectral_weight(t: f32) -> vec3f {
  return vec3f(
    exp(-pow((t - 0.05) / 0.45, 2.0)),
    exp(-pow((t - 0.50) / 0.38, 2.0)),
    exp(-pow((t - 0.95) / 0.45, 2.0)),
  );
}
