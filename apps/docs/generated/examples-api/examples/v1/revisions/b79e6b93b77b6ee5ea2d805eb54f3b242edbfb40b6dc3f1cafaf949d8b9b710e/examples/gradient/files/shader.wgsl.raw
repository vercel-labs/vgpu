@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let vignette = smoothstep(1.2, 0.2, distance(uv, vec2f(0.5)));
  return vec4f(uv.x, uv.y, 0.46 + 0.16 * vignette, 1.0);
}
