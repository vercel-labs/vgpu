struct Uniforms {
  resolution: vec2f,
  kind: u32,
  _pad: u32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;

fn load_clamped(pixel: vec2u) -> vec4f {
  let dims = textureDimensions(scene_tex);
  let clamped = min(pixel, dims - vec2u(1u));
  return textureLoad(scene_tex, clamped, 0);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  if (uniforms.kind == 1u) {
    let base = vec2u(position.xy) * 2u;
    let c00 = load_clamped(base);
    let c10 = load_clamped(base + vec2u(1u, 0u));
    let c01 = load_clamped(base + vec2u(0u, 1u));
    let c11 = load_clamped(base + vec2u(1u, 1u));
    return (c00 + c10 + c01 + c11) * 0.25;
  }

  // MSAA targets expose their single-sample resolve texture, so the 1:1 path can
  // load the resolved pixel directly. Keeping this shader load-only also gives the
  // texture one consistent (unfilterable-float) binding usage across both modes.
  return load_clamped(vec2u(position.xy));
}
