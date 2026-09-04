export fn surfaceColor(position: vec3f) -> vec3f {
  let bands = 0.5 + 0.5 * sin((position.x + position.y * 0.7) * 10.0);
  let cool = vec3f(0.03, 0.12, 0.3);
  let warm = vec3f(1.0, 0.28, 0.06);
  return mix(cool, warm, bands);
}
