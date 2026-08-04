struct Bright {
  threshold: f32,
  knee: f32,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> bright: Bright;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(src, samp, uv, 0.0).rgb;
  let luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  // Quadratic soft knee around the threshold for smooth highlight roll-in.
  let knee = max(bright.knee, 0.0001);
  let soft = clamp((luminance - bright.threshold + knee) / (2.0 * knee), 0.0, 1.0);
  let softContribution = soft * soft * knee;
  let contribution = max(softContribution, luminance - bright.threshold);
  let weight = contribution / max(luminance, 0.0001);
  return vec4f(color * max(weight, 0.0), 1.0);
}
