// Composites the premultiplied MSAA planet over the HDR sky.

@group(0) @binding(0) var planetTexture: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(planetTexture, samp, uv, 0.0);
}
