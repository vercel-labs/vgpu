// Softly isolates HDR highlights before the blur pyramid.

struct ExtractParams {
  threshold: f32,
}

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> params: ExtractParams;

fn brightContribution(color: vec3f) -> vec3f {
  let brightness = max(max(color.r, color.g), color.b);
  let threshold = max(params.threshold, 0.0);
  let knee = max(threshold * 0.5, 0.0001);
  var soft = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 0.0001);
  let contribution = max(brightness - threshold, soft)
    / max(brightness, 0.0001);
  return color * contribution;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(sourceTexture, sourceSampler, uv, 0.0).rgb;
  return vec4f(brightContribution(max(color, vec3f(0.0))), 1.0);
}
