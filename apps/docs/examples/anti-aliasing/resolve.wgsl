struct Uniforms {
  resolution: vec2f,
  kind: u32,
  _pad: u32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;
@group(0) @binding(2) var linear_samp: sampler;

fn load_clamped(pixel: vec2u) -> vec4f {
  let dims = textureDimensions(scene_tex);
  let clamped = min(pixel, dims - vec2u(1u));
  return textureLoad(scene_tex, clamped, 0);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let resolution = max(uniforms.resolution, vec2f(1.0));
  let uv = position.xy / resolution;

  if (uniforms.kind == 1u) {
    let base = vec2u(position.xy) * 2u;
    let c00 = load_clamped(base);
    let c10 = load_clamped(base + vec2u(1u, 0u));
    let c01 = load_clamped(base + vec2u(0u, 1u));
    let c11 = load_clamped(base + vec2u(1u, 1u));
    return (c00 + c10 + c01 + c11) * 0.25;
  }

  return textureSample(scene_tex, linear_samp, uv);
}
