fn palette(t: f32) -> vec3f {
  return 0.5 + 0.5 * cos(6.28318 * (vec3f(0.1, 0.35, 0.65) + t));
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let aspect = uniforms.resolution.x / uniforms.resolution.y;
  let uv = position.xy / uniforms.resolution;
  let zoom = 1.25 + 0.25 * sin(uniforms.time * 0.2);
  let c = vec2f((uv.x - 0.5) * aspect, uv.y - 0.5) * (2.8 / zoom) + vec2f(-0.55, 0.02);
  var z = vec2f(0.0);
  var iter = 0.0;
  for (var i = 0; i < 96; i++) {
    z = vec2f(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    if (dot(z, z) > 4.0) { break; }
    iter += 1.0;
  }
  let smoothed = iter - log2(max(log2(dot(z, z)), 0.001));
  let shade = smoothed / 96.0;
  let inside = select(0.0, 1.0, iter >= 95.0);
  let color = mix(palette(shade * 2.2 + uniforms.time * 0.025), vec3f(0.0, 0.0, 0.02), inside);
  return vec4f(color, 1.0);
}
