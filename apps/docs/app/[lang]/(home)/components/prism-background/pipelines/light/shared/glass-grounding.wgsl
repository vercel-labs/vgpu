/** Deepens the already-baked glass shadow/AO without another target or draw. */
export fn evaluateGlassGrounding(prismShadow: f32, prismAo: f32) -> vec2f {
  return vec2f(
    pow(clamp(prismShadow, 0.0, 1.0), 1.65),
    pow(clamp(prismAo, 0.0, 1.0), 1.45),
  );
}
