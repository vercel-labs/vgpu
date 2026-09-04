// Bloom bright-pass over the composited frame.
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(src, samp, uv, 0.0).rgb;
  let luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  // Soft knee around the threshold so the ember and trail heads glow while
  // the dim bar field stays out of the bloom chain.
  let threshold = 0.62;
  let knee = 0.3;
  let soft = clamp((luminance - threshold + knee) / (2.0 * knee), 0.0, 1.0);
  let contribution = max(soft * soft * knee, luminance - threshold);
  let weight = contribution / max(luminance, 0.0001);
  return vec4f(color * weight, 1.0);
}
