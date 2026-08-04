// Shared sunset sky model. Used by the skydome AND by the ocean's reflection so
// the water mirrors exactly the sky the viewer sees. HDR output (values > 1);
// the composite pass tone-maps. Pure module: exported function only.

/** Radiance looking along `dir`, with the sun toward `sunDir` (both need not be normalized). */
export fn skyColor(dir: vec3f, sunDir: vec3f) -> vec3f {
  let d = normalize(dir);
  let sun = normalize(sunDir);

  // Vertical gradient: warm at the horizon, deep blue toward the zenith.
  let up = clamp(d.y, 0.0, 1.0);
  let horizon = vec3f(1.15, 0.44, 0.19);
  let zenith = vec3f(0.05, 0.08, 0.22);
  var col = mix(horizon, zenith, pow(up, 0.5));

  // Extra warmth in a band hugging the horizon, and a darker tint just below it.
  let band = exp(-abs(d.y) * 7.0);
  col += vec3f(0.45, 0.15, 0.04) * band;
  let below = clamp(-d.y, 0.0, 1.0);
  col = mix(col, vec3f(0.18, 0.08, 0.09), below * 0.75);

  // Sun: tight golden halo + core + disk (kept warm, not blown to white).
  let m = max(dot(d, sun), 0.0);
  col += vec3f(1.35, 0.62, 0.24) * pow(m, 12.0) * 0.55;
  col += vec3f(1.5, 0.85, 0.42) * pow(m, 170.0) * 1.5;
  let disk = smoothstep(0.9993, 0.9997, m);
  col += vec3f(1.7, 1.05, 0.6) * disk * 4.5;

  return col;
}
