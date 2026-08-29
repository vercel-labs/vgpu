fn aces(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp(
    (color * (a * color + vec3f(b))) /
      (color * (c * color + vec3f(d)) + vec3f(e)),
    vec3f(0.0),
    vec3f(1.0),
  );
}

export fn presentCeramic(color: vec3f) -> vec4f {
  let mapped = aces(color * 1.08);
  return vec4f(pow(mapped, vec3f(1.0 / 2.2)), 1.0);
}
