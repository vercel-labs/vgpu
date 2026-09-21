// Exact copy of the retained, display-encoded dark base. `textureLoad` keeps
// pixel centres and encoded values unchanged; dust is added after this draw.

@group(0) @binding(0) var sourceTexture: texture_2d<f32>;

struct PresentParams {
  backgroundColor: vec3f,
  revealProgress: f32,
}

@group(0) @binding(1) var<uniform> params: PresentParams;

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let presented = textureLoad(sourceTexture, vec2i(position.xy), 0);
  let reveal = clamp(params.revealProgress, 0.0, 1.0);
  if (reveal >= 1.0) { return presented; }
  return vec4f(mix(params.backgroundColor, presented.rgb, reveal), 1.0);
}
