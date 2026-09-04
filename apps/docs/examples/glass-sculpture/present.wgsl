// HDR scene + bloom -> ACES tonemap, vignette, a whisper of grain.
struct Params { bloom: f32, time: f32, padding: vec2f }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var bloom: texture_2d<f32>;
@group(0) @binding(3) var scene_sampler: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var color = textureSampleLevel(scene, scene_sampler, uv, 0.0).rgb;
  color = color + textureSampleLevel(bloom, scene_sampler, uv, 0.0).rgb * params.bloom;
  color = color * 1.05;
  color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
  let d = uv - 0.5;
  color = color * (1.0 - 0.35 * dot(d, d) * 2.0);
  let grain = fract(sin(dot(uv * 1000.0 + params.time, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
  color = color + grain * 0.012 * step(0.001, params.time); // stills (time 0) stay grain-free
  return vec4f(pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 1.05)), 1.0);
}
