// One axis of an energy-normalized Gaussian blur. The same shader serves every
// pyramid level; coefficients beyond each level's kernel are zero-padded.

const MAX_KERNEL_TAPS: u32 = 22u;

struct BlurParams {
  direction: vec2f,
  texelSize: vec2f,
  tapCount: f32,
  coefficients0: vec4f,
  coefficients1: vec4f,
  coefficients2: vec4f,
  coefficients3: vec4f,
  coefficients4: vec4f,
  coefficients5: vec4f,
}

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> params: BlurParams;

fn coefficient(index: u32) -> f32 {
  let values = array<f32, 24>(
    params.coefficients0.x,
    params.coefficients0.y,
    params.coefficients0.z,
    params.coefficients0.w,
    params.coefficients1.x,
    params.coefficients1.y,
    params.coefficients1.z,
    params.coefficients1.w,
    params.coefficients2.x,
    params.coefficients2.y,
    params.coefficients2.z,
    params.coefficients2.w,
    params.coefficients3.x,
    params.coefficients3.y,
    params.coefficients3.z,
    params.coefficients3.w,
    params.coefficients4.x,
    params.coefficients4.y,
    params.coefficients4.z,
    params.coefficients4.w,
    params.coefficients5.x,
    params.coefficients5.y,
    params.coefficients5.z,
    params.coefficients5.w,
  );
  return values[index];
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var color = textureSampleLevel(sourceTexture, sourceSampler, uv, 0.0).rgb
    * coefficient(0u);
  let tapCount = min(MAX_KERNEL_TAPS, u32(max(params.tapCount, 1.0)));
  for (var tap = 1u; tap < MAX_KERNEL_TAPS; tap = tap + 1u) {
    if (tap >= tapCount) { break; }
    let offset = params.direction * params.texelSize * f32(tap);
    let weight = coefficient(tap);
    color += (
      textureSampleLevel(sourceTexture, sourceSampler, uv + offset, 0.0).rgb
      + textureSampleLevel(sourceTexture, sourceSampler, uv - offset, 0.0).rgb
    ) * weight;
  }
  return vec4f(max(color, vec3f(0.0)), 1.0);
}
