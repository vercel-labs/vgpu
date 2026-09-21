struct PresentParams {
  bloom_strength: f32,
  time: f32,
  padding: vec2f,
}

@group(0) @binding(0) var<uniform> params: PresentParams;
@group(0) @binding(1) var scene_texture: texture_2d<f32>;
@group(0) @binding(2) var bloom_texture: texture_2d<f32>;
@group(0) @binding(3) var linear_sampler: sampler;

fn aces(color: vec3f) -> vec3f {
  return (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let scene = textureSampleLevel(scene_texture, linear_sampler, uv, 0.0).rgb;
  let bloom = textureSampleLevel(bloom_texture, linear_sampler, uv, 0.0).rgb;
  var color = aces((scene + bloom * params.bloom_strength) * 1.05);
  let centered = uv - 0.5;
  color *= 1.0 - dot(centered, centered) * 0.7;
  let noise = fract(sin(dot(uv * 1000.0 + params.time, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
  color += noise * 0.012 * step(0.001, params.time);
  return vec4f(pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 1.05)), 1.0);
}
