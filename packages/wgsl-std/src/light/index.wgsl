export fn lambert(normal: vec3f, lightDirection: vec3f, lightColor: vec3f, intensity: f32) -> vec3f {
  let n = normalize(normal);
  let l = normalize(-lightDirection);
  return lightColor * max(dot(n, l), 0.0) * intensity;
}
