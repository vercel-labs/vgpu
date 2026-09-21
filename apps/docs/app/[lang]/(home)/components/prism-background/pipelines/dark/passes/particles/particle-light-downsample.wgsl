// Builds the low-frequency particle-light field directly from the HDR scene.
// An 8x8 area filter preserves thin rays when reducing straight to 1/16 while
// deliberately avoiding the visible bloom threshold.

struct DownsampleParams {
  sourceTexelSize: vec2f,
  sourceToTargetScale: vec2f,
}

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> params: DownsampleParams;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var color = vec3f(0.0);
  for (var y = 0u; y < 8u; y = y + 1u) {
    for (var x = 0u; x < 8u; x = x + 1u) {
      let grid = vec2f(f32(x), f32(y)) - vec2f(3.5);
      let offset = grid * 0.125
        * params.sourceToTargetScale * params.sourceTexelSize;
      color += textureSampleLevel(
        sourceTexture,
        sourceSampler,
        uv + offset,
        0.0,
      ).rgb;
    }
  }
  return vec4f(max(color / 64.0, vec3f(0.0)), 1.0);
}
