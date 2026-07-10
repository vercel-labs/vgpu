@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let wave = sin(uv.x * uniforms.frequency + uniforms.time * 2.0) * uniforms.amplitude;
  let d = abs(uv.y - 0.5 - wave);
  let glow = 0.018 / max(d, 0.002);
  let core = smoothstep(0.018, 0.0, d);
  return vec4f(uniforms.color * (glow + core), 1.0);
}
