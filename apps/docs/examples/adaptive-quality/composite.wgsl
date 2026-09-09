// Final High-tier pass: HDR scene + bloom, ACES tone mapping, soft vignette.
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

fn tonemapAces(color: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3f(0.0), vec3f(1.0));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(scene, samp, uv, 0.0).rgb;
  let glow = textureSampleLevel(bloom, samp, uv, 0.0).rgb;
  let centered = uv - 0.5;
  let vignette = 1.0 - dot(centered, centered) * 0.6;
  let color = tonemapAces((base + glow * 0.6) * vignette);
  return vec4f(color, 1.0);
}
