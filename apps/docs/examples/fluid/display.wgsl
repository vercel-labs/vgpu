@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let color = textureSample(dyeTexture, materialSampler, uv).rgb;
  let bloom = max(max(color.r, color.g), color.b);
  let vignette = smoothstep(0.9, 0.2, distance(uv, vec2f(0.5)));
  return vec4f(color * (0.85 + 0.35 * bloom) * vignette, 1.0);
}
