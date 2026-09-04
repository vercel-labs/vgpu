// Downsample the HDR frame 2x and keep only what is brighter than the threshold.
struct Params { texel: vec2f, threshold: f32, padding: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let t = params.texel;
  var c = textureSampleLevel(source, source_sampler, uv + vec2f(-t.x, -t.y), 0.0).rgb;
  c = c + textureSampleLevel(source, source_sampler, uv + vec2f(t.x, -t.y), 0.0).rgb;
  c = c + textureSampleLevel(source, source_sampler, uv + vec2f(-t.x, t.y), 0.0).rgb;
  c = c + textureSampleLevel(source, source_sampler, uv + vec2f(t.x, t.y), 0.0).rgb;
  c = c * 0.25;
  let luma = dot(c, vec3f(0.299, 0.587, 0.114));
  let keep = max(luma - params.threshold, 0.0) / max(luma, 1e-4);
  return vec4f(c * keep, 1.0);
}
