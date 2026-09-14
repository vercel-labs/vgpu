// Scene plus blurred glow, tone mapped for the canvas.
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var glow: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

fn tonemap(color: vec3f) -> vec3f {
  return color / (color + vec3f(1.0));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(scene, samp, uv, 0.0).rgb;
  let bloom = textureSampleLevel(glow, samp, uv, 0.0).rgb;
  let centered = uv - 0.5;
  let vignette = 1.0 - dot(centered, centered) * 0.5;
  return vec4f(tonemap((base + bloom * 0.8) * vignette), 1.0);
}
