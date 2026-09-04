// One axis of the Gaussian blur with adjacent positive/negative taps paired
// through bilinear filtering. CPU-precomputed weights and fractional offsets
// reconstruct the same discrete kernel with fewer texture samples.

const MAX_PAIR_TAPS: u32 = 11u;

struct BlurParams {
  direction: vec2f,
  texelSize: vec2f,
  // x = center weight, y = active pair count.
  kernel: vec4f,
  weights0: vec4f,
  weights1: vec4f,
  weights2: vec4f,
  offsets0: vec4f,
  offsets1: vec4f,
  offsets2: vec4f,
}

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> params: BlurParams;

fn pair_weight(index: u32) -> f32 {
  let values = array<f32, 12>(
    params.weights0.x,
    params.weights0.y,
    params.weights0.z,
    params.weights0.w,
    params.weights1.x,
    params.weights1.y,
    params.weights1.z,
    params.weights1.w,
    params.weights2.x,
    params.weights2.y,
    params.weights2.z,
    params.weights2.w,
  );
  return values[index];
}

fn pair_offset(index: u32) -> f32 {
  let values = array<f32, 12>(
    params.offsets0.x,
    params.offsets0.y,
    params.offsets0.z,
    params.offsets0.w,
    params.offsets1.x,
    params.offsets1.y,
    params.offsets1.z,
    params.offsets1.w,
    params.offsets2.x,
    params.offsets2.y,
    params.offsets2.z,
    params.offsets2.w,
  );
  return values[index];
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var color = textureSampleLevel(sourceTexture, sourceSampler, uv, 0.0).rgb
    * params.kernel.x;
  let pairCount = min(MAX_PAIR_TAPS, u32(max(params.kernel.y, 0.0)));
  for (var pair = 0u; pair < MAX_PAIR_TAPS; pair = pair + 1u) {
    if (pair >= pairCount) { break; }
    let offset = params.direction * params.texelSize * pair_offset(pair);
    color += (
      textureSampleLevel(sourceTexture, sourceSampler, uv + offset, 0.0).rgb
      + textureSampleLevel(sourceTexture, sourceSampler, uv - offset, 0.0).rgb
    ) * pair_weight(pair);
  }
  return vec4f(max(color, vec3f(0.0)), 1.0);
}
