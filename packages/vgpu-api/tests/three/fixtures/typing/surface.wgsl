export fn surfaceColor(position: vec3f, timeSeconds: f32) -> vec3f {
  return position * timeSeconds;
}
