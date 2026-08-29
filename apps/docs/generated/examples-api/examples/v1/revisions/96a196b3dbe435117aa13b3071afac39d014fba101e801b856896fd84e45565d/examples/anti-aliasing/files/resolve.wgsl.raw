struct Uniforms {
  kind: u32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;
@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  if (uniforms.kind == 1u) {
    let base = vec2u(position.xy) * 2u;
    let c00 = textureLoad(scene_tex, base, 0);
    let c10 = textureLoad(scene_tex, base + vec2u(1u, 0u), 0);
    let c01 = textureLoad(scene_tex, base + vec2u(0u, 1u), 0);
    let c11 = textureLoad(scene_tex, base + vec2u(1u, 1u), 0);
    return (c00 + c10 + c01 + c11) * 0.25;
  }
  return textureLoad(scene_tex, vec2u(position.xy), 0);
}
