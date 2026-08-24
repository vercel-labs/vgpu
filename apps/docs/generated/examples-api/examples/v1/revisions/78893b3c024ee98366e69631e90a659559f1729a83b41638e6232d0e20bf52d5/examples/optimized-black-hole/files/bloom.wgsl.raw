// Multi-resolution bloom stage.
//
// mode 0: four-tap downsample, optionally with a soft HDR threshold.
// mode 1: separable five-fetch Gaussian blur (an optimized nine-tap kernel).

// The first downsample reads the full-resolution HDR scene and extracts only
// highlights. Later downsample levels receive threshold = -1 and preserve the
// energy already selected by the first level.

struct Bloom {
  sourceSize: vec2f,
  direction: vec2f,
  // x = threshold (-1 disables), y = soft knee, z = blur radius, w = mode.
  params: vec4f,
}

@group(0) @binding(0) var<uniform> bloom: Bloom;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;

fn softThreshold(color: vec3f) -> vec3f {
  let threshold = bloom.params.x;
  // Threshold zero means "bloom everything", not "apply a knee around zero".
  // Keeping a non-zero knee at zero threshold creates a luminance floor of
  // roughly knee/4 and turns arbitrarily dim input into a hard-edged plateau.
  if (threshold <= 0.0) {
    return color;
  }

  let brightness = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  // A knee wider than the threshold crosses zero and produces the same floor
  // for small positive thresholds. Cap it so the transition always begins at
  // non-negative luminance and can decay continuously to black.
  let knee = max(min(bloom.params.y, threshold), 0.000001);
  let soft = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
  let softContribution = soft * soft / (4.0 * knee + 0.0001);
  let contribution = max(brightness - threshold, softContribution) / max(brightness, 0.0001);
  return color * contribution;
}

fn downsample(uv: vec2f) -> vec3f {
  let texel = 1.0 / bloom.sourceSize;
  let offset = texel * 0.5;
  let color = (
    textureSample(source, linearSampler, uv + vec2f(-offset.x, -offset.y)).rgb +
    textureSample(source, linearSampler, uv + vec2f( offset.x, -offset.y)).rgb +
    textureSample(source, linearSampler, uv + vec2f(-offset.x,  offset.y)).rgb +
    textureSample(source, linearSampler, uv + vec2f( offset.x,  offset.y)).rgb
  ) * 0.25;
  return softThreshold(color);
}

fn gaussianBlur(uv: vec2f) -> vec3f {
  // The old kernel multiplied the pre-combined offsets (1.38 and 3.23 texels)
  // by radius while keeping their weights fixed. At radius 1.5 that jumps to
  // 2.08 and 4.85 texels: a point highlight illuminates separated samples and
  // the horizontal/vertical passes reveal a cross-hatched grid.
  //
  // Build the nine consecutive Gaussian taps for the requested sigma instead,
  // then pair taps 1+2 and 3+4 into bilinear samples. Every source texel remains
  // represented, but the pass still costs only five texture fetches.
  let sigma = max(bloom.params.z, 0.5);
  let inverseTwoSigmaSquared = 0.5 / (sigma * sigma);
  let w0 = 1.0;
  let w1 = exp(-1.0 * inverseTwoSigmaSquared);
  let w2 = exp(-4.0 * inverseTwoSigmaSquared);
  let w3 = exp(-9.0 * inverseTwoSigmaSquared);
  let w4 = exp(-16.0 * inverseTwoSigmaSquared);

  let pair12 = w1 + w2;
  let pair34 = w3 + w4;
  let offset12 = (w1 + 2.0 * w2) / max(pair12, 0.000001);
  let offset34 = (3.0 * w3 + 4.0 * w4) / max(pair34, 0.000001);
  let normalization = w0 + 2.0 * (pair12 + pair34);
  let texel = bloom.direction / bloom.sourceSize;

  var color = textureSample(source, linearSampler, uv).rgb * w0;
  color += textureSample(source, linearSampler, uv + texel * offset12).rgb * pair12;
  color += textureSample(source, linearSampler, uv - texel * offset12).rgb * pair12;
  color += textureSample(source, linearSampler, uv + texel * offset34).rgb * pair34;
  color += textureSample(source, linearSampler, uv - texel * offset34).rgb * pair34;
  return color / normalization;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var color: vec3f;
  if (bloom.params.w > 0.5) {
    color = gaussianBlur(uv);
  } else {
    color = downsample(uv);
  }
  return vec4f(color, 1.0);
}
