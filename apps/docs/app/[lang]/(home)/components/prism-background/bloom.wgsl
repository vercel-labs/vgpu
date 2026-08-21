// One level of an Unreal-style bloom pyramid.
//
// Every pass renders at half the resolution of its source. A rotated 9-tap
// kernel performs a smooth low-pass while downsampling; a stable screen-space
// hash changes the rotation per output texel so parallel light edges do not
// reveal a regular sampling grid. Only the first level extracts highlights.

struct BloomParams {
  sourceTexelSize: vec2f,
  threshold: f32,
  extractHighlights: f32,
}

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> params: BloomParams;

const TAU = 6.28318530718;

fn hash12(pixel: vec2f) -> f32 {
  let p = fract(pixel * vec2f(0.1031, 0.1030));
  let mixed = p + dot(p, p.yx + vec2f(33.33));
  return fract((mixed.x + mixed.y) * mixed.x);
}

fn lowPass(uv: vec2f, outputPixel: vec2f) -> vec3f {
  let rotation = hash12(outputPixel) * TAU;
  var result = textureSampleLevel(sourceTexture, sourceSampler, uv, 0.0).rgb * 0.25;
  for (var tap = 0; tap < 8; tap = tap + 1) {
    let angle = rotation + f32(tap) * (TAU / 8.0);
    let offset = vec2f(cos(angle), sin(angle)) * params.sourceTexelSize * 1.5;
    result += textureSampleLevel(sourceTexture, sourceSampler, uv + offset, 0.0).rgb
      * 0.09375;
  }
  return max(result, vec3f(0.0));
}

/** Soft-knee extraction keeps the edge around the HDR threshold continuous. */
fn brightContribution(color: vec3f) -> vec3f {
  let brightness = max(max(color.r, color.g), color.b);
  let threshold = max(params.threshold, 0.0);
  let knee = max(threshold * 0.5, 0.0001);
  var soft = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 0.0001);
  let contribution = max(brightness - threshold, soft) / max(brightness, 0.0001);
  return color * contribution;
}

@fragment
fn fs_main(@location(0) uv: vec2f, @builtin(position) position: vec4f) -> @location(0) vec4f {
  let filtered = lowPass(uv, floor(position.xy));
  let color = select(filtered, brightContribution(filtered), params.extractHighlights > 0.5);
  return vec4f(color, 1.0);
}
